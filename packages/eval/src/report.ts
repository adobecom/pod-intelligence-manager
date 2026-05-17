import type { JudgeResult } from "./judges/types.js";
import type { RunUsage } from "./runners/types.js";
import { costFor } from "./pricing.js";

export interface EvalRow {
  taskId: string;
  taskType: "code" | "content";
  podId: string;
  arm: string;
  armLabel: string;
  runner: "bedrock" | "anthropic";
  model: string;
  output: string;
  usage: RunUsage;
  latencyMs: number;
  judge: JudgeResult;
  costUsd: number;
  /** Diagnostic: which expectedSignals appeared in the output (case-insensitive substring match). */
  signalsHit: string[];
  /** All tags on the source task. Used for per-category roll-ups. */
  tags?: string[];
  /** 0-indexed seed number when multi-seed runs are enabled. Defaults to 0. */
  seed?: number;
  /** Run-level error if the call or judge failed. */
  error?: string;
}

/**
 * Categories used in the leadership-facing per-category breakdown table.
 *
 * Each task gets exactly one bucket via its tags. Tag → bucket precedence is:
 *   off-scope > housestyle > vague-issue > saturated > (other).
 * The order matters: "off-scope" wins because that's a negative-control
 * statement about the task regardless of whether the fix happens to be in a
 * house style. A task without any of these four tags lands in "other".
 */
const CATEGORY_PRECEDENCE = [
  "off-scope",
  "housestyle",
  "vague-issue",
  "saturated",
] as const;

type Category = (typeof CATEGORY_PRECEDENCE)[number] | "other";

const CATEGORY_LABEL: Record<Category, string> = {
  "vague-issue": "Vague issue text — PIM should win",
  housestyle: "Requires house-style / convention — PIM should win",
  saturated: "PR body specifies the answer — sanity check",
  "off-scope": "KG-irrelevant — negative control",
  other: "Other / uncategorized",
};

function categorize(tags: string[] | undefined): Category {
  if (!tags) return "other";
  for (const c of CATEGORY_PRECEDENCE) {
    if (tags.includes(c)) return c;
  }
  return "other";
}

export interface ReportContext {
  generatedAt: string;
  gitSha?: string;
  runner: string;
  model: string;
  judgeModel: string;
  /** Filter applied (for repro). */
  filter: { taskIds?: string[]; tags?: string[]; arms?: string[] };
}

export function renderMarkdownReport(rows: EvalRow[], ctx: ReportContext): string {
  const lines: string[] = [];
  lines.push(`# PIM Eval Report`);
  lines.push(`_Generated: ${ctx.generatedAt}_`);
  lines.push("");

  // Executive summary — auto-derived from rows so leadership-facing copy
  // stays honest as new tasks are added. Shows the headline arm delta plus
  // a one-line readout per category.
  const exec = computeExecutiveSummary(rows);
  if (exec) {
    lines.push("## Executive summary");
    lines.push("");
    for (const bullet of exec.bullets) lines.push(`- ${bullet}`);
    lines.push("");
  }

  lines.push("## Summary by arm");
  lines.push("");
  lines.push("| Arm | Pass rate | Avg score | Total cost (USD) | Cost / correct (USD) | Output tok / correct | p50 latency (ms) | Cache hit rate |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const armId of distinct(rows.map((r) => r.arm))) {
    const armRows = rows.filter((r) => r.arm === armId);
    const armLabel = armRows[0]?.armLabel ?? armId;
    const total = armRows.length;
    const passes = armRows.filter((r) => r.judge.passed).length;
    const avgScore = mean(armRows.map((r) => r.judge.score));
    const totalCost = sum(armRows.map((r) => r.costUsd));
    const costPerCorrect = passes > 0 ? totalCost / passes : Infinity;
    const totalOutputTokens = sum(armRows.map((r) => r.usage.outputTokens));
    const outputTokPerCorrect = passes > 0 ? totalOutputTokens / passes : Infinity;
    const p50 = percentile(armRows.map((r) => r.latencyMs), 0.5);
    const cacheHitRate = computeCacheHitRate(armRows);
    lines.push(
      `| ${armLabel} | ${pct(passes / total)} (${passes}/${total}) | ${(avgScore).toFixed(2)} | ${totalCost.toFixed(4)} | ${costPerCorrect === Infinity ? "—" : costPerCorrect.toFixed(4)} | ${outputTokPerCorrect === Infinity ? "—" : outputTokPerCorrect.toFixed(0)} | ${p50.toFixed(0)} | ${pct(cacheHitRate)} |`,
    );
  }
  lines.push("");

  lines.push("## Summary by task type and arm");
  lines.push("");
  lines.push("| Type | Arm | Pass rate | Avg score | Total cost (USD) |");
  lines.push("| --- | --- | ---: | ---: | ---: |");
  for (const type of ["code", "content"] as const) {
    for (const armId of distinct(rows.map((r) => r.arm))) {
      const subset = rows.filter((r) => r.taskType === type && r.arm === armId);
      if (subset.length === 0) continue;
      const passes = subset.filter((r) => r.judge.passed).length;
      const avgScore = mean(subset.map((r) => r.judge.score));
      const cost = sum(subset.map((r) => r.costUsd));
      lines.push(
        `| ${type} | ${subset[0].armLabel} | ${pct(passes / subset.length)} (${passes}/${subset.length}) | ${avgScore.toFixed(2)} | ${cost.toFixed(4)} |`,
      );
    }
  }
  lines.push("");

  // Per-category breakdown — the single most useful table for leadership.
  // Shows where PIM lifts vs. where it's a wash, separated by why we think it
  // should or shouldn't matter.
  const categoryRows = computeCategoryBreakdown(rows);
  if (categoryRows.length > 0) {
    lines.push("## Pass rate by category (PIM vs. control)");
    lines.push("");
    lines.push("| Category | n | Control pass | PIM pass | Δ pass rate | Control avg score | PIM avg score |");
    lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
    for (const r of categoryRows) {
      const delta = r.pimPassRate - r.controlPassRate;
      const deltaStr = delta === 0 ? "tie" : `${delta > 0 ? "+" : ""}${(delta * 100).toFixed(0)}pp`;
      lines.push(
        `| ${r.label} | ${r.taskCount} | ${pct(r.controlPassRate)} (${r.controlPasses}/${r.taskCount}) | ${pct(r.pimPassRate)} (${r.pimPasses}/${r.taskCount}) | ${deltaStr} | ${r.controlAvgScore.toFixed(2)} | ${r.pimAvgScore.toFixed(2)} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Per-task results");
  lines.push("");
  // When multi-seed: collapse rows so each (task, arm) cell shows pass-rate over
  // seeds. Single-seed runs render unchanged (k=1 of 1 == ✅, 0 of 1 == ❌).
  const maxSeed = Math.max(0, ...rows.map((r) => r.seed ?? 0));
  const seedCount = maxSeed + 1;
  lines.push("| Task | Arm | Pass | Score | In | CacheR | CacheW | Out | Cost | Latency (ms) | Signals hit |");
  lines.push("| --- | --- | :---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |");
  const taskOrder = distinct(rows.map((r) => r.taskId));
  for (const taskId of taskOrder) {
    const taskRows = rows.filter((r) => r.taskId === taskId);
    const armIds = distinct(taskRows.map((r) => r.arm));
    for (const armId of armIds) {
      const cells = taskRows.filter((r) => r.arm === armId);
      const passes = cells.filter((r) => r.judge.passed).length;
      const armLabel = cells[0].armLabel;
      const avgScore = mean(cells.map((r) => r.judge.score));
      const sumIn = sum(cells.map((r) => r.usage.inputTokens));
      const sumCacheR = sum(cells.map((r) => r.usage.cacheReadTokens));
      const sumCacheW = sum(cells.map((r) => r.usage.cacheCreationTokens));
      const sumOut = sum(cells.map((r) => r.usage.outputTokens));
      const sumCost = sum(cells.map((r) => r.costUsd));
      const avgLatency = mean(cells.map((r) => r.latencyMs));
      const signalsHit = distinct(cells.flatMap((r) => r.signalsHit));
      // Pass column: single-seed shows ✅/❌; multi-seed shows e.g. "✅ 3/3" or "⚠️ 2/3" or "❌ 0/3".
      let passCell: string;
      if (seedCount === 1) {
        passCell = passes > 0 ? "✅" : "❌";
      } else if (passes === seedCount) {
        passCell = `✅ ${passes}/${seedCount}`;
      } else if (passes === 0) {
        passCell = `❌ 0/${seedCount}`;
      } else {
        passCell = `⚠️ ${passes}/${seedCount}`;
      }
      lines.push(
        `| ${taskId} | ${armLabel} | ${passCell} | ${avgScore.toFixed(2)} | ${sumIn} | ${sumCacheR} | ${sumCacheW} | ${sumOut} | ${sumCost.toFixed(4)} | ${avgLatency.toFixed(0)} | ${signalsHit.join(", ") || "—"} |`,
      );
    }
  }
  if (seedCount > 1) {
    lines.push("");
    lines.push(`_Multi-seed run (n=${seedCount}). Pass column shows seeds passed / total. Tokens and cost are summed across seeds; score and latency are averaged._`);
  }
  lines.push("");

  lines.push("## Diagnostic: where PIM made the difference");
  lines.push("");
  const diffs = computeArmDiff(rows);
  if (diffs.pimSaves.length > 0) {
    lines.push("### Tasks where PIM-arm passed AND control failed (PIM saves)");
    for (const d of diffs.pimSaves) {
      lines.push(`- **${d.taskId}** — control failure: \`${d.controlFailure}\``);
    }
    lines.push("");
  }
  if (diffs.pimRegressions.length > 0) {
    lines.push("### Tasks where control passed AND PIM-arm failed (PIM regressions)");
    for (const d of diffs.pimRegressions) {
      lines.push(`- **${d.taskId}** — PIM failure: \`${d.pimFailure}\``);
    }
    lines.push("");
  }
  if (diffs.pimSaves.length === 0 && diffs.pimRegressions.length === 0) {
    lines.push("_No differential outcomes — both arms tied on every task. Consider harder tasks or richer PIM context._");
    lines.push("");
  }

  lines.push("## Per-task failure detail");
  lines.push("");
  // When multi-seed: only surface a failure block when the task failed a majority of
  // seeds, and pick the lowest-scoring failure as the representative — that's the
  // signal worth reading. Single-seed runs render one block per failing row as before.
  const failureGroups = new Map<string, EvalRow[]>();
  for (const r of rows.filter((r) => !r.judge.passed)) {
    const key = `${r.taskId}::${r.arm}`;
    if (!failureGroups.has(key)) failureGroups.set(key, []);
    failureGroups.get(key)!.push(r);
  }
  for (const [key, fails] of failureGroups) {
    const [, arm] = key.split("::");
    const allRowsForArm = rows.filter((r) => r.taskId === fails[0].taskId && r.arm === arm);
    // Only render if this is a majority-failing (task, arm) combo.
    if (fails.length < allRowsForArm.length / 2) continue;
    // Representative failure = lowest score among the failures.
    const r = fails.slice().sort((a, b) => a.judge.score - b.judge.score)[0];
    const seedsLabel = seedCount > 1 ? ` (${fails.length}/${allRowsForArm.length} seeds failed)` : "";
    lines.push(`### ${r.taskId} — ${r.armLabel}${seedsLabel}`);
    lines.push(`- Score: ${r.judge.score.toFixed(2)}`);
    lines.push(`- Detail: ${r.judge.detail}`);
    if (r.judge.failures && r.judge.failures.length > 0) {
      lines.push(`- Failures:`);
      for (const f of r.judge.failures) lines.push(`  - ${f}`);
    }
    if (r.judge.rubricScores) {
      lines.push(`- Rubric: ${JSON.stringify(r.judge.rubricScores)}`);
    }
    if (r.error) lines.push(`- Error: ${r.error}`);
    lines.push("");
  }

  lines.push("## Reproduction");
  lines.push("");
  lines.push(`- Runner: \`${ctx.runner}\``);
  lines.push(`- Model: \`${ctx.model}\``);
  lines.push(`- Judge model: \`${ctx.judgeModel}\``);
  if (ctx.gitSha) lines.push(`- Git SHA: \`${ctx.gitSha}\``);
  lines.push(`- Filter: \`${JSON.stringify(ctx.filter)}\``);
  lines.push("");

  return lines.join("\n");
}

function distinct<T>(arr: T[]): T[] {
  const out: T[] = [];
  const seen = new Set<T>();
  for (const x of arr) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}

function sum(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0);
}

function mean(arr: number[]): number {
  return arr.length === 0 ? 0 : sum(arr) / arr.length;
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function pct(x: number): string {
  if (!Number.isFinite(x)) return "—";
  return `${(x * 100).toFixed(0)}%`;
}

function computeCacheHitRate(rows: EvalRow[]): number {
  const totalCacheable = sum(rows.map((r) => r.usage.cacheReadTokens + r.usage.cacheCreationTokens + r.usage.inputTokens));
  if (totalCacheable === 0) return 0;
  return sum(rows.map((r) => r.usage.cacheReadTokens)) / totalCacheable;
}

interface CategoryRow {
  category: Category;
  label: string;
  taskCount: number;
  controlPasses: number;
  controlPassRate: number;
  controlAvgScore: number;
  pimPasses: number;
  pimPassRate: number;
  pimAvgScore: number;
}

function computeCategoryBreakdown(rows: EvalRow[]): CategoryRow[] {
  // Group unique tasks by category, then compute per-arm pass stats inside.
  const byCategory = new Map<Category, Set<string>>();
  for (const r of rows) {
    const c = categorize(r.tags);
    if (!byCategory.has(c)) byCategory.set(c, new Set());
    byCategory.get(c)!.add(r.taskId);
  }

  const results: CategoryRow[] = [];
  // Stable order: render categories in the precedence order, with "other"
  // last so it visibly sits at the bottom when present.
  const order: Category[] = [...CATEGORY_PRECEDENCE, "other"];
  for (const c of order) {
    const taskIds = byCategory.get(c);
    if (!taskIds || taskIds.size === 0) continue;
    const taskCount = taskIds.size;
    const controlRows = rows.filter((r) => taskIds.has(r.taskId) && r.arm === "control");
    const pimRows = rows.filter((r) => taskIds.has(r.taskId) && r.arm === "pim-full");
    if (controlRows.length === 0 && pimRows.length === 0) continue;
    const controlPasses = controlRows.filter((r) => r.judge.passed).length;
    const pimPasses = pimRows.filter((r) => r.judge.passed).length;
    results.push({
      category: c,
      label: CATEGORY_LABEL[c],
      taskCount,
      controlPasses,
      controlPassRate: controlRows.length > 0 ? controlPasses / controlRows.length : 0,
      controlAvgScore: mean(controlRows.map((r) => r.judge.score)),
      pimPasses,
      pimPassRate: pimRows.length > 0 ? pimPasses / pimRows.length : 0,
      pimAvgScore: mean(pimRows.map((r) => r.judge.score)),
    });
  }
  return results;
}

interface ExecSummary {
  bullets: string[];
}

function computeExecutiveSummary(rows: EvalRow[]): ExecSummary | null {
  const control = rows.filter((r) => r.arm === "control");
  const pim = rows.filter((r) => r.arm === "pim-full");
  if (control.length === 0 || pim.length === 0) return null;

  const controlPasses = control.filter((r) => r.judge.passed).length;
  const pimPasses = pim.filter((r) => r.judge.passed).length;
  const controlCost = sum(control.map((r) => r.costUsd));
  const pimCost = sum(pim.map((r) => r.costUsd));
  const controlCpc = controlPasses > 0 ? controlCost / controlPasses : Infinity;
  const pimCpc = pimPasses > 0 ? pimCost / pimPasses : Infinity;
  const diff = computeArmDiff(rows);

  // Headline pass-rate delta, in percentage points.
  const controlRate = controlPasses / control.length;
  const pimRate = pimPasses / pim.length;
  const deltaPp = Math.round((pimRate - controlRate) * 100);
  const passLine =
    deltaPp === 0
      ? `Pass rate tied at ${pct(pimRate)} across ${control.length} tasks.`
      : `PIM ${deltaPp > 0 ? "lifts" : "drops"} pass rate by ${Math.abs(deltaPp)}pp ` +
        `(${pct(controlRate)} → ${pct(pimRate)}, n=${control.length}).`;

  // Cost-per-correct delta. Use signed % vs control.
  const cpcLine = (() => {
    if (!Number.isFinite(controlCpc) && !Number.isFinite(pimCpc)) {
      return `Cost-per-correct not computable (no passes in either arm).`;
    }
    if (!Number.isFinite(controlCpc)) {
      return `Control had no passing tasks; PIM cost-per-correct is $${pimCpc.toFixed(4)}.`;
    }
    if (!Number.isFinite(pimCpc)) {
      return `PIM had no passing tasks; control cost-per-correct was $${controlCpc.toFixed(4)}.`;
    }
    const deltaPct = Math.round(((pimCpc - controlCpc) / controlCpc) * 100);
    const verb = deltaPct < 0 ? "cuts" : deltaPct > 0 ? "raises" : "leaves";
    return (
      `PIM ${verb} cost-per-correct by ${Math.abs(deltaPct)}% ` +
      `($${controlCpc.toFixed(4)} → $${pimCpc.toFixed(4)}).`
    );
  })();

  // PIM saves / regressions — the differential outcome line.
  const diffLine = (() => {
    const saves = diff.pimSaves.length;
    const regs = diff.pimRegressions.length;
    if (saves === 0 && regs === 0) {
      return `No differential outcomes (both arms tied on every task).`;
    }
    const parts: string[] = [];
    if (saves > 0) parts.push(`${saves} task${saves === 1 ? "" : "s"} where PIM passed and control failed`);
    if (regs > 0) parts.push(`${regs} task${regs === 1 ? "" : "s"} where PIM regressed`);
    return `Differential outcomes: ${parts.join("; ")}.`;
  })();

  return { bullets: [passLine, cpcLine, diffLine] };
}

function computeArmDiff(rows: EvalRow[]): {
  pimSaves: Array<{ taskId: string; controlFailure: string }>;
  pimRegressions: Array<{ taskId: string; pimFailure: string }>;
} {
  // Differential outcomes use majority vote across seeds: PIM "saves" a task
  // when at least half of the PIM-arm seeds pass AND fewer than half of the
  // control seeds pass. Single-seed reduces to the original strict comparison.
  const pimSaves: Array<{ taskId: string; controlFailure: string }> = [];
  const pimRegressions: Array<{ taskId: string; pimFailure: string }> = [];
  const taskIds = distinct(rows.map((r) => r.taskId));
  for (const id of taskIds) {
    const controlRows = rows.filter((r) => r.taskId === id && r.arm === "control");
    const pimRows = rows.filter((r) => r.taskId === id && r.arm === "pim-full");
    if (controlRows.length === 0 || pimRows.length === 0) continue;
    const controlPassFrac = controlRows.filter((r) => r.judge.passed).length / controlRows.length;
    const pimPassFrac = pimRows.filter((r) => r.judge.passed).length / pimRows.length;
    if (pimPassFrac >= 0.5 && controlPassFrac < 0.5) {
      // Surface the first failing control output so the reader sees a concrete reason.
      const firstControlFail = controlRows.find((r) => !r.judge.passed);
      pimSaves.push({ taskId: id, controlFailure: firstControlFail?.judge.detail ?? "(no failure detail)" });
    }
    if (pimPassFrac < 0.5 && controlPassFrac >= 0.5) {
      const firstPimFail = pimRows.find((r) => !r.judge.passed);
      pimRegressions.push({ taskId: id, pimFailure: firstPimFail?.judge.detail ?? "(no failure detail)" });
    }
  }
  return { pimSaves, pimRegressions };
}

export function rowCost(model: string, usage: RunUsage): number {
  return costFor(model, usage);
}
