import type { Task } from "../../types.js";

/**
 * Real EMC PR replayed as an eval task.
 *
 * Provenance:
 *   Repo:    adobecom/EMC (local: /Users/rkhan/emcV2/EMC)
 *   PR:      #79 — "Fix UI permission leaks — gate write/delete actions by RBAC role"
 *   Parent:  c44fe3d (state of EventsDashboard.tsx BEFORE the merge)
 *   Merge:   b25effb
 *
 * Scope of THIS task file:
 *   Only web-src/src/pages/EventsDashboard/EventsDashboard.tsx. The full PR
 *   also touched SeriesDashboard, SpeakersDashboard, CampaignsTab and App
 *   route guards; those are intentionally out of scope here.
 */

const SOURCE_FILE = `// imports near top of file
import { seriesEnrichmentManager, SeriesInfo } from '../../services/seriesEnrichment'
import { IMS } from '../../types'
import { useToast, useGroup } from '../../contexts'
import { filterEventData } from '../../utils/dataFilters'
import { useSafeState, useRBACFilter } from '../../hooks'
import { getEspEnvParam } from '../../config/constants'

// ... component top ...
export const EventsDashboard: React.FC<EventsDashboardProps> = () => {
  const toast = useToast()
  const navigate = useNavigate()
  const { filterEvents } = useRBACFilter()
  const [events, setEvents] = useSafeState<EventDashboardItem[]>([])
  // ... other state ...

  // ... per-row actions menu (inside columns useMemo) ...
  render: (item) => (
    <MenuTrigger>
      <ActionButton isQuiet aria-label="Actions menu">
        <More />
      </ActionButton>
      <Menu onAction={(key) => handleMenuAction(key as string, item)}>
        <MenuItem id="publish" textValue={item.published ? 'Unpublish' : 'Publish'}>
          {item.published ? <PublishNo /> : <Publish />}
          <Text slot="label">{item.published ? 'Unpublish' : 'Publish'}</Text>
        </MenuItem>
        <MenuItem id="preview-pre" textValue="Preview pre-event">
          <Preview />
          <Text slot="label">Preview pre-event</Text>
        </MenuItem>
        <MenuItem id="preview-post" textValue="Preview post-event">
          <Preview />
          <Text slot="label">Preview post-event</Text>
        </MenuItem>
        <MenuItem id="copy-url" textValue="Copy URL">
          <Copy />
          <Text slot="label">Copy URL</Text>
        </MenuItem>
        <MenuItem id="edit" textValue="Edit">
          <Edit />
          <Text slot="label">Edit</Text>
        </MenuItem>
        <MenuItem id="clone" textValue="Clone">
          <Duplicate />
          <Text slot="label">Clone</Text>
        </MenuItem>
        <MenuItem id="delete" textValue="Delete">
          <Delete />
          <Text slot="label">Delete</Text>
        </MenuItem>
      </Menu>
    </MenuTrigger>
  )

  // ... later, the create button ...
  // Custom create button with dropdown menu
  const createEventButton = useMemo(() => (
    <MenuTrigger>
      <Button variant="accent">Create new event</Button>
      <Menu onAction={(key) => handleCreateEvent(key as EventType)}>
        {eventTypeOptions.map(option => (
          <MenuItem key={option.key} id={option.key} textValue={option.label}>
            {eventTypeIcons[option.key]}
            <Text slot="label">{option.label}</Text>
          </MenuItem>
        ))}
      </Menu>
    </MenuTrigger>
  ), [handleCreateEvent, eventTypeOptions])
`;

const ISSUE_TEXT = `Fix UI permission leaks — gate write/delete actions by RBAC role

EventsDashboard currently shows every row-level action (Publish/Unpublish,
Edit, Clone, Delete) and the top-level "Create new event" button to every
user, regardless of role. Read-only users see buttons that 403 when they
click them. Hide them.

Use the existing useHasPermission hook (\\\`useHasPermission('event', 'write')\\\`
and \\\`useHasPermission('event', 'delete')\\\`).

Rules:
- Create button: hidden unless the user has event:write.
- Publish/Unpublish row item: gated by event:write.
- Edit row item: gated by event:write.
- Clone row item: gated by event:write.
- Delete row item: gated by event:delete.
- Preview pre-event, Preview post-event, and Copy URL must remain
  visible to every user (they are read-only operations).`;

const GROUND_TRUTH_PATCH = `--- a/web-src/src/pages/EventsDashboard/EventsDashboard.tsx
+++ b/web-src/src/pages/EventsDashboard/EventsDashboard.tsx
@@ -27,6 +27,7 @@ import { IMS } from '../../types'
 import { useToast, useGroup } from '../../contexts'
 import { filterEventData } from '../../utils/dataFilters'
 import { useSafeState, useRBACFilter } from '../../hooks'
+import { useHasPermission } from '../../hooks/useHasPermission'
 import { getEspEnvParam } from '../../config/constants'

 const EVENTS_SEARCH_KEYS = ['eventName', 'eventType', 'cloudType', 'hostEmail', 'seriesId']
@@ -39,6 +40,8 @@ export const EventsDashboard: React.FC<EventsDashboardProps> = () => {
   const toast = useToast()
   const navigate = useNavigate()
   const { filterEvents } = useRBACFilter()
+  const canWriteEvent = useHasPermission('event', 'write')
+  const canDeleteEvent = useHasPermission('event', 'delete')
   const [events, setEvents] = useSafeState<EventDashboardItem[]>([])
   const [isLoading, setIsLoading] = useSafeState(true)
   const [error, setError] = useSafeState<string | null>(null)
@@ -817,10 +820,12 @@ export const EventsDashboard: React.FC<EventsDashboardProps> = () => {
             <More />
           </ActionButton>
           <Menu onAction={(key) => handleMenuAction(key as string, item)}>
-            <MenuItem id="publish" textValue={item.published ? 'Unpublish' : 'Publish'}>
-              {item.published ? <PublishNo /> : <Publish />}
-              <Text slot="label">{item.published ? 'Unpublish' : 'Publish'}</Text>
-            </MenuItem>
+            {canWriteEvent && (
+              <MenuItem id="publish" textValue={item.published ? 'Unpublish' : 'Publish'}>
+                {item.published ? <PublishNo /> : <Publish />}
+                <Text slot="label">{item.published ? 'Unpublish' : 'Publish'}</Text>
+              </MenuItem>
+            )}
             <MenuItem id="preview-pre" textValue="Preview pre-event">
               <Preview />
               <Text slot="label">Preview pre-event</Text>
@@ -833,18 +838,24 @@ export const EventsDashboard: React.FC<EventsDashboardProps> = () => {
               <Copy />
               <Text slot="label">Copy URL</Text>
             </MenuItem>
-            <MenuItem id="edit" textValue="Edit">
-              <Edit />
-              <Text slot="label">Edit</Text>
-            </MenuItem>
-            <MenuItem id="clone" textValue="Clone">
-              <Duplicate />
-              <Text slot="label">Clone</Text>
-            </MenuItem>
-            <MenuItem id="delete" textValue="Delete">
-              <Delete />
-              <Text slot="label">Delete</Text>
-            </MenuItem>
+            {canWriteEvent && (
+              <MenuItem id="edit" textValue="Edit">
+                <Edit />
+                <Text slot="label">Edit</Text>
+              </MenuItem>
+            )}
+            {canWriteEvent && (
+              <MenuItem id="clone" textValue="Clone">
+                <Duplicate />
+                <Text slot="label">Clone</Text>
+              </MenuItem>
+            )}
+            {canDeleteEvent && (
+              <MenuItem id="delete" textValue="Delete">
+                <Delete />
+                <Text slot="label">Delete</Text>
+              </MenuItem>
+            )}
           </Menu>
         </MenuTrigger>
       )
@@ -887,20 +898,23 @@ export const EventsDashboard: React.FC<EventsDashboardProps> = () => {
     'webinar': <GlobeGrid />,
   }

-  // Custom create button with dropdown menu
-  const createEventButton = useMemo(() => (
-    <MenuTrigger>
-      <Button variant="accent">Create new event</Button>
-      <Menu onAction={(key) => handleCreateEvent(key as EventType)}>
-        {eventTypeOptions.map(option => (
-          <MenuItem key={option.key} id={option.key} textValue={option.label}>
-            {eventTypeIcons[option.key]}
-            <Text slot="label">{option.label}</Text>
-          </MenuItem>
-        ))}
-      </Menu>
-    </MenuTrigger>
-  ), [handleCreateEvent, eventTypeOptions])
+  // Custom create button with dropdown menu — only shown when user has event:write
+  const createEventButton = useMemo(() => {
+    if (!canWriteEvent) return undefined
+    return (
+      <MenuTrigger>
+        <Button variant="accent">Create new event</Button>
+        <Menu onAction={(key) => handleCreateEvent(key as EventType)}>
+          {eventTypeOptions.map(option => (
+            <MenuItem key={option.key} id={option.key} textValue={option.label}>
+              {eventTypeIcons[option.key]}
+              <Text slot="label">{option.label}</Text>
+            </MenuItem>
+          ))}
+        </Menu>
+      </MenuTrigger>
+    )
+  }, [canWriteEvent, handleCreateEvent, eventTypeOptions])
`;

export const rbacEventsDashboardGating: Task = {
  id: "real-emc-rbac-events-dashboard-gating",
  type: "content",
  podId: "pod-emc-rbac",
  asOf: "2026-03-25T16:02:19-07:00",
  tags: ["real-emc", "rbac", "ui"],
  // Re-tiered to realistic-ticket (#8): exact hook + per-item permission map removed.
  prompt: [
    "# Issue",
    "Fix UI permission leaks — gate write/delete actions by RBAC role",
    "",
    "EventsDashboard shows every row-level action (Publish/Unpublish, Edit, Clone,",
    "Delete) and the top-level \"Create new event\" button to everyone, regardless of",
    "role. Read-only users see controls that just 403 when clicked. Hide actions the",
    "user isn't allowed to perform.",
    "",
    "Write actions (create, publish/unpublish, edit, clone) should only show for users",
    "with write access; deletion should be gated on its own delete permission. Genuinely",
    "read-only actions (the two Preview items and Copy URL) must remain visible to all",
    "users. Use the codebase's existing permission-check hook.",
    "",
    "The file is `web-src/src/pages/EventsDashboard/EventsDashboard.tsx`.",
    "",
    "# Output",
    "Return ONLY a unified diff (--- / +++ / @@) against the EventsDashboard component. No prose, no full-file rewrite.",
  ].join("\n"),
  expectedSignals: [
    "useHasPermission",
    "canWriteEvent",
    "canDeleteEvent",
    "event:write",
    "event:delete",
  ],
  groundTruth: {
    output: GROUND_TRUTH_PATCH,
    note: "adobecom/EMC PR #79, merge SHA b25effb. Parent file at c44fe3d. (Other files in this PR (SeriesDashboard, SpeakersDashboard, CampaignsTab, App.tsx) are intentionally out of scope here.)",
  },
  rubric: {
    id: "real-emc-rbac-events-dashboard-gating-v1",
    criteria: [
      {
        id: "imports_use_has_permission",
        description:
          "Does the patch import and call useHasPermission for both 'event','write' and 'event','delete' (or equivalent role/scope/action shape)? Boolean.",
        scale: "boolean",
        weight: 1.5,
      },
      {
        id: "gates_write_actions",
        description:
          "Does the patch gate the Publish/Unpublish, Edit, and Clone menu items behind the write permission so they do not render for read-only users? Score 0-5: 0=none gated, 5=all three gated correctly.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "gates_delete_action",
        description:
          "Does the patch gate the Delete menu item behind the delete permission (a separate check from write)? Boolean.",
        scale: "boolean",
        weight: 1.5,
      },
      {
        id: "preserves_read_only_items",
        description:
          "Does the patch leave Preview pre-event, Preview post-event, and Copy URL visible to all users (unconditional render)? Score 0-5.",
        scale: "0-5",
        weight: 1.5,
      },
      {
        id: "gates_create_button",
        description:
          "Does the patch hide the top-level 'Create new event' button (or its MenuTrigger) when the user lacks write permission, e.g. by returning undefined/null from the useMemo when the permission is false? Boolean.",
        scale: "boolean",
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
        id: "no_invented_permissions",
        description:
          "Does the patch avoid inventing permission names that don't match the contract (e.g., 'admin', 'manage')? It should use the 'event','write' and 'event','delete' pair, not a single combined check. Boolean.",
        scale: "boolean",
        weight: 1,
      },
    ],
  },
};
