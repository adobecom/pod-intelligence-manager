import type { Scope } from "./pod";

export interface ContextUpdate {
  id: string;
  agent_id: string;
  timestamp: string;
  pod_id: string;
  type: ContextUpdateType;
  scope: Scope;
  summary: string;
  details: string;
  artifacts: Artifact[];
  status: WorkStatus;
  blocks: string[];
  blocked_by: string[];
  needs_input_from: InputRequest[];
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
