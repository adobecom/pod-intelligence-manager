/**
 * Benjamini-Hochberg FDR correction for multiple comparisons.
 *
 * Use for the protocol pairwise arm comparisons. Default q = 0.05.
 *
 * Algorithm:
 *   1. Sort p-values ascending.
 *   2. Find the largest k such that p_(k) <= (k / m) * q.
 *   3. Reject all hypotheses with p_(i) for i <= k.
 *   4. Adjusted p-value for the i-th sorted entry is min over j >= i of m*p_(j)/j.
 */

export interface BHEntry {
  /** Caller-supplied identifier (e.g., "pim-full vs lic-full"). */
  id: string;
  /** Raw p-value (two-sided). */
  p: number;
}

export interface BHResult extends BHEntry {
  /** BH-adjusted q-value (also clipped to [0, 1]). */
  adjusted: number;
  /** True if this comparison is rejected at the q threshold. */
  rejected: boolean;
}

export function benjaminiHochberg(entries: BHEntry[], q = 0.05): BHResult[] {
  const m = entries.length;
  if (m === 0) return [];
  const sorted = [...entries]
    .map((e, originalIndex) => ({ ...e, originalIndex }))
    .sort((a, b) => a.p - b.p);

  // Compute adjusted p-values (BH-adjusted q-values): minimum from i to m of (m/i)*p.
  const adjustedSorted = new Array<number>(m);
  let minSoFar = Number.POSITIVE_INFINITY;
  for (let i = m - 1; i >= 0; i--) {
    const rank = i + 1; // 1-indexed
    const candidate = (m / rank) * sorted[i].p;
    minSoFar = Math.min(minSoFar, candidate);
    adjustedSorted[i] = Math.min(1, minSoFar);
  }

  // Find largest k where p_(k) <= (k/m) * q.
  let kStar = -1;
  for (let i = 0; i < m; i++) {
    const rank = i + 1;
    if (sorted[i].p <= (rank / m) * q) kStar = i;
  }

  const sortedResults = sorted.map((e, i) => ({
    id: e.id,
    p: e.p,
    adjusted: adjustedSorted[i],
    rejected: i <= kStar,
  }));

  // Restore original order.
  const result: BHResult[] = new Array(m);
  for (let i = 0; i < m; i++) {
    const e = sortedResults[i];
    result[sorted[i].originalIndex] = e;
  }
  return result;
}
