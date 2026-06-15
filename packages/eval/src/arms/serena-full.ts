import type { Arm, ArmBuildInputs, SessionContextFixture } from "./types.js";
import type { Task } from "../tasks/types.js";
import type { PromptSegments } from "../runners/types.js";

const SYSTEM_CODE = [
  "You are a senior software engineer working on the EMC (Event Management) platform at Adobe.",
  "You will be given a Serena code-intelligence context block: symbol definitions, references/callsites, declarations/implementations, and diagnostics retrieved from the codebase via a language server.",
  "Use that context to ground your fix in existing patterns and cross-file relationships.",
  "The task prompt's exported API and input contract are authoritative. If snippets show surrounding app-only preconditions or dependencies, adapt the pattern to the requested self-contained module instead of requiring extra inputs.",
  "Produce a single self-contained TypeScript module that satisfies the user's task.",
  "Return ONLY a fenced ```typescript code block — no prose, no commentary outside the block.",
  "The module should export named functions matching the names mentioned in the task.",
].join("\n");

const SYSTEM_CONTENT = [
  "You are a contributor on the EMC (Event Management) platform at Adobe writing concise, decisive technical content.",
  "You will be given a Serena code-intelligence context block: symbol definitions, references, and diagnostics retrieved from the codebase.",
  "Use the context to ground your answer in real code structure (specific files, symbols, callers).",
  "Treat the user task as authoritative if retrieved code context conflicts with the requested output shape.",
  "Return ONLY the requested content — no preamble, no postscript.",
].join("\n");

/**
 * serena-full arm: ships only a Serena code-intelligence context block. No PIM
 * context. Pairs against `control` for Serena's standalone lift and against
 * `lic-full` for Serena-as-LIC-provider.
 */
export const serenaFullArm: Arm = {
  id: "serena-full",
  label: "serena-full",
  usesPim: false,
  usesSerena: true,
  primary: true,
  build(_task: Task, _fixture: SessionContextFixture | null): PromptSegments {
    throw new Error("serena-full: use buildWithInputs; runner must pass a SerenaContextFixture");
  },
  buildWithInputs(task: Task, inputs: ArmBuildInputs): PromptSegments {
    const serena = inputs.serena;
    if (!serena) {
      throw new Error(
        `serena-full arm requires a serena fixture for task ${task.id}. Run \`pnpm --filter @pim/eval serena-freeze --task=${task.id}\` first.`,
      );
    }
    return {
      system: task.type === "code" ? SYSTEM_CODE : SYSTEM_CONTENT,
      pimContext: serena.renderedBlock,
      userTask: `## Task\n${task.prompt}`,
    };
  },
};
