import type { EvalRow } from "../report.js";
import { bootstrapPairedDelta, pairedDeltas, type BootstrapResult } from "./bootstrap.js";
import { cohensDz, effectSizeBucket, type EffectSizeBucket } from "./effect-size.js";
import { benjaminiHochberg, type BHResult } from "./multiple-comparison.js";

export interface PairwiseComparison {
  armA: string;
  armB: string;
  n: number;
  meanDeltaPp: number; // expressed in percentage points (passRate is 0..1)
  ciLowPp: number;
  ciHighPp: number;
  cohensD: number;
  effectBucket: EffectSizeBucket;
  pTwoSided: number;
  bhAdjusted?: number;
  rejected?: boolean;
  pairedTaskIds: string[];
}

function passRatePerTask(rows: EvalRow[], armId: string): Map<string, number> {
  const byTask = new Map<string, { sum: number; n: number }>();
  for (const r of rows) {
    if (r.arm !== armId) continue;
    const score = r.judge.passed ? 1 : 0;
    const entry = byTask.get(r.taskId) ?? { sum: 0, n: 0 };
    entry.sum += score;
    entry.n += 1;
    byTask.set(r.taskId, entry);
  }
  const result = new Map<string, number>();
  for (const [taskId, { sum, n }] of byTask) {
    if (n > 0) result.set(taskId, sum / n);
  }
  return result;
}

export function comparePair(rows: EvalRow[], armA: string, armB: string, B = 10_000): PairwiseComparison {
  const passA = passRatePerTask(rows, armA);
  const passB = passRatePerTask(rows, armB);
  const { deltas, pairedTaskIds } = pairedDeltas(passA, passB);
  const boot: BootstrapResult = bootstrapPairedDelta(deltas, B);
  const d = cohensDz(deltas);
  return {
    armA,
    armB,
    n: deltas.length,
    meanDeltaPp: boot.mean * 100,
    ciLowPp: boot.ciLow * 100,
    ciHighPp: boot.ciHigh * 100,
    cohensD: d,
    effectBucket: effectSizeBucket(d),
    pTwoSided: boot.pTwoSided,
    pairedTaskIds,
  };
}

/**
 * Compute all unordered arm pairs and apply BH-FDR adjustment.
 * Returns comparisons in the order pairs were generated.
 */
export function compareAllPairs(rows: EvalRow[], armIds: string[], B = 10_000, q = 0.05): PairwiseComparison[] {
  const comparisons: PairwiseComparison[] = [];
  for (let i = 0; i < armIds.length; i++) {
    for (let j = i + 1; j < armIds.length; j++) {
      comparisons.push(comparePair(rows, armIds[i], armIds[j], B));
    }
  }
  const bh: BHResult[] = benjaminiHochberg(
    comparisons.map((c) => ({ id: `${c.armA}|${c.armB}`, p: c.pTwoSided })),
    q,
  );
  return comparisons.map((c, i) => ({ ...c, bhAdjusted: bh[i].adjusted, rejected: bh[i].rejected }));
}

export type Verdict = "strong-support" | "directional" | "no-effect" | "harm";

export function verdictFor(c: PairwiseComparison, severeRegressionRate: number): Verdict {
  if (c.meanDeltaPp < -5 || severeRegressionRate > 0.1) return "harm";
  if (c.meanDeltaPp >= 5 && c.ciLowPp > 0 && Math.abs(c.cohensD) >= 0.5) return "strong-support";
  if (c.meanDeltaPp >= 5) return "directional";
  return "no-effect";
}

/**
 * Fraction of paired tasks where armA severely regresses versus armB.
 *
 * Scores are normalized to 0..1, so a severe score drop is >= 0.4. For
 * multi-seed runs, pass/fail is a per-task pass rate; a severe pass-rate
 * regression is armA < 0.5 while armB >= 0.5.
 */
export function severeRegressionRate(rows: EvalRow[], armA: string, armB: string): number {
  const byTaskA = new Map<string, EvalRow[]>();
  const byTaskB = new Map<string, EvalRow[]>();
  for (const r of rows) {
    if (r.arm === armA) {
      const e = byTaskA.get(r.taskId) ?? [];
      e.push(r);
      byTaskA.set(r.taskId, e);
    }
    if (r.arm === armB) {
      const e = byTaskB.get(r.taskId) ?? [];
      e.push(r);
      byTaskB.set(r.taskId, e);
    }
  }
  let paired = 0;
  let regressions = 0;
  for (const [taskId, ar] of byTaskA) {
    const br = byTaskB.get(taskId);
    if (!br) continue;
    paired += 1;
    const aPassRate = ar.filter((r) => r.judge.passed).length / ar.length;
    const bPassRate = br.filter((r) => r.judge.passed).length / br.length;
    const aScore = ar.reduce((acc, r) => acc + r.judge.score, 0) / ar.length;
    const bScore = br.reduce((acc, r) => acc + r.judge.score, 0) / br.length;
    if ((aPassRate < 0.5 && bPassRate >= 0.5) || bScore - aScore >= 0.4) regressions++;
  }
  return paired === 0 ? 0 : regressions / paired;
}
