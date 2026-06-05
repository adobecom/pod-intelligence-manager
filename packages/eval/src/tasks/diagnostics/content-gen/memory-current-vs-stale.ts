import type { Task } from "../../types.js";

export const memoryCurrentVsStale: Task = {
  id: "memory-current-vs-stale",
  type: "content",
  podId: "pod-emc-configs",
  tags: ["memory", "temporal"],
  prompt: [
    "Answer this as a concise engineering note: What is the current config inheritance decision, and what prior/stale option should not be followed?",
    "",
    "Requirements:",
    "- Separate current decision from historical or rejected options.",
    "- Cite the relevant conflict/decision identifiers when available.",
    "- Abstain from claiming a current state if the provided PIM context does not prove one.",
    "",
    "Output only the note.",
  ].join("\n"),
  expectedSignals: ["current", "stale", "deep-merge", "full-replace", "C-301"],
  rubric: {
    id: "memory-current-vs-stale-v1",
    criteria: [
      {
        id: "separates_current_from_stale",
        description: "Clearly distinguishes the current accepted decision from stale or rejected alternatives. Score 0-5.",
        scale: "0-5",
        weight: 3,
      },
      {
        id: "uses_evidence",
        description: "Grounds the answer in cited PIM context rather than unsupported inference. Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "avoids_stale_advice",
        description: "Does not recommend following a superseded or rejected option. Boolean.",
        scale: "boolean",
        weight: 2,
      },
      {
        id: "abstains_when_needed",
        description: "Avoids overstating certainty if the supplied context does not prove current state. Boolean.",
        scale: "boolean",
        weight: 1,
      },
    ],
  },
};
