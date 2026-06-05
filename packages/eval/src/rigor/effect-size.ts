/**
 * Cohen's d for paired per-task pass-rate differences.
 *
 * For paired data, d_z = mean(delta) / sd(delta). This is sometimes called
 * "Cohen's d_z" — the effect size for the standardized mean of the paired
 * differences. We use the n - 1 denominator (sample sd).
 *
 * Interpretation thresholds (Cohen 1988):
 *   |d| < 0.2  negligible
 *   0.2-0.5    small
 *   0.5-0.8    medium
 *   > 0.8      large
 */

export type EffectSizeBucket = "negligible" | "small" | "medium" | "large";

export function cohensDz(deltas: number[]): number {
  const n = deltas.length;
  if (n < 2) return 0;
  const mean = deltas.reduce((a, b) => a + b, 0) / n;
  const ss = deltas.reduce((acc, x) => acc + (x - mean) * (x - mean), 0);
  const sd = Math.sqrt(ss / (n - 1));
  if (sd === 0) return mean === 0 ? 0 : Number.POSITIVE_INFINITY * Math.sign(mean);
  return mean / sd;
}

export function effectSizeBucket(d: number): EffectSizeBucket {
  const a = Math.abs(d);
  if (a < 0.2) return "negligible";
  if (a < 0.5) return "small";
  if (a < 0.8) return "medium";
  return "large";
}
