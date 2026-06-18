/**
 * SearchDocument — the unified intermediate document shape shared by
 * context search (live fan-out) and project search (persisted index).
 *
 * Connectors produce `SearchDocument`s; the live ranker consumes them
 * directly; the indexed write path feeds them into `indexProjectDocument`.
 *
 * Design invariants:
 * - `org_id` is always set so ranking and storage can never cross org boundaries.
 * - `project_id` is set only for project-scoped (indexed-mode) documents.
 * - `source_type` captures the sub-type within a source (e.g. "release",
 *   "merged_pr", "backlog_issue") — present for indexed sources, optional
 *   for live sources that don't distinguish sub-types.
 * - `freshness_state` is indexed-mode only; live documents are always "fresh"
 *   by construction (they were just fetched).
 *
 * Phase 2 will migrate connector return types from `ContextSearchHit` to
 * `SearchDocument`. Until then this type is purely additive — nothing depends
 * on it yet.
 */

import type { ProjectSearchFreshness } from "./project-search.js";

/** All sources that can appear in a SearchDocument. Superset of
 *  ContextSource (adds project_update, pod_update) and
 *  ProjectSearchSource (adds kg, fluffyjaws). */
export type SearchDocumentSource =
  | "kg"
  | "slack"
  | "fluffyjaws"
  | "jira"
  | "confluence"
  | "github"
  | "git"
  | "project_update"
  | "pod_update";

export interface SearchDocument {
  // ── scope (always required; project_id only for indexed mode) ──────────
  org_id: string;
  project_id?: string;

  // ── provenance ──────────────────────────────────────────────────────────
  /** High-level source system. */
  source: SearchDocumentSource;
  /** Sub-type within the source (e.g. "release", "merged_pr", "backlog_issue").
   *  Indexed-mode connectors always supply this; live-mode connectors may omit. */
  source_type?: string;
  /** Native artifact id (Jira key, "owner/repo#123", commit SHA, page title…). */
  source_id: string;
  source_url?: string;

  // ── content ─────────────────────────────────────────────────────────────
  title: string;
  /** Short text excerpt / preview used for ranking and display. */
  snippet: string;
  author?: string;
  /** ISO 8601 timestamp of the artifact (creation or last update). Used for recency. */
  timestamp?: string;
  status?: string;

  // ── metadata ────────────────────────────────────────────────────────────
  metadata?: Record<string, unknown>;

  // ── indexed-mode lifecycle ───────────────────────────────────────────────
  /** Lifecycle of the document relative to its upstream source. Absent (or
   *  "unknown") for live-fetched documents, which are always fresh by definition. */
  freshness_state?: ProjectSearchFreshness;
}
