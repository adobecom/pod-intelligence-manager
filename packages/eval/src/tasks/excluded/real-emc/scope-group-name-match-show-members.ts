import type { Task } from "../../types.js";

/**
 * Real EMC PR replayed as an eval task.
 *
 * Provenance:
 *   Repo:    adobecom/EMC (local: /Users/rkhan/emcV2/EMC)
 *   PR:      #161 — "fix(scope-group-mgmt): show all members when group matched by name"
 *   Parent:  0d38019 (state of ScopeGroupManagement.tsx BEFORE the merge)
 *   Merge:   0bfc47b
 *
 * Why this PR was chosen:
 *   - Two-hunk surgical diff in a single file with a clear semantic asymmetry:
 *     the bug is that the same query string is used both to surface a group and
 *     to filter its members, but those two predicates target different fields.
 *   - Correct fix needs to (a) guard the predicate against empty input and
 *     (b) branch the member-filter on whether the group itself matched.
 */

const SOURCE_FILE = `function groupMetaMatchesQuery(group: RBACApiGroup, qLower: string): boolean {
  return (
    (group.name?.toLowerCase().includes(qLower) ?? false) ||
    (group.description?.toLowerCase().includes(qLower) ?? false)
  )
}

// ...

  const renderGroupExpandedContent = useCallback((group: RBACApiGroup) => {
    const users = groupUsersMap[group.groupId] || []
    const isLoading = loadingGroupIds.has(group.groupId)
    const q = listSearchQuery.trim().toLowerCase()

    const sortedUsers = [...users].sort((a, b) => {
      switch (userSortKey) {
        case 'name': {
          const aName = scopeUserDisplayName(a)
          const bName = scopeUserDisplayName(b)
          return aName.localeCompare(bName)
        }
        case 'email':
          return a.email.localeCompare(b.email)
        default:
          return 0
      }
    })

    const visibleUsers = q ? sortedUsers.filter(u => userMatchesQuery(u, q)) : sortedUsers

    return (
      // ... renders the expanded group row with visibleUsers ...
    )
  }, [/* deps */])
`;

const ISSUE_TEXT = `fix(scope-group-mgmt): show all members when group matched by name

Searching a group by name surfaces the group in the list, but expanding
it shows "No members match your search" — because the same query string
is applied to filter the member list, and users don't have the group
name in their searchable fields.

When the group itself matched the query (by name or description), all
members should be visible on expand. User-level filtering should only
apply when the group surfaced via a member match.

Also add a defensive empty-string guard to groupMetaMatchesQuery so it
behaves consistently with the parallel userMatchesQuery helper.`;

const GROUND_TRUTH_PATCH = `--- a/web-src/src/pages/ScopeGroupManagement/ScopeGroupManagement.tsx
+++ b/web-src/src/pages/ScopeGroupManagement/ScopeGroupManagement.tsx
@@ -70,6 +70,7 @@ function userMatchesQuery(user: ScopeUser, qLower: string): boolean {
 }

 function groupMetaMatchesQuery(group: RBACApiGroup, qLower: string): boolean {
+  if (!qLower) return false
   return (
     (group.name?.toLowerCase().includes(qLower) ?? false) ||
     (group.description?.toLowerCase().includes(qLower) ?? false)
@@ -800,7 +801,8 @@ export const ScopeGroupManagement: React.FC<ScopeGroupManagementProps> = () => {
       }
     })

-    const visibleUsers = q ? sortedUsers.filter(u => userMatchesQuery(u, q)) : sortedUsers
+    const groupMetaMatch = q ? groupMetaMatchesQuery(group, q) : false
+    const visibleUsers = q && !groupMetaMatch ? sortedUsers.filter(u => userMatchesQuery(u, q)) : sortedUsers

     return (
       <div className={style({display: 'flex', flexDirection: 'column', gap: 16})}>
`;

export const scopeGroupNameMatchShowMembers: Task = {
  id: "real-emc-scope-group-name-match-show-members",
  type: "content",
  podId: "pod-emc-rbac",
  asOf: "2026-05-20T22:19:55+05:30",
  tags: ["real-emc", "rbac", "search"],
  prompt: [
    "# Issue",
    ISSUE_TEXT,
    "",
    "# Current source (web-src/src/pages/ScopeGroupManagement/ScopeGroupManagement.tsx, parent commit 0d38019)",
    "```tsx",
    SOURCE_FILE,
    "```",
    "",
    "# Output",
    "Return ONLY a unified diff (--- / +++ / @@) against `web-src/src/pages/ScopeGroupManagement/ScopeGroupManagement.tsx`. No prose, no full-file rewrite.",
  ].join("\n"),
  expectedSignals: [
    "groupMetaMatchesQuery",
    "userMatchesQuery",
    "visibleUsers",
    "groupMetaMatch",
    "qLower",
  ],
  groundTruth: {
    output: GROUND_TRUTH_PATCH,
    note: "adobecom/EMC PR #161, merge SHA 0bfc47b. Parent file at 0d38019.",
  },
  rubric: {
    id: "real-emc-scope-group-name-match-show-members-v1",
    criteria: [
      {
        id: "branches_on_group_meta_match",
        description:
          "Does the patch introduce a check that asks whether the group itself matched the query (e.g., calling `groupMetaMatchesQuery(group, q)`) and only applies the user-level filter when the group did NOT match? Score 0-5: 0=no branching, 5=explicit branch on group-meta match.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "shows_all_members_on_group_match",
        description:
          "When the group meta matches, does the patch fall back to `sortedUsers` (all members) instead of the user-filtered list? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "adds_empty_string_guard",
        description:
          "Does the patch add a guard like `if (!qLower) return false` (or equivalent) at the top of `groupMetaMatchesQuery`? Boolean.",
        scale: "boolean",
        weight: 1,
      },
      {
        id: "preserves_user_filter_path",
        description:
          "Does the patch preserve the original behavior when the match was a user-level match (filter by `userMatchesQuery`)? Score 0-5: 0=removes user filter entirely, 5=preserved exactly for the non-group-match path.",
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
      {
        id: "no_unrelated_changes",
        description:
          "Does the patch avoid unrelated edits (sort order, styling, key bindings, table columns)? Boolean — true if scope is limited to the predicate and the visibleUsers assignment.",
        scale: "boolean",
        weight: 1,
      },
    ],
  },
};
