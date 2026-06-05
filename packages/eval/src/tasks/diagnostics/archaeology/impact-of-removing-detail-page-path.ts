import type { Task } from "../../types.js";
import { archaeologyRubric } from "./_helper.js";

const GROUND_TRUTH = `Expected files that would be affected if detailPagePath is removed from the Event contract:

- web-src/src/types/domain.ts (the type definition itself — declares detailPagePath?: string)
- web-src/src/config/detailPageLocalePrefix.ts (locale-prefix configuration that uses detailPagePath)
- web-src/src/hooks/useCustomDetailPagePath.ts (the custom hook that resolves detail-page paths)
- web-src/src/hooks/useCustomDetailPagePath.test.ts (tests for the hook — exercise the field)
- web-src/src/services/api.ts (PUT-builder for events — currently includes / excludes the field depending on POST vs PUT)
- web-src/src/services/dataFilters.ts (filter helper that strips detailPagePath from PUT payloads — PR #107 added this)
- web-src/src/pages/EventForm/EventForm.tsx (event form — surfaces detailPagePath UI when present)
- web-src/src/pages/EventsDashboard/EventsDashboard.tsx (dashboard — may render a link using detailPagePath)

Documentation references (docs/) should NOT be in the list — they are not code.`;

export const impactOfRemovingDetailPagePath: Task = {
  id: "arch-impact-of-removing-detail-page-path",
  type: "content",
  podId: "pod-emc-sessions",
  stratum: "S6",
  tags: ["archaeology", "blast-radius"],
  licSeed: {
    symbol: "detailPagePath",
    investigateQuery: "blast radius of removing detailPagePath from the Event type",
  },
  prompt: [
    "# Question",
    "",
    "Suppose we removed the `detailPagePath` field from the Event type. What code in the EMC web-src/ directory would need to change?",
    "List every affected file and a one-sentence reason for each (what depends on the field and how).",
    "",
    "# Output format",
    "",
    "A markdown bulleted list. One entry per file. Format: `- <file path> — <what depends on detailPagePath here>`.",
    "Do not include docs/* markdown references.",
  ].join("\n"),
  groundTruth: {
    output: GROUND_TRUTH,
    note: "Captured from lic find-references detailPagePath, filtered to code references.",
  },
  rubric: archaeologyRubric("arch-impact-of-removing-detail-page-path-v1"),
};
