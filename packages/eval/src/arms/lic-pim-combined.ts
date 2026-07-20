import type { Arm, ArmBuildInputs, LicContextFixture, SessionContextFixture } from "./types.js";
import type { Task } from "../tasks/types.js";
import type { PromptSegments } from "../runners/types.js";
import { filterFixtureByAsOf, serializeContextWithReservedKg } from "./pim-full.js";
import { HALF_BUDGET_CHARS, clip } from "./budget.js";

const SYSTEM_CODE = [
  "You are a senior software engineer working on the EMC (Event Management) platform at Adobe.",
  "You will be given two complementary context blocks:",
  "  1. A PIM session context: pod living-doc, conflicts, knowledge-graph learnings, and recent updates.",
  "  2. A lic context block: semantic search results, symbol references, call graphs.",
  "Use both to align your fix with already-made decisions AND with cross-file code structure.",
  "The task prompt's exported API and input contract are authoritative. If lic snippets show surrounding app-only preconditions or dependencies, adapt the pattern to the requested self-contained module instead of requiring extra inputs.",
  "Produce a single self-contained TypeScript module that satisfies the user's task.",
  "Return ONLY a fenced ```typescript code block — no prose, no commentary outside the block.",
  "The module should export named functions matching the names mentioned in the task.",
].join("\n");

const SYSTEM_CONTENT = [
  "You are a contributor on the EMC (Event Management) platform at Adobe writing concise, decisive technical content.",
  "You will be given two complementary context blocks:",
  "  1. A PIM session context (pod state, conflicts, learnings, updates).",
  "  2. A lic context block (code-intelligence: search hits, symbols, callers).",
  "Use both when relevant. Return ONLY the requested content — no preamble, no postscript.",
  "Treat the user task as authoritative if retrieved code context conflicts with the requested output shape.",
].join("\n");

function buildCombinedContext(pim: SessionContextFixture, lic: LicContextFixture, taskId: string): string {
  const pimBlock = serializeContextWithReservedKg(pim, taskId, HALF_BUDGET_CHARS);
  const licBlock = clip(lic.renderedBlock, HALF_BUDGET_CHARS);
  return [
    "=== PIM Session Context ===",
    pimBlock,
    "",
    "=== lic Code-Intelligence Context ===",
    licBlock,
  ].join("\n");
}

/**
 * Budget-split combined arm: PIM (2000 chars) + lic (2000 chars) concatenated.
 * Tests the deployed configuration where both sources are available to the agent
 * at once. Because each source is clipped to half the budget, complementarity is
 * read against the MATCHED-BUDGET singles (`pim-clipped`, `lic-clipped`) — not the
 * full-budget `pim-full` / `lic-full` — so a loss can't be blamed on clipping
 * alone. See `budget.ts`.
 */
export const licPimCombinedArm: Arm = {
  id: "lic-pim-combined",
  label: "Combined (budget-split)",
  usesPim: true,
  usesLic: true,
  primary: true,
  build(_task: Task, _fixture: SessionContextFixture | null): PromptSegments {
    throw new Error("lic-pim-combined: use buildWithInputs; runner must pass both fixtures");
  },
  buildWithInputs(task: Task, inputs: ArmBuildInputs): PromptSegments {
    const pim = inputs.pim;
    const lic = inputs.lic;
    if (!pim) {
      throw new Error(
        `lic-pim-combined arm requires a PIM fixture for pod ${task.podId}. Run \`pnpm --filter @pim/eval freeze\` first.`,
      );
    }
    if (!lic) {
      throw new Error(
        `lic-pim-combined arm requires a lic fixture for task ${task.id}. Run \`pnpm --filter @pim/eval lic-freeze --task=${task.id}\` first.`,
      );
    }
    const filtered = task.asOf ? filterFixtureByAsOf(pim, task.asOf) : pim;
    const system = task.type === "code" ? SYSTEM_CODE : SYSTEM_CONTENT;
    return {
      system,
      pimContext: buildCombinedContext(filtered, lic, task.id),
      userTask: `## Task\n${task.prompt}`,
    };
  },
};
