import type { Task } from "../../types.js";

/**
 * Real EMC PR replayed as an eval task.
 *
 * Provenance:
 *   Repo:    adobecom/EMC (local: /Users/rkhan/emcV2/EMC)
 *   PR:      #146 — "fix(registrations): avoid S2 Tabs crash on Event report (SegmentedControl)"
 *   Parent:  04eccca90b7f18df03afe27c17a6d94c5fc7d8b7
 *   Merge:   eff22c27e0d3b3389d5f1b2de56edee2c0a26bb2
 *
 * Why this PR was chosen (off-scope / negative control):
 *   - The fix is library-specific knowledge about React Spectrum 2: the
 *     horizontal `Tabs` component can unmount the inner react-aria-components
 *     Tabs shell, leaving `TabListStateContext` null and crashing the page.
 *     The remediation pattern (swap `Tabs`/`TabPanel` for `SegmentedControl` +
 *     conditional rendering) is an EMC convention used elsewhere, but it is
 *     not encoded in any pod-emc-* living doc or in the org knowledge graph.
 *   - Expected behaviour: PIM-arm and control-arm should perform similarly.
 *     This is a negative control that catches KG-hallucinated relevance.
 */

const SOURCE_FILE = `import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { Tabs, TabList, Tab, TabPanel } from '@react-spectrum/s2'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
// ... other imports ...

export const Registrations: React.FC<RegistrationsProps> = ({ ims: _ims }) => {
  // ... state, data loading, handlers elided for brevity ...
  const [selectedTab, setSelectedTab] = useState<string>('registrations')

  return (
    <div style={{ width: '100%', padding: '32px', boxSizing: 'border-box' }}>
      {/* Header + EventSelector + EventInfo elided */}

      {/* Tabbed Content Area */}
      <div style={{ marginTop: '16px' }}>
        <Tabs
          aria-label="Registrations Dashboard"
          selectedKey={selectedTab}
          onSelectionChange={(key) => setSelectedTab(String(key))}
        >
          <TabList>
            <Tab id="registrations">Registrations</Tab>
            <Tab id="campaigns">Campaigns</Tab>
            <Tab id="sessions">Sessions</Tab>
          </TabList>
          <TabPanel id="registrations">
            <div style={{ paddingTop: '24px' }}>
              <RegistrationsTab
                selectedEventId={selectedEventId}
                attendees={attendees}
                columnConfig={effectiveColumnConfig}
                onAttendeesRefresh={handleAttendeesRefresh}
                campaigns={campaigns}
                eventTitle={selectedEvent?.title || selectedEvent?.enTitle || ''}
              />
            </div>
          </TabPanel>
          <TabPanel id="campaigns">
            <div style={{ paddingTop: '24px' }}>
              <CampaignsTab
                eventId={selectedEventId}
                event={selectedEvent}
                campaigns={campaigns}
                onCreateCampaign={handleCreateCampaign}
                onUpdateCampaign={handleUpdateCampaign}
                onDeleteCampaign={handleDeleteCampaign}
              />
            </div>
          </TabPanel>
          <TabPanel id="sessions">
            <div style={{ paddingTop: '24px' }}>
              <SessionsTab
                eventId={selectedEventId}
                attendees={attendees}
              />
            </div>
          </TabPanel>
        </Tabs>
      </div>

      <BlurredLoadingOverlay
        visible={isLoading}
        message={loadingMessage}
        ariaLabel={loadingMessage.replace(/\\.\\.\\.$/, '')}
      />
    </div>
  )
}
`;

const ISSUE_TEXT = `fix(registrations): avoid S2 Tabs crash on Event report

Problem:
S2 horizontal Tabs can take an overflow/collapse path that unmounts the
inner react-aria-components Tabs shell. That leaves TabListStateContext
unset and crashes the page with errors such as
"Cannot read properties of null (reading 'selectedKey')" and collection/
TabPanel failures in the console.

Solution:
Replace Tabs / TabList / Tab / TabPanel with SegmentedControl /
SegmentedControlItem (same pattern used elsewhere in EMC) and render the
three sections (Registrations, Campaigns, Sessions) conditionally based
on the existing selectedTab state. No change to data loading or the tab
content components.

Testing: npm run type-check; manual switch between the three sections —
confirm no error boundary and no Tabs-related console errors.`;

const GROUND_TRUTH_PATCH = `--- a/web-src/src/pages/Registrations/Registrations.tsx
+++ b/web-src/src/pages/Registrations/Registrations.tsx
@@ -3,7 +3,7 @@
 */

 import React, { useState, useEffect, useCallback, useMemo } from 'react'
-import { Tabs, TabList, Tab, TabPanel } from '@react-spectrum/s2'
+import { SegmentedControl, SegmentedControlItem } from '@react-spectrum/s2'
 import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
 import type { EventApiResponse } from '../../types/domain'
 import type { Attendee, AttendeeStats, AttendeeColumnConfig } from '../../types/attendee'
@@ -305,51 +305,44 @@ export const Registrations: React.FC<RegistrationsProps> = ({ ims: _ims }) => {
         </div>
       )}

-      {/* Tabbed Content Area */}
       <div style={{ marginTop: '16px' }}>
-        <Tabs
+        <SegmentedControl
           aria-label="Registrations Dashboard"
           selectedKey={selectedTab}
           onSelectionChange={(key) => setSelectedTab(String(key))}
         >
-          <TabList>
-            <Tab id="registrations">Registrations</Tab>
-            <Tab id="campaigns">Campaigns</Tab>
-            <Tab id="sessions">Sessions</Tab>
-          </TabList>
-          <TabPanel id="registrations">
-            <div style={{ paddingTop: '24px' }}>
-              <RegistrationsTab
-                selectedEventId={selectedEventId}
-                attendees={attendees}
-                columnConfig={effectiveColumnConfig}
-                onAttendeesRefresh={handleAttendeesRefresh}
-                campaigns={campaigns}
-                eventTitle={selectedEvent?.title || selectedEvent?.enTitle || ''}
-              />
-            </div>
-          </TabPanel>
-          <TabPanel id="campaigns">
-            <div style={{ paddingTop: '24px' }}>
-              <CampaignsTab
-                eventId={selectedEventId}
-                event={selectedEvent}
-                campaigns={campaigns}
-                onCreateCampaign={handleCreateCampaign}
-                onUpdateCampaign={handleUpdateCampaign}
-                onDeleteCampaign={handleDeleteCampaign}
-              />
-            </div>
-          </TabPanel>
-          <TabPanel id="sessions">
-            <div style={{ paddingTop: '24px' }}>
-              <SessionsTab
-                eventId={selectedEventId}
-                attendees={attendees}
-              />
-            </div>
-          </TabPanel>
-        </Tabs>
+          <SegmentedControlItem id="registrations">Registrations</SegmentedControlItem>
+          <SegmentedControlItem id="campaigns">Campaigns</SegmentedControlItem>
+          <SegmentedControlItem id="sessions">Sessions</SegmentedControlItem>
+        </SegmentedControl>
+        <div style={{ paddingTop: '24px' }}>
+          {selectedTab === 'registrations' && (
+            <RegistrationsTab
+              selectedEventId={selectedEventId}
+              attendees={attendees}
+              columnConfig={effectiveColumnConfig}
+              onAttendeesRefresh={handleAttendeesRefresh}
+              campaigns={campaigns}
+              eventTitle={selectedEvent?.title || selectedEvent?.enTitle || ''}
+            />
+          )}
+          {selectedTab === 'campaigns' && (
+            <CampaignsTab
+              eventId={selectedEventId}
+              event={selectedEvent}
+              campaigns={campaigns}
+              onCreateCampaign={handleCreateCampaign}
+              onUpdateCampaign={handleUpdateCampaign}
+              onDeleteCampaign={handleDeleteCampaign}
+            />
+          )}
+          {selectedTab === 'sessions' && (
+            <SessionsTab
+              eventId={selectedEventId}
+              attendees={attendees}
+            />
+          )}
+        </div>
       </div>
`;

export const s2TabsCrashSegmentedControl: Task = {
  id: "real-emc-s2-tabs-crash-segmented-control",
  type: "content",
  // pod-emc-configs is the least-wrong choice: the org KG has no React
  // Spectrum 2 library knowledge, so this task is intentionally off-scope.
  // Picked because the Registrations page is config-adjacent (column
  // configs, RSVP config) but the fix itself is library-internal.
  podId: "pod-emc-configs",
  asOf: "2026-05-05T14:34:21-07:00",
  tags: ["real-emc", "off-scope", "ui-lib"],
  // Re-tiered to realistic-ticket (#8): dictated Tabs->SegmentedControl solution + pasted source removed.
  prompt: [
    "# Issue",
    "fix(registrations): avoid S2 Tabs crash on Event report",
    "",
    "On the Registrations page, the Spectrum 2 horizontal Tabs can hit an",
    "overflow/collapse path that unmounts its internal tab state and crashes the page",
    "with errors like \"Cannot read properties of null (reading 'selectedKey')\" and",
    "TabPanel/collection failures in the console.",
    "",
    "Make the three-section switcher (Registrations, Campaigns, Sessions) robust so it",
    "no longer crashes, without changing data loading or the section content components",
    "themselves.",
    "",
    "Testing: npm run type-check; manually switch between the three sections and confirm",
    "no error boundary and no console errors.",
    "",
    "The page is `web-src/src/pages/Registrations/Registrations.tsx`.",
    "",
    "# Output",
    "Return ONLY a unified diff (--- / +++ / @@) against the Registrations page. No prose, no full-file rewrite.",
  ].join("\n"),
  expectedSignals: ["SegmentedControl", "SegmentedControlItem", "selectedTab"],
  kgExpectations: {
    requiredFacts: [
      "Spectrum 2 horizontal Tabs",
      "SegmentedControl",
      "conditional rendering",
    ],
    requiredSymbols: ["SegmentedControl", "SegmentedControlItem"],
  },
  groundTruth: {
    output: GROUND_TRUTH_PATCH,
    note: "adobecom/EMC PR #146, merge SHA eff22c27. Parent file at 04eccca.",
  },
  rubric: {
    id: "real-emc-s2-tabs-crash-segmented-control-v1",
    criteria: [
      {
        id: "replaces_tabs_with_segmented_control",
        description:
          "Does the patch remove the `<Tabs>`/`<TabList>`/`<Tab>`/`<TabPanel>` structure (and the corresponding import) and replace it with `<SegmentedControl>`/`<SegmentedControlItem>`? Score 0-5: 0=Tabs preserved, 5=fully swapped including import.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "uses_conditional_rendering",
        description:
          "Does the patch render each section's content conditionally on `selectedTab === 'registrations' | 'campaigns' | 'sessions'` rather than relying on TabPanel children to switch panels? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "preserves_section_props",
        description:
          "Are all three sections (RegistrationsTab, CampaignsTab, SessionsTab) preserved with their prop sets unchanged (selectedEventId/eventId, attendees, columnConfig, onAttendeesRefresh, campaigns, eventTitle, event, onCreateCampaign, onUpdateCampaign, onDeleteCampaign)? Score 0-5.",
        scale: "0-5",
        weight: 1.5,
      },
      {
        id: "matches_ground_truth_intent",
        description:
          "Compared to the reference patch, does the agent's diff achieve the same effect (SegmentedControl + conditional rendering of all three panels with preserved props) regardless of exact formatting? Score 0-5.",
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
