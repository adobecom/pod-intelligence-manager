import type { Task } from "../../types.js";

/**
 * Real EMC PR replayed as an eval task.
 *
 * Provenance:
 *   Repo:    adobecom/EMC (local: /Users/rkhan/emcV2/EMC)
 *   PR:      #135 — "Add toast for session API errors"
 *   Parent:  e477b74 (state of SessionForm.tsx BEFORE the merge)
 *   Merge:   7c86403
 *
 * Why this PR was chosen:
 *   - Three-hunk diff with a clear add-toast surface: import useToast,
 *     initialize it inside the component, and surface both success and
 *     error toasts at the save call site.
 *   - Tests whether the agent uses the existing `useToast` from the shared
 *     contexts (not Spectrum's notification primitives or a custom shim).
 *   - Tracks: should the success toast distinguish create vs update?
 *     (PR answer: yes — uses `isEditMode` to pick the message.)
 */

const SOURCE_FILE = `import {
  // ...
} from "@react-spectrum/s2"
import {
  CalendarDate,
  Time,
} from "@internationalized/date";
import { Session } from "../../../types/sessions";
import { EventTag, SeriesSpeaker } from "../../../types/domain";
import { apiService } from "../../../services/api";
import { useEventFormContext } from "../../../contexts";
import { RichTextEditor, TagSelector } from "../../../components/shared";
import {
  dateAndTimeToISO,
  millisToNaiveDateTimeString,
  parseTimeFromDateTime,
  safeParseDateTimeString,
} from "../../../utils/dateTime";

// ...

export const SessionForm: React.FC<SessionFormProps> = ({
  session,
  onSave,
  onCancel,
  venueLocations: venueLocationsProp,
  seriesSpeakers: seriesSpeakersProp,
  onSpeakersRefresh: onSpeakersRefreshProp,
  onDirtyChange,
}) => {
  const isEditMode = session !== null;
  const { seriesId: contextSeriesId, formData, locale } = useEventFormContext();
  const seriesId = contextSeriesId || formData.seriesId || "";

  // ... lots of state ...

  const handleSave = async () => {
    if (!date || !startTime || !endTime || !name.trim() || !description.trim()) return;
    setSaveError(null);
    setSaving(true);
    const startDateTime = dateAndTimeToISO(date, startTime);
    const endDateTime = dateAndTimeToISO(date, endTime);
    try {
      await onSave({
        name: name.trim(),
        description: description.trim(),
        startDateTime,
        endDateTime,
        tags: tagsToString(selectedTags),
        isAutoRegistrationEnabled,
        attendeeLimit: !isAutoRegistrationEnabled && attendeeLimitEnabled && attendeeLimit
          ? Number(attendeeLimit)
          : undefined,
        ...(isEditMode &&
        (sessionTimestamps.creationTime != null ||
          sessionTimestamps.modificationTime != null)
          ? {
              creationTime: sessionTimestamps.creationTime,
              modificationTime: sessionTimestamps.modificationTime,
            }
          : {}),
        ...(isEditMode && sessionTimeMeta.sessionTimeId
          ? {
              sessionTimeId: sessionTimeMeta.sessionTimeId,
              sessionTimeCreationTime: sessionTimeMeta.creationTime,
              sessionTimeModificationTime: sessionTimeMeta.modificationTime,
            }
          : {}),
        speakerIds: selectedSpeakers.map((s) => s.speakerId),
        ...(isEditMode ? { originalSpeakerIds } : {}),
        timezone: formData.timezone || undefined,
        locationId: selectedLocationId ?? undefined,
      });
      onCancel(); // unmounts this component — no state updates after this
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save");
      setSaving(false);
    }
  };
`;

const ISSUE_TEXT = `Add toast for session API errors

Resolves: MWPW-193406

Today the only feedback when a session save fails is a hidden
\`saveError\` state. The user sees nothing immediately — they have to
scroll the form to find the error. Add a toast so failures surface
immediately, even if the user has navigated away from the error region.

Behavior:
- Import the existing \`useToast\` from the shared contexts barrel
  (same module that already exposes \`useEventFormContext\`).
- Call \`useToast()\` inside SessionForm to obtain a \`toast\` handle.
- On successful save: show \`toast.success(...)\` with a message that
  distinguishes "updated" vs "created" using the existing \`isEditMode\`
  flag.
- On caught error in handleSave: still set \`saveError\` for the inline
  region, but also call \`toast.error(message, { duration: 8000 })\`
  with the same human-readable message.`;

const GROUND_TRUTH_PATCH = `--- a/web-src/src/pages/EventForm/SessionManagement/SessionForm.tsx
+++ b/web-src/src/pages/EventForm/SessionManagement/SessionForm.tsx
@@ -25,7 +25,7 @@ import {
 import { Session } from "../../../types/sessions";
 import { EventTag, SeriesSpeaker } from "../../../types/domain";
 import { apiService } from "../../../services/api";
-import { useEventFormContext } from "../../../contexts";
+import { useEventFormContext, useToast } from "../../../contexts";
 import { RichTextEditor, TagSelector } from "../../../components/shared";
 import {
   dateAndTimeToISO,
@@ -162,6 +162,7 @@ export const SessionForm: React.FC<SessionFormProps> = ({
 }) => {
   const isEditMode = session !== null;
   const { seriesId: contextSeriesId, formData, locale } = useEventFormContext();
+  const toast = useToast();
   const seriesId = contextSeriesId || formData.seriesId || "";

   const [loadingDetails, setLoadingDetails] = useState(
@@ -421,9 +422,12 @@ export const SessionForm: React.FC<SessionFormProps> = ({
         timezone: formData.timezone || undefined,
         locationId: selectedLocationId ?? undefined,
       });
+      toast.success(isEditMode ? "Session updated successfully" : "Session created successfully");
       onCancel(); // unmounts this component — no state updates after this
     } catch (err) {
-      setSaveError(err instanceof Error ? err.message : "Failed to save");
+      const msg = err instanceof Error ? err.message : "Failed to save";
+      setSaveError(msg);
+      toast.error(msg, { duration: 8000 });
       setSaving(false);
     }
   };
`;

export const sessionApiErrorToast: Task = {
  id: "real-emc-session-api-error-toast",
  type: "content",
  podId: "pod-emc-sessions",
  asOf: "2026-04-30T13:31:18-07:00",
  tags: ["real-emc", "ui", "toast", "error-handling"],
  // Re-tiered to realistic-ticket (#8): exact toast API/duration steps + pasted source removed.
  prompt: [
    "# Issue",
    "Add toast for session API errors",
    "",
    "Resolves: MWPW-193406",
    "",
    "Right now the only feedback when a session save fails is a hidden inline `saveError`",
    "state — the user sees nothing immediately and has to scroll the form to find it.",
    "Surface save failures via a toast so they're visible right away even if the user",
    "has scrolled away from the inline error region. On a successful save, show a",
    "confirmation toast too (wording should reflect whether it was a create or an",
    "update). Keep the existing inline error behavior as well.",
    "",
    "Use the app's existing toast mechanism. The component is",
    "`web-src/src/pages/EventForm/SessionManagement/SessionForm.tsx`.",
    "",
    "# Output",
    "Return ONLY a unified diff (--- / +++ / @@) against the SessionForm component. No prose, no full-file rewrite.",
  ].join("\n"),
  expectedSignals: [
    "useToast",
    "toast.error",
    "toast.success",
    "isEditMode",
    "duration",
  ],
  groundTruth: {
    output: GROUND_TRUTH_PATCH,
    note: "adobecom/EMC PR #135, merge SHA 7c86403. Parent file at e477b74.",
  },
  rubric: {
    id: "real-emc-session-api-error-toast-v1",
    criteria: [
      {
        id: "imports_use_toast_from_contexts",
        description:
          "Does the patch add `useToast` to the named import from `../../../contexts` (the same module already exporting `useEventFormContext`)? Score 0-5: 0=imports from a different module / not imported, 5=correctly added to the existing import.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "initializes_toast_in_component",
        description:
          "Does the patch call `useToast()` inside the SessionForm component body and bind it to a `toast` const? Boolean.",
        scale: "boolean",
        weight: 1.5,
      },
      {
        id: "calls_toast_error_on_catch",
        description:
          "Does the catch block of `handleSave` call `toast.error(...)` with the caught error message (still preserving `setSaveError`)? Score 0-5: 0=no toast on error, 5=both setSaveError and toast.error called with the same human-readable message.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "calls_toast_success_on_save",
        description:
          "Does the patch add a `toast.success(...)` call in the success branch of `handleSave` (after `await onSave` resolves and before `onCancel()`)? Boolean.",
        scale: "boolean",
        weight: 1.5,
      },
      {
        id: "success_message_distinguishes_edit_mode",
        description:
          "Does the success message differ between edit and create (using `isEditMode` to pick wording like 'updated' vs 'created')? Boolean.",
        scale: "boolean",
        weight: 1,
      },
      {
        id: "preserves_save_error_state",
        description:
          "Does the patch still call `setSaveError` (or equivalent) in the catch branch so the inline error region also updates? Boolean.",
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
