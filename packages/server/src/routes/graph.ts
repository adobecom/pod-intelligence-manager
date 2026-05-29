/**
 * Knowledge Graph API Routes
 *
 * Query endpoints designed for minimal context window consumption.
 * Agents use POST /api/knowledge/query with token budgets.
 * UI uses GET /api/knowledge/graph for full visualization.
 *
 * Every handler partitions by req.org.org_id (resolved by the org-context
 * middleware) so org A can never read or write org B's graph.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type {
  AdHocLearningInput,
  ConfidenceLevel,
  CurationRequest,
  EnhancedPodLearning,
  KnowledgeQueryOptions,
} from "@pim/shared";
import {
  addLearningsToGraph,
  curateNode,
  getGraph,
  getPrecedents,
  getRelevantLearnings,
  getStats,
  queryKnowledge,
  stripEmbeddingsFromGraph,
} from "../services/knowledge-graph.js";
import { validateBody } from "../middleware/validation.js";
import { generateEmbedding } from "../services/embeddings.js";

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
  query_embedding: z.array(z.number()).nullable().optional(),
  query_text: z.string().min(1).optional(),
  include_embeddings: z.boolean().optional(),
});

const CurationSchema = z.object({
  action: z.enum(["approve", "reject", "edit"]),
  edits: z.object({
    summary: z.string().optional(),
    details: z.string().optional(),
    domains: z.array(z.string()).optional(),
  }).optional(),
});

const AdHocLearningSchema = z.object({
  type: z.enum(["decision", "pattern", "anti_pattern", "resolved_conflict", "scope_insight"]),
  summary: z.string().min(10).max(500),
  details: z.string().min(30),
  domains: z.array(z.string().min(1)).min(1),
  source_label: z.string().min(1).max(120).optional(),
  confidence_score: z.number().min(0).max(1).optional(),
});

const AD_HOC_POD_ID = "adhoc";
const AD_HOC_DEFAULT_LABEL = "Ad-Hoc Submission";
const AD_HOC_DEFAULT_CONFIDENCE = 0.7;

export default async function graphRoutes(app: FastifyInstance) {
  // Full graph (for UI visualization).
  //
  // Embeddings (~2 KB per node) are omitted by default. The UI never reads them
  // and the payload would otherwise dominate the response at scale (a 10k-node
  // graph drops from ~22 MB to ~4 MB on the wire). Callers that need raw vectors
  // (MCP clients doing client-side similarity, debugging tools) opt in with
  // ?include_embeddings=true.
  app.get<{ Querystring: { include_embeddings?: string } }>(
    "/api/knowledge/graph",
    async (req) => {
      const graph = getGraph(req.org!.org_id);
      if (req.query.include_embeddings === "true") return graph;
      return stripEmbeddingsFromGraph(graph);
    },
  );

  // Stats summary
  app.get("/api/knowledge/stats", async (req) => {
    return getStats(req.org!.org_id);
  });

  // Token-budgeted query (main agent-facing interface).
  // If `query_text` is provided and `query_embedding` is not, we generate the embedding
  // server-side so callers without Bedrock creds can still get semantic scoring.
  app.post<{ Body: KnowledgeQueryOptions }>("/api/knowledge/query", { preHandler: validateBody(KnowledgeQuerySchema) }, async (req) => {
    const { query_text, query_embedding, max_tokens, ...rest } = req.body;
    const embedding = query_embedding ?? (query_text ? await generateEmbedding(query_text) : null);
    return queryKnowledge(req.org!.org_id, {
      ...rest,
      query_text,
      query_embedding: embedding,
      max_tokens: max_tokens ?? 2000,
    });
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
      return getRelevantLearnings(req.org!.org_id, scopes, conflictSummaries, maxTokens, projectId);
    },
  );

  // Convenience: precedent lookup for conflicts
  app.get<{ Querystring: { conflict?: string; maxTokens?: string } }>(
    "/api/knowledge/precedents",
    async (req) => {
      const conflict = req.query.conflict ?? "";
      const maxTokens = parseInt(req.query.maxTokens ?? "1000", 10);
      return getPrecedents(req.org!.org_id, conflict, maxTokens);
    },
  );

  // Ad-hoc learning submission. For confirmed learnings outside any active pod
  // (bug fixes, chatbot/agent conversations, anything an operator deems worth keeping).
  // Submitted nodes enter the curation queue (`curated: false`) and are deduplicated
  // synchronously against existing nodes via embedding cosine similarity.
  app.post<{ Body: AdHocLearningInput }>(
    "/api/knowledge/nodes",
    { preHandler: validateBody(AdHocLearningSchema) },
    async (req, reply) => {
      const body = req.body;
      const learning: EnhancedPodLearning = {
        type: body.type,
        summary: body.summary,
        details: body.details,
        domains: body.domains,
        confidence: "extracted" satisfies ConfidenceLevel,
        confidence_score: body.confidence_score ?? AD_HOC_DEFAULT_CONFIDENCE,
      };
      const result = await addLearningsToGraph(
        req.org!.org_id,
        [learning],
        AD_HOC_POD_ID,
        body.source_label ?? AD_HOC_DEFAULT_LABEL,
        undefined,
        { skipAnalysis: true },
      );
      if (result.nodesAdded === 0) {
        reply.code(409);
        return { error: "Near-duplicate of an existing node — not added." };
      }
      return {
        nodesAdded: result.nodesAdded,
        edgesAdded: result.edgesAdded,
        nodeId: result.nodeIds[0],
      };
    },
  );

  // Node curation (human approval/rejection/editing)
  app.post<{ Params: { nodeId: string }; Body: CurationRequest }>(
    "/api/knowledge/nodes/:nodeId/curate",
    { preHandler: validateBody(CurationSchema) },
    async (req, reply) => {
      const { nodeId } = req.params;
      const { action, edits } = req.body;
      const success = curateNode(req.org!.org_id, nodeId, action, edits);
      if (!success) {
        reply.code(404);
        return { error: "Node not found" };
      }
      return { ok: true };
    },
  );
}
