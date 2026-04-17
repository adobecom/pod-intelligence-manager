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
  ContextUpdateType,
  Scope,
} from "@council/shared";
import { loadGraph, saveGraph } from "./graph-storage.js";
import {
  buildEdges,
  detectCommunities,
  identifyHubs,
  keywordsFromTexts,
  scoreRelevance,
} from "./graph-analysis.js";

// --- In-Memory Cache ---

let graph: KnowledgeGraph | null = null;
let hubIds: Set<string> = new Set();

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

// --- Add Learnings ---

export function addLearningsToGraph(
  learnings: EnhancedPodLearning[],
  podId: string,
  podName: string,
  project?: { project_id: string; project_name: string },
): { nodesAdded: number; edgesAdded: number } {
  if (!graph) throw new Error("Knowledge graph not initialized");

  const now = new Date().toISOString();
  const newNodes: KnowledgeNode[] = [];

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
    newNodes.push(node);
  }

  // Build edges between new nodes and existing graph
  const newEdges = buildEdges(newNodes, graph.nodes);

  // Also build edges among the new nodes themselves
  const intraEdges = buildEdges(newNodes, newNodes);

  graph.nodes.push(...newNodes);
  graph.edges.push(...newEdges, ...intraEdges);
  graph.version++;
  graph.updated_at = now;

  // Re-run community detection and hub identification
  graph.communities = detectCommunities(graph);
  hubIds = new Set(identifyHubs(graph));

  // Persist
  saveGraph(graph.org_id, graph);

  return {
    nodesAdded: newNodes.length,
    edgesAdded: newEdges.length + intraEdges.length,
  };
}

/**
 * Lightweight ingestion from project context updates: high-signal types only.
 */
export function maybeAddProjectContextSignalToGraph(
  projectId: string,
  projectName: string,
  type: ContextUpdateType,
  summary: string,
  details: string,
  scope: Scope,
): { added: boolean } {
  if (!graph) return { added: false };
  if (type !== "decision" && type !== "spec_change") return { added: false };

  const now = new Date().toISOString();
  const nodeType: KnowledgeNodeType = type === "decision" ? "decision" : "scope_insight";
  const node: KnowledgeNode = {
    id: `kn-${crypto.randomUUID().slice(0, 8)}`,
    type: nodeType,
    summary,
    details,
    source_pod_id: "project",
    source_pod_name: projectName,
    source_project_id: projectId,
    source_project_name: projectName,
    domains: [scope],
    confidence: "extracted",
    confidence_score: 0.85,
    created_at: now,
    curated: false,
  };

  const newEdges = buildEdges([node], graph.nodes);
  graph.nodes.push(node);
  graph.edges.push(...newEdges);
  graph.version++;
  graph.updated_at = now;
  graph.communities = detectCommunities(graph);
  hubIds = new Set(identifyHubs(graph));
  saveGraph(graph.org_id, graph);
  return { added: true };
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

  const { filters, max_tokens, include_details = false, include_edges = false, limit } = options;

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

  const scored = candidates.map((node) => ({
    node,
    score: scoreRelevance(node, { scopes, keywords }, hubIds),
  }));
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

    // Strip details if not requested
    if (!include_details) {
      resultNodes.push({ ...node, details: "" });
    } else {
      resultNodes.push(node);
    }
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

export function getRelevantLearnings(
  scopes: string[],
  activeConflictSummaries: string[],
  maxTokens: number,
  projectId?: string | null,
): KnowledgeQueryResult {
  const keywords = keywordsFromTexts(activeConflictSummaries, 40);

  return queryKnowledge({
    filters: {
      domains: scopes,
      ...(keywords.length > 0 ? { keywords } : {}),
      ...(projectId ? { include_project_id: projectId } : {}),
    },
    max_tokens: maxTokens,
    include_details: false,
  });
}

// --- Convenience: Get Precedents ---

export function getPrecedents(
  conflictSummary: string,
  maxTokens: number,
): KnowledgeQueryResult {
  return queryKnowledge({
    filters: {
      types: ["resolved_conflict"],
      text_search: conflictSummary.slice(0, 100), // Use first 100 chars for matching
    },
    max_tokens: maxTokens,
    include_details: true,
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
    // Remove node and its edges
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
  if (!graph || graph.nodes.length === 0) return;
  graph.communities = detectCommunities(graph);
  hubIds = new Set(identifyHubs(graph));
  saveGraph(graph.org_id, graph);
}
