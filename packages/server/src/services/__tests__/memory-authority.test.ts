import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_ORG_TUNING, type EnhancedPodLearning } from "@pim/shared";

const { testDb, graphRoot, ingestLearnings } = vi.hoisted(() => {
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const root = mkdtempSync(join(tmpdir(), "pim-memory-authority-"));
  process.env.KG_DATA_DIR = root;
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  return {
    testDb: database,
    graphRoot: root,
    ingestLearnings: vi.fn(async () => ({
      nodesAdded: 1,
      edgesAdded: 0,
      nodeIds: [`kn-promoted-${crypto.randomUUID()}`],
      droppedCount: 0,
    })),
  };
});

vi.mock("../../db/connection.js", () => ({
  default: testDb,
  withTransaction: (fn: () => unknown) => fn(),
  withImmediateTransaction: (fn: () => unknown) => fn(),
}));

vi.mock("../ingestion-gateway.js", () => ({ ingestLearnings }));

vi.mock("../org-settings.js", () => ({
  getKgContextContract: vi.fn(() => "legacy"),
  getOrgTuning: vi.fn(() => DEFAULT_ORG_TUNING),
}));

vi.mock("../embeddings.js", () => ({
  generateEmbedding: vi.fn(async () => null),
  embedText: vi.fn((value: { summary?: string; details?: string }) =>
    `${value.summary ?? ""}\n${value.details ?? ""}`),
  embeddingTextHash: vi.fn(() => "embedding-hash"),
  batchEmbedWithRateLimit: vi.fn(async () => undefined),
  cosineSimilarity: vi.fn(() => 0),
  isEmbeddingAvailable: vi.fn(() => false),
}));

vi.mock("../project-search-index.js", () => ({ indexEvidenceItem: vi.fn() }));

vi.mock("../../pim/llm.js", () => ({
  isLLMAvailable: vi.fn(() => false),
  MODELS: { fast: "test-fast", smart: "test-smart" },
  callLLM: vi.fn(),
  callLLMJSON: vi.fn(async () => null),
}));

vi.mock("../../pim/agents/knowledge-extraction.js", () => ({
  classifyDecisionDurability: vi.fn(async () => new Map()),
}));

import { createTables } from "../../db/schema.js";
import {
  CanonicalMemoryAuthorityRequiredError,
  LegacyMemoryAuthorityFrozenError,
  assertCanonicalMemoryAuthorityRequired,
  assertLegacyMemoryWritable,
  getMemoryAuthorityState,
  installLegacySqlWriteBarriers,
  legacyMemoryWritesFrozen,
} from "../memory-authority.js";
import { graphDataRoot, saveGraph } from "../graph-storage.js";
import {
  _resetForTests,
  addLearningsToGraph,
  curateNode,
  getGraph,
  initializeKnowledgeGraph,
} from "../knowledge-graph.js";
import {
  getMemoryCandidate,
  promoteMemoryCandidate,
  rejectMemoryCandidate,
} from "../agent-memory.js";
import {
  listProjectMemoryCandidates,
  promoteProjectMemoryCandidate,
  rejectProjectMemoryCandidate,
  recordProjectEvidence,
} from "../project-memory.js";

const ORG_ID = "org-memory-authority";
const PROJECT_ID = "project-memory-authority";
const NOW = "2026-08-03T00:00:00.000Z";

const learning = (summary: string): EnhancedPodLearning => ({
  type: "decision",
  summary,
  details: `${summary} remains durable only while the legacy graph is authoritative.`,
  domains: ["authority"],
  confidence: "extracted",
  confidence_score: 0.9,
});

function insertAgentCandidate(id: string): void {
  testDb.prepare(
    `INSERT INTO memory_candidates
       (id, org_id, source_type, source_id, type, summary, details,
        domains_json, confidence_score, evidence_json, status, created_at)
     VALUES (?, ?, 'agent_run', ?, 'decision', ?, ?, '["authority"]', 0.9, '{}', 'pending', ?)`,
  ).run(
    id,
    ORG_ID,
    `source-${id}`,
    `Candidate ${id} records a durable authority decision`,
    `Candidate ${id} has enough detail to pass the legacy structural activation boundary.`,
    NOW,
  );
}

async function createProjectCandidate(sourceId: string): Promise<string> {
  await recordProjectEvidence({
    org_id: ORG_ID,
    project_id: PROJECT_ID,
    source: "project_update",
    source_type: "decision",
    source_id: sourceId,
    source_title: `Authority evidence ${sourceId}`,
    summary: `Authority evidence ${sourceId} is durable`,
    body: `Authority evidence ${sourceId} contains enough detail for a manual legacy promotion.`,
    occurred_at: NOW,
    confidence_score: 0.8,
    promotable: true,
  });
  const candidate = listProjectMemoryCandidates(ORG_ID, PROJECT_ID, "pending")
    ?.find((item) => item.source === "project_update" && item.summary.includes(sourceId));
  if (!candidate) throw new Error(`Project candidate was not created for ${sourceId}`);
  return candidate.id;
}

afterAll(() => {
  _resetForTests();
  testDb.close();
  fs.rmSync(graphRoot, { recursive: true, force: true });
});

describe("durable legacy memory authority freeze", () => {
  it("allows legacy writes before cutover and blocks graph, promotion, storage, and SQL writes after it", async () => {
    createTables();
    testDb.exec(`
      CREATE TABLE IF NOT EXISTS memory_authority_transitions (
        transition_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL UNIQUE CHECK (revision >= 1),
        from_authority TEXT NOT NULL CHECK (from_authority IN ('legacy','migration_locked','canonical')),
        to_authority TEXT NOT NULL CHECK (to_authority IN ('legacy','migration_locked','canonical')),
        legacy_writes_frozen INTEGER NOT NULL CHECK (legacy_writes_frozen IN (0,1)),
        import_run_id TEXT,
        actor_id TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
    `);
    testDb.prepare(
      `INSERT INTO users (user_id, email, display_name, is_service, created_at)
       VALUES ('authority-user', 'authority@local', 'Authority User', 0, ?)`,
    ).run(NOW);
    testDb.prepare(
      `INSERT INTO orgs (org_id, slug, name, created_by_user_id, created_at)
       VALUES (?, 'memory-authority', 'Memory Authority', 'authority-user', ?)`,
    ).run(ORG_ID, NOW);
    testDb.prepare(
      `INSERT INTO projects
         (project_id, name, description, created_at, resources_json, org_id, created_by_user_id)
       VALUES (?, 'Authority Project', NULL, ?, '{}', ?, 'authority-user')`,
    ).run(PROJECT_ID, NOW, ORG_ID);

    expect(getMemoryAuthorityState()).toEqual({
      authority: "legacy",
      legacyWritesFrozen: false,
      revision: 0,
    });
    expect(legacyMemoryWritesFrozen()).toBe(false);
    expect(() => assertLegacyMemoryWritable("pre_cutover_test")).not.toThrow();
    expect(() => assertCanonicalMemoryAuthorityRequired(false)).not.toThrow();
    expect(() => assertCanonicalMemoryAuthorityRequired(true)).toThrowError(
      CanonicalMemoryAuthorityRequiredError,
    );

    initializeKnowledgeGraph(ORG_ID);
    await addLearningsToGraph(
      ORG_ID,
      [learning("First legacy authority node"), learning("Second legacy authority node")],
      "pod-authority",
      "Authority Pod",
    );
    const graph = getGraph(ORG_ID);
    expect(graph.nodes).toHaveLength(2);
    await expect(curateNode(ORG_ID, graph.nodes[0].id, "approve")).resolves.toBe(true);
    expect(graph.nodes[0].curated).toBe(true);
    saveGraph(ORG_ID, graph);

    insertAgentCandidate("agent-before-freeze");
    insertAgentCandidate("agent-after-freeze");
    await expect(promoteMemoryCandidate(ORG_ID, "agent-before-freeze"))
      .resolves.toMatchObject({ status: "promoted" });
    const projectBefore = await createProjectCandidate("project-before-freeze");
    const projectAfter = await createProjectCandidate("project-after-freeze");
    await expect(promoteProjectMemoryCandidate(ORG_ID, PROJECT_ID, projectBefore))
      .resolves.toMatchObject({ status: "promoted" });

    const latestPath = path.join(graphDataRoot, ORG_ID, "graph-latest.json");
    const durableBeforeFreeze = fs.readFileSync(latestPath, "utf8");
    const graphBeforeFreeze = structuredClone(getGraph(ORG_ID));
    const ingestCallsBeforeFreeze = ingestLearnings.mock.calls.length;

    testDb.prepare(
      `INSERT INTO memory_authority_transitions
       (transition_id, revision, from_authority, to_authority, legacy_writes_frozen,
          import_run_id, actor_id, reason_code, occurred_at)
       VALUES ('authority-transition-1', 1, 'legacy', 'migration_locked', 1,
               NULL, 'authority-test', 'offline_cutover_locked', ?)`,
    ).run(NOW);
    testDb.prepare(
      `INSERT INTO memory_authority_transitions
         (transition_id, revision, from_authority, to_authority, legacy_writes_frozen,
          import_run_id, actor_id, reason_code, occurred_at)
       VALUES ('authority-transition-2', 2, 'migration_locked', 'canonical', 1,
               NULL, 'authority-test', 'offline_cutover_complete', ?)`,
    ).run(NOW);
    installLegacySqlWriteBarriers();
    installLegacySqlWriteBarriers();

    expect(getMemoryAuthorityState()).toEqual({
      authority: "canonical",
      legacyWritesFrozen: true,
      revision: 2,
    });
    expect(legacyMemoryWritesFrozen()).toBe(true);
    expect(assertCanonicalMemoryAuthorityRequired(true)).toEqual({
      authority: "canonical",
      legacyWritesFrozen: true,
      revision: 2,
    });
    expect(() => assertLegacyMemoryWritable("post_cutover_test")).toThrowError(
      expect.objectContaining({
        name: "LegacyMemoryAuthorityFrozenError",
        code: "legacy_authority_frozen",
        statusCode: 409,
      }),
    );

    await expect(addLearningsToGraph(
      ORG_ID,
      [learning("Forbidden post-cutover node")],
      "pod-authority",
      "Authority Pod",
    )).rejects.toBeInstanceOf(LegacyMemoryAuthorityFrozenError);
    expect(getGraph(ORG_ID)).toEqual(graphBeforeFreeze);

    await expect(curateNode(ORG_ID, graph.nodes[1].id, "approve"))
      .rejects.toBeInstanceOf(LegacyMemoryAuthorityFrozenError);
    expect(getGraph(ORG_ID).nodes[1].curated).toBe(false);

    const replacement = structuredClone(graphBeforeFreeze);
    replacement.version += 1;
    replacement.nodes = [];
    expect(() => saveGraph(ORG_ID, replacement)).toThrowError(LegacyMemoryAuthorityFrozenError);
    expect(fs.readFileSync(latestPath, "utf8")).toBe(durableBeforeFreeze);

    await expect(promoteMemoryCandidate(ORG_ID, "agent-after-freeze"))
      .rejects.toBeInstanceOf(LegacyMemoryAuthorityFrozenError);
    expect(() => rejectMemoryCandidate(ORG_ID, "agent-after-freeze"))
      .toThrowError(LegacyMemoryAuthorityFrozenError);
    expect(getMemoryCandidate(ORG_ID, "agent-after-freeze")?.status).toBe("pending");

    await expect(promoteProjectMemoryCandidate(ORG_ID, PROJECT_ID, projectAfter))
      .rejects.toBeInstanceOf(LegacyMemoryAuthorityFrozenError);
    expect(() => rejectProjectMemoryCandidate(ORG_ID, PROJECT_ID, projectAfter))
      .toThrowError(LegacyMemoryAuthorityFrozenError);
    expect(listProjectMemoryCandidates(ORG_ID, PROJECT_ID, "pending")?.map((item) => item.id))
      .toContain(projectAfter);
    expect(ingestLearnings.mock.calls).toHaveLength(ingestCallsBeforeFreeze);

    const candidateCountBeforeFrozenEvidence = (testDb.prepare(
      "SELECT COUNT(*) AS count FROM project_memory_candidates",
    ).get() as { count: number }).count;
    const evidenceOnly = await recordProjectEvidence({
      org_id: ORG_ID,
      project_id: PROJECT_ID,
      source: "project_update",
      source_type: "decision",
      source_id: "project-after-freeze-evidence-only",
      source_title: "Frozen project evidence remains searchable",
      summary: "Frozen project evidence does not create legacy candidates",
      body: "Project evidence intake remains available for search but candidate creation and promotion are retired under frozen authority.",
      occurred_at: NOW,
      confidence_score: 0.9,
      promotable: true,
    });
    expect(evidenceOnly.source_id).toBe("project-after-freeze-evidence-only");
    expect(testDb.prepare("SELECT COUNT(*) AS count FROM project_memory_candidates").get())
      .toMatchObject({ count: candidateCountBeforeFrozenEvidence });

    expect(() => testDb.prepare(
      "UPDATE memory_candidates SET summary = 'blocked' WHERE id = 'agent-after-freeze'",
    ).run()).toThrow(/legacy_authority_frozen/);
    expect(() => testDb.prepare(
      "DELETE FROM memory_candidates WHERE id = 'agent-after-freeze'",
    ).run()).toThrow(/legacy_authority_frozen/);
    expect(() => testDb.prepare(
      `INSERT INTO memory_candidates
         (id, org_id, source_type, source_id, type, summary, details, status, created_at)
       VALUES ('blocked-agent-insert', ?, 'agent_run', 'blocked-source', 'decision',
               'Blocked agent insert', 'Blocked agent insert has sufficient detail.', 'pending', ?)`,
    ).run(ORG_ID, NOW)).toThrow(/legacy_authority_frozen/);

    expect(() => testDb.prepare(
      "UPDATE project_memory_candidates SET summary = 'blocked' WHERE id = ?",
    ).run(projectAfter)).toThrow(/legacy_authority_frozen/);
    expect(() => testDb.prepare(
      "DELETE FROM project_memory_candidates WHERE id = ?",
    ).run(projectAfter)).toThrow(/legacy_authority_frozen/);
    expect(() => testDb.prepare(
      `INSERT INTO project_memory_candidates
         (id, org_id, project_id, evidence_item_id, type, summary, details,
          confidence_score, source, status, created_at)
       SELECT 'blocked-project-insert', org_id, project_id, evidence_item_id, type,
              'Blocked project insert', details, confidence_score, source, 'pending', ?
       FROM project_memory_candidates WHERE id = ?`,
    ).run(NOW, projectAfter)).toThrow(/legacy_authority_frozen/);

    const promotedEvidenceId = (testDb.prepare(
      "SELECT evidence_item_id FROM project_memory_candidates WHERE id = ?",
    ).get(projectBefore) as { evidence_item_id: string }).evidence_item_id;
    const pendingEvidenceId = (testDb.prepare(
      "SELECT evidence_item_id FROM project_memory_candidates WHERE id = ?",
    ).get(projectAfter) as { evidence_item_id: string }).evidence_item_id;
    expect(() => testDb.prepare(
      "UPDATE project_evidence_items SET promoted_node_id = 'kn-blocked' WHERE id = ?",
    ).run(pendingEvidenceId)).toThrow(/legacy_authority_frozen/);
    expect(() => testDb.prepare(
      "UPDATE project_evidence_items SET promoted_node_id = NULL WHERE id = ?",
    ).run(promotedEvidenceId)).toThrow(/legacy_authority_frozen/);
    expect(() => testDb.prepare(
      `INSERT INTO project_evidence_items
         (id, org_id, project_id, source, source_type, source_id, source_title,
          summary, body, occurred_at, ingested_at, promoted_node_id)
       VALUES ('blocked-evidence-insert', ?, ?, 'project_update', 'decision',
               'blocked-evidence-source', 'Blocked evidence', 'Blocked evidence insert',
               'Blocked promoted evidence insert has sufficient detail.', ?, ?, 'kn-blocked')`,
    ).run(ORG_ID, PROJECT_ID, NOW, NOW)).toThrow(/legacy_authority_frozen/);
  });
});
