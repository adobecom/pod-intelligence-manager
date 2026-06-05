/**
 * Paired bootstrap for per-task pass-rate deltas.
 *
 * Each task has two paired pass rates (one per arm, averaged over seeds).
 * We resample tasks with replacement B times, compute the mean delta per
 * resample, and return the 95% percentile CI of that distribution.
 *
 * Resampling at the task level (not seed level) preserves seed-level variance
 * inside each task's pass-rate estimate. This matches the protocol's stated
 * unit of analysis (the task).
 */

export interface BootstrapResult {
  mean: number;
  /** Lower bound of the 95% percentile CI. */
  ciLow: number;
  /** Upper bound of the 95% percentile CI. */
  ciHigh: number;
  /** Empirical one-sided p-value for the null hypothesis delta == 0
   * (fraction of resamples with sign opposite to the mean). */
  pOneSided: number;
  /** Two-sided p-value (2 * min(pOneSided, 1 - pOneSided), clipped to [0,1]). */
  pTwoSided: number;
  /** Bootstrap iterations (B). */
  iterations: number;
  /** Per-task paired deltas used as input. */
  deltas: number[];
}

/** Deterministic mulberry32 PRNG (small, fast, repeatable). */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 0x100000000;
  };
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const idx = q * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

/** Bootstrap the mean of a paired-delta array. B defaults to 10,000. */
export function bootstrapPairedDelta(
  deltas: number[],
  B = 10_000,
  rngSeed = 0xc0ffee,
): BootstrapResult {
  const n = deltas.length;
  if (n === 0) {
    return { mean: 0, ciLow: 0, ciHigh: 0, pOneSided: 0.5, pTwoSided: 1, iterations: 0, deltas };
  }
  const mean = deltas.reduce((a, b) => a + b, 0) / n;
  const rng = mulberry32(rngSeed);
  const samples = new Array<number>(B);
  for (let i = 0; i < B; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) {
      const idx = Math.floor(rng() * n);
      sum += deltas[idx];
    }
    samples[i] = sum / n;
  }
  samples.sort((a, b) => a - b);
  const ciLow = percentile(samples, 0.025);
  const ciHigh = percentile(samples, 0.975);
  // One-sided: fraction of resamples on the "null" side of the mean.
  const negCount = samples.filter((s) => s <= 0).length;
  const posCount = B - negCount;
  const pOneSided = mean >= 0 ? negCount / B : posCount / B;
  const pTwoSided = Math.min(1, 2 * pOneSided);
  return { mean, ciLow, ciHigh, pOneSided, pTwoSided, iterations: B, deltas };
}

/**
 * Convenience: compute the paired-delta array from two arms' per-task pass-rate maps.
 * Tasks present in only one arm are skipped. Returns the delta array (arm A - arm B)
 * and the list of task IDs used in pair-order.
 */
export function pairedDeltas(
  taskPassA: Map<string, number>,
  taskPassB: Map<string, number>,
): { deltas: number[]; pairedTaskIds: string[] } {
  const pairedTaskIds: string[] = [];
  const deltas: number[] = [];
  for (const [taskId, passA] of taskPassA) {
    const passB = taskPassB.get(taskId);
    if (passB === undefined) continue;
    pairedTaskIds.push(taskId);
    deltas.push(passA - passB);
  }
  return { deltas, pairedTaskIds };
}
