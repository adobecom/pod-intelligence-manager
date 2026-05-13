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
  /** Run-level error if the call or judge failed. */
  error?: string;
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

  lines.push("## Summary by arm");
  lines.push("");
  lines.push("| Arm | Pass rate | Avg score | Total cost (USD) | Cost / correct (USD) | p50 latency (ms) | Cache hit rate |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const armId of distinct(rows.map((r) => r.arm))) {
    const armRows = rows.filter((r) => r.arm === armId);
    const armLabel = armRows[0]?.armLabel ?? armId;
    const total = armRows.length;
    const passes = armRows.filter((r) => r.judge.passed).length;
    const avgScore = mean(armRows.map((r) => r.judge.score));
    const totalCost = sum(armRows.map((r) => r.costUsd));
    const costPerCorrect = passes > 0 ? totalCost / passes : Infinity;
    const p50 = percentile(armRows.map((r) => r.latencyMs), 0.5);
    const cacheHitRate = computeCacheHitRate(armRows);
    lines.push(
      `| ${armLabel} | ${pct(passes / total)} (${passes}/${total}) | ${(avgScore).toFixed(2)} | ${totalCost.toFixed(4)} | ${costPerCorrect === Infinity ? "—" : costPerCorrect.toFixed(4)} | ${p50.toFixed(0)} | ${pct(cacheHitRate)} |`,
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

  lines.push("## Per-task results");
  lines.push("");
  lines.push("| Task | Arm | Pass | Score | In | CacheR | CacheW | Out | Cost | Latency (ms) | Signals hit |");
  lines.push("| --- | --- | :---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |");
  const taskOrder = distinct(rows.map((r) => r.taskId));
  for (const taskId of taskOrder) {
    const taskRows = rows.filter((r) => r.taskId === taskId);
    for (const r of taskRows) {
      lines.push(
        `| ${r.taskId} | ${r.armLabel} | ${r.judge.passed ? "✅" : "❌"} | ${r.judge.score.toFixed(2)} | ${r.usage.inputTokens} | ${r.usage.cacheReadTokens} | ${r.usage.cacheCreationTokens} | ${r.usage.outputTokens} | ${r.costUsd.toFixed(4)} | ${r.latencyMs.toFixed(0)} | ${r.signalsHit.join(", ") || "—"} |`,
      );
    }
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
  for (const r of rows.filter((r) => !r.judge.passed)) {
    lines.push(`### ${r.taskId} — ${r.armLabel}`);
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

function computeArmDiff(rows: EvalRow[]): {
  pimSaves: Array<{ taskId: string; controlFailure: string }>;
  pimRegressions: Array<{ taskId: string; pimFailure: string }>;
} {
  const pimSaves: Array<{ taskId: string; controlFailure: string }> = [];
  const pimRegressions: Array<{ taskId: string; pimFailure: string }> = [];
  const taskIds = distinct(rows.map((r) => r.taskId));
  for (const id of taskIds) {
    const control = rows.find((r) => r.taskId === id && r.arm === "control");
    const pim = rows.find((r) => r.taskId === id && r.arm === "pim-full");
    if (!control || !pim) continue;
    if (pim.judge.passed && !control.judge.passed) {
      pimSaves.push({ taskId: id, controlFailure: control.judge.detail });
    }
    if (!pim.judge.passed && control.judge.passed) {
      pimRegressions.push({ taskId: id, pimFailure: pim.judge.detail });
    }
  }
  return { pimSaves, pimRegressions };
}

export function rowCost(model: string, usage: RunUsage): number {
  return costFor(model, usage);
}
