import type { Task } from "../types.js";

/**
 * Real EMC PR replayed as an eval task — vague-issue category.
 *
 * Provenance:
 *   Repo:    adobecom/EMC (local: /Users/rkhan/emcV2/EMC)
 *   PR:      #118 — "feat(event-form): restore Include partners toggle for showSponsors"
 *   Parent:  f7c19fc230c4e5aecfe06b46d12cf96304253ce8
 *   Merge:   aed893da260263a630f554eeb9c31560f84f46b2
 *
 * Why this PR was chosen for the vague-issue bucket:
 *   - User-facing ask: "restore the Include partners control on the partners step."
 *     The agent must independently discover that the API field is `showSponsors`,
 *     that defaults live in `EventFormContext.createDefaultFormData`, that the
 *     load-time mapping lives in `eventFormMappers.mapApiResponseToFormData`, and
 *     that the UI lives in `SponsorsComponent`. None of those file paths are named
 *     in the issue.
 *   - The `EVENT_DATA_FILTER` entry for `showSponsors` already exists (so payload
 *     egress is already correct); the missing pieces are defaults + load mapper +
 *     UI binding — three coordinated edits across three files.
 *   - pod-emc-configs context contains the EventForm wiring conventions.
 */

const SOURCE_FILE = `// --------------------------------------------------------------------------
// web-src/src/contexts/EventFormContext.tsx  (excerpt — unrelated state/reducer omitted)
// --------------------------------------------------------------------------

export const createDefaultFormData = (): EventFormData => ({
  cloudType: '',
  eventType: 'in-person',
  seriesId: '',
  organizationId: '',
  name: '',
  // ... most form-data defaults omitted ...
  agendaItems: [],
  showAgendaPostEvent: false,
  sponsors: []
})

// --------------------------------------------------------------------------
// web-src/src/utils/eventFormMappers.ts  (excerpt — unrelated mapping fields omitted)
// --------------------------------------------------------------------------

export function mapApiResponseToFormData(event: EventApiResponse, locale: string): Partial<EventFormData> {
  const localized = event.localizations?.[locale] || {}
  // ... unrelated tag/agenda/venue/cta mapping omitted ...

  return {
    // ... most mapped fields omitted ...
    agendaItems: agendaItems,
    showAgendaPostEvent: event.showAgendaPostEvent || false,
    sponsors: mapSponsorsToFormData(event.sponsors || [], locale),
    promotionalItems: (localized.promotionalItems || [])
      .filter((item: any) => typeof item === 'string' ? item.trim() !== '' : item && item.title)
      .map((item: any) => typeof item === 'string' ? { title: item } : item),
    marketoIntegration: event.marketoIntegration,
    video: event.video,
  }
}

// --------------------------------------------------------------------------
// web-src/src/pages/EventForm/SponsorsComponent.tsx  (excerpt — header + render only)
// --------------------------------------------------------------------------

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
  Button, ButtonGroup, Text, TextField, Picker, PickerItem,
  Dialog, DialogContainer, Content, Heading, ActionButton, ProgressCircle,
} from '@react-spectrum/s2'
// ... other imports omitted ...

export const SponsorsComponent: React.FC = () => {
  const { formData, updateFormData /* ... */ } = useEventFormContext()
  // ... other hooks / sponsor list state omitted ...

  return (
    <div className={style({display: 'flex', flexDirection: 'column', gap: 16})}>
      {/* Header */}
      <div className={style({display: 'flex', alignItems: 'center', gap: 12})}>
        <Heading level={3} UNSAFE_style={TYPOGRAPHY.COMPONENT_HEADING}>
          Partners (optional)
        </Heading>
        {isLoadingSponsors && (
          <ProgressCircle isIndeterminate aria-label="Loading partners" />
        )}
      </div>
      {/* ... sponsor list rendering (always rendered) ... */}
    </div>
  )
}

// --------------------------------------------------------------------------
// Reference: showSponsors is already an established field on the API contract
// (EventApiResponse.showSponsors: boolean | undefined) and is already declared
// submittable in EVENT_DATA_FILTER — so the payload egress side already works
// when the field is populated on formData.
// --------------------------------------------------------------------------
`;

const ISSUE_TEXT = `feat(event-form): restore the Include partners control on the partners step

The Event Form partners step used to have a control that let event owners
opt out of showing partner info on the detail page. That control is missing
from the form today. Restore it.

The corresponding field already exists on the API contract; this is purely a
UI-and-defaults gap on the frontend (new events should default to including
partners; existing events should reflect what the API returned).`;

const GROUND_TRUTH_PATCH = `--- a/web-src/src/contexts/EventFormContext.tsx
+++ b/web-src/src/contexts/EventFormContext.tsx
@@ -228,6 +228,7 @@ export const createDefaultFormData = (): EventFormData => ({
   secondaryLinkTitle: '',
   agendaItems: [],
   showAgendaPostEvent: false,
+  showSponsors: true,
   sponsors: []
 })

--- a/web-src/src/utils/eventFormMappers.ts
+++ b/web-src/src/utils/eventFormMappers.ts
@@ -165,6 +165,7 @@ export function mapApiResponseToFormData(event: EventApiResponse, locale: string
     secondaryLinkTitle: cta?.label || '',
     agendaItems: agendaItems,
     showAgendaPostEvent: event.showAgendaPostEvent || false,
+    showSponsors: event.showSponsors ?? true,
     sponsors: mapSponsorsToFormData(event.sponsors || [], locale),
     promotionalItems: (localized.promotionalItems || [])
       .filter((item: any) => {

--- a/web-src/src/pages/EventForm/SponsorsComponent.tsx
+++ b/web-src/src/pages/EventForm/SponsorsComponent.tsx
@@ -3,7 +3,7 @@
 */

 import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
-import { Button, ButtonGroup, Text, TextField, Picker, PickerItem, Dialog, DialogContainer, Content, Heading, ActionButton, ProgressCircle } from '@react-spectrum/s2'
+import { Button, ButtonGroup, Text, TextField, Picker, PickerItem, Dialog, DialogContainer, Content, Heading, ActionButton, ProgressCircle, Checkbox } from '@react-spectrum/s2'
 import { style } from '@react-spectrum/s2/style' with { type: 'macro' }
@@ -775,6 +775,12 @@ export const SponsorsComponent: React.FC = () => {
     return new Set(sponsors.map(s => s.sponsorId).filter(Boolean) as string[])
   }, [sponsors])

+  const includePartners = formData.showSponsors ?? true
+
+  const handleIncludePartnersChange = (value: boolean) => {
+    updateFormData({ showSponsors: value })
+  }
+
   // ============================================================================
   // RENDER
   // ============================================================================
@@ -782,13 +788,27 @@ export const SponsorsComponent: React.FC = () => {
   return (
     <div className={style({display: 'flex', flexDirection: 'column', gap: 16})}>
       {/* Header */}
-      <div className={style({display: 'flex', alignItems: 'center', gap: 12})}>
-        <Heading level={3} UNSAFE_style={TYPOGRAPHY.COMPONENT_HEADING}>
-          Partners (optional)
-        </Heading>
-        {isLoadingSponsors && (
-          <ProgressCircle isIndeterminate aria-label="Loading partners" />
-        )}
+      <div className={style({display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: 16})}>
+        <div className={style({display: 'flex', alignItems: 'center', gap: 12})}>
+          <Heading level={3} UNSAFE_style={TYPOGRAPHY.COMPONENT_HEADING}>
+            Partners
+          </Heading>
+          {isLoadingSponsors && (
+            <ProgressCircle isIndeterminate aria-label="Loading partners" />
+          )}
+        </div>
+        <div className={style({display: 'flex', flexDirection: 'column', alignItems: 'end', gap: 4})}>
+          <Checkbox
+            data-testid="include-partners-checkbox"
+            isSelected={includePartners}
+            onChange={handleIncludePartnersChange}
+          >
+            Include partners
+          </Checkbox>
+          <Text UNSAFE_style={TYPOGRAPHY.HELPER_TEXT}>
+            (Partners are optional)
+          </Text>
+        </div>
       </div>
`;

export const includePartnersToggle: Task = {
  id: "real-emc-include-partners-toggle",
  type: "content",
  podId: "pod-emc-configs",
  tags: ["real-emc", "vague-issue", "form"],
  prompt: [
    "# Issue",
    ISSUE_TEXT,
    "",
    "# Current source (parent commit f7c19fc; three relevant files shown)",
    "```tsx",
    SOURCE_FILE,
    "```",
    "",
    "# Output",
    "Return ONLY a unified diff (--- / +++ / @@) covering the file(s) you need to change. No prose, no full-file rewrites.",
  ].join("\n"),
  expectedSignals: ["showSponsors", "EventFormContext", "eventFormMappers", "true"],
  groundTruth: {
    output: GROUND_TRUTH_PATCH,
    note: "adobecom/EMC PR #118, merge SHA aed893d. Parent at f7c19fc. The SponsorsComponent hunk has been trimmed to the import + header/handler changes (the original PR keeps the rest of the file unchanged).",
  },
  rubric: {
    id: "real-emc-include-partners-toggle-v1",
    criteria: [
      {
        id: "defaults_to_true",
        description:
          "Does the patch default `showSponsors: true` for new events in `EventFormContext.createDefaultFormData`? Score 0-5: 0=missing, 5=present and defaults to true (so existing events that never had the field still render with the checkbox on).",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "maps_on_load",
        description:
          "Does the load-mapper (`mapApiResponseToFormData`) read `event.showSponsors` with a `?? true` fallback so an API response with the field absent still defaults to ON? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "binds_ui_to_field",
        description:
          "Does `SponsorsComponent` add a checkbox (or equivalent control) bound to `formData.showSponsors` via `updateFormData({ showSponsors })`, so toggling persists through save? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "matches_ground_truth_intent",
        description:
          "Compared to the reference patch, does the agent's diff achieve the same effect (defaults + mapper + UI) regardless of exact formatting? Score 0-5.",
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
