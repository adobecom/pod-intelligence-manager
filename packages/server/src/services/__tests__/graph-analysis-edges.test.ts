import { describe, it, expect } from "vitest";
import { buildEdges } from "../graph-analysis.js";
import type { KnowledgeNode } from "@pim/shared";

function node(overrides: Partial<KnowledgeNode> & { id: string; summary: string }): KnowledgeNode {
  return {
    id: overrides.id,
    type: overrides.type ?? "pattern",
    summary: overrides.summary,
    details: overrides.details ?? overrides.summary,
    source_pod_id: overrides.source_pod_id ?? "pod-test",
    source_pod_name: overrides.source_pod_name ?? "Test Pod",
    domains: overrides.domains ?? ["backend"],
    confidence: overrides.confidence ?? "extracted",
    confidence_score: overrides.confidence_score ?? 0.9,
    created_at: overrides.created_at ?? new Date().toISOString(),
    curated: overrides.curated ?? false,
    embedding: overrides.embedding,
  };
}

describe("buildEdges — domain-only nodes must not get an edge", () => {
  it("two ['backend'] nodes with no textual overlap produce no edge (regression for Item 2)", () => {
    const a = node({ id: "a", summary: "Adopted React Server Components for ranking page" });
    const b = node({ id: "b", summary: "Migrated from MongoDB to Postgres for billing" });
    // Both share domain ["backend"] but no keyword overlap and no embeddings.
    const edges = buildEdges([a], [b]);
    expect(edges).toHaveLength(0);
  });

  it("nodes with strong keyword overlap (and shared domain) do produce an edge", () => {
    const a = node({ id: "a", summary: "Migrated from MongoDB to Postgres" });
    const b = node({ id: "b", summary: "Migrated from MongoDB to Postgres for billing" });
    const edges = buildEdges([a], [b]);
    expect(edges).toHaveLength(1);
    expect(edges[0].weight).toBeGreaterThanOrEqual(0.35);
  });

  it("disjoint domains, disjoint keywords: no edge", () => {
    const a = node({ id: "a", summary: "Cache strategy", domains: ["backend"] });
    const b = node({ id: "b", summary: "Color tokens", domains: ["design"] });
    const edges = buildEdges([a], [b]);
    expect(edges).toHaveLength(0);
  });
});

describe("buildEdges — embedding-driven scoring", () => {
  it("high cosine similarity passes threshold even with disjoint domains", () => {
    // Manufactured embeddings: identical → cosine 1.0
    const emb = [1, 0, 0];
    const a = node({ id: "a", summary: "Foo", domains: ["backend"], embedding: emb });
    const b = node({ id: "b", summary: "Bar", domains: ["frontend"], embedding: emb });
    const edges = buildEdges([a], [b]);
    expect(edges).toHaveLength(1);
  });

  it("near-zero cosine + strong domain overlap is BELOW the hard floor — no edge", () => {
    // Orthogonal embeddings → cosine 0
    const a = node({ id: "a", summary: "Foo", domains: ["backend"], embedding: [1, 0, 0] });
    const b = node({ id: "b", summary: "Bar", domains: ["backend"], embedding: [0, 1, 0] });
    const edges = buildEdges([a], [b]);
    expect(edges).toHaveLength(0);
  });
});

describe("buildEdges — high-impact inferred edge types", () => {
  it("preserves inferred contradicts edges instead of downgrading to relates_to", () => {
    const emb = [1, 0, 0];
    const pattern = node({ id: "pattern", type: "pattern", summary: "Use token refresh retry", embedding: emb });
    const antiPattern = node({ id: "anti", type: "anti_pattern", summary: "Use token refresh retry", embedding: emb });

    const edges = buildEdges([antiPattern], [pattern]);

    expect(edges).toHaveLength(1);
    expect(edges[0].type).toBe("contradicts");
    expect(edges[0].inferred).toBe(true);
  });

  it("preserves inferred resolved_by edges instead of downgrading to relates_to", () => {
    const emb = [1, 0, 0];
    const pattern = node({ id: "pattern", type: "pattern", summary: "Auth retry limit", embedding: emb });
    const conflict = node({ id: "conflict", type: "resolved_conflict", summary: "Auth retry limit", embedding: emb });

    const edges = buildEdges([conflict], [pattern]);

    expect(edges).toHaveLength(1);
    expect(edges[0].type).toBe("resolved_by");
    expect(edges[0].inferred).toBe(true);
  });
});

describe("buildEdges — incremental maintenance (no quadratic rebuild)", () => {
  // Why this test exists: archival ingestion calls buildEdges(newNodes, existingNodes).
  // If a future refactor passes the full graph for both args, the cost regresses from
  // newNodes × existingNodes to existingNodes² — at 5k nodes that is 25M comparisons
  // per archival on the main event loop. Lock the contract in.
  it("only compares newNodes against existingNodes (not existingNodes against itself)", () => {
    const matchingEmb = [1, 0, 0];
    const existing = [
      node({ id: "old-1", summary: "Old pattern one", embedding: matchingEmb }),
      node({ id: "old-2", summary: "Old pattern two", embedding: matchingEmb }),
      node({ id: "old-3", summary: "Old pattern three", embedding: matchingEmb }),
    ];
    const incoming = [node({ id: "new-1", summary: "New pattern arrival", embedding: matchingEmb })];

    const edges = buildEdges(incoming, existing);

    // 1 new × 3 existing = up to 3 edges. A quadratic rebuild would also emit
    // edges between old-1↔old-2, old-1↔old-3, old-2↔old-3 (3 more), so a max of 3
    // proves the function did not re-pair the existing set.
    expect(edges.length).toBeLessThanOrEqual(3);
    for (const edge of edges) {
      expect(edge.source).toBe("new-1");
      const targetIsExisting = ["old-1", "old-2", "old-3"].includes(edge.target);
      expect(targetIsExisting).toBe(true);
    }
  });

  it("respects existingEdges to avoid duplicating edges across batches", () => {
    const emb = [1, 0, 0];
    const a = node({ id: "a", summary: "Shared pattern", embedding: emb });
    const b = node({ id: "b", summary: "Shared pattern", embedding: emb });

    const firstBatch = buildEdges([a], [b]);
    expect(firstBatch).toHaveLength(1);

    // Second call with the same pair plus the prior edge: must not re-emit.
    const secondBatch = buildEdges([a], [b], firstBatch);
    expect(secondBatch).toHaveLength(0);

    // Reverse-direction guard: edge (b → a) already covers (a → b).
    const reverseEdge = [{ source: "b", target: "a", type: "relates_to" as const, weight: 0.9 }];
    const reverseBatch = buildEdges([a], [b], reverseEdge);
    expect(reverseBatch).toHaveLength(0);
  });
});
