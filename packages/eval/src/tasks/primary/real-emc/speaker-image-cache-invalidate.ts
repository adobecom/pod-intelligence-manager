import type { Task } from "../../types.js";

/**
 * Real EMC PR replayed as an eval task.
 *
 * Provenance:
 *   Repo:    adobecom/EMC (local: /Users/rkhan/emcV2/EMC)
 *   PR:      #158 — "[MWPW-195871] Fix: Speaker image update and delete not reflecting in table"
 *   Parent:  84f21c9d968beaaac01eebca2dc1b2cb853a1b68 (state of SpeakerFormDialog.tsx BEFORE the merge)
 *   Merge:   0d38019eddcb4e0f63af0a1af69c3891f8460d99
 */

const SOURCE_FILE = `// SpeakerFormDialog.tsx — relevant excerpts at parent 84f21c9

export interface SpeakerFormSubmitData {
  firstName: string
  lastName: string
  socialLinks: SocialLink[]
  localizationDrafts: Record<string, SpeakerDashboardLocalizationDraft>
}

interface FormState {
  firstName: string
  lastName: string
  socialLinks: SocialLinkFormData[]
  imageUrl?: string
  imageId?: string
}

export const SpeakerFormDialog: React.FC<SpeakerFormDialogProps> = ({
  isOpen,
  onClose,
  onSubmit,
  speaker,
  seriesId: _seriesId,
  isSubmitting,
  cascadeToEvents,
}) => {
  void _seriesId
  const [formState, setFormState] = useState<FormState>(initialFormState)
  const [localizationDrafts, setLocalizationDrafts] = useState<
    Record<string, SpeakerDashboardLocalizationDraft>
  >(emptyLocalizationDrafts)
  const [selectedLocale, setSelectedLocale] = useState<string>(DEFAULT_LOCALE)
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [shouldCascade, setShouldCascade] = useState(cascadeToEvents ?? false)

  // ...

  useEffect(() => {
    if (isOpen && speaker) {
      setFormState({
        firstName: speaker.firstName || '',
        lastName: speaker.lastName || '',
        socialLinks: speaker.socialLinks?.map((link) => fromApiSocialLink(link)) || [],
        imageUrl: speaker.photo?.imageUrl,
        imageId: speaker.photo?.imageId,
      })
      setLocalizationDrafts(localizationDraftsFromSpeaker(speaker))
      setSelectedLocale(DEFAULT_LOCALE)
      setShouldCascade(cascadeToEvents ?? false)
    } else if (isOpen) {
      setFormState(initialFormState)
      setLocalizationDrafts(emptyLocalizationDrafts())
      setSelectedLocale(DEFAULT_LOCALE)
      setPendingFile(null)
      setShouldCascade(false)
    }
  }, [isOpen, speaker, cascadeToEvents])

  // ... other handlers ...

  const handleFileRemove = useCallback(() => {
    setPendingFile(null)
    updateField('imageUrl', undefined)
    updateField('imageId', undefined)
  }, [updateField])

  const handleSubmit = useCallback(async () => {
    if (!formState.firstName.trim() || !formState.lastName.trim()) {
      return
    }

    const data: SpeakerFormSubmitData = {
      firstName: formState.firstName.trim(),
      lastName: formState.lastName.trim(),
      socialLinks: formState.socialLinks
        .filter((link) => link.url.trim())
        .map((link) => toApiSocialLink(link)),
      localizationDrafts: { ...localizationDrafts },
    }

    await onSubmit(data, pendingFile ?? undefined, { cascadeToEvents: shouldCascade })
  }, [formState, localizationDrafts, pendingFile, shouldCascade, onSubmit])
`;

const ISSUE_TEXT = `Fix: Speaker image update and delete not reflecting in dashboard table

After saving a new image the table shows the stale photo, and removing an
image has no effect because no DELETE is sent. The parent's handleFormSubmit
needs to know when a previously-saved image was removed so it can call
deleteSpeakerImage.

SpeakerFormDialog must track the removed image's id when the user clears a
saved image (handleFileRemove) and forward it to the parent through the
SpeakerFormSubmitData payload (new optional field removedImageId). State
must reset on open/close like other form fields.`;

const GROUND_TRUTH_PATCH = `--- a/web-src/src/pages/SpeakersDashboard/SpeakerFormDialog.tsx
+++ b/web-src/src/pages/SpeakersDashboard/SpeakerFormDialog.tsx
@@ -54,6 +54,7 @@ export interface SpeakerFormSubmitData {
   lastName: string
   socialLinks: SocialLink[]
   localizationDrafts: Record<string, SpeakerDashboardLocalizationDraft>
+  removedImageId?: string
 }

 interface SpeakerFormDialogProps {
@@ -122,6 +123,7 @@ export const SpeakerFormDialog: React.FC<SpeakerFormDialogProps> = ({
   >(emptyLocalizationDrafts)
   const [selectedLocale, setSelectedLocale] = useState<string>(DEFAULT_LOCALE)
   const [pendingFile, setPendingFile] = useState<File | null>(null)
+  const [removedImageId, setRemovedImageId] = useState<string | undefined>(undefined)
   const [shouldCascade, setShouldCascade] = useState(cascadeToEvents ?? false)

   const isEditing = !!speaker
@@ -144,11 +146,13 @@ export const SpeakerFormDialog: React.FC<SpeakerFormDialogProps> = ({
       setLocalizationDrafts(localizationDraftsFromSpeaker(speaker))
       setSelectedLocale(DEFAULT_LOCALE)
       setShouldCascade(cascadeToEvents ?? false)
+      setRemovedImageId(undefined)
     } else if (isOpen) {
       setFormState(initialFormState)
       setLocalizationDrafts(emptyLocalizationDrafts())
       setSelectedLocale(DEFAULT_LOCALE)
       setPendingFile(null)
+      setRemovedImageId(undefined)
       setShouldCascade(false)
     }
   }, [isOpen, speaker, cascadeToEvents])
@@ -217,10 +221,11 @@ export const SpeakerFormDialog: React.FC<SpeakerFormDialogProps> = ({
   }, [])

   const handleFileRemove = useCallback(() => {
+    setRemovedImageId(formState.imageId)
     setPendingFile(null)
     updateField('imageUrl', undefined)
     updateField('imageId', undefined)
-  }, [updateField])
+  }, [updateField, formState.imageId])

   const handleSubmit = useCallback(async () => {
     if (!formState.firstName.trim() || !formState.lastName.trim()) {
@@ -234,6 +239,7 @@ export const SpeakerFormDialog: React.FC<SpeakerFormDialogProps> = ({
         .filter((link) => link.url.trim())
         .map((link) => toApiSocialLink(link)),
       localizationDrafts: { ...localizationDrafts },
+      removedImageId,
     }

     await onSubmit(data, pendingFile ?? undefined, { cascadeToEvents: shouldCascade })
`;

export const speakerImageCacheInvalidate: Task = {
  id: "real-emc-speaker-image-cache-invalidate",
  type: "content",
  podId: "pod-emc-sessions",
  asOf: "2026-05-20T09:34:03-07:00",
  tags: ["real-emc", "speakers", "dashboard", "form-state"],
  // Re-tiered to realistic-ticket (#8): named field/edit list + pasted source removed.
  prompt: [
    "# Issue",
    "Fix: Speaker image update and delete not reflecting in dashboard table",
    "",
    "After saving a new speaker image the dashboard table still shows the old photo, and",
    "removing a saved image does nothing because no DELETE is ever sent. The parent that",
    "handles the form submit has no way to know a previously-saved image was cleared, so",
    "it can't issue the delete.",
    "",
    "Give the SpeakerFormDialog a way to tell its parent, on submit, that a previously",
    "saved image was removed, so the parent can invalidate/delete it. Make sure this",
    "tracking resets cleanly when the dialog opens/closes, like the other form fields.",
    "",
    "The dialog is `web-src/src/pages/SpeakersDashboard/SpeakerFormDialog.tsx`.",
    "",
    "# Output",
    "Return ONLY a unified diff (--- / +++ / @@) against the SpeakerFormDialog component. No prose, no full-file rewrite.",
  ].join("\n"),
  expectedSignals: [
    "removedImageId",
    "setRemovedImageId",
    "handleFileRemove",
    "formState.imageId",
    "SpeakerFormSubmitData",
  ],
  groundTruth: {
    output: GROUND_TRUTH_PATCH,
    note: "adobecom/EMC PR #158, merge SHA 0d38019. Parent file at 84f21c9.",
  },
  rubric: {
    id: "real-emc-speaker-image-cache-invalidate-v1",
    criteria: [
      {
        id: "adds_removed_image_id_to_submit_type",
        description:
          "Does the patch add an optional `removedImageId?: string` field to the `SpeakerFormSubmitData` interface so the parent receives the removed image id? Boolean.",
        scale: "boolean",
        weight: 1.5,
      },
      {
        id: "introduces_removed_image_state",
        description:
          "Does the patch introduce a `removedImageId` state (e.g., `useState<string | undefined>(undefined)`) inside `SpeakerFormDialog`? Boolean.",
        scale: "boolean",
        weight: 1.5,
      },
      {
        id: "captures_image_id_on_remove",
        description:
          "In `handleFileRemove`, does the patch capture the currently-saved `formState.imageId` into `removedImageId` BEFORE clearing imageUrl/imageId, and update the `useCallback` dependency list accordingly? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "forwards_removed_image_id_on_submit",
        description:
          "Does `handleSubmit` include `removedImageId` in the `SpeakerFormSubmitData` payload passed to `onSubmit`? Boolean.",
        scale: "boolean",
        weight: 1.5,
      },
      {
        id: "resets_state_on_open_close",
        description:
          "Does the patch reset `removedImageId` to `undefined` in both branches of the open/close effect (when opening with a speaker, and when opening fresh)? Score 0-5.",
        scale: "0-5",
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
    ],
  },
};
