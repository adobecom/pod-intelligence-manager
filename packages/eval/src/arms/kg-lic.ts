import type { Arm, ArmBuildInputs, LicContextFixture, SessionContextFixture } from "./types.js";
import type { Task } from "../tasks/types.js";
import type { PromptSegments } from "../runners/types.js";
import { serializeKgOnly } from "./kg-only.js";
import { filterFixtureByAsOf } from "./pim-full.js";

const SYSTEM_CODE = [
  "You are a senior software engineer working on the EMC (Event Management) platform at Adobe.",
  "You will be given two complementary context blocks:",
  "  1. Relevant org learnings retrieved from the PIM knowledge graph.",
  "  2. A lic context block: semantic search results, symbol references, and call-graph excerpts from the codebase.",
  "Use the learnings to align with already-made decisions and avoid known anti-patterns, and use the lic context to ground your fix in existing code structure and cross-file relationships.",
  "The task prompt's exported API and input contract are authoritative. If lic snippets show surrounding app-only preconditions or dependencies, adapt the pattern to the requested self-contained module instead of requiring extra inputs.",
  "Produce a single self-contained TypeScript module that satisfies the user's task.",
  "Return ONLY a fenced ```typescript code block — no prose, no commentary outside the block.",
  "The module should export named functions matching the names mentioned in the task.",
].join("\n");

const SYSTEM_CONTENT = [
  "You are a contributor on the EMC (Event Management) platform at Adobe writing concise, decisive technical content.",
  "You will be given two complementary context blocks:",
  "  1. Relevant org learnings retrieved from the PIM knowledge graph.",
  "  2. A lic context block (code-intelligence: search hits, symbols, callers).",
  "Use both when relevant. Return ONLY the requested content — no preamble, no postscript.",
  "Treat the user task as authoritative if retrieved code context conflicts with the requested output shape.",
].join("\n");

/**
 * KG+lic arm: the kg-only knowledge-graph block PLUS lic code-intelligence
 * block, concatenated. The KG portion is byte-identical to the `kg-only` arm
 * (it reuses `serializeKgOnly`), so the kg-only → kg-lic delta isolates lic's
 * marginal contribution on top of KG retrieval — rather than confounding it with
 * the full PIM living doc and conflicts, which is what `lic-pim-combined` measures.
 */
export const kgLicArm: Arm = {
  id: "kg-lic",
  label: "KG+lic",
  usesPim: true,
  usesLic: true,
  primary: true,
  build(): PromptSegments {
    throw new Error("kg-lic: use buildWithInputs; runner must pass both PIM and lic fixtures");
  },
  buildWithInputs(task: Task, inputs: ArmBuildInputs): PromptSegments {
    const { pim, lic } = inputs;
    if (!pim) {
      throw new Error(
        `kg-lic arm requires a PIM fixture for pod ${task.podId}. Run \`pnpm --filter @pim/eval freeze\` first.`,
      );
    }
    if (!lic) {
      throw new Error(
        `kg-lic arm requires a lic fixture for task ${task.id}. Run \`pnpm --filter @pim/eval lic-freeze --task=${task.id}\` first.`,
      );
    }
    const scopedPim = task.asOf ? filterFixtureByAsOf(pim, task.asOf) : pim;
    const system = task.type === "code" ? SYSTEM_CODE : SYSTEM_CONTENT;
    return {
      system,
      pimContext: buildKgLicContext(scopedPim, lic, task.id, task),
      userTask: `## Task\n${task.prompt}`,
    };
  },
};

function buildKgLicContext(pim: SessionContextFixture, lic: LicContextFixture, taskId: string, task?: Task): string {
  return [
    serializeKgOnly(pim, taskId, task),
    "=== lic Code-Intelligence Context ===",
    lic.renderedBlock,
  ].join("\n");
}
