import type { Task } from "../../types.js";

/**
 * Real EMC PR replayed as an eval task.
 *
 * Provenance:
 *   Repo:    adobecom/EMC (local: /Users/rkhan/emcV2/EMC)
 *   PR:      #130 — "MWPW 192537 : Implement session management enhancements with unsaved changes dialog"
 *   Parent:  6d8d812 (state of Sessions.tsx BEFORE the merge)
 *   Merge:   5350792
 *
 * Scope of THIS task file:
 *   Only web-src/src/pages/EventForm/SessionManagement/Sessions.tsx (the
 *   thin wiring layer that surfaces inline-form dirty state up to the
 *   parent FormWizard via a new optional callback). The actual dialog
 *   itself, the dirty-detection logic in SessionForm.tsx, the
 *   sessionHasOpenForm prop on EventForm, and the FormWizard
 *   integration are in OTHER files in the PR and are intentionally out
 *   of scope here.
 */

const SOURCE_FILE = `export const Sessions: React.FC = () => {
  const {
    eventId,
    mergeEventResponse,
    venueLocations,
    setVenueLocations,
    seriesSpeakers,
    setSeriesSpeakers,
    seriesId: contextSeriesId,
    formData,
  } = useEventFormContext();
  const [sessions, setSessions] = useState<Session[]>([]);
  // ... lots of session state and effects ...

  // ... near the bottom of the render, the SessionList that hosts the
  //     inline add/edit form receives the existing handlers and data:
          onCancelAdd={() => setIsAddingNew(false)}
          onAdd={handleAddSession}
          onDelete={handleDeleteSession}
          onSave={handleUpdateSession}
          venueLocations={venueLocations}
          seriesSpeakers={seriesSpeakers}
          onSpeakersRefresh={refreshSeriesSpeakers}
`;

const ISSUE_TEXT = `MWPW-192537: surface inline-session-form dirty state up to FormWizard

We are adding an "unsaved changes" confirmation dialog when a user
navigates away from a session form with edits pending. The dialog
itself lives in FormWizard; SessionForm already gains a dirty-detection
hook in this PR.

The middle component, \\\`Sessions\\\`, needs to forward the open/dirty
signal upward. Two thin changes are required in
\\\`web-src/src/pages/EventForm/SessionManagement/Sessions.tsx\\\`:

1. Define a \\\`SessionsProps\\\` interface with an optional
   \\\`onOpenFormChange?: (hasOpen: boolean) => void\\\` callback.
   Apply it to the \\\`Sessions\\\` component: change the type from
   \\\`React.FC\\\` to \\\`React.FC<SessionsProps>\\\` and destructure
   \\\`onOpenFormChange\\\` from props.

2. Pass that callback into the child \\\`SessionList\\\` via a new
   \\\`onDirtyChange\\\` prop, alongside the existing
   \\\`venueLocations\\\` / \\\`seriesSpeakers\\\` / \\\`onSpeakersRefresh\\\`
   props.

The internal session list / handler logic is unchanged. SessionList
itself accepts the new \\\`onDirtyChange\\\` prop separately (out of
scope here).`;

const GROUND_TRUTH_PATCH = `--- a/web-src/src/pages/EventForm/SessionManagement/Sessions.tsx
+++ b/web-src/src/pages/EventForm/SessionManagement/Sessions.tsx
@@ -247,7 +247,12 @@ async function syncSessionSpeakers(
   );
 }

-export const Sessions: React.FC = () => {
+interface SessionsProps {
+  /** Called whenever an inline session form opens or closes */
+  onOpenFormChange?: (hasOpen: boolean) => void;
+}
+
+export const Sessions: React.FC<SessionsProps> = ({ onOpenFormChange }) => {
   const {
     eventId,
     mergeEventResponse,
@@ -559,6 +564,7 @@ export const Sessions: React.FC = () => {
           venueLocations={venueLocations}
           seriesSpeakers={seriesSpeakers}
           onSpeakersRefresh={refreshSeriesSpeakers}
+          onDirtyChange={onOpenFormChange}
         />
       )}
     </div>
`;

export const sessionUnsavedChangesDialog: Task = {
  id: "real-emc-session-unsaved-changes-dialog",
  type: "content",
  podId: "pod-emc-sessions",
  asOf: "2026-04-13T14:18:15-07:00",
  tags: ["real-emc", "ui", "form-state"],
  prompt: [
    "# Issue",
    ISSUE_TEXT,
    "",
    "# Current source (web-src/src/pages/EventForm/SessionManagement/Sessions.tsx, parent commit 6d8d812)",
    "```tsx",
    SOURCE_FILE,
    "```",
    "",
    "# Output",
    "Return ONLY a unified diff (--- / +++ / @@) against `web-src/src/pages/EventForm/SessionManagement/Sessions.tsx`. No prose, no full-file rewrite.",
  ].join("\n"),
  expectedSignals: [
    "SessionsProps",
    "onOpenFormChange",
    "onDirtyChange",
    "hasOpen",
  ],
  groundTruth: {
    output: GROUND_TRUTH_PATCH,
    note: "adobecom/EMC PR #130, merge SHA 5350792. Parent file at 6d8d812. (Other files in this PR (FormWizard.tsx, EventForm.tsx, SessionForm.tsx, SessionList.tsx, SessionManagement/index.tsx) are intentionally out of scope here.)",
  },
  rubric: {
    id: "real-emc-session-unsaved-changes-dialog-v1",
    criteria: [
      {
        id: "adds_props_interface",
        description:
          "Does the patch introduce a SessionsProps interface (or equivalent typed props shape) that includes an optional onOpenFormChange callback typed roughly as (hasOpen: boolean) => void? Boolean.",
        scale: "boolean",
        weight: 1.5,
      },
      {
        id: "types_component",
        description:
          "Does the patch change the Sessions component's type from React.FC to React.FC<SessionsProps> (or any equivalent typed-props form) and actually destructure onOpenFormChange from props? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "forwards_to_child",
        description:
          "Does the patch forward the new callback into the SessionList child via a new onDirtyChange prop (or equivalent name matching what the issue requests)? Boolean.",
        scale: "boolean",
        weight: 2,
      },
      {
        id: "preserves_existing_props",
        description:
          "Are the existing props on the SessionList element (venueLocations, seriesSpeakers, onSpeakersRefresh, onAdd, onDelete, onSave, onCancelAdd) left intact? Score 0-5.",
        scale: "0-5",
        weight: 1.5,
      },
      {
        id: "no_unrelated_logic_changes",
        description:
          "Does the patch limit itself to the props plumbing (no edits to handleAddSession / handleUpdateSession / handleDeleteSession / load effects)? Score 0-5.",
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
      {
        id: "no_invented_dialog",
        description:
          "Does the patch avoid inventing a dialog component or modal in THIS file? The dialog itself lives in FormWizard (out of scope). Boolean.",
        scale: "boolean",
        weight: 1,
      },
    ],
  },
};
