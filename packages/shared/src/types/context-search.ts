// Context search — cross-source query across the org knowledge graph,
// Slack, Fluffyjaws, Jira, Confluence, GitHub, and local git. Executed
// server-side by /api/context-search; surfaced via the context_search MCP
// tool, PimClient.searchContext, and the `pim search` CLI.
//
// "kg" (knowledge graph) is the org's persistent learning memory and is
// the first source of truth: every fan-out queries it before reaching out
// to external systems, and its hits rank above all other sources.

export type ContextSource =
  | "kg"
  | "slack"
  | "fluffyjaws"
  | "jira"
  | "confluence"
  | "github"
  | "git";

export const CONTEXT_SOURCES: ContextSource[] = [
  "kg",
  "slack",
  "fluffyjaws",
  "jira",
  "confluence",
  "github",
  "git",
];

export interface ContextSearchActor {
  email?: string;
  slack_user_id?: string;
  github_login?: string;
  display_name?: string;
}

export interface ContextSearchRequest {
  query: string;
  sources?: ContextSource[];
  pod_id?: string;
  project_id?: string;
  actor?: ContextSearchActor;
  time_window_days?: number;
  max_hits_per_source?: number;
  synthesize?: boolean;
  use_cache?: boolean;
}

export interface ContextSearchHit {
  source: ContextSource;
  title: string;
  url?: string;
  snippet: string;
  author?: string;
  timestamp?: string;
  metadata?: Record<string, unknown>;
}

export interface ContextSearchMissingSource {
  source: ContextSource;
  reason: string;
}

export interface ContextSearchResult {
  query: string;
  /** Project the search was scoped to, if any. Populated whether the
   * project came from an explicit project_id, a pod lookup, or
   * query-text detection against name/aliases. */
  project_id?: string;
  project_name?: string;
  /** Actor the search was scoped to, if one was resolved (explicit or
   * auto-detected from the query text). */
  actor?: ContextSearchActor;
  summary_md?: string;
  hits: ContextSearchHit[];
  sources_used: ContextSource[];
  missing_sources: ContextSearchMissingSource[];
  from_cache: boolean;
  cached_at?: string;
  generated_at: string;
}
