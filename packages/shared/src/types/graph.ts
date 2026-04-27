import type { Scope } from "./pod";

// --- Node Types ---

export type KnowledgeNodeType =
  | "decision"
  | "pattern"
  | "anti_pattern"
  | "resolved_conflict"
  | "scope_insight";

export type ConfidenceLevel = "extracted" | "inferred";

export interface KnowledgeNode {
  id: string;
  type: KnowledgeNodeType;
  summary: string;
  details: string;
  source_pod_id: string;
  source_pod_name: string;
  /** When set, this node is also attributable to a long-lived project (e.g. off-pod updates). */
  source_project_id?: string;
  source_project_name?: string;
  domains: string[];
  confidence: ConfidenceLevel;
  confidence_score: number; // 0.0–1.0
  created_at: string;
  curated: boolean; // false = auto-extracted, true = human-approved
  community_id?: string;
  /** Set when a newer node with a `supersedes` edge points to this one. Superseded nodes are excluded from queries by default. */
  superseded_by?: string;
  /** Titan Text Embeddings v2 vector; absent on nodes created before embedding backfill. */
  embedding?: number[];
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
  confidence_min?: number;
  curated_only?: boolean;
  /** When false (default), nodes with `superseded_by` set are excluded. Pass true to include them. */
  include_superseded?: boolean;
  /** Substring filter on summary + details (unchanged behavior). */
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
}

export interface KnowledgeQueryResult {
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  total_matching: number;
  token_estimate: number;
  truncated: boolean;
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
  domains: string[];
  confidence: ConfidenceLevel;
  confidence_score: number;
}

// --- Curation ---

export type CurationAction = "approve" | "reject" | "edit";

export interface CurationRequest {
  action: CurationAction;
  edits?: Partial<Pick<KnowledgeNode, "summary" | "details" | "domains">>;
}
