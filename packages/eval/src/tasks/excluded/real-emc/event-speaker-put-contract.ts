import type { Task } from "../../types.js";

/**
 * Real EMC PR replayed as an eval task.
 *
 * Provenance:
 *   Repo:    adobecom/EMC (local: /Users/rkhan/emcV2/EMC)
 *   PR:      #134 — "fix(api): contract-shaped PUT for event speakers"
 *   Branch:  fix/event-speaker-put-payload
 *   Tip:     4558a36
 *   Parent:  5350792 (state of api.ts BEFORE the merge)
 *   Merge:   e477b74
 *
 * Why this PR was chosen for v0:
 *   - Small, single-file, surgical diff (≈15 +/- 8 lines)
 *   - The fix narrows the PUT body from "spread the whole GET response over
 *     the body" to a specific contract — exactly the kind of decision
 *     pod-emc-sessions' living doc encodes (modificationTime optimistic
 *     concurrency, ESP API contract shape). Control should produce a generic
 *     merge fix; PIM-arm should produce the narrow contract.
 */

const SOURCE_FILE = `  async updateSpeakerInEvent(speakerData: any, speakerId: string, eventId: string): Promise<any | ErrorResponse> {
    validateString(eventId, 'event ID')
    validateString(speakerId, 'speaker ID')
    validateObject(speakerData, 'speaker data')
    return this.callWithDependency(
      'esp',
      \`/v1/events/\${eventId}/speakers/\${speakerId}\`,
      speakerData,
      () => this.getEventSpeaker(eventId, speakerId),
      (body, dependentData) => {
        const { creationTime: _omitCreationTime, ...fromGet } = dependentData
        return {
          ...fromGet,
          ...body,
          modificationTime: dependentData.modificationTime,
        }
      },
      'updateSpeakerInEvent'
    )
  }
`;

const ISSUE_TEXT = `fix(api): send contract-shaped body for event speaker PUT

Previously updateSpeakerInEvent merged the full getEventSpeaker response
into the PUT body. Narrow to speakerId, speakerType, ordinal,
creationTime, and modificationTime, with GET fallbacks for fields
callers omit (e.g. Speakers dashboard cascade).`;

const GROUND_TRUTH_PATCH = `--- a/web-src/src/services/api.ts
+++ b/web-src/src/services/api.ts
@@ -1393,14 +1393,13 @@ class ApiService {
       \`/v1/events/\${eventId}/speakers/\${speakerId}\`,
       speakerData,
       () => this.getEventSpeaker(eventId, speakerId),
-      (body, dependentData) => {
-        const { creationTime: _omitCreationTime, ...fromGet } = dependentData
-        return {
-          ...fromGet,
-          ...body,
-          modificationTime: dependentData.modificationTime,
-        }
-      },
+      (body, dependentData) => ({
+        speakerId: body.speakerId ?? dependentData.speakerId,
+        speakerType: body.speakerType ?? dependentData.speakerType,
+        ordinal: body.ordinal ?? dependentData.ordinal,
+        creationTime: dependentData.creationTime,
+        modificationTime: dependentData.modificationTime,
+      }),
       'updateSpeakerInEvent'
     )
   }
`;

export const eventSpeakerPutContract: Task = {
  id: "real-emc-event-speaker-put-contract",
  type: "content",
  // pod-emc-sessions is the closest fit: its living doc encodes
  // modificationTime / optimistic-concurrency and ESP PUT contract patterns.
  podId: "pod-emc-sessions",
  tags: ["real-emc", "saturated", "api", "esp"],
  prompt: [
    "# Issue",
    ISSUE_TEXT,
    "",
    "# Current source (web-src/src/services/api.ts, parent commit 5350792)",
    "```ts",
    SOURCE_FILE,
    "```",
    "",
    "# Output",
    "Return ONLY a unified diff (--- / +++ / @@) against `web-src/src/services/api.ts` that fixes the PUT body shape. No prose, no full-file rewrite.",
  ].join("\n"),
  expectedSignals: ["speakerId", "speakerType", "ordinal", "creationTime", "modificationTime"],
  groundTruth: {
    output: GROUND_TRUTH_PATCH,
    note: "adobecom/EMC PR #134, merge SHA e477b74. Parent file at 5350792.",
  },
  rubric: {
    id: "real-emc-event-speaker-put-contract-v1",
    criteria: [
      {
        id: "removes_full_get_spread",
        description:
          "Does the patch remove the `...fromGet` / full-GET-response spread into the PUT body? The bug is that updateSpeakerInEvent currently sends every field from the GET response. Score 0-5: 0=keeps spread, 5=fully removed.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "narrows_to_contract_fields",
        description:
          "Does the patch narrow the body to a small explicit set of fields (speakerId, speakerType, ordinal) plus the optimistic-concurrency timestamps (creationTime, modificationTime)? Score 0-5: 0=still spreads unknown fields, 5=explicit field list matching the contract.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "preserves_get_fallback",
        description:
          "Does the patch preserve a GET-fallback for the named fields when the caller omits them (e.g., `body.speakerId ?? dependentData.speakerId`)? The PR description calls out the Speakers dashboard cascade case. Score 0-5.",
        scale: "0-5",
        weight: 1.5,
      },
      {
        id: "uses_modification_time",
        description:
          "Does the patch set modificationTime from the dependent GET response (optimistic-concurrency pattern documented in pod-emc-sessions)? Boolean.",
        scale: "boolean",
        weight: 1.5,
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
        id: "no_invented_fields",
        description:
          "Does the patch avoid inventing fields not in the source or issue text (e.g., a fake `version`, a non-existent `etag`)? Boolean.",
        scale: "boolean",
        weight: 1,
      },
    ],
  },
};
