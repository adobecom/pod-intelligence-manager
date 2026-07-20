import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../graph-storage.js", () => ({
  loadGraph: vi.fn(() => null),
  saveGraph: vi.fn(),
}));

vi.mock("../org-settings.js", async () => {
  const { DEFAULT_ORG_TUNING } = await import("@pim/shared");
  return {
    getOrgTuning: vi.fn(() => DEFAULT_ORG_TUNING),
    getKgContextContract: vi.fn(() => "legacy"),
  };
});

vi.mock("../embeddings.js", () => ({
  generateEmbedding: vi.fn(async () => null),
  embedText: (node: { summary: string; details?: string; retrieval_text?: string }) =>
    node.retrieval_text?.trim() || node.details?.trim() || node.summary,
  embeddingTextHash: (text: string) => `hash:${text}`,
  batchEmbedWithRateLimit: vi.fn(async () => undefined),
  cosineSimilarity: (a: number[], b: number[]) => {
    if (a.length !== b.length || a.length === 0) return 0;
    const dot = a.reduce((sum, value, index) => sum + value * b[index], 0);
    const normA = Math.sqrt(a.reduce((sum, value) => sum + value * value, 0));
    const normB = Math.sqrt(b.reduce((sum, value) => sum + value * value, 0));
    return normA && normB ? dot / (normA * normB) : 0;
  },
  isEmbeddingAvailable: vi.fn(() => true),
}));

import {
  _resetForTests,
  addLearningsToGraph,
  getGraph,
  initializeKnowledgeGraph,
  queryKnowledge,
  queryKnowledgeSemantic,
} from "../knowledge-graph.js";

async function seedBackendNode(orgId: string, summary = "Backend queue retry policy"): Promise<void> {
  initializeKnowledgeGraph(orgId);
  await addLearningsToGraph(
    orgId,
    [{
      type: "pattern",
      summary,
      details: "Retry queue jobs with capped exponential backoff and bounded worker concurrency.",
      domains: ["backend"],
      confidence: "extracted",
      confidence_score: 0.9,
    }],
    "pod-seed",
    "Seed Pod",
  );
}

describe("knowledge graph retrieval observability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
  });

  it("distinguishes a healthy scope-only query from degraded lexical fallback", async () => {
    const orgId = "kg-observe-scope";
    await seedBackendNode(orgId);

    const result = queryKnowledge(orgId, {
      filters: { scopes: ["backend"] },
      max_tokens: 2000,
    });

    expect(result.retrieval_diagnostics).toEqual({
      mode: "scope_only",
      degraded: false,
      semantic_query_requested: false,
      query_embedding_available: false,
      embedding_coverage: 0,
      candidate_count: 1,
      matched_count: 1,
      returned_count: 1,
    });
  });

  it("marks semantic-query fallback as lexical and degraded when the query embedding is unavailable", async () => {
    const orgId = "kg-observe-degraded";
    await seedBackendNode(orgId);

    const result = await queryKnowledgeSemantic(orgId, {
      filters: { scopes: ["backend"] },
      query_text: "queue retry backoff",
      max_tokens: 2000,
    });

    expect(result.retrieval_diagnostics).toMatchObject({
      mode: "lexical",
      degraded: true,
      semantic_query_requested: true,
      query_embedding_available: false,
      embedding_coverage: 0,
      candidate_count: 1,
      returned_count: 1,
      degradation_reasons: ["query_embedding_unavailable"],
    });
  });

  it("reports hybrid coverage and score evidence without changing the final score", async () => {
    const orgId = "kg-observe-hybrid";
    await seedBackendNode(orgId);
    getGraph(orgId).nodes[0].embedding = [1, 0];

    const result = queryKnowledge(orgId, {
      filters: { scopes: ["backend"] },
      query_text: "queue retry",
      query_embedding: [1, 0],
      max_tokens: 2000,
      expand_graph: false,
      include_explanations: true,
    });

    expect(result.retrieval_diagnostics).toMatchObject({
      mode: "hybrid",
      degraded: false,
      semantic_query_requested: true,
      query_embedding_available: true,
      embedding_coverage: 1,
      candidate_count: 1,
      matched_count: 1,
      returned_count: 1,
    });
    const explanation = result.explanations?.[0];
    expect(explanation).toMatchObject({
      node_id: result.nodes[0].id,
      semantic_score: 1,
      evidence: {
        keyword_hits: 2,
        non_generic_keyword_hits: 2,
        identifier_hits: 0,
        strong_identifier_hits: 0,
        generic_identifier_hits: 0,
        rare_keyword_hits: 2,
        lexical_recall_hits: 2,
        exact_short_keyword_match: true,
        direct_evidence: true,
        semantic_relevance: true,
      },
    });
    const components = explanation?.score_components;
    expect(components).toBeDefined();
    expect(components?.semantic_match).toBe(0.08);
    expect(components?.direct_evidence).toBe(0);
    const componentTotal =
      components!.base_relevance +
      components!.semantic_match +
      components!.identifier_match +
      components!.direct_evidence +
      components!.lexical_recall +
      components!.lexical_specificity +
      components!.source_authority +
      components!.retrieval_tier +
      (components!.graph_expansion ?? 0) +
      (components!.required_pin ?? 0);
    expect(explanation?.score).toBeCloseTo(componentTotal, 12);
  });

  it("explains the additive score used to pin an eval-required node", async () => {
    const orgId = "kg-observe-required-pin";
    await seedBackendNode(orgId);
    getGraph(orgId).nodes[0].embedding = [1, 0];

    const requiredId = getGraph(orgId).nodes[0].id;
    const result = queryKnowledge(orgId, {
      filters: { scopes: ["backend"] },
      query_text: "mobile animation storyboard",
      query_embedding: [0, 1],
      required_node_ids: [requiredId],
      include_explanations: true,
      expand_graph: false,
      max_tokens: 2000,
    });

    const explanation = result.explanations?.[0];
    const components = explanation?.score_components;
    expect(explanation?.score).toBe(10);
    expect(explanation?.evidence?.required_pin).toBe(true);
    expect(components?.required_pin).toBeGreaterThan(0);
    const componentTotal =
      components!.base_relevance +
      components!.semantic_match +
      components!.identifier_match +
      components!.direct_evidence +
      components!.lexical_recall +
      components!.lexical_specificity +
      components!.source_authority +
      components!.retrieval_tier +
      (components!.graph_expansion ?? 0) +
      (components!.required_pin ?? 0);
    expect(explanation?.score).toBeCloseTo(componentTotal, 12);
  });
});
