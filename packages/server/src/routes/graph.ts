/**
 * Knowledge Graph API Routes
 *
 * Query endpoints designed for minimal context window consumption.
 * Agents use POST /api/knowledge/query with token budgets.
 * UI uses GET /api/knowledge/graph for full visualization.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { KnowledgeQueryOptions, CurationRequest } from "@pim/shared";
import {
  getGraph,
  queryKnowledge,
  getRelevantLearnings,
  getPrecedents,
  curateNode,
  getStats,
} from "../services/knowledge-graph.js";
import { validateBody } from "../middleware/validation.js";

const KnowledgeQuerySchema = z.object({
  filters: z.object({
    domains: z.array(z.string()).optional(),
    types: z.array(z.enum(["decision", "pattern", "anti_pattern", "resolved_conflict", "scope_insight"])).optional(),
    source_pod_ids: z.array(z.string()).optional(),
    source_project_ids: z.array(z.string()).optional(),
    include_project_id: z.string().optional(),
    confidence_min: z.number().min(0).max(1).optional(),
    curated_only: z.boolean().optional(),
    text_search: z.string().optional(),
    keywords: z.array(z.string()).optional(),
  }),
  max_tokens: z.number().int().positive().optional(),
  include_details: z.boolean().optional(),
  include_edges: z.boolean().optional(),
  limit: z.number().int().positive().optional(),
});

const CurationSchema = z.object({
  action: z.enum(["approve", "reject", "edit"]),
  edits: z.object({
    summary: z.string().optional(),
    details: z.string().optional(),
    domains: z.array(z.string()).optional(),
  }).optional(),
});

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
  app.post<{ Body: KnowledgeQueryOptions }>("/api/knowledge/query", { preHandler: validateBody(KnowledgeQuerySchema) }, async (req) => {
    return queryKnowledge(req.body);
  });

  // Convenience: relevant learnings for given scopes.
  // `projectId` scopes results to org-wide + nodes tagged with that project (no cross-project bleed).
  // `query` is free-text used to generate a semantic embedding; without it, scoring falls back to keyword+domain only.
  app.get<{ Querystring: { scopes?: string; maxTokens?: string; projectId?: string; query?: string } }>(
    "/api/knowledge/relevant",
    async (req) => {
      const scopes = req.query.scopes?.split(",").filter(Boolean) ?? [];
      const maxTokens = parseInt(req.query.maxTokens ?? "2000", 10);
      const projectId = req.query.projectId?.trim() || null;
      const queryText = req.query.query?.trim();
      const conflictSummaries = queryText ? [queryText] : [];
      return getRelevantLearnings(scopes, conflictSummaries, maxTokens, projectId);
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
    { preHandler: validateBody(CurationSchema) },
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
