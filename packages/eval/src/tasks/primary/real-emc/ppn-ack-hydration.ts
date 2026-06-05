import type { Task } from "../../types.js";

/**
 * Real EMC PR replayed as an eval task.
 *
 * Provenance:
 *   Repo:    adobecom/EMC (local: /Users/rkhan/emcV2/EMC)
 *   PR:      #156 — "fix(event-form): stabilize page metadata (PPN) acknowledgment hydration"
 *   Parent:  ccc9e49 (state of PageMetadataComponent.tsx BEFORE the merge)
 *   Merge:   84f21c9
 *
 * Why this PR was chosen:
 *   - Race-condition fix between catalogue load and profile load. The bug is
 *     that a "hydration tick" counter only triggers acknowledgment when the
 *     catalogue is already present; if the profile arrives first, the user
 *     sees "select a value" errors even though metadata is loaded.
 *   - Correct fix needs to (a) apply acks immediately when both are present,
 *     (b) set a pending-backfill flag and flush when catalogue arrives later,
 *     (c) reset on eventId change, and (d) treat metadata-with-value as
 *     satisfied during validation even without an explicit ack.
 */

const SOURCE_FILE = `// Local state
const [catalogue, setCatalogue] = useState<MetadataCatalogue | null>(null)
const [isLoading, setIsLoading] = useState(true)
const [error, setError] = useState<string | null>(null)
/** Increment when a publishing profile is loaded from the API or saved — drives acknowledgment sync */
const [profileHydrationTick, setProfileHydrationTick] = useState(0)

const publishingProfileRef = useRef<PublishingProfile | null>(null)
const catalogueRef = useRef<MetadataCatalogue | null>(null)
const updateFormDataRef = useRef<((updates: any) => void) | null>(null)
const formDataRef = useRef<any>(null)

const bumpProfileHydrationTick = useCallback(() => {
  setProfileHydrationTick((t) => t + 1)
}, [])

const {
  formData,
  updateFormData,
  eventId,
  isEditMode,
} = useEventFormComponent({
  componentId: 'page-metadata',
  onLoadResponse: async (eventResponse: any) => {
    if (!eventResponse?.eventId) return
    try {
      const profileResponse = await cachedApi.getEventPublishingProfile(eventResponse.eventId)
      const profiles = Array.isArray(profileResponse) ? profileResponse : [profileResponse]
      const profileAssociation = profiles[0]
      if (profileAssociation && !('error' in profileAssociation)) {
        // API returns { eventId, profileId, profile: { metadata, ... } }
        const actualProfile = profileAssociation.profile || profileAssociation
        publishingProfileRef.current = actualProfile as PublishingProfile
        if (actualProfile.metadata != null && updateFormDataRef.current) {
          updateFormDataRef.current({ metadata: actualProfile.metadata })
        }
        bumpProfileHydrationTick()
      }
    } catch (err) {
      console.error('Failed to load publishing profile:', err)
    }
  },
  onAfterSave: async (eventId: string) => {
    const savedMetadata = formDataRef.current?.metadata ?? {}
    const hasMetadataKeys = Object.keys(savedMetadata).length > 0
    const existingProfile = publishingProfileRef.current
    if (!existingProfile?.profileId && !hasMetadataKeys) return
    try {
      if (existingProfile?.profileId) {
        const updateResult = await apiService.updatePublishingProfile(existingProfile.profileId, {
          name: existingProfile.name,
          description: existingProfile.description,
          metadata: savedMetadata,
          modificationTime: existingProfile.modificationTime,
        })
        if (updateResult && !('error' in updateResult) && (updateResult as PublishingProfile).profileId) {
          publishingProfileRef.current = { ...existingProfile, ...(updateResult as PublishingProfile) }
          bumpProfileHydrationTick()
        }
      } else if (hasMetadataKeys) {
        const createResult = await apiService.createPublishingProfile({
          name: \\\`Event \\\${eventId} Profile\\\`,
          metadata: savedMetadata,
        })
        if (createResult && !('error' in createResult) && createResult.profileId) {
          await apiService.assignPublishingProfileToEvent(eventId, createResult.profileId)
          publishingProfileRef.current = createResult as PublishingProfile
          bumpProfileHydrationTick()
        }
      }
    } catch (err) {
      console.error('Failed to save publishing profile:', err)
    }
  },
  validate: () => {
    const cat = catalogueRef.current
    const fieldsList = cat?.data?.data
    if (!fieldsList?.length) return true
    const ack = formDataRef.current?.metadataFieldAcknowledged || {}
    for (const field of fieldsList as MetadataField[]) {
      if (!ack[field.key]) {
        return \\\`Select a value for \\\${field.name} (page metadata).\\\`
      }
    }
    return true
  },
})

// Effects keeping refs in sync (updateFormData, formData, catalogue) ...

// When a profile was loaded or saved, treat server metadata as fully
// acknowledged for all catalogue keys.
useEffect(() => {
  if (!catalogue?.data?.data?.length || profileHydrationTick === 0) return
  const keys = catalogue.data.data.map((f: MetadataField) => f.key)
  updateFormDataRef.current?.({
    metadataFieldAcknowledged: Object.fromEntries(keys.map((k) => [k, true])),
  })
}, [catalogue, profileHydrationTick])

// Load profile in edit mode (duplicate of onLoadResponse path, used when
// edit-mode is entered after the form already mounted).
const loadPublishingProfile = useCallback(async (targetEventId: string) => {
  if (!targetEventId) return
  try {
    const profileResponse = await cachedApi.getEventPublishingProfile(targetEventId)
    const profiles = Array.isArray(profileResponse) ? profileResponse : [profileResponse]
    const profileAssociation = profiles[0]
    if (profileAssociation && !('error' in profileAssociation)) {
      const actualProfile = profileAssociation.profile || profileAssociation
      publishingProfileRef.current = actualProfile as PublishingProfile
      if (actualProfile.metadata != null) {
        updateFormData({ metadata: actualProfile.metadata })
      }
      bumpProfileHydrationTick()
    }
  } catch (err) {
    console.error('Failed to load publishing profile:', err)
  }
}, [updateFormData, bumpProfileHydrationTick])

useEffect(() => {
  if (isEditMode && eventId && !publishingProfileRef.current) {
    loadPublishingProfile(eventId)
  }
}, [isEditMode, eventId, loadPublishingProfile])
`;

const ISSUE_TEXT = `fix(event-form): stabilize page metadata (PPN) acknowledgment hydration

Resolves: MWPW-193969

When editing an existing webinar whose publishing profile already has
metadata values, saving any other step-1 field without re-opening the
PPN picker fails validation with "Select a value for ...". The root
cause is a race: 'profileHydrationTick' only causes acknowledgments to
be written when the catalogue is already loaded. If the catalogue
arrives later (or the user leaves step 1 before fetch finishes), the
acks are never written.

Required behavior:
- When the catalogue is already loaded at the time profile metadata
  arrives, apply metadata AND \`metadataFieldAcknowledged\` in a single
  update.
- Otherwise, set a pending-backfill flag and flush acknowledgments once
  the catalogue arrives.
- Reset publishingProfileRef and the pending backfill when \`eventId\`
  changes so switching events always reloads.
- Validation should treat a field as satisfied when acknowledged OR
  when \`metadata\` already holds a value (server-backed selection).
- ESP returns \`profileId\` on the association wrapper while the nested
  \`profile\` sometimes omits it. Normalize so the top-level profileId
  is preserved when the inner object is missing it.
- New webinars must still require an explicit choice per catalogue
  field (so the metadata-satisfies rule only helps when there IS a
  server-backed value).`;

const GROUND_TRUTH_PATCH = `--- a/web-src/src/pages/EventForm/PageMetadataComponent.tsx
+++ b/web-src/src/pages/EventForm/PageMetadataComponent.tsx
@@ -6,6 +6,7 @@ import React, { useState, useEffect, useRef, useCallback } from 'react'
 import { Picker, PickerItem, Text, Heading } from '@react-spectrum/s2'
 import { style } from '@react-spectrum/s2/style' with { type: 'macro' }
 import { TYPOGRAPHY, COLORS } from '../../styles/designSystem'
+import { useEventFormContext } from '../../contexts/EventFormContext'
 import { useEventFormComponent } from '../../hooks/useEventFormComponent'
 import { apiService, cachedApi } from '../../services/api'
 import { PublishingProfile } from '../../types/domain'
@@ -32,6 +33,26 @@ function noOptionKey(fieldKey: string): string {
   return \`no-\${fieldKey}\`
 }

+function catalogueFieldKeys(cat: MetadataCatalogue | null): string[] {
+  const fields = cat?.data?.data
+  if (!fields?.length) return []
+  return (fields as MetadataField[]).map((f) => f.key)
+}
+
+/** ESP may return profileId on the association object while nested \`profile\` omits it. */
+function publishingProfileFromAssociation(profileAssociation: {
+  profile?: PublishingProfile
+  profileId?: string
+  [key: string]: unknown
+}): PublishingProfile {
+  const inner = (profileAssociation.profile ?? profileAssociation) as PublishingProfile
+  const topId = profileAssociation.profileId
+  if (typeof topId === 'string' && topId && !inner.profileId) {
+    return { ...inner, profileId: topId }
+  }
+  return inner
+}
+
 /**
  * PageMetadataComponent - Manages page metadata for webinar events
@@ -40,29 +61,76 @@ function noOptionKey(fieldKey: string): string {
  * Loads/saves metadata via PublishingProfile API.
  */
 export const PageMetadataComponent: React.FC = () => {
+  const { isEditMode } = useEventFormContext()
+
   // ============================================================================
   // LOCAL STATE
   // ============================================================================
-
+
   const [catalogue, setCatalogue] = useState<MetadataCatalogue | null>(null)
   const [isLoading, setIsLoading] = useState(true)
   const [error, setError] = useState<string | null>(null)
-  /** Increment when a publishing profile is loaded from the API or saved — drives acknowledgment sync */
-  const [profileHydrationTick, setProfileHydrationTick] = useState(0)
-
+  /** Catalogue arrived after publishing profile metadata was merged — flush acknowledgments once */
+  const [pendingProfileAckBackfill, setPendingProfileAckBackfill] = useState(false)
+
   // Track the current publishing profile for updates
   const publishingProfileRef = useRef<PublishingProfile | null>(null)
   const catalogueRef = useRef<MetadataCatalogue | null>(null)
-
+
   // Ref to hold updateFormData for use in callbacks (avoids circular dependency)
   const updateFormDataRef = useRef<((updates: any) => void) | null>(null)
-
+
   // Keep a ref to formData for use in callbacks
   const formDataRef = useRef<any>(null)

-  const bumpProfileHydrationTick = useCallback(() => {
-    setProfileHydrationTick((t) => t + 1)
-  }, [])
+  const mergeAckForCatalogueKeys = useCallback(
+    (prevAck: Record<string, boolean>, keys: string[]): Record<string, boolean> => ({
+      ...prevAck,
+      ...Object.fromEntries(keys.map((k) => [k, true])),
+    }),
+    []
+  )
+
+  /** Apply association from GET publishing profile: metadata (if present) + acknowledgments when catalogue keys are known. */
+  const applyPublishingProfileFromServer = useCallback(
+    (actualProfile: PublishingProfile) => {
+      publishingProfileRef.current = actualProfile
+
+      const keys = catalogueFieldKeys(catalogueRef.current)
+      const prevAck = (formDataRef.current?.metadataFieldAcknowledged || {}) as Record<string, boolean>
+
+      if (keys.length > 0) {
+        const updates: Record<string, unknown> = {
+          metadataFieldAcknowledged: mergeAckForCatalogueKeys(prevAck, keys),
+        }
+        if (actualProfile.metadata != null) {
+          updates.metadata = actualProfile.metadata
+        }
+        updateFormDataRef.current?.(updates)
+        setPendingProfileAckBackfill(false)
+      } else {
+        if (actualProfile.metadata != null) {
+          updateFormDataRef.current?.({ metadata: actualProfile.metadata })
+        }
+        setPendingProfileAckBackfill(true)
+      }
+    },
+    [mergeAckForCatalogueKeys]
+  )
+
+  /** After profile save/create: keep acknowledgments aligned with catalogue (same intent as prior hydration tick). */
+  const syncAcknowledgmentsAfterProfileSave = useCallback(() => {
+    const keys = catalogueFieldKeys(catalogueRef.current)
+    const prevAck = (formDataRef.current?.metadataFieldAcknowledged || {}) as Record<string, boolean>
+    if (keys.length > 0) {
+      updateFormDataRef.current?.({
+        metadataFieldAcknowledged: mergeAckForCatalogueKeys(prevAck, keys),
+      })
+      setPendingProfileAckBackfill(false)
+    } else {
+      setPendingProfileAckBackfill(true)
+    }
+  }, [mergeAckForCatalogueKeys])

   // ============================================================================
   // CONTEXT INTEGRATION
@@ -72,7 +140,6 @@ export const PageMetadataComponent: React.FC = () => {
     formData,
     updateFormData,
     eventId,
-    isEditMode,
   } = useEventFormComponent({
     componentId: 'page-metadata',
     onLoadResponse: async (eventResponse: any) => {
@@ -87,16 +154,9 @@ export const PageMetadataComponent: React.FC = () => {
         const profileAssociation = profiles[0]

         if (profileAssociation && !('error' in profileAssociation)) {
-          // API returns { eventId, profileId, profile: { metadata, ... } }
-          // The actual profile data is nested inside the 'profile' property
-          const actualProfile = profileAssociation.profile || profileAssociation
-
-          publishingProfileRef.current = actualProfile as PublishingProfile
-          // Populate form data with the profile's metadata
-          if (actualProfile.metadata != null && updateFormDataRef.current) {
-            updateFormDataRef.current({ metadata: actualProfile.metadata })
-          }
-          bumpProfileHydrationTick()
+          applyPublishingProfileFromServer(
+            publishingProfileFromAssociation(profileAssociation as { profile?: PublishingProfile; profileId?: string })
+          )
         }
       } catch (err) {
         console.error('Failed to load publishing profile:', err)
@@ -132,7 +192,7 @@ export const PageMetadataComponent: React.FC = () => {
               ...existingProfile,
               ...(updateResult as PublishingProfile),
             }
-            bumpProfileHydrationTick()
+            syncAcknowledgmentsAfterProfileSave()
           }
         } else if (hasMetadataKeys) {
           // Create new profile and assign to event
@@ -145,7 +205,7 @@ export const PageMetadataComponent: React.FC = () => {
             // Assign the new profile to the event
             await apiService.assignPublishingProfileToEvent(eventId, createResult.profileId)
             publishingProfileRef.current = createResult as PublishingProfile
-            bumpProfileHydrationTick()
+            syncAcknowledgmentsAfterProfileSave()
           }
         }
       } catch (err) {
@@ -159,10 +219,12 @@ export const PageMetadataComponent: React.FC = () => {
       if (!fieldsList?.length) return true

       const ack = formDataRef.current?.metadataFieldAcknowledged || {}
+      const meta = formDataRef.current?.metadata || {}
+
       for (const field of fieldsList as MetadataField[]) {
-        if (!ack[field.key]) {
-          return \`Select a value for \${field.name} (page metadata).\`
-        }
+        if (ack[field.key]) continue
+        if (meta[field.key]) continue
+        return \`Select a value for \${field.name} (page metadata).\`
       }
       return true
     },
@@ -184,14 +246,19 @@ export const PageMetadataComponent: React.FC = () => {
   const metadata = formData.metadata || {}
   const metadataFieldAcknowledged = formData.metadataFieldAcknowledged || {}

-  // When a profile was loaded or saved, treat server metadata as fully acknowledged for all catalogue keys
+  // Catalogue arrived after profile metadata was merged — backfill acknowledgments once
   useEffect(() => {
-    if (!catalogue?.data?.data?.length || profileHydrationTick === 0) return
-    const keys = catalogue.data.data.map((f: MetadataField) => f.key)
+    if (!pendingProfileAckBackfill) return
+    if (!publishingProfileRef.current) return
+    const keys = catalogueFieldKeys(catalogue)
+    if (!keys.length) return
+
+    const prevAck = (formDataRef.current?.metadataFieldAcknowledged || {}) as Record<string, boolean>
     updateFormDataRef.current?.({
-      metadataFieldAcknowledged: Object.fromEntries(keys.map((k) => [k, true])),
+      metadataFieldAcknowledged: mergeAckForCatalogueKeys(prevAck, keys),
     })
-  }, [catalogue, profileHydrationTick])
+    setPendingProfileAckBackfill(false)
+  }, [catalogue, pendingProfileAckBackfill, mergeAckForCatalogueKeys])

   // ============================================================================
   // LOAD PUBLISHING PROFILE ON EDIT MODE
@@ -208,23 +275,21 @@ export const PageMetadataComponent: React.FC = () => {
       const profileAssociation = profiles[0]

       if (profileAssociation && !('error' in profileAssociation)) {
-        // API returns { eventId, profileId, profile: { metadata, ... } }
-        // The actual profile data is nested inside the 'profile' property
-        const actualProfile = profileAssociation.profile || profileAssociation
-
-        publishingProfileRef.current = actualProfile as PublishingProfile
-        // Populate form data with the profile's metadata
-        if (actualProfile.metadata != null) {
-          updateFormData({ metadata: actualProfile.metadata })
-        }
-        bumpProfileHydrationTick()
+        applyPublishingProfileFromServer(
+          publishingProfileFromAssociation(profileAssociation as { profile?: PublishingProfile; profileId?: string })
+        )
       }
     } catch (err) {
       console.error('Failed to load publishing profile:', err)
       // Non-fatal - profile may not exist yet
     }
-  }, [updateFormData, bumpProfileHydrationTick])
+  }, [applyPublishingProfileFromServer])

+  useEffect(() => {
+    publishingProfileRef.current = null
+    setPendingProfileAckBackfill(false)
+  }, [eventId])
+
   useEffect(() => {
     // If we're in edit mode and have an eventId, load the publishing profile
     if (isEditMode && eventId && !publishingProfileRef.current) {
`;

export const ppnAckHydration: Task = {
  id: "real-emc-ppn-ack-hydration",
  type: "content",
  podId: "pod-emc-configs",
  asOf: "2026-05-14T14:26:16+05:30",
  tags: ["real-emc", "event-form", "hydration", "race"],
  // Re-tiered to realistic-ticket (#8): per-branch "Required behavior" list + pasted source removed.
  prompt: [
    "# Issue",
    "fix(event-form): stabilize page metadata (PPN) acknowledgment hydration",
    "",
    "Resolves: MWPW-193969",
    "",
    "When editing an existing webinar whose publishing profile already has metadata",
    "values, saving any other step-1 field WITHOUT re-opening the PPN picker fails",
    "validation with \"Select a value for ...\". It's a load-order race: the catalogue",
    "and the profile arrive asynchronously, and if the profile lands before the",
    "catalogue (or the user leaves step 1 before the catalogue fetch finishes), the",
    "fields never get acknowledged.",
    "",
    "Make hydration order-independent so an existing, server-backed selection counts as",
    "satisfied regardless of which response arrives first, switching events reloads",
    "cleanly, and brand-new webinars still require an explicit per-field choice.",
    "",
    "The component is `web-src/src/pages/EventForm/PageMetadataComponent.tsx`.",
    "",
    "# Output",
    "Return ONLY a unified diff (--- / +++ / @@) against the PageMetadataComponent. No prose, no full-file rewrite.",
  ].join("\n"),
  expectedSignals: [
    "pendingProfileAckBackfill",
    "metadataFieldAcknowledged",
    "publishingProfileFromAssociation",
    "applyPublishingProfileFromServer",
    "catalogueFieldKeys",
    "profileHydrationTick",
    "eventId",
  ],
  groundTruth: {
    output: GROUND_TRUTH_PATCH,
    note: "adobecom/EMC PR #156, merge SHA 84f21c9. Parent file at ccc9e49.",
  },
  rubric: {
    id: "real-emc-ppn-ack-hydration-v1",
    criteria: [
      {
        id: "removes_or_replaces_hydration_tick",
        description:
          "Does the patch remove the `profileHydrationTick` counter (or otherwise replace its role) and stop using it as the gate for writing acknowledgments? Score 0-5.",
        scale: "0-5",
        weight: 1.5,
      },
      {
        id: "introduces_pending_backfill_flag",
        description:
          "Does the patch introduce a flag like `pendingProfileAckBackfill` (or equivalent) that is set when the profile arrives before the catalogue, and cleared once the catalogue arrives and acknowledgments are written? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "applies_meta_and_ack_in_one_update",
        description:
          "When the catalogue IS already loaded at the time the profile arrives, does the patch apply both `metadata` and `metadataFieldAcknowledged` in a single `updateFormData` call (not two separate calls and not a re-render hop)? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "validation_accepts_server_value",
        description:
          "Does the validate function now treat a catalogue field as satisfied when EITHER the ack is true OR `metadata[field.key]` already has a value? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "resets_on_event_id_change",
        description:
          "Does the patch add a `useEffect` (or equivalent) that resets `publishingProfileRef.current` and the pending-backfill flag when `eventId` changes? Boolean.",
        scale: "boolean",
        weight: 1.5,
      },
      {
        id: "normalizes_top_level_profile_id",
        description:
          "Does the patch handle the ESP response where `profileId` lives on the association wrapper but the nested `profile` omits it (by preserving the top-level id when the inner is missing)? Score 0-5.",
        scale: "0-5",
        weight: 1.5,
      },
      {
        id: "merges_with_previous_ack",
        description:
          "Does the patch merge into the previous `metadataFieldAcknowledged` instead of overwriting it (so user-made acks on non-catalogue keys are preserved)? Boolean.",
        scale: "boolean",
        weight: 1,
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
