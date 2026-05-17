import type { Task } from "../types.js";

/**
 * Real EMC PR replayed — anti-pattern case.
 *
 * Provenance:
 *   Repo:   adobecom/EMC
 *   PR:     #137 — "fix(api): omit read-only targetCms on ESP series PUT"
 *   Tip:    e7bc152
 *   Parent: 82f6dac
 *   Merge:  cd1892d
 *
 * Why this PR for the eval:
 *   - The "tempting wrong" pattern is the current code: spread `seriesData`
 *     straight into the PUT body. It compiles, looks reasonable, but echoes
 *     read-only fields (targetCms) back to ESP and fails readOnly.openapi.validation.
 *   - Right answer: filter `seriesData` through the existing
 *     `filterSeriesData(data, 'update')` helper (or add a thin wrapper). This is
 *     a "house style" decision — same fix shape is already used elsewhere
 *     (SeriesForm edits, `prepareEslEventPutPayload` for events).
 *   - Issue text mentions the symptom (readOnly validation error) but the agent
 *     must know that filtering before PUT is the team's pattern.
 *
 * The PR also adds `prepareEspSeriesPutPayload` to dataFilters.ts. We give that
 * helper as a hint in the prompt so the eval focuses on "did you apply the fix
 * to the right four methods" rather than "did you invent the helper from scratch."
 */

const SOURCE_FILE = `// web-src/src/services/api.ts (excerpt)
// Existing import (at the top of the file):
import { prepareEslEventPutPayload } from '../utils/dataFilters'

// ...

class ApiService {
  // ...

  async updateSeriesExternal(seriesId: string, seriesData: any): Promise<any | ErrorResponse> {
    validateString(seriesId, 'series ID')
    validateObject(seriesData, 'series data')
    return this.callExternalApi('esp', \`/v1/series/\${seriesId}\`, 'PUT',
      { ...seriesData, seriesId },
      { operationName: \`updateSeries(\${seriesId})\`, shouldReturnFullResponse: true }
    )
  }

  async publishSeries(seriesId: string, seriesData: any): Promise<any | ErrorResponse> {
    validateString(seriesId, 'series ID')
    validateObject(seriesData, 'series data')
    return this.callExternalApi('esp', \`/v1/series/\${seriesId}\`, 'PUT',
      { ...seriesData, seriesId, seriesStatus: 'published' },
      { operationName: \`publishSeries(\${seriesId})\`, shouldReturnFullResponse: true }
    )
  }

  async unpublishSeries(seriesId: string, seriesData: any): Promise<any | ErrorResponse> {
    validateString(seriesId, 'series ID')
    validateObject(seriesData, 'series data')
    return this.callExternalApi('esp', \`/v1/series/\${seriesId}\`, 'PUT',
      { ...seriesData, seriesId, seriesStatus: 'draft' },
      { operationName: \`unpublishSeries(\${seriesId})\`, shouldReturnFullResponse: true }
    )
  }

  async archiveSeries(seriesId: string, seriesData: any): Promise<any | ErrorResponse> {
    validateString(seriesId, 'series ID')
    validateObject(seriesData, 'series data')
    return this.callExternalApi('esp', \`/v1/series/\${seriesId}\`, 'PUT',
      { ...seriesData, seriesId, seriesStatus: 'archived' },
      { operationName: \`archiveSeries(\${seriesId})\`, shouldReturnFullResponse: true }
    )
  }
}
`;

const ISSUE_TEXT = `Series PUT requests are failing readOnly.openapi.validation

Dashboard unpublish/archive flows echo full GET responses back on PUT and
trip ESP's OpenAPI read-only validator. Fix the four series PUT call sites
(updateSeriesExternal, publishSeries, unpublishSeries, archiveSeries) so
read-only fields are stripped before the request body is sent.

Note: a helper \`prepareEspSeriesPutPayload(seriesData)\` is available in
\`'../utils/dataFilters'\` that wraps \`filterSeriesData\` in 'update' mode
(non-updatable fields omitted) — same approach already used for events
via \`prepareEslEventPutPayload\`.`;

const GROUND_TRUTH_PATCH = `--- a/web-src/src/services/api.ts
+++ b/web-src/src/services/api.ts
@@ -24,7 +24,7 @@ import { getCurrentEnvironment, getApiHost, SUPPORTED_CLOUDS } from '../config/c
 import { env } from '../config/env'
 import { apiCache } from './cacheUtils'
 import { deduplicateBy } from '../utils/deduplication'
-import { prepareEslEventPutPayload } from '../utils/dataFilters'
+import { prepareEslEventPutPayload, prepareEspSeriesPutPayload } from '../utils/dataFilters'
 import type {
@@ -775,8 +775,9 @@ class ApiService {
   async updateSeriesExternal(seriesId: string, seriesData: any): Promise<any | ErrorResponse> {
     validateString(seriesId, 'series ID')
     validateObject(seriesData, 'series data')
-    return this.callExternalApi('esp', \`/v1/series/\${seriesId}\`, 'PUT',
-      { ...seriesData, seriesId },
+    const payload = prepareEspSeriesPutPayload(seriesData)
+    return this.callExternalApi('esp', \`/v1/series/\${seriesId}\`, 'PUT',
+      { ...payload, seriesId },
       { operationName: \`updateSeries(\${seriesId})\`, shouldReturnFullResponse: true }
     )
   }
@@ -784,8 +785,9 @@ class ApiService {
   async publishSeries(seriesId: string, seriesData: any): Promise<any | ErrorResponse> {
     validateString(seriesId, 'series ID')
     validateObject(seriesData, 'series data')
+    const payload = prepareEspSeriesPutPayload(seriesData)
     return this.callExternalApi('esp', \`/v1/series/\${seriesId}\`, 'PUT',
-      { ...seriesData, seriesId, seriesStatus: 'published' },
+      { ...payload, seriesId, seriesStatus: 'published' },
       { operationName: \`publishSeries(\${seriesId})\`, shouldReturnFullResponse: true }
     )
   }
@@ -793,8 +795,9 @@ class ApiService {
   async unpublishSeries(seriesId: string, seriesData: any): Promise<any | ErrorResponse> {
     validateString(seriesId, 'series ID')
     validateObject(seriesData, 'series data')
+    const payload = prepareEspSeriesPutPayload(seriesData)
     return this.callExternalApi('esp', \`/v1/series/\${seriesId}\`, 'PUT',
-      { ...seriesData, seriesId, seriesStatus: 'draft' },
+      { ...payload, seriesId, seriesStatus: 'draft' },
       { operationName: \`unpublishSeries(\${seriesId})\`, shouldReturnFullResponse: true }
     )
   }
@@ -802,8 +805,9 @@ class ApiService {
   async archiveSeries(seriesId: string, seriesData: any): Promise<any | ErrorResponse> {
     validateString(seriesId, 'series ID')
     validateObject(seriesData, 'series data')
+    const payload = prepareEspSeriesPutPayload(seriesData)
     return this.callExternalApi('esp', \`/v1/series/\${seriesId}\`, 'PUT',
-      { ...seriesData, seriesId, seriesStatus: 'archived' },
+      { ...payload, seriesId, seriesStatus: 'archived' },
       { operationName: \`archiveSeries(\${seriesId})\`, shouldReturnFullResponse: true }
     )
   }
`;

export const seriesPutReadonlyTargetCms: Task = {
  id: "real-emc-series-put-readonly-targetcms",
  type: "content",
  // pod-emc-sessions is the closest existing pod fixture for ESP-PUT patterns.
  // (pod-emc-configs has less ESP-PUT specific learning.) Using this gives the
  // PIM-arm the "modificationTime / optimistic-concurrency / ESP contract"
  // context — relevant but not a direct read-only-fields callout. This is
  // also a useful test of whether tangentially-related context still helps.
  podId: "pod-emc-sessions",
  tags: ["real-emc", "housestyle", "api", "esp", "anti-pattern"],
  prompt: [
    "# Issue",
    ISSUE_TEXT,
    "",
    "# Current source (web-src/src/services/api.ts, parent commit 82f6dac)",
    "```ts",
    SOURCE_FILE,
    "```",
    "",
    "# Output",
    "Return ONLY a unified diff (--- / +++ / @@) against `web-src/src/services/api.ts`. No prose.",
  ].join("\n"),
  expectedSignals: ["prepareEspSeriesPutPayload", "filterSeriesData", "payload", "targetCms"],
  groundTruth: {
    output: GROUND_TRUTH_PATCH,
    note: "adobecom/EMC PR #137, merge SHA cd1892d. Parent file at 82f6dac.",
  },
  rubric: {
    id: "real-emc-series-put-readonly-targetcms-v1",
    criteria: [
      {
        id: "imports_filter_helper",
        description:
          "Does the patch import `prepareEspSeriesPutPayload` (or equivalent filter wrapper) from `'../utils/dataFilters'`? Score 0-5.",
        scale: "0-5",
        weight: 1.5,
      },
      {
        id: "applies_filter_to_all_four_methods",
        description:
          "Does the patch apply the filter to ALL FOUR series PUT methods: updateSeriesExternal, publishSeries, unpublishSeries, archiveSeries? Score 0-5: 0=none/wrong methods, 3=2-3 of the four, 5=all four.",
        scale: "0-5",
        weight: 3,
      },
      {
        id: "preserves_seriesid_and_seriesstatus",
        description:
          "Does the patch preserve the explicit `seriesId` and `seriesStatus` additions on each method (don't filter those out — they're required overrides on top of the payload)? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "matches_ground_truth_intent",
        description:
          "Compared to the reference, does the agent's diff achieve the same effect (read-only fields stripped before PUT for all four series flows)? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "valid_unified_diff",
        description:
          "Is the output a parseable unified diff? Boolean.",
        scale: "boolean",
        weight: 1,
      },
      {
        id: "no_invented_helpers",
        description:
          "Does the patch avoid inventing a different helper name not mentioned in the issue (e.g., creating a brand-new `stripReadOnly()` instead of using the suggested `prepareEspSeriesPutPayload`)? Boolean.",
        scale: "boolean",
        weight: 1,
      },
    ],
  },
};
