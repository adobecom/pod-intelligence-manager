import type { Task } from "../../types.js";

/**
 * Real EMC PR replayed as an eval task.
 *
 * Provenance:
 *   Repo:    adobecom/EMC (local: /Users/rkhan/emcV2/EMC)
 *   PR:      #107 — "fix(esl): omit detailPagePath on event PUT (POST-only)"
 *   Parent:  fa650788f2e6dc01794fe98157dec3f98aa30563 (state of dataFilters.ts BEFORE the merge)
 *   Merge:   367aef166ae0ca97eb8f051632d799565d9598b9
 */

const SOURCE_FILE = `// dataFilters.ts — relevant excerpts at parent fa65078

export type EventFilterMode = 'submission' | 'clone'

const EVENT_FILTER_STRATEGIES: Record<EventFilterMode, (descriptor: DataFieldDescriptor | undefined) => boolean> = {
  submission: (descriptor) => descriptor?.submittable === true,
  clone: (descriptor) => descriptor?.submittable === true && descriptor?.cloneable !== false,
}

/** Fields omitted from ESL event PUT when using {@link prepareEslEventPutPayload} (read-only or not accepted on ESL update). */
export const EVENT_DATA_ESL_PUBLISH_EXCLUDE_KEYS: readonly string[] = ['inviteOnly']

/**
 * ESL PUT may accept these top-level keys even when EVENT_DATA_FILTER marks them non-submittable.
 * They are merged back from the input after {@link filterEventData} (e.g. detailPagePath via form extraPayload).
 */
export const EVENT_DATA_ESL_PUT_POST_FILTER_ALLOWLIST: readonly string[] = ['detailPagePath']

/**
 * Normalize any object intended for ESL \`PUT /v1/events/:id\` (update, publish, unpublish, preview).
 * Applies submission filtering plus ESL-specific exclusions, then restores allowlisted keys from the input.
 */
export function prepareEslEventPutPayload(
  data: Record<string, any>,
  options: FilterOptions = {}
): Record<string, any> {
  if (!data || typeof data !== 'object') return {}

  const excludeKeys = [
    ...EVENT_DATA_ESL_PUBLISH_EXCLUDE_KEYS,
    ...(options.excludeKeys ?? []),
  ]
  const filtered = filterEventData(data, 'submission', { excludeKeys })

  const out: Record<string, any> = { ...filtered }
  for (const key of EVENT_DATA_ESL_PUT_POST_FILTER_ALLOWLIST) {
    if (Object.prototype.hasOwnProperty.call(data, key) && isValidAttribute(data[key])) {
      out[key] = data[key]
    }
  }
  return out
}
`;

const ISSUE_TEXT = `fix(esl): omit detailPagePath on event PUT (POST-only)

ESL accepts \`detailPagePath\` only on event create (POST); sending it on
PUT (update / publish / unpublish / preview) is incorrect. All event PUTs
go through \`prepareEslEventPutPayload\`, but it currently re-injects
\`detailPagePath\` after filtering via the \`EVENT_DATA_ESL_PUT_POST_FILTER_ALLOWLIST\`
merge-back loop, so callers that pass it (e.g. form extraPayload on save)
still leak it onto the wire.

Move \`detailPagePath\` into the existing event-PUT exclude list so it is
stripped on every PUT, and remove the now-unused allowlist + merge-back
loop. Rename the constant so it reads as a general event-PUT exclude list
(not "publish"-specific). Update the JSDoc and inline references
accordingly.`;

const GROUND_TRUTH_PATCH = `--- a/web-src/src/utils/dataFilters.ts
+++ b/web-src/src/utils/dataFilters.ts
@@ -272,18 +272,17 @@ const EVENT_FILTER_STRATEGIES: Record<EventFilterMode, (descriptor: DataFieldDes
   clone: (descriptor) => descriptor?.submittable === true && descriptor?.cloneable !== false,
 }

-/** Fields omitted from ESL event PUT when using {@link prepareEslEventPutPayload} (read-only or not accepted on ESL update). */
-export const EVENT_DATA_ESL_PUBLISH_EXCLUDE_KEYS: readonly string[] = ['inviteOnly']
-
 /**
- * ESL PUT may accept these top-level keys even when EVENT_DATA_FILTER marks them non-submittable.
- * They are merged back from the input after {@link filterEventData} (e.g. detailPagePath via form extraPayload).
+ * Keys stripped on every ESL **event** \`PUT /v1/events/:id\` (update, publish, unpublish, preview)
+ * inside {@link prepareEslEventPutPayload} — not publish-specific.
+ * - inviteOnly: read-only on ESL update.
+ * - detailPagePath: POST (create) only; must not be sent on PUT.
  */
-export const EVENT_DATA_ESL_PUT_POST_FILTER_ALLOWLIST: readonly string[] = ['detailPagePath']
+export const EVENT_DATA_ESL_EVENT_PUT_EXCLUDE_KEYS: readonly string[] = ['inviteOnly', 'detailPagePath']

 /**
  * Normalize any object intended for ESL \`PUT /v1/events/:id\` (update, publish, unpublish, preview).
- * Applies submission filtering plus ESL-specific exclusions, then restores allowlisted keys from the input.
+ * Applies submission filtering plus {@link EVENT_DATA_ESL_EVENT_PUT_EXCLUDE_KEYS}.
  */
 export function prepareEslEventPutPayload(
   data: Record<string, any>,
@@ -292,18 +291,10 @@ export function prepareEslEventPutPayload(
   if (!data || typeof data !== 'object') return {}

   const excludeKeys = [
-    ...EVENT_DATA_ESL_PUBLISH_EXCLUDE_KEYS,
+    ...EVENT_DATA_ESL_EVENT_PUT_EXCLUDE_KEYS,
     ...(options.excludeKeys ?? []),
   ]
-  const filtered = filterEventData(data, 'submission', { excludeKeys })
-
-  const out: Record<string, any> = { ...filtered }
-  for (const key of EVENT_DATA_ESL_PUT_POST_FILTER_ALLOWLIST) {
-    if (Object.prototype.hasOwnProperty.call(data, key) && isValidAttribute(data[key])) {
-      out[key] = data[key]
-    }
-  }
-  return out
+  return filterEventData(data, 'submission', { excludeKeys })
 }

 /**
`;

export const eventPutOmitDetailPagePath: Task = {
  id: "real-emc-event-put-omit-detail-page-path",
  type: "content",
  podId: "pod-emc-sessions",
  asOf: "2026-04-02T10:46:18-07:00",
  tags: ["real-emc", "esl", "api-contract", "data-filters"],
  // Re-tiered to realistic-ticket (#8): step-by-step refactor list + pasted source removed.
  prompt: [
    "# Issue",
    "fix(esl): omit detailPagePath on event PUT (POST-only)",
    "",
    "ESL accepts `detailPagePath` only when creating an event (POST). Sending it on",
    "PUT (update / publish / unpublish / preview) is incorrect, but it's currently",
    "leaking onto PUT requests when a caller supplies it (e.g. the form's extraPayload",
    "on save).",
    "",
    "All event PUTs are normalized through `prepareEslEventPutPayload` in",
    "`web-src/src/utils/dataFilters.ts`. Make that path strip `detailPagePath` on every",
    "PUT so it can never reach the wire on update, while leaving the create path and",
    "caller-supplied exclusions intact.",
    "",
    "# Output",
    "Return ONLY a unified diff (--- / +++ / @@) against `web-src/src/utils/dataFilters.ts`. No prose, no full-file rewrite.",
  ].join("\n"),
  expectedSignals: [
    "detailPagePath",
    "inviteOnly",
    "EVENT_DATA_ESL_PUT_POST_FILTER_ALLOWLIST",
    "EVENT_DATA_ESL_PUBLISH_EXCLUDE_KEYS",
    "prepareEslEventPutPayload",
    "filterEventData",
  ],
  kgExpectations: {
    requiredFacts: [
      "detailPagePath",
      "POST",
      "PUT",
      "exclude",
    ],
    requiredSymbols: ["prepareEslEventPutPayload", "detailPagePath"],
  },
  groundTruth: {
    output: GROUND_TRUTH_PATCH,
    note: "adobecom/EMC PR #107, merge SHA 367aef1. Parent file at fa65078.",
  },
  rubric: {
    id: "real-emc-event-put-omit-detail-page-path-v1",
    criteria: [
      {
        id: "removes_allowlist_constant",
        description:
          "Does the patch remove the `EVENT_DATA_ESL_PUT_POST_FILTER_ALLOWLIST` export (the constant that allowlists `detailPagePath` for merge-back)? Boolean.",
        scale: "boolean",
        weight: 1.5,
      },
      {
        id: "adds_detail_page_path_to_exclude_list",
        description:
          "Does the patch add `'detailPagePath'` to the event-PUT exclude key list alongside `'inviteOnly'` so it is stripped by `filterEventData`? Boolean.",
        scale: "boolean",
        weight: 2,
      },
      {
        id: "removes_merge_back_loop",
        description:
          "Does the patch remove the `for (const key of ...ALLOWLIST)` re-injection loop inside `prepareEslEventPutPayload`, so the function simply returns the filtered output? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "renames_constant_for_clarity",
        description:
          "Does the patch rename the publish-flavored constant (e.g., to `EVENT_DATA_ESL_EVENT_PUT_EXCLUDE_KEYS`) so it reads as a general event-PUT exclude list, and update the reference inside `prepareEslEventPutPayload` to match? Score 0-5.",
        scale: "0-5",
        weight: 1.5,
      },
      {
        id: "preserves_options_exclude_keys_passthrough",
        description:
          "Does the patch preserve the existing behavior of merging caller-supplied `options.excludeKeys` into the final excludeKeys list? Boolean.",
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
    ],
  },
};
