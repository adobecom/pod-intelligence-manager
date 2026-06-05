import type { Task } from "../../types.js";

/**
 * Counterfactual variant of `event-speaker-put-contract`.
 *
 * Same EMC PR (#134), same source file, same ground-truth patch — but the
 * issue text is stripped of the explicit field list. Where the original PR
 * description says "Narrow to speakerId, speakerType, ordinal, creationTime,
 * and modificationTime, with GET fallbacks...", this variant says only that
 * the PUT body is too wide and asks for the right contract.
 *
 * Purpose: isolate the PIM signal. The original task was a tie because the
 * PR description gave away the answer. With the answer removed, the model
 * has to derive the correct field set from somewhere — either the source
 * file itself (control) or the pod's living doc (PIM-arm, which contains
 * the modificationTime optimistic-concurrency learning).
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

const ISSUE_TEXT = `fix(api): event speaker PUT body is too wide

updateSpeakerInEvent currently sends every field from the GET response back
on PUT. Send only the fields the speaker contract actually requires.`;

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

export const eventSpeakerPutContractVague: Task = {
  id: "real-emc-event-speaker-put-contract-vague",
  type: "content",
  podId: "pod-emc-sessions",
  tags: ["real-emc", "vague-issue", "api", "esp", "counterfactual"],
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
    "Return ONLY a unified diff (--- / +++ / @@) against `web-src/src/services/api.ts`. No prose.",
  ].join("\n"),
  expectedSignals: ["speakerId", "speakerType", "ordinal", "creationTime", "modificationTime"],
  groundTruth: {
    output: GROUND_TRUTH_PATCH,
    note: "adobecom/EMC PR #134 with issue text stripped of the explicit field list (counterfactual).",
  },
  rubric: {
    id: "real-emc-event-speaker-put-contract-vague-v1",
    criteria: [
      {
        id: "removes_full_get_spread",
        description:
          "Does the patch remove the `...fromGet` / full-GET spread? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "narrows_to_contract_fields",
        description:
          "Does the patch narrow to a small explicit set of fields including the optimistic-concurrency timestamps? Score 0-5. The correct contract is { speakerId, speakerType, ordinal, creationTime, modificationTime }; partial credit for hitting most of them.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "preserves_get_fallback",
        description:
          "Does the patch preserve a GET-fallback for omitted fields (e.g. `body.X ?? dependentData.X`)? Score 0-5.",
        scale: "0-5",
        weight: 1.5,
      },
      {
        id: "uses_modification_time",
        description:
          "Does the patch set modificationTime from the GET response (optimistic-concurrency pattern)? Boolean.",
        scale: "boolean",
        weight: 1.5,
      },
      {
        id: "matches_ground_truth_intent",
        description:
          "Compared to the reference patch, does the agent's diff achieve the same effect? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "valid_unified_diff",
        description:
          "Is the output a parseable unified diff (not prose, not a full-file rewrite)? Boolean.",
        scale: "boolean",
        weight: 1,
      },
      {
        id: "no_invented_fields",
        description:
          "Does the patch avoid inventing fields not in the source (e.g., fake `etag`, fake `version`)? Boolean.",
        scale: "boolean",
        weight: 1,
      },
    ],
  },
};
