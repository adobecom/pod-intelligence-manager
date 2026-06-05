import type { Task } from "../../types.js";

export const progressUpdatePermissions: Task = {
  id: "progress-update-permissions",
  type: "content",
  podId: "pod-emc-rbac",
  tags: ["rbac"],
  prompt: [
    "Acting as be-agent-rbac, draft a `progress` context update announcing that the ESP API GroupContext integration is fully production-ready and the static users.json fallback has been moved to a session-storage cache.",
    "",
    "The update should:",
    "- Reference the related architectural conflict and how it was resolved.",
    "- Mention the specific frontend dependency this unblocks.",
    "- Cite the specific files/components touched.",
    "- Be calibrated, not boastful — focus on what changed and what's now possible.",
    "",
    "Format as labeled sections: `Summary:` (one line), `Details:` (2-4 sentences), `Artifacts:` (bullet list of paths or components), `Unblocks:` (which agent/area can now proceed).",
  ].join("\n"),
  expectedSignals: ["GroupContext", "ESP", "users.json", "C-101", "fe-agent-rbac", "TopNav"],
  rubric: {
    id: "progress-update-permissions-v1",
    criteria: [
      {
        id: "names_resolved_conflict",
        description:
          "Does the update reference the C-101 conflict (or the static-users-vs-ESP-API decision) so a reader can trace why the change was made? Boolean.",
        scale: "boolean",
        weight: 2,
      },
      {
        id: "names_unblocked_agent",
        description:
          "Does `Unblocks:` correctly identify the frontend agent or specific UI work that depended on this (e.g., fe-agent-rbac, TopNav permission gating, qa sign-off)? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "concrete_artifacts",
        description:
          "Does `Artifacts:` list concrete components/files that exist in the pod's history (GroupContext.tsx, esp-groups.ts, permissions.ts, TopNav.tsx, HomeCards.tsx)? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "calibrated_tone",
        description:
          "Is the tone calibrated and operational rather than promotional? Score 0-5: 0=hype, 5=engineering-grade matter-of-fact.",
        scale: "0-5",
        weight: 1,
      },
      {
        id: "no_invented_facts",
        description:
          "Does the output avoid fabricating facts not in the PIM context? Boolean.",
        scale: "boolean",
        weight: 2,
      },
    ],
  },
};
