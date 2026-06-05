import type { Task } from "../../types.js";

/**
 * Real EMC PR replayed as an eval task.
 *
 * Provenance:
 *   Repo:    adobecom/EMC (local: /Users/rkhan/emcV2/EMC)
 *   PR:      #116 — "fix(series): modificationTime resilience and dashboard Series PUT bodies"
 *   Parent:  925a96cc360d8228917ec85b0ec068c2200c338b
 *   Merge:   c07859356c981eaf991b67599a16dc84855478ef
 *
 * Why this PR was chosen:
 *   - Surgical change to cachedApi.createSeries: when the create response
 *     returns a new seriesId, invalidate that per-series cache entry too
 *     (other series mutations already do this). The fix preserves
 *     modificationTime correctness in follow-up reads. Tests whether the
 *     model recognizes the symmetry with updateSeries / publishSeries.
 */

const SOURCE_FILE = `// web-src/src/services/api.ts — cachedApi.createSeries and neighbors at parent 925a96c

  // === MUTATIONS (with cache invalidation) ===

  // Series Mutations
  async createSeries(data: any) {
    const result = await apiService.createSeriesExternal(data)
    apiCache.invalidate('getSeriesList')
    return result
  },
  async updateSeries(seriesId: string, data: any) {
    const result = await apiService.updateSeriesExternal(seriesId, data)
    apiCache.invalidate(seriesId)
    apiCache.invalidate('getSeriesList')
    return result
  },
  async publishSeries(seriesId: string, data: any) {
    const result = await apiService.publishSeries(seriesId, data)
    apiCache.invalidate(seriesId)
    apiCache.invalidate('getSeriesList')
    return result
  },
  async unpublishSeries(seriesId: string, data: any) {
    const result = await apiService.unpublishSeries(seriesId, data)
    apiCache.invalidate(seriesId)
    apiCache.invalidate('getSeriesList')
    return result
  },
  async archiveSeries(seriesId: string, data: any) {
    const result = await apiService.archiveSeries(seriesId, data)
    apiCache.invalidate(seriesId)
    apiCache.invalidate('getSeriesList')
    return result
  },
`;

const ISSUE_TEXT = `fix(cachedApi.createSeries): invalidate the per-series cache entry when create returns a new seriesId.

When a series is created successfully, the caller often immediately reads
back the canonical series state (e.g., SeriesForm's create-then-publish
flow needs a fresh modificationTime). The other series mutations
(updateSeries, publishSeries, unpublishSeries, archiveSeries) already
invalidate apiCache for the affected seriesId. createSeries only
invalidates 'getSeriesList', so any stale per-id cache entry remains and
later reads can miss modificationTime.

Make createSeries also invalidate the per-series cache entry by seriesId
when the response is a success that includes a seriesId. Do not
invalidate if the response is an error.`;

const GROUND_TRUTH_PATCH = `--- a/web-src/src/services/api.ts
+++ b/web-src/src/services/api.ts
@@ -2467,6 +2467,12 @@ export const cachedApi = {
   async createSeries(data: any) {
     const result = await apiService.createSeriesExternal(data)
     apiCache.invalidate('getSeriesList')
+    if (result && typeof result === 'object' && !('error' in result)) {
+      const id = (result as { seriesId?: string }).seriesId
+      if (id) {
+        apiCache.invalidate(id)
+      }
+    }
     return result
   },
   async updateSeries(seriesId: string, data: any) {
`;

export const seriesModTimeResilience: Task = {
  id: "real-emc-series-mod-time-resilience",
  type: "content",
  podId: "pod-emc-sessions",
  asOf: "2026-04-06T08:55:07-07:00",
  tags: ["real-emc", "api", "cache", "series"],
  prompt: [
    "# Issue",
    ISSUE_TEXT,
    "",
    "# Current source (web-src/src/services/api.ts, parent commit 925a96c)",
    "```ts",
    SOURCE_FILE,
    "```",
    "",
    "# Output",
    "Return ONLY a unified diff (--- / +++ / @@) against `web-src/src/services/api.ts`. No prose, no full-file rewrite.",
  ].join("\n"),
  expectedSignals: ["createSeries", "apiCache.invalidate", "seriesId", "error"],
  groundTruth: {
    output: GROUND_TRUTH_PATCH,
    note: "adobecom/EMC PR #116, merge SHA c078593. Parent file at 925a96c.",
  },
  rubric: {
    id: "real-emc-series-mod-time-resilience-v1",
    criteria: [
      {
        id: "invalidates_by_series_id",
        description:
          "Does the patch call apiCache.invalidate with the seriesId returned by createSeriesExternal (matching the pattern updateSeries / publishSeries already use)? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "guards_against_error_response",
        description:
          "Does the patch avoid invalidating when the response is an error (e.g., checks `!('error' in result)` or equivalent) so a failed create does not blow away a valid per-series cache entry? Boolean.",
        scale: "boolean",
        weight: 1.5,
      },
      {
        id: "guards_against_missing_id",
        description:
          "Does the patch guard against a successful response that omits seriesId so we never call apiCache.invalidate(undefined)? Boolean.",
        scale: "boolean",
        weight: 1.5,
      },
      {
        id: "preserves_existing_invalidation",
        description:
          "Does the patch keep the existing `apiCache.invalidate('getSeriesList')` call and still return result unchanged? Boolean.",
        scale: "boolean",
        weight: 1,
      },
      {
        id: "matches_ground_truth_intent",
        description:
          "Compared to the reference patch, does the agent's diff achieve the same effect regardless of exact formatting? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "valid_unified_diff",
        description:
          "Is the output a parseable unified diff with --- / +++ / @@ headers and proper +/- prefixes (not prose, not a full-file rewrite)? Boolean.",
        scale: "boolean",
        weight: 1,
      },
      {
        id: "no_unrelated_changes",
        description:
          "Does the patch leave updateSeries, publishSeries, unpublishSeries, and archiveSeries untouched (the issue is only about createSeries)? Boolean.",
        scale: "boolean",
        weight: 1,
      },
    ],
  },
};
