import type { Task } from "../../types.js";

export const rbacDecisionRationale: Task = {
  id: "rbac-decision-rationale",
  type: "content",
  podId: "pod-emc-rbac",
  tags: ["rbac"],
  prompt: [
    "Write a decision rationale (3-5 short paragraphs, plain markdown) resolving the open conflict about whether to deprecate the static `users.json` permission file or keep it as a 403 fallback.",
    "",
    "The rationale should:",
    "- State the chosen direction clearly in the first paragraph.",
    "- Acknowledge BOTH positions fairly, citing the contributors by their agent IDs.",
    "- Cite concrete evidence from the pod's history (e.g., the staging-traffic measurement of the 403 fallback path).",
    "- Specify exactly what changes for the 403 fallback path so frontend implementation can proceed.",
    "- Be decisive — produce something the team could merge, not a discussion summary.",
    "",
    "Output the rationale only — no preamble, no postscript.",
  ].join("\n"),
  expectedSignals: ["C-101", "GroupContext", "ESP", "users.json", "8%", "be-agent-rbac", "fe-agent-rbac"],
  rubric: {
    id: "rbac-decision-rationale-v1",
    criteria: [
      {
        id: "decisive_position",
        description:
          "Does the rationale state a clear chosen direction (resolves the conflict, doesn't just summarize)? Score 0-5: 0=no decision, 5=unambiguous and actionable.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "cites_both_positions",
        description:
          "Does it acknowledge both contributors' positions (the deprecation argument from be-agent-rbac AND the 8%-staging fallback evidence from fe-agent-rbac)? Score 0-5.",
        scale: "0-5",
        weight: 1.5,
      },
      {
        id: "uses_pim_evidence",
        description:
          "Does it cite concrete evidence that exists in the pod's PIM context — specifically the 8% staging fallback metric, the GroupContext / ESP API path, or the C-101 conflict ID? Score 0-5: 0=generic prose, 5=multiple citations.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "specifies_fallback_behavior",
        description:
          "Does the rationale specify what the new 403 fallback behavior is (e.g., session-storage cache, deny-all, time-window read fallback) so the frontend can implement it without further discussion? Score 0-5.",
        scale: "0-5",
        weight: 1.5,
      },
      {
        id: "no_invented_facts",
        description:
          "Does the output avoid inventing facts not present in the PIM context (e.g., a fake metric, a fictitious meeting, a non-existent endpoint)? Boolean: true=grounded, false=fabricates.",
        scale: "boolean",
        weight: 2,
      },
    ],
  },
};
