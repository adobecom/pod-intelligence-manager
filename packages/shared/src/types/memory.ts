import type { Artifact } from "./context-update.js";
import type { KnowledgeNodeType } from "./graph.js";

export type MemoryEntityType =
  | "project"
  | "pod"
  | "scope"
  | "workstream"
  | "agent"
  | "person"
  | "component"
  | "artifact"
  | "api_contract"
  | "jira_issue"
  | "github_pr"
  | "decision"
  | "conflict"
  | "knowledge_node";

export interface MemoryEntityRef {
  type: MemoryEntityType;
  id: string;
  label?: string;
  source?: string;
}

export type TemporalQueryMode = "current" | "history" | "as_of" | "why_changed";

export type RetrievalTier = "hot" | "warm" | "cold";

export interface TemporalRelationship {
  id: string;
  org_id: string;
  source_entity_id: string;
  target_entity_id: string;
  relation_type: string;
  valid_from: string;
  valid_until?: string;
  committed_at: string;
  source_update_refs: string[];
  artifact_refs: Artifact[];
  reason?: string;
  confidence_score: number;
  created_at: string;
}

export type AgentSessionStatus = "active" | "paused" | "ended";
export type AgentRunStatus = "running" | "completed" | "failed" | "cancelled";
export const AGENT_RUN_EVENT_TYPES = [
  "tool_call",
  "tool_result",
  "model_output",
  "file_change",
  "checkpoint_created",
  "context_update_submitted",
  "run_compacted",
  "run_started",
  "run_completed",
  "run_failed",
  "run_cancelled",
  "error",
] as const;
export type AgentRunEventType = typeof AGENT_RUN_EVENT_TYPES[number];

export interface AgentSession {
  session_id: string;
  org_id: string;
  project_id?: string | null;
  pod_id?: string | null;
  scope?: string | null;
  agent_id: string;
  status: AgentSessionStatus;
  goal?: string | null;
  current_task?: string | null;
  working_state: Record<string, unknown>;
  compacted_summary?: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  ended_at?: string | null;
}

export interface AgentRun {
  run_id: string;
  session_id: string;
  org_id: string;
  project_id?: string | null;
  pod_id?: string | null;
  scope?: string | null;
  agent_id: string;
  status: AgentRunStatus;
  input_prompt?: string | null;
  model?: string | null;
  provider?: string | null;
  metadata: Record<string, unknown>;
  token_input_count: number;
  token_output_count: number;
  total_cost_usd: number;
  error_message?: string | null;
  final_output?: string | null;
  context_update_id?: string | null;
  compacted_summary?: string | null;
  started_at: string;
  ended_at?: string | null;
}

export interface AgentRunEvent {
  id: string;
  run_id: string;
  session_id: string;
  org_id: string;
  seq: number;
  event_type: AgentRunEventType;
  payload: Record<string, unknown>;
  summary?: string | null;
  artifact_refs: Artifact[];
  token_count: number;
  created_at: string;
}

export interface AgentCheckpoint {
  checkpoint_id: string;
  session_id: string;
  run_id?: string | null;
  org_id: string;
  seq: number;
  snapshot: Record<string, unknown>;
  summary?: string | null;
  artifact_refs: Artifact[];
  created_at: string;
}

export type MemoryCandidateStatus = "pending" | "promoted" | "rejected" | "auto_promoted";

export interface MemoryCandidate {
  id: string;
  org_id: string;
  project_id?: string | null;
  pod_id?: string | null;
  session_id?: string | null;
  run_id?: string | null;
  source_type: string;
  source_id: string;
  type: KnowledgeNodeType;
  summary: string;
  details: string;
  retrieval_text?: string | null;
  entity_refs: MemoryEntityRef[];
  domains: string[];
  confidence_score: number;
  evidence: Record<string, unknown>;
  status: MemoryCandidateStatus;
  promoted_node_id?: string | null;
  created_at: string;
  reviewed_at?: string | null;
}

export interface AgentResumeContext {
  session: AgentSession;
  latest_run?: AgentRun;
  working_state: Record<string, unknown>;
  latest_checkpoint?: AgentCheckpoint;
  compacted_summary?: string | null;
  recent_events: AgentRunEvent[];
  pod_living_doc?: string | null;
  same_scope_decisions: Array<{ id: string; summary: string; timestamp: string; agent_id: string }>;
  same_scope_conflicts: Array<{ id: string; summary: string; status: string; severity: string; created_at: string }>;
  project_memory: MemoryCandidate[];
  org_knowledge: Array<{ id: string; summary: string; details?: string; confidence_score: number }>;
}
