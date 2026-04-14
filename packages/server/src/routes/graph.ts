/**
 * Knowledge Graph API Routes
 *
 * Query endpoints designed for minimal context window consumption.
 * Agents use POST /api/knowledge/query with token budgets.
 * UI uses GET /api/knowledge/graph for full visualization.
 */

import type { FastifyInstance } from "fastify";
import type { KnowledgeQueryOptions, CurationRequest } from "@council/shared";
import {
  getGraph,
  queryKnowledge,
  getRelevantLearnings,
  getPrecedents,
  curateNode,
  getStats,
} from "../services/knowledge-graph.js";

export default async function graphRoutes(app: FastifyInstance) {
  // Full graph (for UI visualization)
  app.get("/api/knowledge/graph", async () => {
    return getGraph();
  });

  // Stats summary
  app.get("/api/knowledge/stats", async () => {
    return getStats();
  });

  // Token-budgeted query (main agent-facing interface)
  app.post<{ Body: KnowledgeQueryOptions }>("/api/knowledge/query", async (req) => {
    return queryKnowledge(req.body);
  });

  // Convenience: relevant learnings for given scopes
  app.get<{ Querystring: { scopes?: string; maxTokens?: string } }>(
    "/api/knowledge/relevant",
    async (req) => {
      const scopes = req.query.scopes?.split(",").filter(Boolean) ?? [];
      const maxTokens = parseInt(req.query.maxTokens ?? "2000", 10);
      return getRelevantLearnings(scopes, [], maxTokens);
    },
  );

  // Convenience: precedent lookup for conflicts
  app.get<{ Querystring: { conflict?: string; maxTokens?: string } }>(
    "/api/knowledge/precedents",
    async (req) => {
      const conflict = req.query.conflict ?? "";
      const maxTokens = parseInt(req.query.maxTokens ?? "1000", 10);
      return getPrecedents(conflict, maxTokens);
    },
  );

  // Node curation (human approval/rejection/editing)
  app.post<{ Params: { nodeId: string }; Body: CurationRequest }>(
    "/api/knowledge/nodes/:nodeId/curate",
    async (req, reply) => {
      const { nodeId } = req.params;
      const { action, edits } = req.body;
      const success = curateNode(nodeId, action, edits);
      if (!success) {
        reply.code(404);
        return { error: "Node not found" };
      }
      return { ok: true };
    },
  );
}
