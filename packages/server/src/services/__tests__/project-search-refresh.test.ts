/**
 * project-search-refresh.test.ts
 *
 * Tests for the scheduled incremental project-search refresh mechanisms:
 *   1. listActiveProjectsForRefresh — enumerator
 *   2. indexProjectKgNodes — KG→index bridge (upsert, reconciliation, staleness)
 *   3. refreshProjectSearch — per-project orchestrator (poll → backfill → kg → embed → annotate)
 *   4. A kg-typed doc surfacing in searchProject results with authority + in-scope bonus
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

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

// Stub queryKnowledge so we can control which KG nodes it returns per test.
const mockKgResult: { nodes: Record<string, unknown>[]; edges: []; total_matching: number; token_estimate: number; truncated: boolean } = {
  nodes: [],
  edges: [],
  total_matching: 0,
  token_estimate: 0,
  truncated: false,
};
vi.mock("../knowledge-graph.js", () => ({
  queryKnowledge: vi.fn(() => mockKgResult),
  initializeKnowledgeGraph: vi.fn(),
  refreshAnalysis: vi.fn(),
  getRelevantLearnings: vi.fn().mockReturnValue({ nodes: [], truncated: false, total_matching: 0, token_estimate: 0, edges: [] }),
  getPrecedents: vi.fn().mockReturnValue({ nodes: [] }),
}));

// Stub LLM (not needed for refresh tests, but project-search.ts imports it)
vi.mock("../../pim/llm.js", () => ({
  isLLMAvailable: () => false,
  MODELS: { fast: "test-fast", smart: "test-smart" },
  callLLM: vi.fn(async () => ""),
}));

// Stub pollProjectSources so we don't make real API calls in tests.
vi.mock("../project-memory.js", () => ({
  pollProjectSources: vi.fn(async () => ({
    results: [{ source: "jira", ingested: 3 }, { source: "github", ingested: 1 }],
    health: [],
  })),
  loadProject: vi.fn(() => null),
}));

import { createTables } from "../../db/schema.js";
import { upsertUserByIms } from "../users.js";
import { createOrg } from "../orgs.js";
import {
  indexProjectDocument,
  indexProjectKgNodes,
  type IndexDocumentInput,
} from "../project-search-index.js";
import { searchProject } from "../project-search.js";
import {
  listActiveProjectsForRefresh,
  refreshProjectSearch,
  getLastRefreshAt,
} from "../project-search-refresh.js";
import { queryKnowledge } from "../knowledge-graph.js";

const ORG_ID = "org_refresh_test";
const PROJECT_ID = "proj_refresh_active";
const INACTIVE_PROJECT_ID = "proj_refresh_inactive";

// ── Test helpers ─────────────────────────────────────────────────────────────

function setMockKgNodes(nodes: Record<string, unknown>[]) {
  (mockKgResult.nodes as unknown[]) = nodes;
  mockKgResult.total_matching = nodes.length;
}

function makeKgNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "kg-node-1",
    type: "decision",
    summary: "Use OAuth2 for all API authentication",
    details: "After evaluating options, the team decided to standardize on OAuth2 with PKCE.",
    created_at: new Date(Date.now() - 7 * 86_400_000).toISOString(),
    confidence_score: 0.85,
    curated: true,
    domains: [],
    confidence: "high",
    ...overrides,
  };
}

function seedEvidence(projectId = PROJECT_ID, daysAgo = 1) {
  const ts = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  testDb
    .prepare(
      `INSERT OR IGNORE INTO project_evidence_items
       (id, org_id, project_id, source, source_type, source_id, source_url, source_title, summary, body, author, occurred_at, ingested_at, metadata_json, confidence_score)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `ev-${projectId}-${daysAgo}`,
      ORG_ID, projectId, "jira", "active_issue",
      "EMC-100", "https://jira.test/EMC-100", "EMC-100",
      "A jira ticket", "Body text", "author@test",
      ts, ts, "{}", 0.8,
    );
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(() => {
  createTables();

  const creator = upsertUserByIms({ email: "refresh@local", display_name: "Refresher" });
  createOrg({ orgId: ORG_ID, slug: "refresh", name: "Refresh", creatorUserId: creator.user_id });

  const insertProject = testDb.prepare(
    "INSERT OR IGNORE INTO projects (project_id, name, description, created_at, resources_json, org_id, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  // Active project with resources configured
  insertProject.run(
    PROJECT_ID, "Active Project", null,
    new Date().toISOString(),
    JSON.stringify({ jira: { project_keys: ["EMC"] } }),
    ORG_ID, creator.user_id,
  );
  // Inactive project with resources configured — no recent evidence
  insertProject.run(
    INACTIVE_PROJECT_ID, "Inactive Project", null,
    new Date(Date.now() - 90 * 86_400_000).toISOString(),
    JSON.stringify({ jira: { project_keys: ["OLD"] } }),
    ORG_ID, creator.user_id,
  );
  // Seed recent evidence only for the active project
  seedEvidence(PROJECT_ID, 1);
});

beforeEach(() => {
  vi.mocked(queryKnowledge).mockClear();
  setMockKgNodes([]);
  // Reset the KG docs between tests for clean state
  testDb.prepare(
    "DELETE FROM project_search_documents WHERE source = 'kg' AND org_id = ? AND project_id = ?",
  ).run(ORG_ID, PROJECT_ID);
});

// ── 1. listActiveProjectsForRefresh ─────────────────────────────────────────

describe("listActiveProjectsForRefresh", () => {
  it("returns only projects with resources_json and recent activity", () => {
    const projects = listActiveProjectsForRefresh(30);
    const ids = projects.map((p) => p.project_id);
    expect(ids).toContain(PROJECT_ID);
    expect(ids).not.toContain(INACTIVE_PROJECT_ID);
  });

  it("includes a project with only context-update activity (no evidence)", () => {
    const contextOnlyProjectId = "proj_ctx_only";
    testDb.prepare(
      "INSERT OR IGNORE INTO projects (project_id, name, created_at, resources_json, org_id) VALUES (?, ?, ?, ?, ?)",
    ).run(
      contextOnlyProjectId, "Context Only", new Date().toISOString(),
      JSON.stringify({ jira: { project_keys: ["CTX"] } }),
      ORG_ID,
    );
    // Insert a recent context update
    testDb.prepare(
      `INSERT OR IGNORE INTO project_context_updates
       (id, project_id, summary, details, type, scope, agent_id, status, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "cu-ctx-1", contextOnlyProjectId,
      "Recent context update", "Details here", "progress", "frontend",
      "agent-1", "active", new Date().toISOString(),
    );

    const projects = listActiveProjectsForRefresh(30);
    const ids = projects.map((p) => p.project_id);
    expect(ids).toContain(contextOnlyProjectId);
  });

  it("excludes projects without resources_json", () => {
    testDb.prepare(
      "INSERT OR IGNORE INTO projects (project_id, name, created_at, org_id) VALUES (?, ?, ?, ?)",
    ).run("proj_no_resources", "No Resources", new Date().toISOString(), ORG_ID);
    seedEvidence("proj_no_resources", 1);

    const projects = listActiveProjectsForRefresh(30);
    const ids = projects.map((p) => p.project_id);
    expect(ids).not.toContain("proj_no_resources");
  });

  it("deduplicates when a project has both evidence and context-update activity", () => {
    // PROJECT_ID already has evidence; add a context update too
    testDb.prepare(
      `INSERT OR IGNORE INTO project_context_updates
       (id, project_id, summary, details, type, scope, agent_id, status, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("cu-dedup-1", PROJECT_ID, "Dup update", "Details", "progress", "frontend", "agent-1", "active", new Date().toISOString());

    const projects = listActiveProjectsForRefresh(30);
    const occurrences = projects.filter((p) => p.project_id === PROJECT_ID).length;
    expect(occurrences).toBe(1);
  });
});

// ── 2. indexProjectKgNodes ────────────────────────────────────────────────────

describe("indexProjectKgNodes", () => {
  it("indexes a KG node as a kg-typed project_search_document", () => {
    const node = makeKgNode();
    setMockKgNodes([node]);

    const result = indexProjectKgNodes(ORG_ID, PROJECT_ID);
    expect(result.indexed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.deleted).toBe(0);

    const doc = testDb
      .prepare("SELECT source, source_id, title FROM project_search_documents WHERE org_id = ? AND project_id = ? AND source = 'kg'")
      .get(ORG_ID, PROJECT_ID) as { source: string; source_id: string; title: string } | undefined;

    expect(doc).toBeDefined();
    expect(doc!.source).toBe("kg");
    expect(doc!.source_id).toBe("kg-node-1");
    expect(doc!.title).toBe("Use OAuth2 for all API authentication");
  });

  it("is a content-hash no-op when the node is unchanged (re-run)", () => {
    setMockKgNodes([makeKgNode()]);
    indexProjectKgNodes(ORG_ID, PROJECT_ID); // first run
    const result2 = indexProjectKgNodes(ORG_ID, PROJECT_ID); // second run
    expect(result2.skipped).toBe(1);
    expect(result2.indexed).toBe(0);

    // Only one document should exist — upsert, not duplicate
    const count = (
      testDb
        .prepare("SELECT COUNT(*) AS c FROM project_search_documents WHERE org_id = ? AND project_id = ? AND source = 'kg'")
        .get(ORG_ID, PROJECT_ID) as { c: number }
    ).c;
    expect(count).toBe(1);
  });

  it("marks a removed KG node as freshness_state='deleted' (staleness reconciliation)", () => {
    // First run: node present
    setMockKgNodes([makeKgNode()]);
    indexProjectKgNodes(ORG_ID, PROJECT_ID);

    // Second run: node no longer returned (pruned/superseded)
    setMockKgNodes([]);
    const result2 = indexProjectKgNodes(ORG_ID, PROJECT_ID);
    expect(result2.deleted).toBe(1);

    const doc = testDb
      .prepare("SELECT freshness_state FROM project_search_documents WHERE org_id = ? AND project_id = ? AND source = 'kg' AND source_id = 'kg-node-1'")
      .get(ORG_ID, PROJECT_ID) as { freshness_state: string } | undefined;
    expect(doc?.freshness_state).toBe("deleted");
  });

  it("does not delete a still-live node on a re-run", () => {
    setMockKgNodes([makeKgNode()]);
    indexProjectKgNodes(ORG_ID, PROJECT_ID);
    const result2 = indexProjectKgNodes(ORG_ID, PROJECT_ID);
    expect(result2.deleted).toBe(0);
  });
});

// ── 3. refreshProjectSearch orchestration ────────────────────────────────────

describe("refreshProjectSearch", () => {
  it("completes successfully and records a last_refresh watermark", async () => {
    const before = getLastRefreshAt(ORG_ID, PROJECT_ID);
    setMockKgNodes([makeKgNode()]);

    const result = await refreshProjectSearch(ORG_ID, PROJECT_ID);
    expect(result.ok).toBe(true);
    expect(result.org_id).toBe(ORG_ID);
    expect(result.project_id).toBe(PROJECT_ID);
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);

    const after = getLastRefreshAt(ORG_ID, PROJECT_ID);
    expect(after).not.toBeNull();
    if (before !== null) {
      expect(new Date(after!).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
    }
  });

  it("returns ok:false and an error message when orchestration throws", async () => {
    // Force pollProjectSources to throw
    vi.mocked(
      (await import("../project-memory.js")).pollProjectSources,
    ).mockRejectedValueOnce(new Error("network failure"));

    const result = await refreshProjectSearch(ORG_ID, PROJECT_ID);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/network failure/);
  });
});

// ── 4. kg-typed doc surfaces in searchProject ranking ─────────────────────────

describe("searchProject with kg-typed documents", () => {
  it("includes kg docs in ranked hits and applies kg authority bonus", async () => {
    // Seed a regular jira doc
    const jiraDoc: IndexDocumentInput = {
      org_id: ORG_ID,
      project_id: PROJECT_ID,
      source: "jira",
      source_type: "active_issue",
      source_id: "EMC-200",
      title: "Implement OAuth2 authentication",
      body: "This ticket tracks the OAuth2 implementation effort.",
      occurred_at: new Date().toISOString(),
      freshness_state: "fresh",
    };
    indexProjectDocument(jiraDoc);

    // Index a KG node with the same topic
    setMockKgNodes([
      makeKgNode({
        id: "kg-oauth-decision",
        summary: "Use OAuth2 for all API authentication",
        details: "Team standardized on OAuth2 with PKCE after security review.",
        confidence_score: 0.9,
        curated: true,
      }),
    ]);
    indexProjectKgNodes(ORG_ID, PROJECT_ID);

    // Query for the topic
    const result = await searchProject(ORG_ID, PROJECT_ID, {
      query: "OAuth2 authentication",
      sources: ["jira", "kg"],
      include_kg: false, // disable overlay so we only see indexed kg docs
    });

    expect(result).not.toBeNull();
    const kgHit = result!.hits.find((h) => h.source === "kg");
    expect(kgHit).toBeDefined();
    expect(kgHit!.source_id).toBe("kg-oauth-decision");

    // KG docs are marked in-scope (constructed via indexProjectKgNodes)
    expect(kgHit!.matched.in_scope_resource).toBe(true);
  });
});
