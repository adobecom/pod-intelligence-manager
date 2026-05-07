/**
 * Core Knowledge Graph Service — the central hub for building, querying,
 * and maintaining the persistent organizational knowledge graph.
 *
 * In-memory cache loaded on server start, persisted to disk on mutations.
 * All query endpoints use token budgets to minimize agent context window usage.
 */

import crypto from "node:crypto";
import type {
  KnowledgeGraph,
  KnowledgeNode,
  KnowledgeEdge,
  KnowledgeQueryOptions,
  KnowledgeQueryResult,
  KnowledgeStats,
  KnowledgeNodeType,
  ConfidenceLevel,
  EnhancedPodLearning,
  CurationAction,
} from "@pim/shared";
import { DEFAULT_ORG_TUNING } from "@pim/shared";
import { getOrgTuning } from "./org-settings.js";
import { loadGraph, saveGraph } from "./graph-storage.js";
import {
  buildEdges,
  detectCommunities,
  identifyHubs,
  keywordsFromTexts,
  scoreRelevance,
} from "./graph-analysis.js";
import {
  generateEmbedding,
  embedText,
  batchEmbedWithRateLimit,
  cosineSimilarity,
  isEmbeddingAvailable,
} from "./embeddings.js";

// --- In-Memory Cache ---

let graph: KnowledgeGraph | null = null;
let hubIds: Set<string> = new Set();
// Set when a mutation skipped community/hub recompute; cleared by refreshAnalysis.
// Lets ad-hoc POSTs return fast without leaving the graph permanently stale —
// the periodic interval (or the next archival batch) picks up the work.
let analysisStale = false;

function emptyGraph(orgId: string): KnowledgeGraph {
  return {
    version: 0,
    org_id: orgId,
    updated_at: new Date().toISOString(),
    nodes: [],
    edges: [],
    communities: [],
  };
}

// --- Initialization ---

export function initializeKnowledgeGraph(orgId: string): void {
  graph = loadGraph(orgId) ?? emptyGraph(orgId);
  hubIds = new Set(identifyHubs(graph));
  console.log(
    `[knowledge-graph] Loaded graph for org "${orgId}": ${graph.nodes.length} nodes, ${graph.edges.length} edges`,
  );

  const unembeddedCount = graph.nodes.filter((n) => !n.embedding).length;
  if (unembeddedCount > 0 && isEmbeddingAvailable()) {
    console.log(`[knowledge-graph] Scheduling background embedding backfill for ${unembeddedCount} nodes`);
    // Fire-and-forget: does not block server startup
    batchEmbedWithRateLimit(graph.nodes, () => {
      if (graph) saveGraph(graph.org_id, graph);
    }).catch((err) => console.error("[knowledge-graph] Backfill failed:", err));
  }
}

export function getGraph(): KnowledgeGraph {
  if (!graph) throw new Error("Knowledge graph not initialized. Call initializeKnowledgeGraph first.");
  return graph;
}

// --- Token Estimation ---

const TOKENS_PER_SUMMARY = 20;
const TOKENS_PER_DETAILS = 80;
const TOKENS_PER_EDGE = 10;

function estimateNodeTokens(node: KnowledgeNode, includeDetails: boolean): number {
  return TOKENS_PER_SUMMARY + (includeDetails ? TOKENS_PER_DETAILS : 0);
}

/** Omit embedding from serialized query results unless explicitly requested (debug). */
function omitEmbeddingForResponse(node: KnowledgeNode): KnowledgeNode {
  const { embedding: _, ...rest } = node;
  return rest as KnowledgeNode;
}

function shapeNodeForQueryResponse(
  node: KnowledgeNode,
  includeDetails: boolean,
  includeEmbeddings: boolean,
): KnowledgeNode {
  const base = includeEmbeddings ? node : omitEmbeddingForResponse(node);
  return includeDetails ? base : { ...base, details: "" };
}

// --- Helpers ---

// P1: After edges are built, mark older nodes whose decisions were superseded.
function markSupersededEdges(edges: KnowledgeEdge[], allNodes: KnowledgeNode[]): void {
  const nodeById = new Map(allNodes.map((n) => [n.id, n]));
  for (const edge of edges) {
    if (edge.type === "supersedes") {
      const older = nodeById.get(edge.target);
      if (older && !older.superseded_by) {
        older.superseded_by = edge.source;
      }
    }
  }
}

// --- Add Learnings ---

export interface AddLearningsOptions {
  /**
   * Skip the synchronous community-detection + hub-identification step. Used by the
   * ad-hoc `POST /api/knowledge/nodes` hot path; the analysis is deferred to the
   * periodic interval (or the next non-skipped mutation) instead of running per request.
   */
  skipAnalysis?: boolean;
}

export async function addLearningsToGraph(
  learnings: EnhancedPodLearning[],
  podId: string,
  podName: string,
  project?: { project_id: string; project_name: string },
  options: AddLearningsOptions = {},
): Promise<{ nodesAdded: number; edgesAdded: number; nodeIds: string[] }> {
  if (!graph) throw new Error("Knowledge graph not initialized");

  const now = new Date().toISOString();
  const newNodes: KnowledgeNode[] = [];
  let skipped = 0;

  for (const learning of learnings) {
    const node: KnowledgeNode = {
      id: `kn-${crypto.randomUUID().slice(0, 8)}`,
      type: learning.type,
      summary: learning.summary,
      details: learning.details,
      source_pod_id: podId,
      source_pod_name: podName,
      ...(project
        ? { source_project_id: project.project_id, source_project_name: project.project_name }
        : {}),
      domains: learning.domains,
      confidence: learning.confidence,
      confidence_score: learning.confidence_score,
      created_at: now,
      curated: false,
    };

    node.embedding = (await generateEmbedding(embedText(node))) ?? undefined;

    // P0 + P2: Skip if a near-identical node already exists in the graph.
    // Same-pod threshold catches incremental-signal nodes re-extracted at archival.
    // Cross-pod threshold catches near-verbatim patterns from different pods.
    // Thresholds are org-tunable via getOrgTuning (defaults: 0.85 same-pod, 0.95 cross-pod).
    if (!node.embedding) {
      console.warn(`[knowledge-graph] Node accepted without dedup (embedding unavailable): "${node.summary.slice(0, 80)}"`);
    }
    if (node.embedding) {
      const graphTuning = graph.org_id
        ? getOrgTuning(graph.org_id).graphScoring
        : DEFAULT_ORG_TUNING.graphScoring;
      const samePodThreshold = graphTuning.samePodDedupThreshold;
      const crossPodThreshold = graphTuning.crossPodDedupThreshold;
      const isDuplicate = graph.nodes.some((existing) => {
        if (!existing.embedding) return false;
        const sim = cosineSimilarity(node.embedding!, existing.embedding);
        return existing.source_pod_id === podId ? sim >= samePodThreshold : sim >= crossPodThreshold;
      });
      if (isDuplicate) {
        skipped++;
        continue;
      }
    }

    newNodes.push(node);
  }

  if (skipped > 0) {
    console.log(`[knowledge-graph] Skipped ${skipped} near-duplicate node(s) during ingestion for pod "${podId}"`);
  }

  if (newNodes.length === 0) {
    return { nodesAdded: 0, edgesAdded: 0, nodeIds: [] };
  }

  // P3: Pass existing edges so buildEdges won't create duplicate edges for node pairs already connected.
  const newEdges = buildEdges(newNodes, graph.nodes, graph.edges);
  const intraEdges = buildEdges(newNodes, newNodes, [...graph.edges, ...newEdges]);

  graph.nodes.push(...newNodes);
  graph.edges.push(...newEdges, ...intraEdges);

  // P1: Mark older nodes that are superseded by newly added ones.
  markSupersededEdges([...newEdges, ...intraEdges], graph.nodes);

  graph.version++;
  graph.updated_at = now;

  if (options.skipAnalysis) {
    analysisStale = true;
  } else {
    graph.communities = detectCommunities(graph);
    hubIds = new Set(identifyHubs(graph));
    analysisStale = false;
  }

  saveGraph(graph.org_id, graph);

  return {
    nodesAdded: newNodes.length,
    edgesAdded: newEdges.length + intraEdges.length,
    nodeIds: newNodes.map((n) => n.id),
  };
}

// --- Query Knowledge ---

function mergeScoringKeywords(filters: KnowledgeQueryOptions["filters"]): string[] {
  const fromExplicit =
    filters.keywords?.map((k) => k.toLowerCase().trim()).filter((k) => k.length > 2) ?? [];
  const fromTextSearch = filters.text_search
    ? filters.text_search
        .split(/\s+/)
        .filter((w) => w.length > 2)
        .map((w) => w.toLowerCase())
    : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of [...fromExplicit, ...fromTextSearch]) {
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

export function queryKnowledge(options: KnowledgeQueryOptions): KnowledgeQueryResult {
  if (!graph) throw new Error("Knowledge graph not initialized");

  const {
    filters,
    max_tokens,
    include_details = false,
    include_edges = false,
    include_embeddings = false,
    limit,
    query_embedding,
  } = options;

  // Step 1: Filter nodes
  let candidates = graph.nodes.filter((node) => {
    if (filters.domains?.length) {
      const hasDomain = filters.domains.some((d) => node.domains.includes(d));
      if (!hasDomain) return false;
    }
    if (filters.types?.length) {
      if (!filters.types.includes(node.type)) return false;
    }
    if (filters.source_pod_ids?.length) {
      if (!filters.source_pod_ids.includes(node.source_pod_id)) return false;
    }
    if (filters.source_project_ids?.length) {
      const pid = node.source_project_id;
      if (!pid || !filters.source_project_ids.includes(pid)) return false;
    }
    if (filters.include_project_id) {
      const want = filters.include_project_id;
      if (node.source_project_id && node.source_project_id !== want) return false;
    }
    if (filters.confidence_min !== undefined) {
      if (node.confidence_score < filters.confidence_min) return false;
    }
    if (filters.curated_only) {
      if (!node.curated) return false;
    }
    // P1: Exclude superseded nodes by default so agents don't receive stale decisions.
    if (!filters.include_superseded && node.superseded_by) return false;
    if (filters.text_search) {
      const search = filters.text_search.toLowerCase();
      const text = `${node.summary} ${node.details}`.toLowerCase();
      if (!text.includes(search)) return false;
    }
    return true;
  });

  const totalMatching = candidates.length;

  // Step 2: Score and sort by relevance
  const scopes = filters.domains ?? [];
  const keywords = mergeScoringKeywords(filters);
  const graphTuning = graph.org_id ? getOrgTuning(graph.org_id).graphScoring : DEFAULT_ORG_TUNING.graphScoring;

  const scored = candidates.map((node) => {
    const querySimilarity =
      query_embedding && node.embedding
        ? cosineSimilarity(query_embedding, node.embedding)
        : undefined;
    return {
      node,
      score: scoreRelevance(node, { scopes, keywords, querySimilarity }, hubIds, graphTuning),
    };
  });
  scored.sort((a, b) => b.score - a.score);

  // Step 3: Apply token budget and/or limit
  const resultNodes: KnowledgeNode[] = [];
  let tokenCount = 0;
  const effectiveLimit = limit ?? scored.length;
  const tokenBudget = max_tokens ?? Infinity;

  for (const { node } of scored) {
    if (resultNodes.length >= effectiveLimit) break;

    const nodeTokens = estimateNodeTokens(node, include_details);
    if (tokenCount + nodeTokens > tokenBudget) break;

    tokenCount += nodeTokens;

    resultNodes.push(shapeNodeForQueryResponse(node, include_details, include_embeddings));
  }

  // Step 4: Include edges if requested
  let resultEdges: KnowledgeEdge[] = [];
  if (include_edges) {
    const nodeIds = new Set(resultNodes.map((n) => n.id));
    resultEdges = graph.edges.filter(
      (e) => nodeIds.has(e.source) && nodeIds.has(e.target),
    );
    tokenCount += resultEdges.length * TOKENS_PER_EDGE;
  }

  return {
    nodes: resultNodes,
    edges: resultEdges,
    total_matching: totalMatching,
    token_estimate: tokenCount,
    truncated: resultNodes.length < totalMatching,
  };
}

// --- Convenience: Get Relevant Learnings ---

export async function getRelevantLearnings(
  scopes: string[],
  activeConflictSummaries: string[],
  maxTokens: number,
  projectId?: string | null,
): Promise<KnowledgeQueryResult> {
  const keywords = keywordsFromTexts(activeConflictSummaries, 40);

  // Use conflict summaries as the semantic query (scopes are handled by domain filter)
  const queryText = activeConflictSummaries.filter(Boolean).join(" ");
  const queryEmbedding = queryText.trim()
    ? await generateEmbedding(queryText)
    : null;

  return queryKnowledge({
    filters: {
      domains: scopes,
      ...(keywords.length > 0 ? { keywords } : {}),
      ...(projectId ? { include_project_id: projectId } : {}),
    },
    max_tokens: maxTokens,
    include_details: false,
    query_embedding: queryEmbedding,
  });
}

// --- Convenience: Get Precedents ---

export async function getPrecedents(
  conflictSummary: string,
  maxTokens: number,
): Promise<KnowledgeQueryResult> {
  const queryEmbedding = conflictSummary.trim()
    ? await generateEmbedding(conflictSummary)
    : null;

  return queryKnowledge({
    filters: {
      types: ["resolved_conflict"],
      text_search: conflictSummary.slice(0, 100),
    },
    max_tokens: maxTokens,
    include_details: true,
    query_embedding: queryEmbedding,
  });
}

// --- Curation ---

export function curateNode(
  nodeId: string,
  action: CurationAction,
  edits?: Partial<Pick<KnowledgeNode, "summary" | "details" | "domains">>,
): boolean {
  if (!graph) throw new Error("Knowledge graph not initialized");

  const nodeIndex = graph.nodes.findIndex((n) => n.id === nodeId);
  if (nodeIndex === -1) return false;

  if (action === "reject") {
    // Clear superseded_by on any nodes this node was superseding, so they
    // become visible again rather than pointing at a deleted node.
    for (const n of graph.nodes) {
      if (n.superseded_by === nodeId) n.superseded_by = undefined;
    }
    graph.nodes.splice(nodeIndex, 1);
    graph.edges = graph.edges.filter(
      (e) => e.source !== nodeId && e.target !== nodeId,
    );
  } else if (action === "approve") {
    graph.nodes[nodeIndex].curated = true;
  } else if (action === "edit" && edits) {
    const node = graph.nodes[nodeIndex];
    if (edits.summary !== undefined) node.summary = edits.summary;
    if (edits.details !== undefined) node.details = edits.details;
    if (edits.domains !== undefined) node.domains = edits.domains;
    node.curated = true;
  }

  graph.version++;
  graph.updated_at = new Date().toISOString();

  // Re-run analysis after structural changes
  if (action === "reject") {
    graph.communities = detectCommunities(graph);
    hubIds = new Set(identifyHubs(graph));
  }

  saveGraph(graph.org_id, graph);
  return true;
}

// --- Stats ---

export function getStats(): KnowledgeStats {
  if (!graph) {
    return {
      total_nodes: 0,
      total_edges: 0,
      total_communities: 0,
      nodes_by_type: { decision: 0, pattern: 0, anti_pattern: 0, resolved_conflict: 0, scope_insight: 0 },
      nodes_by_confidence: { extracted: 0, inferred: 0 },
      top_domains: [],
      updated_at: null,
    };
  }

  const nodesByType: Record<KnowledgeNodeType, number> = {
    decision: 0, pattern: 0, anti_pattern: 0, resolved_conflict: 0, scope_insight: 0,
  };
  const nodesByConfidence: Record<ConfidenceLevel, number> = {
    extracted: 0, inferred: 0,
  };
  const domainCounts = new Map<string, number>();

  for (const node of graph.nodes) {
    nodesByType[node.type] = (nodesByType[node.type] ?? 0) + 1;
    nodesByConfidence[node.confidence] = (nodesByConfidence[node.confidence] ?? 0) + 1;
    for (const d of node.domains) {
      domainCounts.set(d, (domainCounts.get(d) ?? 0) + 1);
    }
  }

  const topDomains = [...domainCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([d]) => d);

  return {
    total_nodes: graph.nodes.length,
    total_edges: graph.edges.length,
    total_communities: graph.communities.length,
    nodes_by_type: nodesByType,
    nodes_by_confidence: nodesByConfidence,
    top_domains: topDomains,
    updated_at: graph.updated_at,
  };
}

// --- Re-run Community Detection (called periodically) ---

export function refreshAnalysis(): void {
  if (!graph || graph.nodes.length === 0) {
    analysisStale = false;
    return;
  }
  graph.communities = detectCommunities(graph);
  hubIds = new Set(identifyHubs(graph));
  analysisStale = false;
  saveGraph(graph.org_id, graph);
}

/**
 * Cheap variant of refreshAnalysis: returns immediately when nothing has marked the graph
 * stale. Safe to call from hot paths (interval ticks, post-query lazy refresh).
 */
export function refreshAnalysisIfStale(): boolean {
  if (!analysisStale) return false;
  refreshAnalysis();
  return true;
}

/** Test/debug helper. */
export function isAnalysisStale(): boolean {
  return analysisStale;
}

// --- Pruning ---

/**
 * Drop low-confidence, uncurated, stale nodes that no human has approved or edited.
 * Curated and superseded nodes are protected; superseded nodes are filtered at query
 * time and may still be useful for history. Runs once and rebuilds analysis at the end.
 */
const PRUNE_AGE_MS = 180 * 24 * 60 * 60 * 1000;

export function pruneStaleNodes(now: Date = new Date()): { removed: number } {
  if (!graph || graph.nodes.length === 0) return { removed: 0 };

  const cutoff = now.getTime() - PRUNE_AGE_MS;
  const toRemove = new Set<string>();
  for (const node of graph.nodes) {
    if (node.curated) continue;
    if (node.confidence_score >= 0.5) continue;
    if (node.superseded_by) continue;
    const created = new Date(node.created_at).getTime();
    if (Number.isNaN(created) || created > cutoff) continue;
    toRemove.add(node.id);
  }

  if (toRemove.size === 0) return { removed: 0 };

  graph.nodes = graph.nodes.filter((n) => !toRemove.has(n.id));
  graph.edges = graph.edges.filter(
    (e) => !toRemove.has(e.source) && !toRemove.has(e.target),
  );
  // Clear stale superseded_by references pointing into removed nodes.
  for (const n of graph.nodes) {
    if (n.superseded_by && toRemove.has(n.superseded_by)) {
      n.superseded_by = undefined;
    }
  }

  graph.version++;
  graph.updated_at = now.toISOString();
  graph.communities = detectCommunities(graph);
  hubIds = new Set(identifyHubs(graph));
  saveGraph(graph.org_id, graph);

  console.log(`[knowledge-graph] Pruned ${toRemove.size} stale node(s)`);
  return { removed: toRemove.size };
}
