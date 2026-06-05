import type { Task } from "../../types.js";

/**
 * Real EMC PR replayed as an eval task.
 *
 * Provenance:
 *   Repo:    adobecom/EMC (local: /Users/rkhan/emcV2/EMC)
 *   PR:      #150 — "feat(rsvp): SXSW ticket field (requiresSxswTicket) console support"
 *   Parent:  cd1892d42c98c523d7c322f7e3a4f86226d2edb6
 *   Merge:   dd81c423ce1e4d2326d36bdc4900f57613f3a8e2
 *
 * Why this PR was chosen (housestyle):
 *   - The merged PR touches 5 files; this task focuses on the housestyle
 *     decision in RegistrationFieldsComponent.tsx: load the RSVP field
 *     catalog through `configService.getRsvpConfig` (cached + retry) rather
 *     than hardcoding `requiresSxswTicket` in the component. EMC's
 *     pod-emc-configs living doc encodes this catalog-loading convention
 *     and the JSON field schema (`Field`, `Label`, `Type`, `Required`).
 *   - The agent should also use the `Label` field from the JSON catalog
 *     when present (with `convertString(fieldName)` as the fallback) and
 *     document the new attendee field on the `Attendee` type.
 *   - Control-arm should hardcode (or invent its own loader); PIM-arm,
 *     given the pod context, should know to route through configService.
 */

const SOURCE_FILE = `// web-src/src/pages/EventForm/RegistrationFieldsComponent.tsx (parent cd1892d)

import React, { useState, useEffect } from 'react'
import { TextField, RadioGroup, Radio, Text, Switch } from '@react-spectrum/s2'
import { style } from "@react-spectrum/s2/style" with { type: "macro" }
import { HeadingWithTooltip } from '../../components/shared'
import { COLORS, SURFACES } from '../../styles/designSystem'
import OpenIn from '@react-spectrum/s2/icons/OpenIn'
import Move from '@react-spectrum/s2/icons/Move'

/** Configuration field structure from the JSON configs */
interface RsvpConfigField {
  Field: string
  Type: string
  Required?: string
}

interface RsvpConfig {
  cloudType: string
  config: RsvpConfigField[] | null
}

/** Extended field with display info */
interface DisplayField {
  fieldName: string
  isMandated: boolean
  originalIndex: number
}

/** Converts camelCase / PascalCase into uppercase with spaces. */
const convertString = (input: string): string => {
  const parts = input.replace(/([a-z])([A-Z])/g, '$1 $2')
  return parts.toUpperCase()
}

/** Fetches RSVP form configurations for all supported clouds (current: inline fetch, no caching/retry). */
const fetchRsvpFormConfigs = async (): Promise<RsvpConfig[]> => {
  const SUPPORTED_CLOUDS = [
    { id: 'CreativeCloud', name: 'Creative Cloud' },
    { id: 'ExperienceCloud', name: 'Experience Cloud' }
  ]
  return Promise.all(
    SUPPORTED_CLOUDS.map(async ({ id }) => {
      try {
        const response = await fetch(\`https://www.adobe.com/event-libs/assets/configs/rsvp/\${id.toLowerCase()}.json\`)
        if (!response.ok) {
          console.error(\`Failed to fetch RSVP config for \${id}: \${response.status} \${response.statusText}\`)
          return { cloudType: id, config: null }
        }
        const data = await response.json()
        const config = Array.isArray(data) ? data : (data.data || data.fields || data.config || null)
        return { cloudType: id, config }
      } catch (error) {
        console.error(\`Failed to fetch RSVP config for \${id}:\`, error)
        return { cloudType: id, config: null }
      }
    })
  )
}

// ... component body. Key snippets:
//
//   const validFields = currentConfig.filter((f) => f.Field && f.Field.trim() !== '' && f.Type !== 'submit')
//   const allDisplayFields: DisplayField[] = validFields.map((f, idx) => ({
//     fieldName: f.Field,
//     isMandated: f.Required === 'x',
//     originalIndex: idx,
//   }))
//
//   // Render:
//   <Text UNSAFE_style={{ fontWeight: 500 }}>
//     {convertString(fieldName)}
//   </Text>

// web-src/src/types/attendee.ts (parent cd1892d)

export interface Attendee {
  attendeeId: string
  firstName: string
  lastName: string
  email: string
  registrationStatus: RegistrationStatus
  checkedIn: boolean
  // ... other optional BaseAttendee fields ...
  isGuest?: boolean
  invitedBy?: string
  shareInfoWithPartners?: boolean
  ccSentiment?: string
  campaignId?: string
  creationTime?: number
  modificationTime?: number
  [key: string]: any
}
`;

const ISSUE_TEXT = `feat(rsvp): SXSW ticket field (requiresSxswTicket) console support (MWPW-194794)

Implement frontend support for the new optional boolean attendee field
\`requiresSxswTicket\` (Experience Cloud RSVP). The field is defined in the
hosted event-libs experiencecloud.json catalog — it should NOT be
hardcoded in the component.

Requirements:
- RegistrationFieldsComponent must load the RSVP field catalogs through
  EMC's standard config-loading service (with caching and retry), not via
  ad-hoc fetch in the component. Reuse the existing JSON schema
  (Field / Type / Required / Label).
- When the JSON entry has a Label, render that label (e.g. "SXSW ticket
  required?"); fall back to the existing convertString(fieldName) when
  Label is absent. Mandated-field notes should also use labels.
- Document the new optional boolean on the Attendee type so downstream
  table cells, filter chips, and CSV export can reference it without
  bypassing the type system.

(Companion work — out of scope for this task — renders the boolean as
yes/no in attendee tables, filter chips, and CSV export.)`;

const GROUND_TRUTH_PATCH = `--- a/web-src/src/pages/EventForm/RegistrationFieldsComponent.tsx
+++ b/web-src/src/pages/EventForm/RegistrationFieldsComponent.tsx
@@ -9,26 +9,16 @@ import { HeadingWithTooltip } from '../../components/shared'
 import { COLORS, SURFACES } from '../../styles/designSystem'
 import OpenIn from '@react-spectrum/s2/icons/OpenIn'
 import Move from '@react-spectrum/s2/icons/Move'
-
-/**
- * Configuration field structure from the JSON configs
- */
-interface RsvpConfigField {
-  Field: string
-  Type: string
-  Required?: string
-}
+import { configService } from '../../services/configService'
+import type { RsvpConfigField } from '../../types/attendee'

 interface RsvpConfig {
   cloudType: string
   config: RsvpConfigField[] | null
 }

-/**
- * Extended field with display info
- */
 interface DisplayField {
   fieldName: string
+  displayLabel: string
   isMandated: boolean
   originalIndex: number
 }
@@ -54,29 +44,15 @@ const convertString = (input: string): string => {
   return parts.toUpperCase()
 }

-/**
- * Fetches RSVP form configurations for all supported clouds
- */
 const fetchRsvpFormConfigs = async (): Promise<RsvpConfig[]> => {
-  const SUPPORTED_CLOUDS = [
-    { id: 'CreativeCloud', name: 'Creative Cloud' },
-    { id: 'ExperienceCloud', name: 'Experience Cloud' }
-  ]
-
+  const clouds = ['CreativeCloud', 'ExperienceCloud'] as const
   return Promise.all(
-    SUPPORTED_CLOUDS.map(async ({ id }) => {
-      try {
-        const response = await fetch(\`https://www.adobe.com/event-libs/assets/configs/rsvp/\${id.toLowerCase()}.json\`)
-        if (!response.ok) {
-          console.error(\`Failed to fetch RSVP config for \${id}: \${response.status} \${response.statusText}\`)
-          return { cloudType: id, config: null }
-        }
-        const data = await response.json()
-        const config = Array.isArray(data) ? data : (data.data || data.fields || data.config || null)
-        return { cloudType: id, config }
-      } catch (error) {
-        console.error(\`Failed to fetch RSVP config for \${id}:\`, error)
-        return { cloudType: id, config: null }
-      }
-    })
+    clouds.map(async (id) => ({
+      cloudType: id,
+      config: await configService.getRsvpConfig(id),
+    }))
   )
 }
@@ -136,6 +112,7 @@ export const RegistrationFieldsComponent: React.FC<RegistrationFieldsComponentPr
   const allDisplayFields: DisplayField[] = validFields.map((f, idx) => ({
     fieldName: f.Field,
+    displayLabel: (f.Label && f.Label.trim()) || convertString(f.Field),
     isMandated: f.Required === 'x',
     originalIndex: idx
   }))
@@ -342,7 +319,7 @@ export const RegistrationFieldsComponent: React.FC<RegistrationFieldsComponentPr
           {/* Field rows */}
           <div className={style({display: 'flex', flexDirection: 'column', gap: 8})} >
             {sortedDisplayFields.map((displayField, displayIndex) => {
-              const { fieldName, isMandated } = displayField
+              const { fieldName, displayLabel, isMandated } = displayField
               const isVisible = visibleFields.includes(fieldName)
@@ -381,7 +358,7 @@ export const RegistrationFieldsComponent: React.FC<RegistrationFieldsComponentPr
                 >
                   <Text UNSAFE_style={{ fontWeight: 500 }}>
-                    {convertString(fieldName)}
+                    {displayLabel}
                     {isMandated && (
                       <Text UNSAFE_style={{ fontSize: '11px' }}>...</Text>
                     )}
--- a/web-src/src/types/attendee.ts
+++ b/web-src/src/types/attendee.ts
@@ -55,6 +55,7 @@ export interface Attendee {
   isGuest?: boolean
   invitedBy?: string
   shareInfoWithPartners?: boolean
+  requiresSxswTicket?: boolean
   ccSentiment?: string
`;

export const sxswTicketFieldConfigService: Task = {
  id: "real-emc-sxsw-ticket-field-config-service",
  type: "content",
  // pod-emc-configs encodes the RSVP catalog JSON schema (Field/Label/Type/
  // Required) and the convention that field metadata is loaded via
  // configService.getRsvpConfig with caching and retry rather than ad-hoc
  // fetches from the component. PIM-arm should pull this knowledge.
  podId: "pod-emc-configs",
  asOf: "2026-05-08T09:31:21-07:00",
  tags: ["real-emc", "housestyle", "rsvp"],
  prompt: [
    "# Issue",
    ISSUE_TEXT,
    "",
    "# Current source (parent commit cd1892d)",
    "```tsx",
    SOURCE_FILE,
    "```",
    "",
    "# Output",
    "Return ONLY a unified diff (--- / +++ / @@) covering `web-src/src/pages/EventForm/RegistrationFieldsComponent.tsx` and `web-src/src/types/attendee.ts`. No prose, no full-file rewrite.",
  ].join("\n"),
  expectedSignals: ["configService", "getRsvpConfig", "requiresSxswTicket"],
  groundTruth: {
    output: GROUND_TRUTH_PATCH,
    note: "adobecom/EMC PR #150, merge SHA dd81c423. Parent files at cd1892d. Other files in the merged PR (AttendeeFiltersComponent, AttendeeTableComponent, ExportDialog) are intentionally out of scope here.",
  },
  rubric: {
    id: "real-emc-sxsw-ticket-field-config-service-v1",
    criteria: [
      {
        id: "loads_field_catalog_via_config_service",
        description:
          "Does the patch fetch the RSVP field catalog through `configService.getRsvpConfig` (the EMC catalog loader with caching/retry) rather than keeping the inline `fetch(...event-libs/assets/configs/rsvp/...)` call or hardcoding `requiresSxswTicket` in the component? Score 0-5: 0=hardcodes the field or keeps ad-hoc fetch, 5=fully routes through configService.getRsvpConfig.",
        scale: "0-5",
        weight: 2.5,
      },
      {
        id: "uses_catalog_label",
        description:
          "Does the patch render each field's label from the JSON catalog (e.g. `f.Label?.trim() || convertString(f.Field)`) instead of always calling `convertString(fieldName)`? Score 0-5.",
        scale: "0-5",
        weight: 1.5,
      },
      {
        id: "documents_attendee_type",
        description:
          "Does the patch add `requiresSxswTicket?: boolean` to the `Attendee` interface in `web-src/src/types/attendee.ts` so downstream consumers are typed? Score 0-5.",
        scale: "0-5",
        weight: 1,
      },
      {
        id: "matches_ground_truth_intent",
        description:
          "Compared to the reference patch, does the agent's diff achieve the same effect (configService-driven catalog load, label-from-JSON rendering, typed attendee field) regardless of exact formatting? Score 0-5.",
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
