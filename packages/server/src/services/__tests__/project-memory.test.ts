import { describe, it, expect, beforeEach, vi } from "vitest";

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

vi.mock("../knowledge-graph.js", () => ({
  addLearningsToGraph: vi.fn(async () => ({
    nodesAdded: 1,
    edgesAdded: 0,
    nodeIds: ["kn-promoted"],
  })),
  queryKnowledge: vi.fn(() => ({
    nodes: [],
    edges: [],
    total_matching: 0,
    token_estimate: 0,
    truncated: false,
  })),
  retractProjectEvidenceKnowledgeNodes: vi.fn(() => []),
}));

import { createTables } from "../../db/schema.js";
import { upsertUserByIms } from "../users.js";
import { createOrg } from "../orgs.js";
import {
  getProjectCursor,
  getProjectSourceHealthLive,
  listProjectMemoryCandidates,
  pollProjectSources,
  promoteProjectMemoryCandidate,
  recordProjectEvidence,
} from "../project-memory.js";
import { answerProjectQuestion } from "../project-answers.js";
import { addLearningsToGraph, queryKnowledge } from "../knowledge-graph.js";

const ORG_ID = "org_project_memory";
const PROJECT_ID = "project-memory-alpha";

function seedProject() {
  const creator = upsertUserByIms({ email: "creator-memory@local", display_name: "Creator" });
  createOrg({ orgId: ORG_ID, slug: "memory", name: "Memory", creatorUserId: creator.user_id });
  testDb.prepare(
    "INSERT INTO projects (project_id, name, description, created_at, resources_json, org_id, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    PROJECT_ID,
    "Memory Alpha",
    null,
    new Date().toISOString(),
    JSON.stringify({
      aliases: ["MAlpha"],
      glossary: [{ term: "PAF", definition: "Project answer flow", aliases: ["answers"] }],
      github: { repos: ["adobe/app"] },
      jira: { project_keys: ["MWPW"] },
      slack: { channels: ["T_MEMORY:C_MEMORY"] },
    }),
    ORG_ID,
    creator.user_id,
  );
}

function setProjectResources(resources: unknown) {
  testDb
    .prepare("UPDATE projects SET resources_json = ? WHERE project_id = ? AND org_id = ?")
    .run(JSON.stringify(resources), PROJECT_ID, ORG_ID);
}

function healthFor(
  rows: Awaited<ReturnType<typeof getProjectSourceHealthLive>>,
  source: "github" | "jira" | "slack" | "confluence" | "git",
) {
  return rows?.find((h) => h.source === source);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  delete process.env.GH_TOKEN;
  delete process.env.JIRA_BASE_URL;
  delete process.env.JIRA_TOKEN;
  delete process.env.JIRA_EMAIL;
  process.env.PROJECT_SLACK_SEARCH_ENABLED = "1";
  process.env.PROJECT_GITHUB_VISIBLE_REPOS = "adobe/app";
  process.env.PROJECT_JIRA_VISIBLE_PROJECT_KEYS = "MWPW";
  testDb.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS memory_relationships;
    DROP TABLE IF EXISTS memory_entities;
    DROP TABLE IF EXISTS memory_candidates;
    DROP TABLE IF EXISTS agent_checkpoints;
    DROP TABLE IF EXISTS agent_run_events;
    DROP TABLE IF EXISTS agent_runs;
    DROP TABLE IF EXISTS agent_sessions;
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
  seedProject();
});

describe("project working memory promotion", () => {
  it("auto-promotes high-confidence merged GitHub PR evidence into the existing KG", async () => {
    await recordProjectEvidence({
      org_id: ORG_ID,
      project_id: PROJECT_ID,
      source: "github",
      source_type: "merged_pr",
      source_id: "adobe/app#42",
      source_url: "https://github.com/adobe/app/pull/42",
      source_title: "PR #42: Cache answer citations",
      summary: "Cache answer citations",
      body: "Merged implementation for cached project answer citations.",
      occurred_at: "2026-05-01T00:00:00.000Z",
      confidence_score: 0.9,
    });

    expect(addLearningsToGraph).toHaveBeenCalledTimes(1);
    const candidates = listProjectMemoryCandidates(ORG_ID, PROJECT_ID);
    expect(candidates?.[0].status).toBe("promoted");
    expect(candidates?.[0].promoted_node_id).toBe("kn-promoted");
  });

  it("auto-promotes high-confidence resolved Jira issue evidence", async () => {
    await recordProjectEvidence({
      org_id: ORG_ID,
      project_id: PROJECT_ID,
      source: "jira",
      source_type: "resolved_issue",
      source_id: "MWPW-123",
      source_title: "MWPW-123: Resolve answer timeout",
      summary: "Resolve answer timeout",
      body: "The timeout was resolved by bounding raw hits.",
      occurred_at: "2026-05-02T00:00:00.000Z",
      confidence_score: 0.9,
    });

    expect(addLearningsToGraph).toHaveBeenCalledTimes(1);
    expect(listProjectMemoryCandidates(ORG_ID, PROJECT_ID)?.[0].status).toBe("promoted");
  });

  it("keeps Slack-only evidence candidate-only even at high confidence", async () => {
    await recordProjectEvidence({
      org_id: ORG_ID,
      project_id: PROJECT_ID,
      source: "slack",
      source_type: "thread_url",
      source_id: "https://slack.example/archives/C/p1",
      source_url: "https://slack.example/archives/C/p1",
      source_title: "Slack thread",
      summary: "Thread about answer routing",
      body: "Slack discussion should not auto-promote.",
      occurred_at: "2026-05-03T00:00:00.000Z",
      source_instance: "T_MEMORY",
      native_id: "C_MEMORY:1746259200.000000",
      metadata: { workspace_id: "T_MEMORY", channel_id: "C_MEMORY", thread_ts: "1746259200.000000" },
      confidence_score: 0.95,
    });

    expect(addLearningsToGraph).not.toHaveBeenCalled();
    expect(listProjectMemoryCandidates(ORG_ID, PROJECT_ID)?.[0].status).toBe("pending");
  });

  it("rejects manual promotion when evidence is marked non-promotable", async () => {
    await recordProjectEvidence({
      org_id: ORG_ID,
      project_id: PROJECT_ID,
      source: "github",
      source_type: "issue",
      source_id: "adobe/app#123",
      source_title: "Architecture notes",
      summary: "Architecture notes",
      body: "A working note that must remain evidence-only.",
      occurred_at: "2026-05-03T00:00:00.000Z",
      confidence_score: 0.99,
      promotable: false,
    });

    const candidate = listProjectMemoryCandidates(ORG_ID, PROJECT_ID)?.[0];
    expect(candidate).toBeDefined();
    await expect(promoteProjectMemoryCandidate(ORG_ID, PROJECT_ID, candidate!.id)).resolves.toBeNull();
    expect(addLearningsToGraph).not.toHaveBeenCalled();
    expect(listProjectMemoryCandidates(ORG_ID, PROJECT_ID)?.[0].status).toBe("pending");
  });

  it("keeps low-confidence evidence out of the KG", async () => {
    await recordProjectEvidence({
      org_id: ORG_ID,
      project_id: PROJECT_ID,
      source: "github",
      source_type: "merged_pr",
      source_id: "adobe/app#44",
      source_title: "PR #44: Tentative answer copy",
      summary: "Tentative answer copy",
      body: "The evidence is too weak for automatic KG promotion.",
      occurred_at: "2026-05-04T00:00:00.000Z",
      confidence_score: 0.7,
    });

    expect(addLearningsToGraph).not.toHaveBeenCalled();
    expect(listProjectMemoryCandidates(ORG_ID, PROJECT_ID)?.[0].status).toBe("pending");
  });

  it("does not block auto-promotion on unrelated anti-patterns that only say avoid", async () => {
    vi.mocked(queryKnowledge).mockReturnValueOnce({
      nodes: [
        {
          summary: "Avoid legacy checkout deployment coupling",
          details: "Avoid risky release sequencing for LegacyCheckoutService.",
        },
      ],
      edges: [],
      total_matching: 1,
      token_estimate: 10,
      truncated: false,
      query_mode: "current",
    } as any);

    await recordProjectEvidence({
      org_id: ORG_ID,
      project_id: PROJECT_ID,
      source: "github",
      source_type: "merged_pr",
      source_id: "adobe/app#45",
      source_title: "PR #45: Cache answer citations",
      summary: "Cache answer citations",
      body: "Merged implementation for cached project answer citations.",
      occurred_at: "2026-05-05T00:00:00.000Z",
      confidence_score: 0.9,
    });

    expect(addLearningsToGraph).toHaveBeenCalledTimes(1);
    expect(listProjectMemoryCandidates(ORG_ID, PROJECT_ID)?.[0].status).toBe("promoted");
  });
});

describe("project source health", () => {
  it("keeps configured GitHub and Jira as missing_credentials when env is absent", async () => {
    setProjectResources({
      github: { repos: ["adobe/app"] },
      jira: { project_keys: ["MWPW"] },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const health = await getProjectSourceHealthLive(ORG_ID, PROJECT_ID);

    expect(healthFor(health, "github")?.credential_state).toBe("missing_credentials");
    expect(healthFor(health, "jira")?.credential_state).toBe("missing_credentials");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports GitHub 401 as invalid_credentials", async () => {
    setProjectResources({ github: { repos: ["adobe/app"] } });
    process.env.GH_TOKEN = "bad-token";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad credentials", { status: 401 })));

    const health = await getProjectSourceHealthLive(ORG_ID, PROJECT_ID);

    expect(healthFor(health, "github")?.credential_state).toBe("invalid_credentials");
    expect(healthFor(health, "github")?.message).toContain("GitHub 401");
    expect(healthFor(health, "github")?.message).not.toContain("bad credentials");
  });

  it("reports Jira TLS trust failures as unreachable", async () => {
    setProjectResources({ jira: { project_keys: ["MWPW"] } });
    process.env.JIRA_BASE_URL = "https://jira.corp.adobe.com";
    process.env.JIRA_TOKEN = "token";
    const tlsError = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" },
    });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw tlsError;
    }));

    const health = await getProjectSourceHealthLive(ORG_ID, PROJECT_ID);

    expect(healthFor(health, "jira")?.credential_state).toBe("unreachable");
    expect(healthFor(health, "jira")?.message).toContain("UNABLE_TO_GET_ISSUER_CERT_LOCALLY");
  });

  it("leaves unconfigured sources as not_configured without live probes", async () => {
    setProjectResources({});
    process.env.GH_TOKEN = "token";
    process.env.JIRA_BASE_URL = "https://jira.example.com";
    process.env.JIRA_TOKEN = "token";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const health = await getProjectSourceHealthLive(ORG_ID, PROJECT_ID);

    expect(health?.map((h) => h.credential_state)).toEqual([
      "not_configured",
      "not_configured",
      "not_configured",
      "not_configured",
      "not_configured",
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("project source polling", () => {
  it("does not purge configured GitHub or Jira evidence when legacy operator allowlists are absent", async () => {
    await recordProjectEvidence({
      org_id: ORG_ID,
      project_id: PROJECT_ID,
      source: "github",
      source_type: "issue",
      source_id: "adobe/app#7",
      source_title: "Issue #7",
      summary: "Configured GitHub evidence",
      body: "This row must survive a credential-only poll failure.",
      metadata: { repo: "adobe/app", number: 7 },
      confidence_score: 0.6,
    });
    await recordProjectEvidence({
      org_id: ORG_ID,
      project_id: PROJECT_ID,
      source: "jira",
      source_type: "active_issue",
      source_id: "MWPW-7",
      source_title: "MWPW-7",
      summary: "Configured Jira evidence",
      body: "This row must survive a credential-only poll failure.",
      metadata: { key: "MWPW-7" },
      confidence_score: 0.6,
    });
    delete process.env.PROJECT_GITHUB_VISIBLE_REPOS;
    delete process.env.PROJECT_JIRA_VISIBLE_PROJECT_KEYS;

    const result = await pollProjectSources(ORG_ID, PROJECT_ID);

    expect(result?.results.find((entry) => entry.source === "github")?.missing).toBe("GH_TOKEN not set");
    expect(result?.results.find((entry) => entry.source === "jira")?.missing).toBe("jira_source_poll_failed");
    expect(testDb.prepare(
      "SELECT source, source_id FROM project_evidence_items WHERE source IN ('github', 'jira') ORDER BY source",
    ).all()).toEqual([
      { source: "github", source_id: "adobe/app#7" },
      { source: "jira", source_id: "MWPW-7" },
    ]);
  });

  it("does not echo an upstream response body in poll failures", async () => {
    setProjectResources({ jira: { project_keys: ["MWPW"] } });
    process.env.JIRA_BASE_URL = "https://jira.example.com";
    process.env.JIRA_TOKEN = "token";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      "password=upstream-secret-must-not-leak",
      { status: 500 },
    )));

    const result = await pollProjectSources(ORG_ID, PROJECT_ID);
    const jira = result?.results.find((entry) => entry.source === "jira");

    expect(jira?.missing).toBe("jira_source_poll_failed");
    expect(JSON.stringify(result)).not.toContain("upstream-secret-must-not-leak");
  });

  it("ingests deeply nested Jira ADF descriptions without failing the Jira poll", async () => {
    setProjectResources({ jira: { project_keys: ["MWPW"] } });
    process.env.JIRA_BASE_URL = "https://jira.example.com";
    process.env.JIRA_TOKEN = "token";

    let description: unknown = { text: "leaf text" };
    for (let i = 0; i < 12_000; i++) {
      description = { content: [description] };
    }

    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        total: 1,
        issues: [{
          key: "MWPW-999",
          fields: {
            summary: "Deep ADF issue",
            description,
            updated: "2026-06-01T00:00:00.000Z",
            status: { name: "To Do", statusCategory: { key: "new", name: "To Do" } },
            issuetype: { name: "Task" },
          },
        }],
      }),
      text: async () => "",
    })));

    const result = await pollProjectSources(ORG_ID, PROJECT_ID);

    expect(result?.results.filter((r) => r.source === "jira")).toHaveLength(1);
    expect(result?.results.find((r) => r.source === "jira")?.missing).toBeUndefined();
    expect(
      testDb.prepare("SELECT COUNT(*) AS c FROM project_evidence_items WHERE source_id = ?").get("MWPW-999"),
    ).toMatchObject({ c: 1 });
  });

  it("resumes Jira pagination after the per-run cap and advances the high-water mark only when complete", async () => {
    setProjectResources({ jira: { project_keys: ["MWPW"] } });
    process.env.JIRA_BASE_URL = "https://jira.example.com";
    process.env.JIRA_TOKEN = "token";

    const updatedAt = (n: number) => {
      const minutes = n;
      const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
      const mm = String(minutes % 60).padStart(2, "0");
      return `2026-06-01T${hh}:${mm}:00.000Z`;
    };
    const issues = Array.from({ length: 550 }, (_, i) => {
      const n = 550 - i;
      return {
        key: `MWPW-${n}`,
        fields: {
          summary: `Issue ${n}`,
          updated: updatedAt(n),
          status: { name: "To Do", statusCategory: { key: "new", name: "To Do" } },
          issuetype: { name: "Task" },
        },
      };
    });
    const requests: Array<{ jql: string; startAt: number; maxResults: number }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { jql: string; startAt?: number; maxResults?: number };
      requests.push({ jql: body.jql, startAt: body.startAt ?? 0, maxResults: body.maxResults ?? 50 });
      const startAt = body.startAt ?? 0;
      const maxResults = body.maxResults ?? 50;
      return new Response(JSON.stringify({
        total: issues.length,
        issues: issues.slice(startAt, startAt + maxResults),
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));

    const first = await pollProjectSources(ORG_ID, PROJECT_ID);

    expect(first?.results.find((r) => r.source === "jira" && r.ingested > 0)?.ingested).toBe(500);
    const firstIncrementalRequests = requests.filter((request) => request.jql.includes("ORDER BY updated DESC, key DESC"));
    expect(firstIncrementalRequests[0].jql).toContain("updated >=");
    expect(firstIncrementalRequests.map((r) => r.startAt)).toEqual([0, 50, 100, 150, 200, 250, 300, 350, 400, 450]);
    expect(
      testDb.prepare("SELECT COUNT(*) AS c FROM project_evidence_items WHERE source_id = ?").get("MWPW-550"),
    ).toMatchObject({ c: 1 });
    expect(
      testDb.prepare("SELECT COUNT(*) AS c FROM project_evidence_items WHERE source_id = ?").get("MWPW-1"),
    ).toMatchObject({ c: 0 });
    expect(getProjectCursor(ORG_ID, PROJECT_ID, "jira", "issues")).toBeNull();
    expect(JSON.parse(getProjectCursor(ORG_ID, PROJECT_ID, "jira", "issues:page:v1") ?? "null")).toMatchObject({
      version: 1,
      start_at: 500,
      newest: updatedAt(550),
    });

    const second = await pollProjectSources(ORG_ID, PROJECT_ID);

    expect(second?.results.find((r) => r.source === "jira" && r.ingested > 0)?.ingested).toBe(50);
    expect(requests.filter((request) => request.jql.includes("ORDER BY updated DESC, key DESC")).at(-1)?.startAt).toBe(500);
    expect(
      testDb.prepare("SELECT COUNT(*) AS c FROM project_evidence_items WHERE source_id = ?").get("MWPW-1"),
    ).toMatchObject({ c: 1 });
    expect(getProjectCursor(ORG_ID, PROJECT_ID, "jira", "issues:page:v1")).toBeNull();
    expect(getProjectCursor(ORG_ID, PROJECT_ID, "jira", "issues")).toBe(updatedAt(550));
  });

  it("reconciles Jira issues that were deleted or moved outside the bound scope", async () => {
    setProjectResources({ jira: { project_keys: ["MWPW"], components: ["Project Search"] } });
    process.env.JIRA_BASE_URL = "https://jira.example.com";
    process.env.JIRA_TOKEN = "token";
    for (const key of ["MWPW-1", "MWPW-2"]) {
      await recordProjectEvidence({
        org_id: ORG_ID,
        project_id: PROJECT_ID,
        source: "jira",
        source_type: "active_issue",
        source_id: key,
        source_url: `https://jira.example.com/browse/${key}`,
        source_title: `${key}: scoped issue`,
        summary: "Scoped issue",
        body: "Project Search component",
        metadata: { components: ["Project Search"] },
        confidence_score: 0.6,
      });
    }
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { jql?: string };
      const issues = body.jql?.includes("ORDER BY key ASC") ? [{ key: "MWPW-1" }] : [];
      return new Response(JSON.stringify({ total: issues.length, issues }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }));

    const result = await pollProjectSources(ORG_ID, PROJECT_ID);

    expect(result?.results.find((entry) => entry.source === "jira")?.deleted).toBe(1);
    expect(testDb.prepare(
      "SELECT source_id FROM project_evidence_items WHERE source = 'jira' ORDER BY source_id",
    ).all()).toEqual([{ source_id: "MWPW-1" }]);
    expect(testDb.prepare(
      "SELECT COUNT(*) AS count FROM project_search_documents WHERE source = 'jira' AND source_id = 'MWPW-1'",
    ).get()).toMatchObject({ count: 1 });
    expect(testDb.prepare(
      "SELECT COUNT(*) AS count FROM project_search_documents WHERE source = 'jira' AND source_id = 'MWPW-2'",
    ).get()).toMatchObject({ count: 0 });
  });

  it("bounds GitHub reconciliation, resumes it, and deletes only after a complete scan", async () => {
    setProjectResources({ github: { repos: ["adobe/app"] } });
    process.env.GH_TOKEN = "token";
    for (const number of [1, 999]) {
      await recordProjectEvidence({
        org_id: ORG_ID,
        project_id: PROJECT_ID,
        source: "github",
        source_type: "issue",
        source_id: `adobe/app#${number}`,
        source_url: `https://github.com/adobe/app/issues/${number}`,
        source_title: `Issue #${number}`,
        summary: `Issue ${number}`,
        body: "GitHub issue",
        metadata: { repo: "adobe/app", number },
        confidence_score: 0.6,
      });
    }
    const upstream = Array.from({ length: 500 }, (_, index) => ({ number: index + 1 }));
    vi.stubGlobal("fetch", vi.fn(async (rawUrl: string) => {
      const url = new URL(rawUrl);
      if (url.pathname.endsWith("/issues") && url.searchParams.get("sort") === "created") {
        const page = Number(url.searchParams.get("page") ?? "1");
        const start = (page - 1) * 100;
        return new Response(JSON.stringify(upstream.slice(start, start + 100)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    }));

    const first = await pollProjectSources(ORG_ID, PROJECT_ID);

    expect(first?.results.find((entry) => entry.source === "github")?.deleted).toBeUndefined();
    expect(testDb.prepare(
      "SELECT COUNT(*) AS count FROM project_evidence_items WHERE source = 'github' AND source_id = 'adobe/app#999'",
    ).get()).toMatchObject({ count: 1 });
    expect(JSON.parse(getProjectCursor(
      ORG_ID,
      PROJECT_ID,
      "github",
      "repo:adobe/app:reconciliation:v1",
    ) ?? "null")).toMatchObject({ next_page: 6 });

    const second = await pollProjectSources(ORG_ID, PROJECT_ID);

    expect(second?.results.find((entry) => entry.source === "github")?.deleted).toBe(1);
    expect(testDb.prepare(
      "SELECT source_id FROM project_evidence_items WHERE source = 'github' ORDER BY source_id",
    ).all()).toEqual([{ source_id: "adobe/app#1" }]);
    expect(getProjectCursor(
      ORG_ID,
      PROJECT_ID,
      "github",
      "repo:adobe/app:reconciliation:v1",
    )).toBeNull();
  });

  it("keeps undated Jira release occurred_at stable across polls and returns one Jira result", async () => {
    setProjectResources({ jira: { project_keys: ["MWPW"], version_prefixes: ["T3-"] } });
    process.env.JIRA_BASE_URL = "https://jira.example.com";
    process.env.JIRA_TOKEN = "token";
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/versions")) {
        return new Response(JSON.stringify([
          { name: "T3-26.16", released: false, archived: false },
        ]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ total: 0, issues: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }));

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
      const first = await pollProjectSources(ORG_ID, PROJECT_ID);
      const firstOccurredAt = (testDb
        .prepare("SELECT occurred_at FROM project_evidence_items WHERE source_id = ?")
        .get("release:MWPW:T3-26.16") as { occurred_at: string }).occurred_at;

      vi.setSystemTime(new Date("2026-06-02T00:00:00.000Z"));
      const second = await pollProjectSources(ORG_ID, PROJECT_ID);
      const secondOccurredAt = (testDb
        .prepare("SELECT occurred_at FROM project_evidence_items WHERE source_id = ?")
        .get("release:MWPW:T3-26.16") as { occurred_at: string }).occurred_at;

      expect(first?.results.filter((r) => r.source === "jira")).toHaveLength(1);
      expect(second?.results.filter((r) => r.source === "jira")).toHaveLength(1);
      expect(first?.results.find((r) => r.source === "jira")?.ingested).toBe(1);
      expect(secondOccurredAt).toBe(firstOccurredAt);
      expect(secondOccurredAt).not.toBe("2026-06-02T00:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Project Answers", () => {
  it("answers from project evidence first and includes citations", async () => {
    await recordProjectEvidence({
      org_id: ORG_ID,
      project_id: PROJECT_ID,
      source: "jira",
      source_type: "resolved_issue",
      source_id: "MWPW-200",
      source_title: "MWPW-200: Project answer flow",
      summary: "Project answer flow is available",
      body: "Project Answers retrieve evidence before KG nodes.",
      occurred_at: "2026-05-05T00:00:00.000Z",
      confidence_score: 0.9,
    });

    const answer = await answerProjectQuestion(ORG_ID, PROJECT_ID, "What is the PAF status?");
    expect(answer?.intent).toBe("status");
    expect(answer?.sources_used).toContain("project_evidence");
    expect(answer?.citations[0].title).toContain("Project answer flow");
    expect(answer?.answer_markdown).toContain("Project answer flow");
  });
});
