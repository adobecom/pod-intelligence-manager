import type { Task } from "../../types.js";
import { archaeologyRubric } from "./_helper.js";

const GROUND_TRUTH = `Expected useHasPermission callsites and the resources/access they check:

- web-src/src/components/App.tsx (route guards — checks high-level resource access)
- web-src/src/components/layout/TopNav.tsx (hides nav items the user cannot reach)
- web-src/src/components/shared/RequirePermission.tsx (generic permission-gate wrapper component)
- web-src/src/components/user/UserPanel.tsx (gates self-affecting actions in the user menu)
- web-src/src/hooks/useRBACFilter.ts (filters list-level results by per-row permission)
- web-src/src/pages/EventsDashboard/EventsDashboard.tsx (gates publish / delete / create on the events dashboard)
- web-src/src/pages/Home.tsx (gates home-page tiles)
- web-src/src/pages/OverviewDashboard/OverviewDashboard.tsx (gates overview-dashboard sections)
- web-src/src/pages/Registrations/CampaignsTab.tsx (gates campaign actions on the registrations tab)

Documentation references (docs/RBAC_PERMISSION_GATING_IMPLEMENTATION.md) and the hook's own definition / barrel re-export should NOT be in the list.`;

export const rbacPermissionCheckCallsites: Task = {
  id: "arch-rbac-permission-check-callsites",
  type: "content",
  podId: "pod-emc-rbac",
  stratum: "S6",
  tags: ["archaeology", "rbac"],
  licSeed: { symbol: "useHasPermission", investigateQuery: "all callsites of useHasPermission and what permission they check" },
  prompt: [
    "# Question",
    "",
    "List every callsite of the `useHasPermission()` hook in the EMC web-src/ code. For each callsite, name the file and briefly say what the call is gating (e.g., 'gates publish button on dashboard').",
    "Do NOT include the hook's own definition file or any docs/* markdown references.",
    "",
    "# Output format",
    "",
    "A markdown bulleted list. One entry per file. Format: `- <file path> — <what is being gated>`.",
  ].join("\n"),
  groundTruth: {
    output: GROUND_TRUTH,
    note: "Captured from lic find-references useHasPermission, filtered to consumer references.",
  },
  rubric: archaeologyRubric("arch-rbac-permission-check-callsites-v1"),
};
