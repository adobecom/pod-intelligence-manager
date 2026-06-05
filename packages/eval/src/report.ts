import type { JudgeResult } from "./judges/types.js";
import type { RunUsage } from "./runners/types.js";
import { costFor } from "./pricing.js";
import type { LicFixtureQuality } from "./rigor/lic-quality.js";
import type { ProtocolAnalysis } from "./rigor/protocol-analysis.js";
import { realisticTicketHeadlineRows } from "./rigor/protocol-analysis.js";
import { renderProtocolReport } from "./rigor/protocol-report.js";

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
  /** Protocol stratum (S1-S6) assigned by the holdout manifest. */
  stratum?: string;
  /** Prompt realism tier (realistic-ticket / saturated / underspecified / context-required). */
  promptTier?: string;
  /** Full SHA-256 of the frozen lic fixture JSON for this task, when present. */
  licFixtureHash?: string;
  /** Deterministic quality metadata for the frozen lic fixture. */
  licFixtureQuality?: LicFixtureQuality;
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
  /** Protocol claim analysis, rendered as a top section in protocol-mode runs. */
  protocol?: ProtocolAnalysis;
}

export function renderMarkdownReport(rows: EvalRow[], ctx: ReportContext): string {
  const lines: string[] = [];
  lines.push(`# PIM Eval Report`);
  lines.push(`_Generated: ${ctx.generatedAt}_`);
  lines.push("");
  const comparisonArm = pickComparisonArm(rows);

  // Executive summary — auto-derived from rows so leadership-facing copy
  // stays honest as new tasks are added. Shows the headline arm delta plus
  // a one-line readout per category.
  const executiveRows = ctx.protocol ? realisticTicketHeadlineRows(rows) : rows;
  const exec = computeExecutiveSummary(executiveRows, comparisonArm);
  if (exec) {
    lines.push("## Executive summary");
    lines.push("");
    if (ctx.protocol) {
      lines.push("_Protocol mode: bullets use realistic-ticket S1-S5 tasks only; broader diagnostics are below._");
      lines.push("");
    }
    for (const bullet of exec.bullets) lines.push(`- ${bullet}`);
    lines.push("");
  }

  // Protocol claim analysis — the headline PIM-vs-baseline-vs-LIC result, rendered
  // here (not only in analysis.json) for protocol-mode runs.
  if (ctx.protocol) {
    lines.push(...renderProtocolReport(ctx.protocol));
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
  const categoryRows = comparisonArm ? computeCategoryBreakdown(rows, comparisonArm.id) : [];
  if (comparisonArm && categoryRows.length > 0) {
    const comparisonName = comparisonDisplayName(comparisonArm);
    lines.push(`## Pass rate by category (${comparisonName} vs. control)`);
    lines.push("");
    lines.push(`| Category | n tasks | Control pass | ${comparisonName} pass | Δ pass rate | Control avg score | ${comparisonName} avg score |`);
    lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
    for (const r of categoryRows) {
      const delta = r.comparisonPassRate - r.controlPassRate;
      const deltaStr = delta === 0 ? "tie" : `${delta > 0 ? "+" : ""}${(delta * 100).toFixed(0)}pp`;
      lines.push(
        `| ${r.label} | ${r.taskCount} | ${pct(r.controlPassRate)} (${r.controlPasses}/${r.controlTotal}) | ${pct(r.comparisonPassRate)} (${r.comparisonPasses}/${r.comparisonTotal}) | ${deltaStr} | ${r.controlAvgScore.toFixed(2)} | ${r.comparisonAvgScore.toFixed(2)} |`,
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

  const comparisonName = comparisonArm ? comparisonDisplayName(comparisonArm) : "PIM";
  lines.push(`## Diagnostic: where ${comparisonName} made the difference`);
  lines.push("");
  const diffs = comparisonArm ? computeArmDiff(rows, comparisonArm.id) : { comparisonSaves: [], comparisonRegressions: [] };
  if (diffs.comparisonSaves.length > 0) {
    lines.push(`### Tasks where ${comparisonName} passed AND control failed (${comparisonName} saves)`);
    for (const d of diffs.comparisonSaves) {
      lines.push(`- **${d.taskId}** — control failure: \`${d.controlFailure}\``);
    }
    lines.push("");
  }
  if (diffs.comparisonRegressions.length > 0) {
    lines.push(`### Tasks where control passed AND ${comparisonName} failed (${comparisonName} regressions)`);
    for (const d of diffs.comparisonRegressions) {
      lines.push(`- **${d.taskId}** — ${comparisonName} failure: \`${d.comparisonFailure}\``);
    }
    lines.push("");
  }
  if (diffs.comparisonSaves.length === 0 && diffs.comparisonRegressions.length === 0) {
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

interface ComparisonArm {
  id: string;
  label: string;
}

function pickComparisonArm(rows: EvalRow[]): ComparisonArm | null {
  const labels = new Map<string, string>();
  for (const r of rows) labels.set(r.arm, r.armLabel);
  if (!labels.has("control")) return null;

  // PIM-full is the canonical treatment. When a decomposition run omits it
  // (for example control vs kg-only), use the most direct KG/PIM arm present
  // instead of rendering zeroed diagnostics for a missing arm.
  const preferred = ["pim-full", "kg-only", "kg-lic", "lic-pim-combined"];
  for (const id of preferred) {
    const label = labels.get(id);
    if (label) return { id, label };
  }
  return null;
}

function comparisonDisplayName(arm: ComparisonArm): string {
  if (arm.id === "pim-full") return "PIM";
  return arm.label;
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
  controlTotal: number;
  controlPassRate: number;
  controlAvgScore: number;
  comparisonPasses: number;
  comparisonTotal: number;
  comparisonPassRate: number;
  comparisonAvgScore: number;
}

function computeCategoryBreakdown(rows: EvalRow[], comparisonArmId: string): CategoryRow[] {
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
    const comparisonRows = rows.filter((r) => taskIds.has(r.taskId) && r.arm === comparisonArmId);
    if (controlRows.length === 0 && comparisonRows.length === 0) continue;
    const controlPasses = controlRows.filter((r) => r.judge.passed).length;
    const comparisonPasses = comparisonRows.filter((r) => r.judge.passed).length;
    results.push({
      category: c,
      label: CATEGORY_LABEL[c],
      taskCount,
      controlPasses,
      controlTotal: controlRows.length,
      controlPassRate: controlRows.length > 0 ? controlPasses / controlRows.length : 0,
      controlAvgScore: mean(controlRows.map((r) => r.judge.score)),
      comparisonPasses,
      comparisonTotal: comparisonRows.length,
      comparisonPassRate: comparisonRows.length > 0 ? comparisonPasses / comparisonRows.length : 0,
      comparisonAvgScore: mean(comparisonRows.map((r) => r.judge.score)),
    });
  }
  return results;
}

interface ExecSummary {
  bullets: string[];
}

function computeExecutiveSummary(rows: EvalRow[], comparisonArm: ComparisonArm | null): ExecSummary | null {
  const control = rows.filter((r) => r.arm === "control");
  if (!comparisonArm) return null;
  const comparison = rows.filter((r) => r.arm === comparisonArm.id);
  if (control.length === 0 || comparison.length === 0) return null;
  const comparisonName = comparisonDisplayName(comparisonArm);

  const controlPasses = control.filter((r) => r.judge.passed).length;
  const comparisonPasses = comparison.filter((r) => r.judge.passed).length;
  const controlCost = sum(control.map((r) => r.costUsd));
  const comparisonCost = sum(comparison.map((r) => r.costUsd));
  const controlCpc = controlPasses > 0 ? controlCost / controlPasses : Infinity;
  const comparisonCpc = comparisonPasses > 0 ? comparisonCost / comparisonPasses : Infinity;
  const diff = computeArmDiff(rows, comparisonArm.id);

  // Headline pass-rate delta, in percentage points.
  const controlRate = controlPasses / control.length;
  const comparisonRate = comparisonPasses / comparison.length;
  const deltaPp = Math.round((comparisonRate - controlRate) * 100);
  const passLine =
    deltaPp === 0
      ? `Pass rate tied at ${pct(comparisonRate)} across ${control.length} samples.`
      : `${comparisonName} ${deltaPp > 0 ? "lifts" : "drops"} pass rate by ${Math.abs(deltaPp)}pp ` +
        `(${pct(controlRate)} → ${pct(comparisonRate)}, n=${control.length}).`;

  // Cost-per-correct delta. Use signed % vs control.
  const cpcLine = (() => {
    if (!Number.isFinite(controlCpc) && !Number.isFinite(comparisonCpc)) {
      return `Cost-per-correct not computable (no passes in either arm).`;
    }
    if (!Number.isFinite(controlCpc)) {
      return `Control had no passing tasks; ${comparisonName} cost-per-correct is $${comparisonCpc.toFixed(4)}.`;
    }
    if (!Number.isFinite(comparisonCpc)) {
      return `${comparisonName} had no passing tasks; control cost-per-correct was $${controlCpc.toFixed(4)}.`;
    }
    const deltaPct = Math.round(((comparisonCpc - controlCpc) / controlCpc) * 100);
    const verb = deltaPct < 0 ? "cuts" : deltaPct > 0 ? "raises" : "leaves";
    return (
      `${comparisonName} ${verb} cost-per-correct by ${Math.abs(deltaPct)}% ` +
      `($${controlCpc.toFixed(4)} → $${comparisonCpc.toFixed(4)}).`
    );
  })();

  // PIM saves / regressions — the differential outcome line.
  const diffLine = (() => {
    const saves = diff.comparisonSaves.length;
    const regs = diff.comparisonRegressions.length;
    if (saves === 0 && regs === 0) {
      return `No differential outcomes (both arms tied on every task).`;
    }
    const parts: string[] = [];
    if (saves > 0) parts.push(`${saves} task${saves === 1 ? "" : "s"} where ${comparisonName} passed and control failed`);
    if (regs > 0) parts.push(`${regs} task${regs === 1 ? "" : "s"} where ${comparisonName} regressed`);
    return `Differential outcomes: ${parts.join("; ")}.`;
  })();

  return { bullets: [passLine, cpcLine, diffLine] };
}

function computeArmDiff(rows: EvalRow[], comparisonArmId: string): {
  comparisonSaves: Array<{ taskId: string; controlFailure: string }>;
  comparisonRegressions: Array<{ taskId: string; comparisonFailure: string }>;
} {
  // Differential outcomes use majority vote across seeds: the comparison arm
  // "saves" a task when at least half of that arm's seeds pass AND fewer than half of the
  // control seeds pass. Single-seed reduces to the original strict comparison.
  const comparisonSaves: Array<{ taskId: string; controlFailure: string }> = [];
  const comparisonRegressions: Array<{ taskId: string; comparisonFailure: string }> = [];
  const taskIds = distinct(rows.map((r) => r.taskId));
  for (const id of taskIds) {
    const controlRows = rows.filter((r) => r.taskId === id && r.arm === "control");
    const comparisonRows = rows.filter((r) => r.taskId === id && r.arm === comparisonArmId);
    if (controlRows.length === 0 || comparisonRows.length === 0) continue;
    const controlPassFrac = controlRows.filter((r) => r.judge.passed).length / controlRows.length;
    const comparisonPassFrac = comparisonRows.filter((r) => r.judge.passed).length / comparisonRows.length;
    if (comparisonPassFrac >= 0.5 && controlPassFrac < 0.5) {
      // Surface the first failing control output so the reader sees a concrete reason.
      const firstControlFail = controlRows.find((r) => !r.judge.passed);
      comparisonSaves.push({ taskId: id, controlFailure: firstControlFail?.judge.detail ?? "(no failure detail)" });
    }
    if (comparisonPassFrac < 0.5 && controlPassFrac >= 0.5) {
      const firstComparisonFail = comparisonRows.find((r) => !r.judge.passed);
      comparisonRegressions.push({ taskId: id, comparisonFailure: firstComparisonFail?.judge.detail ?? "(no failure detail)" });
    }
  }
  return { comparisonSaves, comparisonRegressions };
}

export function rowCost(model: string, usage: RunUsage): number {
  return costFor(model, usage);
}
