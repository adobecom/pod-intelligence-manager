import type { Arm, ArmBuildInputs, SessionContextFixture } from "./types.js";
import type { SerenaContextFixture } from "../serena/types.js";
import type { Task } from "../tasks/types.js";
import type { PromptSegments } from "../runners/types.js";
import { filterFixtureByAsOf, serializeContextWithReservedKg } from "./pim-full.js";
import { HALF_BUDGET_CHARS, clip } from "./budget.js";

const SYSTEM_CODE = [
  "You are a senior software engineer working on the EMC (Event Management) platform at Adobe.",
  "You will be given two complementary context blocks:",
  "  1. A PIM session context: pod living-doc, conflicts, knowledge-graph learnings, and recent updates.",
  "  2. A Serena code-intelligence block: symbol definitions, references, declarations/implementations, diagnostics.",
  "Use both to align your fix with already-made decisions AND with cross-file code structure.",
  "The task prompt's exported API and input contract are authoritative. If snippets show surrounding app-only preconditions or dependencies, adapt the pattern to the requested self-contained module instead of requiring extra inputs.",
  "Produce a single self-contained TypeScript module that satisfies the user's task.",
  "Return ONLY a fenced ```typescript code block — no prose, no commentary outside the block.",
  "The module should export named functions matching the names mentioned in the task.",
].join("\n");

const SYSTEM_CONTENT = [
  "You are a contributor on the EMC (Event Management) platform at Adobe writing concise, decisive technical content.",
  "You will be given two complementary context blocks:",
  "  1. A PIM session context (pod state, conflicts, learnings, updates).",
  "  2. A Serena code-intelligence block (symbols, references, diagnostics).",
  "Use both when relevant. Return ONLY the requested content — no preamble, no postscript.",
  "Treat the user task as authoritative if retrieved code context conflicts with the requested output shape.",
].join("\n");

function buildCombinedContext(pim: SessionContextFixture, serena: SerenaContextFixture, taskId: string): string {
  const pimBlock = serializeContextWithReservedKg(pim, taskId, HALF_BUDGET_CHARS);
  const serenaBlock = clip(serena.renderedBlock, HALF_BUDGET_CHARS);
  return [
    "=== PIM Session Context ===",
    pimBlock,
    "",
    "=== Serena Code-Intelligence Context ===",
    serenaBlock,
  ].join("\n");
}

/**
 * Budget-split combined arm: PIM (2000 chars) + Serena (2000 chars). Complementarity
 * is read against the MATCHED-BUDGET singles (`pim-clipped`, `serena-clipped`), not
 * the full-budget `pim-full` / `serena-full`. See `budget.ts`.
 */
export const serenaPimCombinedArm: Arm = {
  id: "serena-pim-combined",
  label: "Serena+PIM (budget-split)",
  usesPim: true,
  usesSerena: true,
  primary: true,
  build(_task: Task, _fixture: SessionContextFixture | null): PromptSegments {
    throw new Error("serena-pim-combined: use buildWithInputs; runner must pass both fixtures");
  },
  buildWithInputs(task: Task, inputs: ArmBuildInputs): PromptSegments {
    const pim = inputs.pim;
    const serena = inputs.serena;
    if (!pim) {
      throw new Error(
        `serena-pim-combined arm requires a PIM fixture for pod ${task.podId}. Run \`pnpm --filter @pim/eval freeze\` first.`,
      );
    }
    if (!serena) {
      throw new Error(
        `serena-pim-combined arm requires a serena fixture for task ${task.id}. Run \`pnpm --filter @pim/eval serena-freeze --task=${task.id}\` first.`,
      );
    }
    const filtered = task.asOf ? filterFixtureByAsOf(pim, task.asOf) : pim;
    return {
      system: task.type === "code" ? SYSTEM_CODE : SYSTEM_CONTENT,
      pimContext: buildCombinedContext(filtered, serena, task.id),
      userTask: `## Task\n${task.prompt}`,
    };
  },
};
