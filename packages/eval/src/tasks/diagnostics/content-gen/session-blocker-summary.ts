import type { Task } from "../../types.js";

export const sessionBlockerSummary: Task = {
  id: "session-blocker-summary",
  type: "content",
  podId: "pod-emc-sessions",
  tags: ["sessions"],
  prompt: [
    "Acting as fe-agent-sessions, write a `blocker` context update for the PIM living doc.",
    "",
    "It must include:",
    "- A short, action-directed summary line (under 120 characters).",
    "- 2-4 sentences of detail explaining what is blocked and why.",
    "- The specific upstream conflict ID that's blocking you and the exact piece of information you need to unblock.",
    "- The downstream work this blocks (be specific — name the components or features at risk).",
    "",
    "Format the output as plain text with these labeled sections: `Summary:`, `Detail:`, `Blocked by:`, `Blocks:`.",
  ].join("\n"),
  expectedSignals: ["C-201", "timezone", "naive", "UTC", "session form"],
  rubric: {
    id: "session-blocker-summary-v1",
    criteria: [
      {
        id: "cites_correct_conflict",
        description:
          "Does the `Blocked by:` field reference the actual blocking conflict (C-201, the timezone handling conflict)? Boolean.",
        scale: "boolean",
        weight: 3,
      },
      {
        id: "specifies_unblock_need",
        description:
          "Does it specify the exact information needed to unblock (e.g., 'API contract decision: do we send naive+IANA or UTC millis?')? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "concrete_downstream_impact",
        description:
          "Does the `Blocks:` field name specific downstream items (session form, auto-registration window, speaker assignment modal)? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "structured_format",
        description:
          "Does the output follow the requested labeled-section format (Summary/Detail/Blocked by/Blocks)? Boolean.",
        scale: "boolean",
        weight: 1,
      },
      {
        id: "no_invented_facts",
        description:
          "Does the output avoid inventing facts not in the PIM context? Boolean.",
        scale: "boolean",
        weight: 2,
      },
    ],
  },
};
