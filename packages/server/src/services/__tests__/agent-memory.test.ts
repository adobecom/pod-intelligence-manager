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

vi.mock("../ingestion-gateway.js", () => ({
  ingestLearnings: vi.fn(async () => ({
    nodesAdded: 1,
    edgesAdded: 0,
    nodeIds: ["kn-agent-run"],
    droppedCount: 0,
  })),
}));

import { createTables } from "../../db/schema.js";
import {
  AgentMemorySequenceError,
  AgentRunNotAppendableError,
  appendAgentRunEvent,
  assembleAgentResumeContext,
  createAgentCheckpoint,
  createAgentRun,
  createAgentSession,
  endAgentRun,
  listMemoryCandidates,
  promoteMemoryCandidate,
  rejectMemoryCandidate,
  updateAgentSessionWorkingState,
} from "../agent-memory.js";
import { ingestLearnings } from "../ingestion-gateway.js";
import { persistMemoryEntities, recordTemporalRelationshipsForUpdate } from "../memory-enrichment.js";

const ORG_ID = "org_agent_memory";
const PROJECT_ID = "project-agent-memory";
const POD_ID = "pod-agent-memory";

function resetDb() {
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
    DROP TABLE IF EXISTS living_docs;
    DROP TABLE IF EXISTS conflicts;
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
}

function seedWorkspace() {
  const now = new Date().toISOString();
  testDb.prepare("INSERT INTO users (user_id, email, created_at) VALUES (?, ?, ?)").run("user-agent", "agent@local", now);
  testDb
    .prepare("INSERT INTO orgs (org_id, slug, name, created_by_user_id, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(ORG_ID, "agent-memory", "Agent Memory", "user-agent", now);
  testDb
    .prepare("INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)")
    .run(ORG_ID, "user-agent", now);
  testDb
    .prepare(
      "INSERT INTO projects (project_id, name, description, created_at, anatomy_json, org_id, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(PROJECT_ID, "Agent Memory Project", null, now, "{}", ORG_ID, "user-agent");
  testDb
    .prepare(
      `INSERT INTO pods
         (pod_id, name, sprint_start, sprint_end, day_number, total_days, conflict_pressure, milestone_json, project_id, org_id, created_by_user_id)
       VALUES (?, ?, '2026-06-01', '2026-06-05', 1, 5, 0.0, ?, ?, ?, ?)`,
    )
    .run(POD_ID, "Agent Memory Pod", JSON.stringify({ name: "Goal", target_date: "2026-06-05", percent_complete: 0 }), PROJECT_ID, ORG_ID, "user-agent");
  testDb
    .prepare("INSERT INTO living_docs (pod_id, markdown, last_regenerated_at, regen_count, org_id) VALUES (?, ?, ?, 1, ?)")
    .run(POD_ID, "# Pod: Agent Memory Pod\n\nCurrent status.", now, ORG_ID);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDb();
  seedWorkspace();
});

describe("agent run memory", () => {
  it("enforces append-only event sequence expectations", () => {
    const session = createAgentSession({
      orgId: ORG_ID,
      pod_id: POD_ID,
      scope: "backend",
      agent_id: "agent-1",
      goal: "Implement memory",
    });
    expect(session).toBeTruthy();
    const run = createAgentRun(ORG_ID, session!.session_id, { model: "gpt-test" });
    expect(run).toBeTruthy();

    const event = appendAgentRunEvent(ORG_ID, run!.run_id, {
      event_type: "tool_call",
      summary: "Read schema",
      expected_seq: 1,
    });
    expect(event?.seq).toBe(1);

    expect(() =>
      appendAgentRunEvent(ORG_ID, run!.run_id, {
        event_type: "tool_result",
        summary: "Mismatch",
        expected_seq: 1,
      }),
    ).toThrow(AgentMemorySequenceError);
  });

  it("assembles resume context from working state, checkpoints, recent events, living doc, and KG", async () => {
    const session = createAgentSession({
      orgId: ORG_ID,
      pod_id: POD_ID,
      scope: "backend",
      agent_id: "agent-1",
      goal: "Resume safely",
      working_state: { current_plan: ["inspect", "patch"], last_progress: "schema done" },
    });
    const run = createAgentRun(ORG_ID, session!.session_id, { input_prompt: "continue" });
    appendAgentRunEvent(ORG_ID, run!.run_id, { event_type: "model_output", summary: "Found route boundary" });
    const checkpoint = createAgentCheckpoint(ORG_ID, session!.session_id, {
      run_id: run!.run_id,
      snapshot: { step: "patch routes" },
      summary: "Before routes",
    });

    const context = await assembleAgentResumeContext(ORG_ID, session!.session_id);

    expect(context?.working_state.last_progress).toBe("schema done");
    expect(context?.latest_checkpoint?.checkpoint_id).toBe(checkpoint?.checkpoint_id);
    expect(context?.recent_events.map((e) => e.summary)).toContain("Found route boundary");
    expect(context?.pod_living_doc).toContain("Agent Memory Pod");
    expect(context?.org_knowledge).toEqual([]);
  });

  it("clears current_task when null is explicitly provided", () => {
    const session = createAgentSession({
      orgId: ORG_ID,
      pod_id: POD_ID,
      scope: "backend",
      agent_id: "agent-1",
      goal: "Clear task",
      current_task: "Patch route",
    });

    const updated = updateAgentSessionWorkingState(ORG_ID, session!.session_id, {
      working_state: { done: true },
      current_task: null,
    });

    expect(updated?.current_task).toBeNull();
  });

  it("compacts only uncompacted event segments after thresholds are crossed", () => {
    const priorEventThreshold = process.env.AGENT_MEMORY_COMPACT_EVENT_THRESHOLD;
    const priorCharThreshold = process.env.AGENT_MEMORY_COMPACT_CHAR_THRESHOLD;
    process.env.AGENT_MEMORY_COMPACT_EVENT_THRESHOLD = "2";
    process.env.AGENT_MEMORY_COMPACT_CHAR_THRESHOLD = "999999";
    try {
      const session = createAgentSession({
        orgId: ORG_ID,
        pod_id: POD_ID,
        scope: "backend",
        agent_id: "agent-1",
        goal: "Compact session",
      });
      const run = createAgentRun(ORG_ID, session!.session_id, { input_prompt: "compact" });

      appendAgentRunEvent(ORG_ID, run!.run_id, { event_type: "model_output", summary: "First durable signal" });
      let row = testDb
        .prepare("SELECT compacted_summary, last_compacted_event_rowid FROM agent_sessions WHERE session_id = ?")
        .get(session!.session_id) as { compacted_summary: string | null; last_compacted_event_rowid: number };
      expect(row.compacted_summary).toBeNull();
      expect(row.last_compacted_event_rowid).toBe(0);

      appendAgentRunEvent(ORG_ID, run!.run_id, { event_type: "model_output", summary: "Second durable signal" });
      row = testDb
        .prepare("SELECT compacted_summary, last_compacted_event_rowid FROM agent_sessions WHERE session_id = ?")
        .get(session!.session_id) as { compacted_summary: string | null; last_compacted_event_rowid: number };
      const firstCompactedRowid = row.last_compacted_event_rowid;
      const firstSummary = row.compacted_summary;
      expect(firstCompactedRowid).toBeGreaterThan(0);
      expect(firstSummary).toContain("Events compacted in this segment: 2");
      const marker = testDb
        .prepare("SELECT event_type, summary FROM agent_run_events WHERE run_id = ? ORDER BY seq DESC LIMIT 1")
        .get(run!.run_id) as { event_type: string; summary: string };
      expect(marker.event_type).toBe("run_compacted");
      expect(marker.summary).toContain("Compacted 2 event");

      appendAgentRunEvent(ORG_ID, run!.run_id, { event_type: "model_output", summary: "Third durable signal" });
      row = testDb
        .prepare("SELECT compacted_summary, last_compacted_event_rowid FROM agent_sessions WHERE session_id = ?")
        .get(session!.session_id) as { compacted_summary: string | null; last_compacted_event_rowid: number };
      expect(row.last_compacted_event_rowid).toBe(firstCompactedRowid);
      expect(row.compacted_summary).toBe(firstSummary);

      appendAgentRunEvent(ORG_ID, run!.run_id, { event_type: "model_output", summary: "Fourth durable signal" });
      row = testDb
        .prepare("SELECT compacted_summary, last_compacted_event_rowid FROM agent_sessions WHERE session_id = ?")
        .get(session!.session_id) as { compacted_summary: string | null; last_compacted_event_rowid: number };
      expect(row.last_compacted_event_rowid).toBeGreaterThan(firstCompactedRowid);
      expect(row.compacted_summary).toContain("Fourth durable signal");
    } finally {
      if (priorEventThreshold === undefined) delete process.env.AGENT_MEMORY_COMPACT_EVENT_THRESHOLD;
      else process.env.AGENT_MEMORY_COMPACT_EVENT_THRESHOLD = priorEventThreshold;
      if (priorCharThreshold === undefined) delete process.env.AGENT_MEMORY_COMPACT_CHAR_THRESHOLD;
      else process.env.AGENT_MEMORY_COMPACT_CHAR_THRESHOLD = priorCharThreshold;
    }
  });

  it("creates a review-gated completed-run memory candidate and promotes it manually", async () => {
    const session = createAgentSession({
      orgId: ORG_ID,
      pod_id: POD_ID,
      scope: "backend",
      agent_id: "agent-1",
      goal: "Ship rollup",
    });
    const run = createAgentRun(ORG_ID, session!.session_id, { input_prompt: "finish backend memory" });
    appendAgentRunEvent(ORG_ID, run!.run_id, {
      event_type: "file_change",
      summary: "Added agent session routes and service",
      artifact_refs: [{ type: "file", path: "packages/server/src/services/agent-memory.ts" }],
    });

    await endAgentRun(ORG_ID, run!.run_id, {
      status: "completed",
      final_output: "Implemented AgentSession memory routes with append-only events and checkpoint resume context.",
    });

    const candidates = listMemoryCandidates(ORG_ID, { session_id: session!.session_id });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].status).toBe("pending");
    expect(candidates[0].confidence_score).toBe(0.7);
    expect(candidates[0].promoted_node_id).toBeNull();
    expect(candidates[0].retrieval_text).toContain("AgentSession");
    expect(ingestLearnings).not.toHaveBeenCalled();

    const promoted = await promoteMemoryCandidate(ORG_ID, candidates[0].id);
    expect(promoted?.status).toBe("promoted");
    expect(promoted?.promoted_node_id).toBe("kn-agent-run");
    expect(ingestLearnings).toHaveBeenCalledTimes(1);
  });

  it("auto-promotes high-confidence completed-run memory candidates", async () => {
    const session = createAgentSession({
      orgId: ORG_ID,
      pod_id: POD_ID,
      scope: "backend",
      agent_id: "agent-1",
      goal: "Ship high confidence rollup",
    });
    const run = createAgentRun(ORG_ID, session!.session_id, { input_prompt: "finish backend memory" });
    appendAgentRunEvent(ORG_ID, run!.run_id, {
      event_type: "context_update_submitted",
      summary: "Submitted durable implementation decision",
    });
    appendAgentRunEvent(ORG_ID, run!.run_id, {
      event_type: "file_change",
      summary: "Updated the service and route tests",
      artifact_refs: [{ type: "file", path: "packages/server/src/services/agent-memory.ts" }],
    });

    await endAgentRun(ORG_ID, run!.run_id, {
      status: "completed",
      context_update_id: "ctx-high-confidence",
      final_output: "Implemented durable agent memory rollup with explicit context update evidence and route coverage.",
    });

    const candidates = listMemoryCandidates(ORG_ID, { session_id: session!.session_id });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].status).toBe("auto_promoted");
    expect(candidates[0].confidence_score).toBeGreaterThanOrEqual(0.85);
    expect(candidates[0].promoted_node_id).toBe("kn-agent-run");
    expect(ingestLearnings).toHaveBeenCalledTimes(1);
  });

  it("keeps completed-run candidates review-gated without corroborating promotion evidence", async () => {
    const session = createAgentSession({
      orgId: ORG_ID,
      pod_id: POD_ID,
      scope: "backend",
      agent_id: "agent-1",
      goal: "Avoid trivial auto-promotion",
    });
    const run = createAgentRun(ORG_ID, session!.session_id, { input_prompt: "finish backend memory" });

    await endAgentRun(ORG_ID, run!.run_id, {
      status: "completed",
      context_update_id: "ctx-without-event",
      final_output: "Implemented a durable backend memory change.",
    });

    const candidates = listMemoryCandidates(ORG_ID, { session_id: session!.session_id });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].status).toBe("pending");
    expect(candidates[0].confidence_score).toBe(0.7);
    expect(ingestLearnings).not.toHaveBeenCalled();
  });

  it("rejecting a promoted candidate leaves the audit status promoted", async () => {
    const session = createAgentSession({
      orgId: ORG_ID,
      pod_id: POD_ID,
      scope: "backend",
      agent_id: "agent-1",
      goal: "Promote then reject",
    });
    const run = createAgentRun(ORG_ID, session!.session_id, { input_prompt: "finish memory" });
    appendAgentRunEvent(ORG_ID, run!.run_id, { event_type: "model_output", summary: "Durable result" });
    await endAgentRun(ORG_ID, run!.run_id, {
      status: "completed",
      final_output: "Implemented a durable result for project memory.",
    });
    const candidate = listMemoryCandidates(ORG_ID, { session_id: session!.session_id })[0];
    await promoteMemoryCandidate(ORG_ID, candidate.id);

    const rejected = rejectMemoryCandidate(ORG_ID, candidate.id);

    expect(rejected?.status).toBe("promoted");
    expect(rejected?.promoted_node_id).toBe("kn-agent-run");
  });

  it("does not append events to completed runs", async () => {
    const session = createAgentSession({
      orgId: ORG_ID,
      pod_id: POD_ID,
      scope: "backend",
      agent_id: "agent-1",
      goal: "No late events",
    });
    const run = createAgentRun(ORG_ID, session!.session_id, { input_prompt: "finish" });
    await endAgentRun(ORG_ID, run!.run_id, {
      status: "completed",
      final_output: "Done.",
    });

    expect(() =>
      appendAgentRunEvent(ORG_ID, run!.run_id, {
        event_type: "model_output",
        summary: "Too late",
      }),
    ).toThrow(AgentRunNotAppendableError);
  });

  it("only includes promoted memory candidates in resume context", async () => {
    const now = new Date().toISOString();
    const session = createAgentSession({
      orgId: ORG_ID,
      project_id: PROJECT_ID,
      pod_id: POD_ID,
      scope: "backend",
      agent_id: "agent-1",
      goal: "Resume with durable memory only",
    });
    const insert = testDb.prepare(
      `INSERT INTO memory_candidates
         (id, org_id, project_id, pod_id, session_id, run_id, source_type, source_id, type, summary, details,
          retrieval_text, entity_refs_json, domains_json, confidence_score, evidence_json, status, promoted_node_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pattern', ?, ?, ?, '[]', '["backend"]', 0.9, '{}', ?, ?, ?)`,
    );
    insert.run("mc-promoted", ORG_ID, PROJECT_ID, POD_ID, session!.session_id, null, "agent_run", "run-promoted", "Promoted memory", "Durable", "Durable", "promoted", "kn-1", now);
    insert.run("mc-rejected", ORG_ID, PROJECT_ID, POD_ID, session!.session_id, null, "agent_run", "run-rejected", "Rejected memory", "Discarded", "Discarded", "rejected", null, now);
    insert.run("mc-pending", ORG_ID, PROJECT_ID, POD_ID, session!.session_id, null, "agent_run", "run-pending", "Pending memory", "Unreviewed", "Unreviewed", "pending", null, now);

    const context = await assembleAgentResumeContext(ORG_ID, session!.session_id);

    expect(context?.project_memory.map((candidate) => candidate.id)).toEqual(["mc-promoted"]);
  });

  it("persists the same logical entity key in multiple orgs without primary-key collision", () => {
    const now = new Date().toISOString();
    testDb
      .prepare("INSERT INTO orgs (org_id, slug, name, created_by_user_id, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("org-agent-memory-2", "agent-memory-2", "Agent Memory 2", "user-agent", now);

    const ref1 = { type: "component" as const, id: "me-org-1-shared", key: "shared-component", label: "Shared Component" };
    const ref2 = { type: "component" as const, id: "me-org-2-shared", key: "shared-component", label: "Shared Component" };
    persistMemoryEntities(ORG_ID, [ref1]);
    persistMemoryEntities("org-agent-memory-2", [ref2]);

    const rows = testDb
      .prepare("SELECT id, org_id, entity_key FROM memory_entities WHERE entity_key = ? ORDER BY org_id")
      .all(ref1.key) as Array<{ id: string; org_id: string; entity_key: string }>;
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([
      { id: ref1.id, org_id: ORG_ID, entity_key: ref1.key },
      { id: ref2.id, org_id: "org-agent-memory-2", entity_key: ref2.key },
    ]));
  });

  it("stores temporal relationships against memory entity ref ids", () => {
    const now = new Date().toISOString();
    const agent = { type: "agent" as const, id: "me-agent-local", key: "agent-local", label: "Agent Local" };
    const pod = { type: "pod" as const, id: "me-pod-local", key: "pod-local", label: "Pod Local" };

    recordTemporalRelationshipsForUpdate({
      orgId: ORG_ID,
      updateId: "context-update-1",
      timestamp: now,
      type: "status",
      entityRefs: [agent, pod],
      artifacts: [],
      reason: "agent contributed to pod context",
    });

    const relationship = testDb
      .prepare("SELECT source_entity_id, target_entity_id FROM memory_relationships WHERE org_id = ?")
      .get(ORG_ID) as { source_entity_id: string; target_entity_id: string };
    const entityRows = testDb
      .prepare("SELECT id FROM memory_entities WHERE org_id = ?")
      .all(ORG_ID) as Array<{ id: string }>;
    const entityIds = entityRows.map((row) => row.id);

    expect(entityIds).toContain(relationship.source_entity_id);
    expect(entityIds).toContain(relationship.target_entity_id);
    expect(relationship.source_entity_id).toBe(agent.id);
    expect(relationship.target_entity_id).toBe(pod.id);
  });
});
