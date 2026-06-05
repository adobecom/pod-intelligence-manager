import type { Task } from "../../types.js";

/**
 * Real EMC PR replayed as an eval task.
 *
 * Provenance:
 *   Repo:    adobecom/EMC (local: /Users/rkhan/emcV2/EMC)
 *   PR:      #93 — "fix(event-form): sync event modificationTime after session mutations"
 *   Parent:  bba1f6a56f4c35725870afa93dd686a732fcfb9b (state of api.ts BEFORE the merge)
 *   Merge:   58f01640e65b4f88bd1ddc9add862c59e7285a75
 *
 * Note: PR #93 touched three files; this task focuses on the api.ts hunk,
 * which omits empty `tags` from session POST/PUT bodies so ESP does not
 * receive `tags: ''` (which collides with later session-tag mutations and
 * contributes to the modificationTime drift the broader PR addresses).
 */

const SOURCE_FILE = `// api.ts — relevant excerpts at parent bba1f6a (ApiService class methods)

  async createSession(eventId: string, data: Record<string, unknown>): Promise<any | ErrorResponse> {
    validateString(eventId, 'event ID')
    validateObject(data, 'session data')
    const sessionCode = (String(data.name ?? '').replace(/\\s+/g, '-').toLowerCase()).substring(0, 50) || 'session'
    const body: Record<string, unknown> = {
      eventId,
      enTitle: data.name ?? '',
      title: data.name ?? '',
      description: data.description ?? '',
      tags: data.tags ?? '',
      sessionCode,
      sessionType: 'Session',
      published: false,
    }
    return this.callExternalApi('esp', '/v1/sessions', 'POST', body, {
      operationName: 'createSession',
      shouldReturnFullResponse: true,
    })
  }

  async updateSession(id: string, eventId: string, data: Record<string, unknown>): Promise<any | ErrorResponse> {
    validateString(id, 'session ID')
    validateString(eventId, 'event ID')
    validateObject(data, 'session data')
    const sessionCode = (String(data.name ?? '').replace(/\\s+/g, '-').toLowerCase()).substring(0, 50) || 'session'
    const now = Date.now()
    const body: Record<string, unknown> = {
      sessionId: id,
      eventId,
      enTitle: data.name ?? '',
      title: data.name ?? '',
      description: data.description ?? '',
      tags: data.tags ?? '',
      sessionCode,
      sessionType: 'Session',
      published: false,
      creationTime: (data.creationTime as number) ?? now,
      modificationTime: (data.modificationTime as number) ?? now,
    }
    return this.callExternalApi('esp', \`/v1/sessions/\${encodeURIComponent(id)}\`, 'PUT', body, {
      operationName: 'updateSession',
      shouldReturnFullResponse: true,
    })
  }
`;

const ISSUE_TEXT = `Omit empty session \`tags\` from create/update session bodies.

\`createSession\` and \`updateSession\` currently send \`tags: data.tags ?? ''\`
unconditionally, so an empty string is written to ESP whenever the caller
omits tags (almost every form save). That stale empty value collides with
later session-tag mutations and contributes to the event modificationTime
drift this PR fixes elsewhere.

Coerce \`data.tags\` to a trimmed string and only include the \`tags\` key
on the body when the trimmed value is non-empty. Apply the same treatment
to both POST and PUT.`;

const GROUND_TRUTH_PATCH = `--- a/web-src/src/services/api.ts
+++ b/web-src/src/services/api.ts
@@ -333,16 +333,19 @@ class ApiService {
     validateString(eventId, 'event ID')
     validateObject(data, 'session data')
     const sessionCode = (String(data.name ?? '').replace(/\\s+/g, '-').toLowerCase()).substring(0, 50) || 'session'
+    const tagsStr = typeof data.tags === 'string' ? data.tags.trim() : ''
     const body: Record<string, unknown> = {
       eventId,
       enTitle: data.name ?? '',
       title: data.name ?? '',
       description: data.description ?? '',
-      tags: data.tags ?? '',
       sessionCode,
       sessionType: 'Session',
       published: false,
     }
+    if (tagsStr.length > 0) {
+      body.tags = tagsStr
+    }
     return this.callExternalApi('esp', '/v1/sessions', 'POST', body, {
       operationName: 'createSession',
       shouldReturnFullResponse: true,
@@ -355,19 +358,22 @@ class ApiService {
     validateObject(data, 'session data')
     const sessionCode = (String(data.name ?? '').replace(/\\s+/g, '-').toLowerCase()).substring(0, 50) || 'session'
     const now = Date.now()
+    const tagsStr = typeof data.tags === 'string' ? data.tags.trim() : ''
     const body: Record<string, unknown> = {
       sessionId: id,
       eventId,
       enTitle: data.name ?? '',
       title: data.name ?? '',
       description: data.description ?? '',
-      tags: data.tags ?? '',
       sessionCode,
       sessionType: 'Session',
       published: false,
       creationTime: (data.creationTime as number) ?? now,
       modificationTime: (data.modificationTime as number) ?? now,
     }
+    if (tagsStr.length > 0) {
+      body.tags = tagsStr
+    }
     return this.callExternalApi('esp', \`/v1/sessions/\${encodeURIComponent(id)}\`, 'PUT', body, {
       operationName: 'updateSession',
       shouldReturnFullResponse: true,
`;

export const eventModTimeSyncAfterSession: Task = {
  id: "real-emc-event-mod-time-sync-after-session",
  type: "content",
  podId: "pod-emc-sessions",
  asOf: "2026-03-31T10:56:29-07:00",
  tags: ["real-emc", "api", "esp", "sessions"],
  // Re-tiered to realistic-ticket (#8): dictated coercion steps + pasted source removed.
  prompt: [
    "# Issue",
    "Omit empty session `tags` from create/update session bodies",
    "",
    "`createSession` and `updateSession` always send a `tags` value to ESP, even when",
    "the caller didn't supply any tags (almost every form save). That writes a stale",
    "empty value that collides with later session-tag mutations and contributes to the",
    "event modificationTime drift we're chasing elsewhere.",
    "",
    "Only send `tags` to ESP when there's an actual non-empty tag value; otherwise leave",
    "the key off the request body. Both the POST (create) and PUT (update) paths have",
    "this problem.",
    "",
    "These methods are on the ApiService class in `web-src/src/services/api.ts`.",
    "",
    "# Output",
    "Return ONLY a unified diff (--- / +++ / @@) against `web-src/src/services/api.ts`. No prose, no full-file rewrite.",
  ].join("\n"),
  expectedSignals: [
    "tagsStr",
    "data.tags",
    "trim",
    "tagsStr.length",
    "createSession",
    "updateSession",
  ],
  groundTruth: {
    output: GROUND_TRUTH_PATCH,
    note: "adobecom/EMC PR #93, merge SHA 58f0164. Parent file at bba1f6a.",
  },
  rubric: {
    id: "real-emc-event-mod-time-sync-after-session-v1",
    criteria: [
      {
        id: "removes_unconditional_empty_tags",
        description:
          "Does the patch remove the literal `tags: data.tags ?? ''` line from BOTH `createSession` and `updateSession` bodies? Score 0-5: 0=keeps both, 3=removes one, 5=removes both.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "trims_and_type_checks_input",
        description:
          "Does the patch coerce/guard `data.tags` to a trimmed string before deciding whether to include it (e.g., `typeof data.tags === 'string' ? data.tags.trim() : ''`)? Boolean.",
        scale: "boolean",
        weight: 1.5,
      },
      {
        id: "conditional_tags_assignment",
        description:
          "Does the patch only assign `body.tags` (or include the `tags` key on the body) when the trimmed value is non-empty? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "applies_to_both_methods",
        description:
          "Is the fix applied symmetrically to both `createSession` (POST) and `updateSession` (PUT)? Boolean.",
        scale: "boolean",
        weight: 1.5,
      },
      {
        id: "preserves_other_body_fields",
        description:
          "Does the patch leave the other body fields (eventId, sessionId, enTitle, title, description, sessionCode, sessionType, published, creationTime, modificationTime) untouched? Boolean.",
        scale: "boolean",
        weight: 1,
      },
      {
        id: "matches_ground_truth_intent",
        description:
          "Compared to the reference patch, does the agent's diff achieve the same effect regardless of exact formatting (e.g., extracting a helper vs. inlining the check)? Score 0-5.",
        scale: "0-5",
        weight: 1.5,
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
