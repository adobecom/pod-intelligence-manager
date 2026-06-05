import type { Task } from "../../types.js";

/**
 * Real EMC PR replayed as an eval task.
 *
 * Provenance:
 *   Repo:    adobecom/EMC (local: /Users/rkhan/emcV2/EMC)
 *   PR:      #105 — "fix: omit inviteOnly on dashboard publish/unpublish; fix Speakers actions menu"
 *   Parent:  cde40fa (state of api.ts BEFORE the merge)
 *   Merge:   fa65078
 *
 * Scope of THIS task file:
 *   Only web-src/src/services/api.ts. The full PR also touched
 *   useEventFormSave.ts (a comment-only update), dataFilters.ts (where
 *   prepareEslEventPutPayload is defined and exported), EventsDashboard.tsx,
 *   and SpeakersDashboard.tsx. Those are intentionally out of scope here.
 *
 *   Note: the original ticket pointed at useEventFormSave.ts, but that
 *   file only received a comment edit. The substantive change (wrapping
 *   the four ESL PUT entry points so they go through the centralized
 *   exclusion helper) lives in api.ts, which is what this task scores.
 */

const SOURCE_FILE = `  async updateEventExternal(eventId: string, payload: any, policies = { forceSpWrite: false, liveUpdate: false }): Promise<any | ErrorResponse> {
    validateString(eventId, 'event ID')
    validateObject(payload, 'event payload')
    return this.callExternalApi('esl', \`/v1/events/\${eventId}\`, 'PUT',
      { ...payload, ...policies },
      { operationName: \`updateEvent(\${eventId})\`, shouldReturnFullResponse: true }
    )
  }

  async publishEvent(eventId: string, payload: any): Promise<any | ErrorResponse> {
    validateString(eventId, 'event ID')
    validateObject(payload, 'event payload')
    return this.callExternalApi('esl', \`/v1/events/\${eventId}\`, 'PUT',
      { ...payload, published: true, liveUpdate: true, forceSpWrite: false },
      { operationName: \`publishEvent(\${eventId})\`, shouldReturnFullResponse: true }
    )
  }

  async unpublishEvent(eventId: string, payload: any): Promise<any | ErrorResponse> {
    validateString(eventId, 'event ID')
    validateObject(payload, 'event payload')
    return this.callExternalApi('esl', \`/v1/events/\${eventId}\`, 'PUT',
      { ...payload, published: false, liveUpdate: true, forceSpWrite: false },
      { operationName: \`unpublishEvent(\${eventId})\`, shouldReturnFullResponse: true }
    )
  }

  async previewEvent(eventId: string, payload: any): Promise<any | ErrorResponse> {
    validateString(eventId, 'event ID')
    validateObject(payload, 'event payload')
    return this.callExternalApi('esl', \`/v1/events/\${eventId}\`, 'PUT',
      { ...payload, liveUpdate: false, forceSpWrite: true },
      { operationName: \`previewEvent(\${eventId})\` }
    )
  }
`;

const ISSUE_TEXT = `fix: omit inviteOnly on dashboard publish/unpublish

The Events dashboard publish/unpublish/update path sends the full event
payload to ESL via PUT /v1/events/:id. ESL rejects \\\`inviteOnly\\\` on update
(it is read-only on that endpoint), so dashboard publish/unpublish 400s
on events whose payload includes the field.

A new helper \\\`prepareEslEventPutPayload\\\` already exists in
\\\`web-src/src/utils/dataFilters.ts\\\`. It accepts a payload object,
strips ESL-read-only keys (currently just \\\`inviteOnly\\\`), and returns
a sanitized object. Wire it through the four ESL PUT entry points in
\\\`ApiService\\\`: \\\`updateEventExternal\\\`, \\\`publishEvent\\\`,
\\\`unpublishEvent\\\`, \\\`previewEvent\\\`.

The policies/flags arguments (\\\`forceSpWrite\\\`, \\\`liveUpdate\\\`,
\\\`published\\\`) must still be merged AFTER the sanitized body so they
override anything the helper might emit.`;

const GROUND_TRUTH_PATCH = `--- a/web-src/src/services/api.ts
+++ b/web-src/src/services/api.ts
@@ -24,6 +24,7 @@ import { getCurrentEnvironment, getApiHost, SUPPORTED_CLOUDS } from '../config/c
 import { env } from '../config/env'
 import { apiCache } from './cacheUtils'
 import { deduplicateBy } from '../utils/deduplication'
+import { prepareEslEventPutPayload } from '../utils/dataFilters'
 import type {
   RBACApiScope,
   RBACApiGroup,
@@ -957,8 +958,9 @@ class ApiService {
   async updateEventExternal(eventId: string, payload: any, policies = { forceSpWrite: false, liveUpdate: false }): Promise<any | ErrorResponse> {
     validateString(eventId, 'event ID')
     validateObject(payload, 'event payload')
+    const body = prepareEslEventPutPayload(payload)
     return this.callExternalApi('esl', \`/v1/events/\${eventId}\`, 'PUT',
-      { ...payload, ...policies },
+      { ...body, ...policies },
       { operationName: \`updateEvent(\${eventId})\`, shouldReturnFullResponse: true }
     )
   }
@@ -966,8 +968,9 @@ class ApiService {
   async publishEvent(eventId: string, payload: any): Promise<any | ErrorResponse> {
     validateString(eventId, 'event ID')
     validateObject(payload, 'event payload')
+    const body = prepareEslEventPutPayload(payload)
     return this.callExternalApi('esl', \`/v1/events/\${eventId}\`, 'PUT',
-      { ...payload, published: true, liveUpdate: true, forceSpWrite: false },
+      { ...body, published: true, liveUpdate: true, forceSpWrite: false },
       { operationName: \`publishEvent(\${eventId})\`, shouldReturnFullResponse: true }
     )
   }
@@ -975,8 +978,9 @@ class ApiService {
   async unpublishEvent(eventId: string, payload: any): Promise<any | ErrorResponse> {
     validateString(eventId, 'event ID')
     validateObject(payload, 'event payload')
+    const body = prepareEslEventPutPayload(payload)
     return this.callExternalApi('esl', \`/v1/events/\${eventId}\`, 'PUT',
-      { ...payload, published: false, liveUpdate: true, forceSpWrite: false },
+      { ...body, published: false, liveUpdate: true, forceSpWrite: false },
       { operationName: \`unpublishEvent(\${eventId})\`, shouldReturnFullResponse: true }
     )
   }
@@ -984,8 +988,9 @@ class ApiService {
   async previewEvent(eventId: string, payload: any): Promise<any | ErrorResponse> {
     validateString(eventId, 'event ID')
     validateObject(payload, 'event payload')
+    const body = prepareEslEventPutPayload(payload)
     return this.callExternalApi('esl', \`/v1/events/\${eventId}\`, 'PUT',
-      { ...payload, liveUpdate: false, forceSpWrite: true },
+      { ...body, liveUpdate: false, forceSpWrite: true },
       { operationName: \`previewEvent(\${eventId})\` }
     )
   }
`;

export const dashboardPublishOmitInviteOnly: Task = {
  id: "real-emc-dashboard-publish-omit-invite-only",
  type: "content",
  podId: "pod-emc-sessions",
  asOf: "2026-04-02T10:46:03-07:00",
  tags: ["real-emc", "api", "esl"],
  prompt: [
    "# Issue",
    ISSUE_TEXT,
    "",
    "# Current source (web-src/src/services/api.ts, parent commit cde40fa)",
    "```ts",
    SOURCE_FILE,
    "```",
    "",
    "# Output",
    "Return ONLY a unified diff (--- / +++ / @@) against `web-src/src/services/api.ts`. No prose, no full-file rewrite.",
  ].join("\n"),
  expectedSignals: [
    "prepareEslEventPutPayload",
    "updateEventExternal",
    "publishEvent",
    "unpublishEvent",
    "previewEvent",
  ],
  groundTruth: {
    output: GROUND_TRUTH_PATCH,
    note: "adobecom/EMC PR #105, merge SHA fa65078. Parent file at cde40fa. (Other files in this PR (useEventFormSave.ts, dataFilters.ts, EventsDashboard.tsx, SpeakersDashboard.tsx) are intentionally out of scope here. The original spec pointed at useEventFormSave.ts but that file only received a comment edit; the substantive change is in api.ts.)",
  },
  rubric: {
    id: "real-emc-dashboard-publish-omit-invite-only-v1",
    criteria: [
      {
        id: "imports_helper",
        description:
          "Does the patch import prepareEslEventPutPayload from '../utils/dataFilters' (or equivalent relative path)? Boolean.",
        scale: "boolean",
        weight: 1.5,
      },
      {
        id: "wraps_all_four_methods",
        description:
          "Does the patch route payload through prepareEslEventPutPayload in all four ESL PUT entry points: updateEventExternal, publishEvent, unpublishEvent, previewEvent? Score 0-5: 0=none, 5=all four.",
        scale: "0-5",
        weight: 2.5,
      },
      {
        id: "preserves_policy_override_order",
        description:
          "After sanitization, are the per-method flags (e.g. published, liveUpdate, forceSpWrite, the policies arg) merged AFTER the sanitized body so they continue to override anything in the body? Score 0-5: 0=flags lost or ordering reversed, 5=correct override order preserved.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "no_local_filtering",
        description:
          "Does the patch call the centralized helper rather than open-coding an inline 'delete payload.inviteOnly' or destructuring-omit? It should delegate to prepareEslEventPutPayload. Boolean.",
        scale: "boolean",
        weight: 1.5,
      },
      {
        id: "matches_ground_truth_intent",
        description:
          "Compared to the reference patch, does the agent's diff achieve the same effect (inviteOnly never reaches the ESL PUT body on dashboard publish/unpublish/update/preview) regardless of exact formatting? Score 0-5.",
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
        id: "no_invented_helpers",
        description:
          "Does the patch avoid inventing helpers that don't exist (e.g., a made-up 'sanitizeForEsl' or 'stripReadOnlyFields') instead of calling the existing prepareEslEventPutPayload? Boolean.",
        scale: "boolean",
        weight: 1,
      },
    ],
  },
};
