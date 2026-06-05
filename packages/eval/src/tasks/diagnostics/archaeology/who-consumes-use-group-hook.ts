import type { Task } from "../../types.js";
import { archaeologyRubric } from "./_helper.js";

const GROUND_TRUTH = `Expected consumers of useGroup():

- web-src/src/components/RBACGate.tsx (gates child rendering by group permissions)
- web-src/src/components/layout/TopNav.tsx (shows scope/group selector in top nav)
- web-src/src/components/shared/GroupSwitcher.tsx (active-group switcher widget)
- web-src/src/components/user/UserPanel.tsx (side user menu — reads groups for self-affecting actions)
- web-src/src/hooks/useHasPermission.ts (permission lookup — derives from useGroup permissions)
- web-src/src/hooks/useRBACFilter.ts (filters lists by current group scope)
- web-src/src/pages/EventForm/EventForm.tsx (event editor — uses group to gate fields and actions)
- web-src/src/pages/EventForm/EventFormatComponent.tsx (event-format sub-form)
- web-src/src/pages/EventsDashboard/EventsDashboard.tsx (dashboard — uses group for scoped lists)
- web-src/src/pages/ScopeGroupManagement/ScopeGroupManagement.tsx (the access-management page itself)

Definitions and re-exports (web-src/src/contexts/GroupContext.tsx, hooks/index.ts) should NOT be in the consumer list — those define the hook, they don't consume it.`;

export const whoConsumesUseGroupHook: Task = {
  id: "arch-who-consumes-use-group-hook",
  type: "content",
  podId: "pod-emc-rbac",
  stratum: "S6",
  tags: ["archaeology"],
  licSeed: { symbol: "useGroup", investigateQuery: "all React components that consume the useGroup hook" },
  prompt: [
    "# Question",
    "",
    "List every component, page, or hook in the EMC codebase (web-src/) that **consumes** the `useGroup()` hook to read group/scope context.",
    "Do NOT include the file that defines useGroup itself, nor re-export barrel files.",
    "",
    "# Output format",
    "",
    "A markdown bulleted list, one entry per file. For each entry include the file path and a one-sentence reason describing what the consumer does with the value.",
    "Do not include line numbers; do not invent files.",
  ].join("\n"),
  groundTruth: {
    output: GROUND_TRUTH,
    note: "Captured from lic find-references useGroup; filtered to consumer-class references.",
  },
  rubric: archaeologyRubric("arch-who-consumes-use-group-hook-v1"),
};
