import type { Arm, SessionContextFixture } from "./types.js";
import type { Task } from "../tasks/types.js";
import type { PromptSegments } from "../runners/types.js";

const SYSTEM_CODE = [
  "You are a senior software engineer working on the EMC (Event Management) platform at Adobe.",
  "You will be given the canonical PIM living doc for your pod plus open conflicts and relevant org learnings.",
  "Use that context to align your output with already-made decisions, avoid known anti-patterns, and respect open conflicts.",
  "Produce a single self-contained TypeScript module that satisfies the user's task.",
  "Return ONLY a fenced ```typescript code block — no prose, no commentary outside the block.",
  "The module should export named functions matching the names mentioned in the task.",
].join("\n");

const SYSTEM_CONTENT = [
  "You are a contributor on the EMC (Event Management) platform at Adobe writing concise, decisive technical content.",
  "You will be given the canonical PIM living doc for your pod plus open conflicts and relevant org learnings.",
  "Ground your output in that context — cite specific conflict IDs and prior decisions where relevant.",
  "Return ONLY the requested content — no preamble, no postscript.",
].join("\n");

/**
 * PIM-full arm — injects the entire SessionContext as a single cacheable block.
 * The block is identical across all tasks for a given pod, so prompt caching
 * (when supported by the runner) amortizes the input cost across the pod's task batch.
 */
export const pimFullArm: Arm = {
  id: "pim-full",
  label: "PIM-full",
  usesPim: true,
  build(task: Task, fixture: SessionContextFixture | null): PromptSegments {
    if (!fixture) {
      throw new Error(
        `pim-full arm requires a fixture for pod ${task.podId}. Run \`pnpm --filter @pim/eval freeze\` first.`,
      );
    }
    const system = task.type === "code" ? SYSTEM_CODE : SYSTEM_CONTENT;
    return {
      system,
      pimContext: serializeContext(fixture),
      userTask: `## Task\n${task.prompt}`,
    };
  },
};

function serializeContext(fixture: SessionContextFixture): string {
  const { pod, livingDocMarkdown, conflicts, relevantLearnings, recentUpdates } = fixture.payload;
  const lines: string[] = [];

  lines.push(`# PIM Session Context — pod \`${pod.pod_id}\` (${pod.name})`);
  lines.push(`_Pulled at ${fixture.pulledAt}._`);
  lines.push("");

  lines.push("## Living Doc");
  lines.push(livingDocMarkdown.trim() || "(empty)");
  lines.push("");

  if (conflicts.length > 0) {
    lines.push("## Open Conflicts (full detail)");
    for (const c of conflicts) {
      lines.push(`### ${c.id} [${c.severity}] — ${c.summary}`);
      for (const s of c.sides) {
        lines.push(`- **${s.contributor}**: ${s.position}`);
      }
      lines.push("");
      lines.push(`**PIM analysis:** ${c.master_analysis}`);
      if (c.impact?.length) {
        lines.push(`**Impact:** ${c.impact.join("; ")}`);
      }
      lines.push("");
    }
  }

  if (relevantLearnings.nodes.length > 0) {
    lines.push("## Relevant Org Learnings");
    for (const n of relevantLearnings.nodes) {
      const src = n.source_pod_name ? ` (from ${n.source_pod_name})` : "";
      lines.push(`- **[${n.type}]${src}** ${n.summary}`);
      if (n.details) lines.push(`  - ${n.details}`);
    }
    if (relevantLearnings.truncated) {
      lines.push(`_(${relevantLearnings.total_matching - relevantLearnings.nodes.length} more matching learnings truncated by token budget)_`);
    }
    lines.push("");
  }

  if (recentUpdates.length > 0) {
    lines.push("## Recent Context Updates");
    for (const u of recentUpdates.slice(0, 12)) {
      lines.push(`- \`${u.timestamp}\` [${u.type}/${u.status}] **${u.agent_id}**: ${u.summary}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
