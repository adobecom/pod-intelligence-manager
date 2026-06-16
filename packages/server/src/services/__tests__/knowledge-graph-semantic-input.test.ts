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
});
