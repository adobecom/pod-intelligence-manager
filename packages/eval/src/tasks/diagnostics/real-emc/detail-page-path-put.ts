import type { Task } from "../../types.js";

/**
 * Real EMC PR replayed as an eval task — vague-issue category.
 *
 * Provenance:
 *   Repo:    adobecom/EMC (local: /Users/rkhan/emcV2/EMC)
 *   PR:      #119 — "MWPW-191618: [Fix] Send detailPagePath in Event update when event title is changed"
 *   Parent:  aed893da260263a630f554eeb9c31560f84f46b2 (state of dataFilters.ts BEFORE the merge)
 *   Merge:   80e5e351c9d4ef7cf6a858dc3efe8e78948af87d
 *
 * Why this PR was chosen for the vague-issue bucket:
 *   - Bug symptom is high-level ("title change should create a DA page with the new title").
 *   - The actual fix lives in two paired config primitives that are non-obvious:
 *     `EVENT_DATA_FILTER.detailPagePath.submittable` AND the PUT-time exclude list
 *     `EVENT_DATA_ESL_EVENT_PUT_EXCLUDE_KEYS`. Both must change in lockstep — flipping
 *     only one leaves the field stuck either at the submission filter or at the ESL
 *     PUT egress.
 *   - The pod-emc-sessions living doc encodes the "submittable false + PUT exclude"
 *     contract; a context-less agent has to derive both layers from the source alone.
 */

const SOURCE_FILE = `// web-src/src/utils/dataFilters.ts (relevant excerpts — unrelated entries omitted)

export const EVENT_DATA_FILTER: DataFilter = {
  // ... other event field descriptors omitted ...
  cloudType: { type: 'string', localizable: false, cloneable: true, submittable: true },
  seriesId: { type: 'string', localizable: false, cloneable: true, submittable: true },
  enTitle: { type: 'string', localizable: false, cloneable: true, submittable: true },
  // ... other event field descriptors omitted ...
  isPrivate: { type: 'boolean', localizable: false, cloneable: true, submittable: true },
  inviteOnly: { type: 'boolean', localizable: false, cloneable: true, submittable: true },
  detailPagePath: { type: 'string', localizable: false, cloneable: false, submittable: false },
  useLegacyDetailPagePath: { type: 'boolean', localizable: false, cloneable: false, submittable: true },
  // ... other event field descriptors omitted ...
}

// ... unrelated filters and helpers omitted ...

export type EventFilterMode = 'submission' | 'clone'

const EVENT_FILTER_STRATEGIES: Record<EventFilterMode, (descriptor: DataFieldDescriptor | undefined) => boolean> = {
  submission: (descriptor) => descriptor?.submittable === true,
  clone: (descriptor) => descriptor?.submittable === true && descriptor?.cloneable !== false,
}

/**
 * Keys stripped on every ESL **event** \`PUT /v1/events/:id\` (update, publish, unpublish, preview)
 * inside {@link prepareEslEventPutPayload} — not publish-specific.
 * - inviteOnly: read-only on ESL update.
 * - detailPagePath: POST (create) only; must not be sent on PUT.
 */
export const EVENT_DATA_ESL_EVENT_PUT_EXCLUDE_KEYS: readonly string[] = ['inviteOnly', 'detailPagePath']

/**
 * Normalize any object intended for ESL \`PUT /v1/events/:id\` (update, publish, unpublish, preview).
 * Applies submission filtering plus {@link EVENT_DATA_ESL_EVENT_PUT_EXCLUDE_KEYS}.
 */
export function prepareEslEventPutPayload(
  data: Record<string, any>,
  options: FilterOptions = {}
): Record<string, any> {
  if (!data || typeof data !== 'object') return {}

  const excludeKeys = [
    ...EVENT_DATA_ESL_EVENT_PUT_EXCLUDE_KEYS,
    ...(options.excludeKeys ?? []),
  ]
  return filterEventData(data, 'submission', { excludeKeys })
}
`;

const ISSUE_TEXT = `fix: send detailPagePath on event update when the title changes

When the event title is changed the expected behaviour is to create a new DA
page with the new event title. But \`detailPagePath\` was being intentionally
omitted in the PUT call because it was a read-only field in BE.

Note: a backend change has landed to allow updating the field; the OpenAPI
spec now accepts detailPagePath on PUT.`;

const GROUND_TRUTH_PATCH = `--- a/web-src/src/utils/dataFilters.ts
+++ b/web-src/src/utils/dataFilters.ts
@@ -139,7 +139,7 @@ export const EVENT_DATA_FILTER: DataFilter = {
   modificationTime: { type: 'string', localizable: false, cloneable: false, submittable: true },
   isPrivate: { type: 'boolean', localizable: false, cloneable: true, submittable: true },
   inviteOnly: { type: 'boolean', localizable: false, cloneable: true, submittable: true },
-  detailPagePath: { type: 'string', localizable: false, cloneable: false, submittable: false },
+  detailPagePath: { type: 'string', localizable: false, cloneable: false, submittable: true },
   useLegacyDetailPagePath: { type: 'boolean', localizable: false, cloneable: false, submittable: true },
   video: { type: 'object', localizable: false, cloneable: true, submittable: true, ref: VIDEO_DATA_REF_FILTER },
   registration: { type: 'object', localizable: false, cloneable: true, submittable: true, ref: REGISTRATION_DATA_REF_FILTER },
@@ -276,9 +276,8 @@ const EVENT_FILTER_STRATEGIES: Record<EventFilterMode, (descriptor: DataFieldDes
  * Keys stripped on every ESL **event** \`PUT /v1/events/:id\` (update, publish, unpublish, preview)
  * inside {@link prepareEslEventPutPayload} — not publish-specific.
  * - inviteOnly: read-only on ESL update.
- * - detailPagePath: POST (create) only; must not be sent on PUT.
  */
-export const EVENT_DATA_ESL_EVENT_PUT_EXCLUDE_KEYS: readonly string[] = ['inviteOnly', 'detailPagePath']
+export const EVENT_DATA_ESL_EVENT_PUT_EXCLUDE_KEYS: readonly string[] = ['inviteOnly']

 /**
  * Normalize any object intended for ESL \`PUT /v1/events/:id\` (update, publish, unpublish, preview).
`;

export const detailPagePathPut: Task = {
  id: "real-emc-detail-page-path-put",
  type: "content",
  podId: "pod-emc-sessions",
  asOf: "2026-04-06T18:04:48-07:00",
  tags: ["real-emc", "vague-issue", "api", "dataFilters"],
  prompt: [
    "# Issue",
    ISSUE_TEXT,
    "",
    "# Current source (web-src/src/utils/dataFilters.ts, parent commit aed893d)",
    "```ts",
    SOURCE_FILE,
    "```",
    "",
    "# Output",
    "Return ONLY a unified diff (--- / +++ / @@) against `web-src/src/utils/dataFilters.ts`. No prose, no full-file rewrite.",
  ].join("\n"),
  expectedSignals: [
    "detailPagePath",
    "submittable",
    "EVENT_DATA_ESL_EVENT_PUT_EXCLUDE_KEYS",
    "prepareEslEventPutPayload",
  ],
  groundTruth: {
    output: GROUND_TRUTH_PATCH,
    note: "adobecom/EMC PR #119, merge SHA 80e5e35. Parent dataFilters.ts at aed893d. Ground-truth-only hunks shown; the PR also touched a test file and EventForm.tsx wiring, which are not required to fix the underlying ESL PUT contract.",
  },
  rubric: {
    id: "real-emc-detail-page-path-put-v1",
    criteria: [
      {
        id: "marks_detailpagepath_submittable",
        description:
          "Does the patch flip `detailPagePath` to `submittable: true` in `EVENT_DATA_FILTER` so it survives the submission filter? Score 0-5: 0=unchanged or still false, 5=flipped to true.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "removes_from_put_exclude",
        description:
          "Does the patch remove `'detailPagePath'` from `EVENT_DATA_ESL_EVENT_PUT_EXCLUDE_KEYS` so it actually reaches ESL on PUT? Score 0-5: 0=still excluded, 5=fully removed. Both changes are required — flipping only `submittable` still leaves the field stripped at the PUT egress.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "uses_dataFilters_pattern",
        description:
          "Does the patch route the change through the existing dataFilters / prepareEslEventPutPayload convention (not invent a new code path, e.g. a new helper or a bypass in api.ts)? Score 0-5.",
        scale: "0-5",
        weight: 2,
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
        id: "no_invented_apis",
        description:
          "Does the patch avoid inventing helpers or constants not in the source (e.g., a fake `EVENT_DATA_ESL_EVENT_PUT_INCLUDE_KEYS`, a fake `isTitleChanged` flag at this layer)? Boolean.",
        scale: "boolean",
        weight: 1,
      },
    ],
  },
};
