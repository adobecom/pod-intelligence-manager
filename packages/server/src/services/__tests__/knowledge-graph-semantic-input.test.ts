import { describe, it, expect, vi, beforeEach } from "vitest";

const embeddingMock = vi.hoisted(() => ({
  generateEmbedding: vi.fn(async () => null),
}));

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
  generateEmbedding: embeddingMock.generateEmbedding,
  embedText: (node: { summary: string; details?: string; retrieval_text?: string }) =>
    node.retrieval_text?.trim() || node.details?.trim() || node.summary,
  embeddingTextHash: (text: string) => `hash:${text}`,
  batchEmbedWithRateLimit: vi.fn(async () => undefined),
  cosineSimilarity: vi.fn(() => 0),
  isEmbeddingAvailable: vi.fn(() => true),
}));

import {
  addLearningsToGraph,
  getRelevantLearningsForContractMode,
  initializeKnowledgeGraph,
  queryKnowledgeSemantic,
  _resetForTests,
} from "../knowledge-graph.js";

describe("queryKnowledgeSemantic input handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
  });

  it("trims query text before generating an embedding", async () => {
    const orgId = "kg-semantic-trim";
    initializeKnowledgeGraph(orgId);

    await queryKnowledgeSemantic(orgId, {
      filters: {},
      query_text: "  webhook authentication  ",
      max_tokens: 100,
    });

    expect(embeddingMock.generateEmbedding).toHaveBeenCalledWith("webhook authentication");
  });

  it("keeps scoped task context when strict task relevance has no query embedding", async () => {
    const orgId = "kg-semantic-outage";
    initializeKnowledgeGraph(orgId);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await addLearningsToGraph(
        orgId,
        [
          {
            type: "pattern",
            summary: "Backend queue retry policy",
            details: "Retry jobs with capped exponential backoff.",
            domains: ["backend"],
            confidence: "extracted",
            confidence_score: 0.9,
          },
          {
            type: "pattern",
            summary: "Backend worker concurrency limit",
            details: "Keep worker pools bounded by deployment capacity.",
            domains: ["backend"],
            confidence: "extracted",
            confidence_score: 0.9,
          },
        ],
        "pod-seed",
        "Seed Pod",
      );
      embeddingMock.generateEmbedding.mockClear();

      const result = await getRelevantLearningsForContractMode(orgId, "task_relevant", {
        scopes: ["backend"],
        taskQuery: "mobile sign-in regression",
        maxTokens: 2000,
      });

      expect(embeddingMock.generateEmbedding).toHaveBeenCalledWith("mobile sign-in regression");
      expect(result.context_contract?.returned_mode).toBe("task_relevant");
      expect(result.context_contract?.task_query_used).toBe(true);
      expect(result.nodes.map((node) => node.summary).sort()).toEqual([
        "Backend queue retry policy",
        "Backend worker concurrency limit",
      ]);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
