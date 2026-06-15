import type { Arm, ArmBuildInputs, SessionContextFixture } from "./types.js";
import type { SerenaContextFixture } from "../serena/types.js";
import type { Task } from "../tasks/types.js";
import type { PromptSegments } from "../runners/types.js";
import { serializeKgOnly } from "./kg-only.js";
import { filterFixtureByAsOf } from "./pim-full.js";

const SYSTEM_CODE = [
  "You are a senior software engineer working on the EMC (Event Management) platform at Adobe.",
  "You will be given two complementary context blocks:",
  "  1. Relevant org learnings retrieved from the PIM knowledge graph.",
  "  2. A Serena code-intelligence block: symbol definitions, references/callsites, declarations/implementations, and diagnostics from the codebase.",
  "Use the learnings to align with already-made decisions and avoid known anti-patterns, and use the Serena context to ground your fix in existing code structure and cross-file relationships.",
  "The task prompt's exported API and input contract are authoritative. If snippets show surrounding app-only preconditions or dependencies, adapt the pattern to the requested self-contained module instead of requiring extra inputs.",
  "Produce a single self-contained TypeScript module that satisfies the user's task.",
  "Return ONLY a fenced ```typescript code block — no prose, no commentary outside the block.",
  "The module should export named functions matching the names mentioned in the task.",
].join("\n");

const SYSTEM_CONTENT = [
  "You are a contributor on the EMC (Event Management) platform at Adobe writing concise, decisive technical content.",
  "You will be given two complementary context blocks:",
  "  1. Relevant org learnings retrieved from the PIM knowledge graph.",
  "  2. A Serena code-intelligence block (symbols, references, diagnostics).",
  "Use both when relevant. Return ONLY the requested content — no preamble, no postscript.",
  "Treat the user task as authoritative if retrieved code context conflicts with the requested output shape.",
].join("\n");

/**
 * KG+Serena arm: the kg-only knowledge-graph block PLUS a Serena code-intelligence
 * block, concatenated. The KG portion is byte-identical to the `kg-only` arm (it
 * reuses `serializeKgOnly`), so the kg-only → kg-serena delta isolates Serena's
 * marginal contribution on top of KG retrieval. Directly parallel to `kg-lic`, so
 * `kg-lic` vs `kg-serena` is a clean code-intelligence-provider comparison holding
 * the KG context fixed.
 */
export const kgSerenaArm: Arm = {
  id: "kg-serena",
  label: "KG+Serena",
  usesPim: true,
  usesSerena: true,
  primary: true,
  build(): PromptSegments {
    throw new Error("kg-serena: use buildWithInputs; runner must pass both PIM and serena fixtures");
  },
  buildWithInputs(task: Task, inputs: ArmBuildInputs): PromptSegments {
    const { pim, serena } = inputs;
    if (!pim) {
      throw new Error(
        `kg-serena arm requires a PIM fixture for pod ${task.podId}. Run \`pnpm --filter @pim/eval freeze\` first.`,
      );
    }
    if (!serena) {
      throw new Error(
        `kg-serena arm requires a serena fixture for task ${task.id}. Run \`pnpm --filter @pim/eval serena-freeze --task=${task.id}\` first.`,
      );
    }
    const scopedPim = task.asOf ? filterFixtureByAsOf(pim, task.asOf) : pim;
    const system = task.type === "code" ? SYSTEM_CODE : SYSTEM_CONTENT;
    return {
      system,
      pimContext: buildKgSerenaContext(scopedPim, serena, task.id, task),
      userTask: `## Task\n${task.prompt}`,
    };
  },
};

function buildKgSerenaContext(pim: SessionContextFixture, serena: SerenaContextFixture, taskId: string, task?: Task): string {
  return [
    serializeKgOnly(pim, taskId, task),
    "=== Serena Code-Intelligence Context ===",
    serena.renderedBlock,
  ].join("\n");
}
