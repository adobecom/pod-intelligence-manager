import type { Scope } from "./pod.js";
import type { MemoryEntityRef } from "./memory.js";

export type ContextUpdateSource =
  | "manual"
  | "git-hook"
  | "claude-code-hook"
  | "mcp"
  | "sdk";

export interface ContextUpdate {
  id: string;
  agent_id: string;
  timestamp: string;
  pod_id: string;
  type: ContextUpdateType;
  scope: Scope;
  summary: string;
  details: string;
  retrieval_text?: string;
  entity_refs?: MemoryEntityRef[];
  artifacts: Artifact[];
  status: WorkStatus;
  blocks: string[];
  blocked_by: string[];
  needs_input_from: InputRequest[];
  quality_score?: number;
  /** Short AI rationale after async quality pass (optional). */
  quality_rationale?: string | null;
  source?: ContextUpdateSource;
}

export type ContextUpdateType =
  | "progress"
  | "blocker"
  | "spec_change"
  | "question"
  | "decision";

export type WorkStatus = "completed" | "in_progress" | "blocked";

export interface Artifact {
  type: string;
  path?: string;
  url?: string;
}

export interface InputRequest {
  role: Scope;
  question: string;
}
