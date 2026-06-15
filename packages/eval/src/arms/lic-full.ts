import type { Arm, ArmBuildInputs, LicContextFixture } from "./types.js";
import type { Task } from "../tasks/types.js";
import type { PromptSegments } from "../runners/types.js";

const SYSTEM_CODE = [
  "You are a senior software engineer working on the EMC (Event Management) platform at Adobe.",
  "You will be given a lic context block: semantic search results, symbol references, call graphs, and other code-intelligence retrieved from the codebase.",
  "Use that context to ground your fix in existing patterns and cross-file relationships.",
  "The task prompt's exported API and input contract are authoritative. If lic snippets show surrounding app-only preconditions or dependencies, adapt the pattern to the requested self-contained module instead of requiring extra inputs.",
  "Produce a single self-contained TypeScript module that satisfies the user's task.",
  "Return ONLY a fenced ```typescript code block — no prose, no commentary outside the block.",
  "The module should export named functions matching the names mentioned in the task.",
].join("\n");

const SYSTEM_CONTENT = [
  "You are a contributor on the EMC (Event Management) platform at Adobe writing concise, decisive technical content.",
  "You will be given a lic context block: semantic search results, symbol references, call graphs, and other code-intelligence retrieved from the codebase.",
  "Use the lic context to ground your answer in real code structure (specific files, symbols, callers).",
  "Treat the user task as authoritative if retrieved code context conflicts with the requested output shape.",
  "Return ONLY the requested content — no preamble, no postscript.",
].join("\n");

/**
 * lic-only arm: ships only lic code-intelligence context. No PIM context.
 * Pairs head-to-head against `pim-full` and `kg-only` for the main protocol
 * comparison; against `lic-pim-combined` for the complementarity question.
 */
export const licFullArm: Arm = {
  id: "lic-full",
  label: "lic-full",
  usesPim: false,
  usesLic: true,
  primary: true,
  build(task: Task, _fixture: import("./types.js").SessionContextFixture | null): PromptSegments {
    throw new Error("lic-full: use buildWithInputs; runner must pass a LicContextFixture");
  },
  buildWithInputs(task: Task, inputs: ArmBuildInputs): PromptSegments {
    const lic = inputs.lic;
    if (!lic) {
      throw new Error(
        `lic-full arm requires a lic fixture for task ${task.id}. Run \`pnpm --filter @pim/eval lic-freeze --task=${task.id}\` first.`,
      );
    }
    const system = task.type === "code" ? SYSTEM_CODE : SYSTEM_CONTENT;
    return {
      system,
      pimContext: lic.renderedBlock,
      userTask: `## Task\n${task.prompt}`,
    };
  },
};

export function serializeLicContext(lic: LicContextFixture): string {
  return lic.renderedBlock;
}
