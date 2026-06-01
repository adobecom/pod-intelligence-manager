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
}));

import { createTables } from "../../db/schema.js";
import { upsertUserByIms } from "../users.js";
import { createOrg } from "../orgs.js";
import {
  getProjectSourceHealthLive,
  listProjectMemoryCandidates,
  recordProjectEvidence,
} from "../project-memory.js";
import { answerProjectQuestion } from "../project-answers.js";
import { addLearningsToGraph } from "../knowledge-graph.js";

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
  testDb.exec(`
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
      confidence_score: 0.95,
    });

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

    const answer = answerProjectQuestion(ORG_ID, PROJECT_ID, "What is the PAF status?");
    expect(answer?.intent).toBe("status");
    expect(answer?.sources_used).toContain("project_evidence");
    expect(answer?.citations[0].title).toContain("Project answer flow");
    expect(answer?.answer_markdown).toContain("Project answer flow");
  });
});
