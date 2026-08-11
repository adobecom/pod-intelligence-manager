import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

const mocks = vi.hoisted(() => {
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  return {
    testDb: database,
    extractKnowledgeEnhanced: vi.fn(async () => [{
      type: "decision" as const,
      summary: "Archived Pods submit canonical candidates",
      details: "Archived Pod learnings must pass through the internal canonical receipt service after legacy memory authority is frozen.",
      domains: ["memory"],
      confidence: "extracted" as const,
      confidence_score: 0.9,
    }]),
    ingestLearnings: vi.fn(),
    broadcastToAll: vi.fn(),
    runTuningAgent: vi.fn(async () => undefined),
  };
});

vi.mock("../../db/connection.js", () => ({
  default: mocks.testDb,
  withTransaction: (fn: () => unknown) => fn(),
  withImmediateTransaction: (fn: () => unknown) => fn(),
}));

vi.mock("../../pim/agents/knowledge-extraction.js", () => ({
  extractKnowledgeEnhanced: mocks.extractKnowledgeEnhanced,
}));

vi.mock("../../services/ingestion-gateway.js", () => ({
  ingestLearnings: mocks.ingestLearnings,
}));

vi.mock("../../ws/index.js", () => ({ broadcastToAll: mocks.broadcastToAll }));
vi.mock("../../pim/agents/tuning-agent.js", () => ({ runTuningAgent: mocks.runTuningAgent }));

import { createTables } from "../../db/schema.js";
import orgRoutes from "../org.js";
import { canonicalLegacySystemProjectId } from "../../services/canonical-legacy-intake.js";
import { installLegacySqlWriteBarriers } from "../../services/memory-authority.js";

const ORG_ID = "org-archive-canonical";
const PROJECT_ID = "project-archive-canonical";
const NOW = "2026-08-09T12:00:00.000Z";
let app: FastifyInstance;

function insertPod(podId: string, projectId: string | null): void {
  mocks.testDb.prepare(
    `INSERT INTO pods
       (pod_id, name, sprint_start, sprint_end, day_number, total_days,
        conflict_pressure, milestone_json, project_id, org_id, created_by_user_id)
     VALUES (?, ?, '2026-08-01', '2026-08-10', 9, 10, 0,
             '{"name":"Canonical archive","percent_complete":100}', ?, ?, 'archive-user')`,
  ).run(podId, `Archive ${podId}`, projectId, ORG_ID);
  mocks.testDb.prepare(
    `INSERT INTO org_pod_summaries
       (pod_id, name, day_number, total_days, conflict_pressure, open_conflicts,
        active_tunnels, agent_count, org_id)
     VALUES (?, ?, 9, 10, 0, 0, 0, 1, ?)`,
  ).run(podId, `Archive ${podId}`, ORG_ID);
}

async function waitForArchive(statusUrl: string) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    const status = await app.inject({ method: "GET", url: statusUrl });
    const body = status.json() as {
      status: string;
      error?: string;
      archived?: { learnings_extracted?: number };
      canonical_memory_intake?: Record<string, unknown>;
    };
    if (body.status === "failed") throw new Error(body.error ?? "archive failed");
    if (body.status === "completed") return body;
  }
  throw new Error("archive did not complete");
}

beforeAll(async () => {
  createTables();
  mocks.testDb.prepare(
    "INSERT INTO users (user_id, email, created_at) VALUES ('archive-user', 'archive@local', ?)",
  ).run(NOW);
  mocks.testDb.prepare(
    `INSERT INTO orgs (org_id, slug, name, created_by_user_id, created_at)
     VALUES (?, 'archive-canonical', 'Archive Canonical', 'archive-user', ?)`,
  ).run(ORG_ID, NOW);
  mocks.testDb.prepare(
    `INSERT INTO projects
       (project_id, name, description, created_at, anatomy_json, resources_json,
        org_id, created_by_user_id)
     VALUES (?, 'Archive Project', NULL, ?, '{}', '{}', ?, 'archive-user')`,
  ).run(PROJECT_ID, NOW, ORG_ID);
  insertPod("pod-archive-project", PROJECT_ID);
  insertPod("pod-archive-system-project", null);
  mocks.testDb.prepare(
    `INSERT INTO memory_authority_transitions
       (transition_id, revision, from_authority, to_authority, legacy_writes_frozen,
        import_run_id, actor_id, reason_code, occurred_at)
     VALUES ('archive-transition-1', 1, 'legacy', 'migration_locked', 1,
             NULL, 'archive-test', 'offline_cutover_locked', ?)`,
  ).run(NOW);
  mocks.testDb.prepare(
    `INSERT INTO memory_authority_transitions
       (transition_id, revision, from_authority, to_authority, legacy_writes_frozen,
        import_run_id, actor_id, reason_code, occurred_at)
     VALUES ('archive-transition-2', 2, 'migration_locked', 'canonical', 1,
             NULL, 'archive-test', 'offline_cutover_complete', ?)`,
  ).run(NOW);
  installLegacySqlWriteBarriers();

  app = Fastify();
  app.addHook("onRequest", async (request: FastifyRequest) => {
    request.org = {
      org_id: ORG_ID,
      slug: "archive-canonical",
      name: "Archive Canonical",
      created_by_user_id: "archive-user",
      created_at: NOW,
    };
  });
  app.register(orgRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  mocks.testDb.close();
});

describe("Pod archival after the legacy-memory freeze", () => {
  it("completes through canonical pending intake with real and reserved projects", async () => {
    for (const podId of ["pod-archive-project", "pod-archive-system-project"]) {
      const started = await app.inject({ method: "POST", url: `/api/pods/${podId}/archive` });
      expect(started.statusCode).toBe(202);
      const completed = await waitForArchive((started.json() as { status_url: string }).status_url);
      expect(completed.archived?.learnings_extracted).toBe(1);
      expect(completed.canonical_memory_intake).toMatchObject({
        candidates_submitted: 1,
        candidates_created: 1,
        selected: 1,
        dropped_low_confidence: 0,
        dropped_unmappable: 0,
        dropped_over_cap: 0,
      });
    }

    expect(mocks.ingestLearnings).not.toHaveBeenCalled();
    expect(mocks.testDb.prepare("SELECT COUNT(*) AS count FROM memory_candidates").get())
      .toMatchObject({ count: 0 });
    expect(mocks.testDb.prepare("SELECT COUNT(*) AS count FROM knowledge_nodes").get())
      .toMatchObject({ count: 0 });
    expect(mocks.testDb.prepare(
      `SELECT COUNT(*) AS count FROM memory_candidates_v1
       WHERE producer_harness_id = 'pim-internal' AND current_status = 'received'`,
    ).get()).toMatchObject({ count: 2 });
    expect(mocks.testDb.prepare(
      "SELECT COUNT(*) AS count FROM memory_outbox WHERE job_type = 'candidate_validation'",
    ).get()).toMatchObject({ count: 2 });
    expect(mocks.testDb.prepare(
      "SELECT COUNT(*) AS count FROM projects WHERE project_id = ? AND org_id = ?",
    ).get(canonicalLegacySystemProjectId(ORG_ID), ORG_ID)).toMatchObject({ count: 1 });
    expect(mocks.broadcastToAll).toHaveBeenCalledTimes(2);
    expect(mocks.broadcastToAll.mock.calls.every(([event]) => (
      event.type === "memory_candidates_submitted"
      && event.payload.status === "pending_validation_review"
    ))).toBe(true);
  });
});
