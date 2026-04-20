import type {
  ContextUpdateType,
  WorkStatus,
  Artifact,
  InputRequest,
  ContextUpdateSource,
} from "./context-update";
import type { Scope } from "./pod";

/** External data-source endpoints a project pulls from (Jira, GitHub, etc.).
 * Used by context-search to scope fan-out; independent of team composition. */
export interface ProjectResources {
  jira?: { project_keys?: string[]; team?: string };
  github?: { repos?: string[] };
  slack?: { channels?: string[] };
  confluence?: { space_keys?: string[] };
  git?: { repo_paths?: string[] };
  aliases?: string[];
}

/** Internal initiative owners; each row references an org scope id. */
export interface ProjectAnatomyInternalSlot {
  scope_id: string;
}

/** External dependency or collaborator team; role is free text. */
export interface ProjectAnatomyExternalTeam {
  name: string;
  role: string;
  notes?: string;
}

export interface ProjectAnatomy {
  internal: ProjectAnatomyInternalSlot[];
  external: ProjectAnatomyExternalTeam[];
}

export const EMPTY_PROJECT_ANATOMY: ProjectAnatomy = {
  internal: [],
  external: [],
};

export interface Project {
  project_id: string;
  name: string;
  description: string | null;
  created_at: string;
  anatomy: ProjectAnatomy;
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
