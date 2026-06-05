import type { Arm, ArmBuildInputs, SessionContextFixture } from "./types.js";
import type { Task } from "../tasks/types.js";
import type { PromptSegments } from "../runners/types.js";
import { filterFixtureByAsOf, serializeContext } from "./pim-full.js";
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
 * pim-clipped — PIM session context clipped to the same 2000-char budget the
 * combined arm gives PIM. Matched-budget single-source baseline for the
 * complementarity comparison; pairs against `lic-pim-combined`.
 */
export const pimClippedArm: Arm = {
  id: "pim-clipped",
  label: "PIM (matched budget)",
  usesPim: true,
  build(task: Task, fixture: SessionContextFixture | null): PromptSegments {
    if (!fixture) {
      throw new Error(`pim-clipped arm requires a fixture for pod ${task.podId}. Run \`pnpm --filter @pim/eval freeze\` first.`);
    }
    const filtered = task.asOf ? filterFixtureByAsOf(fixture, task.asOf) : fixture;
    return {
      system: task.type === "code" ? SYSTEM_CODE : SYSTEM_CONTENT,
      pimContext: clip(serializeContext(filtered), HALF_BUDGET_CHARS),
      userTask: `## Task\n${task.prompt}`,
    };
  },
};

/**
 * lic-clipped — locally indexed code block clipped to the same 2000-char budget
 * the combined arm gives it. Matched-budget single-source baseline; pairs against
 * `lic-pim-combined`.
 */
export const licClippedArm: Arm = {
  id: "lic-clipped",
  label: "lic (matched budget)",
  usesPim: false,
  usesLic: true,
  build(): PromptSegments {
    throw new Error("lic-clipped: use buildWithInputs; runner must pass a lic fixture");
  },
  buildWithInputs(task: Task, inputs: ArmBuildInputs): PromptSegments {
    const lic = inputs.lic;
    if (!lic) {
      throw new Error(`lic-clipped arm requires a lic fixture for task ${task.id}. Run \`pnpm --filter @pim/eval lic-freeze --task=${task.id}\` first.`);
    }
    return {
      system: task.type === "code" ? SYSTEM_CODE : SYSTEM_CONTENT,
      pimContext: clip(lic.renderedBlock, HALF_BUDGET_CHARS),
      userTask: `## Task\n${task.prompt}`,
    };
  },
};
