import type { Artifact } from "./context-update.js";
import type { MemoryEntityRef, RetrievalTier, TemporalQueryMode } from "./memory.js";
import type { KgContextContractMode } from "./org-settings.js";
import type { Scope } from "./pod.js";

// --- Node Types ---

export type KnowledgeNodeType =
  | "decision"
  | "pattern"
  | "anti_pattern"
  | "resolved_conflict"
  | "scope_insight";

export type ConfidenceLevel = "extracted" | "inferred";

/** Provenance for nodes not produced by pod archival or a single ad-hoc human submission. */
export type KnowledgeIngestionProvenanceKind = "scheduled_synthesis" | "project_evidence" | "agent_run";

export interface KnowledgeIngestionProvenance {
  kind: KnowledgeIngestionProvenanceKind;
  run_id: string;
  model: string;
  /** Existing graph nodes cited as evidence (must be valid ids at ingest time). */
  evidence_node_ids: string[];
  lint_finding_ids?: string[];
  /** Project working-memory evidence ids cited for a promoted node. */
  evidence_item_ids?: string[];
}

export type KnowledgeAudience = "org" | "project" | "pod";

export interface KnowledgeProvenance {
  source: string;
  source_id?: string;
  title?: string;
  url?: string;
  occurred_at?: string;
  evidence_item_id?: string;
}

export interface KnowledgeNode {
  id: string;
  type: KnowledgeNodeType;
  summary: string;
  details: string;
  /** Retrieval-optimized expanded text. Display surfaces should keep using summary/details. */
  retrieval_text?: string;
  /** Resolved entities mentioned by or attributable to this node. */
  entity_refs?: MemoryEntityRef[];
  source_pod_id: string;
  source_pod_name: string;
  /** When set, this node is also attributable to a long-lived project (e.g. off-pod updates). */
  source_project_id?: string;
  source_project_name?: string;
  audience?: KnowledgeAudience;
  provenance?: KnowledgeProvenance[];
  /** Canonical org/project scope tags used for retrieval. `domains` remains a legacy alias during migration. */
  scopes?: string[];
  /** Topic tags used as a lightweight retrieval/explanation dimension. */
  topics?: string[];
  /** Legacy compatibility output. Prefer `scopes` for new callers. */
  domains: string[];
  confidence: ConfidenceLevel;
  confidence_score: number; // 0.0–1.0
  created_at: string;
  curated: boolean; // false = auto-extracted, true = human-approved
  community_id?: string;
  /** Set when a newer node with a `supersedes` edge points to this one. Superseded nodes are excluded from queries by default. */
  superseded_by?: string;
  retention_score?: number;
  retrieval_tier?: RetrievalTier;
  retrieval_count?: number;
  last_retrieved_at?: string;
  /** Titan Text Embeddings v2 vector; absent on nodes created before embedding backfill. */
  embedding?: number[];
  /** SHA-256 of the exact text used to produce `embedding`; missing or mismatched means the vector is stale. */
  embedding_text_hash?: string;
  /** Optional audit trail for scheduled synthesis or future system ingestors. */
  ingestion_provenance?: KnowledgeIngestionProvenance;
}

// --- Edge Types ---

export type KnowledgeEdgeType =
  | "relates_to"
  | "supersedes"
  | "contradicts"
  | "builds_on"
  | "resolved_by";

export interface KnowledgeEdge {
  source: string;
  target: string;
  type: KnowledgeEdgeType;
  weight: number; // 0.0–1.0
  valid_from?: string;
  valid_until?: string;
  source_update_refs?: string[];
  artifact_refs?: Artifact[];
  reason?: string;
  confidence_score?: number;
  inferred?: boolean;
}

// --- Community / Cluster ---

export interface CommunitySummary {
  id: string;
  label: string;
  node_count: number;
  top_domains: string[];
  summary: string;
}

// --- Full Graph ---

export interface KnowledgeGraph {
  version: number;
  org_id: string;
  updated_at: string;
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  communities: CommunitySummary[];
}

// --- Query Types ---

export interface KnowledgeQueryFilters {
  /** Canonical retrieval scope tags. */
  scopes?: string[];
  /** Topic tags to filter or explain retrieval matches. */
  topics?: string[];
  /** Legacy alias for `scopes`; still accepted and returned during migration. */
  domains?: string[];
  types?: KnowledgeNodeType[];
  source_pod_ids?: string[];
  /** When set, only nodes whose `source_project_id` is in this list. */
  source_project_ids?: string[];
  /**
   * When set with domain filters: include org-wide nodes (no `source_project_id`) and nodes
   * tagged with this project; exclude nodes tagged with other projects.
   */
  include_project_id?: string;
  /** Minimum confidence score. queryKnowledge defaults to 0.7 when omitted (matches ad-hoc submission default). */
  confidence_min?: number;
  curated_only?: boolean;
  /** When false (default), nodes with `superseded_by` set are excluded. Pass true to include them. */
  include_superseded?: boolean;
  retrieval_tiers?: RetrievalTier[];
  /** Word-level filter via the keyword index (summary + details tokenized; not substring). */
  text_search?: string;
  /**
   * Terms for relevance scoring only (does not filter candidates).
   * Merged with tokens derived from `text_search` for ranking.
   */
  keywords?: string[];
}

export interface KnowledgeQueryOptions {
  filters: KnowledgeQueryFilters;
  max_tokens?: number;
  include_details?: boolean;
  include_edges?: boolean;
  limit?: number;
  /** Pre-computed query embedding for hybrid semantic+keyword scoring. */
  query_embedding?: number[] | null;
  /**
   * Free-text query the server will embed for semantic scoring. Convenience when
   * the caller doesn't have access to an embedding provider. Ignored if
   * `query_embedding` is supplied.
   */
  query_text?: string;
  /**
   * When true, each returned node includes the stored `embedding` vector (large).
   * Default false — embeddings are for server-side scoring only; omit them for token-efficient agent/API responses.
   */
  include_embeddings?: boolean;
  query_mode?: TemporalQueryMode;
  /** ISO timestamp required when `query_mode` is `as_of`; optional hint for temporal ranking otherwise. */
  as_of?: string;
  /** Defaults true for text/temporal queries; false disables one-hop graph expansion. */
  expand_graph?: boolean;
  /** Include compact retrieval explanations for each returned node. */
  include_explanations?: boolean;
  /** Internal/shadow-mode switch: false avoids counting candidate-only retrievals as delivered context. */
  record_retrievals?: boolean;
}

export interface KnowledgeRetrievalExplanation {
  node_id: string;
  strength: "must_follow" | "avoid" | "related";
  matched_scopes: string[];
  matched_topics: string[];
  semantic_score?: number;
  graph_expanded?: boolean;
}

export interface KnowledgeContextContractInfo {
  mode: KgContextContractMode;
  returned_mode: "legacy" | "task_relevant";
  task_query_used: boolean;
  possible_constraints?: boolean;
  note?: string;
}

export interface KnowledgeQueryResult {
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  total_matching: number;
  token_estimate: number;
  truncated: boolean;
  query_mode?: TemporalQueryMode;
  as_of?: string;
  explanations?: KnowledgeRetrievalExplanation[];
  context_contract?: KnowledgeContextContractInfo;
  /** Prompt-ready summary-only KG context for task-query retrieval. */
  compact_context?: string;
  /** Number of KG nodes rendered into compact_context before character clipping. */
  compact_context_node_count?: number;
}

// --- Stats ---

export interface KnowledgeStats {
  total_nodes: number;
  total_edges: number;
  total_communities: number;
  nodes_by_type: Record<KnowledgeNodeType, number>;
  nodes_by_confidence: Record<ConfidenceLevel, number>;
  top_domains: string[];
  updated_at: string | null;
}

// --- Enhanced Learning (output of extraction pipeline) ---

export interface EnhancedPodLearning {
  type: KnowledgeNodeType;
  summary: string;
  details: string;
  retrieval_text?: string;
  entity_refs?: MemoryEntityRef[];
  scopes?: string[];
  topics?: string[];
  /** Legacy alias for `scopes`; still required by older callers during migration. */
  domains: string[];
  confidence: ConfidenceLevel;
  confidence_score: number;
  audience?: KnowledgeAudience;
  provenance?: KnowledgeProvenance[];
  /** When set, persisted on the created `KnowledgeNode` (e.g. scheduled graph synthesis). */
  ingestion_provenance?: KnowledgeIngestionProvenance;
}

// --- Curation ---

export type CurationAction = "approve" | "reject" | "edit";

export interface CurationRequest {
  action: CurationAction;
  edits?: Partial<Pick<KnowledgeNode, "summary" | "details" | "domains">>;
}

// --- Ad-Hoc Submission ---

/**
 * Input for the explicit ad-hoc learning submission API. Use this for confirmed
 * learnings outside an active pod (bug fixes, chatbot/agent conversations, etc.).
 * Submitted nodes enter the curation queue (`curated: false`).
 */
export interface AdHocLearningInput {
  type: KnowledgeNodeType;
  summary: string;
  details: string;
  domains: string[];
  scopes?: string[];
  /** Free-text label that becomes `source_pod_name` for traceability (e.g., chatbot/session id). */
  source_label?: string;
  /** Defaults to 0.7 server-side. */
  confidence_score?: number;
}
