import type { Task } from "../../types.js";
import { archaeologyRubric } from "./_helper.js";

/**
 * S6 code-archaeology task: enumerate write sites of an optimistic-concurrency token.
 * Ground truth captured from `lic find-references modificationTime -r /Users/rkhan/emcV2/EMC`
 * filtered to the actual mutation sites (not all references).
 */

const GROUND_TRUTH = `Expected files where modificationTime is set (written or assigned), not merely read:

- web-src/src/services/api.ts (PUT-builder helpers for event, series, session, partner, sponsor — the centralized place where modificationTime is included in PUT bodies)
- web-src/src/hooks/useEventFormSave.ts (sets event.modificationTime after a save round-trip)
- web-src/src/pages/EventForm/SessionManagement/Sessions.tsx (sessions list refresh after batch save)
- web-src/src/pages/EventForm/SessionManagement/SessionForm.tsx (single-session save flow)
- web-src/src/pages/EventForm/SpeakerPickerDialog.tsx (speaker linkage save)
- web-src/src/pages/EventForm/SponsorsComponent.tsx (sponsor add/remove save)
- web-src/src/pages/SeriesDashboard/SeriesDashboard.tsx (series header save)
- web-src/src/contexts/EventFormContext.tsx (in-memory event state refresh after a save)

Read-only references in HistoryTimeline, GroupContext, useRsvpConfig should NOT be in the answer (they observe but do not write).`;

export const whereIsModificationTimeSet: Task = {
  id: "arch-where-is-modification-time-set",
  type: "content",
  podId: "pod-emc-sessions",
  stratum: "S6",
  tags: ["archaeology"],
  licSeed: {
    symbol: "modificationTime",
    investigateQuery: "all sites that write event or session modificationTime",
  },
  prompt: [
    "# Question",
    "",
    "List every code site in the EMC codebase (web-src/) that **sets** or **writes** the `modificationTime` field on an event, series, session, or related entity.",
    "Read-only references that only **observe** modificationTime (e.g., in a HistoryTimeline UI) do NOT count.",
    "",
    "# Output format",
    "",
    "A markdown bulleted list, one entry per file. For each entry include the file path and a one-sentence reason describing what the site does with modificationTime.",
    "Do not include line numbers; do not invent files.",
  ].join("\n"),
  groundTruth: {
    output: GROUND_TRUTH,
    note: "Captured from lic find-references modificationTime, filtered to write sites by domain inspection.",
  },
  rubric: archaeologyRubric("arch-where-is-modification-time-set-v1"),
};
