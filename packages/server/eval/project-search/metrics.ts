export interface RelevanceJudgment {
  source_id: string;
  relevance: number;
}

export interface RankedCitation {
  source_id: string;
  url?: string;
}

export interface RankingMetrics {
  recall_at_10: number;
  ndcg_at_10: number;
  mrr_at_10: number;
  citation_correctness_at_10: number;
}

export interface AggregateMetrics extends RankingMetrics {
  query_count: number;
}

function finiteRelevance(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function dcg(relevances: number[]): number {
  return relevances.reduce((total, relevance, index) => {
    const gain = 2 ** finiteRelevance(relevance) - 1;
    return total + gain / Math.log2(index + 2);
  }, 0);
}

/**
 * Scores one ranked list. Relevance is graded (>0 is relevant); duplicate qrels
 * for a source are collapsed to their highest grade. Citation correctness is
 * evaluated only for retrieved relevant evidence: each such hit must point
 * back to the exact URL in the frozen corpus. A query that has relevant qrels
 * but retrieves none receives 0.0; an intentionally judgment-free query would
 * be vacuously correct.
 */
export function evaluateRanking(
  ranked: RankedCitation[],
  judgments: RelevanceJudgment[],
  expectedUrls: ReadonlyMap<string, string>,
  k = 10,
): RankingMetrics {
  if (!Number.isInteger(k) || k <= 0) throw new Error(`k must be a positive integer; received ${k}`);

  const grades = new Map<string, number>();
  for (const judgment of judgments) {
    const relevance = finiteRelevance(judgment.relevance);
    grades.set(judgment.source_id, Math.max(grades.get(judgment.source_id) ?? 0, relevance));
  }

  const relevant = new Set([...grades].filter(([, grade]) => grade > 0).map(([sourceId]) => sourceId));
  const top = ranked.slice(0, k);
  const retrievedRelevant = new Set(top.filter((hit) => relevant.has(hit.source_id)).map((hit) => hit.source_id));
  const recall = relevant.size === 0 ? 1 : retrievedRelevant.size / relevant.size;

  const firstRelevant = top.findIndex((hit) => relevant.has(hit.source_id));
  const mrr = firstRelevant === -1 ? 0 : 1 / (firstRelevant + 1);

  const observed = top.map((hit) => grades.get(hit.source_id) ?? 0);
  const ideal = [...grades.values()].sort((a, b) => b - a).slice(0, k);
  const idealDcg = dcg(ideal);
  const ndcg = idealDcg === 0 ? 1 : dcg(observed) / idealDcg;

  const retrievedRelevantHits = top.filter((hit) => relevant.has(hit.source_id));
  const correctCitations = retrievedRelevantHits.filter((hit) => {
    const expected = expectedUrls.get(hit.source_id);
    return expected !== undefined && hit.url === expected;
  }).length;
  const citationCorrectness = retrievedRelevantHits.length === 0
    ? relevant.size === 0 ? 1 : 0
    : correctCitations / retrievedRelevantHits.length;

  return {
    recall_at_10: recall,
    ndcg_at_10: ndcg,
    mrr_at_10: mrr,
    citation_correctness_at_10: citationCorrectness,
  };
}

export function aggregateMetrics(rows: RankingMetrics[]): AggregateMetrics {
  const queryCount = rows.length;
  const average = (key: keyof RankingMetrics): number =>
    queryCount === 0 ? 0 : rows.reduce((total, row) => total + row[key], 0) / queryCount;

  return {
    query_count: queryCount,
    recall_at_10: average("recall_at_10"),
    ndcg_at_10: average("ndcg_at_10"),
    mrr_at_10: average("mrr_at_10"),
    citation_correctness_at_10: average("citation_correctness_at_10"),
  };
}

/** Nearest-rank percentile, suitable for the small fixed evaluation set. */
export function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  if (!Number.isFinite(quantile) || quantile < 0 || quantile > 1) {
    throw new Error(`quantile must be between 0 and 1; received ${quantile}`);
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(0, Math.ceil(quantile * sorted.length) - 1);
  return sorted[rank];
}
