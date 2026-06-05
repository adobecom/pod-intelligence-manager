import type { Task } from "../../types.js";

/**
 * Real EMC PR replayed as an eval task.
 *
 * Provenance:
 *   Repo:    adobecom/EMC (local: /Users/rkhan/emcV2/EMC)
 *   PR:      #80 — "Add \"My\" filter and sync user menu"
 *   Parent:  c4c8d9bfc2916fa70d9d39ef56dd44b198c2a2bf
 *   Merge:   985daa838839219e2b5a94ec839ac5e0ac4edfb8
 *
 * Why this PR was chosen:
 *   - RBAC-scoped feature add: a "My" Switch on the Access Management
 *     page that narrows both the Scope picker and the Groups table to
 *     scopes/groups the current user is a member of (sourced from
 *     useGroup().groups), plus calls refreshGroups() after any
 *     self-affecting mutation (delete group, add self, remove self) so
 *     the side user menu stays in sync.
 */

const SOURCE_FILE = `// web-src/src/pages/ScopeGroupManagement/ScopeGroupManagement.tsx — focused excerpts at parent c4c8d9b

// --- IMPORTS (head of file) ---
import React, { useState, useCallback, useMemo, useEffect } from 'react'
import {
  View,
  DialogTrigger as V3DialogTrigger,
  AlertDialog,
  ActionButton,
} from '@adobe/react-spectrum'
import { Badge, Button, ButtonGroup, TextField, Picker, PickerItem, ComboBox, ComboBoxItem, Text, DialogTrigger, Dialog, Content, Heading } from "@react-spectrum/s2"
// ...other icon imports
import { useApi } from '../../contexts/ApiContext'
import { useToast } from '../../contexts'
// ...type imports

// --- COMPONENT TOP ---
export const ScopeGroupManagement: React.FC<ScopeGroupManagementProps> = () => {
  const apiService = useApi()
  const toast = useToast()

  // Permissions
  const canWriteScope = useHasPermission('scope', 'write')
  // ...other permissions

  // Scope state
  const [scopes, setScopes] = useState<RBACApiScope[]>([])
  const [selectedScopeId, setSelectedScopeId] = useState<string | null>(null)
  const [scopeFilterText, setScopeFilterText] = useState('')
  const [isLoadingScopes, setIsLoadingScopes] = useState(true)
  // ...other state

  // --- DERIVED DATA (current) ---
  const selectedScope = useMemo(
    () => scopes.find(s => s.scopeId === selectedScopeId) || null,
    [scopes, selectedScopeId]
  )

  const filteredScopes = useMemo(() => {
    const items = scopes.map(s => ({ id: s.scopeId, name: s.name, type: s.type }))
    if (!scopeFilterText) return items
    const lower = scopeFilterText.toLowerCase()
    return items.filter(s => s.name.toLowerCase().includes(lower) || s.type.toLowerCase().includes(lower))
  }, [scopes, scopeFilterText])

  // --- EFFECTS (current) ---
  useEffect(() => { loadScopes() }, [loadScopes])
  useEffect(() => { loadGroups() }, [loadGroups])

  useEffect(() => {
    setSelectedGroup(null)
    setExpandedGroupIds(new Set())
    setGroupUsersMap({})
  }, [selectedScopeId])

  // --- GROUP DELETE (current tail) ---
  // ...inside handleDeleteGroup, after success:
  //   await loadGroups()
  // ...end of try
  // deps: [apiService, selectedScopeId, toast, loadGroups, selectedGroup]

  // --- USER SAVE (current excerpt) ---
  const handleSaveUser = useCallback(async () => {
    // ...editingUser branch unchanged
    if (!newUserEmail.trim()) return
    const result = await apiService.addGroupUser(selectedScopeId, selectedGroup.groupId, {
      email: newUserEmail.trim().toLowerCase(),
      ...(newUserFirstName.trim() && { firstName: newUserFirstName.trim() }),
      ...(newUserLastName.trim() && { lastName: newUserLastName.trim() }),
      ...(newUserGuid.trim() && { userGuid: newUserGuid.trim() }),
    })
    // ...toast + reset, then:
    await loadGroupUsersForExpand(selectedGroup.groupId)
    // deps: [..., loadGroupUsersForExpand]
  }, [/* deps */])

  // --- USER REMOVE (current excerpt) ---
  // ...after toast.success('User removed'):
  //   setUserToRemove(null)
  //   await loadGroupUsersForExpand(selectedGroup.groupId)
  // deps: [selectedGroup, selectedScopeId, apiService, toast, loadGroupUsersForExpand]

  // --- RENDER (current) ---
  return (
    <View padding="size-400" maxWidth="1400px" marginX="auto">
      <div className={style({display: 'flex', flexDirection: 'column', gap: 32})}>
        <Heading level={1}>Access Management</Heading>

        {/* Scope selector + actions */}
        <div className={style({padding: 20})}>
          <div className={style({display: 'flex', justifyContent: 'space-between', alignItems: 'end', gap: 16, flexWrap: 'wrap'})}>
            <div className={style({display: 'flex', alignItems: 'end', gap: 8})}>
              <ComboBox
                label={\`Select Scope (\${scopes.length} scope\${scopes.length === 1 ? '' : 's'} available)\`}
                selectedKey={selectedScopeId}
                onSelectionChange={(key) => setSelectedScopeId(key as string | null)}
                onInputChange={setScopeFilterText}
                defaultItems={filteredScopes}
                /* ...other props */
              >
                {/* item template */}
              </ComboBox>
              {/* selectedScope actions */}
            </div>
            {/* New Scope button */}
          </div>
        </div>

        {/* Groups table */}
        {selectedScopeId ? (
          <ResourceDashboardLayout
            title="Groups"
            totalCount={groups.length}
            error={groupError}
            data={groups}
            columns={groupColumns}
            getItemKey={(item) => item.groupId}
            /* ...createButton, onRefresh, empty state */
          />
        ) : null}
      </div>
    </View>
  )
}

// Available helpers / contexts (do NOT redefine):
//   useGroup() returns { groups: Array<{ groupId: string; scopeId?: string }>, refreshGroups: () => Promise<void> }
//   useAuth() returns { ims: { profile?: { email?: string } } }
//   '@react-spectrum/s2' already exports Switch.
`;

const ISSUE_TEXT = `Add a "My" filter and keep the side user menu in sync on the Access Management page.

UX:
  - A Switch labeled "My" sits next to the Access Management Heading.
  - When ON, the Scope picker (ComboBox) only shows scopes that the
    current user is a member of, and the Groups table only shows groups
    the user belongs to within the selected scope.
  - The ComboBox label count should reflect the *filtered* scope list,
    not the raw scopes.length.
  - When the currently-selected scope falls out of the filtered pool
    (e.g., user just turned "My" on), clear the selection.
  - When the table data set shrinks, drop any expanded-row / cached
    users for groups that are no longer visible, and clear the
    selectedGroup if it is no longer visible.

Sync side menu:
  - The app's left rail user menu derives its visible scope groups from
    useGroup(). After any of these self-affecting mutations, also call
    refreshGroups():
      1. After successfully deleting a group the current user is a
         member of.
      2. After successfully adding the current user (their own email)
         to a group.
      3. After successfully removing the current user from a group.

Wire-up:
  - Pull \`groups: userMemberGroups\` and \`refreshGroups\` from useGroup().
  - Pull \`ims\` from useAuth() to compare emails case-insensitively.
  - The /me/groups response may omit scopeId on each membership; when
    so, fall back to matching by groupId within the selected scope's
    group list.

Do not change unrelated CRUD, table columns, or styles.`;

const GROUND_TRUTH_PATCH = `--- a/web-src/src/pages/ScopeGroupManagement/ScopeGroupManagement.tsx
+++ b/web-src/src/pages/ScopeGroupManagement/ScopeGroupManagement.tsx
@@ -15,7 +15,7 @@ import {
   AlertDialog,
   ActionButton,
 } from '@adobe/react-spectrum'
-import { Badge, Button, ButtonGroup, TextField, Picker, PickerItem, ComboBox, ComboBoxItem, Text, DialogTrigger, Dialog, Content, Heading } from "@react-spectrum/s2"
+import { Badge, Button, ButtonGroup, TextField, Picker, PickerItem, ComboBox, ComboBoxItem, Text, DialogTrigger, Dialog, Content, Heading, Switch } from "@react-spectrum/s2"
 import { style } from "@react-spectrum/s2/style" with { type: "macro" }
 import EditIcon from "@react-spectrum/s2/icons/Edit"
 import DeleteIcon from "@react-spectrum/s2/icons/Delete"
@@ -24,7 +24,7 @@ import UserAdd from "@react-spectrum/s2/icons/UserAdd"
 import RemoveCircle from "@react-spectrum/s2/icons/RemoveCircle"
 import UserGroupIcon from "@react-spectrum/s2/icons/UserGroup"
 import { useApi } from '../../contexts/ApiContext'
-import { useToast } from '../../contexts'
+import { useToast, useGroup, useAuth } from '../../contexts'
 import { IMS } from '../../types'
 import type {
   RBACApiScope,
@@ -60,6 +60,8 @@ const GROUP_SEARCH_KEYS = ['name', 'description']
 export const ScopeGroupManagement: React.FC<ScopeGroupManagementProps> = () => {
   const apiService = useApi()
   const toast = useToast()
+  const { ims } = useAuth()
+  const { groups: userMemberGroups, refreshGroups } = useGroup()

   // Permissions
   const canWriteScope = useHasPermission('scope', 'write')
@@ -76,6 +78,7 @@ export const ScopeGroupManagement: React.FC<ScopeGroupManagementProps> = () => {
   const [scopes, setScopes] = useState<RBACApiScope[]>([])
   const [selectedScopeId, setSelectedScopeId] = useState<string | null>(null)
   const [scopeFilterText, setScopeFilterText] = useState('')
+  const [myScopesOnly, setMyScopesOnly] = useState(false)
   const [isLoadingScopes, setIsLoadingScopes] = useState(true)
   const [roles, setRoles] = useState<RBACApiRole[]>([])

@@ -135,12 +138,45 @@ export const ScopeGroupManagement: React.FC<ScopeGroupManagementProps> = () => {
     [scopes, selectedScopeId]
   )

+  const scopeIdsImMemberOf = useMemo(() => {
+    const ids = new Set<string>()
+    for (const g of userMemberGroups) {
+      if (g.scopeId) ids.add(g.scopeId)
+    }
+    return ids
+  }, [userMemberGroups])
+
+  const scopesForPicker = useMemo(() => {
+    if (!myScopesOnly) return scopes
+    return scopes.filter(s => scopeIdsImMemberOf.has(s.scopeId))
+  }, [scopes, myScopesOnly, scopeIdsImMemberOf])
+
   const filteredScopes = useMemo(() => {
-    const items = scopes.map(s => ({ id: s.scopeId, name: s.name, type: s.type }))
+    const items = scopesForPicker.map(s => ({ id: s.scopeId, name: s.name, type: s.type }))
     if (!scopeFilterText) return items
     const lower = scopeFilterText.toLowerCase()
     return items.filter(s => s.name.toLowerCase().includes(lower) || s.type.toLowerCase().includes(lower))
-  }, [scopes, scopeFilterText])
+  }, [scopesForPicker, scopeFilterText])
+
+  /** Group IDs the current user belongs to for the selected scope (for table filter). */
+  const myGroupIdsInSelectedScope = useMemo(() => {
+    if (!selectedScopeId) return new Set<string>()
+    const withScopeId = userMemberGroups.some(m => !!m.scopeId)
+    if (withScopeId) {
+      const ids = new Set<string>()
+      for (const m of userMemberGroups) {
+        if (m.scopeId === selectedScopeId) ids.add(m.groupId)
+      }
+      return ids
+    }
+    // /me/groups omitted scopeId — match by groupId; table is already limited to selected scope's groups
+    return new Set(userMemberGroups.map(m => m.groupId))
+  }, [userMemberGroups, selectedScopeId])
+
+  const groupsForTable = useMemo(() => {
+    if (!myScopesOnly || !selectedScopeId) return groups
+    return groups.filter(g => myGroupIdsInSelectedScope.has(g.groupId))
+  }, [groups, myScopesOnly, selectedScopeId, myGroupIdsInSelectedScope])

   const parentScopes = useMemo(() => {
     if (scopeFormType === 'platform') return []
@@ -251,6 +287,35 @@ export const ScopeGroupManagement: React.FC<ScopeGroupManagementProps> = () => {
     setGroupUsersMap({})
   }, [selectedScopeId])

+  // Drop scope selection if it falls outside the current picker pool (e.g. My scopes on)
+  useEffect(() => {
+    if (!selectedScopeId) return
+    if (!scopesForPicker.some(s => s.scopeId === selectedScopeId)) {
+      setSelectedScopeId(null)
+    }
+  }, [selectedScopeId, scopesForPicker])
+
+  // Remove expand/user cache for groups no longer visible in the table
+  useEffect(() => {
+    const valid = new Set(groupsForTable.map(g => g.groupId))
+    setExpandedGroupIds(prev => {
+      const next = new Set([...prev].filter(id => valid.has(id)))
+      return next.size === prev.size ? prev : next
+    })
+    setGroupUsersMap(prev => {
+      let changed = false
+      const next = { ...prev }
+      for (const k of Object.keys(next)) {
+        if (!valid.has(k)) {
+          delete next[k]
+          changed = true
+        }
+      }
+      return changed ? next : prev
+    })
+    setSelectedGroup(prev => (prev && !valid.has(prev.groupId) ? null : prev))
+  }, [groupsForTable])
+
   // ============================================================================
   // SCOPE CRUD
   // ============================================================================
@@ -432,12 +497,15 @@ export const ScopeGroupManagement: React.FC<ScopeGroupManagementProps> = () => {
         return next
       })
       await loadGroups()
+      if (userMemberGroups.some(g => g.groupId === group.groupId)) {
+        await refreshGroups()
+      }
     } catch (err) {
       toast.error(err instanceof Error ? err.message : 'Failed to delete group')
     } finally {
       setIsSaving(false)
     }
-  }, [apiService, selectedScopeId, toast, loadGroups, selectedGroup])
+  }, [apiService, selectedScopeId, toast, loadGroups, selectedGroup, userMemberGroups, refreshGroups])

   // ============================================================================
   // USER CRUD
@@ -446,6 +514,7 @@ export const ScopeGroupManagement: React.FC<ScopeGroupManagementProps> = () => {
   const handleSaveUser = useCallback(async () => {
     if (!selectedGroup || !selectedScopeId) return
     setIsSaving(true)
+    let addedSelfToGroup = false
     try {
       if (editingUser) {
         const updateData: ScopeUserUpdateBody = {
@@ -465,8 +534,11 @@ export const ScopeGroupManagement: React.FC<ScopeGroupManagementProps> = () => {
         toast.success('User updated')
       } else {
         if (!newUserEmail.trim()) return
+        const profileEmail = ims.profile?.email?.toLowerCase()
+        const addedEmail = newUserEmail.trim().toLowerCase()
+        addedSelfToGroup = !!(profileEmail && addedEmail === profileEmail)
         const result = await apiService.addGroupUser(selectedScopeId, selectedGroup.groupId, {
-          email: newUserEmail.trim().toLowerCase(),
+          email: addedEmail,
           ...(newUserFirstName.trim() && { firstName: newUserFirstName.trim() }),
           ...(newUserLastName.trim() && { lastName: newUserLastName.trim() }),
           ...(newUserGuid.trim() && { userGuid: newUserGuid.trim() }),
@@ -485,12 +557,15 @@ export const ScopeGroupManagement: React.FC<ScopeGroupManagementProps> = () => {
       setNewUserGuid('')
       // Refresh users in the expanded row
       await loadGroupUsersForExpand(selectedGroup.groupId)
+      if (addedSelfToGroup) {
+        await refreshGroups()
+      }
     } catch (err) {
       toast.error(err instanceof Error ? err.message : 'Failed to save user')
     } finally {
       setIsSaving(false)
     }
-  }, [editingUser, newUserEmail, newUserFirstName, newUserLastName, newUserGuid, selectedGroup, selectedScopeId, apiService, toast, loadGroupUsersForExpand])
+  }, [editingUser, newUserEmail, newUserFirstName, newUserLastName, newUserGuid, selectedGroup, selectedScopeId, apiService, toast, loadGroupUsersForExpand, ims.profile?.email, refreshGroups])

   const handleRemoveUser = useCallback(async (user: ScopeUser) => {
     if (!selectedGroup || !selectedScopeId) return
@@ -505,12 +580,16 @@ export const ScopeGroupManagement: React.FC<ScopeGroupManagementProps> = () => {
       setUserToRemove(null)
       // Refresh users in the expanded row
       await loadGroupUsersForExpand(selectedGroup.groupId)
+      const profileEmail = ims.profile?.email?.toLowerCase()
+      if (profileEmail && user.email.toLowerCase() === profileEmail) {
+        await refreshGroups()
+      }
     } catch (err) {
       toast.error(err instanceof Error ? err.message : 'Failed to remove user')
     } finally {
       setIsSaving(false)
     }
-  }, [selectedGroup, selectedScopeId, apiService, toast, loadGroupUsersForExpand])
+  }, [selectedGroup, selectedScopeId, apiService, toast, loadGroupUsersForExpand, ims.profile?.email, refreshGroups])

   // ============================================================================
   // TABLE COLUMNS
@@ -683,14 +762,19 @@ export const ScopeGroupManagement: React.FC<ScopeGroupManagementProps> = () => {
   return (
     <View padding="size-400" maxWidth="1400px" marginX="auto">
       <div className={style({display: 'flex', flexDirection: 'column', gap: 32})}>
-        <Heading level={1}>Access Management</Heading>
+        <div className={style({display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 24, flexWrap: 'wrap'})}>
+          <Heading level={1}>Access Management</Heading>
+          <Switch isSelected={myScopesOnly} onChange={setMyScopesOnly}>
+            My
+          </Switch>
+        </div>

         {/* ── Scope selector + actions ── */}
         <div className={style({padding: 20})}>
           <div className={style({display: 'flex', justifyContent: 'space-between', alignItems: 'end', gap: 16, flexWrap: 'wrap'})}>
             <div className={style({display: 'flex', alignItems: 'end', gap: 8})}>
               <ComboBox
-                label={\`Select Scope (\${scopes.length} scope\${scopes.length === 1 ? '' : 's'} available)\`}
+                label={\`Select Scope (\${filteredScopes.length} scope\${filteredScopes.length === 1 ? '' : 's'} available)\`}
                 selectedKey={selectedScopeId}
                 onSelectionChange={(key) => setSelectedScopeId(key as string | null)}
                 onInputChange={setScopeFilterText}
@@ -753,9 +837,9 @@ export const ScopeGroupManagement: React.FC<ScopeGroupManagementProps> = () => {
         {selectedScopeId ? (
           <ResourceDashboardLayout
             title="Groups"
-            totalCount={groups.length}
+            totalCount={groupsForTable.length}
             error={groupError}
-            data={groups}
+            data={groupsForTable}
             columns={groupColumns}
             getItemKey={(item) => item.groupId}
             createButton={canWriteGroup ? (
`;

export const scopeGroupMyFilter: Task = {
  id: "real-emc-scope-group-my-filter",
  type: "content",
  podId: "pod-emc-rbac",
  asOf: "2026-03-25T16:30:11-07:00",
  tags: ["real-emc", "rbac", "ui"],
  // Re-tiered to realistic-ticket (#8): hook/wire-up enumeration + pasted source removed.
  prompt: [
    "# Issue",
    "Add a \"My\" filter and keep the side user menu in sync on the Access Management page.",
    "",
    "Add a Switch labeled \"My\" next to the Access Management heading. When it's on, the",
    "Scope picker should only list scopes the current user belongs to, and the Groups",
    "table should only show groups the user is a member of within the selected scope.",
    "The picker's count label should reflect the filtered list, and selecting a scope /",
    "expanding rows should behave sensibly when the visible set shrinks (e.g. a",
    "now-hidden selection clears).",
    "",
    "Separately, the app's left-rail user menu derives its scope groups from membership",
    "data that can go stale: after a user deletes a group they belong to, adds",
    "themselves to a group, or removes themselves from a group, that side menu should",
    "refresh so it stays accurate.",
    "",
    "Don't change unrelated CRUD, table columns, or styles. The page is",
    "`web-src/src/pages/ScopeGroupManagement/ScopeGroupManagement.tsx`.",
    "",
    "# Output",
    "Return ONLY a unified diff (--- / +++ / @@) against the ScopeGroupManagement page. No prose, no full-file rewrite.",
  ].join("\n"),
  expectedSignals: [
    "myScopesOnly",
    "useGroup",
    "refreshGroups",
    "useAuth",
    "ims.profile",
    "scopesForPicker",
    "groupsForTable",
    "Switch",
  ],
  groundTruth: {
    output: GROUND_TRUTH_PATCH,
    note: "adobecom/EMC PR #80, merge SHA 985daa8. Parent file at c4c8d9b.",
  },
  rubric: {
    id: "real-emc-scope-group-my-filter-v1",
    criteria: [
      {
        id: "adds_my_switch_in_header",
        description:
          "Does the patch render a Switch labeled 'My' next to the Access Management Heading, wired to a boolean state (e.g., myScopesOnly) toggled via isSelected / onChange? Score 0-5.",
        scale: "0-5",
        weight: 1.5,
      },
      {
        id: "filters_scope_picker",
        description:
          "When the Switch is on, does the ComboBox's underlying data set narrow to scopes the current user is a member of (derived from useGroup().groups by scopeId), and does the label's count reflect the filtered list rather than scopes.length? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "filters_groups_table",
        description:
          "Does the Groups table render `groupsForTable` (filtered by membership) instead of `groups` directly when the Switch is on, including matching the case where /me/groups omits scopeId (fallback by groupId within the selected scope)? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "clears_invalid_selection_and_cache",
        description:
          "Does the patch add effects that (a) clear selectedScopeId when the selected scope is no longer in the filtered picker pool, and (b) prune expandedGroupIds, groupUsersMap, and selectedGroup for groups no longer visible? Boolean.",
        scale: "boolean",
        weight: 1.5,
      },
      {
        id: "refresh_groups_on_self_mutations",
        description:
          "Does the patch call refreshGroups() after the three self-affecting cases: deleting a group the user belongs to, adding the user's own email to a group, and removing the user's own email from a group (compared case-insensitively against ims.profile.email)? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "matches_ground_truth_intent",
        description:
          "Compared to the reference patch, does the agent's diff achieve the same behavior even with cosmetic differences (variable names, memo placement), while leaving the editingUser branch, API request bodies, and table columns unchanged? Score 0-5.",
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
