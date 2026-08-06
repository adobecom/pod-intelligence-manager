import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { testDb } = vi.hoisted(() => {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  return { testDb: db };
});

vi.mock("../../db/connection.js", () => ({
  default: testDb,
  withTransaction: (fn: () => unknown) => fn(),
}));

// project-search.ts attaches a KG overlay by default; keep it empty + deterministic.
vi.mock("../knowledge-graph.js", () => ({
  queryKnowledge: vi.fn(() => ({
    nodes: [],
    edges: [],
    total_matching: 0,
    token_estimate: 0,
    truncated: false,
  })),
}));

// Deterministic synthesis: echo a fixed answer + record the prompt for assertions.
const llmCalls: Array<{ system: string; prompt: string }> = [];
vi.mock("../../pim/llm.js", () => ({
  isLLMAvailable: () => true,
  MODELS: { fast: "test-fast", smart: "test-smart" },
  callLLM: vi.fn(async (opts: { system: string; prompt: string }) => {
    llmCalls.push({ system: opts.system, prompt: opts.prompt });
    if (opts.prompt.includes('"source": "kg"')) {
      return "RBAC is implemented through the project knowledge graph evidence [K1].";
    }
    return "**Upcoming:** the next release is in planning [T3-26.29].";
  }),
}));

import { createTables } from "../../db/schema.js";
import { upsertUserByIms } from "../users.js";
import { createOrg } from "../orgs.js";
import {
  backfillProjectSearch,
  indexProjectDocument,
  reindexProjectSearch,
  type IndexDocumentInput,
} from "../project-search-index.js";
import { connectorBindingVersion } from "../project-resource-bindings.js";
import { searchProject } from "../project-search.js";
import { queryKnowledge } from "../knowledge-graph.js";

const ORG_ID = "org_search";
const PROJECT_ID = "project-emc-search";
const OTHER_PROJECT_ID = "project-other";
let creatorId = "";
let tempRepos: string[] = [];

function mockKgNodes(nodes: Array<Record<string, unknown>>) {
  vi.mocked(queryKnowledge).mockReturnValue({
    nodes: nodes as never,
    edges: [],
    total_matching: nodes.length,
    token_estimate: 0,
    truncated: false,
  });
}

function seed() {
  const creator = upsertUserByIms({ email: "search@local", display_name: "Searcher" });
  creatorId = creator.user_id;
  createOrg({ orgId: ORG_ID, slug: "search", name: "Search", creatorUserId: creator.user_id });
  const insertProject = testDb.prepare(
    "INSERT INTO projects (project_id, name, description, created_at, resources_json, org_id, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  insertProject.run(
    PROJECT_ID,
    "EMC Platform",
    null,
    new Date().toISOString(),
    JSON.stringify({
      jira: { project_keys: ["EMC", "MWPW"] },
      github: { repos: ["adobe/emc"] },
      slack: { channels: ["T1:C1"] },
      confluence: { space_keys: ["ENG"] },
    }),
    ORG_ID,
    creator.user_id,
  );
  insertProject.run(OTHER_PROJECT_ID, "Other", null, new Date().toISOString(), "{}", ORG_ID, creator.user_id);
}

function doc(overrides: Partial<IndexDocumentInput> & Pick<IndexDocumentInput, "source" | "source_type" | "source_id" | "title">): IndexDocumentInput {
  return {
    org_id: ORG_ID,
    project_id: PROJECT_ID,
    body: "",
    occurred_at: new Date().toISOString(),
    ...overrides,
  };
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function createLocalGitRepo(): { repo: string; sha: string } {
  const repo = mkdtempSync(path.join(tmpdir(), "pim-project-search-"));
  tempRepos.push(repo);
  runGit(repo, ["init"]);
  runGit(repo, ["config", "user.email", "dev@example.test"]);
  runGit(repo, ["config", "user.name", "Dev Example"]);
  mkdirSync(path.join(repo, "src"), { recursive: true });
  writeFileSync(
    path.join(repo, "src", "sessionLimits.ts"),
    [
      "export const EVENT_LIMIT = 25;",
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(repo, "src", "EventDashboard.tsx"),
    [
      "import { EVENT_LIMIT } from './sessionLimits';",
      "",
      "export interface EventDashboardProps {",
      "  eventId: string;",
      "}",
      "",
      "export function EventDashboard(props: EventDashboardProps) {",
      "  return props.eventId;",
      "}",
      "",
      "export class EventDashboardController {",
      "  load() {",
      "    return EVENT_LIMIT;",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  runGit(repo, ["add", "src/EventDashboard.tsx", "src/sessionLimits.ts"]);
  runGit(repo, ["commit", "-m", "Fix EMC-123 implement event dashboard exports"]);
  const sha = runGit(repo, ["rev-parse", "HEAD"]);
  const canonicalRepo = runGit(repo, ["rev-parse", "--show-toplevel"]);
  process.env.PROJECT_GIT_ALLOWED_ROOTS = canonicalRepo;
  return { repo: canonicalRepo, sha };
}

beforeEach(() => {
  process.env.CONFLUENCE_PROJECT_VISIBLE_SPACE_KEYS = "ENG";
  process.env.CONFLUENCE_BASE_URL = "https://wiki.example.test";
  process.env.PROJECT_SLACK_SEARCH_ENABLED = "1";
  process.env.PROJECT_CONFLUENCE_SEARCH_ENABLED = "1";
  vi.clearAllMocks();
  llmCalls.length = 0;
  mockKgNodes([]);
  tempRepos = [];
  testDb.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS project_search_fts;
    DROP TABLE IF EXISTS project_search_edges;
    DROP TABLE IF EXISTS project_search_entities;
    DROP TABLE IF EXISTS project_search_chunks;
    DROP TABLE IF EXISTS project_search_documents;
    DROP TABLE IF EXISTS project_ingestion_cursors;
    DROP TABLE IF EXISTS project_memory_candidates;
    DROP TABLE IF EXISTS project_evidence_items;
    DROP TABLE IF EXISTS project_context_updates;
    DROP TABLE IF EXISTS context_updates;
    DROP TABLE IF EXISTS pod_areas;
    DROP TABLE IF EXISTS pods;
    DROP TABLE IF EXISTS projects;
    DROP TABLE IF EXISTS memberships;
    DROP TABLE IF EXISTS org_invites;
    DROP TABLE IF EXISTS org_settings;
    DROP TABLE IF EXISTS orgs;
    DROP TABLE IF EXISTS users;
    PRAGMA foreign_keys = ON;
  `);
  createTables();
  seed();
});

afterEach(() => {
  delete process.env.CONFLUENCE_PROJECT_VISIBLE_SPACE_KEYS;
  delete process.env.CONFLUENCE_BASE_URL;
  delete process.env.PROJECT_SLACK_SEARCH_ENABLED;
  delete process.env.PROJECT_CONFLUENCE_SEARCH_ENABLED;
  delete process.env.PROJECT_GITHUB_VISIBLE_REPOS;
  delete process.env.PROJECT_JIRA_VISIBLE_PROJECT_KEYS;
  delete process.env.PROJECT_GIT_ALLOWED_ROOTS;
  for (const repo of tempRepos) {
    rmSync(repo, { recursive: true, force: true });
  }
  tempRepos = [];
});

describe("indexed project search — retrieval", () => {
  it("stamps derived metadata without rewriting authoritative evidence", async () => {
    const currentVersion = connectorBindingVersion({
      jira: { project_keys: ["EMC", "MWPW"] },
    }, "jira");
    const now = new Date().toISOString();
    testDb.prepare(
      `INSERT INTO project_evidence_items
         (id, org_id, project_id, source, source_type, source_id, source_title,
          summary, body, occurred_at, ingested_at, metadata_json, confidence_score, visibility)
       VALUES ('evidence-binding-restamp', ?, ?, 'jira', 'issue', 'EMC-101',
               'bindingrestampneedle remains searchable', 'Historical evidence',
               'Historical evidence under the configured project binding.', ?, ?, ?, 0.7, 'project_visible')`,
    ).run(
      ORG_ID,
      PROJECT_ID,
      now,
      now,
      JSON.stringify({ key: "EMC-101", resource_binding_version: "resource-binding-v1:obsolete" }),
    );

    backfillProjectSearch(ORG_ID, PROJECT_ID);

    const storedDocument = testDb.prepare(
      "SELECT metadata_json FROM project_search_documents WHERE project_id = ? AND source_id = ?",
    ).get(PROJECT_ID, "EMC-101") as { metadata_json: string };
    const storedEvidence = testDb.prepare(
      "SELECT metadata_json FROM project_evidence_items WHERE project_id = ? AND source_id = ?",
    ).get(PROJECT_ID, "EMC-101") as { metadata_json: string };
    expect(JSON.parse(storedDocument.metadata_json)).toMatchObject({
      resource_binding_version: currentVersion,
    });
    expect(JSON.parse(storedEvidence.metadata_json)).toMatchObject({
      resource_binding_version: "resource-binding-v1:obsolete",
    });

    process.env.PROJECT_JIRA_VISIBLE_PROJECT_KEYS = "UNRELATED,REORDERED";
    expect(connectorBindingVersion({
      jira: { project_keys: ["EMC", "MWPW"] },
    }, "jira")).toBe(currentVersion);
    const result = await searchProject(ORG_ID, PROJECT_ID, { query: "bindingrestampneedle" });
    expect(result?.hits.map((hit) => hit.source_id)).toContain("EMC-101");
  });

  it("returns an exact Jira-key lookup as the top hit", async () => {
    indexProjectDocument(doc({
      source: "jira", source_type: "resolved_issue", source_id: "EMC-123",
      title: "Add RBAC scopes to the event console",
      body: "Implemented role-based access control scopes for session configuration.",
      author: "rayyan",
    }));
    indexProjectDocument(doc({
      source: "jira", source_type: "issue", source_id: "EMC-999",
      title: "Unrelated billing rollup", body: "Stripe invoice reconciliation.",
    }));

    const res = await searchProject(ORG_ID, PROJECT_ID, { query: "EMC-123" });
    expect(res).not.toBeNull();
    expect(res!.hits[0].document_id).toBeDefined();
    expect(res!.hits[0].title).toContain("RBAC");
    expect(res!.hits[0].matched.identifier).toBe(true);
    expect(res!.detected_identifiers).toContain("emc-123");
  });

  it("uses normalized exact-token equality for identifiers", async () => {
    indexProjectDocument(doc({
      source: "jira", source_type: "issue", source_id: "EMC-12",
      title: "EMC-12 exact task", body: "The exact task requested by the user.",
    }));
    indexProjectDocument(doc({
      source: "jira", source_type: "issue", source_id: "EMC-120",
      title: "EMC-120 prefix collision", body: "A different task with a longer numeric suffix.",
    }));

    const res = await searchProject(ORG_ID, PROJECT_ID, { query: "EMC-12" });

    expect(res!.hits[0].source_id).toBe("EMC-12");
    expect(res!.hits[0].matched.identifier).toBe(true);
    expect(res!.hits.find((hit) => hit.source_id === "EMC-120")?.matched.identifier).not.toBe(true);
  });

  it("applies source eligibility before the exact-identifier candidate cap", async () => {
    for (let i = 0; i < 55; i++) {
      indexProjectDocument(doc({
        source: "slack",
        source_type: "thread",
        source_id: `exact-mirror-${i}`,
        title: `EMC-77 mirror discussion ${i}`,
      }));
    }
    indexProjectDocument(doc({
      source: "jira", source_type: "issue", source_id: "EMC-77",
      title: "Native identity task", body: "The canonical issue.",
    }));

    const res = await searchProject(ORG_ID, PROJECT_ID, { query: "EMC-77", sources: ["jira"] });

    expect(res!.hits[0].source_id).toBe("EMC-77");
    expect(res!.hits[0].matched.identifier).toBe(true);
  });

  it("expands project aliases and glossary terms with whole-phrase matching", async () => {
    testDb.prepare("UPDATE projects SET resources_json = ? WHERE org_id = ? AND project_id = ?").run(
      JSON.stringify({
        aliases: ["Event Console"],
        jira: { project_keys: ["EMC", "MWPW"] },
        github: { repos: ["adobe/emc"] },
        slack: { channels: ["T1:C1"] },
        confluence: { space_keys: ["ENG"] },
        glossary: [
          { term: "role based access control", aliases: ["RBAC"] },
          { term: "artificial intelligence", aliases: ["AI"] },
        ],
      }),
      ORG_ID,
      PROJECT_ID,
    );
    indexProjectDocument(doc({
      source: "jira", source_type: "issue", source_id: "EMC-410",
      title: "EMC Platform architecture", body: "Platform foundations and boundaries.",
    }));
    indexProjectDocument(doc({
      source: "jira", source_type: "issue", source_id: "EMC-411",
      title: "Authorization architecture", body: "Role based access control protects every operation.",
    }));
    indexProjectDocument(doc({
      source: "jira", source_type: "issue", source_id: "EMC-412",
      title: "ML architecture", body: "Artificial intelligence model evaluation.",
    }));

    const aliasRes = await searchProject(ORG_ID, PROJECT_ID, { query: "Event Console" });
    expect(aliasRes!.hits.some((hit) => hit.source_id === "EMC-410")).toBe(true);

    const glossaryRes = await searchProject(ORG_ID, PROJECT_ID, { query: "RBAC" });
    expect(glossaryRes!.hits.some((hit) => hit.source_id === "EMC-411")).toBe(true);

    const substringRes = await searchProject(ORG_ID, PROJECT_ID, { query: "chair" });
    expect(substringRes!.hits.some((hit) => hit.source_id === "EMC-412")).toBe(false);
  });

  it("answers a vague keyword query lexically (no embeddings) with a snippet", async () => {
    indexProjectDocument(doc({
      source: "jira", source_type: "resolved_issue", source_id: "EMC-200",
      title: "RBAC scope enforcement", body: "Scope-level configs gate who can edit event sessions.",
    }));

    const res = await searchProject(ORG_ID, PROJECT_ID, { query: "who can edit sessions" });
    expect(res!.retrieval_mode).toBe("lexical");
    expect(res!.hits.length).toBeGreaterThanOrEqual(1);
    expect(res!.hits.some((h) => h.matched.lexical)).toBe(true);
    expect(res!.hits[0].snippet.length).toBeGreaterThan(0);
  });

  it("never returns documents from a different project (wrong-project control)", async () => {
    indexProjectDocument({
      org_id: ORG_ID, project_id: OTHER_PROJECT_ID, source: "project_update", source_type: "progress",
      source_id: "OTH-1", title: "zzqplutonium reactor calibration", body: "zzqplutonium specifics",
      occurred_at: new Date().toISOString(),
    });

    const res = await searchProject(ORG_ID, PROJECT_ID, { query: "zzqplutonium" });
    expect(res!.hits).toHaveLength(0);
  });

  it("excludes documents whose freshness is deleted", async () => {
    indexProjectDocument(doc({
      source: "github", source_type: "merged_pr", source_id: "adobe/emc#7",
      title: "Deprecated webhook handler", body: "Removed legacy webhook ingestion path.",
      freshness_state: "deleted",
    }));
    indexProjectDocument(doc({
      source: "github", source_type: "merged_pr", source_id: "adobe/emc#8",
      title: "Current webhook handler", body: "New webhook ingestion path.",
    }));

    const res = await searchProject(ORG_ID, PROJECT_ID, { query: "webhook ingestion" });
    const ids = res!.hits.map((h) => h.source_type + ":" + h.title);
    expect(res!.hits.some((h) => h.title === "Current webhook handler")).toBe(true);
    expect(res!.hits.some((h) => h.title === "Deprecated webhook handler")).toBe(false);
    void ids;
  });

  it("honors the sources filter", async () => {
    indexProjectDocument(doc({ source: "jira", source_type: "issue", source_id: "EMC-300", title: "session timeout config", body: "timeout config for sessions" }));
    indexProjectDocument(doc({ source: "slack", source_type: "thread_url", source_id: "https://slack/x", title: "session timeout chatter", body: "timeout config discussion" }));

    const res = await searchProject(ORG_ID, PROJECT_ID, { query: "timeout config", sources: ["jira"] });
    expect(res!.hits.length).toBeGreaterThanOrEqual(1);
    expect(res!.hits.every((h) => h.source === "jira")).toBe(true);
  });

  it("requires every configured Jira narrowing dimension before candidate generation", async () => {
    testDb.prepare("UPDATE projects SET resources_json = ? WHERE org_id = ? AND project_id = ?").run(
      JSON.stringify({
        jira: {
          project_keys: ["EMC"],
          issue_keys: ["EMC-501", "EMC-502", "EMC-503", "EMC-505"],
          epics: ["EMC-900"],
          components: ["Project Search"],
          fix_versions: ["R1"],
        },
      }),
      ORG_ID,
      PROJECT_ID,
    );
    const jiraDoc = (sourceId: string, metadata: Record<string, unknown>) => doc({
      source: "jira",
      source_type: "issue",
      source_id: sourceId,
      title: `${sourceId} conjunctiveboundarytoken`,
      body: "conjunctiveboundarytoken",
      metadata,
    });
    indexProjectDocument(jiraDoc("EMC-501", {
      components: ["Project Search"], fix_versions: ["R1"], parent: "EMC-900",
    }));
    indexProjectDocument(jiraDoc("EMC-502", {
      components: ["Other"], fix_versions: ["R1"], parent: "EMC-900",
    }));
    indexProjectDocument(jiraDoc("EMC-503", {
      components: ["Project Search"], fix_versions: ["R2"], parent: "EMC-900",
    }));
    indexProjectDocument(jiraDoc("EMC-504", {
      components: ["Project Search"], fix_versions: ["R1"], parent: "EMC-900",
    }));
    indexProjectDocument(jiraDoc("EMC-505", {
      components: ["Project Search"], fix_versions: ["R1"], parent: "EMC-901",
    }));

    const res = await searchProject(ORG_ID, PROJECT_ID, { query: "conjunctiveboundarytoken", sources: ["jira"] });

    expect(res!.hits.map((hit) => hit.source_id)).toEqual(["EMC-501"]);
  });

  it("applies source eligibility before the lexical candidate cap", async () => {
    for (let i = 0; i < 210; i++) {
      indexProjectDocument(doc({
        source: "slack",
        source_type: "thread",
        source_id: `thread-${i}`,
        title: `quasarneedle excluded thread ${i}`,
        body: "quasarneedle quasarneedle quasarneedle quasarneedle",
      }));
    }
    indexProjectDocument(doc({
      source: "jira",
      source_type: "issue",
      source_id: "EMC-420",
      title: "quasarneedle allowed Jira task",
      body: "The scoped candidate.",
    }));

    const res = await searchProject(ORG_ID, PROJECT_ID, {
      query: "quasarneedle",
      sources: ["jira"],
    });

    expect(res!.hits.map((hit) => hit.source_id)).toContain("EMC-420");
    expect(res!.hits.every((hit) => hit.source === "jira")).toBe(true);
  });

  it("expands neighboring Confluence chunks only after selection", async () => {
    const paragraph = (marker: string, word: string) => `${marker} ${(`${word} `.repeat(90)).trim()}`;
    indexProjectDocument(doc({
      source: "confluence",
      source_type: "page",
      source_id: "wiki:page-42",
      source_instance: "wiki.example.test",
      native_id: "page-42",
      title: "Architecture notes",
      body: [
        paragraph("precedingcontext", "alpha"),
        paragraph("needlecontext", "beta"),
        paragraph("followingcontext", "gamma"),
      ].join("\n\n"),
      metadata: { page_id: "page-42", space_key: "ENG" },
    }));

    const res = await searchProject(ORG_ID, PROJECT_ID, { query: "needlecontext" });

    expect(res!.hits[0].source_id).toBe("wiki:page-42");
    expect(res!.hits[0].snippet).toContain("precedingcontext");
    expect(res!.hits[0].snippet).toContain("needlecontext");
    expect(res!.hits[0].snippet).toContain("followingcontext");
  });

  it("deep-links a Slack hit to the matching message", async () => {
    indexProjectDocument(doc({
      source: "slack",
      source_type: "thread",
      source_id: "T1::C1:100.1",
      source_url: "https://workspace.slack.com/archives/C1/p1001",
      title: "#project: Release thread",
      body: [
        "[2026-07-01T00:00:00.000Z] <@U1>: Initial release question\nPermalink: https://workspace.slack.com/archives/C1/p1001",
        "[2026-07-01T00:01:00.000Z] <@U2>: replydeepneedle contains the resolution\nPermalink: https://workspace.slack.com/archives/C1/p1011?thread_ts=100.1&cid=C1",
      ].join("\n\n"),
      source_instance: "T1",
      native_id: "C1:100.1",
      metadata: { workspace_id: "T1", channel_id: "C1", thread_ts: "100.1" },
    }));

    const res = await searchProject(ORG_ID, PROJECT_ID, { query: "replydeepneedle" });

    expect(res!.hits[0].url).toBe("https://workspace.slack.com/archives/C1/p1011?thread_ts=100.1&cid=C1");
  });

  it("expands neighboring Confluence section documents from the same page", async () => {
    for (let sectionIndex = 0; sectionIndex < 5; sectionIndex++) {
      indexProjectDocument(doc({
        source: "confluence",
        source_type: "page_section",
        source_id: `site::page-42:section:${sectionIndex}`,
        source_instance: "wiki.example.test",
        native_id: `page-42:section:${sectionIndex}`,
        title: `Architecture notes — Section ${sectionIndex}`,
        body: sectionIndex === 2
          ? "centralneedle matched section"
          : `sectionmarker${sectionIndex} adjacent section`,
        metadata: { page_id: "page-42", space_key: "ENG", section_index: sectionIndex },
        visibility: "project_visible",
      }));
    }

    const res = await searchProject(ORG_ID, PROJECT_ID, { query: "centralneedle" });

    expect(res!.hits[0].source_id).toContain("section:2");
    expect(res!.hits[0].snippet).toContain("sectionmarker0");
    expect(res!.hits[0].snippet).toContain("sectionmarker1");
    expect(res!.hits[0].snippet).toContain("centralneedle");
    expect(res!.hits[0].snippet).toContain("sectionmarker3");
    expect(res!.hits[0].snippet).toContain("sectionmarker4");
  });

  it("includes project source health in every search response", async () => {
    const res = await searchProject(ORG_ID, PROJECT_ID, { query: "no indexed evidence" });

    expect(res!.source_health.map((entry) => entry.source)).toEqual([
      "github", "jira", "slack", "confluence", "git",
    ]);
    expect(res!.source_health.find((entry) => entry.source === "jira")?.configured).toBe(true);
  });

  it("fails closed over previously indexed Confluence evidence when the visibility policy is absent", async () => {
    indexProjectDocument(doc({
      source: "confluence",
      source_type: "page_section",
      source_id: "site::page-private:section:one",
      title: "Policy-bound document",
      body: "policyrevokedneedle must not remain searchable",
      visibility: "project_visible",
    }));
    delete process.env.CONFLUENCE_PROJECT_VISIBLE_SPACE_KEYS;

    const res = await searchProject(ORG_ID, PROJECT_ID, { query: "policyrevokedneedle" });

    expect(res!.hits.some((hit) => hit.source === "confluence")).toBe(false);
  });

  it("honors the entity_types filter for document-backed entities", async () => {
    indexProjectDocument(doc({
      source: "jira",
      source_type: "issue",
      source_id: "EMC-301",
      title: "session cache timeout ticket",
      body: "timeout config for the session cache",
    }));
    indexProjectDocument(doc({
      source: "github",
      source_type: "merged_pr",
      source_id: "adobe/emc#301",
      title: "session cache timeout PR",
      body: "timeout config for the session cache",
    }));

    const ticketRes = await searchProject(ORG_ID, PROJECT_ID, { query: "session cache timeout", entity_types: ["ticket"] });
    expect(ticketRes!.hits.length).toBeGreaterThanOrEqual(1);
    expect(ticketRes!.hits.every((h) => h.source_id === "EMC-301")).toBe(true);

    const prRes = await searchProject(ORG_ID, PROJECT_ID, { query: "session cache timeout", entity_types: ["pr"] });
    expect(prRes!.hits.length).toBeGreaterThanOrEqual(1);
    expect(prRes!.hits.every((h) => h.source_id === "adobe/emc#301")).toBe(true);
  });

  it("reports lexical retrieval and zero embedding coverage without an embedding service", async () => {
    indexProjectDocument(doc({ source: "jira", source_type: "issue", source_id: "EMC-1", title: "alpha", body: "alpha beta" }));
    const res = await searchProject(ORG_ID, PROJECT_ID, { query: "alpha" });
    expect(res!.retrieval_mode).toBe("lexical");
    expect(res!.embedding_coverage).toBe(0);
  });
});

describe("indexed project search — backfill + mind map", () => {
  it.each(["first", "middle", "last"])(
    "continues valid evidence and update rows when a malformed evidence row is %s",
    (position) => {
      const now = new Date().toISOString();
      const insertEvidence = testDb.prepare(
        `INSERT INTO project_evidence_items
           (id, org_id, project_id, source, source_type, source_id, source_title,
            summary, body, occurred_at, ingested_at, metadata_json, confidence_score, visibility)
         VALUES (?, ?, ?, 'project_update', 'progress', ?, ?, ?, ?, ?, ?, ?, 0.7, 'project_visible')`,
      );
      const rows = [
        { id: "evidence-good-a", sourceId: "good-a", metadata: "{}" },
        { id: "evidence-bad", sourceId: "bad-row", metadata: "{" },
        { id: "evidence-good-b", sourceId: "good-b", metadata: "{}" },
      ];
      if (position === "first") rows.unshift(rows.splice(1, 1)[0]!);
      if (position === "last") rows.push(rows.splice(1, 1)[0]!);
      for (const row of rows) {
        insertEvidence.run(
          row.id,
          ORG_ID,
          PROJECT_ID,
          row.sourceId,
          `Title ${row.sourceId}`,
          `Summary ${row.sourceId}`,
          `Body ${row.sourceId}`,
          now,
          now,
          row.metadata,
        );
      }

      testDb.prepare(
        `INSERT INTO project_context_updates
           (id, org_id, project_id, summary, details, type, scope, agent_id, status, timestamp)
         VALUES ('project-update-after-bad', ?, ?, 'Project update after bad row', 'Still indexed',
                 'progress', 'backend', 'agent-project', 'active', ?)`,
      ).run(ORG_ID, PROJECT_ID, now);
      testDb.prepare(
        `INSERT INTO pods
           (pod_id, name, sprint_start, sprint_end, day_number, total_days, conflict_pressure,
            milestone_json, project_id, org_id, created_by_user_id)
         VALUES ('pod-after-bad', 'Pod after bad row', '2026-08-01', '2026-08-07', 1, 7, 0, '{}', ?, ?, ?)`,
      ).run(PROJECT_ID, ORG_ID, creatorId);
      testDb.prepare(
        `INSERT INTO context_updates
           (id, agent_id, timestamp, pod_id, type, scope, summary, details, artifacts_json,
            status, blocks_json, blocked_by_json, needs_input_from_json, org_id)
         VALUES ('pod-update-after-bad', 'agent-pod', ?, 'pod-after-bad', 'progress', 'backend',
                 'Pod update after bad row', 'Also indexed', '[]', 'active', '[]', '[]', '[]', ?)`,
      ).run(now, ORG_ID);

      const result = backfillProjectSearch(ORG_ID, PROJECT_ID);
      const sourceIds = (testDb.prepare(
        `SELECT source_id FROM project_search_documents
         WHERE org_id = ? AND project_id = ? ORDER BY source_id`,
      ).all(ORG_ID, PROJECT_ID) as Array<{ source_id: string }>).map((row) => row.source_id);

      expect(result).toMatchObject({
        failed_rows: 1,
        complete: false,
        skipped_ineligible: 0,
      });
      expect(result.failures).toEqual([
        { row_id: "evidence-bad", source: "project_update", code: "metadata_json" },
      ]);
      expect(JSON.stringify(result.failures)).not.toContain("Body bad-row");
      expect(sourceIds).toEqual(expect.arrayContaining([
        "good-a",
        "good-b",
        "project-update-after-bad",
        "pod-update-after-bad",
      ]));
      expect(sourceIds).not.toContain("bad-row");
    },
  );

  it("prunes derived evidence whose connector binding was removed and classifies it as ineligible", () => {
    const now = new Date().toISOString();
    testDb.prepare(
      `INSERT INTO project_evidence_items
         (id, org_id, project_id, source, source_type, source_id, source_title,
          summary, body, occurred_at, ingested_at, metadata_json, confidence_score, visibility)
       VALUES ('stale-binding-row', ?, ?, 'jira', 'issue', 'EMC-REMOVED', 'Removed binding',
               'Removed binding', 'Authoritative evidence remains', ?, ?, '{}', 0.7, 'project_visible')`,
    ).run(ORG_ID, PROJECT_ID, now, now);
    backfillProjectSearch(ORG_ID, PROJECT_ID);
    expect(testDb.prepare(
      "SELECT 1 FROM project_search_documents WHERE project_id = ? AND source_id = 'EMC-REMOVED'",
    ).get(PROJECT_ID)).toBeDefined();

    testDb.prepare("UPDATE projects SET resources_json = '{}' WHERE project_id = ?").run(PROJECT_ID);
    testDb.prepare("UPDATE project_evidence_items SET metadata_json = '{' WHERE id = 'stale-binding-row'").run();
    const result = backfillProjectSearch(ORG_ID, PROJECT_ID);

    expect(result).toMatchObject({ skipped_ineligible: 1, failed_rows: 0, complete: true });
    expect(testDb.prepare(
      "SELECT 1 FROM project_search_documents WHERE project_id = ? AND source_id = 'EMC-REMOVED'",
    ).get(PROJECT_ID)).toBeUndefined();
    expect(testDb.prepare(
      "SELECT body, metadata_json FROM project_evidence_items WHERE id = 'stale-binding-row'",
    ).get()).toEqual({ body: "Authoritative evidence remains", metadata_json: "{" });
  });

  it("backfills from linked pod context updates so they become searchable", async () => {
    testDb.prepare(
      "INSERT INTO pods (pod_id, name, sprint_start, sprint_end, day_number, total_days, conflict_pressure, milestone_json, project_id, org_id, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("pod-emc-1", "EMC Webhook Pod", "2026-06-01", "2026-06-05", 2, 5, 0.2, "{}", PROJECT_ID, ORG_ID, creatorId);
    testDb.prepare(
      "INSERT INTO context_updates (id, agent_id, timestamp, pod_id, type, scope, summary, details, artifacts_json, status, blocks_json, blocked_by_json, needs_input_from_json, org_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "cu-1", "agent-be", new Date().toISOString(), "pod-emc-1", "decision", "backend",
      "Chose HMAC signature verification for inbound webhooks",
      "Adopted HMAC-SHA256 over shared secret for the EMC webhook receiver.",
      "[]", "in_progress", "[]", "[]", "[]", ORG_ID,
    );

    const stats = backfillProjectSearch(ORG_ID, PROJECT_ID);
    expect(stats.documents).toBeGreaterThanOrEqual(1);

    const res = await searchProject(ORG_ID, PROJECT_ID, { query: "HMAC webhook signature" });
    expect(res!.hits.some((h) => h.source === "pod_update")).toBe(true);
  });

  it("builds a mind-map neighborhood from extracted entities/edges", async () => {
    indexProjectDocument(doc({
      source: "jira", source_type: "resolved_issue", source_id: "EMC-500",
      title: "Wire RBAC into console",
      body: "Fixes EMC-501. Touches src/rbac/scopes.ts and console/session.ts.",
      author: "rayyan",
    }));

    const res = await searchProject(ORG_ID, PROJECT_ID, { query: "RBAC console", include_mind_map: true });
    expect(res!.mind_map).toBeDefined();
    const labels = res!.mind_map!.entities.map((e) => e.entity_key);
    expect(labels).toContain("EMC-500");
    // Referenced key is upper-cased even though extractIdentifiers lowercases it.
    expect(labels).toContain("EMC-501");
    expect(res!.mind_map!.edges.length).toBeGreaterThanOrEqual(1);
  });

  it("mints deterministic Jira feature nodes from components and parent epics", async () => {
    indexProjectDocument(doc({
      source: "jira",
      source_type: "active_issue",
      source_id: "EMC-510",
      title: "Button polish",
      body: "Adjust copy and spacing.",
      metadata: {
        components: ["Session Builder"],
        parent: "EMC-900",
        parent_summary: "Session creation overhaul",
      },
    }));

    const features = testDb
      .prepare("SELECT entity_key, label, source_document_id FROM project_search_entities WHERE org_id = ? AND project_id = ? AND entity_type = 'feature'")
      .all(ORG_ID, PROJECT_ID) as Array<{ entity_key: string; label: string; source_document_id: string | null }>;
    expect(features).toEqual(expect.arrayContaining([
      expect.objectContaining({ entity_key: "component:session builder", label: "Session Builder", source_document_id: null }),
      expect.objectContaining({ entity_key: "epic:EMC-900", label: "EMC-900: Session creation overhaul", source_document_id: null }),
    ]));

    const edges = testDb
      .prepare(
        `SELECT se.entity_key AS source_key, te.entity_key AS target_key, e.edge_type, e.confidence_score
         FROM project_search_edges e
         JOIN project_search_entities se ON se.id = e.source_entity_id
         JOIN project_search_entities te ON te.id = e.target_entity_id
         WHERE e.org_id = ? AND e.project_id = ? AND e.edge_type = 'implements'`,
      )
      .all(ORG_ID, PROJECT_ID) as Array<{ source_key: string; target_key: string; edge_type: string; confidence_score: number }>;
    expect(edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_key: "EMC-510", target_key: "component:session builder", confidence_score: 0.9 }),
      expect.objectContaining({ source_key: "EMC-510", target_key: "epic:EMC-900", confidence_score: 0.9 }),
    ]));
  });

  it("does not mint feature nodes from GitHub-only issues", async () => {
    indexProjectDocument(doc({
      source: "github",
      source_type: "issue",
      source_id: "adobe/emc#510",
      title: "GitHub issue with component metadata",
      body: "This issue mirrors a Jira discussion.",
      metadata: { components: ["Session Builder"], parent: "EMC-900" },
    }));

    const row = testDb
      .prepare("SELECT COUNT(*) AS count FROM project_search_entities WHERE org_id = ? AND project_id = ? AND entity_type = 'feature'")
      .get(ORG_ID, PROJECT_ID) as { count: number };
    expect(row.count).toBe(0);
  });

  it("uses feature graph expansion for focus-feature retrieval and graph explanations", async () => {
    indexProjectDocument(doc({
      source: "jira",
      source_type: "active_issue",
      source_id: "EMC-520",
      title: "Primary creation flow",
      body: "Adjust copy and spacing.",
      metadata: { components: ["Session Builder"] },
    }));
    indexProjectDocument(doc({
      source: "jira",
      source_type: "active_issue",
      source_id: "EMC-521",
      title: "Secondary creation flow",
      body: "Tighten validation behavior.",
      metadata: { components: ["Session Builder"] },
    }));

    const res = await searchProject(ORG_ID, PROJECT_ID, {
      query: "Session Builder",
      include_mind_map: true,
      max_hits: 4,
    });

    expect(res!.focus_feature).toEqual(expect.objectContaining({
      entity_key: "component:session builder",
      label: "Session Builder",
    }));
    expect(res!.focus_feature!.members).toHaveLength(2);
    expect(res!.hits).toHaveLength(1); // graph-only hits capped at floor(4 * 0.3) => 1
    expect(res!.hits[0].matched.graph).toBe(true);
    expect(res!.hits[0].graph_score).toBeGreaterThan(0);
    expect(res!.hits[0].graph_score).toBeLessThanOrEqual(1 / 61); // graph lane is fused with RRF k=60
    expect(res!.mind_map!.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ entity_type: "feature", entity_key: "component:session builder" }),
    ]));
    expect(res!.mind_map!.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ edge_type: "implements", confidence_score: 0.9 }),
    ]));

    const sourceFiltered = await searchProject(ORG_ID, PROJECT_ID, {
      query: "Session Builder",
      sources: ["github"],
    });
    expect(sourceFiltered!.hits).toHaveLength(0);
    expect(sourceFiltered!.focus_feature).toBeUndefined();
  });

  it("can disable graph expansion per query", async () => {
    indexProjectDocument(doc({
      source: "jira",
      source_type: "active_issue",
      source_id: "EMC-522",
      title: "Creation copy",
      body: "Adjust copy and spacing.",
      metadata: { components: ["Session Builder"] },
    }));

    const res = await searchProject(ORG_ID, PROJECT_ID, {
      query: "Session Builder",
      graph_expansion: false,
    });
    expect(res!.hits).toHaveLength(0);
    expect(res!.focus_feature).toBeUndefined();
  });

  it("enforces query-centered mind-map node and edge caps for high-fan-out features", async () => {
    for (let i = 0; i < 55; i++) {
      indexProjectDocument(doc({
        source: "jira",
        source_type: "active_issue",
        source_id: `EMC-${600 + i}`,
        title: `Fanout work item ${i}`,
        body: "Small implementation note.",
        metadata: { components: ["High Fanout Feature"] },
      }));
    }

    const res = await searchProject(ORG_ID, PROJECT_ID, {
      query: "High Fanout Feature",
      include_mind_map: true,
      max_hits: 50,
    });

    expect(res!.mind_map).toBeDefined();
    expect(res!.mind_map!.entities.length).toBeLessThanOrEqual(40);
    expect(res!.mind_map!.edges.length).toBeLessThanOrEqual(80);
    expect(res!.mind_map!.edges[0].edge_type).toBe("implements");
  });

  it("reindex reports document/chunk/entity counts", async () => {
    const now = new Date().toISOString();
    testDb.prepare(
      `INSERT INTO project_evidence_items
         (id, org_id, project_id, source, source_type, source_id, source_title, summary, body,
          occurred_at, ingested_at, metadata_json, confidence_score, promotable, visibility)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, 'project_visible')`,
    ).run(
      "pei-reindex-1",
      ORG_ID,
      PROJECT_ID,
      "jira",
      "issue",
      "EMC-600",
      "EMC-600: indexing",
      "indexing",
      "index the corpus",
      now,
      now,
      0.6,
      0,
    );
    const stats = await reindexProjectSearch(ORG_ID, PROJECT_ID, { embed: false });
    expect(stats.documents_indexed).toBeGreaterThanOrEqual(1);
    expect(stats.chunks_indexed).toBeGreaterThanOrEqual(1);
    expect(stats.embedding_available).toBe(false);
    const entity = testDb
      .prepare("SELECT metadata_json FROM project_search_entities WHERE org_id = ? AND project_id = ? LIMIT 1")
      .get(ORG_ID, PROJECT_ID) as { metadata_json: string };
    const metadata = JSON.parse(entity.metadata_json) as { version?: number; domains?: string[]; graph?: Record<string, unknown> };
    expect(metadata.version).toBe(1);
    expect(metadata.domains).toEqual(expect.any(Array));
    expect(metadata.graph).toEqual(expect.objectContaining({ degree: expect.any(Number) }));
  });

  it("reindex removes search documents that disappeared from source rows", async () => {
    const now = new Date().toISOString();
    testDb.prepare(
      "INSERT INTO project_context_updates (id, agent_id, timestamp, project_id, type, scope, summary, details, artifacts_json, status, blocks_json, blocked_by_json, needs_input_from_json, org_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "pcu-obsolete",
      "agent-search",
      now,
      PROJECT_ID,
      "decision",
      "backend",
      "Retire obsolete phoenix toggle",
      "obsolete phoenix marker should vanish after retraction",
      "[]",
      "done",
      "[]",
      "[]",
      "[]",
      ORG_ID,
    );

    await reindexProjectSearch(ORG_ID, PROJECT_ID, { embed: false });
    expect((await searchProject(ORG_ID, PROJECT_ID, { query: "obsolete phoenix marker" }))!.hits.length).toBeGreaterThan(0);

    testDb.prepare("UPDATE project_context_updates SET retracted_at = ? WHERE id = ?").run(now, "pcu-obsolete");

    await reindexProjectSearch(ORG_ID, PROJECT_ID, { embed: false });
    expect((await searchProject(ORG_ID, PROJECT_ID, { query: "obsolete phoenix marker" }))!.hits).toHaveLength(0);
  });

  it("reindex ingests local git commits, touched files, exported symbols, and graph edges without KG candidates", async () => {
    const { repo, sha } = createLocalGitRepo();
    testDb
      .prepare("UPDATE projects SET resources_json = ? WHERE org_id = ? AND project_id = ?")
      .run(
        JSON.stringify({
          jira: { project_keys: ["EMC"] },
          git: { repo_paths: [repo], lookback_days: 90 },
        }),
        ORG_ID,
        PROJECT_ID,
      );

    const stats = await reindexProjectSearch(ORG_ID, PROJECT_ID, { embed: false });
    expect(stats.documents_indexed).toBeGreaterThanOrEqual(2);
    expect(stats.entities_indexed).toBeGreaterThanOrEqual(5);

    const docs = testDb
      .prepare("SELECT source_type, source_id, title FROM project_search_documents WHERE org_id = ? AND project_id = ? AND source = 'git'")
      .all(ORG_ID, PROJECT_ID) as Array<{ source_type: string; source_id: string; title: string }>;
    expect(docs.some((d) => d.source_type === "commit" && d.source_id === `${repo}@${sha}`)).toBe(true);
    expect(docs.some((d) => d.source_type === "file_summary" && d.source_id === `${repo}:src/EventDashboard.tsx`)).toBe(true);
    expect(docs.some((d) => d.source_type === "file_summary" && d.source_id === `${repo}:src/sessionLimits.ts`)).toBe(true);

    const entities = testDb
      .prepare("SELECT entity_type, entity_key, label FROM project_search_entities WHERE org_id = ? AND project_id = ?")
      .all(ORG_ID, PROJECT_ID) as Array<{ entity_type: string; entity_key: string; label: string }>;
    expect(entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entity_type: "ticket", entity_key: "EMC-123" }),
        expect.objectContaining({ entity_type: "file", entity_key: `${repo}:src/EventDashboard.tsx` }),
        expect.objectContaining({ entity_type: "symbol", label: "EventDashboard" }),
        expect.objectContaining({ entity_type: "symbol", label: "EventDashboardController" }),
        expect.objectContaining({ entity_type: "symbol", label: "EVENT_LIMIT" }),
      ]),
    );

    const edges = testDb
      .prepare(
        `SELECT se.entity_type AS source_type, te.entity_type AS target_type, e.edge_type
         FROM project_search_edges e
         JOIN project_search_entities se ON se.id = e.source_entity_id
         JOIN project_search_entities te ON te.id = e.target_entity_id
         WHERE e.org_id = ? AND e.project_id = ?`,
      )
      .all(ORG_ID, PROJECT_ID) as Array<{ source_type: string; target_type: string; edge_type: string }>;
    expect(edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_type: "commit", target_type: "ticket", edge_type: "fixes" }),
      expect.objectContaining({ source_type: "commit", target_type: "file", edge_type: "touches" }),
      expect.objectContaining({ source_type: "file", target_type: "symbol", edge_type: "defines" }),
      expect.objectContaining({ source_type: "file", target_type: "file", edge_type: "imports" }),
    ]));

    const ticketRes = await searchProject(ORG_ID, PROJECT_ID, { query: "EMC-123", include_mind_map: true });
    expect(ticketRes!.documents_by_source.git).toBeGreaterThanOrEqual(2);
    expect(ticketRes!.hits.some((h) => h.source === "git" && h.matched.in_scope_resource)).toBe(true);
    expect(ticketRes!.mind_map!.edges.some((e) => e.edge_type === "touches")).toBe(true);

    const symbolRes = await searchProject(ORG_ID, PROJECT_ID, { query: "EventDashboard", include_mind_map: true });
    expect(symbolRes!.hits.some((h) => h.source === "git" && h.source_type === "file_summary")).toBe(true);
    expect(symbolRes!.mind_map!.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ entity_type: "file", entity_key: `${repo}:src/EventDashboard.tsx` }),
      expect.objectContaining({ entity_type: "symbol", label: "EventDashboard" }),
      expect.objectContaining({ entity_type: "commit", entity_key: `${repo}@${sha}` }),
    ]));

    const symbolOnlyRes = await searchProject(ORG_ID, PROJECT_ID, { query: "EventDashboard", entity_types: ["symbol"] });
    expect(symbolOnlyRes!.hits.length).toBeGreaterThanOrEqual(1);
    expect(symbolOnlyRes!.hits.every((h) => h.source === "git" && h.source_type === "file_summary")).toBe(true);

    const candidates = testDb
      .prepare("SELECT COUNT(*) AS count FROM project_memory_candidates WHERE org_id = ? AND project_id = ?")
      .get(ORG_ID, PROJECT_ID) as { count: number };
    expect(candidates.count).toBe(0);
  });

  it("does not dereference a tracked file symlink outside the admitted repository", async () => {
    const { repo } = createLocalGitRepo();
    const outside = mkdtempSync(path.join(tmpdir(), "pim-project-search-outside-"));
    tempRepos.push(outside);
    writeFileSync(path.join(outside, "secret.ts"), "export const OUTSIDE_SECRET = 'must-not-be-indexed';\n");
    symlinkSync(path.join(outside, "secret.ts"), path.join(repo, "src", "leak.ts"));
    runGit(repo, ["add", "src/leak.ts"]);
    runGit(repo, ["commit", "-m", "Add tracked link fixture"]);
    testDb.prepare("UPDATE projects SET resources_json = ? WHERE org_id = ? AND project_id = ?").run(
      JSON.stringify({ git: { repo_paths: [repo], lookback_days: 90 } }),
      ORG_ID,
      PROJECT_ID,
    );

    await reindexProjectSearch(ORG_ID, PROJECT_ID, { embed: false });

    const indexed = testDb.prepare(
      `SELECT d.source_id, c.text AS content
       FROM project_search_documents d
       LEFT JOIN project_search_chunks c ON c.document_id = d.id
       WHERE d.org_id = ? AND d.project_id = ? AND d.source = 'git'`,
    ).all(ORG_ID, PROJECT_ID) as Array<{ source_id: string; content: string | null }>;
    expect(indexed.some((row) => row.source_id.endsWith(":src/leak.ts"))).toBe(false);
    expect(indexed.some((row) => row.content?.includes("must-not-be-indexed"))).toBe(false);
  });

  it("hides indexed Git rows immediately when the operator allowed-root policy narrows", async () => {
    const { repo } = createLocalGitRepo();
    testDb.prepare("UPDATE projects SET resources_json = ? WHERE org_id = ? AND project_id = ?").run(
      JSON.stringify({ git: { repo_paths: [repo], lookback_days: 90 } }),
      ORG_ID,
      PROJECT_ID,
    );
    await reindexProjectSearch(ORG_ID, PROJECT_ID, { embed: false });
    expect((await searchProject(ORG_ID, PROJECT_ID, { query: "EventDashboard" }))!.hits
      .some((hit) => hit.source === "git")).toBe(true);

    const replacementRoot = mkdtempSync(path.join(tmpdir(), "pim-project-search-new-root-"));
    tempRepos.push(replacementRoot);
    process.env.PROJECT_GIT_ALLOWED_ROOTS = replacementRoot;

    expect((await searchProject(ORG_ID, PROJECT_ID, { query: "EventDashboard" }))!.hits
      .some((hit) => hit.source === "git")).toBe(false);
  });
});

describe("indexed project search — intent + readable answer", () => {
  it("ranks an upcoming release above other docs for a release question", async () => {
    indexProjectDocument(doc({
      source: "jira", source_type: "release", source_id: "release:MWPW:T3-26.29",
      title: "Release T3-26.29 — Upcoming",
      body: "Release T3-26.29 (MWPW) — Upcoming. Release date: 2026-07-01.",
    }));
    indexProjectDocument(doc({
      source: "jira", source_type: "active_issue", source_id: "MWPW-1",
      title: "Add localization to sessions", body: "Localization for session pages, currently in development.",
    }));

    const res = await searchProject(ORG_ID, PROJECT_ID, { query: "what is shipping in the next upcoming release" });
    expect(res!.hits.length).toBeGreaterThanOrEqual(1);
    expect(res!.hits[0].source_type).toBe("release");
  });

  it("synthesizes a plain-language answer with citation refs when synthesize=true", async () => {
    indexProjectDocument(doc({
      source: "jira", source_type: "release", source_id: "release:MWPW:T3-26.29",
      title: "Release T3-26.29 — Upcoming", body: "Release T3-26.29 (MWPW) — Upcoming.",
    }));

    const res = await searchProject(ORG_ID, PROJECT_ID, { query: "what is the next release", synthesize: true });
    expect(res!.summary_md).toBeDefined();
    expect(res!.summary_md).toContain("T3-26.29");
    // The release version is passed to the LLM as a readable citation ref (not the raw source_id).
    expect(llmCalls.at(-1)!.prompt).toContain("T3-26.29");
  });

  it("redacts query credentials before synthesis and response boundaries", async () => {
    indexProjectDocument(doc({
      source: "jira",
      source_type: "release",
      source_id: "release:MWPW:T3-26.29",
      title: "Release T3-26.29 — Upcoming",
      body: "Release T3-26.29 (MWPW) — Upcoming.",
    }));

    const secret = "query-secret-must-not-reach-model";
    const res = await searchProject(ORG_ID, PROJECT_ID, {
      query: `what is the next release token="${secret}"`,
      synthesize: true,
    });

    expect(llmCalls.at(-1)?.prompt).not.toContain(secret);
    expect(res?.query).not.toContain(secret);
    expect(res?.query).toContain("[REDACTED:Generic Secret]");
  });

  it("feeds project-scoped KG evidence into synthesis before artifact hits", async () => {
    mockKgNodes([
      {
        id: "kn-rbac-1",
        type: "pattern",
        summary: "RBAC permission gating uses wildcard permission strings",
        details: "EMC gates UI and API actions with event:write, event:delete, and event:* permission checks.",
        confidence_score: 0.92,
        curated: true,
      },
    ]);
    for (let i = 0; i < 5; i++) {
      indexProjectDocument(doc({
        source: "jira",
        source_type: "active_issue",
        source_id: `EMC-${800 + i}`,
        title: `RBAC follow-up Jira task ${i}`,
        body: "RBAC planning and triage note without implementation details.",
      }));
    }

    const res = await searchProject(ORG_ID, PROJECT_ID, { query: "is rbac implemented", synthesize: true });

    expect(res!.summary_md).toContain("[K1]");
    expect(res!.kg_overlay?.[0]?.summary).toContain("RBAC permission gating");
    expect(res!.answer_citations?.[0]).toEqual(expect.objectContaining({
      ref: "K1",
      source: "kg",
      title: "RBAC permission gating uses wildcard permission strings",
    }));
    const prompt = JSON.parse(llmCalls.at(-1)!.prompt) as {
      evidence: Array<{ ref: string; source: string; title: string }>;
    };
    expect(prompt.evidence[0]).toEqual(expect.objectContaining({
      ref: "K1",
      source: "kg",
      title: "RBAC permission gating uses wildcard permission strings",
    }));
    expect(prompt.evidence.some((e) => e.source === "jira")).toBe(true);
  });

  it("can synthesize a KG-only answer when no artifact chunks match", async () => {
    mockKgNodes([
      {
        id: "kn-rbac-only",
        type: "pattern",
        summary: "ESP has three-tier RBAC Platform → Org → Team",
        details: "The hosted knowledge graph records a Platform to Org to Team RBAC hierarchy for ESP.",
        confidence_score: 0.88,
        curated: false,
      },
    ]);

    const res = await searchProject(ORG_ID, PROJECT_ID, { query: "is rbac implemented", synthesize: true });

    expect(res!.hits).toHaveLength(0);
    expect(res!.kg_overlay).toHaveLength(1);
    expect(res!.summary_md).toContain("[K1]");
    expect(res!.answer_citations?.map((c) => c.ref)).toEqual(["K1"]);
  });

  it("excludes KG from synthesis and citations when include_kg=false", async () => {
    mockKgNodes([
      {
        id: "kn-rbac-hidden",
        type: "pattern",
        summary: "Hidden RBAC KG node",
        details: "This should not be visible when include_kg is false.",
        confidence_score: 0.9,
        curated: true,
      },
    ]);
    indexProjectDocument(doc({
      source: "jira", source_type: "active_issue", source_id: "EMC-850",
      title: "RBAC tracking ticket", body: "RBAC tracking ticket for implementation status.",
    }));

    const res = await searchProject(ORG_ID, PROJECT_ID, {
      query: "is rbac implemented",
      synthesize: true,
      include_kg: false,
    });

    expect(res!.kg_overlay).toBeUndefined();
    expect(res!.answer_citations?.some((c) => c.source === "kg")).toBe(false);
    expect(llmCalls.at(-1)!.prompt).not.toContain('"source": "kg"');
  });

  it("keeps implementation evidence in top results for implementation questions", async () => {
    for (let i = 0; i < 5; i++) {
      indexProjectDocument(doc({
        source: "jira",
        source_type: "active_issue",
        source_id: `EMC-${900 + i}`,
        title: `RBAC Jira artifact ${i}`,
        body: "RBAC implemented planning details and status tracking.",
      }));
    }
    indexProjectDocument(doc({
      source: "github",
      source_type: "merged_pr",
      source_id: "adobe/emc#79",
      title: "Fix UI permission leaks by RBAC role",
      body: "Implemented RBAC permission gating with useHasPermission, event:write, event:delete, and event:*.",
    }));

    const res = await searchProject(ORG_ID, PROJECT_ID, { query: "is rbac implemented", max_hits: 4 });

    expect(res!.hits.some((h) => h.source === "github")).toBe(true);
  });

  it("guards synthesized answers when the index has no implementation evidence", async () => {
    indexProjectDocument(doc({
      source: "jira", source_type: "active_issue", source_id: "EMC-777",
      title: "Dashboard implementation ticket",
      body: "Implement the event dashboard export controls.",
    }));

    const res = await searchProject(ORG_ID, PROJECT_ID, { query: "EMC-777 implementation", synthesize: true });
    expect(res!.documents_by_source.jira).toBe(1);
    expect(res!.documents_by_source.git ?? 0).toBe(0);
    expect(res!.summary_md).toContain("Implementation evidence is absent");
  });
});
