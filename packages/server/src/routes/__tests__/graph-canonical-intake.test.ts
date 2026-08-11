import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { EnhancedPodLearning } from "@pim/shared";

const mocks = vi.hoisted(() => {
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  return {
    testDb: database,
    ingestLearnings: vi.fn(),
  };
});

vi.mock("../../db/connection.js", () => ({
  default: mocks.testDb,
  withTransaction: (fn: () => unknown) => fn(),
  withImmediateTransaction: (fn: () => unknown) => fn(),
}));

vi.mock("../../services/knowledge-graph.js", () => ({
  curateNode: vi.fn(),
  getGraph: vi.fn(() => ({ nodes: [], edges: [] })),
  getPrecedents: vi.fn(),
  getContractedRelevantLearnings: vi.fn(),
  getStats: vi.fn(() => ({ total_nodes: 0 })),
  queryKnowledgeSemantic: vi.fn(),
  stripEmbeddingsFromGraph: vi.fn((graph) => graph),
}));

vi.mock("../../services/ingestion-gateway.js", () => ({
  ingestLearnings: mocks.ingestLearnings,
  prepareLearnings: vi.fn((
    _orgId: string,
    learnings: EnhancedPodLearning[],
  ) => ({
    prepared: learnings.map((learning) => ({
      ...learning,
      confidence_score: Math.min(learning.confidence_score, 0.7),
    })),
    droppedCount: 0,
  })),
}));

import { createTables } from "../../db/schema.js";
import { registerJsonBodyParser } from "../../middleware/validation.js";
import { canonicalLegacySystemProjectId } from "../../services/canonical-legacy-intake.js";
import { installLegacySqlWriteBarriers } from "../../services/memory-authority.js";
import graphRoutes from "../graph.js";

const ORG_ID = "org-ad-hoc-canonical";
const NOW = "2026-08-09T12:00:00.000Z";
let app: FastifyInstance;

beforeAll(async () => {
  createTables();
  mocks.testDb.prepare(
    "INSERT INTO users (user_id, email, created_at) VALUES ('ad-hoc-user', 'ad-hoc@local', ?)",
  ).run(NOW);
  mocks.testDb.prepare(
    `INSERT INTO orgs (org_id, slug, name, created_by_user_id, created_at)
     VALUES (?, 'ad-hoc-canonical', 'Ad Hoc Canonical', 'ad-hoc-user', ?)`,
  ).run(ORG_ID, NOW);
  mocks.testDb.prepare(
    `INSERT INTO memory_authority_transitions
       (transition_id, revision, from_authority, to_authority, legacy_writes_frozen,
        import_run_id, actor_id, reason_code, occurred_at)
     VALUES ('ad-hoc-transition-1', 1, 'legacy', 'migration_locked', 1,
             NULL, 'ad-hoc-test', 'offline_cutover_locked', ?)`,
  ).run(NOW);
  mocks.testDb.prepare(
    `INSERT INTO memory_authority_transitions
       (transition_id, revision, from_authority, to_authority, legacy_writes_frozen,
        import_run_id, actor_id, reason_code, occurred_at)
     VALUES ('ad-hoc-transition-2', 2, 'migration_locked', 'canonical', 1,
             NULL, 'ad-hoc-test', 'offline_cutover_complete', ?)`,
  ).run(NOW);
  installLegacySqlWriteBarriers();

  app = Fastify();
  registerJsonBodyParser(app);
  app.addHook("onRequest", async (request: FastifyRequest) => {
    request.org = {
      org_id: ORG_ID,
      slug: "ad-hoc-canonical",
      name: "Ad Hoc Canonical",
      created_by_user_id: "ad-hoc-user",
      created_at: NOW,
    };
  });
  app.register(graphRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  mocks.testDb.close();
});

describe("ad-hoc knowledge after the legacy-memory freeze", () => {
  it("returns a pending canonical candidate and never calls legacy ingestion", async () => {
    const payload = {
      type: "decision" as const,
      summary: "Ad-hoc submissions use canonical intake",
      details: "Explicit ad-hoc learnings must become review-gated canonical candidates after the legacy graph is frozen.",
      domains: ["memory"],
      source_label: "Operator review",
      confidence_score: 0.9,
    };
    const { response, retry } = await (async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date(NOW));
        const first = await app.inject({
          method: "POST",
          url: "/api/knowledge/nodes",
          payload,
        });
        vi.setSystemTime(new Date("2026-08-10T12:00:00.000Z"));
        const second = await app.inject({
          method: "POST",
          url: "/api/knowledge/nodes",
          payload,
        });
        return { response: first, retry: second };
      } finally {
        vi.useRealTimers();
      }
    })();

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      status: "candidate_submitted",
      projectId: canonicalLegacySystemProjectId(ORG_ID),
      usedSystemProject: true,
      candidateStatus: "received",
      blockers: ["validation_pending"],
      candidatesSubmitted: 1,
      candidatesCreated: 1,
      intake: {
        selected: 1,
        dropped_low_confidence: 0,
        dropped_unmappable: 0,
        dropped_over_cap: 0,
      },
    });
    expect(mocks.ingestLearnings).not.toHaveBeenCalled();
    expect(mocks.testDb.prepare("SELECT COUNT(*) AS count FROM memory_candidates").get())
      .toMatchObject({ count: 0 });
    expect(mocks.testDb.prepare("SELECT COUNT(*) AS count FROM knowledge_nodes").get())
      .toMatchObject({ count: 0 });
    expect(mocks.testDb.prepare(
      `SELECT COUNT(*) AS count FROM memory_candidates_v1
       WHERE org_id = ? AND producer_harness_id = 'pim-internal'`,
    ).get(ORG_ID)).toMatchObject({ count: 1 });

    expect(retry.statusCode).toBe(202);
    expect(retry.json()).toMatchObject({
      candidateId: response.json().candidateId,
      receiptId: response.json().receiptId,
      candidatesSubmitted: 1,
      candidatesCreated: 0,
    });
    expect(mocks.testDb.prepare(
      `SELECT COUNT(*) AS count FROM memory_run_receipts
       WHERE org_id = ? AND producer_harness_id = 'pim-internal'`,
    ).get(ORG_ID)).toMatchObject({ count: 1 });
    expect(mocks.testDb.prepare(
      `SELECT COUNT(*) AS count FROM memory_candidates_v1
       WHERE org_id = ? AND producer_harness_id = 'pim-internal'`,
    ).get(ORG_ID)).toMatchObject({ count: 1 });
  });
});
