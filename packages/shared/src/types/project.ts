import type {
  ContextUpdateType,
  WorkStatus,
  Artifact,
  InputRequest,
  ContextUpdateSource,
} from "./context-update";
import type { Scope } from "./pod";

export interface ProjectResources {
  jira?: { project_keys?: string[]; team?: string };
  github?: { repos?: string[] };
  slack?: { channels?: string[] };
  confluence?: { space_keys?: string[] };
  git?: { repo_paths?: string[] };
  aliases?: string[];
}

export interface Project {
  project_id: string;
  name: string;
  description: string | null;
  created_at: string;
  resources?: ProjectResources;
}

/** Project-scoped context stream (no active pod). */
export interface ProjectContextUpdate {
  id: string;
  agent_id: string;
  timestamp: string;
  project_id: string;
  type: ContextUpdateType;
  scope: Scope;
  summary: string;
  details: string;
  artifacts: Artifact[];
  status: WorkStatus;
  blocks: string[];
  blocked_by: string[];
  needs_input_from: InputRequest[];
  quality_score?: number;
  source?: ContextUpdateSource;
}
