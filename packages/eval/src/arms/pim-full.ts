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
      pimContext: serializeContext(scoped, task.id),
      userTask: `## Task\n${task.prompt}`,
    };
  },
};

function selectRelevantLearnings(fixture: SessionContextFixture, taskId?: string): {
  learnings: FixtureLearnings;
  source: "task" | "pod";
} {
  const taskLearnings = taskId ? fixture.payload.taskRelevantLearnings?.[taskId] : undefined;
  if (taskLearnings) return { learnings: taskLearnings, source: "task" };
  return { learnings: fixture.payload.relevantLearnings, source: "pod" };
}

function serializeContextHeader(
  fixture: SessionContextFixture,
  taskId: string | undefined,
  source: "task" | "pod",
): string {
  const { pod } = fixture.payload;
  const lines: string[] = [];

  lines.push(`# PIM Session Context — pod \`${pod.pod_id}\` (${pod.name})`);
  lines.push(`_Pulled at ${fixture.pulledAt}._`);
  if (fixture.asOf) lines.push(`_Point-in-time as of ${fixture.asOf}._`);
  if (taskId) {
    const scope = source === "task" ? `task \`${taskId}\`` : "pod fallback";
    lines.push(`_KG retrieval scope: ${scope}._`);
  }
  return lines.join("\n");
}

function serializeLivingDocBlock(fixture: SessionContextFixture): string {
  return ["## Living Doc", fixture.payload.livingDocMarkdown.trim() || "(empty)"].join("\n");
}

function serializeConflictsBlock(fixture: SessionContextFixture): string | undefined {
  const { conflicts } = fixture.payload;
  if (conflicts.length === 0) return undefined;
  const lines: string[] = ["## Open Conflicts (full detail)"];
  if (conflicts.length > 0) {
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
  return lines.join("\n").trimEnd();
}

function serializeLearningsBlock(
  relevantLearnings: FixtureLearnings,
  options: { includeDetails: boolean } = { includeDetails: true },
): string | undefined {
  if (relevantLearnings.nodes.length === 0) return undefined;
  const lines: string[] = ["## Relevant Org Learnings"];
  if (relevantLearnings.nodes.length > 0) {
    for (const n of relevantLearnings.nodes) {
      const src = n.source_pod_name ? ` (from ${n.source_pod_name})` : "";
      lines.push(`- **[${n.type}]${src}** ${n.summary}`);
      if (options.includeDetails && n.details) lines.push(`  - ${n.details}`);
    }
    if (relevantLearnings.truncated) {
      lines.push(`_(${relevantLearnings.total_matching - relevantLearnings.nodes.length} more matching learnings truncated by token budget)_`);
    }
  }
  return lines.join("\n");
}

function serializeUpdatesBlock(fixture: SessionContextFixture): string | undefined {
  const { recentUpdates } = fixture.payload;
  if (recentUpdates.length === 0) return undefined;
  const lines: string[] = ["## Recent Context Updates"];
  if (recentUpdates.length > 0) {
    for (const u of recentUpdates.slice(0, 12)) {
      lines.push(`- \`${u.timestamp}\` [${u.type}/${u.status}] **${u.agent_id}**: ${u.summary}`);
    }
  }
  return lines.join("\n");
}

export function serializeContext(fixture: SessionContextFixture, taskId?: string): string {
  const { learnings: relevantLearnings, source } = selectRelevantLearnings(fixture, taskId);
  return [
    serializeContextHeader(fixture, taskId, source),
    serializeLivingDocBlock(fixture),
    serializeConflictsBlock(fixture),
    serializeLearningsBlock(relevantLearnings),
    serializeUpdatesBlock(fixture),
  ].filter((block): block is string => Boolean(block)).join("\n\n");
}

const MATCHED_BUDGET_KG_RESERVE_RATIO = 0.55;
const MATCHED_BUDGET_CLIP_MARKER = "\n_[truncated within matched-budget reserve]_";

function clipReservedBlock(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  if (maxChars <= MATCHED_BUDGET_CLIP_MARKER.length) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - MATCHED_BUDGET_CLIP_MARKER.length).trimEnd()}${MATCHED_BUDGET_CLIP_MARKER}`;
}

/**
 * Serialize the matched-budget PIM slice with an explicit KG reservation.
 * Summary-only task learnings are placed before the long living-doc/conflict
 * material, so a 2,000-character clip cannot silently remove the retrieval the
 * arm is meant to evaluate.
 */
export function serializeContextWithReservedKg(
  fixture: SessionContextFixture,
  taskId: string,
  maxChars: number,
): string {
  const { learnings: relevantLearnings, source } = selectRelevantLearnings(fixture, taskId);
  const learningBlock = serializeLearningsBlock(relevantLearnings, { includeDetails: false });
  if (!learningBlock) return clipReservedBlock(serializeContext(fixture, taskId), maxChars);

  const header = serializeContextHeader(fixture, taskId, source);
  const separator = "\n\n";
  const availableAfterHeader = Math.max(0, maxChars - header.length - separator.length);
  const reservedKgChars = Math.min(
    availableAfterHeader,
    Math.max(1, Math.floor(maxChars * MATCHED_BUDGET_KG_RESERVE_RATIO)),
  );
  const reservedKg = clipReservedBlock(learningBlock, reservedKgChars);
  const usedChars = header.length + separator.length + reservedKg.length;
  const auxiliaryBudget = Math.max(0, maxChars - usedChars - separator.length);
  const auxiliary = clipReservedBlock([
    serializeLivingDocBlock(fixture),
    serializeConflictsBlock(fixture),
    serializeUpdatesBlock(fixture),
  ].filter((block): block is string => Boolean(block)).join(separator), auxiliaryBudget);

  return [header, reservedKg, auxiliary]
    .filter(Boolean)
    .join(separator)
    .slice(0, maxChars);
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
    const hasNodeIds = l.nodes.some((node) => Boolean(node.id));
    const survivingNodeIds = new Set(nodes.map((node) => node.id).filter((id): id is string => Boolean(id)));
    const explanations = l.explanations && hasNodeIds
      ? l.explanations.filter((explanation) => survivingNodeIds.has(explanation.node_id))
      : l.explanations;
    return {
      ...l,
      nodes,
      // Server totals/diagnostics describe the retrieval before this legacy
      // fixture post-filter. We cannot recompute the unseen as-of candidate set,
      // so preserve those values instead of fabricating adjusted counts.
      ...(explanations ? { explanations } : {}),
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
