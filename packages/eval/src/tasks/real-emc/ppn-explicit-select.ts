import type { Task } from "../types.js";

/**
 * Real EMC PR replayed as an eval task.
 *
 * Provenance:
 *   Repo:    adobecom/EMC (local: /Users/rkhan/emcV2/EMC)
 *   PR:      #138 — "MWPW-193969: Require explicit page metadata (PPN) selection"
 *   Parent:  13fb4ce98673197a05b04eae8bd93e7aeb075df1
 *   Merge:   82f6dacb717f8612a499c412eac0d10e108d7f2c
 *
 * Why this PR was chosen as a "saturated" sanity check:
 *   - The PR body fully describes the fix: introduce
 *     `metadataFieldAcknowledged` per field, use a placeholder until the user
 *     explicitly chooses, give the "No" option a stable id (`no-${fieldKey}`)
 *     so the previous `startsWith('No ')` check no longer fails on Picker ids,
 *     hydrate ack state after profile load/save, and add a validate() guard.
 *   - Both arms should pass; this proves PIM doesn't break a trivially
 *     self-specifying multi-file change.
 */

const SOURCE_FILE = `// PageMetadataComponent.tsx — relevant excerpts at parent 13fb4ce

interface MetadataField { key: string; name: string }
interface MetadataOption { value: string }
interface MetadataCatalogue {
  data: { data: MetadataField[] }
  [key: string]: any
}

const METADATA_CATALOGUE_URL = 'https://www.adobe.com/event-libs/assets/configs/metadata-catalogue.json'

export const PageMetadataComponent: React.FC = () => {
  const [catalogue, setCatalogue] = useState<MetadataCatalogue | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const publishingProfileRef = useRef<PublishingProfile | null>(null)
  const updateFormDataRef = useRef<((updates: any) => void) | null>(null)
  const formDataRef = useRef<any>(null)

  const { formData, updateFormData } = useEventFormComponent({
    componentId: 'page-metadata',
    onAfterSave: async (eventId: string) => { /* upsert publishing profile from formData.metadata */ },
    // NOTE: no validate() today — user can save before touching any picker
  })

  const metadata = formData.metadata || {}

  // BUG: this matches only on the visible label, not the Picker id 'no-<fieldKey>'
  const handleFieldChange = (fieldKey: string, value: string) => {
    const updatedMetadata = { ...metadata }
    if (value && !value.startsWith('No ')) {
      updatedMetadata[fieldKey] = value
    } else {
      delete updatedMetadata[fieldKey]
    }
    updateFormData({ metadata: updatedMetadata })
  }

  const fields = catalogue?.data?.data || []

  return (
    <>
      {fields.map((field: MetadataField) => {
        const fieldOptions: MetadataOption[] = catalogue?.[field.key]?.data || []
        const currentValue = metadata[field.key] || ''
        const allOptions = [
          { key: \`no-\${field.key}\`, label: \`No \${field.name}\` },
          ...fieldOptions.map(opt => ({ key: opt.value, label: opt.value }))
        ]
        return (
          <Picker
            key={field.key}
            data-testid={\`meta-\${field.key}-input\`}
            label={\`\${field.name} *\`}
            placeholder={\`Select \${field.name.toLowerCase()}\`}
            // BUG: defaults to the "No <field>" option without any user interaction
            selectedKey={currentValue || \`no-\${field.key}\`}
            onSelectionChange={(key) => handleFieldChange(field.key, key as string)}
            isRequired
            items={allOptions}
          >
            {(item) => <PickerItem id={item.key}>{item.label}</PickerItem>}
          </Picker>
        )
      })}
    </>
  )
}

// web-src/src/types/domain.ts — relevant stub
export interface EventFormData {
  // ...many fields...
  metadata?: Record<string, any>
  // (no acknowledgement field today)
}
`;

const ISSUE_TEXT = `MWPW-193969: Require explicit page metadata (PPN) selection

Summary
Page metadata Pickers no longer default to "No {field name}" without user
interaction. Users must open each dropdown and choose a product or the
"No" option before save (draft or publish). The "No" option stays
available at the bottom of each list.

Changes
- Add \`metadataFieldAcknowledged\` (UI-only) on \`EventFormData\`
- selectedKey: placeholder until explicit selection; "No" uses stable id
  \`no-\${fieldKey}\`
- Fix persistence for "No": recognize sentinel id (previous
  \`startsWith('No ')\` did not match Picker ids)
- Hydrate acknowledgments after publishing profile load from API or
  successful profile save (existing events stay usable without re-picking)
- validate() on page-metadata when catalogue fields exist

Resolves MWPW-193969.`;

const GROUND_TRUTH_PATCH = `--- a/web-src/src/pages/EventForm/PageMetadataComponent.tsx
+++ b/web-src/src/pages/EventForm/PageMetadataComponent.tsx
@@ -28,6 +28,10 @@ interface MetadataCatalogue {

 const METADATA_CATALOGUE_URL = 'https://www.adobe.com/event-libs/assets/configs/metadata-catalogue.json'

+function noOptionKey(fieldKey: string): string {
+  return \`no-\${fieldKey}\`
+}
+
 export const PageMetadataComponent: React.FC = () => {
   const [catalogue, setCatalogue] = useState<MetadataCatalogue | null>(null)
   const [isLoading, setIsLoading] = useState(true)
   const [error, setError] = useState<string | null>(null)
+  const [profileHydrationTick, setProfileHydrationTick] = useState(0)
+
+  const bumpProfileHydrationTick = useCallback(() => {
+    setProfileHydrationTick((t) => t + 1)
+  }, [])

   // ...refs unchanged...
   const { formData, updateFormData } = useEventFormComponent({
     componentId: 'page-metadata',
     onAfterSave: async (eventId: string) => { /* ... */ bumpProfileHydrationTick() },
+    validate: () => {
+      const cat = catalogueRef.current
+      const fieldsList = cat?.data?.data
+      if (!fieldsList?.length) return true
+      const ack = formDataRef.current?.metadataFieldAcknowledged || {}
+      for (const field of fieldsList as MetadataField[]) {
+        if (!ack[field.key]) {
+          return \`Select a value for \${field.name} (page metadata).\`
+        }
+      }
+      return true
+    },
   })

   const metadata = formData.metadata || {}
+  const metadataFieldAcknowledged = formData.metadataFieldAcknowledged || {}
+
+  // After profile hydration, treat all catalogue keys as acknowledged.
+  useEffect(() => {
+    if (!catalogue?.data?.data?.length || profileHydrationTick === 0) return
+    const keys = catalogue.data.data.map((f: MetadataField) => f.key)
+    updateFormDataRef.current?.({
+      metadataFieldAcknowledged: Object.fromEntries(keys.map((k) => [k, true])),
+    })
+  }, [catalogue, profileHydrationTick])

   const handleFieldChange = (fieldKey: string, value: string) => {
-    const updatedMetadata = { ...metadata }
-    if (value && !value.startsWith('No ')) {
-      updatedMetadata[fieldKey] = value
-    } else {
-      delete updatedMetadata[fieldKey]
-    }
-    updateFormData({ metadata: updatedMetadata })
+    const prev = formDataRef.current
+    const meta = { ...(prev?.metadata || {}) }
+    const noKey = noOptionKey(fieldKey)
+    const prevAck = prev?.metadataFieldAcknowledged || {}
+    if (value && value !== noKey) {
+      meta[fieldKey] = value
+    } else {
+      delete meta[fieldKey]
+    }
+    updateFormData({
+      metadata: meta,
+      metadataFieldAcknowledged: { ...prevAck, [fieldKey]: true },
+    })
   }

   // ...render...
       {fields.map((field: MetadataField) => {
         const fieldOptions = catalogue?.[field.key]?.data || []
         const currentValue = metadata[field.key] || ''
+        const noKey = noOptionKey(field.key)
         const allOptions = [
-          { key: \`no-\${field.key}\`, label: \`No \${field.name}\` },
-          ...fieldOptions.map(opt => ({ key: opt.value, label: opt.value }))
+          ...fieldOptions.map(opt => ({ key: opt.value, label: opt.value })),
+          { key: noKey, label: \`No \${field.name}\` },
         ]
+        const selectedKey =
+          currentValue
+            ? currentValue
+            : metadataFieldAcknowledged[field.key]
+              ? noKey
+              : undefined
         return (
           <Picker
             // ...
-            selectedKey={currentValue || \`no-\${field.key}\`}
+            selectedKey={selectedKey}
           />
         )
       })}
--- a/web-src/src/types/domain.ts
+++ b/web-src/src/types/domain.ts
@@ -635,6 +635,8 @@ export interface EventFormData {
   metadata?: Record<string, any>
+  /** UI-only: user explicitly chose a catalogue option (including "No …") per metadata field key */
+  metadataFieldAcknowledged?: Record<string, boolean>
 }
`;

export const ppnExplicitSelect: Task = {
  id: "real-emc-ppn-explicit-select",
  type: "content",
  // pod-emc-configs owns publishing-profile / metadata-catalogue work in the EMC eval fixtures.
  podId: "pod-emc-configs",
  tags: ["real-emc", "saturated", "form", "metadata", "validation"],
  prompt: [
    "# Issue",
    ISSUE_TEXT,
    "",
    "# Current source (web-src/src/pages/EventForm/PageMetadataComponent.tsx and types/domain.ts, parent 13fb4ce)",
    "```tsx",
    SOURCE_FILE,
    "```",
    "",
    "# Output",
    "Return ONLY a unified diff (--- / +++ / @@) covering both files that requires explicit user selection for each page-metadata Picker, fixes the broken \"No\" persistence, hydrates acknowledgments after profile load, and adds a validate() guard. No prose, no full-file rewrite.",
  ].join("\n"),
  expectedSignals: ["metadataFieldAcknowledged", "no-", "selectedKey", "placeholder"],
  groundTruth: {
    output: GROUND_TRUTH_PATCH,
    note: "adobecom/EMC PR #138, merge SHA 82f6dac. Parent files at 13fb4ce.",
  },
  rubric: {
    id: "real-emc-ppn-explicit-select-v1",
    criteria: [
      {
        id: "adds_acknowledged_state",
        description:
          "Does the diff introduce a per-field acknowledgment state (e.g., `metadataFieldAcknowledged: Record<string, boolean>`) on `EventFormData` and toggle it when the user picks an option? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "uses_placeholder_until_select",
        description:
          "Does `selectedKey` resolve to a placeholder/null/undefined until the user explicitly chooses (instead of falling back to the \"No\" id by default)? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "stable_id_for_no_option",
        description:
          "Does the \"No\" option get a stable id (e.g., `no-${fieldKey}`) AND does the persistence check use that id instead of the previous `value.startsWith('No ')` label check (which never matched Picker ids)? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "validates_required_before_save",
        description:
          "Does a `validate()` callback on the page-metadata component block save when any catalogue field is unacknowledged, returning a user-readable error string? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "matches_ground_truth_intent",
        description:
          "Compared to the reference patch, does the agent's diff achieve the same end-to-end behavior (placeholder until explicit pick, stable \"No\" id, ack hydration on profile load, validate() guard) regardless of formatting? Score 0-5.",
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
