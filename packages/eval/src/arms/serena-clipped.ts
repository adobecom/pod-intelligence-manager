import type { Arm, ArmBuildInputs } from "./types.js";
import type { Task } from "../tasks/types.js";
import type { PromptSegments } from "../runners/types.js";
import { HALF_BUDGET_CHARS, clip } from "./budget.js";

const SYSTEM_CODE = [
  "You are a senior software engineer working on the EMC (Event Management) platform at Adobe.",
  "You may be given a context block (it may be truncated to a fixed budget).",
  "Produce a single self-contained TypeScript module that satisfies the user's task.",
  "Return ONLY a fenced ```typescript code block — no prose, no commentary outside the block.",
  "The module should export named functions matching the names mentioned in the task.",
].join("\n");

const SYSTEM_CONTENT = [
  "You are a contributor on the EMC (Event Management) platform at Adobe writing concise, decisive technical content.",
  "You may be given a context block (it may be truncated to a fixed budget).",
  "Return ONLY the requested content — no preamble, no postscript.",
].join("\n");

/**
 * serena-clipped — Serena code-intelligence block clipped to the same 2000-char
 * budget the combined arm gives it. Matched-budget single-source baseline; pairs
 * against `serena-pim-combined`.
 */
export const serenaClippedArm: Arm = {
  id: "serena-clipped",
  label: "serena (matched budget)",
  usesPim: false,
  usesSerena: true,
  build(): PromptSegments {
    throw new Error("serena-clipped: use buildWithInputs; runner must pass a serena fixture");
  },
  buildWithInputs(task: Task, inputs: ArmBuildInputs): PromptSegments {
    const serena = inputs.serena;
    if (!serena) {
      throw new Error(
        `serena-clipped arm requires a serena fixture for task ${task.id}. Run \`pnpm --filter @pim/eval serena-freeze --task=${task.id}\` first.`,
      );
    }
    return {
      system: task.type === "code" ? SYSTEM_CODE : SYSTEM_CONTENT,
      pimContext: clip(serena.renderedBlock, HALF_BUDGET_CHARS),
      userTask: `## Task\n${task.prompt}`,
    };
  },
};
