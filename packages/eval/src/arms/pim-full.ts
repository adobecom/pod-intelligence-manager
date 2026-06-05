import type { Arm, FixtureLearnings, LivingDocSection, SessionContextFixture } from "./types.js";
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
  primary: true,
  build(task: Task, fixture: SessionContextFixture | null): PromptSegments {
    if (!fixture) {
      throw new Error(
        `pim-full arm requires a fixture for pod ${task.podId}. Run \`pnpm --filter @pim/eval freeze\` first.`,
      );
    }
    // Point-in-time scope: never let the model see PIM context created after the
    // task's `asOf`, which would be temporal leakage in PIM's favour.
    const scoped = task.asOf ? filterFixtureByAsOf(fixture, task.asOf) : fixture;
    const system = task.type === "code" ? SYSTEM_CODE : SYSTEM_CONTENT;
    return {
      system,
      pimContext: serializeContext(scoped),
      userTask: `## Task\n${task.prompt}`,
    };
  },
};

export function serializeContext(fixture: SessionContextFixture): string {
  const { pod, livingDocMarkdown, conflicts, relevantLearnings, recentUpdates } = fixture.payload;
  const lines: string[] = [];

  lines.push(`# PIM Session Context — pod \`${pod.pod_id}\` (${pod.name})`);
  lines.push(`_Pulled at ${fixture.pulledAt}._`);
  if (fixture.asOf) lines.push(`_Point-in-time as of ${fixture.asOf}._`);
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

/**
 * Return a copy of the fixture with time-sensitive data restricted to on/before
 * `asOf` (an ISO timestamp), preventing temporal leakage when a task is anchored
 * to a point in the pod's history, and stamp the copy with `asOf` so the temporal
 * audit can validate it.
 *
 * Every timestamped element is filtered: `recentUpdates` by their `timestamp`, and
 * conflicts / knowledge-graph nodes by their optional `created_at`. Elements with
 * no timestamp pass through unchanged — seed fixtures carry timestamps only on
 * `recentUpdates`, so conflicts and learnings currently pass through. Once the
 * freezer stamps `created_at` (per-task point-in-time freeze), they are scoped too.
 */
export function filterFixtureByAsOf(fixture: SessionContextFixture, asOf: string): SessionContextFixture {
  const cutoff = Date.parse(asOf);
  const onOrBefore = (ts: string | undefined): boolean => {
    if (!ts) return true; // untimestamped element: pass through
    const t = Date.parse(ts);
    return Number.isNaN(t) ? true : t <= cutoff;
  };
  if (Number.isNaN(cutoff)) {
    // Invalid cutoff: stamp it so provenance is visible, but do not filter.
    return { ...fixture, asOf };
  }
  const scopeLearnings = (l: FixtureLearnings): FixtureLearnings => {
    const nodes = l.nodes.filter((n) => onOrBefore(n.created_at));
    const dropped = l.nodes.length - nodes.length;
    return {
      ...l,
      nodes,
      total_matching: Math.max(0, l.total_matching - dropped),
    };
  };
  const taskRelevantLearnings = fixture.payload.taskRelevantLearnings
    ? Object.fromEntries(
        Object.entries(fixture.payload.taskRelevantLearnings).map(([k, v]) => [k, scopeLearnings(v)]),
      )
    : undefined;
  const livingDocSections = fixture.payload.livingDocSections?.filter((section) => onOrBefore(section.updated_at));
  return {
    ...fixture,
    asOf,
    payload: {
      ...fixture.payload,
      ...(livingDocSections
        ? {
            livingDocSections,
            livingDocMarkdown: renderLivingDocSections(livingDocSections),
          }
        : {}),
      conflicts: fixture.payload.conflicts.filter((c) => onOrBefore(c.created_at)),
      relevantLearnings: scopeLearnings(fixture.payload.relevantLearnings),
      ...(taskRelevantLearnings ? { taskRelevantLearnings } : {}),
      recentUpdates: fixture.payload.recentUpdates.filter((u) => onOrBefore(u.timestamp)),
    },
  };
}

export function renderLivingDocSections(sections: LivingDocSection[]): string {
  if (sections.length === 0) return "(no living doc sections at this point in time)";
  return sections.map((section) => section.markdown.trim()).filter(Boolean).join("\n\n");
}
