import type { Task } from "../../types.js";

/**
 * Real EMC PR replayed as an eval task — housestyle category.
 *
 * Provenance:
 *   Repo:    adobecom/EMC (local: /Users/rkhan/emcV2/EMC)
 *   PR:      #136 — "feat(event-form): PROD publish confirmation (MWPW-191831)"
 *   Parent:  808252410a4c7ee48ebbee109e7db75bf8391eea
 *   Merge:   04eccca90b7f18df03afe27c17a6d94c5fc7d8b7
 *
 * Why this PR was chosen for the housestyle bucket:
 *   - "Require a confirmation step before publishing" admits many shapes:
 *     window.confirm, a custom modal, a Spectrum Dialog, an AlertDialog, etc.
 *   - The EMC pod has standardized on Spectrum 2's `AlertDialog` (already in use
 *     elsewhere in this same file for the group-switch / URL-collision flows).
 *     The PIM-arm should pick that primitive; control may invent a one-off modal.
 *   - The environment gate is also a convention: EMC uses
 *     `getCurrentEnvironment() === ENVIRONMENTS.PROD` from `config/constants`,
 *     not `process.env.NODE_ENV` or an ad-hoc string compare.
 */

const SOURCE_FILE = `// web-src/src/pages/EventForm/EventForm.tsx (relevant excerpts)

// ---- Imports (existing) ----
import React, { useEffect, useCallback, useRef, useState } from 'react'
import {
  Button,
  Picker,
  PickerItem,
  Text,
  Heading,
  Divider,
  ProgressCircle,
  Dialog,
  DialogTrigger,
  Content,
  ButtonGroup,
  AlertDialog,
} from '@react-spectrum/s2'
// ... other imports ...
import { useEventFormSave } from '../../hooks/useEventFormSave'
import { useCustomDetailPagePath } from '../../hooks/useCustomDetailPagePath'
import { getEspEnvParam } from '../../config/constants'
// NOTE: config/constants also exports \`ENVIRONMENTS\` (\`{ DEV, STAGE, PROD }\`) and
// \`getCurrentEnvironment(): 'dev' | 'stage' | 'prod'\`. Both are already used
// elsewhere in this codebase to gate prod-only behavior.

// ---- Inside EventFormInner ----

const { publishEvent, saveDraft, isSaving, saveError } = useEventFormSave()
// ... other state ...

/**
 * Execute the actual save/publish after URL confirmation
 */
const executeSaveWithUrl = useCallback(async (
  action: 'save' | 'publish',
  detailPagePath: string
) => {
  setUrlDialogState(null)
  persistToStorage()

  const extra = { detailPagePath }

  if (action === 'publish') {
    await publishEvent({
      extraPayload: extra,
      onSuccess: () => {
        setPublished(true)
        toast.success(
          isPublished ? 'Event re-published successfully!' : 'Event published successfully!',
          {
            duration: 3000,
            action: { label: 'View Events', onPress: () => navigate('/events') }
          }
        )
      },
      onError: (error) => {
        console.error('Failed to publish event:', error)
      }
    })
  } else {
    await saveDraft({ /* ... */ })
  }
}, [publishEvent, saveDraft, persistToStorage, setPublished, navigate, toast, isPublished])

/**
 * Handle Publish/Re-publish button click
 */
const handleComplete = useCallback(async () => {
  const { proceed, extraPayload } = await checkUrlPatternBeforeSave('publish')
  if (!proceed) return

  persistToStorage()

  await publishEvent({
    extraPayload,
    onSuccess: () => {
      setPublished(true)
      toast.success(
        isPublished ? 'Event re-published successfully!' : 'Event published successfully!',
        {
          duration: 3000,
          action: { label: 'View Events', onPress: () => navigate('/events') }
        }
      )
    },
    onError: (error) => {
      console.error('Failed to publish event:', error)
    }
  })
}, [checkUrlPatternBeforeSave, publishEvent, persistToStorage, setPublished, navigate, toast, isPublished])

// ---- Existing AlertDialog usage elsewhere in this file (group-switch flow) ----
// <DialogTrigger isOpen={...} onOpenChange={...}>
//   <div style={{ display: 'none' }} />
//   <AlertDialog
//     title="..."
//     variant="warning"
//     primaryActionLabel="..."
//     cancelLabel="Cancel"
//     onPrimaryAction={...}
//     onCancel={...}
//   >
//     <Text>...</Text>
//   </AlertDialog>
// </DialogTrigger>
`;

const ISSUE_TEXT = `Require a confirmation step before publishing to production

When the app build targets production (ENVIRONMENT=prod), publishing an event
from the Event Form wizard should require an explicit confirmation step before
calling \`publishEvent\`. Dev and stage builds should be unchanged — they
publish immediately as today.

Both publish paths must be gated: the direct "Publish" button (\`handleComplete\`)
and the publish-after-URL-confirmation path (\`executeSaveWithUrl\` with
\`action === 'publish'\`). Cancelling the confirmation should leave the form
state unchanged.`;

const GROUND_TRUTH_PATCH = `--- a/web-src/src/pages/EventForm/EventForm.tsx
+++ b/web-src/src/pages/EventForm/EventForm.tsx
@@ -53,7 +53,7 @@ import { EventFormProvider, useEventFormContext, useToast, useGroup } from '../.
 import { useEventFormSave } from '../../hooks/useEventFormSave'
 import { useCustomDetailPagePath } from '../../hooks/useCustomDetailPagePath'
 import { COLORS, Z_INDEX, TYPOGRAPHY, SURFACES } from '../../styles/designSystem'
-import { getEspEnvParam } from '../../config/constants'
+import { ENVIRONMENTS, getCurrentEnvironment, getEspEnvParam } from '../../config/constants'

@@ -494,6 +494,9 @@ const EventFormInner: React.FC<EventFormInnerProps> = ({ ims: _ims }) => {
     collision: EventApiResponse | null
     pendingAction: 'save' | 'publish'
   } | null>(null)
+  /** Extra fields for publishEvent while PROD confirmation AlertDialog is open */
+  const prodPublishExtraRef = useRef<Record<string, any> | undefined>(undefined)
+  const [prodPublishConfirmOpen, setProdPublishConfirmOpen] = useState(false)
   const [isCheckingUrl, setIsCheckingUrl] = useState(false)

@@ -701,47 +704,83 @@ const EventFormInner: React.FC<EventFormInnerProps> = ({ ims: _ims }) => {
+  const runPublishEvent = useCallback(
+    async (extraPayload?: Record<string, any>) => {
+      persistToStorage()
+      await publishEvent({
+        extraPayload,
+        onSuccess: () => {
+          setPublished(true)
+          toast.success(
+            isPublished ? 'Event re-published successfully!' : 'Event published successfully!',
+            { duration: 3000, action: { label: 'View Events', onPress: () => navigate('/events') } }
+          )
+        },
+        onError: (error) => { console.error('Failed to publish event:', error) },
+      })
+    },
+    [publishEvent, persistToStorage, setPublished, navigate, toast, isPublished]
+  )
+
+  const requestPublishAfterUrlResolved = useCallback(
+    async (extraPayload?: Record<string, any>) => {
+      if (getCurrentEnvironment() !== ENVIRONMENTS.PROD) {
+        await runPublishEvent(extraPayload)
+        return
+      }
+      prodPublishExtraRef.current = extraPayload
+      setProdPublishConfirmOpen(true)
+    },
+    [runPublishEvent]
+  )
+
+  const handleProdPublishConfirm = useCallback(() => {
+    const extra = prodPublishExtraRef.current
+    prodPublishExtraRef.current = undefined
+    setProdPublishConfirmOpen(false)
+    void runPublishEvent(extra)
+  }, [runPublishEvent])
+
+  const cancelProdPublishDialog = useCallback(() => {
+    prodPublishExtraRef.current = undefined
+    setProdPublishConfirmOpen(false)
+  }, [])
+
   const executeSaveWithUrl = useCallback(async (
     action: 'save' | 'publish',
     detailPagePath: string
   ) => {
     setUrlDialogState(null)
+    const extra = { detailPagePath }
+    if (action === 'publish') {
+      await requestPublishAfterUrlResolved(extra)
+      return
+    }
+    persistToStorage()
+    await saveDraft({ extraPayload: extra, /* ... */ })
+  }, [requestPublishAfterUrlResolved, saveDraft, persistToStorage, toast])

@@ -773,8 +812,5 @@ const EventFormInner: React.FC<EventFormInnerProps> = ({ ims: _ims }) => {
   const handleComplete = useCallback(async () => {
     const { proceed, extraPayload } = await checkUrlPatternBeforeSave('publish')
     if (!proceed) return
-    persistToStorage()
-    await publishEvent({ extraPayload, /* ... */ })
-  }, [checkUrlPatternBeforeSave, publishEvent, persistToStorage, setPublished, navigate, toast, isPublished])
+    await requestPublishAfterUrlResolved(extraPayload)
+  }, [checkUrlPatternBeforeSave, requestPublishAfterUrlResolved])

@@ -1072,6 +1091,28 @@ const EventFormInner: React.FC<EventFormInnerProps> = ({ ims: _ims }) => {
+      <DialogTrigger
+        isOpen={prodPublishConfirmOpen}
+        onOpenChange={(open) => { if (!open) setProdPublishConfirmOpen(false) }}
+      >
+        <div style={{ display: 'none' }} />
+        <AlertDialog
+          title="Publish to production?"
+          variant="warning"
+          primaryActionLabel="Publish to production"
+          cancelLabel="Cancel"
+          onPrimaryAction={handleProdPublishConfirm}
+          onCancel={cancelProdPublishDialog}
+        >
+          <Text>
+            The event you are attempting to publish will be in production. Are you sure you want to
+            publish this event to production?
+          </Text>
+        </AlertDialog>
+      </DialogTrigger>
+
       {/* Custom URL Pattern Confirmation Dialog */}
`;

export const prodPublishConfirmation: Task = {
  id: "real-emc-prod-publish-confirmation",
  type: "content",
  podId: "pod-emc-sessions",
  asOf: "2026-05-05T09:48:40-07:00",
  tags: ["real-emc", "housestyle", "form"],
  prompt: [
    "# Issue",
    ISSUE_TEXT,
    "",
    "# Current source (web-src/src/pages/EventForm/EventForm.tsx, parent commit 808252)",
    "```tsx",
    SOURCE_FILE,
    "```",
    "",
    "# Output",
    "Return ONLY a unified diff (--- / +++ / @@) against `web-src/src/pages/EventForm/EventForm.tsx`. No prose, no full-file rewrite. You may show only the hunks you change.",
  ].join("\n"),
  expectedSignals: ["AlertDialog", "ENVIRONMENT", "prod", "publishEvent"],
  groundTruth: {
    output: GROUND_TRUTH_PATCH,
    note: "adobecom/EMC PR #136, merge SHA 04eccca. Parent EventForm.tsx at 808252. Patch trimmed: success/error callbacks in `runPublishEvent` and `saveDraft` block in `executeSaveWithUrl` are shown abbreviated; the shape and gating logic are preserved.",
  },
  rubric: {
    id: "real-emc-prod-publish-confirmation-v1",
    criteria: [
      {
        id: "uses_alert_dialog",
        description:
          "Does the patch use Spectrum 2's `AlertDialog` (the EMC house-style confirmation primitive — already imported and used elsewhere in this same file) rather than `window.confirm`, a custom modal, or a plain `Dialog`? Score 0-5: 0=window.confirm/custom modal, 3=Spectrum Dialog but not AlertDialog, 5=AlertDialog wrapped in DialogTrigger consistent with the file's existing pattern.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "gates_on_prod_environment",
        description:
          "Does the patch gate the dialog on a check of the current environment being prod (e.g., `getCurrentEnvironment() === ENVIRONMENTS.PROD` or equivalent), so dev/stage flows are unchanged and skip the confirmation entirely? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "intercepts_before_publish",
        description:
          "Does the dialog open *before* calling `publishEvent`, with `publishEvent` only invoked on confirm? Both publish paths must be covered: the direct `handleComplete` and the post-URL-confirmation `executeSaveWithUrl(action='publish')`. Score 0-5: 0=publishEvent still fires unconditionally, 3=only one path gated, 5=both paths route through a shared gate.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "matches_ground_truth_intent",
        description:
          "Compared to the reference patch, does the agent's diff achieve the same effect (AlertDialog + prod-only gate + both publish paths funneled) regardless of exact formatting or naming? Score 0-5.",
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
