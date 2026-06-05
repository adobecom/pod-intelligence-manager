import type { Task } from "../../types.js";

/**
 * Real EMC PR replayed as an eval task — housestyle category.
 *
 * Provenance:
 *   Repo:    adobecom/EMC (local: /Users/rkhan/emcV2/EMC)
 *   PR:      #143 — "[MWPW-193406]: Add validation to block same location for same time in session"
 *   Parent:  7c86403cefd0261010f631c2dd4096efc99b9d2a
 *   Merge:   808252410a4c7ee48ebbee109e7db75bf8391eea
 *
 * Why this PR was chosen for the housestyle bucket:
 *   - "Block conflicting saves on the FE" admits many implementations: a hook,
 *     a util in dateTime.ts, a server roundtrip on blur, etc. The EMC pod's
 *     established convention is a `useMemo`-derived validity flag inside the
 *     form component, surfaced via `isInvalid` on the ComboBox + an inline
 *     red error message + gating `canSave` (mirrors the existing
 *     `isEndTimeInvalid`, `isStartTimeBeforeEventStart` patterns in this same
 *     file).
 *   - The overlap formula (max(a.start, b.start) < min(a.end, b.end), or the
 *     equivalent `currentStart < sEnd && currentEnd > sStart`) is easy to get
 *     subtly wrong (e.g., `<=` instead of `<` makes back-to-back sessions
 *     collide).
 *   - Self-exclusion when editing is a foot-gun the agent has to remember:
 *     without it, every edit-mode save fails its own time slot.
 *   - The session-times API stores start/end as **UTC millis** with a separate
 *     event timezone — the form holds naive local strings, so the comparison
 *     must convert via `naiveDateTimeToUTCMillis` before checking overlap.
 */

const SOURCE_FILE = `// --------------------------------------------------------------------------
// web-src/src/pages/EventForm/SessionManagement/SessionForm.tsx (excerpt)
// --------------------------------------------------------------------------

import {
  dateAndTimeToISO,
  millisToNaiveDateTimeString,
  parseTimeFromDateTime,
  safeParseDateTimeString,
} from "../../../utils/dateTime"
// NOTE: dateTime.ts also exports \`naiveDateTimeToUTCMillis(isoNaive, tz)\`
// which is already used by Sessions.tsx to convert form date+time strings
// into the UTC-millis shape stored on session-time records.

interface SessionFormProps {
  session: Session | null
  onSave: (data: SessionFormData) => Promise<void>
  onCancel: () => void
  venueLocations?: VenueLocation[]
  seriesSpeakers?: SeriesSpeaker[]
  onSpeakersRefresh?: () => Promise<void>
  onDirtyChange?: (isDirty: boolean) => void
  // ... no overlap-related prop yet ...
}

export const SessionForm: React.FC<SessionFormProps> = ({ session, onSave, /* ... */ }) => {
  const isEditMode = session !== null
  const { seriesId: contextSeriesId, formData, locale } = useEventFormContext()
  // formData.timezone is the IANA TZ inherited from the event (e.g. "America/Los_Angeles").
  // ... most state omitted ...
  const [selectedLocationId, setSelectedLocationId] = useState<string | null>(session?.locationId ?? null)
  const [date, setDate] = useState<CalendarDate | null>(/* ... */)
  const [startTime, setStartTime] = useState<Time | null>(/* ... */)
  const [endTime, setEndTime] = useState<Time | null>(/* ... */)

  // Existing validation flags (pattern to mirror)
  const isEndTimeInvalid = Boolean(
    startTime && endTime && (endTime.hour < startTime.hour ||
      (endTime.hour === startTime.hour && endTime.minute <= startTime.minute)),
  )
  // ... other validity flags ...

  const canSave = Boolean(
    name.trim() && description.trim() && date && startTime && endTime &&
    !isDateOutOfRange && !isEndTimeInvalid &&
    !isStartTimeBeforeEventStart && !isEndTimeAfterEventEnd &&
    !isCapacityMissing,
  )

  // Location ComboBox (current render — no error surface yet)
  // <ComboBox
  //   label="Location"
  //   selectedKey={selectedLocationId ?? undefined}
  //   onSelectionChange={(key) => setSelectedLocationId(key ? String(key) : null)}
  //   isDisabled={venueLocations.length === 0}
  // >
  //   {venueLocations.map((loc) => (<ComboBoxItem key={loc.locationId} id={loc.locationId}>{loc.name}</ComboBoxItem>))}
  // </ComboBox>
}

// --------------------------------------------------------------------------
// web-src/src/pages/EventForm/SessionManagement/SessionList.tsx (excerpt)
// --------------------------------------------------------------------------

export interface SessionItemProps {
  session: Session
  isExpanded: boolean
  onToggle: (sessionId: string) => void
  onDelete: (sessionId: string) => void
  onSave: (sessionId: string, data: SessionFormData) => Promise<void>
  venueLocations: VenueLocation[]
  seriesSpeakers: SeriesSpeaker[]
  onSpeakersRefresh: () => Promise<void>
  onDirtyChange?: (isDirty: boolean) => void
  // ... no allSessions prop yet ...
}

export interface SessionsListProps {
  sessions: Session[]
  isAddingNew: boolean
  // ... other props omitted ...
  // ... no allSessions prop yet ...
}

// --------------------------------------------------------------------------
// web-src/src/pages/EventForm/SessionManagement/Sessions.tsx (excerpt)
// --------------------------------------------------------------------------

// State holds the full \`sessions\` array. It is currently passed into
// <SessionsList sessions={sessions} ... /> but is NOT threaded into the
// individual SessionForm instances for overlap checks.

// --------------------------------------------------------------------------
// Reference: Session type (web-src/src/types/sessions.ts)
//   interface Session {
//     id: string
//     name?: string
//     description?: string
//     startDateTime: string            // naive local string ("YYYY-MM-DDTHH:mm")
//     endDateTime: string              //   ditto
//     locationId?: string
//     sessionTime?: {
//       startTimeMillis?: number       // UTC millis (authoritative)
//       endTimeMillis?: number         //   ditto
//       isAutoRegistrationEnabled?: boolean
//       attendeeLimit?: number
//     }
//   }
// --------------------------------------------------------------------------
`;

const ISSUE_TEXT = `feat(sessions): block same-location overlapping-time saves on the FE

The backend is adding a guard that rejects two sessions scheduled at the same
location during overlapping times. Relying on the BE alone has three drawbacks:

- UX: users only see the conflict after a full round-trip at submit time,
  with no inline signal at the point of entry.
- Cost: the BE check involves a paginated scan over all session-time-locations
  for the venue on every save attempt; catching it on the FE avoids the request.
- Race conditions: BE validate + write is not fully atomic, so two concurrent
  saves can still slip conflicting records through.

Add a frontend pre-save validation that blocks the conflict before the BE call.
Two sessions only conflict if they share the same location AND their time
intervals overlap. Two sessions with no location, or with different locations,
should never conflict.`;

const GROUND_TRUTH_PATCH = `--- a/web-src/src/pages/EventForm/SessionManagement/SessionForm.tsx
+++ b/web-src/src/pages/EventForm/SessionManagement/SessionForm.tsx
@@ -30,6 +30,7 @@ import { RichTextEditor, TagSelector } from "../../../components/shared";
 import {
   dateAndTimeToISO,
   millisToNaiveDateTimeString,
+  naiveDateTimeToUTCMillis,
   parseTimeFromDateTime,
   safeParseDateTimeString,
 } from "../../../utils/dateTime";
@@ -136,6 +137,8 @@ interface SessionFormProps {
   onSpeakersRefresh?: () => Promise<void>;
   /** Called when the form's dirty state changes (true = has unsaved edits) */
   onDirtyChange?: (isDirty: boolean) => void;
+  /** All sibling sessions in this event — used for time/location overlap detection */
+  allSessions?: Session[];
 }

@@ -159,6 +162,7 @@ export const SessionForm: React.FC<SessionFormProps> = ({
   seriesSpeakers: seriesSpeakersProp,
   onSpeakersRefresh: onSpeakersRefreshProp,
   onDirtyChange,
+  allSessions,
 }) => {
   const isEditMode = session !== null;
@@ -475,11 +479,27 @@ export const SessionForm: React.FC<SessionFormProps> = ({
     (!attendeeLimit.trim() || Number(attendeeLimit) <= 0),
   );

+  const hasLocationConflict = useMemo(() => {
+    if (!selectedLocationId || !date || !startTime || !endTime) return false
+    if (isEndTimeInvalid) return false
+    const tz = formData.timezone || 'UTC'
+    const currentStart = naiveDateTimeToUTCMillis(dateAndTimeToISO(date, startTime), tz)
+    const currentEnd = naiveDateTimeToUTCMillis(dateAndTimeToISO(date, endTime), tz)
+    return (allSessions ?? []).some((s) => {
+      if (s.id === session?.id) return false
+      if (s.locationId !== selectedLocationId) return false
+      const sStart = s.sessionTime?.startTimeMillis
+      const sEnd = s.sessionTime?.endTimeMillis
+      if (sStart == null || sEnd == null) return false
+      return currentStart < sEnd && currentEnd > sStart
+    })
+  }, [selectedLocationId, date, startTime, endTime, allSessions, session?.id, formData.timezone, isEndTimeInvalid])
+
   const canSave = Boolean(
     name.trim() && description.trim() && date && startTime && endTime &&
     !isDateOutOfRange && !isEndTimeInvalid &&
     !isStartTimeBeforeEventStart && !isEndTimeAfterEventEnd &&
-    !isCapacityMissing,
+    !isCapacityMissing && !hasLocationConflict,
   );
@@ -593,11 +613,17 @@ export const SessionForm: React.FC<SessionFormProps> = ({
         selectedKey={selectedLocationId ?? undefined}
         onSelectionChange={(key) => setSelectedLocationId(key ? String(key) : null)}
         isDisabled={venueLocations.length === 0}
+        isInvalid={hasLocationConflict}
       >
         {venueLocations.map((loc) => (
           <ComboBoxItem key={loc.locationId} id={loc.locationId}>{loc.name}</ComboBoxItem>
         ))}
       </ComboBox>
+      {hasLocationConflict && (
+        <Text UNSAFE_style={{ color: "var(--spectrum-global-color-red-600)", fontSize: "12px" }}>
+          This location is already booked for another session at an overlapping time.
+        </Text>
+      )}

--- a/web-src/src/pages/EventForm/SessionManagement/SessionList.tsx
+++ b/web-src/src/pages/EventForm/SessionManagement/SessionList.tsx
@@ -52,6 +52,7 @@ export interface SessionItemProps {
   seriesSpeakers: SeriesSpeaker[];
   onSpeakersRefresh: () => Promise<void>;
   onDirtyChange?: (isDirty: boolean) => void;
+  allSessions: Session[];
 }
@@ -198,6 +201,7 @@ export interface SessionsListProps {
   onSpeakersRefresh: () => Promise<void>;
   onDirtyChange?: (isDirty: boolean) => void;
+  allSessions: Session[];
 }
 // (allSessions threaded through SessionsList -> SessionItem -> SessionForm
 //  for both the add-new form and each expanded edit form.)

--- a/web-src/src/pages/EventForm/SessionManagement/Sessions.tsx
+++ b/web-src/src/pages/EventForm/SessionManagement/Sessions.tsx
@@ -561,6 +561,7 @@ export const Sessions: React.FC<SessionsProps> = ({ onOpenFormChange }) => {
           seriesSpeakers={seriesSpeakers}
           onSpeakersRefresh={refreshSeriesSpeakers}
           onDirtyChange={onOpenFormChange}
+          allSessions={sessions}
         />
`;

export const sessionLocationTimeOverlap: Task = {
  id: "real-emc-session-location-time-overlap",
  type: "content",
  podId: "pod-emc-sessions",
  asOf: "2026-05-01T08:47:06-07:00",
  tags: ["real-emc", "housestyle", "session"],
  prompt: [
    "# Issue",
    ISSUE_TEXT,
    "",
    "# Current source (three files in web-src/src/pages/EventForm/SessionManagement/, parent commit 7c86403)",
    "```tsx",
    SOURCE_FILE,
    "```",
    "",
    "# Output",
    "Return ONLY a unified diff (--- / +++ / @@) covering the file(s) you need to change. No prose, no full-file rewrites.",
  ].join("\n"),
  expectedSignals: ["locationId", "startTimeMillis", "endTimeMillis", "overlap"],
  groundTruth: {
    output: GROUND_TRUTH_PATCH,
    note: "adobecom/EMC PR #143, merge SHA 808252. Parent at 7c86403. SessionList.tsx hunks trimmed to the prop-threading additions; full file passes `allSessions` through every JSX site.",
  },
  rubric: {
    id: "real-emc-session-location-time-overlap-v1",
    criteria: [
      {
        id: "computes_overlap",
        description:
          "Does the patch compute time-range overlap correctly — i.e., `currentStart < otherEnd && currentEnd > otherStart` (equivalent to `max(a.start, b.start) < min(a.end, b.end)`)? Watch for off-by-one bugs: `<=` instead of `<` makes back-to-back sessions falsely collide. Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "scopes_to_same_location",
        description:
          "Does the check only fire for sessions sharing the same `locationId` (so two sessions with no location, or two sessions at different locations, are NOT considered conflicting)? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "blocks_save_with_feedback",
        description:
          "Does the patch surface validation feedback (inline error message and/or `isInvalid` on the location control, and/or disabled save button) rather than only silently failing on submit? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "excludes_self_when_editing",
        description:
          "When editing an existing session, does the check exclude the current session (e.g., `s.id !== session?.id`) so the session does not collide with its own time slot? Score 0-5.",
        scale: "0-5",
        weight: 1.5,
      },
      {
        id: "matches_ground_truth_intent",
        description:
          "Compared to the reference patch, does the agent's diff achieve the same effect (overlap math + same-location scoping + self-exclusion + UI feedback) regardless of exact formatting? Score 0-5.",
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
