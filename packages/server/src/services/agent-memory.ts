import crypto from "node:crypto";
import db, { withImmediateTransaction, withTransaction } from "../db/connection.js";
import type {
  AgentCheckpoint,
  AgentResumeContext,
  AgentRun,
  AgentRunEvent,
  AgentRunEventType,
  AgentRunStatus,
  AgentSession,
  Artifact,
  EnhancedPodLearning,
  KnowledgeNodeType,
  MemoryCandidate,
  MemoryCandidateStatus,
  MemoryEntityRef,
} from "@pim/shared";
import {
  buildRetrievalText,
  extractEntityRefs,
  persistMemoryEntities,
} from "./memory-enrichment.js";
import { queryKnowledge } from "./knowledge-graph.js";
import { ingestLearnings } from "./ingestion-gateway.js";

const AUTO_PROMOTE_CONFIDENCE_MIN = 0.85;
const AGENT_RUN_CONFIDENCE_CAP = 0.7;
const DEFAULT_RECENT_EVENT_LIMIT = 25;

export class AgentMemorySequenceError extends Error {
  constructor(message: string, public expectedSeq: number) {
    super(message);
    this.name = "AgentMemorySequenceError";
  }
}

export class AgentRunNotAppendableError extends Error {
  constructor(public runStatus: AgentRunStatus) {
    super(`Cannot append events to a ${runStatus} agent run`);
    this.name = "AgentRunNotAppendableError";
  }
}

type JsonRecord = Record<string, unknown>;

interface SessionRow {
  session_id: string;
  org_id: string;
  project_id: string | null;
  pod_id: string | null;
  scope: string | null;
  agent_id: string;
  status: AgentSession["status"];
  goal: string | null;
  current_task: string | null;
  working_state_json: string;
  compacted_summary: string | null;
  last_compacted_event_rowid: number;
  metadata_json: string;
  created_at: string;
  updated_at: string;
  ended_at: string | null;
}

interface RunRow {
  run_id: string;
  session_id: string;
  org_id: string;
  project_id: string | null;
  pod_id: string | null;
  scope: string | null;
  agent_id: string;
  status: AgentRunStatus;
  input_prompt: string | null;
  model: string | null;
  provider: string | null;
  metadata_json: string;
  token_input_count: number;
  token_output_count: number;
  total_cost_usd: number;
  error_message: string | null;
  final_output: string | null;
  context_update_id: string | null;
  compacted_summary: string | null;
  started_at: string;
  ended_at: string | null;
}

interface EventRow {
  id: string;
  run_id: string;
  session_id: string;
  org_id: string;
  seq: number;
  event_type: AgentRunEventType;
  payload_json: string;
  summary: string | null;
  artifact_refs_json: string;
  token_count: number;
  created_at: string;
}

interface EventCompactionRow extends EventRow {
  event_rowid: number;
}

interface EventCompactionStats {
  event_count: number;
  char_count: number;
  max_rowid: number;
}

interface CheckpointRow {
  checkpoint_id: string;
  session_id: string;
  run_id: string | null;
  org_id: string;
  seq: number;
  snapshot_json: string;
  summary: string | null;
  artifact_refs_json: string;
  created_at: string;
}

interface CandidateRow {
  id: string;
  org_id: string;
  project_id: string | null;
  pod_id: string | null;
  session_id: string | null;
  run_id: string | null;
  source_type: string;
  source_id: string;
  type: KnowledgeNodeType;
  summary: string;
  details: string;
  retrieval_text: string | null;
  entity_refs_json: string;
  domains_json: string;
  confidence_score: number;
  evidence_json: string;
  status: MemoryCandidateStatus;
  promoted_node_id: string | null;
  created_at: string;
  reviewed_at: string | null;
}

function id(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toSession(row: SessionRow): AgentSession {
  return {
    session_id: row.session_id,
    org_id: row.org_id,
    project_id: row.project_id,
    pod_id: row.pod_id,
    scope: row.scope,
    agent_id: row.agent_id,
    status: row.status,
    goal: row.goal,
    current_task: row.current_task,
    working_state: parseJson<JsonRecord>(row.working_state_json, {}),
    compacted_summary: row.compacted_summary,
    metadata: parseJson<JsonRecord>(row.metadata_json, {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
    ended_at: row.ended_at,
  };
}

function toRun(row: RunRow): AgentRun {
  return {
    run_id: row.run_id,
    session_id: row.session_id,
    org_id: row.org_id,
    project_id: row.project_id,
    pod_id: row.pod_id,
    scope: row.scope,
    agent_id: row.agent_id,
    status: row.status,
    input_prompt: row.input_prompt,
    model: row.model,
    provider: row.provider,
    metadata: parseJson<JsonRecord>(row.metadata_json, {}),
    token_input_count: row.token_input_count,
    token_output_count: row.token_output_count,
    total_cost_usd: row.total_cost_usd,
    error_message: row.error_message,
    final_output: row.final_output,
    context_update_id: row.context_update_id,
    compacted_summary: row.compacted_summary,
    started_at: row.started_at,
    ended_at: row.ended_at,
  };
}

function toEvent(row: EventRow): AgentRunEvent {
  return {
    id: row.id,
    run_id: row.run_id,
    session_id: row.session_id,
    org_id: row.org_id,
    seq: row.seq,
    event_type: row.event_type,
    payload: parseJson<JsonRecord>(row.payload_json, {}),
    summary: row.summary,
    artifact_refs: parseJson<Artifact[]>(row.artifact_refs_json, []),
    token_count: row.token_count,
    created_at: row.created_at,
  };
}

function toCheckpoint(row: CheckpointRow): AgentCheckpoint {
  return {
    checkpoint_id: row.checkpoint_id,
    session_id: row.session_id,
    run_id: row.run_id,
    org_id: row.org_id,
    seq: row.seq,
    snapshot: parseJson<JsonRecord>(row.snapshot_json, {}),
    summary: row.summary,
    artifact_refs: parseJson<Artifact[]>(row.artifact_refs_json, []),
    created_at: row.created_at,
  };
}

function toCandidate(row: CandidateRow): MemoryCandidate {
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    pod_id: row.pod_id,
    session_id: row.session_id,
    run_id: row.run_id,
    source_type: row.source_type,
    source_id: row.source_id,
    type: row.type,
    summary: row.summary,
    details: row.details,
    retrieval_text: row.retrieval_text,
    entity_refs: parseJson<MemoryEntityRef[]>(row.entity_refs_json, []),
    domains: parseJson<string[]>(row.domains_json, []),
    confidence_score: row.confidence_score,
    evidence: parseJson<JsonRecord>(row.evidence_json, {}),
    status: row.status,
    promoted_node_id: row.promoted_node_id,
    created_at: row.created_at,
    reviewed_at: row.reviewed_at,
  };
}

function getSessionRow(orgId: string, sessionId: string): SessionRow | null {
  const row = db
    .prepare("SELECT * FROM agent_sessions WHERE org_id = ? AND session_id = ?")
    .get(orgId, sessionId) as unknown as SessionRow | undefined;
  return row ?? null;
}

function getRunRow(orgId: string, runId: string): RunRow | null {
  const row = db
    .prepare("SELECT * FROM agent_runs WHERE org_id = ? AND run_id = ?")
    .get(orgId, runId) as unknown as RunRow | undefined;
  return row ?? null;
}

function loadPod(orgId: string, podId: string | null | undefined):
  | { pod_id: string; name: string; project_id: string | null }
  | null {
  if (!podId) return null;
  const row = db
    .prepare("SELECT pod_id, name, project_id FROM pods WHERE pod_id = ? AND org_id = ?")
    .get(podId, orgId) as { pod_id: string; name: string; project_id: string | null } | undefined;
  return row ?? null;
}

function loadProject(orgId: string, projectId: string | null | undefined):
  | { project_id: string; name: string }
  | null {
  if (!projectId) return null;
  const row = db
    .prepare("SELECT project_id, name FROM projects WHERE project_id = ? AND org_id = ?")
    .get(projectId, orgId) as { project_id: string; name: string } | undefined;
  return row ?? null;
}

export function createAgentSession(input: {
  orgId: string;
  project_id?: string | null;
  pod_id?: string | null;
  scope?: string | null;
  agent_id: string;
  goal?: string | null;
  current_task?: string | null;
  working_state?: JsonRecord;
  metadata?: JsonRecord;
}): AgentSession | null {
  const pod = loadPod(input.orgId, input.pod_id);
  if (input.pod_id && !pod) return null;
  const projectId = input.project_id ?? pod?.project_id ?? null;
  if (projectId && !loadProject(input.orgId, projectId)) return null;
  const now = new Date().toISOString();
  const sessionId = id("as");
  db.prepare(
    `INSERT INTO agent_sessions
       (session_id, org_id, project_id, pod_id, scope, agent_id, status, goal, current_task,
        working_state_json, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
  ).run(
    sessionId,
    input.orgId,
    projectId,
    input.pod_id ?? null,
    input.scope ?? null,
    input.agent_id,
    input.goal ?? null,
    input.current_task ?? null,
    JSON.stringify(input.working_state ?? {}),
    JSON.stringify(input.metadata ?? {}),
    now,
    now,
  );
  const row = getSessionRow(input.orgId, sessionId);
  return row ? toSession(row) : null;
}

export function getAgentSession(orgId: string, sessionId: string): AgentSession | null {
  const row = getSessionRow(orgId, sessionId);
  return row ? toSession(row) : null;
}

export function updateAgentSessionWorkingState(
  orgId: string,
  sessionId: string,
  input: { working_state: JsonRecord; merge?: boolean; current_task?: string | null; status?: AgentSession["status"] },
): AgentSession | null {
  const row = getSessionRow(orgId, sessionId);
  if (!row) return null;
  const current = parseJson<JsonRecord>(row.working_state_json, {});
  const next = input.merge === false ? input.working_state : { ...current, ...input.working_state };
  const now = new Date().toISOString();
  const hasCurrentTask = Object.prototype.hasOwnProperty.call(input, "current_task");
  const currentTask = hasCurrentTask ? input.current_task ?? null : row.current_task;
  db.prepare(
    `UPDATE agent_sessions
     SET working_state_json = ?, current_task = ?, status = COALESCE(?, status), updated_at = ?
     WHERE org_id = ? AND session_id = ?`,
  ).run(JSON.stringify(next), currentTask, input.status ?? null, now, orgId, sessionId);
  const updated = getSessionRow(orgId, sessionId);
  return updated ? toSession(updated) : null;
}

export function createAgentRun(orgId: string, sessionId: string, input: {
  input_prompt?: string | null;
  model?: string | null;
  provider?: string | null;
  metadata?: JsonRecord;
}): AgentRun | null {
  const sessionRow = getSessionRow(orgId, sessionId);
  if (!sessionRow) return null;
  const now = new Date().toISOString();
  const runId = id("ar");
  db.prepare(
    `INSERT INTO agent_runs
       (run_id, session_id, org_id, project_id, pod_id, scope, agent_id, status, input_prompt, model, provider, metadata_json, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`,
  ).run(
    runId,
    sessionId,
    orgId,
    sessionRow.project_id,
    sessionRow.pod_id,
    sessionRow.scope,
    sessionRow.agent_id,
    input.input_prompt ?? null,
    input.model ?? null,
    input.provider ?? null,
    JSON.stringify(input.metadata ?? {}),
    now,
  );
  db.prepare("UPDATE agent_sessions SET updated_at = ? WHERE session_id = ? AND org_id = ?").run(now, sessionId, orgId);
  const row = getRunRow(orgId, runId);
  return row ? toRun(row) : null;
}

function nextRunEventSeq(runId: string): number {
  const row = db
    .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM agent_run_events WHERE run_id = ?")
    .get(runId) as { next_seq: number };
  return row.next_seq;
}

export function appendAgentRunEvent(orgId: string, runId: string, input: {
  event_type: AgentRunEventType;
  payload?: JsonRecord;
  summary?: string | null;
  artifact_refs?: Artifact[];
  token_count?: number;
  expected_seq?: number;
  created_at?: string;
}): AgentRunEvent | null {
  return withImmediateTransaction(() => {
    const run = getRunRow(orgId, runId);
    if (!run) return null;
    if (run.status !== "running") throw new AgentRunNotAppendableError(run.status);

    const nextSeq = nextRunEventSeq(runId);
    if (input.expected_seq !== undefined && input.expected_seq !== nextSeq) {
      throw new AgentMemorySequenceError(`Expected event seq ${input.expected_seq}, next seq is ${nextSeq}`, nextSeq);
    }
    const eventId = id("are");
    const now = input.created_at ?? new Date().toISOString();
    try {
      db.prepare(
        `INSERT INTO agent_run_events
           (id, run_id, session_id, org_id, seq, event_type, payload_json, summary, artifact_refs_json, token_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        eventId,
        run.run_id,
        run.session_id,
        orgId,
        nextSeq,
        input.event_type,
        JSON.stringify(input.payload ?? {}),
        input.summary ?? null,
        JSON.stringify(input.artifact_refs ?? []),
        input.token_count ?? 0,
        now,
      );
    } catch (err) {
      if (err instanceof Error && err.message.includes("UNIQUE constraint failed: agent_run_events.run_id, agent_run_events.seq")) {
        throw new AgentMemorySequenceError(`Expected event seq ${nextSeq}, next seq is ${nextSeq + 1}`, nextSeq + 1);
      }
      throw err;
    }
    db.prepare("UPDATE agent_sessions SET updated_at = ? WHERE session_id = ? AND org_id = ?").run(now, run.session_id, orgId);
    compactSessionIfNeeded(orgId, run.session_id, run.run_id);
    const row = db.prepare("SELECT * FROM agent_run_events WHERE id = ?").get(eventId) as unknown as EventRow;
    return toEvent(row);
  });
}

function nextCheckpointSeq(sessionId: string): number {
  const row = db
    .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM agent_checkpoints WHERE session_id = ?")
    .get(sessionId) as { next_seq: number };
  return row.next_seq;
}

function positiveIntFromEnv(name: string, fallback: number): number {
  const parsed = parseInt(process.env[name] ?? String(fallback), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function createAgentCheckpoint(orgId: string, sessionId: string, input: {
  run_id?: string | null;
  snapshot: JsonRecord;
  summary?: string | null;
  artifact_refs?: Artifact[];
}): AgentCheckpoint | null {
  const session = getSessionRow(orgId, sessionId);
  if (!session) return null;
  if (input.run_id && !getRunRow(orgId, input.run_id)) return null;
  const now = new Date().toISOString();
  const checkpointId = id("acp");
  const seq = nextCheckpointSeq(sessionId);
  db.prepare(
    `INSERT INTO agent_checkpoints
       (checkpoint_id, session_id, run_id, org_id, seq, snapshot_json, summary, artifact_refs_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    checkpointId,
    sessionId,
    input.run_id ?? null,
    orgId,
    seq,
    JSON.stringify(input.snapshot),
    input.summary ?? null,
    JSON.stringify(input.artifact_refs ?? []),
    now,
  );
  db.prepare("UPDATE agent_sessions SET updated_at = ? WHERE session_id = ? AND org_id = ?").run(now, sessionId, orgId);
  const row = db.prepare("SELECT * FROM agent_checkpoints WHERE checkpoint_id = ?").get(checkpointId) as unknown as CheckpointRow;
  return toCheckpoint(row);
}

function compactSessionIfNeeded(orgId: string, sessionId: string, runId?: string): void {
  const session = getSessionRow(orgId, sessionId);
  if (!session) return;
  const eventThreshold = positiveIntFromEnv("AGENT_MEMORY_COMPACT_EVENT_THRESHOLD", 50);
  const charThreshold = positiveIntFromEnv("AGENT_MEMORY_COMPACT_CHAR_THRESHOLD", 12000);
  const lastCompactedRowid = session.last_compacted_event_rowid ?? 0;
  const stats = db
    .prepare(
      `SELECT
         COUNT(*) AS event_count,
         COALESCE(SUM(LENGTH(COALESCE(summary, '')) + LENGTH(payload_json)), 0) AS char_count,
         COALESCE(MAX(rowid), ?) AS max_rowid
       FROM agent_run_events
       WHERE org_id = ? AND session_id = ? AND rowid > ?`,
    )
    .get(lastCompactedRowid, orgId, sessionId, lastCompactedRowid) as unknown as EventCompactionStats;
  if (stats.event_count < eventThreshold && stats.char_count < charThreshold) return;

  const rows = db
    .prepare(
      `SELECT rowid AS event_rowid, *
       FROM agent_run_events
       WHERE org_id = ?
         AND session_id = ?
         AND rowid > ?
         AND (event_type IN ('model_output','file_change','checkpoint_created','context_update_submitted','run_compacted')
              OR summary IS NOT NULL)
       ORDER BY rowid DESC
       LIMIT 20`,
    )
    .all(orgId, sessionId, lastCompactedRowid) as unknown as EventCompactionRow[];
  const durable = rows
    .reverse()
    .map((r) => `- #${r.seq} ${r.event_type}: ${r.summary ?? r.payload_json.slice(0, 160)}`);
  const prior = session.compacted_summary?.trim();
  const summary = [
    prior ? `Prior compacted memory:\n${prior.slice(-4000)}` : "",
    "Compacted agent session memory.",
    `Events compacted in this segment: ${stats.event_count}.`,
    `Compacted through event row: ${stats.max_rowid}.`,
    durable.length > 0 ? "Recent durable signals:\n" + durable.join("\n") : "",
  ].filter(Boolean).join("\n");
  const now = new Date().toISOString();
  db.prepare("UPDATE agent_sessions SET compacted_summary = ?, last_compacted_event_rowid = ?, updated_at = ? WHERE org_id = ? AND session_id = ?").run(
    summary,
    stats.max_rowid,
    now,
    orgId,
    sessionId,
  );
  if (runId) {
    db.prepare("UPDATE agent_runs SET compacted_summary = ? WHERE org_id = ? AND run_id = ?").run(
      summary,
      orgId,
      runId,
    );
  }
}

export async function endAgentRun(orgId: string, runId: string, input: {
  status: AgentRunStatus;
  final_output?: string | null;
  error_message?: string | null;
  token_input_count?: number;
  token_output_count?: number;
  total_cost_usd?: number;
  context_update_id?: string | null;
  compacted_summary?: string | null;
}): Promise<AgentRun | null> {
  const run = getRunRow(orgId, runId);
  if (!run) return null;
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE agent_runs
     SET status = ?, final_output = ?, error_message = ?, token_input_count = ?, token_output_count = ?,
         total_cost_usd = ?, context_update_id = ?, compacted_summary = COALESCE(?, compacted_summary), ended_at = ?
     WHERE org_id = ? AND run_id = ?`,
  ).run(
    input.status,
    input.final_output ?? run.final_output,
    input.error_message ?? run.error_message,
    input.token_input_count ?? run.token_input_count,
    input.token_output_count ?? run.token_output_count,
    input.total_cost_usd ?? run.total_cost_usd,
    input.context_update_id ?? run.context_update_id,
    input.compacted_summary ?? null,
    now,
    orgId,
    runId,
  );
  db.prepare("UPDATE agent_sessions SET updated_at = ? WHERE org_id = ? AND session_id = ?").run(now, orgId, run.session_id);
  const updated = getRunRow(orgId, runId);
  if (updated?.status === "completed") await rollupAgentRun(orgId, runId);
  return updated ? toRun(updated) : null;
}

function latestRun(orgId: string, sessionId: string): AgentRun | undefined {
  const row = db
    .prepare("SELECT * FROM agent_runs WHERE org_id = ? AND session_id = ? ORDER BY started_at DESC LIMIT 1")
    .get(orgId, sessionId) as unknown as RunRow | undefined;
  return row ? toRun(row) : undefined;
}

export function getAgentSessionTimeline(orgId: string, sessionId: string): {
  session: AgentSession;
  runs: AgentRun[];
  events: AgentRunEvent[];
  checkpoints: AgentCheckpoint[];
} | null {
  const sessionRow = getSessionRow(orgId, sessionId);
  if (!sessionRow) return null;
  const runs = (db
    .prepare("SELECT * FROM agent_runs WHERE org_id = ? AND session_id = ? ORDER BY started_at ASC")
    .all(orgId, sessionId) as unknown as RunRow[]).map(toRun);
  const events = (db
    .prepare("SELECT * FROM agent_run_events WHERE org_id = ? AND session_id = ? ORDER BY created_at ASC, seq ASC")
    .all(orgId, sessionId) as unknown as EventRow[]).map(toEvent);
  const checkpoints = (db
    .prepare("SELECT * FROM agent_checkpoints WHERE org_id = ? AND session_id = ? ORDER BY seq ASC")
    .all(orgId, sessionId) as unknown as CheckpointRow[]).map(toCheckpoint);
  return { session: toSession(sessionRow), runs, events, checkpoints };
}

export function listMemoryCandidates(orgId: string, filters: {
  session_id?: string;
  project_id?: string;
  status?: MemoryCandidateStatus;
  } = {}): MemoryCandidate[] {
  const clauses = ["org_id = ?"];
  const args: string[] = [orgId];
  if (filters.session_id) {
    clauses.push("session_id = ?");
    args.push(filters.session_id);
  }
  if (filters.project_id) {
    clauses.push("project_id = ?");
    args.push(filters.project_id);
  }
  if (filters.status) {
    clauses.push("status = ?");
    args.push(filters.status);
  }
  const rows = db
    .prepare(`SELECT * FROM memory_candidates WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC`)
    .all(...args) as unknown as CandidateRow[];
  return rows.map(toCandidate);
}

export async function assembleAgentResumeContext(
  orgId: string,
  sessionId: string,
  eventLimit = DEFAULT_RECENT_EVENT_LIMIT,
): Promise<AgentResumeContext | null> {
  const sessionRow = getSessionRow(orgId, sessionId);
  if (!sessionRow) return null;
  const session = toSession(sessionRow);
  const latestCheckpointRow = db
    .prepare("SELECT * FROM agent_checkpoints WHERE org_id = ? AND session_id = ? ORDER BY seq DESC LIMIT 1")
    .get(orgId, sessionId) as unknown as CheckpointRow | undefined;
  const eventRows = db
    .prepare("SELECT * FROM agent_run_events WHERE org_id = ? AND session_id = ? ORDER BY created_at DESC, seq DESC LIMIT ?")
    .all(orgId, sessionId, eventLimit) as unknown as EventRow[];
  const livingDoc = session.pod_id
    ? db.prepare("SELECT markdown FROM living_docs WHERE pod_id = ? AND org_id = ?").get(session.pod_id, orgId) as { markdown: string } | undefined
    : undefined;
  const decisions = session.pod_id && session.scope
    ? db.prepare(
        `SELECT id, summary, timestamp, agent_id
         FROM context_updates
         WHERE org_id = ? AND pod_id = ? AND scope = ? AND type = 'decision' AND retracted_at IS NULL
         ORDER BY timestamp DESC LIMIT 10`,
      ).all(orgId, session.pod_id, session.scope) as Array<{ id: string; summary: string; timestamp: string; agent_id: string }>
    : [];
  const conflicts = session.pod_id
    ? db.prepare(
        `SELECT id, summary, status, severity, created_at
         FROM conflicts
         WHERE org_id = ? AND pod_id = ? AND status != 'dismissed'
         ORDER BY created_at DESC LIMIT 10`,
      ).all(orgId, session.pod_id) as Array<{ id: string; summary: string; status: string; severity: string; created_at: string }>
    : [];
  const projectMemory = session.project_id
    ? listMemoryCandidates(orgId, { project_id: session.project_id })
        .filter((candidate) => candidate.status === "promoted" || candidate.status === "auto_promoted")
        .slice(0, 10)
    : [];

  let orgKnowledge: AgentResumeContext["org_knowledge"] = [];
  try {
    const query = [
      session.goal,
      session.current_task,
      session.scope,
      ...(eventRows.map((e) => e.summary).filter(Boolean) as string[]),
    ].filter(Boolean).join(" ");
    const kg = queryKnowledge(orgId, {
      filters: {
        ...(session.project_id ? { include_project_id: session.project_id } : {}),
        ...(session.scope ? { domains: [session.scope] } : {}),
      },
      query_text: query || undefined,
      max_tokens: 1000,
      include_details: true,
      limit: 8,
    });
    orgKnowledge = kg.nodes.map((n) => ({
      id: n.id,
      summary: n.summary,
      details: n.details,
      confidence_score: n.confidence_score,
    }));
  } catch {
    orgKnowledge = [];
  }

  return {
    session,
    latest_run: latestRun(orgId, sessionId),
    working_state: session.working_state,
    latest_checkpoint: latestCheckpointRow ? toCheckpoint(latestCheckpointRow) : undefined,
    compacted_summary: session.compacted_summary,
    recent_events: eventRows.reverse().map(toEvent),
    pod_living_doc: livingDoc?.markdown ?? null,
    same_scope_decisions: decisions,
    same_scope_conflicts: conflicts,
    project_memory: projectMemory,
    org_knowledge: orgKnowledge,
  };
}

function candidateType(summary: string, details: string): KnowledgeNodeType {
  const text = `${summary} ${details}`.toLowerCase();
  if (text.includes("avoid") || text.includes("regression") || text.includes("risk")) return "anti_pattern";
  if (text.includes("conflict") || text.includes("resolved")) return "resolved_conflict";
  if (text.includes("decision") || text.includes("decided") || text.includes("chose")) return "decision";
  if (text.includes("pattern") || text.includes("implemented") || text.includes("fixed")) return "pattern";
  return "scope_insight";
}

function summarizeRun(run: RunRow, events: AgentRunEvent[]): { summary: string; details: string } {
  const final = run.final_output?.trim();
  const compacted = run.compacted_summary?.trim();
  const eventSummary = events.map((e) => e.summary).filter(Boolean).slice(-8).join("\n");
  const seed = final || compacted || eventSummary || run.input_prompt || `Agent run ${run.run_id}`;
  const firstLine = seed.split(/\n+/)[0].trim();
  const summary = firstLine.length >= 10 ? firstLine.slice(0, 500) : `Agent run outcome for ${run.agent_id}`;
  const details = [final, compacted, eventSummary, `Run id: ${run.run_id}`].filter(Boolean).join("\n\n");
  return {
    summary,
    details: details.length >= 30 ? details.slice(0, 4000) : `${summary}\n\nRun id: ${run.run_id}. Durable result from completed agent run.`,
  };
}

async function promoteCandidate(candidate: MemoryCandidate, auto: boolean): Promise<MemoryCandidate> {
  const project = candidate.project_id
    ? loadProject(candidate.org_id, candidate.project_id)
    : null;
  const pod = candidate.pod_id
    ? loadPod(candidate.org_id, candidate.pod_id)
    : null;
  const learning: EnhancedPodLearning = {
    type: candidate.type,
    summary: candidate.summary,
    details: candidate.details,
    retrieval_text: candidate.retrieval_text ?? undefined,
    entity_refs: candidate.entity_refs,
    domains: candidate.domains.length > 0 ? candidate.domains : ["agent-run"],
    confidence: candidate.confidence_score >= AUTO_PROMOTE_CONFIDENCE_MIN ? "extracted" : "inferred",
    confidence_score: candidate.confidence_score,
    audience: project ? "project" : "org",
    provenance: [
      {
        source: candidate.source_type,
        source_id: candidate.source_id,
        title: candidate.summary,
      },
    ],
    ingestion_provenance: {
      kind: "agent_run",
      run_id: `agent-memory:${candidate.id}`,
      model: "deterministic-rollup-v1",
      evidence_node_ids: [],
      evidence_item_ids: [],
    },
  };
  const result = await ingestLearnings(
    candidate.org_id,
    [learning],
    candidate.pod_id ?? `agent-session-${candidate.session_id ?? "unknown"}`,
    pod?.name ?? "Agent Run Memory",
    "agent_run",
    project ? { project_id: project.project_id, project_name: project.name } : undefined,
    { skipAnalysis: true },
  );
  const now = new Date().toISOString();
  const nodeId = result.nodeIds[0] ?? candidate.promoted_node_id ?? null;
  const status: MemoryCandidateStatus = auto ? "auto_promoted" : "promoted";
  db.prepare(
    "UPDATE memory_candidates SET status = ?, promoted_node_id = ?, reviewed_at = ? WHERE org_id = ? AND id = ?",
  ).run(status, nodeId, now, candidate.org_id, candidate.id);
  return getMemoryCandidate(candidate.org_id, candidate.id) ?? { ...candidate, status, promoted_node_id: nodeId, reviewed_at: now };
}

function getMemoryCandidate(orgId: string, candidateId: string): MemoryCandidate | null {
  const row = db
    .prepare("SELECT * FROM memory_candidates WHERE org_id = ? AND id = ?")
    .get(orgId, candidateId) as unknown as CandidateRow | undefined;
  return row ? toCandidate(row) : null;
}

export async function promoteMemoryCandidate(orgId: string, candidateId: string): Promise<MemoryCandidate | null> {
  const candidate = getMemoryCandidate(orgId, candidateId);
  if (!candidate) return null;
  if (candidate.status === "promoted" || candidate.status === "auto_promoted") return candidate;
  return promoteCandidate(candidate, false);
}

export function rejectMemoryCandidate(orgId: string, candidateId: string): MemoryCandidate | null {
  const candidate = getMemoryCandidate(orgId, candidateId);
  if (!candidate) return null;
  if (candidate.status === "promoted" || candidate.status === "auto_promoted") return candidate;
  const now = new Date().toISOString();
  db.prepare("UPDATE memory_candidates SET status = 'rejected', reviewed_at = ? WHERE org_id = ? AND id = ?").run(now, orgId, candidateId);
  return getMemoryCandidate(orgId, candidateId);
}

export async function rollupAgentRun(orgId: string, runId: string): Promise<MemoryCandidate | null> {
  const run = getRunRow(orgId, runId);
  if (!run) return null;
  const existing = db
    .prepare("SELECT * FROM memory_candidates WHERE org_id = ? AND source_type = 'agent_run' AND source_id = ?")
    .get(orgId, runId) as unknown as CandidateRow | undefined;
  if (existing) return toCandidate(existing);

  const session = getSessionRow(orgId, run.session_id);
  if (!session) return null;
  const events = (db
    .prepare("SELECT * FROM agent_run_events WHERE org_id = ? AND run_id = ? ORDER BY seq ASC")
    .all(orgId, runId) as unknown as EventRow[]).map(toEvent);
  const text = summarizeRun(run, events);
  const artifactRefs = events.flatMap((e) => e.artifact_refs);
  const project = loadProject(orgId, run.project_id);
  const pod = loadPod(orgId, run.pod_id);
  const entityRefs = extractEntityRefs({
    orgId,
    project,
    pod,
    scope: run.scope,
    agentId: run.agent_id,
    type: "agent_run",
    summary: text.summary,
    details: text.details,
    artifacts: artifactRefs,
    source: "agent_run",
  });
  persistMemoryEntities(orgId, entityRefs, { source_run_id: run.run_id });
  const retrievalText = buildRetrievalText({
    kind: "memory_candidate",
    summary: text.summary,
    details: text.details,
    type: candidateType(text.summary, text.details),
    projectName: project?.name,
    podName: pod?.name,
    scope: run.scope,
    agentId: run.agent_id,
    source: "agent_run",
    artifacts: artifactRefs,
    entityRefs,
    currentStatus: "current",
    provenance: [`session_id:${run.session_id}`, `run_id:${run.run_id}`],
  });
  const confidence = run.status === "completed" && (run.final_output || run.context_update_id)
    ? AGENT_RUN_CONFIDENCE_CAP
    : 0.6;
  const candidateId = id("mc");
  const now = new Date().toISOString();
  const domains = [...new Set([run.scope, run.project_id, "agent-run"].filter((v): v is string => !!v))];
  const evidence = {
    session_id: run.session_id,
    run_id: run.run_id,
    event_count: events.length,
    context_update_id: run.context_update_id,
  };
  return withImmediateTransaction(() => {
    const existing = db
      .prepare("SELECT * FROM memory_candidates WHERE org_id = ? AND source_type = 'agent_run' AND source_id = ?")
      .get(orgId, runId) as unknown as CandidateRow | undefined;
    if (existing) return toCandidate(existing);

    try {
      db.prepare(
        `INSERT INTO memory_candidates
           (id, org_id, project_id, pod_id, session_id, run_id, source_type, source_id, type, summary, details,
            retrieval_text, entity_refs_json, domains_json, confidence_score, evidence_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'agent_run', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      ).run(
        candidateId,
        orgId,
        run.project_id,
        run.pod_id,
        run.session_id,
        run.run_id,
        run.run_id,
        candidateType(text.summary, text.details),
        text.summary,
        text.details,
        retrievalText,
        JSON.stringify(entityRefs),
        JSON.stringify(domains),
        confidence,
        JSON.stringify(evidence),
        now,
      );
    } catch (err) {
      if (err instanceof Error && err.message.includes("UNIQUE constraint failed: memory_candidates.org_id, memory_candidates.source_type, memory_candidates.source_id")) {
        const row = db
          .prepare("SELECT * FROM memory_candidates WHERE org_id = ? AND source_type = 'agent_run' AND source_id = ?")
          .get(orgId, runId) as unknown as CandidateRow | undefined;
        if (row) return toCandidate(row);
      }
      throw err;
    }
    return getMemoryCandidate(orgId, candidateId);
  });
}

export async function rollupAgentSession(orgId: string, sessionId: string): Promise<MemoryCandidate[]> {
  const runs = db
    .prepare("SELECT run_id FROM agent_runs WHERE org_id = ? AND session_id = ? AND status = 'completed' ORDER BY started_at ASC")
    .all(orgId, sessionId) as { run_id: string }[];
  const out: MemoryCandidate[] = [];
  for (const run of runs) {
    const candidate = await rollupAgentRun(orgId, run.run_id);
    if (candidate) out.push(candidate);
  }
  return out;
}

export function closeAgentSession(orgId: string, sessionId: string): AgentSession | null {
  const row = getSessionRow(orgId, sessionId);
  if (!row) return null;
  const now = new Date().toISOString();
  db.prepare("UPDATE agent_sessions SET status = 'ended', ended_at = ?, updated_at = ? WHERE org_id = ? AND session_id = ?").run(
    now,
    now,
    orgId,
    sessionId,
  );
  const updated = getSessionRow(orgId, sessionId);
  return updated ? toSession(updated) : null;
}

export function createAgentCheckpointInTransaction(orgId: string, sessionId: string, input: {
  run_id?: string | null;
  snapshot: JsonRecord;
  summary?: string | null;
  artifact_refs?: Artifact[];
}): AgentCheckpoint | null {
  return withTransaction(() => createAgentCheckpoint(orgId, sessionId, input));
}
