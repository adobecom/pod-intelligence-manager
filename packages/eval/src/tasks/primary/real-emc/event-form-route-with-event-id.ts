import type { Task } from "../../types.js";

/**
 * Real EMC PR replayed as an eval task.
 *
 * Provenance:
 *   Repo:    adobecom/EMC (local: /Users/rkhan/emcV2/EMC)
 *   PR:      #152 — "[MWPW-194949] : Update route with event id"
 *   Parent:  d262850 (state of EventForm.tsx BEFORE the merge)
 *   Merge:   ccc9e49
 *
 * Why this PR was chosen:
 *   - Three-call-site change with a clear contract: capture the result from
 *     saveDraft / publishEvent and on first successful save (new form only)
 *     redirect /events/new/:type → /events/edit/:eventId with replace:true.
 *   - Bug if you forget any call site: saving twice creates duplicate events.
 *   - Forces the agent to also update the useCallback dep arrays correctly.
 */

const SOURCE_FILE = `// First call site: runPublishEvent
const runPublishEvent = useCallback(
  async (extraPayload?: Record<string, any>) => {
    persistToStorage()
    await publishEvent({
      extraPayload,
      onSuccess: () => {
        setPublished(true)
        toast.success(
          isPublished ? 'Event re-published successfully!' : 'Event published successfully!',
          {
            duration: 3000,
            action: { label: 'View Events', onPress: () => navigate('/events') },
          }
        )
      },
      onError: (error) => {
        console.error('Failed to publish event:', error)
      },
    })
  },
  [publishEvent, persistToStorage, setPublished, navigate, toast, isPublished]
)

// ...

// Second call site: executeSaveWithUrl (the 'save' branch after URL confirmation)
const executeSaveWithUrl = useCallback(async (
  action: 'save' | 'publish',
  detailPagePath: string
) => {
  setUrlDialogState(null)
  const extra = { detailPagePath }

  if (action === 'publish') {
    await requestPublishAfterUrlResolved(extra)
    return
  }

  persistToStorage()
  await saveDraft({
    extraPayload: extra,
    onSuccess: () => {
      toast.success('Event saved successfully!')
    },
    onError: (error) => {
      console.error('Failed to save event:', error)
    },
  })
}, [requestPublishAfterUrlResolved, saveDraft, persistToStorage, toast])

// Third call site: handleSave (Save button)
const handleSave = useCallback(async (): Promise<boolean> => {
  const { proceed, extraPayload } = await checkUrlPatternBeforeSave('save')
  if (!proceed) return false

  persistToStorage()

  const result = await saveDraft({
    extraPayload,
    onSuccess: () => {
      toast.success(isEditMode ? 'Event updated successfully!' : 'Event saved successfully!')
    },
    onError: (error) => {
      console.error('Failed to save event:', error)
    }
  })

  return result.success
}, [checkUrlPatternBeforeSave, saveDraft, persistToStorage, toast, isEditMode])
`;

const ISSUE_TEXT = `Update route with event id after first save

When a user creates a new event and then clicks Save Draft, Save, or
Publish, the URL stays at /events/new/:eventType. Clicking save again
creates a DUPLICATE event because the form still thinks it's in "new"
mode.

After the first successful save (in new-form mode only), the URL must
change to /events/edit/<eventId> using navigate(..., { replace: true })
so the back button still works correctly. In edit mode, no redirect
should occur on save/publish.

Required call sites to update (all three currently ignore the result of
saveDraft / publishEvent):
- runPublishEvent — Publish button
- executeSaveWithUrl — Save-after-URL-confirmation
- handleSave — Save button

Behavior:
- Capture \`result\` from saveDraft / publishEvent.
- If \`result.success && result.eventId && !isEditMode\` → navigate to
  \`/events/edit/\${result.eventId}\` with \`{ replace: true }\`.
- Update each useCallback dep array to include any newly referenced
  values (navigate, isEditMode).`;

const GROUND_TRUTH_PATCH = `--- a/web-src/src/pages/EventForm/EventForm.tsx
+++ b/web-src/src/pages/EventForm/EventForm.tsx
@@ -723,7 +723,7 @@ const EventFormInner: React.FC<EventFormInnerProps> = ({ ims: _ims }) => {
   const runPublishEvent = useCallback(
     async (extraPayload?: Record<string, any>) => {
       persistToStorage()
-      await publishEvent({
+      const result = await publishEvent({
         extraPayload,
         onSuccess: () => {
           setPublished(true)
@@ -739,8 +739,11 @@ const EventFormInner: React.FC<EventFormInnerProps> = ({ ims: _ims }) => {
           console.error('Failed to publish event:', error)
         },
       })
+      if (result.success && result.eventId && !isEditMode) {
+        navigate(\`/events/edit/\${result.eventId}\`, { replace: true })
+      }
     },
-    [publishEvent, persistToStorage, setPublished, navigate, toast, isPublished]
+    [publishEvent, persistToStorage, setPublished, navigate, toast, isPublished, isEditMode]
   )

   const requestPublishAfterUrlResolved = useCallback(
@@ -787,7 +790,7 @@ const EventFormInner: React.FC<EventFormInnerProps> = ({ ims: _ims }) => {
     }

     persistToStorage()
-    await saveDraft({
+    const result = await saveDraft({
       extraPayload: extra,
       onSuccess: () => {
         toast.success('Event saved successfully!')
@@ -796,7 +799,10 @@ const EventFormInner: React.FC<EventFormInnerProps> = ({ ims: _ims }) => {
         console.error('Failed to save event:', error)
       },
     })
-  }, [requestPublishAfterUrlResolved, saveDraft, persistToStorage, toast])
+    if (result.success && result.eventId && !isEditMode) {
+      navigate(\`/events/edit/\${result.eventId}\`, { replace: true })
+    }
+  }, [requestPublishAfterUrlResolved, saveDraft, persistToStorage, toast, navigate, isEditMode])

   /**
    * Handle Save button click - saves to API + sessionStorage without advancing
@@ -817,9 +823,13 @@ const EventFormInner: React.FC<EventFormInnerProps> = ({ ims: _ims }) => {
         console.error('Failed to save event:', error)
       }
     })
-
+
+    if (result.success && result.eventId && !isEditMode) {
+      navigate(\`/events/edit/\${result.eventId}\`, { replace: true })
+    }
+
     return result.success
-  }, [checkUrlPatternBeforeSave, saveDraft, persistToStorage, toast, isEditMode])
+  }, [checkUrlPatternBeforeSave, saveDraft, persistToStorage, toast, isEditMode, navigate])

   /**
    * Handle Publish/Re-publish button click
`;

export const eventFormRouteWithEventId: Task = {
  id: "real-emc-event-form-route-with-event-id",
  type: "content",
  podId: "pod-emc-sessions",
  asOf: "2026-05-12T11:39:29-07:00",
  tags: ["real-emc", "event-form", "routing"],
  // Re-tiered to realistic-ticket (#8): saturated call-site/guard checklist + pasted source removed.
  prompt: [
    "# Issue",
    "Update route with event id after first save",
    "",
    "When a user creates a NEW event and then saves (Save Draft, Save, or Publish),",
    "the URL stays at /events/new/:eventType. If they save again, a DUPLICATE event",
    "is created because the form still thinks it's in \"new\" mode.",
    "",
    "After the first successful save of a brand-new event, the URL should move to the",
    "event's edit route (/events/edit/<eventId>) without adding a history entry, so",
    "the back button still behaves. Editing an existing event must not redirect on save.",
    "",
    "All the save/publish paths in the form are affected. The form lives at",
    "`web-src/src/pages/EventForm/EventForm.tsx`.",
    "",
    "# Output",
    "Return ONLY a unified diff (--- / +++ / @@) against the EventForm component. No prose, no full-file rewrite.",
  ].join("\n"),
  expectedSignals: [
    "result.eventId",
    "result.success",
    "isEditMode",
    "navigate",
    "/events/edit/",
    "replace: true",
  ],
  groundTruth: {
    output: GROUND_TRUTH_PATCH,
    note: "adobecom/EMC PR #152, merge SHA ccc9e49. Parent file at d262850.",
  },
  rubric: {
    id: "real-emc-event-form-route-with-event-id-v1",
    criteria: [
      {
        id: "captures_result_at_all_three_sites",
        description:
          "Does the patch change `await saveDraft(...)` / `await publishEvent(...)` to `const result = await ...` at ALL THREE call sites (runPublishEvent, executeSaveWithUrl, handleSave)? Score 0-5: 0=zero sites, 5=all three.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "redirect_uses_replace_true",
        description:
          "Does the redirect use `navigate(..., { replace: true })` (not push) at every site where it's added? Boolean.",
        scale: "boolean",
        weight: 1.5,
      },
      {
        id: "guards_on_is_edit_mode_and_event_id",
        description:
          "Does the redirect condition require `result.success && result.eventId && !isEditMode` (so it doesn't run in edit mode and doesn't run on failed saves)? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "target_url_is_events_edit_eventId",
        description:
          "Does the redirect target the path `/events/edit/${result.eventId}` (template literal interpolating the new event id)? Boolean.",
        scale: "boolean",
        weight: 1.5,
      },
      {
        id: "updates_use_callback_deps",
        description:
          "Does the patch add the newly referenced values (`navigate`, `isEditMode`) to each affected useCallback dependency array? Score 0-5: 0=no deps updated, 5=both added at every modified site.",
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
