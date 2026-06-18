import type { KnowledgeNode, SearchDocument } from "@pim/shared";
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
const MAX_QUERY_VARIANTS = 2;

function nodeToDocument(node: KnowledgeNode, opts: IntegrationSearchOpts): SearchDocument {
  const typeLabel = node.type.replace(/_/g, " ");
  const title = node.curated
    ? `[curated] ${typeLabel}: ${node.summary}`
    : `${typeLabel}: ${node.summary}`;
  return {
    org_id: opts.org_id,
    project_id: opts.project_id,
    source: "kg",
    source_type: node.type,
    source_id: node.id,
    source_url: `/knowledge#${node.id}`,
    title,
    snippet: truncate(node.retrieval_text || node.details || node.summary, 600),
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
      retrieval_tier: node.retrieval_tier,
      entity_refs: node.entity_refs,
    },
  };
}

function queryVariants(query: string, opts: IntegrationSearchOpts): string[] {
  const q = query.trim();
  if (!q) return [""];
  const variants = new Set<string>([q]);
  const expansions: string[] = [];
  if (/\/[A-Za-z0-9_./:{}-]+|[A-Z][A-Za-z0-9]*(?:API|Service|Controller|Contract|Endpoint)|[A-Z][A-Z0-9]+-\d+|#\d+/.test(q)) {
    expansions.push(`${q} artifact source API contract component`);
  }
  if (opts.query_mode && opts.query_mode !== "current") {
    expansions.push(`${q} historical decision transition as of ${opts.as_of ?? ""}`.trim());
  }
  if (/\bwhy\b|\bchanged\b|\bsuperseded\b|\bhistory\b/i.test(q)) {
    expansions.push(`${q} decision precedent superseded conflict`);
  }
  if (opts.project_name) expansions.push(`${opts.project_name} ${q}`);
  for (const variant of expansions) {
    if (variants.size >= MAX_QUERY_VARIANTS) break;
    variants.add(variant);
  }
  return [...variants];
}

export async function searchKG(opts: IntegrationSearchOpts): Promise<IntegrationResult> {
  try {
    const limit = Math.max(1, Math.min(opts.max_hits_per_source, 8));
    const queryText = opts.query?.trim() ?? "";
    const byId = new Map<string, KnowledgeNode>();
    const embedding = queryText && isEmbeddingAvailable()
      ? await generateEmbedding(queryText)
      : null;

    for (const variant of queryVariants(queryText, opts)) {
      const result = queryKnowledge(opts.org_id, {
        filters: {
          ...(opts.project_id ? { include_project_id: opts.project_id } : {}),
          ...(opts.query_mode && opts.query_mode !== "current" ? { include_superseded: true, retrieval_tiers: ["hot", "warm", "cold"] } : {}),
        },
        max_tokens: TOKEN_BUDGET,
        include_details: true,
        include_edges: opts.query_mode === "why_changed",
        limit,
        query_embedding: embedding,
        query_mode: opts.query_mode ?? "current",
        as_of: opts.as_of,
        ...(variant ? { query_text: variant } : {}),
      });
      for (const node of result.nodes) {
        if (!byId.has(node.id)) byId.set(node.id, node);
      }
      if (byId.size >= limit) break;
    }

    if (byId.size === 0) {
      // Empty graph or no matches under the project filter — surface as a
      // soft "no hits" rather than an integration failure so the synthesis
      // step can still emit a deterministic "no org learnings yet" line.
      return { source: "kg", documents: [] };
    }

    return {
      source: "kg",
      documents: [...byId.values()].slice(0, limit).map((n) => nodeToDocument(n, opts)),
    };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    // queryKnowledge throws when the graph is uninitialized — treat that as
    // missing rather than a hard error so other sources still run.
    if (msg.includes("not initialized")) {
      return { source: "kg", documents: [], missing: "Knowledge graph not initialized on server" };
    }
    return { source: "kg", documents: [], missing: `KG error: ${msg}` };
  }
}
