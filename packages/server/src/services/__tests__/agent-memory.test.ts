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

vi.mock("../../pim/llm.js", () => ({
  isLLMAvailable: vi.fn(() => false),
  MODELS: {
    fast: "claude-haiku-test",
    smart: "claude-sonnet-test",
  },
  callLLM: vi.fn(),
  callLLMJSON: vi.fn(async () => null),
}));

vi.mock("../../pim/agents/knowledge-extraction.js", () => ({
  classifyDecisionDurability: vi.fn(async (items: unknown[]) => new Map(items.map((_, index) => [index, 0.7]))),
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
  rollupAgentSession,
  updateAgentSessionWorkingState,
} from "../agent-memory.js";
import { recordProjectEvidence } from "../project-memory.js";
import { ingestLearnings } from "../ingestion-gateway.js";
import { persistMemoryEntities, recordTemporalRelationshipsForUpdate } from "../memory-enrichment.js";
import { callLLMJSON, isLLMAvailable } from "../../pim/llm.js";
import { classifyDecisionDurability } from "../../pim/agents/knowledge-extraction.js";

const ORG_ID = "org_agent_memory";
const PROJECT_ID = "project-agent-memory";
const POD_ID = "pod-agent-memory";

function promotionGate(candidate: { evidence: Record<string, unknown> }) {
  return candidate.evidence.promotion_gate as { decision: string; policy: string; reasons: string[] };
}

function validationGate(candidate: { evidence: Record<string, unknown> }) {
  return candidate.evidence.validation_gate as { decision: string; trigger: string; reasons: string[]; runtime_signals?: string[] };
}

const REAL_AUTO_PROMOTE_METADATA = {
  rollup_policy: "auto_promote",
  run_kind: "real",
  side_effect_mode: "real",
  real_pr_created: true,
  stubbed_systems: [],
  verification_status: "passed",
  promotion_intent: "durable_learning",
  pr_url: "https://github.com/acme/pim/pull/123",
};

async function recordMergedPr(prUrl = REAL_AUTO_PROMOTE_METADATA.pr_url, confidenceScore = 0.7) {
  return recordProjectEvidence({
    org_id: ORG_ID,
    project_id: PROJECT_ID,
    source: "github",
    source_type: "merged_pr",
    source_id: `acme/pim#${prUrl.split("/").pop() ?? "123"}`,
    source_url: prUrl,
    source_title: `Merged ${prUrl}`,
    summary: "Merged agent memory PR",
    body: "Merged implementation evidence for agent-session memory validation.",
    occurred_at: "2026-06-01T00:00:00.000Z",
    confidence_score: confidenceScore,
  });
}

async function createPrBackedSessionCandidate(input: {
  summary: string;
  details: string;
  prUrl?: string;
  artifactPath?: string;
  confidence?: number;
  sessionMetadata?: Record<string, unknown>;
  runMetadata?: Record<string, unknown>;
}) {
  vi.mocked(classifyDecisionDurability).mockResolvedValueOnce(new Map([[0, input.confidence ?? 0.85]]));
  const prUrl = input.prUrl ?? REAL_AUTO_PROMOTE_METADATA.pr_url;
  const session = createAgentSession({
    orgId: ORG_ID,
    pod_id: POD_ID,
    scope: "backend",
    agent_id: "agent-1",
    goal: "Create PR-backed candidate",
    metadata: {
      ...REAL_AUTO_PROMOTE_METADATA,
      pr_url: prUrl,
      ...(input.sessionMetadata ?? {}),
    },
  });
  const run = createAgentRun(ORG_ID, session!.session_id, {
    input_prompt: "finish PR-backed memory",
    metadata: {
      learning_summary: input.summary,
      learning_details: input.details,
      ...(input.runMetadata ?? {}),
    },
  });
  appendAgentRunEvent(ORG_ID, run!.run_id, {
    event_type: "file_change",
    summary: "Attached PR and file evidence",
    artifact_refs: [
      { type: "github_pr", url: prUrl },
      { type: "file", path: input.artifactPath ?? "packages/server/src/services/agent-memory.ts" },
    ],
  });
  await endAgentRun(ORG_ID, run!.run_id, {
    status: "completed",
    final_output: input.details,
  });
  await rollupAgentSession(ORG_ID, session!.session_id);
  return {
    session: session!,
    run: run!,
    candidate: listMemoryCandidates(ORG_ID, { session_id: session!.session_id })[0],
  };
}

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
  testDb.prepare("UPDATE projects SET resources_json = ? WHERE project_id = ?").run(
    JSON.stringify({ github: { repos: ["acme/pim"] } }),
    PROJECT_ID,
  );
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

function insertPodContextUpdate(input: {
  id: string;
  agent_id?: string;
  type: "decision" | "spec_change" | "progress" | "blocker" | "question";
  scope?: string;
  summary: string;
  details: string;
}) {
  const now = new Date().toISOString();
  testDb.prepare(
    `INSERT INTO context_updates
       (id, agent_id, timestamp, pod_id, type, scope, summary, details, artifacts_json, status,
        blocks_json, blocked_by_json, needs_input_from_json, org_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', 'completed', '[]', '[]', '[]', ?)`,
  ).run(
    input.id,
    input.agent_id ?? "agent-1",
    now,
    POD_ID,
    input.type,
    input.scope ?? "backend",
    input.summary,
    input.details,
    ORG_ID,
  );
}

beforeEach(() => {
  process.env.PROJECT_GITHUB_VISIBLE_REPOS = "acme/pim";
  vi.clearAllMocks();
  vi.mocked(isLLMAvailable).mockReturnValue(false);
  vi.mocked(callLLMJSON).mockResolvedValue(null);
  vi.mocked(classifyDecisionDurability).mockImplementation(async (items) => new Map(items.map((_, index) => [index, 0.7])));
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
    const run = createAgentRun(ORG_ID, session!.session_id, {
      input_prompt: "finish backend memory",
      metadata: {
        learning_summary: "AgentSession memory routes need append-only event evidence.",
        learning_details: "AgentSession memory routes should preserve append-only events and checkpoint resume context so future rollups can reconstruct durable decisions from stored evidence.",
      },
    });
    appendAgentRunEvent(ORG_ID, run!.run_id, {
      event_type: "file_change",
      summary: "Added agent session routes and service",
      artifact_refs: [{ type: "file", path: "packages/server/src/services/agent-memory.ts" }],
    });

    await endAgentRun(ORG_ID, run!.run_id, {
      status: "completed",
      final_output: "Implemented AgentSession memory routes with append-only events and checkpoint resume context.",
    });
    await rollupAgentSession(ORG_ID, session!.session_id);

    const candidates = listMemoryCandidates(ORG_ID, { session_id: session!.session_id });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].status).toBe("pending");
    expect(candidates[0].confidence_score).toBe(0.7);
    expect(candidates[0].promoted_node_id).toBeNull();
    expect(candidates[0].retrieval_text).toContain("AgentSession");
    expect(promotionGate(candidates[0])).toEqual({
      decision: "blocked",
      policy: "candidate_only",
      reasons: ["policy_candidate_only"],
    });
    expect(candidates[0].source_type).toBe("agent_session");
    expect(ingestLearnings).not.toHaveBeenCalled();

    const promoted = await promoteMemoryCandidate(ORG_ID, candidates[0].id);
    expect(promoted?.status).toBe("promoted");
    expect(promoted?.promoted_node_id).toBe("kn-agent-run");
    expect(ingestLearnings).toHaveBeenCalledTimes(1);
  });

  it("extracts an explicit durable context decision and scores it with the Haiku classifier", async () => {
    vi.mocked(isLLMAvailable).mockReturnValue(true);
    vi.mocked(classifyDecisionDurability).mockResolvedValueOnce(new Map([[0, 0.85]]));
    vi.mocked(callLLMJSON).mockResolvedValueOnce({ learnings: [] });
    const session = createAgentSession({
      orgId: ORG_ID,
      pod_id: POD_ID,
      scope: "backend",
      agent_id: "agent-1",
      goal: "Roll up context decision",
    });
    const run = createAgentRun(ORG_ID, session!.session_id, { input_prompt: "submit durable context" });
    insertPodContextUpdate({
      id: "ctx-durable-decision",
      type: "decision",
      summary: "Use session-level rollup for agent memory extraction.",
      details: "Agent memory extraction should run from the stored session packet because final run evidence, context updates, and artifacts can arrive after the run end call.",
    });
    appendAgentRunEvent(ORG_ID, run!.run_id, {
      event_type: "context_update_submitted",
      payload: { context_update_id: "ctx-durable-decision" },
      summary: "Submitted durable context decision",
    });
    await endAgentRun(ORG_ID, run!.run_id, {
      status: "completed",
      context_update_id: "ctx-durable-decision",
      final_output: "Completed context update submission.",
    });

    const candidates = await rollupAgentSession(ORG_ID, session!.session_id);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].type).toBe("decision");
    expect(candidates[0].confidence_score).toBe(0.85);
    expect(candidates[0].evidence.extraction).toMatchObject({
      kind: "deterministic",
      durability: "high",
      confidence_label: "high",
      evidence_refs: ["context_update:ctx-durable-decision"],
    });
  });

  it("drops deterministic seeds classified as junk", async () => {
    vi.mocked(isLLMAvailable).mockReturnValue(true);
    vi.mocked(classifyDecisionDurability).mockResolvedValueOnce(new Map([[0, 0.3]]));
    vi.mocked(callLLMJSON).mockResolvedValueOnce({ learnings: [] });
    const session = createAgentSession({
      orgId: ORG_ID,
      pod_id: POD_ID,
      scope: "backend",
      agent_id: "agent-1",
      goal: "Drop junk",
    });
    const run = createAgentRun(ORG_ID, session!.session_id, { input_prompt: "submit local cleanup" });
    insertPodContextUpdate({
      id: "ctx-junk-decision",
      type: "decision",
      summary: "Rename local temp variable in memory test.",
      details: "Renamed a local temporary variable in the memory test to match nearby naming; this does not affect future architecture or workflow.",
    });
    appendAgentRunEvent(ORG_ID, run!.run_id, {
      event_type: "context_update_submitted",
      payload: { context_update_id: "ctx-junk-decision" },
      summary: "Submitted local cleanup decision",
    });
    await endAgentRun(ORG_ID, run!.run_id, {
      status: "completed",
      context_update_id: "ctx-junk-decision",
      final_output: "Completed cleanup.",
    });

    const candidates = await rollupAgentSession(ORG_ID, session!.session_id);

    expect(candidates).toHaveLength(0);
    expect(listMemoryCandidates(ORG_ID, { session_id: session!.session_id })).toHaveLength(0);
  });

  it("creates multiple candidates from LLM session extraction without harness-provided summaries", async () => {
    vi.mocked(isLLMAvailable).mockReturnValue(true);
    vi.mocked(callLLMJSON).mockResolvedValueOnce({
      learnings: [
        {
          type: "pattern",
          domain: ["backend"],
          summary: "Checkpoint evidence should carry spec decisions into memory.",
          details: "When the harness stores spec decisions in checkpoints, session rollup can preserve those decisions even if the final run output is only a workflow summary.",
          confidence: "high",
          evidence_refs: ["checkpoint:acp-llm-spec", "run:ar-llm-primary"],
        },
        {
          type: "anti_pattern",
          domain: "qa",
          summary: "Do not promote run status as durable memory.",
          details: "Agent-session extraction should reject status-only events such as completed or approved unless supporting evidence describes a reusable technical lesson.",
          confidence: "medium",
          evidence_refs: ["event:are-llm-status"],
        },
      ],
    });
    const session = createAgentSession({
      orgId: ORG_ID,
      pod_id: POD_ID,
      scope: "backend",
      agent_id: "agent-1",
      goal: "LLM extract from session packet",
    });
    const run = createAgentRun(ORG_ID, session!.session_id, { input_prompt: "finish with checkpoints" });
    testDb.prepare("UPDATE agent_runs SET run_id = ? WHERE run_id = ?").run("ar-llm-primary", run!.run_id);
    createAgentCheckpoint(ORG_ID, session!.session_id, {
      run_id: "ar-llm-primary",
      snapshot: { note: "Session packet owns durable extraction evidence." },
      summary: "Stored packet evidence",
    });
    testDb.prepare("UPDATE agent_checkpoints SET checkpoint_id = ? WHERE session_id = ?").run("acp-llm-spec", session!.session_id);
    appendAgentRunEvent(ORG_ID, "ar-llm-primary", {
      event_type: "model_output",
      summary: "Status event the LLM must interpret with surrounding evidence",
    });
    testDb.prepare("UPDATE agent_run_events SET id = ? WHERE run_id = ?").run("are-llm-status", "ar-llm-primary");
    await endAgentRun(ORG_ID, "ar-llm-primary", {
      status: "completed",
      final_output: "Completed workflow.",
    });

    const candidates = await rollupAgentSession(ORG_ID, session!.session_id);

    expect(candidates).toHaveLength(2);
    expect(candidates.map((candidate) => candidate.summary)).toEqual(expect.arrayContaining([
      "Checkpoint evidence should carry spec decisions into memory.",
      "Do not promote run status as durable memory.",
    ]));
    expect(candidates.map((candidate) => candidate.confidence_score)).toEqual(expect.arrayContaining([0.85, 0.6]));
    expect(candidates.every((candidate) => candidate.evidence.extraction && (candidate.evidence.extraction as { kind?: string }).kind === "llm")).toBe(true);
  });

  it("falls back to deterministic session extraction when the LLM is unavailable", async () => {
    const session = createAgentSession({
      orgId: ORG_ID,
      pod_id: POD_ID,
      scope: "backend",
      agent_id: "agent-1",
      goal: "Offline rollup",
    });
    const run = createAgentRun(ORG_ID, session!.session_id, {
      input_prompt: "offline",
      metadata: {
        learning_summary: "Offline session rollup keeps deterministic learning summaries.",
        learning_details: "When Bedrock is unavailable, agent-session rollup should still create pending candidates from explicit learning metadata without calling LLM extraction.",
      },
    });
    await endAgentRun(ORG_ID, run!.run_id, {
      status: "completed",
      final_output: "Completed offline rollup.",
    });

    const candidates = await rollupAgentSession(ORG_ID, session!.session_id);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].evidence.extraction).toMatchObject({ kind: "deterministic" });
    expect(callLLMJSON).not.toHaveBeenCalled();
  });

  it("promotes high-confidence product candidates after matching PR merge evidence", async () => {
    vi.mocked(isLLMAvailable).mockReturnValue(true);
    vi.mocked(classifyDecisionDurability).mockResolvedValueOnce(new Map([[0, 0.85]]));
    vi.mocked(callLLMJSON).mockResolvedValueOnce({ learnings: [] });
    const session = createAgentSession({
      orgId: ORG_ID,
      pod_id: POD_ID,
      scope: "backend",
      agent_id: "agent-1",
      goal: "Ship high confidence rollup",
      metadata: REAL_AUTO_PROMOTE_METADATA,
    });
    const run = createAgentRun(ORG_ID, session!.session_id, {
      input_prompt: "finish backend memory",
      metadata: {
        learning_summary: "Agent-memory auto-promotion requires explicit real-run metadata and PR evidence.",
        learning_details: "Code-change agent runs can enter durable memory automatically only when the caller marks the run real, confirms real side effects, attaches context-update evidence, and provides a real PR URL.",
      },
    });
    insertPodContextUpdate({
      id: "ctx-high-confidence",
      type: "progress",
      summary: "Recorded real auto-promotion context update.",
      details: "A real context update row anchors the run context_update_id used by the auto-promotion gate.",
    });
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
    await rollupAgentSession(ORG_ID, session!.session_id);

    let candidates = listMemoryCandidates(ORG_ID, { session_id: session!.session_id });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].status).toBe("pending");
    expect(candidates[0].confidence_score).toBeGreaterThanOrEqual(0.85);
    expect(candidates[0].promoted_node_id).toBeNull();
    expect(candidates[0].summary).toBe("Agent-memory auto-promotion requires explicit real-run metadata and PR evidence.");
    expect(promotionGate(candidates[0])).toEqual({
      decision: "allowed",
      policy: "auto_promote",
      reasons: [],
    });
    expect(candidates[0].evidence.target_memory_scope).toBe("product");
    expect(ingestLearnings).not.toHaveBeenCalled();

    await recordMergedPr();

    candidates = listMemoryCandidates(ORG_ID, { session_id: session!.session_id });
    expect(candidates[0].status).toBe("auto_promoted");
    expect(candidates[0].promoted_node_id).toBe("kn-agent-run");
    expect(candidates[0].evidence.matched_pr_url).toBe(REAL_AUTO_PROMOTE_METADATA.pr_url);
    expect(validationGate(candidates[0])).toMatchObject({
      decision: "allowed",
      trigger: "merged_pr",
      reasons: [],
    });
    expect(ingestLearnings).toHaveBeenCalledTimes(1);
  });

  it("keeps product candidates pending for open or unmerged PR evidence", async () => {
    const { session } = await createPrBackedSessionCandidate({
      summary: "Implemented PR merge validation for product memory.",
      details: "Product memory candidates should wait for actual merged PR evidence instead of promoting from open pull request artifacts.",
    });

    await recordProjectEvidence({
      org_id: ORG_ID,
      project_id: PROJECT_ID,
      source: "github",
      source_type: "open_pr",
      source_id: "acme/pim#123-open",
      source_url: REAL_AUTO_PROMOTE_METADATA.pr_url,
      source_title: "Open PR #123",
      summary: "Open PR for memory validation",
      body: "The PR is still open and is not merge validation evidence.",
      occurred_at: "2026-06-01T00:00:00.000Z",
      confidence_score: 0.95,
    });

    const candidates = listMemoryCandidates(ORG_ID, { session_id: session.session_id });
    expect(candidates[0].status).toBe("pending");
    expect(validationGate(candidates[0])).toMatchObject({
      decision: "blocked",
      trigger: "initial_rollup",
    });
    expect(ingestLearnings).not.toHaveBeenCalled();
  });

  it("keeps raw checkpoint-only candidates pending after matching PR merge evidence", async () => {
    vi.mocked(classifyDecisionDurability).mockResolvedValueOnce(new Map([[0, 0.85]]));
    const session = createAgentSession({
      orgId: ORG_ID,
      pod_id: POD_ID,
      scope: "backend",
      agent_id: "agent-1",
      goal: "Checkpoint-only promotion block",
      metadata: REAL_AUTO_PROMOTE_METADATA,
    });
    const run = createAgentRun(ORG_ID, session!.session_id, { input_prompt: "checkpoint only" });
    createAgentCheckpoint(ORG_ID, session!.session_id, {
      run_id: run!.run_id,
      snapshot: {
        durable_learning: {
          summary: "Implemented checkpoint-only memory validation.",
          details: `Raw planner checkpoint for ${REAL_AUTO_PROMOTE_METADATA.pr_url} should not become product memory without non-checkpoint evidence.`,
        },
      },
      summary: "Raw planner checkpoint spec dump",
      artifact_refs: [{ type: "github_pr", url: REAL_AUTO_PROMOTE_METADATA.pr_url }],
    });
    await endAgentRun(ORG_ID, run!.run_id, {
      status: "completed",
      final_output: "Completed checkpoint-only workflow.",
    });
    await rollupAgentSession(ORG_ID, session!.session_id);

    await recordMergedPr();

    const candidates = listMemoryCandidates(ORG_ID, { session_id: session!.session_id });
    expect(candidates[0].status).toBe("pending");
    expect(validationGate(candidates[0]).reasons).toContain("raw_checkpoint_or_spec_dump");
    expect(ingestLearnings).not.toHaveBeenCalled();
  });

  it("keeps product candidates pending when forbidden files were touched", async () => {
    const { session } = await createPrBackedSessionCandidate({
      summary: "Implemented product memory validation with file guard.",
      details: "Product implementation candidates should not auto-promote when evidence shows forbidden files were touched.",
      artifactPath: "forbidden/product-contract.md",
    });

    await recordMergedPr();

    const candidates = listMemoryCandidates(ORG_ID, { session_id: session.session_id });
    expect(candidates[0].status).toBe("pending");
    expect(validationGate(candidates[0]).reasons).toContain("forbidden_file_touched");
    expect(ingestLearnings).not.toHaveBeenCalled();
  });

  it("does not promote product anti-patterns from merge evidence alone", async () => {
    const { session } = await createPrBackedSessionCandidate({
      summary: "Avoid cache invalidation assumptions in product memory.",
      details: "This candidate describes a risky implementation pattern that needs stronger negative evidence before durable promotion.",
    });

    await recordMergedPr();

    const candidates = listMemoryCandidates(ORG_ID, { session_id: session.session_id });
    expect(candidates[0].type).toBe("anti_pattern");
    expect(candidates[0].status).toBe("pending");
    expect(validationGate(candidates[0]).reasons).toContain("missing_explicit_negative_evidence");
    expect(ingestLearnings).not.toHaveBeenCalled();
  });

  it("promotes product anti-patterns with explicit prevention evidence", async () => {
    const { session } = await createPrBackedSessionCandidate({
      summary: "Avoid cache invalidation assumptions in product memory.",
      details: "Merged PR evidence fixes this anti-pattern by preventing stale cache regressions during answer citation refresh.",
    });

    await recordMergedPr();

    const candidates = listMemoryCandidates(ORG_ID, { session_id: session.session_id });
    expect(candidates[0].type).toBe("anti_pattern");
    expect(candidates[0].status).toBe("auto_promoted");
    expect(validationGate(candidates[0]).reasons).toEqual([]);
    expect(ingestLearnings).toHaveBeenCalledTimes(1);
  });

  it("keeps demo or audit product candidates pending even after matching PR merge evidence", async () => {
    const { session } = await createPrBackedSessionCandidate({
      summary: "Implemented demo product memory validation.",
      details: "Demo product candidates remain review-only even when they mention matching PR evidence.",
      sessionMetadata: {
        rollup_policy: "candidate_only",
        run_kind: "demo",
        side_effect_mode: "stubbed",
        promotion_intent: "audit_only",
        learning_scope: "product",
      },
    });

    await recordMergedPr();

    const candidates = listMemoryCandidates(ORG_ID, { session_id: session.session_id });
    expect(candidates[0].status).toBe("pending");
    expect(validationGate(candidates[0]).reasons).toContain("demo_or_audit_product");
    expect(ingestLearnings).not.toHaveBeenCalled();
  });

  it("promotes harness runtime anti-patterns from concrete runtime evidence", async () => {
    const { session } = await createPrBackedSessionCandidate({
      summary: "Avoid forbidden-file drift in harness rollups.",
      details: "A spec_change runtime signal showed forbidden-file drift when harness retry behavior touched blocked files during an orchestration error.",
      sessionMetadata: {
        rollup_policy: "candidate_only",
        run_kind: "demo",
        side_effect_mode: "stubbed",
        promotion_intent: "audit_only",
        learning_scope: "harness",
      },
    });

    const candidates = listMemoryCandidates(ORG_ID, { session_id: session.session_id });
    expect(candidates[0].type).toBe("anti_pattern");
    expect(candidates[0].status).toBe("auto_promoted");
    expect(candidates[0].evidence.target_memory_scope).toBe("harness");
    expect(validationGate(candidates[0])).toMatchObject({
      decision: "allowed",
      trigger: "runtime",
    });
    expect(validationGate(candidates[0]).runtime_signals).toEqual(expect.arrayContaining([
      "spec_drift",
      "retry_behavior",
      "forbidden_file_drift",
      "orchestration_error",
    ]));
    expect(ingestLearnings).toHaveBeenCalledTimes(1);
  });

  it("does not treat benign verification-status tokens as final warnings or errors", async () => {
    vi.mocked(classifyDecisionDurability).mockImplementation(async (items) => new Map(items.map((_, index) => [index, 0.85])));
    const benignStatuses = ["0 errors", "no warnings", "failsafe verified", "0 failures"];

    for (const [index, verificationStatus] of benignStatuses.entries()) {
      const contextUpdateId = `ctx-benign-verification-${index}`;
      const session = createAgentSession({
        orgId: ORG_ID,
        pod_id: POD_ID,
        scope: "backend",
        agent_id: "agent-1",
        goal: `Benign verification ${index}`,
        metadata: {
          ...REAL_AUTO_PROMOTE_METADATA,
          verification_status: verificationStatus,
        },
      });
      const run = createAgentRun(ORG_ID, session!.session_id, {
        input_prompt: "finish backend memory",
        metadata: {
          learning_summary: `Benign verification status ${index} should allow automatic promotion.`,
          learning_details: "Verification status text with zero or negated failure counts should not be classified as final warnings or errors when all other promotion evidence is real.",
        },
      });
      insertPodContextUpdate({
        id: contextUpdateId,
        type: "progress",
        summary: `Recorded benign verification ${index}.`,
        details: "A real context update row anchors the run context_update_id used by the auto-promotion gate.",
      });
      appendAgentRunEvent(ORG_ID, run!.run_id, {
        event_type: "context_update_submitted",
        payload: { context_update_id: contextUpdateId },
        summary: "Submitted durable context update",
      });
      appendAgentRunEvent(ORG_ID, run!.run_id, {
        event_type: "file_change",
        summary: "Updated code with real side effects",
        artifact_refs: [{ type: "file", path: "packages/server/src/services/agent-memory.ts" }],
      });

      await endAgentRun(ORG_ID, run!.run_id, {
        status: "completed",
        context_update_id: contextUpdateId,
        final_output: "Completed durable memory update with real verification evidence.",
      });

      let candidates = await rollupAgentSession(ORG_ID, session!.session_id);

      expect(candidates).toHaveLength(1);
      expect(candidates[0].status).toBe("pending");
      expect(promotionGate(candidates[0])).toEqual({
        decision: "allowed",
        policy: "auto_promote",
        reasons: [],
      });

      await recordMergedPr(`https://github.com/acme/pim/pull/${200 + index}`);
      candidates = listMemoryCandidates(ORG_ID, { session_id: session!.session_id });
      expect(candidates[0].status).toBe("pending");

      await recordMergedPr();
      candidates = listMemoryCandidates(ORG_ID, { session_id: session!.session_id });
      expect(candidates[0].status).toBe("auto_promoted");
      expect(validationGate(candidates[0]).reasons).toEqual([]);
    }
  });

  it("blocks auto-promotion on explicit verification failure tokens", async () => {
    vi.mocked(classifyDecisionDurability).mockImplementation(async (items) => new Map(items.map((_, index) => [index, 0.85])));
    const session = createAgentSession({
      orgId: ORG_ID,
      pod_id: POD_ID,
      scope: "backend",
      agent_id: "agent-1",
      goal: "Verification failure",
      metadata: {
        ...REAL_AUTO_PROMOTE_METADATA,
        verification_status: "failed tests",
      },
    });
    const run = createAgentRun(ORG_ID, session!.session_id, {
      input_prompt: "finish backend memory",
      metadata: {
        learning_summary: "Explicit verification failure should block auto-promotion.",
        learning_details: "Agent memory auto-promotion must remain review-gated when final verification status contains an actual failure token.",
      },
    });
    insertPodContextUpdate({
      id: "ctx-failed-verification",
      type: "progress",
      summary: "Recorded failed verification context update.",
      details: "A real context update row anchors the run context_update_id used by the auto-promotion gate.",
    });
    appendAgentRunEvent(ORG_ID, run!.run_id, {
      event_type: "context_update_submitted",
      payload: { context_update_id: "ctx-failed-verification" },
      summary: "Submitted durable context update",
    });
    appendAgentRunEvent(ORG_ID, run!.run_id, {
      event_type: "file_change",
      summary: "Updated code with real side effects",
      artifact_refs: [{ type: "file", path: "packages/server/src/services/agent-memory.ts" }],
    });

    await endAgentRun(ORG_ID, run!.run_id, {
      status: "completed",
      context_update_id: "ctx-failed-verification",
      final_output: "Completed durable memory update with failed verification.",
    });

    const candidates = await rollupAgentSession(ORG_ID, session!.session_id);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].status).toBe("pending");
    expect(promotionGate(candidates[0]).reasons).toContain("final_state_has_warnings_or_errors");
    expect(ingestLearnings).not.toHaveBeenCalled();
  });

  it("blocks auto-promotion for fake or missing context update ids", async () => {
    vi.mocked(classifyDecisionDurability).mockImplementation(async (items) => new Map(items.map((_, index) => [index, 0.85])));
    const contextUpdateIds = ["stub-1", "mock-123", "fake", "ctx-missing-row"];

    for (const [index, contextUpdateId] of contextUpdateIds.entries()) {
      const session = createAgentSession({
        orgId: ORG_ID,
        pod_id: POD_ID,
        scope: "backend",
        agent_id: "agent-1",
        goal: `Fake context update ${index}`,
        metadata: REAL_AUTO_PROMOTE_METADATA,
      });
      const run = createAgentRun(ORG_ID, session!.session_id, {
        input_prompt: "finish backend memory",
        metadata: {
          learning_summary: `Fake context update ${index} should block automatic promotion.`,
          learning_details: "A submitted context-update event is not enough for automatic promotion when the run context_update_id is a placeholder or has no backing context update row.",
        },
      });
      appendAgentRunEvent(ORG_ID, run!.run_id, {
        event_type: "context_update_submitted",
        payload: { context_update_id: contextUpdateId },
        summary: "Submitted fake context update id",
      });
      appendAgentRunEvent(ORG_ID, run!.run_id, {
        event_type: "file_change",
        summary: "Updated code with real side effects",
        artifact_refs: [{ type: "file", path: "packages/server/src/services/agent-memory.ts" }],
      });

      await endAgentRun(ORG_ID, run!.run_id, {
        status: "completed",
        context_update_id: contextUpdateId,
        final_output: "Completed durable memory update with fake context evidence.",
      });

      const candidates = await rollupAgentSession(ORG_ID, session!.session_id);

      expect(candidates).toHaveLength(1);
      expect(candidates[0].status).toBe("pending");
      expect(promotionGate(candidates[0]).reasons).toContain("missing_context_update");
    }

    expect(ingestLearnings).not.toHaveBeenCalled();
  });

  it("continues merged-PR validation when one auto-promotion ingestion fails", async () => {
    vi.mocked(classifyDecisionDurability).mockImplementation(async (items) => new Map(items.map((_, index) => [index, 0.85])));
    vi.mocked(ingestLearnings).mockRejectedValueOnce(new Error("transient ingest failure"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const session = createAgentSession({
        orgId: ORG_ID,
        pod_id: POD_ID,
        scope: "backend",
        agent_id: "agent-1",
        goal: "Continue after promotion failure",
        metadata: REAL_AUTO_PROMOTE_METADATA,
      });

      for (const index of [0, 1]) {
        const contextUpdateId = `ctx-promotion-failure-${index}`;
        const run = createAgentRun(ORG_ID, session!.session_id, {
          input_prompt: `finish backend memory ${index}`,
          metadata: {
            learning_summary: `Auto-promotion ingestion failure ${index} should not stop session rollup.`,
            learning_details: "Session rollup should keep created candidates and continue processing later durable seeds when one auto-promotion ingest attempt fails transiently.",
          },
        });
        insertPodContextUpdate({
          id: contextUpdateId,
          type: "progress",
          summary: `Recorded promotion failure context ${index}.`,
          details: "A real context update row anchors the run context_update_id used by the auto-promotion gate.",
        });
        appendAgentRunEvent(ORG_ID, run!.run_id, {
          event_type: "context_update_submitted",
          payload: { context_update_id: contextUpdateId },
          summary: "Submitted durable context update",
        });
        appendAgentRunEvent(ORG_ID, run!.run_id, {
          event_type: "file_change",
          summary: "Updated code with real side effects",
          artifact_refs: [{ type: "file", path: "packages/server/src/services/agent-memory.ts" }],
        });
        await endAgentRun(ORG_ID, run!.run_id, {
          status: "completed",
          context_update_id: contextUpdateId,
          final_output: `Completed durable memory update ${index}.`,
        });
      }

      const candidates = await rollupAgentSession(ORG_ID, session!.session_id);

      expect(candidates).toHaveLength(2);
      expect(candidates.map((candidate) => candidate.status)).toEqual(["pending", "pending"]);
      expect(ingestLearnings).not.toHaveBeenCalled();

      await recordMergedPr();
      const validated = listMemoryCandidates(ORG_ID, { session_id: session!.session_id });

      expect(validated).toHaveLength(2);
      expect(candidates.map((candidate) => candidate.summary)).toEqual(expect.arrayContaining([
        "Auto-promotion ingestion failure 0 should not stop session rollup.",
        "Auto-promotion ingestion failure 1 should not stop session rollup.",
      ]));
      expect(validated.map((candidate) => candidate.status).sort()).toEqual(["auto_promoted", "pending"]);
      expect(ingestLearnings).toHaveBeenCalledTimes(2);
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("[agent-memory] merged PR validation auto-promote failed"), expect.any(Error));
    } finally {
      consoleError.mockRestore();
    }
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
      final_output: "Durable learning: Backend memory changes need a submitted context-update event before they can be trusted for automatic promotion.",
    });
    await rollupAgentSession(ORG_ID, session!.session_id);

    const candidates = listMemoryCandidates(ORG_ID, { session_id: session!.session_id });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].status).toBe("pending");
    expect(candidates[0].confidence_score).toBe(0.7);
    expect(promotionGate(candidates[0]).reasons).toContain("policy_candidate_only");
    expect(ingestLearnings).not.toHaveBeenCalled();
  });

  it("keeps demo runs as candidates with auditable blocked gate reasons", async () => {
    const session = createAgentSession({
      orgId: ORG_ID,
      pod_id: POD_ID,
      scope: "backend",
      agent_id: "agent-1",
      goal: "Demo smoke",
      metadata: {
        rollup_policy: "candidate_only",
        run_kind: "demo",
        side_effect_mode: "stubbed",
        real_pr_created: false,
        stubbed_systems: ["github", "codegen"],
        verification_status: "passed",
        promotion_intent: "audit_only",
        pr_url: "https://example.invalid/acme/pim/pull/1",
      },
    });
    const run = createAgentRun(ORG_ID, session!.session_id, { input_prompt: "demo backend memory" });
    appendAgentRunEvent(ORG_ID, run!.run_id, {
      event_type: "file_change",
      summary: "Stubbed demo file change",
      artifact_refs: [{ type: "file", path: "packages/server/src/services/agent-memory.ts" }],
    });

    await endAgentRun(ORG_ID, run!.run_id, {
      status: "completed",
      final_output: "Durable learning: Demo smoke rollups should remain review-only when GitHub or codegen side effects are stubbed.",
    });
    await rollupAgentSession(ORG_ID, session!.session_id);

    const candidates = listMemoryCandidates(ORG_ID, { session_id: session!.session_id });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].status).toBe("pending");
    expect(promotionGate(candidates[0]).reasons).toEqual(expect.arrayContaining([
      "policy_candidate_only",
      "demo_run",
      "stubbed_side_effects",
      "stubbed_systems_present",
      "real_pr_not_confirmed",
      "promotion_intent_not_durable_learning",
      "placeholder_pr_url",
    ]));
    expect(ingestLearnings).not.toHaveBeenCalled();
  });

  it("keeps smoke tests reported as dry runs out of auto-promotion", async () => {
    const session = createAgentSession({
      orgId: ORG_ID,
      pod_id: POD_ID,
      scope: "qa",
      agent_id: "agent-qa",
      goal: "Smoke test",
      metadata: {
        rollup_policy: "candidate_only",
        run_kind: "dry_run",
        side_effect_mode: "real",
        test_kind: "smoke",
        verification_status: "passed",
      },
    });
    const run = createAgentRun(ORG_ID, session!.session_id, { input_prompt: "smoke test memory rollup" });
    appendAgentRunEvent(ORG_ID, run!.run_id, {
      event_type: "model_output",
      summary: "Smoke test passed",
    });

    await endAgentRun(ORG_ID, run!.run_id, {
      status: "completed",
      final_output: "Durable learning: Smoke-test rollups should create review candidates but stay out of auto-promotion when marked dry_run.",
    });
    await rollupAgentSession(ORG_ID, session!.session_id);

    const candidates = listMemoryCandidates(ORG_ID, { session_id: session!.session_id });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].status).toBe("pending");
    expect(promotionGate(candidates[0]).reasons).toEqual(expect.arrayContaining(["policy_candidate_only", "dry_run"]));
    expect(ingestLearnings).not.toHaveBeenCalled();
  });

  it("blocks stubbed PR runs that request auto-promotion", async () => {
    const session = createAgentSession({
      orgId: ORG_ID,
      pod_id: POD_ID,
      scope: "backend",
      agent_id: "agent-1",
      goal: "Stubbed PR run",
      metadata: {
        ...REAL_AUTO_PROMOTE_METADATA,
        side_effect_mode: "stubbed",
        real_pr_created: false,
        stubbed_systems: ["github"],
        promotion_intent: "audit_only",
        pr_url: "https://example.invalid/acme/pim/pull/123",
      },
    });
    const run = createAgentRun(ORG_ID, session!.session_id, { input_prompt: "stubbed pr" });
    appendAgentRunEvent(ORG_ID, run!.run_id, {
      event_type: "context_update_submitted",
      summary: "Submitted context update for stubbed PR",
    });
    appendAgentRunEvent(ORG_ID, run!.run_id, {
      event_type: "file_change",
      summary: "Stubbed PR touched service",
      artifact_refs: [{ type: "file", path: "packages/server/src/services/agent-memory.ts" }],
    });

    await endAgentRun(ORG_ID, run!.run_id, {
      status: "completed",
      context_update_id: "ctx-stubbed-pr",
      final_output: "Durable learning: Stubbed PR workflows must not auto-promote durable memory even when they emit file-change evidence.",
    });
    await rollupAgentSession(ORG_ID, session!.session_id);

    const candidates = listMemoryCandidates(ORG_ID, { session_id: session!.session_id });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].status).toBe("pending");
    expect(promotionGate(candidates[0]).reasons).toEqual(expect.arrayContaining([
      "stubbed_side_effects",
      "stubbed_systems_present",
      "real_pr_not_confirmed",
      "promotion_intent_not_durable_learning",
      "placeholder_pr_url",
    ]));
    expect(ingestLearnings).not.toHaveBeenCalled();
  });

  it("keeps candidate_only runs pending even when all auto-promotion evidence is present", async () => {
    vi.mocked(isLLMAvailable).mockReturnValue(true);
    vi.mocked(classifyDecisionDurability).mockResolvedValueOnce(new Map([[0, 0.85]]));
    vi.mocked(callLLMJSON).mockResolvedValueOnce({ learnings: [] });
    const session = createAgentSession({
      orgId: ORG_ID,
      pod_id: POD_ID,
      scope: "backend",
      agent_id: "agent-1",
      goal: "Candidate-only real run",
      metadata: {
        ...REAL_AUTO_PROMOTE_METADATA,
        rollup_policy: "candidate_only",
      },
    });
    const run = createAgentRun(ORG_ID, session!.session_id, { input_prompt: "candidate only" });
    appendAgentRunEvent(ORG_ID, run!.run_id, {
      event_type: "context_update_submitted",
      summary: "Submitted durable context update",
    });
    appendAgentRunEvent(ORG_ID, run!.run_id, {
      event_type: "file_change",
      summary: "Updated code with real side effects",
      artifact_refs: [{ type: "file", path: "packages/server/src/services/agent-memory.ts" }],
    });

    await endAgentRun(ORG_ID, run!.run_id, {
      status: "completed",
      context_update_id: "ctx-candidate-only",
      final_output: "Durable learning: Candidate-only rollup policy keeps even production-quality agent-session learnings pending for review.",
    });
    await rollupAgentSession(ORG_ID, session!.session_id);

    const candidates = listMemoryCandidates(ORG_ID, { session_id: session!.session_id });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].status).toBe("pending");
    expect(candidates[0].confidence_score).toBe(0.85);
    expect(promotionGate(candidates[0])).toEqual({
      decision: "blocked",
      policy: "candidate_only",
      reasons: ["policy_candidate_only"],
    });
    expect(ingestLearnings).not.toHaveBeenCalled();
  });

  it("does not create candidates when rollup_policy is none", async () => {
    const session = createAgentSession({
      orgId: ORG_ID,
      pod_id: POD_ID,
      scope: "backend",
      agent_id: "agent-1",
      goal: "No rollup",
      metadata: { rollup_policy: "none" },
    });
    const run = createAgentRun(ORG_ID, session!.session_id, { input_prompt: "do not roll up" });
    appendAgentRunEvent(ORG_ID, run!.run_id, {
      event_type: "file_change",
      summary: "Temporary local change",
      artifact_refs: [{ type: "file", path: "tmp/demo.ts" }],
    });

    await endAgentRun(ORG_ID, run!.run_id, {
      status: "completed",
      final_output: "Temporary run should not create durable memory candidates.",
    });
    await rollupAgentSession(ORG_ID, session!.session_id);

    expect(listMemoryCandidates(ORG_ID, { session_id: session!.session_id })).toHaveLength(0);
    expect(ingestLearnings).not.toHaveBeenCalled();
  });

  it("does not extract generic workflow-status summaries as deterministic durable memory", async () => {
    const session = createAgentSession({
      orgId: ORG_ID,
      pod_id: POD_ID,
      scope: "backend",
      agent_id: "agent-1",
      goal: "Generic status",
      metadata: REAL_AUTO_PROMOTE_METADATA,
    });
    const run = createAgentRun(ORG_ID, session!.session_id, { input_prompt: "status only" });
    appendAgentRunEvent(ORG_ID, run!.run_id, {
      event_type: "context_update_submitted",
      summary: "Submitted merge approval status",
    });
    appendAgentRunEvent(ORG_ID, run!.run_id, {
      event_type: "file_change",
      summary: "Code review status artifact",
      artifact_refs: [{ type: "file", path: "packages/server/src/services/agent-memory.ts" }],
    });

    await endAgentRun(ORG_ID, run!.run_id, {
      status: "completed",
      context_update_id: "ctx-status-only",
      final_output: "outcome: merge_approved",
    });
    await rollupAgentSession(ORG_ID, session!.session_id);

    const candidates = listMemoryCandidates(ORG_ID, { session_id: session!.session_id });
    expect(candidates).toHaveLength(0);
    expect(ingestLearnings).not.toHaveBeenCalled();
  });

  it("keeps repeated session rollup idempotent", async () => {
    const session = createAgentSession({
      orgId: ORG_ID,
      pod_id: POD_ID,
      scope: "backend",
      agent_id: "agent-1",
      goal: "Idempotent rollup",
    });
    const run = createAgentRun(ORG_ID, session!.session_id, { input_prompt: "finish once" });
    appendAgentRunEvent(ORG_ID, run!.run_id, {
      event_type: "model_output",
      summary: "Implemented idempotent candidate creation",
    });
    await endAgentRun(ORG_ID, run!.run_id, {
      status: "completed",
      final_output: "Durable learning: Session rollup candidates use stable content hashes so repeated rollups do not create duplicates.",
    });
    const first = await rollupAgentSession(ORG_ID, session!.session_id);

    const rolled = await rollupAgentSession(ORG_ID, session!.session_id);
    const second = listMemoryCandidates(ORG_ID, { session_id: session!.session_id });

    expect(first).toHaveLength(1);
    expect(rolled).toHaveLength(1);
    expect(rolled[0].id).toBe(first[0].id);
    expect(second.map((candidate) => candidate.id)).toEqual([first[0].id]);
  });

  it("re-rolls after rejection while skipping the exact rejected learning", async () => {
    vi.mocked(isLLMAvailable).mockReturnValue(true);
    const session = createAgentSession({
      orgId: ORG_ID,
      pod_id: POD_ID,
      scope: "backend",
      agent_id: "agent-1",
      goal: "Retry rejected rollup",
    });
    const run = createAgentRun(ORG_ID, session!.session_id, { input_prompt: "extract retry learnings" });
    await endAgentRun(ORG_ID, run!.run_id, {
      status: "completed",
      final_output: "Completed retry rollup workflow.",
    });
    const rejectedLearning = {
      type: "decision",
      domain: "backend",
      summary: "Keep rejected rollup decisions out of retry results.",
      details: "Rejected agent-session rollup content should remain rejected when the same content is extracted again during a later rollup.",
      confidence: "high",
      evidence_refs: [`run:${run!.run_id}`],
    };
    const newLearning = {
      type: "pattern",
      domain: "backend",
      summary: "Retry rollup can capture new session learnings.",
      details: "When a later extraction finds a distinct learning, agent-session rollup should create a fresh pending candidate even if older content was rejected.",
      confidence: "medium",
      evidence_refs: [`run:${run!.run_id}`],
    };
    vi.mocked(callLLMJSON)
      .mockResolvedValueOnce({ learnings: [rejectedLearning] })
      .mockResolvedValueOnce({ learnings: [rejectedLearning, newLearning] });
    const first = await rollupAgentSession(ORG_ID, session!.session_id);
    rejectMemoryCandidate(ORG_ID, first[0].id);

    const retried = await rollupAgentSession(ORG_ID, session!.session_id);
    const all = listMemoryCandidates(ORG_ID, { session_id: session!.session_id });

    expect(first).toHaveLength(1);
    expect(retried.map((candidate) => candidate.summary)).toEqual(["Retry rollup can capture new session learnings."]);
    expect(all).toHaveLength(2);
    expect(all.find((candidate) => candidate.summary === rejectedLearning.summary)?.status).toBe("rejected");
    expect(all.find((candidate) => candidate.summary === newLearning.summary)?.status).toBe("pending");
    expect(callLLMJSON).toHaveBeenCalledTimes(2);
  });

  it("reconciles new session learnings when active candidates already exist", async () => {
    vi.mocked(isLLMAvailable).mockReturnValue(true);
    const session = createAgentSession({
      orgId: ORG_ID,
      pod_id: POD_ID,
      scope: "backend",
      agent_id: "agent-1",
      goal: "Reconcile active rollup",
    });
    const run = createAgentRun(ORG_ID, session!.session_id, { input_prompt: "extract additional learnings" });
    await endAgentRun(ORG_ID, run!.run_id, {
      status: "completed",
      final_output: "Completed active reconciliation workflow.",
    });
    const existingLearning = {
      type: "decision",
      domain: "backend",
      summary: "Active rollup candidates stay idempotent across retries.",
      details: "Existing pending agent-session candidates should be reused when the same learning is extracted during a later rollup.",
      confidence: "high",
      evidence_refs: [`run:${run!.run_id}`],
    };
    const additionalLearning = {
      type: "scope_insight",
      domain: "backend",
      summary: "Active rollup retries can add newly found scope insights.",
      details: "A later session extraction should append a distinct candidate instead of returning early because another active candidate already exists.",
      confidence: "medium",
      evidence_refs: [`run:${run!.run_id}`],
    };
    vi.mocked(callLLMJSON)
      .mockResolvedValueOnce({ learnings: [existingLearning] })
      .mockResolvedValueOnce({ learnings: [existingLearning, additionalLearning] });

    const first = await rollupAgentSession(ORG_ID, session!.session_id);
    const reconciled = await rollupAgentSession(ORG_ID, session!.session_id);
    const all = listMemoryCandidates(ORG_ID, { session_id: session!.session_id });

    expect(first).toHaveLength(1);
    expect(reconciled.map((candidate) => candidate.summary)).toEqual(expect.arrayContaining([
      "Active rollup candidates stay idempotent across retries.",
      "Active rollup retries can add newly found scope insights.",
    ]));
    expect(reconciled).toHaveLength(2);
    expect(all).toHaveLength(2);
    expect(callLLMJSON).toHaveBeenCalledTimes(2);
  });

  it("keeps field-boundary-distinct session learnings from colliding", async () => {
    vi.mocked(isLLMAvailable).mockReturnValue(true);
    const session = createAgentSession({
      orgId: ORG_ID,
      pod_id: POD_ID,
      scope: "backend",
      agent_id: "agent-1",
      goal: "Preserve field boundaries",
    });
    const run = createAgentRun(ORG_ID, session!.session_id, { input_prompt: "extract boundary learnings" });
    await endAgentRun(ORG_ID, run!.run_id, {
      status: "completed",
      final_output: "Completed boundary extraction workflow.",
    });
    vi.mocked(callLLMJSON).mockResolvedValueOnce({
      learnings: [
        {
          type: "decision",
          domain: "backend",
          summary: "Redis session boundary",
          details: "not Postgres for durable storage because review candidates need replay.",
          confidence: "high",
          evidence_refs: [`run:${run!.run_id}`],
        },
        {
          type: "decision",
          domain: "backend",
          summary: "Redis session boundary not",
          details: "Postgres for durable storage because review candidates need replay.",
          confidence: "high",
          evidence_refs: [`run:${run!.run_id}`],
        },
      ],
    });

    const candidates = await rollupAgentSession(ORG_ID, session!.session_id);

    expect(candidates).toHaveLength(2);
    expect(new Set(candidates.map((candidate) => candidate.source_id)).size).toBe(2);
  });

  it("keeps punctuation-distinct session learnings from colliding", async () => {
    vi.mocked(isLLMAvailable).mockReturnValue(true);
    const session = createAgentSession({
      orgId: ORG_ID,
      pod_id: POD_ID,
      scope: "backend",
      agent_id: "agent-1",
      goal: "Preserve punctuation",
    });
    const run = createAgentRun(ORG_ID, session!.session_id, { input_prompt: "extract punctuation learnings" });
    await endAgentRun(ORG_ID, run!.run_id, {
      status: "completed",
      final_output: "Completed punctuation extraction workflow.",
    });
    vi.mocked(callLLMJSON).mockResolvedValueOnce({
      learnings: [
        {
          type: "decision",
          domain: "backend",
          summary: "Use Redis. (not Postgres)",
          details: "Durable memory storage choices must preserve punctuation-sensitive meaning across extracted session candidates.",
          confidence: "high",
          evidence_refs: [`run:${run!.run_id}`],
        },
        {
          type: "decision",
          domain: "backend",
          summary: "Use Redis not Postgres!",
          details: "Durable memory storage choices must preserve punctuation-sensitive meaning across extracted session candidates.",
          confidence: "high",
          evidence_refs: [`run:${run!.run_id}`],
        },
      ],
    });

    const candidates = await rollupAgentSession(ORG_ID, session!.session_id);

    expect(candidates).toHaveLength(2);
    expect(new Set(candidates.map((candidate) => candidate.source_id)).size).toBe(2);
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
      final_output: "Durable learning: Project memory candidates should preserve promoted audit status when a later reject request is made.",
    });
    await rollupAgentSession(ORG_ID, session!.session_id);
    const candidate = listMemoryCandidates(ORG_ID, { session_id: session!.session_id })[0];
    await promoteMemoryCandidate(ORG_ID, candidate.id);

    const rejected = rejectMemoryCandidate(ORG_ID, candidate.id);

    expect(rejected?.status).toBe("promoted");
    expect(rejected?.promoted_node_id).toBe("kn-agent-run");
  });

  it("keeps a candidate pending when KG ingestion returns no node id", async () => {
    vi.mocked(ingestLearnings).mockResolvedValueOnce({
      nodesAdded: 0,
      edgesAdded: 0,
      nodeIds: [],
      droppedCount: 1,
    });
    const session = createAgentSession({
      orgId: ORG_ID,
      pod_id: POD_ID,
      scope: "backend",
      agent_id: "agent-1",
      goal: "No node id",
    });
    const run = createAgentRun(ORG_ID, session!.session_id, {
      input_prompt: "finish memory",
      metadata: {
        learning_summary: "Promotion requires KG ingestion to return a concrete node id.",
        learning_details: "Memory candidates must remain pending when the knowledge graph gateway drops or deduplicates the learning without returning a promoted node id.",
      },
    });
    await endAgentRun(ORG_ID, run!.run_id, {
      status: "completed",
      final_output: "Completed promotion check.",
    });
    await rollupAgentSession(ORG_ID, session!.session_id);
    const candidate = listMemoryCandidates(ORG_ID, { session_id: session!.session_id })[0];

    const promoted = await promoteMemoryCandidate(ORG_ID, candidate.id);

    expect(promoted?.status).toBe("pending");
    expect(promoted?.promoted_node_id).toBeNull();
    expect(promoted?.evidence.promotion_error).toMatchObject({
      code: "kg_ingestion_returned_no_node_id",
      dropped_count: 1,
    });
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
