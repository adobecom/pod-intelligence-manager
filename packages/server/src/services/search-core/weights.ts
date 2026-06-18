/**
 * Search ranking constants — single source of truth for both live
 * (context search) and indexed (project search) modes.
 *
 * The two modes use fundamentally different score scales:
 *
 * LIVE: scores are ~1–10+ (integer-ish authority + phrase + recency bonuses).
 *   Source authority alone is 1–6; an exact phrase match adds 3.
 *
 * INDEXED: scores are small floats dominated by RRF terms (1/(60+rank) ≈ 0.016
 *   for rank-1). Authority and recency are proportionally small (0.01–0.08).
 *
 * Keep the profiles separate until tests verify that numeric ordering is
 * identical to the pre-extraction baseline. Only collapse them once the
 * ranker integration tests pass at both call sites.
 */

// ── Live mode (context search) ──────────────────────────────────────────────

/** Per-source additive score bonus for live (context-search) ranking.
 *  Scale: 1–6. The KG ranks above all external sources — it is curated
 *  org memory, not a raw artifact.
 */
export const LIVE_SOURCE_AUTHORITY: Record<string, number> = {
  kg: 6,
  jira: 4,
  confluence: 4,
  github: 3,
  git: 3,
  slack: 2,
  fluffyjaws: 1,
};

/** Recency window for live scoring (milliseconds). Hits within this window
 *  receive a linear boost up to LIVE_RECENCY_MAX. */
export const LIVE_RECENCY_WINDOW_MS = 30 * 24 * 3_600_000; // 30 days

/** Maximum recency bonus for live mode. */
export const LIVE_RECENCY_MAX = 2.0;

// ── Indexed mode (project search) ───────────────────────────────────────────

/** Per-source additive score bonus for indexed (project-search) ranking.
 *  Scale: 0.01–0.05 — proportional to RRF scores (≈0.016 for rank-1).
 *  project_update and pod_update are project-internal sources.
 */
export const INDEXED_SOURCE_AUTHORITY: Record<string, number> = {
  /** KG nodes are curated org memory — ranked above raw artifact sources. */
  kg: 0.06,
  jira: 0.05,
  confluence: 0.05,
  github: 0.04,
  git: 0.04,
  project_update: 0.03,
  pod_update: 0.03,
  slack: 0.01,
};

/** Age threshold (days) for indexed recency boost. Hits older than this
 *  receive zero boost. */
export const INDEXED_RECENCY_DAYS = 30;

/** Maximum recency bonus for indexed mode. */
export const INDEXED_RECENCY_MAX = 0.08;

/** RRF constant — added to rank before taking the reciprocal.
 *  Typical value 60; reduces the score gap between rank-1 and rank-10. */
export const RRF_K = 60;

/** In-scope resource bonus: added when a document matches the project's
 *  configured Jira/GitHub/Confluence/Git resources. */
export const INDEXED_SCOPE_BONUS = 0.15;

/** In-scope resource bonus for live mode: returned by boostFor() when a
 *  hit URL/metadata matches configured project resources. */
export const LIVE_SCOPE_BONUS = 2;

/** KG curated-node bonus for live mode (added on top of kg authority). */
export const LIVE_KG_CURATED_BONUS = 2;
/** KG confidence score multiplier for live mode. */
export const LIVE_KG_CONFIDENCE_FACTOR = 1.5;
