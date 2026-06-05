import type { Arm, FixtureLearnings, SessionContextFixture } from "./types.js";
import type { Task } from "../tasks/types.js";
import type { PromptSegments } from "../runners/types.js";
import { filterFixtureByAsOf } from "./pim-full.js";

const SYSTEM_CODE = [
  "You are a senior software engineer working on the EMC (Event Management) platform at Adobe.",
  "You will be given relevant org learnings retrieved from the PIM knowledge graph.",
  "Use those learnings to align your output with already-made decisions and avoid known anti-patterns.",
  "Produce a single self-contained TypeScript module that satisfies the user's task.",
  "Return ONLY a fenced ```typescript code block — no prose, no commentary outside the block.",
  "The module should export named functions matching the names mentioned in the task.",
].join("\n");

const SYSTEM_CONTENT = [
  "You are a contributor on the EMC (Event Management) platform at Adobe writing concise, decisive technical content.",
  "You will be given relevant org learnings retrieved from the PIM knowledge graph.",
  "Use them only when relevant to the requested output.",
  "Return ONLY the requested content — no preamble, no postscript.",
].join("\n");

/**
 * KG-only arm: ships only the typed knowledge-graph retrieval portion of the
 * fixture. The living doc, open conflicts, and recent context updates are
 * omitted. Isolates the lift contribution of KG retrieval from the surrounding
 * pod fixtures, which are seed data in the eval rather than live PIM operations.
 *
 * Primary v2 arm for isolating the lift contribution of KG retrieval from the
 * surrounding full PIM bundle.
 */
export const kgOnlyArm: Arm = {
  id: "kg-only",
  label: "KG-only",
  usesPim: true,
  primary: true,
  build(task: Task, fixture: SessionContextFixture | null): PromptSegments {
    if (!fixture) {
      throw new Error(
        `kg-only arm requires a fixture for pod ${task.podId}. Run \`pnpm --filter @pim/eval freeze\` first.`,
      );
    }
    const scoped = task.asOf ? filterFixtureByAsOf(fixture, task.asOf) : fixture;
    const system = task.type === "code" ? SYSTEM_CODE : SYSTEM_CONTENT;
    return {
      system,
      pimContext: serializeKgOnly(scoped, task.id),
      userTask: `## Task\n${task.prompt}`,
    };
  },
};

export function selectKgLearnings(fixture: SessionContextFixture, taskId?: string): {
  learnings: FixtureLearnings;
  source: "task" | "pod";
} {
  const taskLearnings = taskId ? fixture.payload.taskRelevantLearnings?.[taskId] : undefined;
  if (taskLearnings) return { learnings: taskLearnings, source: "task" };
  return { learnings: fixture.payload.relevantLearnings, source: "pod" };
}

export function serializeKgOnly(fixture: SessionContextFixture, taskId?: string): string {
  const { pod } = fixture.payload;
  const { learnings: relevantLearnings, source } = selectKgLearnings(fixture, taskId);
  const lines: string[] = [];

  lines.push(`# PIM Knowledge-Graph Context — pod \`${pod.pod_id}\` (${pod.name})`);
  lines.push(`_Pulled at ${fixture.pulledAt}._`);
  if (fixture.asOf) lines.push(`_Point-in-time as of ${fixture.asOf}._`);
  if (taskId) {
    const scope = source === "task" ? `task \`${taskId}\`` : `pod fallback`;
    lines.push(`_KG retrieval scope: ${scope}._`);
  }
  lines.push("");

  lines.push("## Relevant Org Learnings");
  if (relevantLearnings.nodes.length > 0) {
    for (const n of relevantLearnings.nodes) {
      const src = n.source_pod_name ? ` (from ${n.source_pod_name})` : "";
      lines.push(`- **[${n.type}]${src}** ${n.summary}`);
      if (n.details) lines.push(`  - ${n.details}`);
    }
    if (relevantLearnings.truncated) {
      lines.push(
        `_(${relevantLearnings.total_matching - relevantLearnings.nodes.length} more matching learnings truncated by token budget)_`,
      );
    }
  } else {
    lines.push(`_(no learnings matched for ${source === "task" ? "this task" : "this pod"})_`);
  }
  lines.push("");

  return lines.join("\n");
}
