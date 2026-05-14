import type { Task } from "../types.js";

export const configDecisionWriteup: Task = {
  id: "config-decision-writeup",
  type: "content",
  podId: "pod-emc-configs",
  tags: ["configs"],
  prompt: [
    "Write a decision document (markdown, 4-6 short sections) for the EMC team resolving the open architectural conflict about config inheritance: full-replace versus deep-merge.",
    "",
    "Sections (in order, with markdown `##` headings):",
    "1. **Decision** — one decisive sentence stating the chosen model.",
    "2. **Why** — 2-4 bullet points grounded in the existing positions; surface the UX risk that PM raised AND the implementation cost that backend raised.",
    "3. **Migration impact** — bullet points listing what must change in the existing ConfigService implementation.",
    "4. **Out of scope** — what this decision does NOT cover (e.g., the cache invalidation conflict).",
    "5. **References** — list the conflict ID and any related cross-pod precedents.",
    "",
    "Output only the decision document — no preamble.",
  ].join("\n"),
  expectedSignals: ["C-301", "deep-merge", "full-replace", "ConfigService", "RSVP", "merge rules"],
  rubric: {
    id: "config-decision-writeup-v1",
    criteria: [
      {
        id: "names_chosen_model",
        description:
          "Does Section 1 state a clear chosen inheritance model (deep-merge or full-replace)? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "covers_both_concerns",
        description:
          "Does Section 2 surface BOTH PM's UX-cost concern (config duplication, drift) and backend's implementation cost (rewriting ConfigService resolution, ordered-list merge rules)? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "concrete_migration_impact",
        description:
          "Does Section 3 list concrete migration items grounded in the PIM context (rewrite ConfigService resolution, define merge rules per type, handle ordered-list semantics, cache key impact)? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "scopes_correctly",
        description:
          "Does Section 4 correctly scope out the cache TTL/invalidation conflict (C-302) as a separate concern? Boolean.",
        scale: "boolean",
        weight: 1,
      },
      {
        id: "cites_conflict_id",
        description:
          "Does Section 5 reference the correct conflict ID (C-301)? Boolean.",
        scale: "boolean",
        weight: 1.5,
      },
      {
        id: "no_invented_facts",
        description:
          "Does the output avoid fabricating facts not present in the PIM context? Boolean.",
        scale: "boolean",
        weight: 2,
      },
    ],
  },
};
