import type { Task } from "../../types.js";
import { archaeologyRubric } from "./_helper.js";

const GROUND_TRUTH = `Expected blast radius of calling apiService.deleteScope():

- web-src/src/services/api.ts (defines deleteScope — calls ESP DELETE /v1/scopes/{scopeId})
- web-src/src/pages/ScopeGroupManagement/ScopeGroupManagement.tsx (the only UI caller — invokes deleteScope from the Access Management page when a scope is removed)

Side-effects to mention:
- After deleteScope succeeds, refreshGroups() should fire so the side user menu re-renders without the deleted scope (cross-cutting RBAC pattern, see useGroup / GroupContext)
- Any cached scope lookups in useGroup must invalidate
- The user's active scope may no longer exist; the UI should fall back gracefully (typically to the first remaining scope)

Documentation references (docs/RBAC_PERMISSION_GATING_IMPLEMENTATION.md) are not code and should NOT be in the file list, but the side-effect intuition lives there.`;

export const deleteScopeBlastRadius: Task = {
  id: "arch-delete-scope-blast-radius",
  type: "content",
  podId: "pod-emc-rbac",
  stratum: "S6",
  tags: ["archaeology", "blast-radius", "rbac"],
  licSeed: {
    symbol: "deleteScope",
    investigateQuery: "blast radius of calling deleteScope, including cache invalidation and UI side effects",
  },
  prompt: [
    "# Question",
    "",
    "What code paths and side-effects are triggered when `apiService.deleteScope(scopeId)` is called from the EMC UI?",
    "",
    "Include both the direct callers and any cache/state side-effects that should fire (e.g., group refresh, scope cache invalidation).",
    "",
    "# Output format",
    "",
    "A markdown bulleted list. Group entries under two headings: `### Code callers` (file paths) and `### Side effects` (what state needs to update). One sentence per entry.",
  ].join("\n"),
  groundTruth: {
    output: GROUND_TRUTH,
    note: "Captured from lic find-references deleteScope; cross-referenced with useGroup / refreshGroups patterns.",
  },
  rubric: archaeologyRubric("arch-delete-scope-blast-radius-v1"),
};
