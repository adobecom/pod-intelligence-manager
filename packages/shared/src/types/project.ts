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
    /** Jira components to scope to (e.g. ["Events Tier 3"]) — narrows a large shared project. */
    components?: string[];
    epics?: string[];
    issue_keys?: string[];
    fix_versions?: string[];
    /** Version-name prefixes whose releases to ingest (e.g. ["T3-"]). */
    version_prefixes?: string[];
    /** Only ingest tickets updated within this many days (keeps the index current + bounded). */
    lookback_days?: number;
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
  git?: {
    repo_paths?: string[];
    lookback_days?: number;
  };
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

/** Visibility admitted by the project evidence ingestion spine. Connectors may
 * report `restricted`/`unknown`, but only `project_visible` evidence is stored. */
export type ProjectEvidenceVisibility = "project_visible" | "restricted" | "unknown";

/** Sources with user-configurable project bindings and operational sync state. */
export type ProjectSourceHealthSource = "github" | "jira" | "slack" | "confluence" | "git";

/** Connector behavior that is implemented today, rather than aspirational
 * registry metadata. Used by connector tests and operational tooling. */
export interface ProjectSourceCapabilities {
  pagination: "cursor" | "server_next_url" | "none";
  overlap_window: boolean;
  deletion_reconciliation: boolean;
  source_versions: boolean;
  visibility: "project_visible_only";
}

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
  /** Stable upstream instance (for example a Slack workspace or Confluence site). */
  source_instance?: string;
  /** Native identifier within `source_instance`. */
  native_id?: string;
  /** Upstream version/etag, independent of the redacted content hash. */
  source_version?: string;
  visibility?: ProjectEvidenceVisibility;
  visibility_version?: string;
  redaction_version?: string;
  normalized_content_hash?: string;
  source_updated_at?: string;
}

export interface ProjectSourceChangeEvidence {
  source_type: string;
  source_url?: string;
  source_title: string;
  summary: string;
  body: string;
  author?: string;
  metadata?: Record<string, unknown>;
  confidence_score: number;
  promotable?: boolean;
}

interface ProjectSourceChangeBase {
  org_id: string;
  project_id: string;
  source: ProjectEvidenceSource;
  source_instance: string;
  native_id: string;
  source_version?: string;
  visibility: ProjectEvidenceVisibility;
  visibility_version?: string;
  occurred_at?: string;
  updated_at?: string;
  operational_metadata?: Record<string, unknown>;
}

/** Minimal cursor-driven connector contract. Delete changes carry identifiers
 * only, so ineligible or removed content never needs to cross persistence. */
export type ProjectSourceChange =
  | (ProjectSourceChangeBase & { kind: "upsert"; evidence: ProjectSourceChangeEvidence })
  | (ProjectSourceChangeBase & { kind: "delete"; evidence?: never });

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
  source: ProjectSourceHealthSource;
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
  /** Per-binding routing watermarks; keys contain source-native IDs only. */
  cursor_watermarks?: Record<string, string>;
  source_instance?: string;
  last_attempt_at?: string;
  last_success_at?: string;
  last_reconciliation_at?: string;
  lag_seconds?: number;
  indexed_count?: number;
  retry_count?: number;
  last_error_code?: string;
  message?: string;
}

/** Durable operational state. Cursors remain in `project_ingestion_cursors`;
 * this record describes whether consuming those cursors is healthy. */
export interface ProjectSourceSyncState {
  org_id: string;
  project_id: string;
  source: ProjectSourceHealthSource;
  source_instance: string;
  last_attempt_at?: string;
  last_success_at?: string;
  last_reconciliation_at?: string;
  lag_seconds?: number;
  indexed_count: number;
  retry_count: number;
  last_error_code?: string;
  last_error_message?: string;
  updated_at: string;
}
