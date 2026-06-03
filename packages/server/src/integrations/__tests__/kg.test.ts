import { describe, it, expect, beforeEach, vi } from "vitest";
import type { IntegrationSearchOpts } from "../types.js";

vi.mock("../../services/knowledge-graph.js", () => ({
  queryKnowledge: vi.fn(() => ({
    nodes: [],
    edges: [],
    total_matching: 0,
    token_estimate: 0,
    truncated: false,
  })),
}));

vi.mock("../../services/embeddings.js", () => ({
  generateEmbedding: vi.fn(async () => [1, 0, 0]),
  isEmbeddingAvailable: vi.fn(() => true),
}));

import { searchKG } from "../kg.js";
import { queryKnowledge } from "../../services/knowledge-graph.js";
import { generateEmbedding } from "../../services/embeddings.js";

function baseOpts(overrides: Partial<IntegrationSearchOpts> = {}): IntegrationSearchOpts {
  return {
    query: "Why did AuthAPI change in MWPW-123?",
    time_window_days: 90,
    max_hits_per_source: 8,
    org_id: "org-kg-test",
    ...overrides,
  };
}

describe("searchKG query variants", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("embeds the original query once and caps KG variant fan-out", async () => {
    await searchKG(baseOpts({ project_name: "Acme Project", query_mode: "history" }));

    expect(generateEmbedding).toHaveBeenCalledTimes(1);
    expect(generateEmbedding).toHaveBeenCalledWith("Why did AuthAPI change in MWPW-123?");
    expect(queryKnowledge).toHaveBeenCalledTimes(2);
    expect(vi.mocked(queryKnowledge).mock.calls.map(([, opts]) => opts.query_text)).toEqual([
      "Why did AuthAPI change in MWPW-123?",
      "Why did AuthAPI change in MWPW-123? artifact source API contract component",
    ]);
  });
});
