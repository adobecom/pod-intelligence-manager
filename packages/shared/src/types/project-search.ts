/**
 * Indexed Project Search — types for the hybrid (lexical + semantic) search
 * layer over current project artifacts, plus the mind-map entity/edge layer.
 *
 * This layer is deliberately distinct from the org knowledge graph: it indexes
 * raw, current project artifacts (tickets, PRs, commits, docs, updates) so
 * agents and humans can ask "where is this discussed / implemented / blocked?".
 * Only durable, promoted learnings flow into the KG (see project-memory).
 */

/** Where a search document originated. Broader than ProjectEvidenceSource. */
export type ProjectSearchSource =
  | "jira"
  | "github"
  | "confluence"
  | "slack"
  | "git"
  | "project_update"
  | "pod_update"
  /** Durable org-KG nodes persisted into the project index for ranking alongside artifacts. */
  | "kg";

export const PROJECT_SEARCH_SOURCES: ProjectSearchSource[] = [
  "jira",
  "github",
  "confluence",
  "slack",
  "git",
  "project_update",
  "pod_update",
  "kg",
];

/** Lifecycle of an indexed document relative to its upstream source. */
export type ProjectSearchFreshness = "fresh" | "stale" | "deleted" | "unknown";

/** What part of a document a chunk represents. */
export type ProjectSearchChunkKind =
  | "title"
  | "body"
  | "comment"
  | "code"
  | "summary"
  | "metadata";

/** One indexed source artifact. */
export interface ProjectSearchDocument {
  id: string;
  org_id: string;
  project_id: string;
  source: ProjectSearchSource;
  source_type: string;
  source_id: string;
  source_url?: string;
  title: string;
  author?: string;
  status?: string;
  occurred_at?: string;
  ingested_at: string;
  updated_at: string;
  content_hash: string;
  metadata: Record<string, unknown>;
  permissions: Record<string, unknown>;
  freshness_state: ProjectSearchFreshness;
  source_instance?: string;
  native_id?: string;
  source_version?: string;
  visibility?: import("./project.js").ProjectEvidenceVisibility;
  visibility_version?: string;
  redaction_version?: string;
  normalized_content_hash?: string;
  source_updated_at?: string;
}

/** One searchable text chunk belonging to a document. */
export interface ProjectSearchChunk {
  id: string;
  document_id: string;
  org_id: string;
  project_id: string;
  chunk_index: number;
  chunk_kind: ProjectSearchChunkKind;
  text: string;
  retrieval_text?: string;
  embedding?: number[];
  embedding_model?: string;
  embedding_text_hash?: string;
  token_estimate: number;
  created_at: string;
}

/** Mind-map node extracted from documents. */
export type ProjectSearchEntityType =
  | "ticket"
  | "pr"
  | "commit"
  | "file"
  | "symbol"
  | "person"
  | "doc"
  | "feature"
  | "decision"
  | "risk"
  | "blocker";

export interface ProjectSearchEntity {
  id: string;
  org_id: string;
  project_id: string;
  entity_type: ProjectSearchEntityType;
  entity_key: string;
  label: string;
  aliases: string[];
  source_document_id?: string;
  metadata: Record<string, unknown>;
  first_seen_at: string;
  last_seen_at: string;
}

/** Mind-map relationship extracted from documents. */
export type ProjectSearchEdgeType =
  | "mentions"
  | "implements"
  | "fixes"
  | "blocks"
  | "owns"
  | "touches"
  | "defines"
  | "imports"
  | "calls"
  | "discusses"
  | "supersedes"
  | "linked_to"
  | "cites_kg";

export interface ProjectSearchEdge {
  id: string;
  org_id: string;
  project_id: string;
  source_entity_id: string;
  target_entity_id: string;
  edge_type: ProjectSearchEdgeType;
  evidence_document_id?: string;
  confidence_score: number;
  created_at: string;
}

/** Query request for POST /api/projects/:projectId/search. */
export interface ProjectSearchRequest {
  query: string;
  sources?: ProjectSearchSource[];
  entity_types?: ProjectSearchEntityType[];
  time_window_days?: number;
  include_kg?: boolean;
  include_mind_map?: boolean;
  /** Use the project entity graph for bounded query-time expansion and explanations (default true). */
  graph_expansion?: boolean;
  max_hits?: number;
  /** Produce a plain-language, cited summary answer over the hits (LLM; default false). */
  synthesize?: boolean;
  /** Fall back to live connector fan-out when the index returns no candidates.
   *  Default false. Requires PROJECT_SEARCH_LIVE_FALLBACK=1 env flag on the server. */
  use_live?: boolean;
}

/** Why a hit surfaced — useful for explaining ranking. */
export interface ProjectSearchMatch {
  identifier?: boolean;
  lexical?: boolean;
  semantic?: boolean;
  graph?: boolean;
  in_scope_resource?: boolean;
}

export interface ProjectSearchHit {
  document_id: string;
  chunk_id?: string;
  source: ProjectSearchSource;
  source_type: string;
  /** Native artifact id (Jira key, owner/repo#n, release:KEY:name, update id). */
  source_id: string;
  title: string;
  snippet: string;
  url?: string;
  author?: string;
  occurred_at?: string;
  status?: string;
  freshness: ProjectSearchFreshness;
  score: number;
  lexical_score?: number;
  semantic_score?: number;
  graph_score?: number;
  matched: ProjectSearchMatch;
}

/** A KG node attached as a durable overlay on top of project artifacts. */
export interface ProjectSearchKgHit {
  id: string;
  type: string;
  summary: string;
  snippet: string;
  confidence_score: number;
  curated?: boolean;
  url: string;
}

export interface ProjectSearchAnswerCitation {
  ref: string;
  source: ProjectSearchSource | "kg";
  title: string;
  url?: string;
}

export interface ProjectSearchFocusFeature {
  entity_id: string;
  entity_key: string;
  label: string;
  members: Array<{
    entity_id: string;
    entity_type: ProjectSearchEntityType;
    entity_key: string;
    label: string;
    edge_type: ProjectSearchEdgeType;
    confidence_score: number;
    source_document_id?: string;
  }>;
}

/** A small entity-edge neighborhood for the mind map. */
export interface ProjectSearchMindMap {
  entities: Array<
    Pick<ProjectSearchEntity, "id" | "entity_type" | "entity_key" | "label" | "source_document_id" | "metadata">
  >;
  edges: Array<Pick<ProjectSearchEdge, "source_entity_id" | "target_entity_id" | "edge_type" | "confidence_score">>;
}

export interface ProjectSearchResponse {
  query: string;
  project_id: string;
  project_name?: string;
  /** Plain-language, cited answer synthesized over the hits (present when synthesize=true and an LLM is available). */
  summary_md?: string;
  /** Citation lookup for refs used in `summary_md` (for example `K1`, `MWPW-123`, `PR #42`). */
  answer_citations?: ProjectSearchAnswerCitation[];
  hits: ProjectSearchHit[];
  kg_overlay?: ProjectSearchKgHit[];
  focus_feature?: ProjectSearchFocusFeature;
  mind_map?: ProjectSearchMindMap;
  sources_used: ProjectSearchSource[];
  documents_by_source: Partial<Record<ProjectSearchSource, number>>;
  detected_identifiers: string[];
  /** Fraction (0..1) of candidate chunks that carried an embedding at query time. */
  embedding_coverage: number;
  retrieval_mode: "lexical" | "hybrid";
  total_documents: number;
  /** Operational status for each project-bound source at query time. */
  source_health: import("./project.js").ProjectSourceHealth[];
  generated_at: string;
}

/** Result of (re)building / refreshing a project's search index. */
export interface ProjectSearchIndexStats {
  project_id: string;
  documents_indexed: number;
  chunks_indexed: number;
  entities_indexed: number;
  edges_indexed: number;
  chunks_embedded: number;
  embedding_available: boolean;
  complete: boolean;
  skipped_ineligible: number;
  failed_rows: number;
  failures: Array<{ row_id: string; source: string; code: string }>;
}
