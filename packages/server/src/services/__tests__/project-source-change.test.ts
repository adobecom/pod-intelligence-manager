import { beforeEach, describe, expect, it, vi } from "vitest";

const { testDb, retractProjectEvidenceKnowledgeNodes } = vi.hoisted(() => {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  return { testDb: db, retractProjectEvidenceKnowledgeNodes: vi.fn((_org: string, _project: string, ids: string[]) => ids) };
});

vi.mock("../../db/connection.js", () => ({
  default: testDb,
  withTransaction: (fn: () => unknown) => fn(),
}));

vi.mock("../knowledge-graph.js", () => ({
  addLearningsToGraph: vi.fn(async () => ({ nodesAdded: 0, edgesAdded: 0, nodeIds: [] })),
  queryKnowledge: vi.fn(() => ({ nodes: [], edges: [], total_matching: 0, token_estimate: 0, truncated: false })),
  retractProjectEvidenceKnowledgeNodes,
}));

import { createTables } from "../../db/schema.js";
import { createOrg } from "../orgs.js";
import { upsertUserByIms } from "../users.js";
import { indexProjectDocument } from "../project-search-index.js";
import {
  applySourceChanges,
  getProjectSourceSyncState,
  projectSourceId,
  purgeProjectEvidenceSource,
  recordProjectSourceReconciliation,
  recordProjectSourceSyncAttempt,
  recordProjectSourceSyncFailure,
  recordProjectSourceSyncSuccess,
  type SourceChange,
} from "../project-source-change.js";

const ORG_ID = "org_source_change";
const PROJECT_ID = "project-source-change";

function seedProject(): void {
  const creator = upsertUserByIms({ email: "source-change@local", display_name: "Source Change" });
  createOrg({ orgId: ORG_ID, slug: "source-change", name: "Source Change", creatorUserId: creator.user_id });
  testDb.prepare(
    "INSERT INTO projects (project_id, name, created_at, resources_json, org_id, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    PROJECT_ID,
    "Source Change",
    new Date().toISOString(),
    JSON.stringify({
      confluence: { page_ids: ["page-1"] },
      slack: { channels: ["workspace-a:C123"] },
      jira: { project_keys: ["EMC"] },
    }),
    ORG_ID,
    creator.user_id,
  );
}

function confluenceChange(overrides: Partial<SourceChange> = {}): SourceChange {
  return {
    org_id: ORG_ID,
    project_id: PROJECT_ID,
    source: "confluence",
    source_instance: "site-a",
    native_id: "page-1#overview",
    kind: "upsert",
    source_version: "7",
    visibility: "project_visible",
    visibility_version: "public-v1",
    occurred_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-02T00:00:00.000Z",
    evidence: {
      source_type: "section",
      source_url: "https://wiki.example/pages/1?token=topsecretvalue",
      source_title: "Overview token = topsecretvalue",
      summary: "Overview",
      body: "See EMC-123. Bearer abcdefghijklmnopqrstuvwxyz",
      metadata: {
        site_id: "site-a",
        page_id: "page-1",
        page_version: 7,
        heading: "Overview",
        ignored_payload: "drop me",
      },
      confidence_score: 0.7,
      promotable: false,
    },
    ...overrides,
  } as SourceChange;
}

beforeEach(() => {
  process.env.PROJECT_JIRA_VISIBLE_PROJECT_KEYS = "EMC";
  vi.clearAllMocks();
  testDb.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS project_search_fts;
    DROP TABLE IF EXISTS project_search_edges;
    DROP TABLE IF EXISTS project_search_entities;
    DROP TABLE IF EXISTS project_search_chunks;
    DROP TABLE IF EXISTS project_search_documents;
    DROP TABLE IF EXISTS project_source_quarantine;
    DROP TABLE IF EXISTS project_source_sync_state;
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

describe("SourceChange ingestion spine", () => {
  it("quarantines connector content when the project has no current source binding", async () => {
    testDb.prepare("UPDATE projects SET resources_json = '{}' WHERE project_id = ?").run(PROJECT_ID);

    const result = await applySourceChanges([confluenceChange()]);

    expect(result).toEqual({ upserted: 0, deleted: 0, quarantined: 1 });
    expect(testDb.prepare("SELECT COUNT(*) AS count FROM project_evidence_items").get()).toMatchObject({ count: 0 });
    expect(testDb.prepare("SELECT COUNT(*) AS count FROM project_search_documents").get()).toMatchObject({ count: 0 });
    expect(testDb.prepare("SELECT error_code FROM project_source_quarantine").get())
      .toMatchObject({ error_code: "resource_binding" });
  });

  it("upserts canonical redacted evidence and keeps Confluence out of the graph", async () => {
    const result = await applySourceChanges([confluenceChange()]);
    expect(result).toEqual({ upserted: 1, deleted: 0, quarantined: 0 });

    const evidence = testDb.prepare(
      `SELECT source_id, source_url, source_title, body, metadata_json, source_instance, native_id,
              source_version, visibility, visibility_version, redaction_version, normalized_content_hash
       FROM project_evidence_items`,
    ).get() as Record<string, unknown>;
    const persisted = JSON.stringify(evidence);
    expect(evidence.source_id).toBe(projectSourceId("confluence", "site-a", "page-1#overview"));
    expect(evidence).toMatchObject({
      source_instance: "site-a",
      native_id: "page-1#overview",
      source_version: "7",
      visibility: "project_visible",
      visibility_version: "public-v1",
    });
    expect(String(evidence.normalized_content_hash)).toMatch(/^[a-f0-9]{64}$/);
    expect(persisted).not.toContain("topsecretvalue");
    expect(persisted).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(JSON.parse(String(evidence.metadata_json))).not.toHaveProperty("ignored_payload");

    const document = testDb.prepare("SELECT id, graph_enabled FROM project_search_documents").get() as { id: string; graph_enabled: number };
    expect(document.graph_enabled).toBe(0);
    expect(testDb.prepare(
      "SELECT COUNT(*) AS count FROM project_search_entities WHERE source_document_id = ?",
    ).get(document.id)).toMatchObject({ count: 0 });
  });

  it("applies delete and newly restricted changes as hard deletion", async () => {
    const upsert = confluenceChange();
    await applySourceChanges(ORG_ID, PROJECT_ID, [upsert]);
    const restricted = confluenceChange({ kind: "upsert", visibility: "restricted" });
    const result = await applySourceChanges([restricted]);

    expect(result.deleted).toBe(1);
    expect(testDb.prepare("SELECT COUNT(*) AS count FROM project_evidence_items").get()).toMatchObject({ count: 0 });
    expect(testDb.prepare("SELECT COUNT(*) AS count FROM project_memory_candidates").get()).toMatchObject({ count: 0 });
    expect(testDb.prepare("SELECT COUNT(*) AS count FROM project_search_documents").get()).toMatchObject({ count: 0 });
    expect(testDb.prepare("SELECT COUNT(*) AS count FROM project_search_chunks").get()).toMatchObject({ count: 0 });
  });

  it("quarantines identifiers only when normalization fails", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.reactions = cyclic;
    const change = confluenceChange({
      source: "slack",
      source_instance: "workspace-a",
      native_id: "C123:1710000.001",
      evidence: {
        source_type: "thread",
        source_title: "Thread",
        summary: "Summary",
        body: "raw-body-must-never-persist",
        metadata: cyclic,
        confidence_score: 0.5,
      },
    });

    const result = await applySourceChanges([change]);
    expect(result.quarantined).toBe(1);
    const row = testDb.prepare("SELECT * FROM project_source_quarantine").get() as Record<string, unknown>;
    expect(row).toMatchObject({ source: "slack", source_instance: "workspace-a", native_id: "C123:1710000.001" });
    expect(JSON.stringify(row)).not.toContain("raw-body-must-never-persist");
    expect(testDb.prepare("SELECT COUNT(*) AS count FROM project_evidence_items").get()).toMatchObject({ count: 0 });
  });

  it("persists attempt/success/failure/reconciliation health without secret leakage", () => {
    recordProjectSourceSyncAttempt(ORG_ID, PROJECT_ID, "slack", "workspace-a", "2026-07-01T00:00:00.000Z");
    recordProjectSourceSyncFailure(
      ORG_ID,
      PROJECT_ID,
      "slack",
      "workspace-a",
      "HTTP 401",
      "request failed token = topsecretvalue",
      "2026-07-01T00:01:00.000Z",
    );
    let state = getProjectSourceSyncState(ORG_ID, PROJECT_ID, "slack", "workspace-a");
    expect(state).toMatchObject({ retry_count: 1, last_error_code: "sync_error" });
    expect(JSON.stringify(state)).not.toContain("topsecretvalue");

    recordProjectSourceSyncSuccess(ORG_ID, PROJECT_ID, "slack", "workspace-a", {
      succeeded_at: "2026-07-01T00:02:00.000Z",
      lag_seconds: 12,
      indexed_count: 3,
    });
    recordProjectSourceReconciliation(ORG_ID, PROJECT_ID, "slack", "workspace-a", "2026-07-01T00:03:00.000Z");
    state = getProjectSourceSyncState(ORG_ID, PROJECT_ID, "slack", "workspace-a");
    expect(state).toMatchObject({ retry_count: 0, lag_seconds: 12, indexed_count: 3 });
    expect(state?.last_error_code).toBeUndefined();
    expect(state?.last_reconciliation_at).toBe("2026-07-01T00:03:00.000Z");
  });

  it("conservatively purges legacy evidence, cursors, health, and indexed derivatives by source", async () => {
    const change = confluenceChange({
      source: "jira",
      source_instance: "https://jira.example",
      native_id: "EMC-123",
      evidence: {
        source_type: "issue",
        source_title: "EMC-123",
        summary: "Ticket",
        body: "Implements feature",
        confidence_score: 0.5,
      },
    });
    await applySourceChanges([change]);
    testDb.prepare(
      `INSERT INTO project_ingestion_cursors (org_id, project_id, source, cursor_key, cursor_value, updated_at)
       VALUES (?, ?, 'jira', 'issues', 'cursor', ?)`,
    ).run(ORG_ID, PROJECT_ID, new Date().toISOString());
    recordProjectSourceSyncSuccess(ORG_ID, PROJECT_ID, "jira", "https://jira.example", { indexed_count: 1 });

    const result = purgeProjectEvidenceSource(ORG_ID, PROJECT_ID, "jira");
    expect(result.evidence_deleted).toBe(1);
    expect(result.documents_deleted).toBe(1);
    expect(result.cursors_deleted).toBe(1);
    expect(result.sync_states_deleted).toBe(1);
    expect(testDb.prepare("SELECT COUNT(*) AS count FROM project_search_chunks").get()).toMatchObject({ count: 0 });
    expect(testDb.prepare("SELECT COUNT(*) AS count FROM project_search_entities").get()).toMatchObject({ count: 0 });
    expect(testDb.prepare("SELECT COUNT(*) AS count FROM project_search_edges").get()).toMatchObject({ count: 0 });
  });

  it("retracts promoted KG derivatives while preserving unrelated KG documents", async () => {
    await applySourceChanges([confluenceChange({
      source: "jira",
      source_instance: "jira.example",
      native_id: "EMC-900",
      evidence: {
        source_type: "resolved_issue",
        source_title: "EMC-900",
        summary: "Promoted ticket",
        body: "Resolved implementation evidence",
        confidence_score: 0.7,
      },
    })]);
    testDb.prepare("UPDATE project_evidence_items SET promoted_node_id = 'kn-derived'").run();
    indexProjectDocument({
      org_id: ORG_ID,
      project_id: PROJECT_ID,
      source: "kg",
      source_type: "decision",
      source_id: "kn-derived",
      title: "Derived node",
      body: "Derived details",
    });
    indexProjectDocument({
      org_id: ORG_ID,
      project_id: PROJECT_ID,
      source: "kg",
      source_type: "decision",
      source_id: "kn-unrelated",
      title: "Unrelated node",
      body: "Independent details",
    });

    purgeProjectEvidenceSource(ORG_ID, PROJECT_ID, "jira");

    expect(retractProjectEvidenceKnowledgeNodes).toHaveBeenCalledWith(
      ORG_ID,
      PROJECT_ID,
      ["kn-derived"],
    );
    expect(testDb.prepare(
      "SELECT source_id FROM project_search_documents WHERE source = 'kg' ORDER BY source_id",
    ).all()).toEqual([{ source_id: "kn-unrelated" }]);
  });
});
