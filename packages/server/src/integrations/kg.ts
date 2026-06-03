import type { ContextSearchHit, KnowledgeNode } from "@pim/shared";
import { queryKnowledge } from "../services/knowledge-graph.js";
import { generateEmbedding, isEmbeddingAvailable } from "../services/embeddings.js";
import { type IntegrationResult, type IntegrationSearchOpts, truncate } from "./types.js";

// Knowledge-graph integration for context_search. The KG is the org's
// curated memory of decisions, patterns, anti-patterns, resolved conflicts,
// and scope insights — it is the first source of truth, queried before
// any external system. Ranking in context-search.ts gives KG the highest
// authority bonus.
//
// Strategy:
//  1. Generate a query embedding (Bedrock Titan v2 via the existing service).
//  2. Hand the embedding to queryKnowledge so semantic ranking dominates.
//  3. Project-scope when the caller supplied a project_id, so consumer pods
//     only see their org-wide + project-tagged learnings.
//  4. Drop the textual `text_search` filter — it requires literal substring
//     matching, which collapses semantic recall (e.g. an "auth token refresh"
//     query won't substring-match a node titled "OAuth handshake retry").

const TOKEN_BUDGET = 1500;

function nodeToHit(node: KnowledgeNode): ContextSearchHit {
  const typeLabel = node.type.replace(/_/g, " ");
  const title = node.curated
    ? `[curated] ${typeLabel}: ${node.summary}`
    : `${typeLabel}: ${node.summary}`;
  return {
    source: "kg",
    title,
    url: `/knowledge#${node.id}`,
    snippet: truncate(node.details || node.summary, 600),
    timestamp: node.created_at,
    metadata: {
      node_id: node.id,
      type: node.type,
      domains: node.domains,
      confidence: node.confidence,
      confidence_score: node.confidence_score,
      curated: node.curated,
      source_pod_id: node.source_pod_id,
      source_pod_name: node.source_pod_name,
      source_project_id: node.source_project_id,
    },
  };
}

export async function searchKG(opts: IntegrationSearchOpts): Promise<IntegrationResult> {
  try {
    const limit = Math.max(1, Math.min(opts.max_hits_per_source, 8));
    const queryText = opts.query?.trim() ?? "";

    // Embed the original query (before any per-integration cleaning) so the
    // semantic recall benefits from the actor and intent context.
    const embedding = queryText && isEmbeddingAvailable()
      ? await generateEmbedding(queryText)
      : null;

    const result = queryKnowledge(opts.org_id, {
      filters: {
        ...(opts.project_id ? { include_project_id: opts.project_id } : {}),
      },
      max_tokens: TOKEN_BUDGET,
      include_details: true,
      limit,
      query_embedding: embedding,
      ...(queryText ? { query_text: queryText } : {}),
    });

    if (result.nodes.length === 0) {
      // Empty graph or no matches under the project filter — surface as a
      // soft "no hits" rather than an integration failure so the synthesis
      // step can still emit a deterministic "no org learnings yet" line.
      return { source: "kg", hits: [] };
    }

    return { source: "kg", hits: result.nodes.map(nodeToHit) };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    // queryKnowledge throws when the graph is uninitialized — treat that as
    // missing rather than a hard error so other sources still run.
    if (msg.includes("not initialized")) {
      return { source: "kg", hits: [], missing: "Knowledge graph not initialized on server" };
    }
    return { source: "kg", hits: [], missing: `KG error: ${msg}` };
  }
}
