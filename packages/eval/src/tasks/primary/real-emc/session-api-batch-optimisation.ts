import type { Task } from "../../types.js";

/**
 * Real EMC PR replayed as an eval task.
 *
 * Provenance:
 *   Repo:    adobecom/EMC (local: /Users/rkhan/emcV2/EMC)
 *   PR:      #101 — "API optimisations for Session management"
 *   Parent:  d6078f2 (state of Sessions.tsx BEFORE the merge)
 *   Merge:   925a96c
 *
 * Scope of THIS task file:
 *   Only the syncSessionSpeakers function and its single caller in
 *   web-src/src/pages/EventForm/SessionManagement/Sessions.tsx. The full
 *   PR also touched dateTime helpers, SessionForm.tsx, LocationDialog.tsx,
 *   and VenueComponent.tsx are intentionally out of scope here.
 *
 *   Note: the original spec pointed at services/api.ts, but PR #101
 *   does not modify api.ts at all. The redundant-API-call optimisation
 *   the PR body describes lives in Sessions.tsx::syncSessionSpeakers,
 *   which is what this task scores.
 */

const SOURCE_FILE = `async function syncSessionSpeakers(
  sessionId: string,
  selectedIds: string[],
): Promise<void> {
  const speakersRes = await apiService.getSessionSpeakers(sessionId);
  const currentIds: string[] =
    speakersRes && !("error" in speakersRes)
      ? ((speakersRes as any)?.speakers ?? []).map((s: any) =>
          String(s.speakerId),
        )
      : [];
  const toRemove = currentIds.filter((id) => !selectedIds.includes(id));
  const toAdd = selectedIds.filter((id) => !currentIds.includes(id));
  await Promise.all(
    toRemove.map((id) => apiService.deleteSessionSpeaker(sessionId, id)),
  );
  const baseOrdinal = currentIds.length - toRemove.length;
  await Promise.all(
    toAdd.map((id, index) =>
      apiService.addSessionSpeaker(sessionId, {
        speakerId: id,
        speakerType: "Speaker",
        ordinal: baseOrdinal + index + 1,
      }),
    ),
  );
}

// ... single caller inside handleUpdateSession in the Sessions component:
    const shouldUpdateSpeakers = hasSessionSpeakersChanges(data);
    if (shouldUpdateSpeakers) {
      await syncSessionSpeakers(sessionId, data.speakerIds ?? []);
    }
`;

const ISSUE_TEXT = `API optimisation: drop the redundant getSessionSpeakers fetch in syncSessionSpeakers

The session-form save path already keeps a normalized list of the
session's CURRENT speaker IDs on \\\`data.originalSpeakerIds\\\` (populated
when the session is first hydrated). \\\`hasSessionSpeakersChanges(data)\\\`
already uses that list to decide whether sync is needed.

When sync proceeds, however, \\\`syncSessionSpeakers\\\` makes its OWN
\\\`apiService.getSessionSpeakers(sessionId)\\\` call to recompute the same
information, fetching what is already in memory. The extra round-trip
defeats the optimisation it sits inside.

Refactor: pass the already-known IDs into \\\`syncSessionSpeakers\\\` instead
of fetching them. The signature should accept a third \\\`currentSpeakerIds\\\`
parameter (string[]) and the body should diff against that parameter
rather than calling \\\`getSessionSpeakers\\\`. Update the single call site
in \\\`handleUpdateSession\\\` to pass \\\`data.originalSpeakerIds ?? []\\\`.

Keep the rest of the function (toRemove / toAdd diff, parallel
deletes, baseOrdinal arithmetic for adds) unchanged.`;

const GROUND_TRUTH_PATCH = `--- a/web-src/src/pages/EventForm/SessionManagement/Sessions.tsx
+++ b/web-src/src/pages/EventForm/SessionManagement/Sessions.tsx
@@ -222,20 +222,14 @@ async function upsertSessionTimeForSession(
 async function syncSessionSpeakers(
   sessionId: string,
   selectedIds: string[],
+  currentSpeakerIds: string[],
 ): Promise<void> {
-  const speakersRes = await apiService.getSessionSpeakers(sessionId);
-  const currentIds: string[] =
-    speakersRes && !("error" in speakersRes)
-      ? ((speakersRes as any)?.speakers ?? []).map((s: any) =>
-          String(s.speakerId),
-        )
-      : [];
-  const toRemove = currentIds.filter((id) => !selectedIds.includes(id));
-  const toAdd = selectedIds.filter((id) => !currentIds.includes(id));
+  const toRemove = currentSpeakerIds.filter((id) => !selectedIds.includes(id));
+  const toAdd = selectedIds.filter((id) => !currentSpeakerIds.includes(id));
   await Promise.all(
     toRemove.map((id) => apiService.deleteSessionSpeaker(sessionId, id)),
   );
-  const baseOrdinal = currentIds.length - toRemove.length;
+  const baseOrdinal = currentSpeakerIds.length - toRemove.length;
   await Promise.all(
     toAdd.map((id, index) =>
       apiService.addSessionSpeaker(sessionId, {
@@ -443,7 +437,7 @@ export const Sessions: React.FC = () => {

     const shouldUpdateSpeakers = hasSessionSpeakersChanges(data);
     if (shouldUpdateSpeakers) {
-      await syncSessionSpeakers(sessionId, data.speakerIds ?? []);
+      await syncSessionSpeakers(sessionId, data.speakerIds ?? [], data.originalSpeakerIds ?? []);
     }

     if (shouldUpdateSession || shouldUpdateSessionTime || shouldUpdateSpeakers) {
`;

export const sessionApiBatchOptimisation: Task = {
  id: "real-emc-session-api-batch-optimisation",
  type: "content",
  podId: "pod-emc-sessions",
  asOf: "2026-04-06T08:51:30-07:00",
  tags: ["real-emc", "api", "perf"],
  // Re-tiered to realistic-ticket (#8): exact parameter/call-site refactor + pasted source removed.
  prompt: [
    "# Issue",
    "API optimisation: drop the redundant getSessionSpeakers fetch in syncSessionSpeakers",
    "",
    "The session-form save path already keeps a normalized list of the session's current",
    "speaker IDs in memory (populated at hydration, and already used to decide whether a",
    "speaker sync is even needed). But when sync runs, `syncSessionSpeakers` makes its",
    "own `apiService.getSessionSpeakers` call to recompute that same list — an extra",
    "round-trip that defeats the optimisation it sits inside.",
    "",
    "Refactor so the sync uses the already-known IDs instead of re-fetching them, and",
    "keep the existing add/remove diffing and ordinal logic intact.",
    "",
    "The function and its caller are in",
    "`web-src/src/pages/EventForm/SessionManagement/Sessions.tsx`.",
    "",
    "# Output",
    "Return ONLY a unified diff (--- / +++ / @@) against `Sessions.tsx`. No prose, no full-file rewrite.",
  ].join("\n"),
  expectedSignals: [
    "syncSessionSpeakers",
    "currentSpeakerIds",
    "originalSpeakerIds",
    "getSessionSpeakers",
  ],
  groundTruth: {
    output: GROUND_TRUTH_PATCH,
    note: "adobecom/EMC PR #101, merge SHA 925a96c. Parent file at d6078f2. (Other files in this PR (utils/dateTime, SessionForm.tsx, LocationDialog.tsx, VenueComponent.tsx) are intentionally out of scope here. The original spec pointed at services/api.ts, but PR #101 does not touch that file; the redundant-API-call fix lives in Sessions.tsx.)",
  },
  rubric: {
    id: "real-emc-session-api-batch-optimisation-v1",
    criteria: [
      {
        id: "removes_redundant_fetch",
        description:
          "Does the patch remove the apiService.getSessionSpeakers(sessionId) call from inside syncSessionSpeakers? That call is the redundant round-trip. Boolean.",
        scale: "boolean",
        weight: 2,
      },
      {
        id: "adds_current_ids_param",
        description:
          "Does the patch add a new parameter to syncSessionSpeakers carrying the already-known speaker IDs (e.g. currentSpeakerIds: string[])? Boolean.",
        scale: "boolean",
        weight: 1.5,
      },
      {
        id: "updates_caller",
        description:
          "Does the patch update the single call site in handleUpdateSession to pass data.originalSpeakerIds (with a sensible default like ?? []) into syncSessionSpeakers? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "preserves_diff_logic",
        description:
          "Does the rest of the diff/sync logic remain intact (same toRemove / toAdd computation, same parallel deletes, same baseOrdinal arithmetic), just rewired to the parameter? Score 0-5.",
        scale: "0-5",
        weight: 1.5,
      },
      {
        id: "matches_ground_truth_intent",
        description:
          "Compared to the reference patch, does the agent's diff achieve the same effect (no extra GET call on session save when speakers change) regardless of exact formatting? Score 0-5.",
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
