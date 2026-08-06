import { describe, expect, it } from "vitest";
import { aggregateMetrics, evaluateRanking, percentile } from "./metrics.js";

describe("project-search evaluation metrics", () => {
  const urls = new Map([
    ["A", "https://eval.invalid/a"],
    ["B", "https://eval.invalid/b"],
    ["C", "https://eval.invalid/c"],
  ]);

  it("computes graded ranking metrics and validates every returned citation", () => {
    const metrics = evaluateRanking(
      [
        { source_id: "A", url: "https://wrong.invalid/a" },
        { source_id: "C", url: "https://eval.invalid/c" },
        { source_id: "B", url: "https://eval.invalid/b" },
      ],
      [
        { source_id: "A", relevance: 3 },
        { source_id: "B", relevance: 1 },
      ],
      urls,
    );

    expect(metrics.recall_at_10).toBe(1);
    expect(metrics.mrr_at_10).toBe(1);
    expect(metrics.ndcg_at_10).toBeCloseTo((7 + 1 / 2) / (7 + 1 / Math.log2(3)), 8);
    expect(metrics.citation_correctness_at_10).toBeCloseTo(1 / 2, 8);
  });

  it("honors the cutoff and collapses duplicate judgments to the highest grade", () => {
    const ranked = [
      { source_id: "C", url: "https://eval.invalid/c" },
      { source_id: "A", url: "https://eval.invalid/a" },
      { source_id: "B", url: "https://eval.invalid/b" },
    ];
    const metrics = evaluateRanking(
      ranked,
      [
        { source_id: "A", relevance: 1 },
        { source_id: "A", relevance: 3 },
        { source_id: "B", relevance: 2 },
      ],
      urls,
      2,
    );

    expect(metrics.recall_at_10).toBe(0.5);
    expect(metrics.mrr_at_10).toBe(0.5);
    expect(metrics.ndcg_at_10).toBeCloseTo((7 / Math.log2(3)) / (7 + 3 / Math.log2(3)), 8);
    expect(metrics.citation_correctness_at_10).toBe(1);
  });

  it("uses explicit empty-set semantics", () => {
    expect(evaluateRanking([], [], urls)).toEqual({
      recall_at_10: 1,
      ndcg_at_10: 1,
      mrr_at_10: 0,
      citation_correctness_at_10: 1,
    });
    expect(evaluateRanking([], [{ source_id: "A", relevance: 3 }], urls).citation_correctness_at_10).toBe(0);
  });

  it("macro-averages queries and computes nearest-rank latency percentiles", () => {
    const aggregate = aggregateMetrics([
      { recall_at_10: 1, ndcg_at_10: 0.8, mrr_at_10: 1, citation_correctness_at_10: 1 },
      { recall_at_10: 0, ndcg_at_10: 0.2, mrr_at_10: 0.5, citation_correctness_at_10: 0.5 },
    ]);
    expect(aggregate).toEqual({
      query_count: 2,
      recall_at_10: 0.5,
      ndcg_at_10: 0.5,
      mrr_at_10: 0.75,
      citation_correctness_at_10: 0.75,
    });
    expect(percentile([40, 10, 30, 20], 0.5)).toBe(20);
    expect(percentile([40, 10, 30, 20], 0.95)).toBe(40);
    expect(percentile([], 0.95)).toBe(0);
  });
});
