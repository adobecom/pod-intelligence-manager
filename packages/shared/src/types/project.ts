import type {
  ContextUpdateType,
  WorkStatus,
  Artifact,
  InputRequest,
  ContextUpdateSource,
} from "./context-update.js";
import type { Scope } from "./pod.js";
import type { KnowledgeNodeType } from "./graph.js";
import type { MemoryEntityRef } from "./memory.js";

/** Project-local vocabulary used to expand searches and Project Answers queries. */
export interface ProjectGlossaryTerm {
  term: string;
  definition?: string;
  aliases?: string[];
}

/** External data-source endpoints a project pulls from (Jira, GitHub, etc.).
 * Used by context-search, ingestion, and Project Answers to scope fan-out;
 * independent of team composition. Kept JSON-compatible with the original
 * resources_json shape: older payloads remain valid subsets of this profile. */
export interface ProjectResources {
  jira?: {
    project_keys?: string[];
    team?: string;
    epics?: string[];
    issue_keys?: string[];
    fix_versions?: string[];
  };
  github?: {
    repos?: string[];
    default_branches?: Record<string, string>;
  };
  slack?: {
    channels?: string[];
    /** Explicit Slack thread permalinks. V1 ingestion never crawls Slack broadly. */
    thread_urls?: string[];
  };
  confluence?: {
    space_keys?: string[];
    page_ids?: string[];
    page_urls?: string[];
  };
  git?: { repo_paths?: string[] };
  aliases?: string[];
  glossary?: ProjectGlossaryTerm[];
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
  retrieval_text?: string;
  entity_refs?: MemoryEntityRef[];
  artifacts: Artifact[];
  status: WorkStatus;
  blocks: string[];
  blocked_by: string[];
  needs_input_from: InputRequest[];
  quality_score?: number;
  source?: ContextUpdateSource;
}

export type ProjectEvidenceSource =
  | "github"
  | "jira"
  | "slack"
  | "project_update"
  | "commit"
  | "confluence";

export interface ProjectEvidenceItem {
  id: string;
  org_id: string;
  project_id: string;
  source: ProjectEvidenceSource;
  source_type: string;
  source_id: string;
  source_url?: string;
  source_title: string;
  summary: string;
  body: string;
  author?: string;
  occurred_at: string;
  ingested_at: string;
  metadata: Record<string, unknown>;
  confidence_score: number;
  promotable: boolean;
  promoted_node_id?: string;
}

export type ProjectMemoryCandidateStatus = "pending" | "promoted" | "rejected";

export interface ProjectMemoryCandidate {
  id: string;
  org_id: string;
  project_id: string;
  evidence_item_id: string;
  type: KnowledgeNodeType;
  summary: string;
  details: string;
  domains: string[];
  confidence_score: number;
  source: ProjectEvidenceSource;
  status: ProjectMemoryCandidateStatus;
  created_at: string;
  reviewed_at?: string;
  promoted_node_id?: string;
}

export interface ProjectIngestionCursor {
  org_id: string;
  project_id: string;
  source: ProjectEvidenceSource;
  cursor_key: string;
  cursor_value: string;
  updated_at: string;
}

export type ProjectAnswerIntent =
  | "status"
  | "decision"
  | "blocker"
  | "timeline"
  | "qa_focus"
  | "explanation"
  | "ownership"
  | "risk";

export interface ProjectAnswerRequest {
  query: string;
  include_raw_hits?: boolean;
}

export interface ProjectAnswerCitation {
  id: string;
  source: ProjectEvidenceSource | "kg" | "project_update" | "pod_update";
  title: string;
  url?: string;
  timestamp?: string;
}

export interface ProjectAnswerRawHit {
  id: string;
  source: ProjectAnswerCitation["source"];
  title: string;
  snippet: string;
  url?: string;
  timestamp?: string;
  confidence_score?: number;
}

export interface ProjectAnswerUnavailableSource {
  source: "project_evidence" | "project_kg" | "project_updates";
  reason: string;
}

export interface ProjectAnswerResponse {
  intent: ProjectAnswerIntent;
  answer_markdown: string;
  confidence: number;
  citations: ProjectAnswerCitation[];
  sources_used: Array<"project_evidence" | "project_kg" | "project_updates">;
  unavailable_sources: ProjectAnswerUnavailableSource[];
  collapsed_raw_hits: ProjectAnswerRawHit[];
}

export interface ProjectSourceHealth {
  source: "github" | "jira" | "slack" | "confluence" | "git";
  configured: boolean;
  credential_state:
    | "ok"
    | "missing_credentials"
    | "invalid_credentials"
    | "unreachable"
    | "misconfigured"
    | "not_required"
    | "not_configured";
  configured_items: number;
  last_ingested_at?: string;
  cursor_count: number;
  message?: string;
}
