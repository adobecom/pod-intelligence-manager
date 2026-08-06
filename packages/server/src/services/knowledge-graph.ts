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
  KnowledgeRetrievalExplanation,
  KnowledgeRetrievalDiagnostics,
  KnowledgeStats,
  KnowledgeNodeType,
  ConfidenceLevel,
  EnhancedPodLearning,
  CurationAction,
  KgContextContractMode,
} from "@pim/shared";
import { DEFAULT_ORG_TUNING } from "@pim/shared";
import { getKgContextContract, getOrgTuning } from "./org-settings.js";
import { loadGraph, saveGraph } from "./graph-storage.js";
import {
  buildEdges,
  detectCommunities,
  extractKeywords,
  extractRetrievalIdentifiers,
  identifyHubs,
  keywordsFromTexts,
  scoreRelevance,
} from "./graph-analysis.js";
import {
  generateEmbedding,
  embedText,
  embeddingTextHash,
  batchEmbedWithRateLimit,
  cosineSimilarity,
  isEmbeddingAvailable,
} from "./embeddings.js";
import { assertLegacyActivationStructure } from "./memory-structural-validator.js";
import {
  assertLegacyMemoryWritable,
  legacyMemoryWritesFrozen,
} from "./memory-authority.js";
import { getGraphAnalysisPool, isGraphWorkerEnabled } from "./graph-analysis-pool.js";
import { buildKnowledgeNodeMemory } from "./memory-enrichment.js";

// --- In-Memory Cache (per-org) ---

// Supplementary indexes derived from graph.nodes — never serialised, rebuilt on load,
// updated incrementally on every mutation to keep query cost O(result) not O(all_nodes).
interface NodeIndexes {
  nodeById: Map<string, KnowledgeNode>;
  domainIndex: Map<string, Set<string>>;
  topicIndex: Map<string, Set<string>>;
  typeIndex: Map<string, Set<string>>;
  podIndex: Map<string, Set<string>>;
  entityIndex: Map<string, Set<string>>;
  nodeKeywords: Map<string, Set<string>>;
  keywordIndex: Map<string, Set<string>>;
  nodeIdentifiers: Map<string, Set<string>>;
  identifierIndex: Map<string, Set<string>>;
}

interface OrgGraphState extends NodeIndexes {
  graph: KnowledgeGraph;
  hubIds: Set<string>;
  // Set when a mutation skipped community/hub recompute; cleared by refreshAnalysis.
  // Lets ad-hoc POSTs return fast without leaving the graph permanently stale —
  // the periodic interval (or the next archival batch) picks up the work.
  analysisStale: boolean;
  // Retrieval counters are useful telemetry, but query paths must not persist the
  // whole graph synchronously. Flush these updates from the periodic graph tick.
  retrievalTelemetryDirty: boolean;
}

const orgStates = new Map<string, OrgGraphState>();

export class KnowledgeQueryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeQueryValidationError";
  }
}

type InternalKnowledgeQueryOptions = KnowledgeQueryOptions & {
  /** Eval-only oracle hints. Public REST schemas intentionally strip this field. */
  required_node_ids?: string[];
  /** Internal compact-context mode: avoid broad scoped recall unless task evidence is direct. */
  strict_task_relevance?: boolean;
};

// --- Index helpers ---

function normalizeTagList(values: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values ?? []) {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function nodeScopes(node: KnowledgeNode): string[] {
  const scopes = normalizeTagList(node.scopes);
  return scopes.length > 0 ? scopes : normalizeTagList(node.domains);
}

function nodeTopics(node: KnowledgeNode): string[] {
  const explicit = normalizeTagList(node.topics);
  return explicit.length > 0 ? explicit : keywordsFromTexts([node.summary, node.details, node.retrieval_text ?? ""], 12);
}

function normalizeQueryFilters(filters: KnowledgeQueryOptions["filters"]): KnowledgeQueryOptions["filters"] {
  const input = filters ?? {};
  const explicitScopes = normalizeTagList(input.scopes);
  const explicitDomains = normalizeTagList(input.domains);
  const scopes = explicitScopes.length > 0 ? explicitScopes : explicitDomains;
  const domains = explicitDomains;
  const topics = normalizeTagList(input.topics);
  return {
    ...input,
    ...(domains.length > 0 ? { domains } : { domains: undefined }),
    ...(scopes.length > 0 ? { scopes } : { scopes: undefined }),
    ...(topics.length > 0 ? { topics } : { topics: undefined }),
  };
}

function buildIndexes(nodes: KnowledgeNode[]): NodeIndexes {
  const idx: NodeIndexes = {
    nodeById: new Map(),
    domainIndex: new Map(),
    topicIndex: new Map(),
    typeIndex: new Map(),
    podIndex: new Map(),
    entityIndex: new Map(),
    nodeKeywords: new Map(),
    keywordIndex: new Map(),
    nodeIdentifiers: new Map(),
    identifierIndex: new Map(),
  };
  for (const node of nodes) _indexNode(node, idx);
  return idx;
}

function _indexNode(node: KnowledgeNode, idx: NodeIndexes): void {
  idx.nodeById.set(node.id, node);
  for (const d of [...new Set([...normalizeTagList(node.domains), ...nodeScopes(node)])]) {
    if (!idx.domainIndex.has(d)) idx.domainIndex.set(d, new Set());
    idx.domainIndex.get(d)!.add(node.id);
  }
  for (const t of nodeTopics(node)) {
    if (!idx.topicIndex.has(t)) idx.topicIndex.set(t, new Set());
    idx.topicIndex.get(t)!.add(node.id);
  }
  if (!idx.typeIndex.has(node.type)) idx.typeIndex.set(node.type, new Set());
  idx.typeIndex.get(node.type)!.add(node.id);
  if (!idx.podIndex.has(node.source_pod_id)) idx.podIndex.set(node.source_pod_id, new Set());
  idx.podIndex.get(node.source_pod_id)!.add(node.id);
  for (const ref of node.entity_refs ?? []) {
    if (!idx.entityIndex.has(ref.id)) idx.entityIndex.set(ref.id, new Set());
    idx.entityIndex.get(ref.id)!.add(node.id);
  }
  const searchText = `${node.summary} ${node.details} ${node.retrieval_text ?? ""} ${(node.entity_refs ?? []).map((r) => `${r.type} ${r.label ?? r.id}`).join(" ")}`;
  const kws = extractKeywords(searchText);
  idx.nodeKeywords.set(node.id, kws);
  for (const kw of kws) {
    if (!idx.keywordIndex.has(kw)) idx.keywordIndex.set(kw, new Set());
    idx.keywordIndex.get(kw)!.add(node.id);
  }
  const identifiers = extractRetrievalIdentifiers(searchText);
  idx.nodeIdentifiers.set(node.id, identifiers);
  for (const ident of identifiers) {
    if (!idx.identifierIndex.has(ident)) idx.identifierIndex.set(ident, new Set());
    idx.identifierIndex.get(ident)!.add(node.id);
  }
}

function _removeNodeFromIndexes(node: KnowledgeNode, idx: NodeIndexes): void {
  idx.nodeById.delete(node.id);
  for (const d of [...new Set([...normalizeTagList(node.domains), ...nodeScopes(node)])]) idx.domainIndex.get(d)?.delete(node.id);
  for (const t of nodeTopics(node)) idx.topicIndex.get(t)?.delete(node.id);
  idx.typeIndex.get(node.type)?.delete(node.id);
  idx.podIndex.get(node.source_pod_id)?.delete(node.id);
  for (const ref of node.entity_refs ?? []) idx.entityIndex.get(ref.id)?.delete(node.id);
  const kws = idx.nodeKeywords.get(node.id);
  if (kws) {
    for (const kw of kws) idx.keywordIndex.get(kw)?.delete(node.id);
  }
  idx.nodeKeywords.delete(node.id);
  const identifiers = idx.nodeIdentifiers.get(node.id);
  if (identifiers) {
    for (const ident of identifiers) idx.identifierIndex.get(ident)?.delete(node.id);
  }
  idx.nodeIdentifiers.delete(node.id);
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
  markSupersededEdges(graph.edges, graph.nodes);
  return {
    graph,
    hubIds: new Set(identifyHubs(graph)),
    analysisStale: false,
    retrievalTelemetryDirty: false,
    ...buildIndexes(graph.nodes),
  };
}

function persistGraph(orgId: string, state: OrgGraphState): void {
  saveGraph(orgId, state.graph);
  state.retrievalTelemetryDirty = false;
}

// --- Initialization ---

export function initializeKnowledgeGraph(orgId: string): void {
  const graph = loadGraph(orgId) ?? emptyGraph(orgId);
  const state = buildState(graph);
  orgStates.set(orgId, state);
  console.log(
    `[knowledge-graph] Loaded graph for org "${orgId}": ${graph.nodes.length} nodes, ${graph.edges.length} edges`,
  );

  const staleEmbeddingCount = graph.nodes.filter((n) => !n.embedding || n.embedding_text_hash !== embeddingTextHash(embedText(n))).length;
  if (!legacyMemoryWritesFrozen() && staleEmbeddingCount > 0 && isEmbeddingAvailable()) {
    console.log(`[knowledge-graph] Scheduling background embedding backfill for ${staleEmbeddingCount} nodes (org "${orgId}")`);
    const stagedNodes = graph.nodes.map((node) => ({ ...node }));
    // Fire-and-forget: does not block server startup
    batchEmbedWithRateLimit(stagedNodes, () => {
      if (legacyMemoryWritesFrozen()) return;
      let changed = false;
      for (const stagedNode of stagedNodes) {
        const liveNode = state.nodeById.get(stagedNode.id);
        if (!liveNode || !stagedNode.embedding || !stagedNode.embedding_text_hash) continue;
        if (stagedNode.embedding_text_hash !== embeddingTextHash(embedText(liveNode))) continue;
        liveNode.embedding = stagedNode.embedding;
        liveNode.embedding_text_hash = stagedNode.embedding_text_hash;
        changed = true;
      }
      if (changed) persistGraph(orgId, state);
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
  compactContextConfigCache = null;
}

export interface LoadGraphForOfflineEvaluationOptions {
  allowUnsafeOrgId?: boolean;
  allowReplacingLoadedOrg?: boolean;
}

function isOfflineEvaluationOrgId(orgId: string): boolean {
  return /(?:^|[-_])(eval|test|golden|offline)(?:$|[-_])/.test(orgId);
}

/** Test/eval helper: load a frozen graph into memory without touching persistent storage. */
export function loadGraphForOfflineEvaluation(
  graph: KnowledgeGraph,
  options: LoadGraphForOfflineEvaluationOptions = {},
): void {
  if (!options.allowUnsafeOrgId && !isOfflineEvaluationOrgId(graph.org_id)) {
    throw new Error(`Refusing to load offline evaluation graph for non-eval org "${graph.org_id}"`);
  }
  if (orgStates.has(graph.org_id) && !options.allowReplacingLoadedOrg && !isOfflineEvaluationOrgId(graph.org_id)) {
    throw new Error(`Refusing to replace loaded graph state for org "${graph.org_id}" during offline evaluation`);
  }
  orgStates.set(graph.org_id, buildState(structuredClone(graph)));
}

// --- Token Estimation ---

// ~4 chars/token is the Anthropic rule-of-thumb. We measure actual node content
// because real summaries vary 30–1500+ chars and details swing wider still; a
// flat per-node constant lets queryKnowledge admit ~2x its declared max_tokens
// worth of content when include_details=true.
const CHARS_PER_TOKEN = 4;
const TOKENS_PER_EDGE = 10;
/** Aligns with ad-hoc submission default (0.7) so submit_knowledge_learning nodes are queryable. */
const DEFAULT_CONFIDENCE_MIN = 0.7;
const DEFAULT_QUERY_MAX_TOKENS = 2000;
const DEFAULT_COMPACT_CONTEXT_TOP_N = 3;
const DEFAULT_COMPACT_CONTEXT_MAX_CHARS = 1_000;
/** Retrieval depth is intentionally separate from the compact prompt-context depth. */
const DEFAULT_TASK_RELEVANT_CANDIDATE_LIMIT = 15;
const DEFAULT_TASK_RELEVANT_MAX_TOKENS = 2_000;
/** Minimum share of query keywords that must appear on a node to bypass the cosine gate. */
const KEYWORD_OVERLAP_GATE_RATIO = 0.5;
/** Minimum absolute keyword hits (when the query has many terms). */
const KEYWORD_OVERLAP_GATE_MIN_HITS = 2;
const KEYWORD_OVERLAP_GATE_STRONG_ABSOLUTE_HITS = 4;
const HTTP_METHOD_KEYWORDS = new Set(["get", "post", "put", "patch", "delete"]);
const HTTP_CONTRACT_CONTEXT_FRAGMENTS = [
  "api",
  "contract",
  "endpoint",
  "http",
  "openapi",
  "payload",
  "request",
  "response",
  "rest",
  "route",
];
const LOW_SIGNAL_QUERY_KEYWORDS = new Set([
  "about",
  "current",
  "does",
  "existing",
  "explain",
  "how",
  "implemented",
  "implementation",
  "status",
  "using",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "work",
  "works",
]);
const RARE_KEYWORD_RECALL_MAX_TERMS = 3;
const RARE_KEYWORD_RECALL_MAX_ABSOLUTE_MATCHES = 3;
const RARE_KEYWORD_RECALL_MAX_GRAPH_SHARE = 0.02;
const GENERIC_TASK_IDENTIFIER_MAX_LENGTH = 3;
const WEAK_SEMANTIC_SIGNAL_THRESHOLD = 0.45;
const GENERIC_IDENTIFIER_SUPPORT_MIN_KEYWORD_HITS = 2;
const TASK_RECALL_TAIL_MIN_SIMILARITY = 0.27;
const WEAK_HYBRID_AGREEMENT_BONUS = 0.045;

function hasUsableEmbedding(value: number[] | null | undefined): value is number[] {
  return Array.isArray(value) && value.length > 0;
}

function hasCompatibleEmbeddings(
  queryEmbedding: number[] | null | undefined,
  nodeEmbedding: number[] | null | undefined,
): queryEmbedding is number[] {
  return hasUsableEmbedding(queryEmbedding) &&
    hasUsableEmbedding(nodeEmbedding) &&
    queryEmbedding.length === nodeEmbedding.length;
}

function estimateNodeTokens(node: KnowledgeNode, includeDetails: boolean): number {
  const chars = node.summary.length + (includeDetails ? node.details.length : 0);
  return Math.max(1, Math.ceil(chars / CHARS_PER_TOKEN));
}

/** Omit embedding from serialized query results unless explicitly requested (debug). */
function omitEmbeddingForResponse(node: KnowledgeNode): KnowledgeNode {
  const { embedding: _, ...rest } = node;
  return rest as KnowledgeNode;
}

/**
 * Returns a shallow-cloned graph with every node's `embedding` field omitted. The in-memory
 * state is untouched. Used to shape the UI-facing /api/knowledge/graph response so a 512-dim
 * vector (~2 KB/node) is not shipped for every node when only the structure is needed.
 *
 * Callers that genuinely need embeddings (MCP resource clients doing client-side similarity)
 * opt in via the include_embeddings query param at the route layer.
 */
export function stripEmbeddingsFromGraph(graph: KnowledgeGraph): KnowledgeGraph {
  return {
    ...graph,
    nodes: graph.nodes.map(omitEmbeddingForResponse),
  };
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

async function refreshNodeEmbedding(node: KnowledgeNode, clearOnFailure = false): Promise<void> {
  const text = embedText(node);
  const embedding = await generateEmbedding(text);
  if (embedding) {
    node.embedding = embedding;
    node.embedding_text_hash = embeddingTextHash(text);
    return;
  }
  if (clearOnFailure) {
    delete node.embedding;
    delete node.embedding_text_hash;
  }
}

function isVisibilityChangingEdge(edge: KnowledgeEdge): boolean {
  return edge.type === "supersedes" || edge.type === "contradicts" || edge.type === "resolved_by";
}

function isLegacyResolvedByEdge(edge: KnowledgeEdge): boolean {
  return edge.type === "resolved_by" && !edge.inferred && edge.reason === undefined && edge.confidence_score === undefined;
}

function edgeHasEvidenceOrCuration(edge: KnowledgeEdge, nodeById: Map<string, KnowledgeNode>): boolean {
  if (!isVisibilityChangingEdge(edge)) return true;
  if (isLegacyResolvedByEdge(edge)) return true;
  const hasRequiredMetadata = Boolean(edge.reason?.trim()) && typeof edge.confidence_score === "number";
  if (!hasRequiredMetadata) return false;
  const hasEvidence = Boolean(edge.source_update_refs?.length || edge.artifact_refs?.length);
  const source = nodeById.get(edge.source);
  const target = nodeById.get(edge.target);
  const hasCuration = Boolean(source?.curated || target?.curated);
  return hasEvidence || hasCuration;
}

// P1: After edges are built, mark older nodes whose decisions were superseded.
function markSupersededEdges(edges: KnowledgeEdge[], allNodes: KnowledgeNode[]): void {
  const supersededBy = new Map<string, string>();
  for (const edge of edges) {
    if (edge.type === "supersedes" && !supersededBy.has(edge.target)) {
      supersededBy.set(edge.target, edge.source);
    }
  }
  for (const node of allNodes) {
    const source = supersededBy.get(node.id);
    node.superseded_by = source;
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
  assertLegacyMemoryWritable("knowledge_graph_ingestion");
  const state = getOrgState(orgId);
  const { graph } = state;

  const now = new Date().toISOString();
  const newNodes: KnowledgeNode[] = [];
  let skipped = 0;
  let droppedUntagged = 0;

  for (const learning of learnings) {
    const explicitScopes = normalizeTagList(learning.scopes);
    const explicitDomains = normalizeTagList(learning.domains);
    const scopes = explicitScopes.length > 0 ? explicitScopes : explicitDomains;
    const domains = explicitDomains.length > 0 ? explicitDomains : scopes;
    if (domains.length === 0) {
      droppedUntagged++;
      continue;
    }
    const topics = normalizeTagList(
      learning.topics?.length
        ? learning.topics
        : keywordsFromTexts([learning.summary, learning.details, learning.retrieval_text ?? ""], 12),
    );
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
      ...(learning.audience ? { audience: learning.audience } : {}),
      ...(learning.provenance ? { provenance: learning.provenance } : {}),
      scopes,
      topics,
      domains,
      confidence: learning.confidence,
      confidence_score: learning.confidence_score,
      created_at: now,
      curated: false,
      retrieval_tier: "hot",
      retention_score: Math.max(0.5, learning.confidence_score),
      retrieval_count: 0,
      ...(learning.ingestion_provenance ? { ingestion_provenance: learning.ingestion_provenance } : {}),
    };

    const memory = buildKnowledgeNodeMemory({ node, orgId });
    node.retrieval_text = learning.retrieval_text ?? memory.retrieval_text;
    node.entity_refs = learning.entity_refs ?? memory.entity_refs;
    await refreshNodeEmbedding(node);

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
      const dedupScopes = nodeScopes(node);
      const dedupCandidates = dedupScopes.length > 0
        ? [...new Set(dedupScopes.flatMap((d) => [...(state.domainIndex.get(d) ?? [])]))]
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
  if (droppedUntagged > 0) {
    console.warn(`[knowledge-graph] Dropped ${droppedUntagged} unscoped node(s) during ingestion for pod "${podId}" (org "${orgId}")`);
  }

  if (newNodes.length === 0) {
    return { nodesAdded: 0, edgesAdded: 0, nodeIds: [] };
  }

  assertLegacyMemoryWritable("knowledge_graph_ingestion");

  // P3: Pass existing edges so buildEdges won't create duplicate edges for node pairs already connected.
  const newEdges = buildEdges(newNodes, graph.nodes, graph.edges);
  const intraEdges = buildEdges(newNodes, newNodes, [...graph.edges, ...newEdges]);

  graph.nodes.push(...newNodes);
  for (const node of newNodes) _indexNode(node, state);
  graph.edges.push(...newEdges, ...intraEdges);

  // P1: Mark older nodes that are superseded by newly added ones.
  markSupersededEdges(graph.edges, graph.nodes);

  graph.version++;
  graph.updated_at = now;

  if (options.skipAnalysis) {
    state.analysisStale = true;
  } else {
    graph.communities = detectCommunities(graph);
    state.hubIds = new Set(identifyHubs(graph));
    state.analysisStale = false;
  }

  persistGraph(orgId, state);

  return {
    nodesAdded: newNodes.length,
    edgesAdded: newEdges.length + intraEdges.length,
    nodeIds: newNodes.map((n) => n.id),
  };
}

// --- Query Knowledge ---

function isHighSignalQueryKeyword(value: string): boolean {
  const term = value.toLowerCase().trim();
  return term.length > 2 && !LOW_SIGNAL_QUERY_KEYWORDS.has(term);
}

function queryKeywordsFromText(queryText?: string): string[] {
  if (!queryText) return [];
  const keywords = keywordsFromTexts([queryText]);
  return keywords.length <= RARE_KEYWORD_RECALL_MAX_TERMS
    ? keywords.filter(isHighSignalQueryKeyword)
    : keywords;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = value.toLowerCase().trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function mergeScoringKeywords(filters: KnowledgeQueryOptions["filters"], queryText?: string): string[] {
  const fromExplicit =
    filters.keywords?.map((k) => k.toLowerCase().trim()).filter((k) => k.length > 2) ?? [];
  const fromTextSearch = filters.text_search
    ? filters.text_search
        .split(/\s+/)
        .filter((w) => w.length > 2)
        .map((w) => w.toLowerCase())
    : [];
  const fromQueryText = queryKeywordsFromText(queryText);
  const identifiers = queryText ? [...extractRetrievalIdentifiers(queryText)] : [];
  return uniqueStrings([...fromExplicit, ...fromTextSearch, ...fromQueryText, ...identifiers]);
}

function mergeQueryIdentifiers(filters: KnowledgeQueryOptions["filters"], queryText?: string): string[] {
  const text = [
    queryText,
    filters.text_search,
    ...(filters.keywords ?? []),
  ].filter(Boolean).join(" ");
  return [...extractRetrievalIdentifiers(text)];
}

interface QuerySignalPlan {
  strongIdentifiers: string[];
  genericIdentifiers: string[];
  rareKeywords: string[];
  recallIds: Set<string>;
  forceLexicalRecall: boolean;
}

function isGenericTaskIdentifier(identifier: string): boolean {
  const normalized = identifier.toLowerCase().trim();
  return (
    normalized.length >= 2 &&
    normalized.length <= GENERIC_TASK_IDENTIFIER_MAX_LENGTH &&
    /^[a-z][a-z0-9]*$/.test(normalized)
  );
}

function shouldForceLexicalRecall(keywords: string[], identifiers: string[]): boolean {
  if (identifiers.length > 0) {
    return identifiers.length <= 3 && keywords.length <= 8;
  }
  return keywords.length > 0 && keywords.length <= RARE_KEYWORD_RECALL_MAX_TERMS;
}

function rareQueryKeywords(
  state: OrgGraphState,
  keywords: string[],
  strongIdentifiers: string[],
  genericIdentifiers: string[],
  forceLexicalRecall: boolean,
): string[] {
  if (!forceLexicalRecall) return [];
  const highSignalKeywords = keywords.filter(isHighSignalQueryKeyword);
  if (highSignalKeywords.length === 0 || highSignalKeywords.length > RARE_KEYWORD_RECALL_MAX_TERMS) return [];

  const strongIdentifierSet = new Set(strongIdentifiers);
  const genericIdentifierSet = new Set(genericIdentifiers);
  const graphSize = Math.max(1, state.graph.nodes.length);
  const maxMatches = Math.max(
    RARE_KEYWORD_RECALL_MAX_ABSOLUTE_MATCHES,
    Math.ceil(graphSize * RARE_KEYWORD_RECALL_MAX_GRAPH_SHARE),
  );

  return uniqueStrings(highSignalKeywords).filter((keyword) => {
    if (genericIdentifierSet.has(keyword)) return false;
    if (strongIdentifierSet.has(keyword)) return true;
    const matches = state.keywordIndex.get(keyword);
    return !!matches && matches.size > 0 && matches.size <= maxMatches;
  });
}

function buildQuerySignalPlan(
  state: OrgGraphState,
  keywords: string[],
  identifiers: string[],
): QuerySignalPlan {
  const queryIdentifiers = uniqueStrings(identifiers);
  const strongIdentifiers = queryIdentifiers.filter((identifier) => !isGenericTaskIdentifier(identifier));
  const genericIdentifiers = queryIdentifiers.filter(isGenericTaskIdentifier);
  const forceLexicalRecall = shouldForceLexicalRecall(keywords, queryIdentifiers);
  const rareKeywords = rareQueryKeywords(state, keywords, strongIdentifiers, genericIdentifiers, forceLexicalRecall);
  const recallIds = new Set<string>();

  for (const identifier of queryIdentifiers) {
    for (const id of state.identifierIndex.get(identifier) ?? []) recallIds.add(id);
    for (const id of state.keywordIndex.get(identifier) ?? []) recallIds.add(id);
  }
  for (const keyword of rareKeywords) {
    for (const id of state.keywordIndex.get(keyword) ?? []) recallIds.add(id);
  }

  return { strongIdentifiers, genericIdentifiers, rareKeywords, recallIds, forceLexicalRecall };
}

function hasExactShortKeywordMatch(nodeKeywords: Set<string> | undefined, keywords: string[]): boolean {
  if (!nodeKeywords || keywords.length === 0 || keywords.length > 2) return false;
  return keywords.every((kw) => nodeKeywords.has(kw.toLowerCase()));
}

function countKeywordMatches(nodeKeywords: Set<string> | undefined, keywords: string[]): number {
  if (!nodeKeywords || keywords.length === 0) return 0;
  let hits = 0;
  for (const kw of keywords) {
    if (nodeKeywords.has(kw.toLowerCase())) hits++;
  }
  return hits;
}

function highSignalKeywordsForScoring(keywords: string[]): string[] {
  const highSignalKeywords = keywords.filter(isHighSignalQueryKeyword);
  return highSignalKeywords.length > 0 ? highSignalKeywords : keywords;
}

function countIdentifierMatches(nodeIdentifiers: Set<string> | undefined, identifiers: string[]): number {
  if (!nodeIdentifiers || identifiers.length === 0) return 0;
  let hits = 0;
  for (const ident of identifiers) {
    if (nodeIdentifiers.has(ident.toLowerCase())) hits++;
  }
  return hits;
}

function hasHttpContractContext(keywords: string[], identifiers: string[]): boolean {
  if (!keywords.some((kw) => HTTP_METHOD_KEYWORDS.has(kw.toLowerCase()))) return false;
  return [...keywords, ...identifiers].some((value) => {
    const signal = value.toLowerCase();
    return (
      /^(?:get|post|put|patch|delete)\s+\//.test(signal) ||
      HTTP_CONTRACT_CONTEXT_FRAGMENTS.some((fragment) => signal.includes(fragment))
    );
  });
}

function countHttpContractMethodMatches(
  nodeKeywords: Set<string> | undefined,
  keywords: string[],
  identifiers: string[],
): number {
  if (!nodeKeywords || !hasHttpContractContext(keywords, identifiers)) return 0;
  let hits = 0;
  for (const method of HTTP_METHOD_KEYWORDS) {
    if (keywords.some((kw) => kw.toLowerCase() === method) && nodeKeywords.has(method)) hits++;
  }
  return hits;
}

function sourceAuthorityScore(node: KnowledgeNode): number {
  let score = 0;
  if (node.curated) score += 0.12;
  if (node.ingestion_provenance?.kind === "project_evidence") score += 0.08;
  if (node.ingestion_provenance?.kind === "agent_run") score += 0.06;
  if (node.ingestion_provenance?.kind === "scheduled_synthesis") score += 0.04;
  if (node.audience === "project") score += 0.03;
  return score;
}

function retrievalTierScore(node: KnowledgeNode): number {
  if (node.retrieval_tier === "hot" || node.retrieval_tier === undefined) return 0.04;
  if (node.retrieval_tier === "warm") return 0.01;
  return -0.08;
}

/** Lets keyword-strong or short exact matches through the cosine gate (incl. unembedded nodes). */
function passesSemanticRelevanceGate(
  nodeKeywords: Set<string> | undefined,
  keywords: string[],
  identifierHits: number,
  querySimilarity: number | undefined,
  minQuerySimilarity: number,
): boolean {
  const kwHits = countKeywordMatches(nodeKeywords, keywords);
  if (identifierHits >= 2 && (kwHits > 0 || (querySimilarity !== undefined && querySimilarity >= minQuerySimilarity))) {
    return true;
  }
  if (
    identifierHits === 1 &&
    (kwHits >= KEYWORD_OVERLAP_GATE_MIN_HITS ||
      (querySimilarity !== undefined && querySimilarity >= Math.max(0.45, minQuerySimilarity - 0.25)))
  ) {
    return true;
  }
  if (hasExactShortKeywordMatch(nodeKeywords, keywords)) return true;
  if (querySimilarity !== undefined && querySimilarity >= minQuerySimilarity) return true;

  if (kwHits === 0 || keywords.length === 0) return false;
  if (keywords.length <= 2) return kwHits === keywords.length;
  if (
    keywords.length > 8 &&
    (kwHits >= KEYWORD_OVERLAP_GATE_STRONG_ABSOLUTE_HITS + 1 ||
      (kwHits >= KEYWORD_OVERLAP_GATE_STRONG_ABSOLUTE_HITS && (querySimilarity ?? 0) >= 0.25))
  ) {
    return true;
  }
  return kwHits >= KEYWORD_OVERLAP_GATE_MIN_HITS && kwHits / keywords.length >= KEYWORD_OVERLAP_GATE_RATIO;
}

type ScoredNode = {
  node: KnowledgeNode;
  querySimilarity?: number;
  exactShortKeywordMatch: boolean;
  keywordHits: number;
  nonGenericKeywordHits: number;
  identifierHits: number;
  strongIdentifierHits: number;
  genericIdentifierHits: number;
  rareKeywordHits: number;
  lexicalRecallHits: number;
  idfWeightedCoverage: number;
  summaryCoverage: number;
  phraseMatch: number;
  orderedGenericIdentifierMatch: boolean;
  score: number;
  scoreComponents: NonNullable<KnowledgeRetrievalExplanation["score_components"]>;
  graphExpanded?: boolean;
  semanticRelevance?: boolean;
  directEvidence?: boolean;
  recallCandidate?: boolean;
  requiredPin?: boolean;
};

interface LexicalSpecificity {
  idfWeightedCoverage: number;
  summaryCoverage: number;
  phraseMatch: number;
  orderedGenericIdentifierMatch: boolean;
  score: number;
}

function normalizedPhraseText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Preserve query order while admitting guarded identifiers that keyword extraction drops. */
function orderedSpecificityTerms(queryText: string | undefined): string[] {
  if (!queryText?.trim()) return [];
  const identifierTerms = new Set(
    [...extractRetrievalIdentifiers(queryText)]
      .flatMap((identifier) => normalizedPhraseText(identifier).split(" "))
      .filter(Boolean),
  );
  return uniqueStrings(
    normalizedPhraseText(queryText)
      .split(" ")
      .filter((term) => isHighSignalQueryKeyword(term) || identifierTerms.has(term)),
  );
}

function longestQueryPhraseMatch(queryText: string | undefined, node: KnowledgeNode): number {
  if (!queryText?.trim()) return 0;
  const terms = highSignalKeywordsForScoring(queryKeywordsFromText(queryText));
  if (terms.length < 2) return 0;
  const summary = normalizedPhraseText(node.summary);
  const fullText = normalizedPhraseText(`${node.summary} ${node.details} ${node.retrieval_text ?? ""}`);
  const maxLength = Math.min(5, terms.length);
  for (let length = maxLength; length >= 2; length--) {
    for (let offset = 0; offset <= terms.length - length; offset++) {
      const phrase = normalizedPhraseText(terms.slice(offset, offset + length).join(" "));
      // A two-word phrase is useful but common; reserve the full boost for
      // longer contiguous task language so incidental pairs do not dominate.
      if (summary.includes(phrase)) return Math.min(1, (length - 1) * 0.25);
      if (fullText.includes(phrase)) return Math.min(0.8, 0.15 + (length - 2) * 0.2);
    }
  }
  return 0;
}

function hasOrderedGenericIdentifierContext(
  queryText: string | undefined,
  node: KnowledgeNode,
  genericIdentifiers: string[],
): boolean {
  if (!queryText?.trim() || genericIdentifiers.length === 0) return false;
  const genericSet = new Set(genericIdentifiers);
  const terms = orderedSpecificityTerms(queryText);
  // This signal protects concise identifier-qualified lookups. On long task
  // prose, incidental adjacent pairs must not become a broad rank boost.
  if (terms.length < 2 || terms.length > 4) return false;
  const summary = normalizedPhraseText(node.summary);
  const fullText = normalizedPhraseText(`${node.summary} ${node.details} ${node.retrieval_text ?? ""}`);

  for (let index = 0; index < terms.length - 1; index++) {
    const left = terms[index];
    const right = terms[index + 1];
    const hasGenericIdentifier = genericSet.has(left) || genericSet.has(right);
    const hasSupportingTerm = !genericSet.has(left) || !genericSet.has(right);
    if (!hasGenericIdentifier || !hasSupportingTerm) continue;
    const phrase = `${left} ${right}`;
    if (summary.includes(phrase) || fullText.includes(phrase)) return true;
  }
  return false;
}

/**
 * IDF-weighted query coverage plus field/phrase boosts. This is deliberately
 * bounded and additive: embeddings remain the primary semantic signal, while
 * distinctive exact language can outrank broad, high-confidence guidance.
 */
function lexicalSpecificity(
  node: KnowledgeNode,
  state: OrgGraphState,
  keywords: string[],
  queryText: string | undefined,
  genericIdentifiers: string[],
): LexicalSpecificity {
  const uniqueKeywords = uniqueStrings(keywords);
  const orderedGenericIdentifierMatch = hasOrderedGenericIdentifierContext(
    queryText,
    node,
    genericIdentifiers,
  );
  const phraseMatch = Math.max(
    longestQueryPhraseMatch(queryText, node),
    orderedGenericIdentifierMatch ? 0.25 : 0,
  );
  if (uniqueKeywords.length === 0) {
    return {
      idfWeightedCoverage: 0,
      summaryCoverage: 0,
      phraseMatch,
      orderedGenericIdentifierMatch,
      score: phraseMatch * 0.14,
    };
  }
  const graphSize = Math.max(1, state.graph.nodes.length);
  const nodeKeywords = state.nodeKeywords.get(node.id) ?? new Set<string>();
  const summaryKeywords = extractKeywords(node.summary);
  let totalWeight = 0;
  let matchedWeight = 0;
  let summaryWeight = 0;
  for (const keyword of uniqueKeywords) {
    const documentFrequency = state.keywordIndex.get(keyword)?.size ?? 0;
    const idf = Math.log(1 + (graphSize + 1) / (documentFrequency + 1));
    totalWeight += idf;
    if (!nodeKeywords.has(keyword)) continue;
    matchedWeight += idf;
    if (summaryKeywords.has(keyword)) summaryWeight += idf;
  }
  const idfWeightedCoverage = totalWeight > 0 ? matchedWeight / totalWeight : 0;
  const summaryCoverage = totalWeight > 0 ? summaryWeight / totalWeight : 0;
  return {
    idfWeightedCoverage,
    summaryCoverage,
    phraseMatch,
    orderedGenericIdentifierMatch,
    score: idfWeightedCoverage * 0.24 + summaryCoverage * 0.12 + phraseMatch * 0.14,
  };
}

function identifierMatchScore(identifierHits: number): number {
  if (identifierHits <= 0) return 0;
  // One exact identifier is already a strong signal. Additional identifiers
  // have diminishing value so long/noisy queries cannot dominate merely by
  // colliding with several common symbols.
  return 0.22 + Math.min(identifierHits - 1, 2) * 0.09 + Math.max(0, identifierHits - 3) * 0.03;
}

function semanticMatchScore(querySimilarity: number | undefined): number {
  return (querySimilarity ?? 0) >= 0.75 ? 0.08 : 0;
}

function directEvidenceBonus(querySimilarity: number | undefined, keywordHits: number, identifierHits: number): number {
  let bonus = 0;
  if (identifierHits > 0 && keywordHits >= 4 && (querySimilarity ?? 0) >= 0.4) bonus += 0.2;
  if (identifierHits === 0 && keywordHits >= 4 && (querySimilarity ?? 0) >= 0.25) {
    bonus += 0.12;
  } else if (
    identifierHits === 0 &&
    keywordHits >= 3 &&
    (querySimilarity ?? 0) >= TASK_RECALL_TAIL_MIN_SIMILARITY
  ) {
    bonus += WEAK_HYBRID_AGREEMENT_BONUS;
  }
  return bonus;
}

function lexicalRecallScore(identifierHits: number, rareKeywordHits: number, lexicalRecall: boolean): number {
  if (!lexicalRecall) return 0;
  const identifierScore = Math.min(identifierHits, 2) * 0.45;
  const rareKeywordScore = Math.min(rareKeywordHits, 2) * 0.3;
  return Math.min(0.95, 0.2 + identifierScore + rareKeywordScore);
}

function scoreCandidates(
  candidates: KnowledgeNode[],
  state: OrgGraphState,
  scopes: string[],
  keywords: string[],
  identifiers: string[],
  querySignals: QuerySignalPlan,
  queryText: string | undefined,
  queryEmbedding: number[] | null | undefined,
  hubIds: Set<string>,
  graphTuning: ReturnType<typeof getOrgTuning>["graphScoring"],
): ScoredNode[] {
  const scoringKeywords = highSignalKeywordsForScoring(keywords);
  const genericIdentifierSet = new Set(querySignals.genericIdentifiers);
  const nonGenericScoringKeywords = scoringKeywords.filter((keyword) => !genericIdentifierSet.has(keyword));
  const lexicalRecallIdentifiers = [...querySignals.strongIdentifiers, ...querySignals.genericIdentifiers];
  return candidates.map((node) => {
    const precomputedKeywords = state.nodeKeywords.get(node.id);
    const precomputedIdentifiers = state.nodeIdentifiers.get(node.id);
    const querySimilarity = hasCompatibleEmbeddings(queryEmbedding, node.embedding)
      ? cosineSimilarity(queryEmbedding, node.embedding!)
      : undefined;
    const identifierHits = countIdentifierMatches(precomputedIdentifiers, identifiers);
    const strongIdentifierHits = countIdentifierMatches(precomputedIdentifiers, querySignals.strongIdentifiers);
    const genericIdentifierHits = countIdentifierMatches(precomputedIdentifiers, querySignals.genericIdentifiers);
    const keywordHits = countKeywordMatches(precomputedKeywords, scoringKeywords);
    const nonGenericKeywordHits = countKeywordMatches(precomputedKeywords, nonGenericScoringKeywords);
    const lexicalIdentifierHits = countIdentifierMatches(precomputedIdentifiers, lexicalRecallIdentifiers);
    const rareKeywordHits = countKeywordMatches(precomputedKeywords, querySignals.rareKeywords);
    const lexicalRecall = querySignals.forceLexicalRecall && querySignals.recallIds.has(node.id);
    const lexicalRecallHits = lexicalRecall ? Math.max(1, lexicalIdentifierHits, rareKeywordHits) : 0;
    const specificity = lexicalSpecificity(
      node,
      state,
      scoringKeywords,
      queryText,
      querySignals.genericIdentifiers,
    );
    const genericIdentifierSupported =
      specificity.orderedGenericIdentifierMatch ||
      rareKeywordHits > 0 ||
      (querySimilarity ?? 0) >= WEAK_SEMANTIC_SIGNAL_THRESHOLD ||
      nonGenericKeywordHits >= GENERIC_IDENTIFIER_SUPPORT_MIN_KEYWORD_HITS;
    const scoringIdentifierHits =
      strongIdentifierHits +
      (genericIdentifierSupported ? genericIdentifierHits : 0) +
      countHttpContractMethodMatches(precomputedKeywords, scoringKeywords, identifiers);
    const scoreComponents: ScoredNode["scoreComponents"] = {
      base_relevance: scoreRelevance(
        node,
        { scopes, keywords: scoringKeywords, querySimilarity, precomputedKeywords },
        hubIds,
        graphTuning,
      ),
      semantic_match: semanticMatchScore(querySimilarity),
      identifier_match: identifierMatchScore(scoringIdentifierHits),
      direct_evidence: directEvidenceBonus(querySimilarity, keywordHits, scoringIdentifierHits),
      lexical_recall: lexicalRecallScore(lexicalIdentifierHits, rareKeywordHits, lexicalRecall),
      lexical_specificity: specificity.score,
      source_authority: sourceAuthorityScore(node),
      retrieval_tier: retrievalTierScore(node),
    };
    return {
      node,
      querySimilarity,
      exactShortKeywordMatch: hasExactShortKeywordMatch(precomputedKeywords, scoringKeywords),
      keywordHits,
      nonGenericKeywordHits,
      identifierHits,
      strongIdentifierHits,
      genericIdentifierHits,
      rareKeywordHits,
      lexicalRecallHits,
      idfWeightedCoverage: specificity.idfWeightedCoverage,
      summaryCoverage: specificity.summaryCoverage,
      phraseMatch: specificity.phraseMatch,
      orderedGenericIdentifierMatch: specificity.orderedGenericIdentifierMatch,
      score:
        scoreComponents.base_relevance +
        scoreComponents.semantic_match +
        scoreComponents.identifier_match +
        scoreComponents.direct_evidence +
        scoreComponents.lexical_recall +
        scoreComponents.lexical_specificity +
        scoreComponents.source_authority +
        scoreComponents.retrieval_tier,
      scoreComponents,
    };
  });
}

function passesScalarQueryFilters(
  node: KnowledgeNode,
  filters: KnowledgeQueryOptions["filters"],
  mode: NonNullable<KnowledgeQueryOptions["query_mode"]>,
  asOf: string | undefined,
  state: OrgGraphState,
): boolean {
  if (filters.source_project_ids?.length) {
    if (!node.source_project_id || !filters.source_project_ids.includes(node.source_project_id)) return false;
  }
  if (filters.include_project_id) {
    if (node.source_project_id && node.source_project_id !== filters.include_project_id) return false;
  }
  if (node.confidence_score < (filters.confidence_min ?? DEFAULT_CONFIDENCE_MIN)) return false;
  if (filters.curated_only && !node.curated) return false;
  return visibleForQueryMode(node, state, mode, asOf, filters);
}

function hasAnyValue(values: readonly string[], allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return values.some((value) => allowedSet.has(value));
}

/** Apply the indexed dimensions to graph-expanded or explicitly pinned nodes too. */
function passesIndexedQueryFilters(
  node: KnowledgeNode,
  filters: KnowledgeQueryOptions["filters"],
  state: OrgGraphState,
): boolean {
  const scopeFilters = filters.scopes?.length ? filters.scopes : filters.domains;
  if (scopeFilters?.length && !hasAnyValue(nodeScopes(node), scopeFilters)) return false;
  if (filters.topics?.length && !hasAnyValue(nodeTopics(node), filters.topics)) return false;
  if (filters.types?.length && !filters.types.includes(node.type)) return false;
  if (filters.source_pod_ids?.length && !filters.source_pod_ids.includes(node.source_pod_id)) return false;

  if (filters.text_search) {
    const queryKeywords = extractKeywords(filters.text_search);
    const queryIdentifiers = extractRetrievalIdentifiers(filters.text_search);
    if (queryKeywords.size > 0 || queryIdentifiers.size > 0) {
      const indexedKeywords = state.nodeKeywords.get(node.id) ?? new Set<string>();
      const indexedIdentifiers = state.nodeIdentifiers.get(node.id) ?? new Set<string>();
      const keywordMatch = [...queryKeywords].some((keyword) => indexedKeywords.has(keyword));
      const identifierMatch = [...queryIdentifiers].some((identifier) => indexedIdentifiers.has(identifier));
      if (!keywordMatch && !identifierMatch) return false;
    }
  }
  return true;
}

function passesAllQueryFilters(
  node: KnowledgeNode,
  filters: KnowledgeQueryOptions["filters"],
  mode: NonNullable<KnowledgeQueryOptions["query_mode"]>,
  asOf: string | undefined,
  state: OrgGraphState,
): boolean {
  return passesIndexedQueryFilters(node, filters, state) &&
    passesScalarQueryFilters(node, filters, mode, asOf, state);
}

function withRequiredPin(entry: ScoredNode): ScoredNode {
  const finalScore = Math.max(entry.score, 10);
  const requiredPin = finalScore - entry.score;
  return {
    ...entry,
    score: finalScore,
    scoreComponents: {
      ...entry.scoreComponents,
      required_pin: (entry.scoreComponents.required_pin ?? 0) + requiredPin,
    },
    requiredPin: true,
  };
}

function pinRequiredScoredNodes(
  scored: ScoredNode[],
  state: OrgGraphState,
  requiredNodeIds: readonly string[] | undefined,
  filters: KnowledgeQueryOptions["filters"],
  mode: NonNullable<KnowledgeQueryOptions["query_mode"]>,
  asOf: string | undefined,
  scopes: string[],
  keywords: string[],
  identifiers: string[],
  querySignals: QuerySignalPlan,
  queryText: string | undefined,
  queryEmbedding: number[] | null | undefined,
  hubIds: Set<string>,
  graphTuning: ReturnType<typeof getOrgTuning>["graphScoring"],
): ScoredNode[] {
  if (!requiredNodeIds?.length) return scored;
  const byId = new Map(scored.map((entry) => [entry.node.id, entry]));
  const requiredSet = new Set(requiredNodeIds);
  const boosted = scored.map((entry) =>
    requiredSet.has(entry.node.id) ? withRequiredPin(entry) : entry,
  );
  const missingRequired = [...requiredSet]
    .filter((id) => !byId.has(id))
    .map((id) => state.nodeById.get(id))
    .filter((node): node is KnowledgeNode => !!node)
    .filter((node) => passesAllQueryFilters(node, filters, mode, asOf, state));
  if (missingRequired.length === 0) return boosted;
  const pinned = scoreCandidates(
    missingRequired,
    state,
    scopes,
    keywords,
    identifiers,
    querySignals,
    queryText,
    queryEmbedding,
    hubIds,
    graphTuning,
  ).map(withRequiredPin);
  return [...boosted, ...pinned];
}

function hasSemanticEvidence(scored: ScoredNode, minQuerySimilarity: number): boolean {
  return scored.querySimilarity !== undefined && scored.querySimilarity >= minQuerySimilarity;
}

function hasExactShortKeywordEvidence(
  scored: ScoredNode,
  scoringKeywords: string[],
  querySignals: QuerySignalPlan,
): boolean {
  if (!scored.exactShortKeywordMatch) return false;
  const genericIdentifierSet = new Set(querySignals.genericIdentifiers);
  if (scoringKeywords.some((keyword) => !genericIdentifierSet.has(keyword))) return true;
  return scored.strongIdentifierHits > 0 || scored.rareKeywordHits > 0;
}

function hasStrongKeywordOverlapEvidence(scored: ScoredNode, scoringKeywordCount: number): boolean {
  if (scoringKeywordCount === 0 || scored.keywordHits === 0) return false;
  if (scoringKeywordCount <= 2) {
    return scored.exactShortKeywordMatch && scored.nonGenericKeywordHits > 0;
  }
  if (scoringKeywordCount > 8) {
    return scored.keywordHits >= KEYWORD_OVERLAP_GATE_STRONG_ABSOLUTE_HITS + 1 ||
      (scored.keywordHits >= KEYWORD_OVERLAP_GATE_STRONG_ABSOLUTE_HITS && (scored.querySimilarity ?? 0) >= 0.25) ||
      (scored.keywordHits >= 3 && (scored.querySimilarity ?? 0) >= TASK_RECALL_TAIL_MIN_SIMILARITY);
  }
  return scored.keywordHits >= KEYWORD_OVERLAP_GATE_MIN_HITS &&
    scored.keywordHits / scoringKeywordCount >= KEYWORD_OVERLAP_GATE_RATIO;
}

function hasSupportedGenericIdentifierEvidence(scored: ScoredNode): boolean {
  if (scored.genericIdentifierHits === 0) return false;
  return (
    scored.orderedGenericIdentifierMatch ||
    scored.rareKeywordHits > 0 ||
    (scored.querySimilarity ?? 0) >= WEAK_SEMANTIC_SIGNAL_THRESHOLD ||
    scored.nonGenericKeywordHits >= GENERIC_IDENTIFIER_SUPPORT_MIN_KEYWORD_HITS
  );
}

function hasDirectTaskEvidence(
  scored: ScoredNode,
  scoringKeywords: string[],
  querySignals: QuerySignalPlan,
): boolean {
  if (scored.strongIdentifierHits > 0) return true;
  if (hasSupportedGenericIdentifierEvidence(scored)) return true;
  if (scored.lexicalRecallHits > 0 && scored.rareKeywordHits > 0) return true;
  if (hasExactShortKeywordEvidence(scored, scoringKeywords, querySignals)) return true;
  return hasStrongKeywordOverlapEvidence(scored, scoringKeywords.length);
}

function withTaskRelevanceEvidence(
  scored: ScoredNode,
  directEvidence: boolean,
  semanticRelevance: boolean,
): ScoredNode {
  if (scored.directEvidence === directEvidence && scored.semanticRelevance === semanticRelevance) return scored;
  return { ...scored, directEvidence, semanticRelevance };
}

function applySemanticGate(
  scored: ScoredNode[],
  state: OrgGraphState,
  keywords: string[],
  querySignals: QuerySignalPlan,
  queryEmbedding: number[] | null | undefined,
  minQuerySimilarity: number,
  strictTaskRelevance = false,
): ScoredNode[] {
  const scoringKeywords = highSignalKeywordsForScoring(keywords);
  const hasFilteredScoringKeywords =
    scoringKeywords.length !== keywords.length ||
    scoringKeywords.some((keyword, index) => keyword !== keywords[index]);
  const annotate = (entry: ScoredNode): ScoredNode => withTaskRelevanceEvidence(
    entry,
    hasDirectTaskEvidence(entry, scoringKeywords, querySignals),
    hasSemanticEvidence(entry, minQuerySimilarity),
  );

  if (!hasUsableEmbedding(queryEmbedding)) {
    // An embedding outage must degrade to lexical retrieval, not to a broad
    // scope-only dump. This applies to both direct queries and the strict task
    // contract; callers can still issue an intentional scope-only query by
    // omitting query_text entirely.
    return scored.map(annotate).filter((entry) => entry.directEvidence);
  }

  if (strictTaskRelevance) {
    return scored
      .map(annotate)
      .filter((entry) =>
        entry.directEvidence ||
        entry.semanticRelevance ||
        (entry.querySimilarity ?? 0) >= TASK_RECALL_TAIL_MIN_SIMILARITY,
      )
      .map((entry) =>
        entry.directEvidence || entry.semanticRelevance
          ? entry
          : { ...entry, recallCandidate: true },
      );
  }

  const gated = scored.filter(({ node, querySimilarity, identifierHits, lexicalRecallHits }) =>
    lexicalRecallHits > 0 ||
      passesSemanticRelevanceGate(
        state.nodeKeywords.get(node.id),
        keywords,
        identifierHits,
        querySimilarity,
        minQuerySimilarity,
      ) ||
      (hasFilteredScoringKeywords &&
        passesSemanticRelevanceGate(
          state.nodeKeywords.get(node.id),
          scoringKeywords,
          identifierHits,
          querySimilarity,
          minQuerySimilarity,
        )),
  );

  // Cosine gate eliminated everyone — fall back to keyword-strong matches only.
  if (gated.length === 0 && scoringKeywords.length > 0) {
    return scored
      .filter(({ keywordHits, identifierHits, lexicalRecallHits }) => {
        if (lexicalRecallHits > 0 || identifierHits > 0) return true;
        if (keywordHits === 0) return false;
        if (scoringKeywords.length <= 3) return keywordHits >= 1;
        return keywordHits >= Math.max(
          KEYWORD_OVERLAP_GATE_STRONG_ABSOLUTE_HITS + 1,
          Math.ceil(scoringKeywords.length * KEYWORD_OVERLAP_GATE_RATIO),
        );
      })
      .map(annotate)
      .sort((a, b) => b.keywordHits - a.keywordHits || b.score - a.score);
  }

  return gated.map(annotate);
}

function timestampMs(value?: string): number {
  if (!value) return Number.NaN;
  return new Date(value).getTime();
}

function validateTemporalQuery(mode: NonNullable<KnowledgeQueryOptions["query_mode"]>, asOf: string | undefined): void {
  if (mode !== "as_of") return;
  if (Number.isNaN(timestampMs(asOf))) {
    throw new KnowledgeQueryValidationError("query_mode 'as_of' requires a valid as_of timestamp");
  }
}

function isSupersededAsOf(node: KnowledgeNode, state: OrgGraphState, asOfMs: number): boolean {
  if (!node.superseded_by) return false;
  const superseding = state.nodeById.get(node.superseded_by);
  if (!superseding) return false;
  const supersedingCreated = timestampMs(superseding.created_at);
  return !Number.isNaN(supersedingCreated) && supersedingCreated <= asOfMs;
}

function visibleForQueryMode(
  node: KnowledgeNode,
  state: OrgGraphState,
  mode: NonNullable<KnowledgeQueryOptions["query_mode"]>,
  asOf: string | undefined,
  filters: KnowledgeQueryOptions["filters"],
): boolean {
  if (filters.retrieval_tiers?.length && !filters.retrieval_tiers.includes(node.retrieval_tier ?? "hot")) return false;

  if (mode === "history" || mode === "why_changed") return true;

  if (mode === "as_of") {
    const asOfMs = timestampMs(asOf);
    if (Number.isNaN(asOfMs)) return false;
    const created = timestampMs(node.created_at);
    if (!Number.isNaN(created) && created > asOfMs) return false;
    if (!filters.include_superseded && isSupersededAsOf(node, state, asOfMs)) return false;
    return true;
  }

  if (!filters.retrieval_tiers?.length && node.retrieval_tier === "cold") return false;
  if (!filters.include_superseded && node.superseded_by) return false;
  return true;
}

// `null` means "no filter applied yet — all nodes qualify".
function intersectIds(a: Set<string> | null, b: Set<string>): Set<string> {
  if (a === null) return new Set(b);
  return new Set([...b].filter((id) => a.has(id)));
}

function allowsCurrentModePositiveExpansion(
  edge: KnowledgeEdge,
  mode: NonNullable<KnowledgeQueryOptions["query_mode"]>,
  state: OrgGraphState,
): boolean {
  if (mode !== "current") return true;
  if (edge.type === "contradicts" || edge.type === "supersedes") return false;
  if (edge.type === "resolved_by") return edgeHasEvidenceOrCuration(edge, state.nodeById);
  return true;
}

function expandWithGraphNeighbors(
  scored: ScoredNode[],
  state: OrgGraphState,
  mode: NonNullable<KnowledgeQueryOptions["query_mode"]>,
  asOf: string | undefined,
  filters: KnowledgeQueryOptions["filters"],
): ScoredNode[] {
  if (scored.length === 0 || state.graph.edges.length === 0) return scored;
  const byId = new Map(scored.map((s) => [s.node.id, s]));
  const seeds = scored
    .filter((s) =>
      s.score >= 0.45 ||
      s.exactShortKeywordMatch ||
      s.identifierHits > 0 ||
      s.lexicalRecallHits > 0 ||
      (s.querySimilarity ?? 0) >= 0.75,
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  if (seeds.length === 0) return scored;
  const seedIds = new Set(seeds.map((s) => s.node.id));
  const seedById = new Map(seeds.map((s) => [s.node.id, s]));
  const candidateEdges = state.graph.edges
    .map((edge) => {
      const seedSide = seedIds.has(edge.source) ? edge.source : seedIds.has(edge.target) ? edge.target : null;
      return seedSide ? { edge, seedSide } : null;
    })
    .filter((entry): entry is { edge: KnowledgeEdge; seedSide: string } => !!entry)
    .sort((a, b) => {
      const weightDelta = (b.edge.weight ?? 0) - (a.edge.weight ?? 0);
      if (weightDelta !== 0) return weightDelta;
      return (seedById.get(b.seedSide)?.score ?? 0) - (seedById.get(a.seedSide)?.score ?? 0);
    });
  let added = 0;
  for (const { edge, seedSide } of candidateEdges) {
    if (added >= 20) break;
    if (!allowsCurrentModePositiveExpansion(edge, mode, state)) continue;
    const neighborId = edge.source === seedSide ? edge.target : edge.source;
    if (byId.has(neighborId)) continue;
    const neighbor = state.nodeById.get(neighborId);
    if (!neighbor) continue;
    if (!passesAllQueryFilters(neighbor, filters, mode, asOf, state)) continue;
    const seed = seedById.get(seedSide)!;
    const edgeWeight = edge.weight ?? 0;
    const graphExpansionScore = seed.score * 0.35 + Math.min(1, edgeWeight) * 0.08;
    const scoreComponents: ScoredNode["scoreComponents"] = {
      base_relevance: 0,
      semantic_match: 0,
      identifier_match: 0,
      direct_evidence: 0,
      lexical_recall: 0,
      lexical_specificity: 0,
      source_authority: sourceAuthorityScore(neighbor),
      retrieval_tier: retrievalTierScore(neighbor),
      graph_expansion: graphExpansionScore,
    };
    const graphScore =
      graphExpansionScore +
      scoreComponents.source_authority +
      scoreComponents.retrieval_tier;
    const expanded: ScoredNode = {
      node: neighbor,
      exactShortKeywordMatch: false,
      keywordHits: 0,
      nonGenericKeywordHits: 0,
      identifierHits: 0,
      strongIdentifierHits: 0,
      genericIdentifierHits: 0,
      rareKeywordHits: 0,
      lexicalRecallHits: 0,
      idfWeightedCoverage: 0,
      summaryCoverage: 0,
      phraseMatch: 0,
      orderedGenericIdentifierMatch: false,
      score: graphScore,
      scoreComponents,
      graphExpanded: true,
      semanticRelevance: false,
      directEvidence: false,
    };
    byId.set(neighbor.id, expanded);
    added++;
  }
  return [...byId.values()];
}

function recordRetrievals(state: OrgGraphState, nodes: KnowledgeNode[]): void {
  if (legacyMemoryWritesFrozen()) return;
  if (nodes.length === 0) return;
  const now = new Date().toISOString();
  const ids = new Set(nodes.map((n) => n.id));
  for (const id of ids) {
    const node = state.nodeById.get(id);
    if (!node) continue;
    node.retrieval_count = (node.retrieval_count ?? 0) + 1;
    node.last_retrieved_at = now;
    if ((node.retrieval_count ?? 0) >= 5 && node.retrieval_tier === "warm") node.retrieval_tier = "hot";
  }
  state.retrievalTelemetryDirty = true;
}

function nodeStrength(scored: ScoredNode): KnowledgeRetrievalExplanation["strength"] {
  const node = scored.node;
  if (node.type === "anti_pattern") return "avoid";
  if (!scored.semanticRelevance && !scored.directEvidence) return "related";
  if (node.type === "decision" || node.type === "resolved_conflict") return "must_follow";
  if (node.type === "pattern" && node.confidence_score >= 0.85) return "must_follow";
  return "related";
}

function intersection(a: string[], b: string[]): string[] {
  if (a.length === 0 || b.length === 0) return [];
  const bSet = new Set(b);
  return a.filter((value) => bSet.has(value));
}

function sameTags(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const bSet = new Set(b);
  return a.every((value) => bSet.has(value));
}

function explanationForScoredNode(
  scored: ScoredNode,
  filters: KnowledgeQueryOptions["filters"],
  queryText?: string,
): KnowledgeRetrievalExplanation {
  const scopes = filters.scopes ?? filters.domains ?? [];
  const topics = filters.topics ?? [];
  const node = scored.node;
  const scopesSnapshot = nodeScopes(node);
  const topicsSnapshot = nodeTopics(node);
  return {
    node_id: node.id,
    strength: nodeStrength(scored),
    matched_scopes: intersection(scopesSnapshot, scopes),
    matched_topics: intersection(topicsSnapshot, topics.length > 0 ? topics : mergeScoringKeywords(filters, queryText)),
    ...(scored.querySimilarity !== undefined ? { semantic_score: scored.querySimilarity } : {}),
    ...(scored.graphExpanded !== undefined ? { graph_expanded: scored.graphExpanded } : {}),
    score: scored.score,
    score_components: scored.scoreComponents,
    evidence: {
      keyword_hits: scored.keywordHits,
      non_generic_keyword_hits: scored.nonGenericKeywordHits,
      identifier_hits: scored.identifierHits,
      strong_identifier_hits: scored.strongIdentifierHits,
      generic_identifier_hits: scored.genericIdentifierHits,
      rare_keyword_hits: scored.rareKeywordHits,
      lexical_recall_hits: scored.lexicalRecallHits,
      idf_weighted_coverage: scored.idfWeightedCoverage,
      summary_coverage: scored.summaryCoverage,
      phrase_match: scored.phraseMatch,
      ordered_generic_identifier_match: scored.orderedGenericIdentifierMatch,
      exact_short_keyword_match: scored.exactShortKeywordMatch,
      ...(scored.directEvidence !== undefined ? { direct_evidence: scored.directEvidence } : {}),
      ...(scored.semanticRelevance !== undefined ? { semantic_relevance: scored.semanticRelevance } : {}),
      ...(scored.recallCandidate !== undefined ? { recall_candidate: scored.recallCandidate } : {}),
      ...(scored.requiredPin ? { required_pin: true } : {}),
    },
  };
}

function retrievalDiagnostics(
  candidates: KnowledgeNode[],
  filters: KnowledgeQueryOptions["filters"],
  queryText: string | undefined,
  queryEmbedding: number[] | null | undefined,
  matchedCount: number,
  returnedCount: number,
): KnowledgeRetrievalDiagnostics {
  const queryEmbeddingDimensions = Array.isArray(queryEmbedding) ? queryEmbedding.length : 0;
  const hasQueryEmbedding = queryEmbeddingDimensions > 0;
  const semanticQueryRequested = Boolean(queryText?.trim()) || hasQueryEmbedding;
  const lexicalQueryPresent = Boolean(
    queryText?.trim() || filters.text_search?.trim() || filters.keywords?.length,
  );
  const compatibleEmbeddingCount = candidates.filter((node) =>
    hasQueryEmbedding
      ? hasCompatibleEmbeddings(queryEmbedding, node.embedding)
      : hasUsableEmbedding(node.embedding)
  ).length;
  const embeddingCoverage = candidates.length > 0 ? compatibleEmbeddingCount / candidates.length : 0;
  const reasons: NonNullable<KnowledgeRetrievalDiagnostics["degradation_reasons"]> = [];
  if (semanticQueryRequested && !hasQueryEmbedding) reasons.push("query_embedding_unavailable");
  if (hasQueryEmbedding && candidates.length > 0 && compatibleEmbeddingCount === 0) {
    reasons.push("candidate_embeddings_unavailable");
  } else if (hasQueryEmbedding && compatibleEmbeddingCount > 0 && compatibleEmbeddingCount < candidates.length) {
    reasons.push("partial_embedding_coverage");
  }
  const mode: KnowledgeRetrievalDiagnostics["mode"] = !lexicalQueryPresent && !hasQueryEmbedding
    ? "scope_only"
    : hasQueryEmbedding && (candidates.length === 0 || compatibleEmbeddingCount > 0)
      ? "hybrid"
      : "lexical";
  return {
    mode,
    degraded: reasons.length > 0,
    semantic_query_requested: semanticQueryRequested,
    query_embedding_available: hasQueryEmbedding,
    embedding_coverage: embeddingCoverage,
    candidate_count: candidates.length,
    matched_count: matchedCount,
    returned_count: returnedCount,
    ...(reasons.length > 0 ? { degradation_reasons: reasons } : {}),
  };
}

interface CompactKgContextOptions {
  scopes: string[];
  taskQuery?: string;
  possibleConstraints?: boolean;
  headingOffset?: number;
}

let compactContextConfigCache: { topN: number; maxChars: number } | null = null;

function compactContextConfig(): { topN: number; maxChars: number } {
  if (!compactContextConfigCache) {
    compactContextConfigCache = {
      topN: positiveIntFromEnv("PIM_KG_COMPACT_CONTEXT_TOP_N", DEFAULT_COMPACT_CONTEXT_TOP_N),
      maxChars: positiveIntFromEnv("PIM_KG_COMPACT_CONTEXT_MAX_CHARS", DEFAULT_COMPACT_CONTEXT_MAX_CHARS),
    };
  }
  return compactContextConfigCache;
}

function compactContextTopN(): number {
  return compactContextConfig().topN;
}

function compactContextMaxChars(): number {
  return compactContextConfig().maxChars;
}

function positiveIntFromEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeSpaces(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clipOneLine(text: string, maxChars: number): string {
  const normalized = normalizeSpaces(text);
  if (normalized.length <= maxChars) return normalized;
  if (maxChars <= 0) return "";
  if (maxChars <= 3) return normalized.slice(0, maxChars);
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function clipContext(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 0) return "";
  const marker = "\n_(compact context clipped)_";
  if (maxChars <= marker.length) {
    const shortMarker = "_clipped_";
    if (maxChars <= shortMarker.length) return shortMarker.slice(0, maxChars);
    return `${text.slice(0, maxChars - shortMarker.length).trimEnd()}${shortMarker}`;
  }
  return `${text.slice(0, maxChars - marker.length).trimEnd()}${marker}`;
}

function uniqueCompactSignals(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values.map((v) => normalizeSpaces(v)).filter(Boolean)) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function joinCompactSignals(values: string[], maxChars = 320): string {
  const joined: string[] = [];
  for (const value of uniqueCompactSignals(values)) {
    const next = [...joined, value].join("; ");
    if (next.length > maxChars) {
      if (joined.length === 0) joined.push(clipOneLine(value, maxChars));
      break;
    }
    joined.push(value);
  }
  return joined.join("; ");
}

function compactHeading(level: number, text: string, headingOffset = 0): string {
  const adjusted = Math.min(6, Math.max(1, level + Math.max(0, Math.trunc(headingOffset))));
  return `${"#".repeat(adjusted)} ${text}`;
}

function compactSignalsForNode(
  node: KnowledgeNode,
  explanation: KnowledgeRetrievalExplanation | undefined,
): string {
  return joinCompactSignals([
    ...(explanation?.matched_scopes ?? []).slice(0, 3).map((scope) => `scope:${scope}`),
    ...(explanation?.matched_topics ?? []).slice(0, 5).map((topic) => `topic:${topic}`),
    ...(explanation?.semantic_score !== undefined ? [`semantic:${explanation.semantic_score.toFixed(2)}`] : []),
    ...(explanation?.graph_expanded ? ["graph-expanded"] : []),
    `confidence:${node.confidence_score.toFixed(2)}`,
    ...(node.type === "anti_pattern" ? ["anti-pattern"] : []),
  ]);
}

function serializeCompactKgContext(
  result: KnowledgeQueryResult,
  options: CompactKgContextOptions,
): string | undefined {
  if (result.nodes.length === 0) return undefined;

  const topN = compactContextTopN();
  const selected = result.nodes.slice(0, topN);
  const explanationById = new Map((result.explanations ?? []).map((e) => [e.node_id, e]));
  const lines: string[] = [];
  const headingOffset = options.headingOffset ?? 0;

  lines.push(compactHeading(1, "PIM KG Compact Context", headingOffset));
  if (options.taskQuery?.trim()) {
    lines.push(`Scope: task query \`${clipOneLine(options.taskQuery, 180)}\`.`);
  } else if (options.scopes.length > 0) {
    lines.push(`Scope: broad constraints for ${options.scopes.map((scope) => `\`${scope}\``).join(", ")}.`);
  } else {
    lines.push("Scope: broad org constraints.");
  }
  lines.push("Guard: task prompt API/input/output shape is authoritative.");
  lines.push("");
  lines.push(compactHeading(
    2,
    options.possibleConstraints ? "Possible KG constraints" : "Task-matched KG constraints",
    headingOffset,
  ));

  selected.forEach((node, index) => {
    const explanation = explanationById.get(node.id);
    const strength = explanation?.strength ? `/${explanation.strength}` : "";
    lines.push(`- rank ${index + 1} [${node.type}${strength}]: ${clipOneLine(node.summary, 260)}`);
    const signals = compactSignalsForNode(node, explanation);
    if (signals) lines.push(`  - Signals: ${signals}`);
  });

  const omittedReturned = Math.max(0, result.nodes.length - selected.length);
  if (omittedReturned > 0) {
    lines.push(`_Omitted ${omittedReturned} lower-ranked KG candidate(s) after compact gate._`);
  }
  const omittedByRetrieval = Math.max(0, result.total_matching - result.nodes.length);
  if (result.truncated && omittedByRetrieval > 0) {
    lines.push(`_Retrieval had ${omittedByRetrieval} additional match(es) not shown in this compact context._`);
  }

  return clipContext(lines.join("\n"), compactContextMaxChars());
}

function compactContextNodeCount(result: KnowledgeQueryResult): number {
  return Math.min(result.nodes.length, compactContextTopN());
}

export function queryKnowledge(orgId: string, options: InternalKnowledgeQueryOptions): KnowledgeQueryResult {
  const state = getOrgState(orgId);
  const { graph, hubIds } = state;

  const {
    filters: rawFilters,
    max_tokens,
    include_details = false,
    include_edges = false,
    include_embeddings = false,
    limit,
    query_embedding,
    query_text,
    query_mode = "current",
    as_of,
    expand_graph,
    include_explanations = false,
    record_retrievals = true,
    required_node_ids,
    strict_task_relevance = false,
  } = options;
  const filters = normalizeQueryFilters(rawFilters);

  validateTemporalQuery(query_mode, as_of);

  // Step 1: Filter candidates using index-based set intersections.
  // Indexed dimensions (domain, type, pod, keyword) resolve to candidate sets in O(result)
  // time instead of scanning all nodes. Scalar filters (confidence, curated, superseded,
  // project) are applied inline over the already-narrowed list.

  let candidateIds: Set<string> | null = null;

  const scopeFilters = filters.scopes?.length ? filters.scopes : filters.domains;
  if (scopeFilters?.length) {
    const union = new Set<string>();
    for (const d of scopeFilters) {
      for (const id of state.domainIndex.get(d) ?? []) union.add(id);
    }
    candidateIds = intersectIds(candidateIds, union);
  }

  if (filters.topics?.length) {
    const union = new Set<string>();
    for (const t of filters.topics) {
      for (const id of state.topicIndex.get(t) ?? []) union.add(id);
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
    const queryIdentifiers = extractRetrievalIdentifiers(filters.text_search);
    if (queryKws.size > 0) {
      const textMatches = new Set<string>();
      for (const qk of queryKws) {
        for (const id of state.keywordIndex.get(qk) ?? []) textMatches.add(id);
      }
      for (const ident of queryIdentifiers) {
        for (const id of state.identifierIndex.get(ident) ?? []) textMatches.add(id);
      }
      candidateIds = intersectIds(candidateIds, textMatches);
    } else if (queryIdentifiers.size > 0) {
      const identifierMatches = new Set<string>();
      for (const ident of queryIdentifiers) {
        for (const id of state.identifierIndex.get(ident) ?? []) identifierMatches.add(id);
      }
      candidateIds = intersectIds(candidateIds, identifierMatches);
    }
  }

  const baseNodes: KnowledgeNode[] = candidateIds === null
    ? graph.nodes
    : [...candidateIds].map((id) => state.nodeById.get(id)).filter((n): n is KnowledgeNode => !!n);

  // P1: Exclude superseded nodes by default so agents don't receive stale decisions.
  const confidenceMin = filters.confidence_min ?? DEFAULT_CONFIDENCE_MIN;
  const candidates: KnowledgeNode[] = baseNodes.filter((node) => {
    if (node.confidence_score < confidenceMin) return false;
    return passesScalarQueryFilters(node, filters, query_mode, as_of, state);
  });

  // Step 2: Score and sort by relevance
  const scopes = filters.scopes ?? filters.domains ?? [];
  const keywords = mergeScoringKeywords(filters, query_text);
  const identifiers = mergeQueryIdentifiers(filters, query_text);
  const querySignals = buildQuerySignalPlan(state, keywords, identifiers);
  const graphTuning = graph.org_id ? getOrgTuning(graph.org_id).graphScoring : DEFAULT_ORG_TUNING.graphScoring;

  let scored = scoreCandidates(
    candidates,
    state,
    scopes,
    keywords,
    identifiers,
    querySignals,
    query_text,
    query_embedding,
    hubIds,
    graphTuning,
  );

  if (hasUsableEmbedding(query_embedding) || !!query_text?.trim()) {
    const minQuerySimilarity = graphTuning.minQuerySimilarity ?? 0.75;
    const gated = applySemanticGate(
      scored,
      state,
      keywords,
      querySignals,
      query_embedding,
      minQuerySimilarity,
      strict_task_relevance,
    );
    scored = gated;
  }

  scored = pinRequiredScoredNodes(
    scored,
    state,
    required_node_ids,
    filters,
    query_mode,
    as_of,
    scopes,
    keywords,
    identifiers,
    querySignals,
    query_text,
    query_embedding,
    hubIds,
    graphTuning,
  );

  const shouldExpand =
    !strict_task_relevance &&
    (expand_graph ?? Boolean(query_text?.trim() || query_mode === "why_changed" || query_mode === "history" || query_mode === "as_of"));
  if (shouldExpand) {
    scored = expandWithGraphNeighbors(scored, state, query_mode, as_of, filters);
  }

  const totalMatching = scored.length;
  scored.sort((a, b) =>
    b.score - a.score ||
    b.strongIdentifierHits - a.strongIdentifierHits ||
    b.phraseMatch - a.phraseMatch ||
    b.idfWeightedCoverage - a.idfWeightedCoverage ||
    a.node.id.localeCompare(b.node.id),
  );

  // Step 3: Apply token budget and/or limit
  const resultNodes: KnowledgeNode[] = [];
  const resultScored: ScoredNode[] = [];
  let tokenCount = 0;
  const effectiveLimit = limit ?? scored.length;
  const tokenBudget = max_tokens ?? DEFAULT_QUERY_MAX_TOKENS;

  for (const scoredNode of scored) {
    const { node } = scoredNode;
    if (resultNodes.length >= effectiveLimit) break;

    const nodeTokens = estimateNodeTokens(node, include_details);
    if (tokenCount + nodeTokens > tokenBudget) continue;

    tokenCount += nodeTokens;

    resultNodes.push(shapeNodeForQueryResponse(node, include_details, include_embeddings));
    resultScored.push(scoredNode);
  }

  if (record_retrievals) recordRetrievals(state, resultNodes);

  // Step 4: Include edges if requested
  let resultEdges: KnowledgeEdge[] = [];
  let edgesTruncated = false;
  if (include_edges || query_mode === "why_changed") {
    const nodeIds = new Set(resultNodes.map((n) => n.id));
    const matchingEdges = graph.edges.filter(
      (e) => nodeIds.has(e.source) && nodeIds.has(e.target),
    );
    const remainingEdgeBudget = Math.max(0, tokenBudget - tokenCount);
    resultEdges = matchingEdges.slice(0, Math.floor(remainingEdgeBudget / TOKENS_PER_EDGE));
    edgesTruncated = resultEdges.length < matchingEdges.length;
    tokenCount += resultEdges.length * TOKENS_PER_EDGE;
  }

  const explanations = include_explanations
    ? resultScored.map((entry) => explanationForScoredNode(entry, filters, query_text))
    : undefined;
  const diagnostics = retrievalDiagnostics(
    candidates,
    filters,
    query_text,
    query_embedding,
    totalMatching,
    resultNodes.length,
  );

  return {
    nodes: resultNodes,
    edges: resultEdges,
    total_matching: totalMatching,
    token_estimate: tokenCount,
    truncated: resultNodes.length < totalMatching || edgesTruncated,
    query_mode,
    as_of,
    ...(explanations ? { explanations } : {}),
    retrieval_diagnostics: diagnostics,
  };
}

export async function queryKnowledgeSemantic(
  orgId: string,
  options: InternalKnowledgeQueryOptions,
): Promise<KnowledgeQueryResult> {
  const queryText = typeof options.query_text === "string" ? options.query_text.trim() : undefined;
  const hasQueryText = !!queryText;
  const queryEmbedding = options.query_embedding ?? (hasQueryText ? await generateEmbedding(queryText) : null);
  const { query_text: _queryText, query_embedding: _queryEmbedding, ...rest } = options;
  return queryKnowledge(orgId, {
    ...rest,
    ...(hasQueryText ? { query_text: queryText } : {}),
    query_embedding: queryEmbedding,
  });
}

export interface ContractedRelevantLearningsOptions {
  scopes: string[];
  maxTokens: number;
  projectId?: string | null;
  taskQuery?: string;
  taskQueryEmbedding?: number[] | null;
  requiredNodeIds?: string[];
  compactHeadingOffset?: number;
}

function withContextContract(
  result: KnowledgeQueryResult,
  mode: KgContextContractMode,
  returnedMode: "legacy" | "task_relevant",
  taskQueryUsed: boolean,
  possibleConstraints = false,
  compactOptions?: CompactKgContextOptions,
): KnowledgeQueryResult {
  const compactContext = compactOptions
    ? serializeCompactKgContext(result, {
        ...compactOptions,
        possibleConstraints: compactOptions.possibleConstraints ?? possibleConstraints,
      })
    : undefined;
  const possibleConstraintsNote = taskQueryUsed && returnedMode === "legacy"
    ? "Legacy keyword KG context only; treat these as possible constraints and call query_knowledge for a deeper task-semantic lookup."
    : "Broad scope context only; pass taskQuery or call query_knowledge for a deeper precedent lookup.";
  return {
    ...result,
    ...(compactContext
      ? {
          compact_context: compactContext,
          compact_context_node_count: compactContextNodeCount(result),
        }
      : {}),
    context_contract: {
      mode,
      returned_mode: returnedMode,
      task_query_used: taskQueryUsed,
      ...(possibleConstraints ? { possible_constraints: true } : {}),
      ...(possibleConstraints ? { note: possibleConstraintsNote } : {}),
    },
  };
}

async function getTaskRelevantLearnings(
  orgId: string,
  scopes: string[],
  taskQuery: string | undefined,
  taskQueryEmbedding: number[] | null | undefined,
  maxTokens: number,
  projectId?: string | null,
  recordRetrievals = true,
  requiredNodeIds?: string[],
): Promise<KnowledgeQueryResult> {
  const filters = {
    ...(scopes.length > 0 ? { scopes } : {}),
    ...(projectId ? { include_project_id: projectId } : {}),
  };

  if (taskQuery?.trim()) {
    return queryKnowledgeSemantic(orgId, {
      filters,
      query_text: taskQuery.trim(),
      max_tokens: Math.min(maxTokens, DEFAULT_TASK_RELEVANT_MAX_TOKENS),
      include_details: false,
      limit: positiveIntFromEnv("PIM_KG_TASK_RELEVANT_CANDIDATE_LIMIT", DEFAULT_TASK_RELEVANT_CANDIDATE_LIMIT),
      // Candidate retrieval remains direct and explainable. Graph neighbors are
      // available to explicit callers, but should not displace task matches in
      // the compact context contract.
      expand_graph: false,
      include_explanations: true,
      record_retrievals: recordRetrievals,
      required_node_ids: requiredNodeIds,
      query_embedding: taskQueryEmbedding,
      strict_task_relevance: true,
    });
  }

  // No task query means the caller explicitly requested a tiny scope-level
  // constraints block. Do not manufacture semantic intent: during an embedding
  // outage that synthetic text would either leak unrelated nodes or eliminate
  // all broad context depending on the fallback policy.
  return queryKnowledge(orgId, {
    filters,
    max_tokens: Math.min(maxTokens, 500),
    include_details: false,
    limit: 3,
    expand_graph: false,
    include_explanations: true,
    record_retrievals: recordRetrievals,
    required_node_ids: requiredNodeIds,
  });
}

function resultIds(result: KnowledgeQueryResult): string[] {
  return result.nodes.map((node) => node.id);
}

function overlapCount(a: string[], b: string[]): number {
  const bSet = new Set(b);
  return a.filter((id) => bSet.has(id)).length;
}

function logShadowComparison(
  orgId: string,
  opts: ContractedRelevantLearningsOptions,
  legacy: KnowledgeQueryResult,
  taskRelevant: KnowledgeQueryResult,
): void {
  const legacyIds = resultIds(legacy);
  const taskIds = resultIds(taskRelevant);
  const required = opts.requiredNodeIds ?? [];
  const unionCount = new Set([...legacyIds, ...taskIds]).size;
  const metrics = {
    org_id: orgId,
    mode: "shadow" as const,
    scopes: opts.scopes,
    project_id: opts.projectId ?? null,
    task_query_present: Boolean(opts.taskQuery?.trim()),
    legacy_node_ids: legacyIds,
    task_relevant_node_ids: taskIds,
    legacy_token_estimate: legacy.token_estimate,
    task_relevant_token_estimate: taskRelevant.token_estimate,
    overlap_count: overlapCount(legacyIds, taskIds),
    overlap_ratio: unionCount > 0
      ? overlapCount(legacyIds, taskIds) / unionCount
      : 0,
    ...(required.length > 0
      ? {
          required_node_ids: required,
          legacy_required_hits: overlapCount(legacyIds, required),
          task_relevant_required_hits: overlapCount(taskIds, required),
        }
      : {}),
  };
  console.info("[knowledge-graph] kg_context_contract shadow", metrics);
}

export async function getContractedRelevantLearnings(
  orgId: string,
  options: ContractedRelevantLearningsOptions,
): Promise<KnowledgeQueryResult> {
  return getRelevantLearningsForContractMode(orgId, getKgContextContract(orgId), options);
}

/** Eval/test helper: exercise the same context contract switch without reading org settings. */
export async function getRelevantLearningsForContractMode(
  orgId: string,
  mode: KgContextContractMode,
  options: ContractedRelevantLearningsOptions,
): Promise<KnowledgeQueryResult> {
  const taskQuery = options.taskQuery?.trim() || undefined;

  if (mode === "task_relevant") {
    const result = await getTaskRelevantLearnings(
      orgId,
      options.scopes,
      taskQuery,
      options.taskQueryEmbedding,
      options.maxTokens,
      options.projectId,
      true,
      options.requiredNodeIds,
    );
    return withContextContract(result, mode, "task_relevant", Boolean(taskQuery), !taskQuery, {
      scopes: options.scopes,
      ...(taskQuery ? { taskQuery } : {}),
      possibleConstraints: !taskQuery,
      ...(options.compactHeadingOffset !== undefined ? { headingOffset: options.compactHeadingOffset } : {}),
    });
  }

  const legacy = await getRelevantLearnings(
    orgId,
    options.scopes,
    taskQuery ? [taskQuery] : [],
    options.maxTokens,
    options.projectId,
    options.requiredNodeIds,
    options.taskQueryEmbedding,
  );
  if (mode === "shadow") {
    try {
      const taskRelevant = await getTaskRelevantLearnings(
        orgId,
        options.scopes,
        taskQuery,
        options.taskQueryEmbedding,
        options.maxTokens,
        options.projectId,
        false,
        options.requiredNodeIds,
      );
      logShadowComparison(orgId, options, legacy, taskRelevant);
    } catch (err) {
      console.warn("[knowledge-graph] kg_context_contract shadow comparison failed", {
        org_id: orgId,
        mode: "shadow",
        scopes: options.scopes,
        project_id: options.projectId ?? null,
        task_query_present: Boolean(taskQuery),
        ...(options.requiredNodeIds?.length ? { required_node_ids: options.requiredNodeIds } : {}),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return withContextContract(
    legacy,
    mode,
    "legacy",
    Boolean(taskQuery),
    Boolean(taskQuery),
    taskQuery
      ? {
          scopes: options.scopes,
          taskQuery,
          ...(options.compactHeadingOffset !== undefined ? { headingOffset: options.compactHeadingOffset } : {}),
        }
      : undefined,
  );
}

// --- Convenience: Get Relevant Learnings ---

export async function getRelevantLearnings(
  orgId: string,
  scopes: string[],
  activeConflictSummaries: string[],
  maxTokens: number,
  projectId?: string | null,
  requiredNodeIds?: string[],
  queryEmbedding?: number[] | null,
): Promise<KnowledgeQueryResult> {
  const keywords = keywordsFromTexts(activeConflictSummaries, 40);

  // Use conflict summaries as the semantic query (scopes are handled by domain filter)
  const queryText = activeConflictSummaries.filter(Boolean).join(" ");

  return queryKnowledgeSemantic(orgId, {
    filters: {
      scopes,
      ...(keywords.length > 0 ? { keywords } : {}),
      ...(projectId ? { include_project_id: projectId } : {}),
    },
    max_tokens: maxTokens,
    include_details: false,
    ...(queryText.trim() ? { query_text: queryText } : {}),
    ...(queryText.trim() && queryEmbedding !== undefined ? { query_embedding: queryEmbedding } : {}),
    required_node_ids: requiredNodeIds,
  });
}

// --- Convenience: Get Precedents ---

/** Candidates for KG pattern scout — org decisions/patterns that may contradict a pod update. */
export async function getOrgPatternCandidates(
  orgId: string,
  queryText: string,
  scope: string,
  options: {
    maxTokens: number;
    types: KnowledgeNodeType[];
    confidenceMin?: number;
  },
): Promise<KnowledgeQueryResult> {
  const trimmed = queryText.trim();
  const queryEmbedding = trimmed ? await generateEmbedding(trimmed) : null;

  return queryKnowledge(orgId, {
    filters: {
      domains: [scope],
      types: options.types,
      confidence_min: options.confidenceMin ?? 0.65,
    },
    max_tokens: options.maxTokens,
    include_details: true,
    query_embedding: queryEmbedding,
    query_text: trimmed.slice(0, 500),
    query_mode: "current",
  });
}

export async function getPrecedents(
  orgId: string,
  conflictSummary: string,
  maxTokens: number,
): Promise<KnowledgeQueryResult> {
  return queryKnowledgeSemantic(orgId, {
    filters: {
      types: ["resolved_conflict"],
      text_search: conflictSummary.slice(0, 100),
    },
    max_tokens: maxTokens,
    include_details: true,
    query_text: conflictSummary,
  });
}

// --- Curation ---

/** Removes KG nodes whose content was derived from project evidence that has
 * crossed a source-boundary deletion. This is intentionally synchronous so a
 * resource unbind cannot commit while a derived node remains queryable. */
export function retractProjectEvidenceKnowledgeNodes(
  orgId: string,
  projectId: string,
  nodeIds: readonly string[],
): string[] {
  if (legacyMemoryWritesFrozen()) return [];
  if (nodeIds.length === 0) return [];
  const requested = new Set(nodeIds);
  const state = getOrgState(orgId);
  const removed: string[] = [];
  for (let index = state.graph.nodes.length - 1; index >= 0; index--) {
    const node = state.graph.nodes[index];
    if (!requested.has(node.id)
      || node.source_project_id !== projectId
      || node.ingestion_provenance?.kind !== "project_evidence") continue;
    _removeNodeFromIndexes(node, state);
    state.graph.nodes.splice(index, 1);
    removed.push(node.id);
  }
  if (removed.length === 0) return [];
  const removedIds = new Set(removed);
  state.graph.edges = state.graph.edges.filter((edge) =>
    !removedIds.has(edge.source) && !removedIds.has(edge.target));
  for (const node of state.graph.nodes) {
    if (node.superseded_by && removedIds.has(node.superseded_by)) delete node.superseded_by;
  }
  state.graph.version++;
  state.graph.updated_at = new Date().toISOString();
  state.graph.communities = detectCommunities(state.graph);
  state.hubIds = new Set(identifyHubs(state.graph));
  persistGraph(orgId, state);
  return removed;
}

export async function curateNode(
  orgId: string,
  nodeId: string,
  action: CurationAction,
  edits?: Partial<Pick<KnowledgeNode, "summary" | "details" | "domains">>,
): Promise<boolean> {
  assertLegacyMemoryWritable("knowledge_graph_curation");
  const state = getOrgState(orgId);
  const { graph } = state;

  const nodeIndex = graph.nodes.findIndex((n) => n.id === nodeId);
  if (nodeIndex === -1) return false;

  if (action === "approve" || action === "edit") {
    const node = graph.nodes[nodeIndex];
    assertLegacyActivationStructure({
      type: node.type,
      summary: edits?.summary ?? node.summary,
      details: edits?.details ?? node.details,
      domains: edits?.domains ?? node.domains,
    });
  }

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
    const editedNode = { ...node };
    if (edits.summary !== undefined) editedNode.summary = edits.summary;
    if (edits.details !== undefined) editedNode.details = edits.details;
    if (edits.domains !== undefined) {
      const priorDomains = normalizeTagList(node.domains);
      const priorScopes = normalizeTagList(node.scopes);
      const scopesWereDomainMirror = priorScopes.length === 0 || sameTags(priorScopes, priorDomains);
      const domains = normalizeTagList(edits.domains);
      editedNode.domains = domains;
      if (scopesWereDomainMirror) editedNode.scopes = domains;
    }
    const memory = buildKnowledgeNodeMemory({ node: editedNode, orgId });
    editedNode.retrieval_text = memory.retrieval_text;
    editedNode.entity_refs = memory.entity_refs;
    await refreshNodeEmbedding(editedNode, true);
    assertLegacyMemoryWritable("knowledge_graph_curation");
    _removeNodeFromIndexes(node, state);
    editedNode.curated = true;
    graph.nodes[nodeIndex] = editedNode;
    _indexNode(editedNode, state);
  }

  graph.version++;
  graph.updated_at = new Date().toISOString();

  // Re-run analysis after structural changes
  if (action === "reject") {
    graph.communities = detectCommunities(graph);
    state.hubIds = new Set(identifyHubs(graph));
  }

  persistGraph(orgId, state);
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
    for (const d of normalizeTagList(node.domains)) {
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
  if (legacyMemoryWritesFrozen()) return;
  const state = orgStates.get(orgId);
  if (!state || state.graph.nodes.length === 0) {
    if (state) state.analysisStale = false;
    return;
  }
  const { graph } = state;
  graph.communities = detectCommunities(graph);
  state.hubIds = new Set(identifyHubs(graph));
  state.analysisStale = false;
  persistGraph(orgId, state);
}

/**
 * Worker-backed variant of refreshAnalysis. Dispatches detectCommunities + identifyHubs
 * onto a separate OS thread, freeing the main event loop while the work runs.
 *
 * Version-stamp pattern: the worker is sent the graph snapshot's version. When the result
 * arrives we re-check the live graph's version. If a mutation happened in the interim, the
 * worker's result is stale — we discard it and leave analysisStale=true so the next tick
 * re-runs against the newer graph. Correctness wins over throughput here.
 */
export async function refreshAnalysisWithWorker(orgId: string): Promise<boolean> {
  if (legacyMemoryWritesFrozen()) return false;
  const state = orgStates.get(orgId);
  if (!state || state.graph.nodes.length === 0) {
    if (state) state.analysisStale = false;
    return false;
  }

  const fromVersion = state.graph.version;
  // Strip embeddings before serialization — they are not needed for community detection
  // and dominate the message size at ~2KB/node × N nodes. A 5k-node graph drops from
  // ~25MB to ~1.5MB across the worker boundary.
  const graphSnapshot: typeof state.graph = {
    ...state.graph,
    nodes: state.graph.nodes.map((n) => ({ ...n, embedding: undefined })),
  };

  let response;
  try {
    response = await getGraphAnalysisPool().analyze(graphSnapshot, fromVersion);
  } catch (err) {
    console.error(`[knowledge-graph] Worker analysis failed for org "${orgId}":`, err);
    // Leave analysisStale=true so the next interval retries. The graph is not corrupted.
    return false;
  }

  // Live state may have shifted while the worker was running.
  const liveState = orgStates.get(orgId);
  if (!liveState || liveState.graph.version !== fromVersion) {
    // Discard stale result; next tick will re-run with the newer graph.
    return false;
  }
  if (legacyMemoryWritesFrozen()) return false;

  liveState.graph.communities = response.communities;
  liveState.hubIds = new Set(response.hubIds);
  for (const node of liveState.graph.nodes) {
    const cid = response.nodeCommunityMap[node.id];
    if (cid) node.community_id = cid;
  }
  liveState.analysisStale = false;
  persistGraph(orgId, liveState);
  return true;
}

function flushRetrievalTelemetryIfDirty(orgId: string, state: OrgGraphState): boolean {
  if (legacyMemoryWritesFrozen()) return false;
  if (!state.retrievalTelemetryDirty) return false;
  persistGraph(orgId, state);
  return true;
}

/**
 * Cheap variant of refreshAnalysis: returns immediately when nothing has marked the graph
 * stale. Safe to call from hot paths (interval ticks, post-query lazy refresh).
 *
 * With no orgId, iterates over every loaded org's state — the periodic interval uses this
 * form so newly active orgs get picked up without a separate scheduler.
 *
 * When PIM_GRAPH_WORKER=true, dispatches to a worker thread. Returns a Promise<boolean> in
 * that mode. Callers that don't await it (e.g., setInterval) get fire-and-forget behavior,
 * which is the desired shape for periodic refresh.
 */
export function refreshAnalysisIfStale(orgId?: string): boolean | Promise<boolean> {
  if (legacyMemoryWritesFrozen()) return false;
  if (isGraphWorkerEnabled()) {
    return refreshAnalysisIfStaleAsync(orgId);
  }
  if (orgId) {
    const state = orgStates.get(orgId);
    if (!state) return false;
    if (!state.analysisStale) return flushRetrievalTelemetryIfDirty(orgId, state);
    refreshAnalysis(orgId);
    return true;
  }
  let didWork = false;
  for (const [id, state] of orgStates) {
    if (state.analysisStale) {
      refreshAnalysis(id);
      didWork = true;
      continue;
    }
    if (flushRetrievalTelemetryIfDirty(id, state)) didWork = true;
  }
  return didWork;
}

async function refreshAnalysisIfStaleAsync(orgId?: string): Promise<boolean> {
  if (legacyMemoryWritesFrozen()) return false;
  if (orgId) {
    const state = orgStates.get(orgId);
    if (!state) return false;
    if (!state.analysisStale) return flushRetrievalTelemetryIfDirty(orgId, state);
    return refreshAnalysisWithWorker(orgId);
  }
  let didWork = false;
  // Snapshot org ids — refreshAnalysisWithWorker can mutate the map (e.g., another org
  // loaded mid-iteration) so we don't want to iterate a live view.
  for (const id of [...orgStates.keys()]) {
    const state = orgStates.get(id);
    if (!state) continue;
    if (state.analysisStale) {
      const ran = await refreshAnalysisWithWorker(id);
      if (ran) didWork = true;
      continue;
    }
    if (flushRetrievalTelemetryIfDirty(id, state)) didWork = true;
  }
  return didWork;
}

/** Test/debug helper. */
export function isAnalysisStale(orgId: string): boolean {
  return orgStates.get(orgId)?.analysisStale ?? false;
}

// --- Pruning ---

/**
 * Retention scoring replaces hard deletion. Low-retention nodes move to `cold`
 * retrieval so current-mode queries stay clean while history/as_of/why_changed
 * can still recover stale lineage.
 *
 * With no orgId, scores every loaded org's graph — matches the periodic-interval shape.
 */
const PRUNE_AGE_MS = 180 * 24 * 60 * 60 * 1000;

function computeRetentionScore(node: KnowledgeNode, state: OrgGraphState, now: Date): number {
  const ageMs = now.getTime() - new Date(node.created_at).getTime();
  const ageDays = Number.isNaN(ageMs) ? 0 : Math.max(0, ageMs / (24 * 60 * 60 * 1000));
  const ageScore = Math.max(0, 1 - ageDays / 365);
  const degree = state.graph.edges.filter((e) => e.source === node.id || e.target === node.id).length;
  let score =
    node.confidence_score * 0.55 +
    (node.curated ? 0.25 : 0) +
    Math.min(0.15, degree * 0.02) +
    Math.min(0.12, (node.retrieval_count ?? 0) * 0.02) +
    ageScore * 0.25;
  if (node.type === "decision" || node.type === "resolved_conflict") score += 0.08;
  if (node.superseded_by) score += 0.25;
  return Math.max(0, Math.min(1, score));
}

function tierForRetention(score: number): "hot" | "warm" | "cold" {
  if (score >= 0.68) return "hot";
  if (score >= 0.38) return "warm";
  return "cold";
}

export function pruneStaleNodes(orgId?: string, now: Date = new Date()): { removed: number; moved_to_cold: number; rescored: number } {
  if (!orgId) {
    let moved = 0;
    let rescored = 0;
    for (const id of orgStates.keys()) {
      const result = pruneStaleNodes(id, now);
      moved += result.moved_to_cold;
      rescored += result.rescored;
    }
    return { removed: 0, moved_to_cold: moved, rescored };
  }

  if (legacyMemoryWritesFrozen()) return { removed: 0, moved_to_cold: 0, rescored: 0 };

  const state = orgStates.get(orgId);
  if (!state || state.graph.nodes.length === 0) return { removed: 0, moved_to_cold: 0, rescored: 0 };
  const { graph } = state;

  const cutoff = now.getTime() - PRUNE_AGE_MS;
  let movedToCold = 0;
  let rescored = 0;
  for (const node of graph.nodes) {
    const score = computeRetentionScore(node, state, now);
    const priorTier = node.retrieval_tier ?? "hot";
    const nextTier = tierForRetention(score);
    const created = new Date(node.created_at).getTime();
    const staleEnough = !Number.isNaN(created) && created <= cutoff;
    node.retention_score = score;
    if (nextTier !== "cold" || staleEnough) {
      node.retrieval_tier = nextTier;
    }
    rescored++;
    if (priorTier !== "cold" && nextTier === "cold" && staleEnough) movedToCold++;
  }

  if (rescored === 0) return { removed: 0, moved_to_cold: 0, rescored: 0 };

  graph.version++;
  graph.updated_at = now.toISOString();
  state.analysisStale = true;
  const freshIndexes = buildIndexes(graph.nodes);
  state.nodeById = freshIndexes.nodeById;
  state.domainIndex = freshIndexes.domainIndex;
  state.topicIndex = freshIndexes.topicIndex;
  state.typeIndex = freshIndexes.typeIndex;
  state.podIndex = freshIndexes.podIndex;
  state.entityIndex = freshIndexes.entityIndex;
  state.nodeKeywords = freshIndexes.nodeKeywords;
  state.keywordIndex = freshIndexes.keywordIndex;
  state.nodeIdentifiers = freshIndexes.nodeIdentifiers;
  state.identifierIndex = freshIndexes.identifierIndex;
  persistGraph(orgId, state);

  console.log(`[knowledge-graph] Retention-scored ${rescored} node(s), moved ${movedToCold} to cold for org "${orgId}"`);
  return { removed: 0, moved_to_cold: movedToCold, rescored };
}
