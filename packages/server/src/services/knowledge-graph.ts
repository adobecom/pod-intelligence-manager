/**
 * Core Knowledge Graph Service — the central hub for building, querying,
 * and maintaining the persistent organizational knowledge graph.
 *
 * In-memory state is keyed by org_id. Each org's graph is loaded lazily from
 * disk on first access and held in a Map for the lifetime of the process.
 * Every exported function takes orgId as its first arg; callers are expected
 * to thread req.org.org_id (resolved by the org-context middleware) through.
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
  extractKeywords,
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

// --- In-Memory Cache (per-org) ---

// Supplementary indexes derived from graph.nodes — never serialised, rebuilt on load,
// updated incrementally on every mutation to keep query cost O(result) not O(all_nodes).
interface NodeIndexes {
  nodeById: Map<string, KnowledgeNode>;
  domainIndex: Map<string, Set<string>>;
  typeIndex: Map<string, Set<string>>;
  podIndex: Map<string, Set<string>>;
  nodeKeywords: Map<string, Set<string>>;
  keywordIndex: Map<string, Set<string>>;
}

interface OrgGraphState extends NodeIndexes {
  graph: KnowledgeGraph;
  hubIds: Set<string>;
  // Set when a mutation skipped community/hub recompute; cleared by refreshAnalysis.
  // Lets ad-hoc POSTs return fast without leaving the graph permanently stale —
  // the periodic interval (or the next archival batch) picks up the work.
  analysisStale: boolean;
}

const orgStates = new Map<string, OrgGraphState>();

// --- Index helpers ---

function buildIndexes(nodes: KnowledgeNode[]): NodeIndexes {
  const idx: NodeIndexes = {
    nodeById: new Map(),
    domainIndex: new Map(),
    typeIndex: new Map(),
    podIndex: new Map(),
    nodeKeywords: new Map(),
    keywordIndex: new Map(),
  };
  for (const node of nodes) _indexNode(node, idx);
  return idx;
}

function _indexNode(node: KnowledgeNode, idx: NodeIndexes): void {
  idx.nodeById.set(node.id, node);
  for (const d of node.domains) {
    if (!idx.domainIndex.has(d)) idx.domainIndex.set(d, new Set());
    idx.domainIndex.get(d)!.add(node.id);
  }
  if (!idx.typeIndex.has(node.type)) idx.typeIndex.set(node.type, new Set());
  idx.typeIndex.get(node.type)!.add(node.id);
  if (!idx.podIndex.has(node.source_pod_id)) idx.podIndex.set(node.source_pod_id, new Set());
  idx.podIndex.get(node.source_pod_id)!.add(node.id);
  const kws = extractKeywords(`${node.summary} ${node.details}`);
  idx.nodeKeywords.set(node.id, kws);
  for (const kw of kws) {
    if (!idx.keywordIndex.has(kw)) idx.keywordIndex.set(kw, new Set());
    idx.keywordIndex.get(kw)!.add(node.id);
  }
}

function _removeNodeFromIndexes(node: KnowledgeNode, idx: NodeIndexes): void {
  idx.nodeById.delete(node.id);
  for (const d of node.domains) idx.domainIndex.get(d)?.delete(node.id);
  idx.typeIndex.get(node.type)?.delete(node.id);
  idx.podIndex.get(node.source_pod_id)?.delete(node.id);
  const kws = idx.nodeKeywords.get(node.id);
  if (kws) {
    for (const kw of kws) idx.keywordIndex.get(kw)?.delete(node.id);
  }
  idx.nodeKeywords.delete(node.id);
}

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

function buildState(graph: KnowledgeGraph): OrgGraphState {
  return {
    graph,
    hubIds: new Set(identifyHubs(graph)),
    analysisStale: false,
    ...buildIndexes(graph.nodes),
  };
}

// --- Initialization ---

export function initializeKnowledgeGraph(orgId: string): void {
  const graph = loadGraph(orgId) ?? emptyGraph(orgId);
  const state = buildState(graph);
  orgStates.set(orgId, state);
  console.log(
    `[knowledge-graph] Loaded graph for org "${orgId}": ${graph.nodes.length} nodes, ${graph.edges.length} edges`,
  );

  const unembeddedCount = graph.nodes.filter((n) => !n.embedding).length;
  if (unembeddedCount > 0 && isEmbeddingAvailable()) {
    console.log(`[knowledge-graph] Scheduling background embedding backfill for ${unembeddedCount} nodes (org "${orgId}")`);
    // Fire-and-forget: does not block server startup
    batchEmbedWithRateLimit(graph.nodes, () => {
      saveGraph(orgId, state.graph);
    }).catch((err) => console.error(`[knowledge-graph] Backfill failed for org "${orgId}":`, err));
  }
}

/**
 * Returns an active in-memory state for the org, loading it lazily on first access.
 * Every read/write path enters through here so a request for a previously-unseen org
 * boots its graph from disk without requiring an eager startup pass.
 */
function getOrgState(orgId: string): OrgGraphState {
  let state = orgStates.get(orgId);
  if (!state) {
    const graph = loadGraph(orgId) ?? emptyGraph(orgId);
    state = buildState(graph);
    orgStates.set(orgId, state);
  }
  return state;
}

export function getGraph(orgId: string): KnowledgeGraph {
  return getOrgState(orgId).graph;
}

/** Test/debug helper: list orgs with a loaded in-memory graph. */
export function loadedOrgIds(): string[] {
  return [...orgStates.keys()];
}

/** Test helper: clear the in-memory cache. Production code should never call this. */
export function _resetForTests(): void {
  orgStates.clear();
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
  orgId: string,
  learnings: EnhancedPodLearning[],
  podId: string,
  podName: string,
  project?: { project_id: string; project_name: string },
  options: AddLearningsOptions = {},
): Promise<{ nodesAdded: number; edgesAdded: number; nodeIds: string[] }> {
  const state = getOrgState(orgId);
  const { graph } = state;

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
      ...(learning.ingestion_provenance ? { ingestion_provenance: learning.ingestion_provenance } : {}),
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
      // Narrow candidates to same-domain nodes — O(N/D) instead of O(N).
      // Cross-domain near-duplicates at ≥0.95 cosine are exceedingly rare in practice;
      // nodes without any domain fall back to a full scan (uncommon path).
      const dedupCandidates = node.domains.length > 0
        ? [...new Set(node.domains.flatMap((d) => [...(state.domainIndex.get(d) ?? [])]))]
            .map((id) => state.nodeById.get(id))
            .filter((n): n is KnowledgeNode => !!n && !!n.embedding)
        : graph.nodes.filter((n) => !!n.embedding);
      const isDuplicate = dedupCandidates.some((existing) => {
        const sim = cosineSimilarity(node.embedding!, existing.embedding!);
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
    console.log(`[knowledge-graph] Skipped ${skipped} near-duplicate node(s) during ingestion for pod "${podId}" (org "${orgId}")`);
  }

  if (newNodes.length === 0) {
    return { nodesAdded: 0, edgesAdded: 0, nodeIds: [] };
  }

  // P3: Pass existing edges so buildEdges won't create duplicate edges for node pairs already connected.
  const newEdges = buildEdges(newNodes, graph.nodes, graph.edges);
  const intraEdges = buildEdges(newNodes, newNodes, [...graph.edges, ...newEdges]);

  graph.nodes.push(...newNodes);
  for (const node of newNodes) _indexNode(node, state);
  graph.edges.push(...newEdges, ...intraEdges);

  // P1: Mark older nodes that are superseded by newly added ones.
  markSupersededEdges([...newEdges, ...intraEdges], graph.nodes);

  graph.version++;
  graph.updated_at = now;

  if (options.skipAnalysis) {
    state.analysisStale = true;
  } else {
    graph.communities = detectCommunities(graph);
    state.hubIds = new Set(identifyHubs(graph));
    state.analysisStale = false;
  }

  saveGraph(orgId, graph);

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

// `null` means "no filter applied yet — all nodes qualify".
function intersectIds(a: Set<string> | null, b: Set<string>): Set<string> {
  if (a === null) return new Set(b);
  return new Set([...b].filter((id) => a.has(id)));
}

export function queryKnowledge(orgId: string, options: KnowledgeQueryOptions): KnowledgeQueryResult {
  const state = getOrgState(orgId);
  const { graph, hubIds } = state;

  const {
    filters,
    max_tokens,
    include_details = false,
    include_edges = false,
    include_embeddings = false,
    limit,
    query_embedding,
  } = options;

  // Step 1: Filter candidates using index-based set intersections.
  // Indexed dimensions (domain, type, pod, keyword) resolve to candidate sets in O(result)
  // time instead of scanning all nodes. Scalar filters (confidence, curated, superseded,
  // project) are applied inline over the already-narrowed list.

  let candidateIds: Set<string> | null = null;

  if (filters.domains?.length) {
    const union = new Set<string>();
    for (const d of filters.domains) {
      for (const id of state.domainIndex.get(d) ?? []) union.add(id);
    }
    candidateIds = intersectIds(candidateIds, union);
  }

  if (filters.types?.length) {
    const union = new Set<string>();
    for (const t of filters.types) {
      for (const id of state.typeIndex.get(t) ?? []) union.add(id);
    }
    candidateIds = intersectIds(candidateIds, union);
  }

  if (filters.source_pod_ids?.length) {
    const union = new Set<string>();
    for (const p of filters.source_pod_ids) {
      for (const id of state.podIndex.get(p) ?? []) union.add(id);
    }
    candidateIds = intersectIds(candidateIds, union);
  }

  // text_search: inverted keyword index — O(|query_words|) instead of O(all_nodes).
  // Behavior change: word-level match instead of substring (better recall in practice).
  // If extractKeywords returns an empty set (e.g. all stop words), the filter is a
  // no-op — treating it as "zero results" would silently break callers that pass short
  // or punctuation-heavy queries (e.g. getPrecedents with a 100-char conflict summary).
  if (filters.text_search) {
    const queryKws = extractKeywords(filters.text_search);
    if (queryKws.size > 0) {
      const textMatches = new Set<string>();
      for (const qk of queryKws) {
        for (const id of state.keywordIndex.get(qk) ?? []) textMatches.add(id);
      }
      candidateIds = intersectIds(candidateIds, textMatches);
    }
  }

  const baseNodes: KnowledgeNode[] = candidateIds === null
    ? graph.nodes
    : [...candidateIds].map((id) => state.nodeById.get(id)).filter((n): n is KnowledgeNode => !!n);

  // P1: Exclude superseded nodes by default so agents don't receive stale decisions.
  const candidates: KnowledgeNode[] = baseNodes.filter((node) => {
    if (filters.source_project_ids?.length) {
      if (!node.source_project_id || !filters.source_project_ids.includes(node.source_project_id)) return false;
    }
    if (filters.include_project_id) {
      if (node.source_project_id && node.source_project_id !== filters.include_project_id) return false;
    }
    if (filters.confidence_min !== undefined && node.confidence_score < filters.confidence_min) return false;
    if (filters.curated_only && !node.curated) return false;
    if (!filters.include_superseded && node.superseded_by) return false;
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
      score: scoreRelevance(
        node,
        { scopes, keywords, querySimilarity, precomputedKeywords: state.nodeKeywords.get(node.id) },
        hubIds,
        graphTuning,
      ),
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
  orgId: string,
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

  return queryKnowledge(orgId, {
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
  orgId: string,
  conflictSummary: string,
  maxTokens: number,
): Promise<KnowledgeQueryResult> {
  const queryEmbedding = conflictSummary.trim()
    ? await generateEmbedding(conflictSummary)
    : null;

  return queryKnowledge(orgId, {
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
  orgId: string,
  nodeId: string,
  action: CurationAction,
  edits?: Partial<Pick<KnowledgeNode, "summary" | "details" | "domains">>,
): boolean {
  const state = getOrgState(orgId);
  const { graph } = state;

  const nodeIndex = graph.nodes.findIndex((n) => n.id === nodeId);
  if (nodeIndex === -1) return false;

  if (action === "reject") {
    _removeNodeFromIndexes(graph.nodes[nodeIndex], state);
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
    _removeNodeFromIndexes(node, state);
    if (edits.summary !== undefined) node.summary = edits.summary;
    if (edits.details !== undefined) node.details = edits.details;
    if (edits.domains !== undefined) node.domains = edits.domains;
    node.curated = true;
    _indexNode(node, state);
  }

  graph.version++;
  graph.updated_at = new Date().toISOString();

  // Re-run analysis after structural changes
  if (action === "reject") {
    graph.communities = detectCommunities(graph);
    state.hubIds = new Set(identifyHubs(graph));
  }

  saveGraph(orgId, graph);
  return true;
}

// --- Stats ---

export function getStats(orgId: string): KnowledgeStats {
  const state = orgStates.get(orgId);
  const graph = state?.graph ?? loadGraph(orgId);
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

export function refreshAnalysis(orgId: string): void {
  const state = orgStates.get(orgId);
  if (!state || state.graph.nodes.length === 0) {
    if (state) state.analysisStale = false;
    return;
  }
  const { graph } = state;
  graph.communities = detectCommunities(graph);
  state.hubIds = new Set(identifyHubs(graph));
  state.analysisStale = false;
  saveGraph(orgId, graph);
}

/**
 * Cheap variant of refreshAnalysis: returns immediately when nothing has marked the graph
 * stale. Safe to call from hot paths (interval ticks, post-query lazy refresh).
 *
 * With no orgId, iterates over every loaded org's state — the periodic interval uses this
 * form so newly active orgs get picked up without a separate scheduler.
 */
export function refreshAnalysisIfStale(orgId?: string): boolean {
  if (orgId) {
    const state = orgStates.get(orgId);
    if (!state?.analysisStale) return false;
    refreshAnalysis(orgId);
    return true;
  }
  let didWork = false;
  for (const [id, state] of orgStates) {
    if (!state.analysisStale) continue;
    refreshAnalysis(id);
    didWork = true;
  }
  return didWork;
}

/** Test/debug helper. */
export function isAnalysisStale(orgId: string): boolean {
  return orgStates.get(orgId)?.analysisStale ?? false;
}

// --- Pruning ---

/**
 * Drop low-confidence, uncurated, stale nodes that no human has approved or edited.
 * Curated and superseded nodes are protected; superseded nodes are filtered at query
 * time and may still be useful for history. Runs once and rebuilds analysis at the end.
 *
 * With no orgId, prunes every loaded org's graph — matches the periodic-interval shape.
 */
const PRUNE_AGE_MS = 180 * 24 * 60 * 60 * 1000;

export function pruneStaleNodes(orgId?: string, now: Date = new Date()): { removed: number } {
  if (!orgId) {
    let total = 0;
    for (const id of orgStates.keys()) {
      total += pruneStaleNodes(id, now).removed;
    }
    return { removed: total };
  }

  const state = orgStates.get(orgId);
  if (!state || state.graph.nodes.length === 0) return { removed: 0 };
  const { graph } = state;

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
  state.hubIds = new Set(identifyHubs(graph));
  const freshIndexes = buildIndexes(graph.nodes);
  state.nodeById = freshIndexes.nodeById;
  state.domainIndex = freshIndexes.domainIndex;
  state.typeIndex = freshIndexes.typeIndex;
  state.podIndex = freshIndexes.podIndex;
  state.nodeKeywords = freshIndexes.nodeKeywords;
  state.keywordIndex = freshIndexes.keywordIndex;
  saveGraph(orgId, graph);

  console.log(`[knowledge-graph] Pruned ${toRemove.size} stale node(s) for org "${orgId}"`);
  return { removed: toRemove.size };
}
