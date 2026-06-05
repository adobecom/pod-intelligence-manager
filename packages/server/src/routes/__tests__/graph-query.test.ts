import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

const serviceMocks = vi.hoisted(() => ({
  queryKnowledgeSemantic: vi.fn(),
  getContractedRelevantLearnings: vi.fn(),
}));

vi.mock("../../services/knowledge-graph.js", () => ({
  curateNode: vi.fn(),
  getGraph: vi.fn().mockReturnValue({ nodes: [], edges: [] }),
  getPrecedents: vi.fn(),
  getContractedRelevantLearnings: serviceMocks.getContractedRelevantLearnings,
  getStats: vi.fn().mockReturnValue({ total_nodes: 0, by_type: {}, by_confidence: {}, by_domain: {} }),
  queryKnowledgeSemantic: serviceMocks.queryKnowledgeSemantic,
  stripEmbeddingsFromGraph: vi.fn((graph) => graph),
}));

vi.mock("../../services/ingestion-gateway.js", () => ({
  ingestLearnings: vi.fn(),
}));

import graphRoutes from "../graph.js";
import { registerJsonBodyParser } from "../../middleware/validation.js";
import { ingestLearnings } from "../../services/ingestion-gateway.js";

let app: FastifyInstance;

function emptyQueryResult() {
  return {
    nodes: [],
    edges: [],
    total_matching: 0,
    token_estimate: 0,
    truncated: false,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  serviceMocks.queryKnowledgeSemantic.mockResolvedValue(emptyQueryResult());
  serviceMocks.getContractedRelevantLearnings.mockResolvedValue(emptyQueryResult());
  vi.mocked(ingestLearnings).mockResolvedValue({
    prepared: [],
    droppedCount: 0,
    nodesAdded: 1,
    edgesAdded: 0,
    nodeIds: ["kn-ad-hoc"],
  } as any);

  app = Fastify();
  registerJsonBodyParser(app);
  app.addHook("onRequest", async (req: FastifyRequest) => {
    (req as any).org = { org_id: "org-route-test" };
  });
  app.register(graphRoutes);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe("knowledge graph public query routes", () => {
  it("strips eval-only required_node_ids from POST /api/knowledge/query", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/knowledge/query",
      payload: {
        filters: {},
        max_tokens: 500,
        required_node_ids: ["kn-eval-only"],
      },
    });

    expect(res.statusCode).toBe(200);
    const [, options] = serviceMocks.queryKnowledgeSemantic.mock.calls[0];
    expect("required_node_ids" in options).toBe(false);
    expect(options).toEqual({
      filters: {},
      max_tokens: 500,
    });
  });

  it("does not forward requiredNodeIds from GET /api/knowledge/relevant", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/knowledge/relevant?scopes=backend&maxTokens=500&requiredNodeIds=kn-eval-only",
    });

    expect(res.statusCode).toBe(200);
    const [, options] = serviceMocks.getContractedRelevantLearnings.mock.calls[0];
    expect("requiredNodeIds" in options).toBe(false);
    expect(options).toEqual({
      scopes: ["backend"],
      maxTokens: 500,
      projectId: null,
    });
  });

  it("forwards ad-hoc scopes to ingestion", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/knowledge/nodes",
      payload: {
        type: "pattern",
        summary: "Ad hoc scoped learning",
        details: "This ad hoc learning is long enough to satisfy validation.",
        domains: ["legacy-domain"],
        scopes: ["backend", "api"],
      },
    });

    expect(res.statusCode).toBe(200);
    const [, learnings] = vi.mocked(ingestLearnings).mock.calls[0];
    expect(learnings[0]).toMatchObject({
      domains: ["legacy-domain"],
      scopes: ["backend", "api"],
    });
  });
});
