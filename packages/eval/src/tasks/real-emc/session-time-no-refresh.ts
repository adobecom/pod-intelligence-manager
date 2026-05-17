import type { Task } from "../types.js";

/**
 * Real EMC PR replayed — vague-issue case.
 *
 * Provenance:
 *   Repo:   adobecom/EMC
 *   PR:     #124 — "session-fixes"
 *   Tip:    7d1588d ("fix: update continous session-time api without page refresh")
 *   Parent: 704fb11
 *   Merge:  19f50a2
 *
 * Why this PR for the eval:
 *   - One-line commit message, no Jira ticket, terse branch name "session-fixes".
 *   - The actual fix is a multi-spot refactor: change return type of two helpers,
 *     wire returned metadata (sessionTimeId, creationTime, modificationTime) into
 *     local React state so the UI doesn't need a page refresh.
 *   - Right answer is NOT derivable from the issue text alone — the agent must
 *     understand that the symptom ("page refresh required") comes from missing
 *     local state propagation of optimistic-concurrency timestamps.
 *   - pod-emc-sessions context contains the optimistic-concurrency learning
 *     and the speakerIds-with-originalSpeakerIds change-detection pattern.
 */

const SOURCE_FILE = `// web-src/src/pages/EventForm/SessionManagement/Sessions.tsx (relevant excerpt)

async function createSessionTimeForSession(
  eventId: string,
  sessionId: string,
  data: SessionFormData,
): Promise<void> {
  const tz = data.timezone || "UTC";
  const startTimeMillis = naiveDateTimeToUTCMillis(data.startDateTime, tz);
  const endTimeMillis = naiveDateTimeToUTCMillis(data.endDateTime, tz);
  const sessionTimeRes = await apiService.createSessionTime({
    eventId,
    sessionId,
    startTimeMillis,
    endTimeMillis,
    isAutoRegistrationEnabled: data.isAutoRegistrationEnabled !== false,
    ...(data.attendeeLimit && Number(data.attendeeLimit) > 0
      ? { attendeeLimit: Number(data.attendeeLimit) }
      : {}),
    ...(data.timezone ? { timezone: data.timezone } : {}),
    ...(data.locationId ? { locationId: data.locationId } : {}),
  });

  if ("error" in sessionTimeRes) {
    throw new Error(
      sessionTimeRes.error?.message || String(sessionTimeRes.error),
    );
  }
}

async function upsertSessionTimeForSession(
  eventId: string,
  sessionId: string,
  data: SessionFormData,
): Promise<void> {
  const tz = data.timezone || "UTC";
  const startTimeMillis = naiveDateTimeToUTCMillis(data.startDateTime, tz);
  const endTimeMillis = naiveDateTimeToUTCMillis(data.endDateTime, tz);
  if (!data.sessionTimeId) {
    await createSessionTimeForSession(eventId, sessionId, data);
    return;
  }

  const updateTimeRes = await apiService.updateSessionTime(
    data.sessionTimeId,
    { /* ...update payload... */ },
  );

  if ("error" in updateTimeRes) {
    throw new Error(
      updateTimeRes.error?.message || String(updateTimeRes.error),
    );
  }
}

// In handleAddSession (after speaker promises):
    try {
      await createSessionTimeForSession(eventId, newSession.id, data);
    } catch (err) {
      throw err;
    }

    await refreshEventConcurrencyMetadata(eventId);

    const sessionWithTime: Session = {
      ...newSession,
      // ...other fields...
      locationId: data.locationId,
      sessionTime: {
        startTimeMillis: naiveDateTimeToUTCMillis(data.startDateTime, data.timezone || "UTC"),
        endTimeMillis: naiveDateTimeToUTCMillis(data.endDateTime, data.timezone || "UTC"),
        isAutoRegistrationEnabled: data.isAutoRegistrationEnabled,
        attendeeLimit: data.attendeeLimit != null ? Number(data.attendeeLimit) : undefined,
        locationId: data.locationId,
      },
    };
    setSessions((prev) => sortSessionsByDate([...prev, sessionWithTime]));

// In handleUpdateSession:
    if (shouldUpdateSessionTime) {
      await upsertSessionTimeForSession(eventId, sessionId, data);
    }
    // ...later, when rebuilding session state in setSessions(...):
                sessionTimeId: data.sessionTimeId ?? s.sessionTime?.sessionTimeId,
`;

const ISSUE_TEXT = `session-fixes

fix: update continous session-time api without page refresh`;

const GROUND_TRUTH_PATCH = `--- a/web-src/src/pages/EventForm/SessionManagement/Sessions.tsx
+++ b/web-src/src/pages/EventForm/SessionManagement/Sessions.tsx
@@ -162,7 +162,7 @@ async function createSessionTimeForSession(
   eventId: string,
   sessionId: string,
   data: SessionFormData,
-): Promise<void> {
+): Promise<SessionTimeInfo> {
   const tz = data.timezone || "UTC";
   const startTimeMillis = naiveDateTimeToUTCMillis(data.startDateTime, tz);
   const endTimeMillis = naiveDateTimeToUTCMillis(data.endDateTime, tz);
@@ -184,19 +184,19 @@ async function createSessionTimeForSession(
       sessionTimeRes.error?.message || String(sessionTimeRes.error),
     );
   }
+  return sessionTimeRes as SessionTimeInfo;
 }

 async function upsertSessionTimeForSession(
   eventId: string,
   sessionId: string,
   data: SessionFormData,
-): Promise<void> {
+): Promise<SessionTimeInfo> {
   const tz = data.timezone || "UTC";
   const startTimeMillis = naiveDateTimeToUTCMillis(data.startDateTime, tz);
   const endTimeMillis = naiveDateTimeToUTCMillis(data.endDateTime, tz);
   if (!data.sessionTimeId) {
-    await createSessionTimeForSession(eventId, sessionId, data);
-    return;
+    return createSessionTimeForSession(eventId, sessionId, data);
   }

   const updateTimeRes = await apiService.updateSessionTime( ... );
@@ -222,6 +222,7 @@ async function upsertSessionTimeForSession(
       updateTimeRes.error?.message || String(updateTimeRes.error),
     );
   }
+  return updateTimeRes as SessionTimeInfo;
 }

 // In handleAddSession:
-    try {
-      await createSessionTimeForSession(eventId, newSession.id, data);
-    } catch (err) {
-      throw err;
-    }
+    const createdSessionTime = await createSessionTimeForSession(eventId, newSession.id, data);

     // In sessionWithTime.sessionTime, ALSO include:
+        sessionTimeId: createdSessionTime.sessionTimeId,
+        creationTime: createdSessionTime.creationTime,
+        modificationTime: createdSessionTime.modificationTime,

 // In handleUpdateSession:
+    let updatedSessionTime: SessionTimeInfo | undefined
     if (shouldUpdateSessionTime) {
-      await upsertSessionTimeForSession(eventId, sessionId, data);
+      updatedSessionTime = await upsertSessionTimeForSession(eventId, sessionId, data);
     }
     // In the setSessions rebuild, REPLACE sessionTimeId line with:
-                sessionTimeId: data.sessionTimeId ?? s.sessionTime?.sessionTimeId,
+                sessionTimeId: updatedSessionTime?.sessionTimeId ?? data.sessionTimeId ?? s.sessionTime?.sessionTimeId,
+                creationTime: updatedSessionTime?.creationTime ?? s.sessionTime?.creationTime,
+                modificationTime: updatedSessionTime?.modificationTime ?? s.sessionTime?.modificationTime,
`;

export const sessionTimeNoRefresh: Task = {
  id: "real-emc-session-time-no-refresh",
  type: "content",
  podId: "pod-emc-sessions",
  tags: ["real-emc", "vague-issue", "session"],
  prompt: [
    "# Issue",
    ISSUE_TEXT,
    "",
    "# Current source (web-src/src/pages/EventForm/SessionManagement/Sessions.tsx, parent commit 704fb11)",
    "```tsx",
    SOURCE_FILE,
    "```",
    "",
    "# Output",
    "Return ONLY a unified diff (--- / +++ / @@) against `Sessions.tsx` that fixes the bug. No prose.",
  ].join("\n"),
  expectedSignals: ["SessionTimeInfo", "modificationTime", "creationTime", "sessionTimeId", "return"],
  groundTruth: {
    output: GROUND_TRUTH_PATCH,
    note: "adobecom/EMC PR #124, merge SHA 19f50a2. Parent file at 704fb11. Ground truth is presented as a logical patch summary rather than line-perfect because the real diff touches several non-contiguous spots.",
  },
  rubric: {
    id: "real-emc-session-time-no-refresh-v1",
    criteria: [
      {
        id: "identifies_return_type_change",
        description:
          "Does the patch change `createSessionTimeForSession` and/or `upsertSessionTimeForSession` from `Promise<void>` to a Promise returning SessionTimeInfo (or equivalent shape)? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "returns_api_response",
        description:
          "Do the helpers actually `return` the API response value instead of dropping it? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "propagates_timestamps_to_state",
        description:
          "Does the calling code (handleAddSession and/or handleUpdateSession) capture the helper's return value and store the optimistic-concurrency timestamps (modificationTime, creationTime) plus sessionTimeId into local React session state? This is the actual fix for 'without page refresh'. Score 0-5.",
        scale: "0-5",
        weight: 3,
      },
      {
        id: "matches_ground_truth_intent",
        description:
          "Compared to the reference, does the agent's diff achieve the same effect: helpers return data, state is updated locally so no full refresh is required? Score 0-5.",
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
        id: "no_invented_apis",
        description:
          "Does the patch avoid inventing methods or props not shown in the source (e.g., a non-existent refetch endpoint, an invented React hook)? Boolean.",
        scale: "boolean",
        weight: 1,
      },
    ],
  },
};
