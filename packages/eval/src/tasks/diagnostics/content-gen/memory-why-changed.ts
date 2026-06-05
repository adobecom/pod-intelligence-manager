import type { Task } from "../../types.js";

export const memoryWhyChanged: Task = {
  id: "memory-why-changed",
  type: "content",
  podId: "pod-emc-configs",
  tags: ["memory", "temporal", "why_changed"],
  prompt: [
    "Explain why the config inheritance decision changed or stabilized during the pod.",
    "",
    "Requirements:",
    "- Give a short transition chain from earlier position to final/current decision.",
    "- Mention the evidence that caused the change, including implementation and PM concerns if present.",
    "- Include citations or identifiers from the PIM context.",
    "- Do not invent a change history if the context only supports a single decision.",
    "",
    "Output 3-6 bullets only.",
  ].join("\n"),
  expectedSignals: ["why", "changed", "C-301", "ConfigService", "PM", "backend"],
  rubric: {
    id: "memory-why-changed-v1",
    criteria: [
      {
        id: "transition_chain",
        description: "Explains the decision transition path or explicitly says no transition is evidenced. Score 0-5.",
        scale: "0-5",
        weight: 3,
      },
      {
        id: "captures_drivers",
        description: "Captures the concrete drivers behind the decision, including tradeoffs from the supplied context. Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "cites_sources",
        description: "References relevant PIM identifiers or citations. Boolean.",
        scale: "boolean",
        weight: 1.5,
      },
      {
        id: "no_fabrication",
        description: "Does not invent unsupported chronology, artifacts, or actors. Boolean.",
        scale: "boolean",
        weight: 2,
      },
    ],
  },
};
