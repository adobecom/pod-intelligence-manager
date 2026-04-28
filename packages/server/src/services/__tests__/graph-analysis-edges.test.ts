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
