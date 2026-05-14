import type { Arm, SessionContextFixture } from "./types.js";
import type { Task } from "../tasks/types.js";
import type { PromptSegments } from "../runners/types.js";

const SYSTEM_CODE = [
  "You are a senior software engineer working on the EMC (Event Management) platform at Adobe.",
  "Produce a single self-contained TypeScript module that satisfies the user's task.",
  "Return ONLY a fenced ```typescript code block — no prose, no commentary outside the block.",
  "The module should export named functions matching the names mentioned in the task.",
].join("\n");

const SYSTEM_CONTENT = [
  "You are a contributor on the EMC (Event Management) platform at Adobe writing concise, decisive technical content.",
  "Return ONLY the requested content — no preamble, no postscript.",
].join("\n");

/**
 * Control arm — minimal pod metadata only, no PIM context.
 * The user task knows what pod it's in, but not the conflicts, decisions, or org learnings.
 */
export const controlArm: Arm = {
  id: "control",
  label: "Control (no PIM)",
  usesPim: false,
  build(task: Task, fixture: SessionContextFixture | null): PromptSegments {
    const system = task.type === "code" ? SYSTEM_CODE : SYSTEM_CONTENT;
    const podCard = fixture
      ? buildPodCard(fixture)
      : `Pod: ${task.podId}`;
    return {
      system,
      userTask: `${podCard}\n\n## Task\n${task.prompt}`,
    };
  },
};

function buildPodCard(fixture: SessionContextFixture): string {
  const pod = fixture.payload.pod;
  const milestone = pod.milestone?.name ?? "(no milestone)";
  return `## Pod\n- ID: ${pod.pod_id}\n- Name: ${pod.name}\n- Milestone: ${milestone}`;
}
