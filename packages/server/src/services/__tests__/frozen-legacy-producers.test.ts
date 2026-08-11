import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  return {
    testDb: database,
    ingestLearnings: vi.fn(),
    getGraph: vi.fn(() => ({
      org_id: "org-frozen-producers",
      version: 1,
      nodes: [],
      edges: [],
      communities: [],
      last_updated: "2026-08-09T12:00:00.000Z",
    })),
    callLLMJSON: vi.fn(),
  };
});

vi.mock("../../db/connection.js", () => ({
  default: mocks.testDb,
  withTransaction: (fn: () => unknown) => fn(),
  withImmediateTransaction: (fn: () => unknown) => fn(),
}));

vi.mock("../ingestion-gateway.js", () => ({ ingestLearnings: mocks.ingestLearnings }));
vi.mock("../knowledge-graph.js", () => ({ getGraph: mocks.getGraph }));
vi.mock("../embeddings.js", () => ({ isEmbeddingAvailable: vi.fn(() => true) }));
vi.mock("../../pim/llm.js", () => ({
  isLLMAvailable: vi.fn(() => true),
  MODELS: { fast: "test-fast" },
  callLLMJSON: mocks.callLLMJSON,
}));
vi.mock("../graph-analysis.js", () => ({ identifyHubs: vi.fn(() => []) }));

import { createTables } from "../../db/schema.js";
import { seedKnowledgeGraph } from "../../db/seed-knowledge.js";
import { runScheduledGraphSynthesis } from "../knowledge-synthesis.js";

const ORG_ID = "org-frozen-producers";
const NOW = "2026-08-09T12:00:00.000Z";

beforeAll(() => {
  createTables();
  mocks.testDb.prepare(
    "INSERT INTO users (user_id, email, created_at) VALUES ('frozen-producer-user', 'frozen-producer@local', ?)",
  ).run(NOW);
  mocks.testDb.prepare(
    `INSERT INTO orgs (org_id, slug, name, created_by_user_id, created_at)
     VALUES (?, 'frozen-producers', 'Frozen Producers', 'frozen-producer-user', ?)`,
  ).run(ORG_ID, NOW);
  mocks.testDb.prepare(
    `INSERT INTO memory_authority_transitions
       (transition_id, revision, from_authority, to_authority, legacy_writes_frozen,
        import_run_id, actor_id, reason_code, occurred_at)
     VALUES ('frozen-producer-transition-1', 1, 'legacy', 'migration_locked', 1,
             NULL, 'frozen-producer-test', 'offline_cutover_locked', ?)`,
  ).run(NOW);
  mocks.testDb.prepare(
    `INSERT INTO memory_authority_transitions
       (transition_id, revision, from_authority, to_authority, legacy_writes_frozen,
        import_run_id, actor_id, reason_code, occurred_at)
     VALUES ('frozen-producer-transition-2', 2, 'migration_locked', 'canonical', 1,
             NULL, 'frozen-producer-test', 'offline_cutover_complete', ?)`,
  ).run(NOW);
});

afterAll(() => {
  mocks.testDb.close();
});

describe("retired frozen legacy producers", () => {
  it("skips scheduled synthesis and development seeding before reading or writing the graph", async () => {
    await expect(runScheduledGraphSynthesis(ORG_ID)).resolves.toMatchObject({
      ok: true,
      skipped: "legacy_authority_frozen",
    });
    await expect(seedKnowledgeGraph(ORG_ID)).resolves.toBeUndefined();

    expect(mocks.getGraph).not.toHaveBeenCalled();
    expect(mocks.callLLMJSON).not.toHaveBeenCalled();
    expect(mocks.ingestLearnings).not.toHaveBeenCalled();
  });
});
