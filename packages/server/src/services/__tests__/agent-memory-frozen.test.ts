import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { testDb, ingestLearnings } = vi.hoisted(() => {
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  return {
    testDb: database,
    ingestLearnings: vi.fn(async () => ({
      nodesAdded: 1,
      edgesAdded: 0,
      nodeIds: ["forbidden-legacy-node"],
      droppedCount: 0,
    })),
  };
});

vi.mock("../../db/connection.js", () => ({
  default: testDb,
  withTransaction: (fn: () => unknown) => fn(),
  withImmediateTransaction: (fn: () => unknown) => fn(),
}));

vi.mock("../knowledge-graph.js", () => ({
  queryKnowledge: vi.fn(() => ({
    nodes: [],
    edges: [],
    total_matching: 0,
    token_estimate: 0,
    truncated: false,
  })),
}));

vi.mock("../ingestion-gateway.js", () => ({ ingestLearnings }));

vi.mock("../../pim/llm.js", () => ({
  isLLMAvailable: vi.fn(() => false),
  MODELS: { fast: "test-fast", smart: "test-smart" },
  callLLM: vi.fn(),
  callLLMJSON: vi.fn(async () => null),
}));

vi.mock("../../pim/agents/knowledge-extraction.js", () => ({
  classifyDecisionDurability: vi.fn(async (items: unknown[]) => (
    new Map(items.map((_, index) => [index, 0.7]))
  )),
}));

import { createTables } from "../../db/schema.js";
import {
  appendAgentRunEvent,
  createAgentRun,
  createAgentSession,
  endAgentRun,
  listMemoryCandidates,
  rollupAgentRun,
  rollupAgentSession,
} from "../agent-memory.js";
import { installLegacySqlWriteBarriers } from "../memory-authority.js";

const ORG_ID = "org-agent-memory-frozen";
const PROJECT_ID = "project-agent-memory-frozen";
const POD_ID = "pod-agent-memory-frozen";
const NOW = "2026-08-09T12:00:00.000Z";

beforeAll(() => {
  createTables();
  testDb.prepare(
    "INSERT INTO users (user_id, email, created_at) VALUES ('frozen-agent-user', 'frozen-agent@local', ?)",
  ).run(NOW);
  testDb.prepare(
    `INSERT INTO orgs (org_id, slug, name, created_by_user_id, created_at)
     VALUES (?, 'agent-memory-frozen', 'Agent Memory Frozen', 'frozen-agent-user', ?)`,
  ).run(ORG_ID, NOW);
  testDb.prepare(
    `INSERT INTO projects
       (project_id, name, description, created_at, anatomy_json, resources_json,
        org_id, created_by_user_id)
     VALUES (?, 'Frozen Agent Project', NULL, ?, '{}', '{}', ?, 'frozen-agent-user')`,
  ).run(PROJECT_ID, NOW, ORG_ID);
  testDb.prepare(
    `INSERT INTO pods
       (pod_id, name, sprint_start, sprint_end, day_number, total_days,
        conflict_pressure, milestone_json, project_id, org_id, created_by_user_id)
     VALUES (?, 'Frozen Agent Pod', '2026-08-01', '2026-08-10', 9, 10, 0,
             '{"name":"Canonical rollup","percent_complete":100}', ?, ?, 'frozen-agent-user')`,
  ).run(POD_ID, PROJECT_ID, ORG_ID);
  testDb.prepare(
    `INSERT INTO memory_authority_transitions
       (transition_id, revision, from_authority, to_authority, legacy_writes_frozen,
        import_run_id, actor_id, reason_code, occurred_at)
     VALUES ('frozen-agent-transition-1', 1, 'legacy', 'migration_locked', 1,
             NULL, 'frozen-agent-test', 'offline_cutover_locked', ?)`,
  ).run(NOW);
  testDb.prepare(
    `INSERT INTO memory_authority_transitions
       (transition_id, revision, from_authority, to_authority, legacy_writes_frozen,
        import_run_id, actor_id, reason_code, occurred_at)
     VALUES ('frozen-agent-transition-2', 2, 'migration_locked', 'canonical', 1,
             NULL, 'frozen-agent-test', 'offline_cutover_complete', ?)`,
  ).run(NOW);
  installLegacySqlWriteBarriers();
});

afterAll(() => {
  testDb.close();
});

describe("frozen agent-memory producers", () => {
  it("submits run and session rollups as canonical pending candidates without legacy writes", async () => {
    const session = createAgentSession({
      orgId: ORG_ID,
      project_id: PROJECT_ID,
      pod_id: POD_ID,
      scope: "backend",
      agent_id: "agent-frozen-rollup",
      goal: "Prove frozen rollups use canonical intake",
      metadata: { rollup_policy: "auto_promote" },
    });
    const run = createAgentRun(ORG_ID, session!.session_id, {
      model: "test-rollup-model",
      metadata: {
        rollup_policy: "auto_promote",
        learning_summary: "Frozen rollups submit canonical review candidates",
        learning_details: "Frozen agent rollups must never insert or promote legacy candidates after canonical authority is active.",
      },
    });
    appendAgentRunEvent(ORG_ID, run!.run_id, {
      event_type: "model_output",
      summary: "Captured a durable frozen-authority learning",
      created_at: NOW,
    });
    await endAgentRun(ORG_ID, run!.run_id, {
      status: "completed",
      final_output: "Frozen agent rollups submit durable results through canonical receipt intake.",
    });

    const runCandidate = await rollupAgentRun(ORG_ID, run!.run_id);
    const sessionCandidates = await rollupAgentSession(ORG_ID, session!.session_id);

    expect(runCandidate).toMatchObject({
      source_type: "agent_run",
      status: "pending",
      project_id: PROJECT_ID,
      evidence: {
        canonical_memory: {
          status: "received",
          blockers: ["validation_pending"],
        },
      },
    });
    expect(sessionCandidates.length).toBeGreaterThan(0);
    expect(sessionCandidates.every((candidate) => (
      candidate.status === "pending"
      && candidate.project_id === PROJECT_ID
      && "canonical_memory" in candidate.evidence
    ))).toBe(true);
    expect(listMemoryCandidates(ORG_ID, { session_id: session!.session_id })).toEqual([]);
    expect(testDb.prepare(
      `SELECT COUNT(*) AS count FROM memory_candidates_v1
       WHERE org_id = ? AND project_id = ? AND producer_harness_id = 'pim-internal'`,
    ).get(ORG_ID, PROJECT_ID)).toMatchObject({ count: 1 + sessionCandidates.length });
    expect(testDb.prepare("SELECT COUNT(*) AS count FROM memory_candidates").get())
      .toMatchObject({ count: 0 });
    expect(ingestLearnings).not.toHaveBeenCalled();
  });
});
