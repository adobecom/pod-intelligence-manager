/**
 * Graph Analysis Service — inline algorithms for knowledge graph analysis.
 *
 * Community detection (label propagation), hub identification,
 * edge building (keyword overlap + type-specific rules), relevance scoring.
 * No external graph library — adequate for hundreds to low-thousands of nodes.
 */

import type {
  KnowledgeNode,
  KnowledgeEdge,
  KnowledgeEdgeType,
  KnowledgeGraph,
  CommunitySummary,
  OrgTuning,
} from "@pim/shared";
import { DEFAULT_ORG_TUNING } from "@pim/shared";
import { cosineSimilarity } from "./embeddings.js";

// --- Keyword Extraction ---

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "was", "are", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "to", "of", "in",
  "for", "on", "with", "at", "by", "from", "as", "into", "through",
  "during", "before", "after", "above", "below", "between", "and", "but",
  "or", "nor", "not", "so", "yet", "both", "either", "neither", "each",
  "every", "all", "any", "few", "more", "most", "other", "some", "such",
  "no", "only", "own", "same", "than", "too", "very", "just", "because",
  "this", "that", "these", "those", "it", "its", "they", "them", "their",
  "we", "us", "our", "you", "your", "he", "him", "his", "she", "her",
  "memory", "kind", "pod", "agent", "source", "workstream", "knowledge",
  "node", "context",
]);
const BARE_HTTP_VERB_IDENTIFIERS = new Set(["get", "post", "put", "patch", "delete"]);
const LOW_SIGNAL_RETRIEVAL_IDENTIFIERS = new Set(["api", "current"]);

export function extractKeywords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
  );
}

export function extractIdentifiers(text: string): Set<string> {
  const identifiers = new Set<string>();
  const patterns = [
    /\b[A-Z][A-Z0-9]+-\d+\b/g,
    /\b(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#\d+\b/g,
    /\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/[A-Za-z0-9_./:{}-]+/g,
    /\b[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+\b/g,
    /\b[A-Za-z_$][A-Za-z0-9_$]*(?:_[A-Za-z0-9_$]+)+\b/g,
    /\b[a-z][A-Za-z0-9_$]*[A-Z][A-Za-z0-9_$]*\b/g,
    /\b[A-Z]{2,}[A-Z0-9_]*\b/g,
    /\b[A-Za-z0-9_-]+\.(?:ts|tsx|js|jsx|json|yaml|yml|openapi)\b/g,
    /\b[A-Z][A-Za-z0-9]*(?:API|Api|Service|Controller|Contract|Endpoint)\b/g,
    /\b[A-Z][A-Za-z0-9]+(?:[A-Z][A-Za-z0-9]+)+\b/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.match(pattern) ?? []) {
      const cleaned = match.trim().toLowerCase();
      if (STOP_WORDS.has(cleaned)) continue;
      if (BARE_HTTP_VERB_IDENTIFIERS.has(cleaned)) continue;
      if (cleaned.length > 2) identifiers.add(cleaned);
    }
  }
  return identifiers;
}

export function extractRetrievalIdentifiers(text: string): Set<string> {
  const identifiers = extractIdentifiers(text);
  for (const lowSignal of LOW_SIGNAL_RETRIEVAL_IDENTIFIERS) identifiers.delete(lowSignal);
  return identifiers;
}

/** Tokenize and de-duplicate text for query-time scoring (stop words stripped). */
export function keywordsFromTexts(texts: string[], maxTerms = 40): string[] {
  const blob = texts.filter(Boolean).join(" ");
  if (!blob.trim()) return [];
  return [...extractKeywords(blob)].slice(0, maxTerms);
}

function keywordOverlap(a: string, b: string): number {
  const kwA = extractKeywords(a);
  const kwB = extractKeywords(b);
  if (kwA.size === 0 || kwB.size === 0) return 0;
  let overlap = 0;
  for (const w of kwA) {
    if (kwB.has(w)) overlap++;
  }
  return overlap / Math.min(kwA.size, kwB.size);
}

function domainOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  let overlap = 0;
  for (const d of a) {
    if (setB.has(d)) overlap++;
  }
  return overlap / Math.min(a.length, b.length);
}

// --- Edge Building ---

// P3: Accept existing edges to prevent duplicate edges between the same node pair.
export function buildEdges(
  newNodes: KnowledgeNode[],
  existingNodes: KnowledgeNode[],
  existingEdges?: KnowledgeEdge[],
): KnowledgeEdge[] {
  const edges: KnowledgeEdge[] = [];
  // Track both directions so we never create A→B when B→A (or A→B) already exists.
  const seenPairs = new Set<string>();
  if (existingEdges) {
    for (const e of existingEdges) {
      seenPairs.add(`${e.source}:${e.target}`);
      seenPairs.add(`${e.target}:${e.source}`);
    }
  }

  for (const newNode of newNodes) {
    for (const existing of existingNodes) {
      if (newNode.id === existing.id) continue;

      const pairKey = `${newNode.id}:${existing.id}`;
      const reverseKey = `${existing.id}:${newNode.id}`;
      if (seenPairs.has(pairKey) || seenPairs.has(reverseKey)) continue;

      const domOverlap = domainOverlap(newNode.domains, existing.domains);
      const keyword = keywordOverlap(newNode.summary, existing.summary);

      // Fast-path: skip cosine similarity when keyword and domain signals are both
      // absent AND neither node has an embedding — those pairs are almost certainly
      // unrelated. When embeddings ARE present, always compute cosine: two nodes can
      // be semantically near-identical with disjoint summaries and domains.
      if (keyword < 0.2 && domOverlap === 0 && !(newNode.embedding && existing.embedding)) continue;

      const cosine =
        newNode.embedding && existing.embedding
          ? cosineSimilarity(newNode.embedding, existing.embedding)
          : 0;
      if (cosine < 0.2 && keyword < 0.2) continue;

      // Domain becomes a tiebreaker (15% weight) rather than a primary signal.
      const combinedScore =
        newNode.embedding && existing.embedding
          ? cosine * 0.85 + domOverlap * 0.15
          : keyword * 0.85 + domOverlap * 0.15;

      if (combinedScore < 0.35) continue;

      const edgeType = inferEdgeType(newNode, existing);

      edges.push({
        source: newNode.id,
        target: existing.id,
        type: edgeType,
        weight: Math.min(1, combinedScore),
      });

      // Track this pair so intra-batch calls don't add the reverse edge too.
      seenPairs.add(pairKey);
      seenPairs.add(reverseKey);
    }
  }

  return capNodeDegree(edges, existingEdges);
}

function capNodeDegree(
  newEdges: KnowledgeEdge[],
  existingEdges: KnowledgeEdge[] = [],
  maxDegree = 20,
): KnowledgeEdge[] {
  // Count degrees already committed by existing edges so we don't push any node over cap.
  const degree = new Map<string, number>();
  for (const e of existingEdges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  // Fast-path: skip sorting if no node would exceed the cap.
  // Must account for degree accumulated within newEdges themselves, not just existing edges.
  const newDegree = new Map<string, number>();
  for (const e of newEdges) {
    newDegree.set(e.source, (newDegree.get(e.source) ?? 0) + 1);
    newDegree.set(e.target, (newDegree.get(e.target) ?? 0) + 1);
  }
  let anyExceed = false;
  for (const [id, nd] of newDegree) {
    if ((degree.get(id) ?? 0) + nd > maxDegree) {
      anyExceed = true;
      break;
    }
  }
  if (!anyExceed) return newEdges;

  // Sort highest-weight first so we keep the strongest connections.
  const sorted = [...newEdges].sort((a, b) => b.weight - a.weight);
  const added = new Map<string, number>();
  const kept: KnowledgeEdge[] = [];
  for (const edge of sorted) {
    const sd = (degree.get(edge.source) ?? 0) + (added.get(edge.source) ?? 0);
    const td = (degree.get(edge.target) ?? 0) + (added.get(edge.target) ?? 0);
    if (sd >= maxDegree || td >= maxDegree) continue;
    kept.push(edge);
    added.set(edge.source, (added.get(edge.source) ?? 0) + 1);
    added.set(edge.target, (added.get(edge.target) ?? 0) + 1);
  }
  return kept;
}

function inferEdgeType(
  newer: KnowledgeNode,
  older: KnowledgeNode,
): KnowledgeEdgeType {
  // Anti-pattern contradicts a pattern in the same domain
  if (newer.type === "anti_pattern" && older.type === "pattern") {
    return "contradicts";
  }
  if (newer.type === "pattern" && older.type === "anti_pattern") {
    return "contradicts";
  }

  // Resolved conflict links back
  if (newer.type === "resolved_conflict" || older.type === "resolved_conflict") {
    return "resolved_by";
  }

  // Pattern building on another pattern
  if (newer.type === "pattern" && older.type === "pattern") {
    return "builds_on";
  }

  return "relates_to";
}

// --- Seeded PRNG (mulberry32) ---

// P4: Deterministic shuffle in label propagation so community IDs don't shift
// between runs of the same graph version.
function seededRNG(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Community Detection (Label Propagation) ---

export function detectCommunities(graph: KnowledgeGraph): CommunitySummary[] {
  const { nodes, edges } = graph;
  if (nodes.length === 0) return [];

  // Build adjacency list
  const nodeIndex = new Map<string, number>();
  nodes.forEach((n, i) => nodeIndex.set(n.id, i));

  const adj: Map<number, { neighbor: number; weight: number }[]> = new Map();
  for (let i = 0; i < nodes.length; i++) adj.set(i, []);

  for (const edge of edges) {
    const si = nodeIndex.get(edge.source);
    const ti = nodeIndex.get(edge.target);
    if (si === undefined || ti === undefined) continue;
    adj.get(si)!.push({ neighbor: ti, weight: edge.weight });
    adj.get(ti)!.push({ neighbor: si, weight: edge.weight });
  }

  // Initialize labels
  const labels = nodes.map((_, i) => i);
  const rand = seededRNG(graph.version);

  // Iterate
  const MAX_ITERATIONS = 20;
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let changed = false;

    // Process nodes in deterministic-random order (seeded per graph version)
    const order = [...Array(nodes.length).keys()];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }

    for (const idx of order) {
      const neighbors = adj.get(idx)!;
      if (neighbors.length === 0) continue;

      // Count weighted label frequencies
      const labelWeights = new Map<number, number>();
      for (const { neighbor, weight } of neighbors) {
        const lbl = labels[neighbor];
        labelWeights.set(lbl, (labelWeights.get(lbl) ?? 0) + weight);
      }

      // Find most frequent label
      let bestLabel = labels[idx];
      let bestWeight = 0;
      for (const [lbl, w] of labelWeights) {
        if (w > bestWeight) {
          bestWeight = w;
          bestLabel = lbl;
        }
      }

      if (bestLabel !== labels[idx]) {
        labels[idx] = bestLabel;
        changed = true;
      }
    }

    if (!changed) break;
  }

  // Group nodes by label
  const communities = new Map<number, number[]>();
  labels.forEach((lbl, idx) => {
    if (!communities.has(lbl)) communities.set(lbl, []);
    communities.get(lbl)!.push(idx);
  });

  // Build summaries
  const result: CommunitySummary[] = [];
  let communityCounter = 0;

  for (const [, memberIndices] of communities) {
    if (memberIndices.length === 0) continue;

    const communityId = `community-${communityCounter++}`;
    const memberNodes = memberIndices.map((i) => nodes[i]);

    // Assign community_id to nodes (mutates in place)
    for (const node of memberNodes) {
      node.community_id = communityId;
    }

    // Compute top domains
    const domainCounts = new Map<string, number>();
    for (const node of memberNodes) {
      for (const d of node.domains) {
        domainCounts.set(d, (domainCounts.get(d) ?? 0) + 1);
      }
    }
    const topDomains = [...domainCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([d]) => d);

    // Generate summary from most common types and domains
    const typeCounts = new Map<string, number>();
    for (const node of memberNodes) {
      typeCounts.set(node.type, (typeCounts.get(node.type) ?? 0) + 1);
    }
    const topType = [...typeCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "mixed";
    const domainLabel = topDomains.slice(0, 3).join(", ") || "general";

    result.push({
      id: communityId,
      label: `${topType} cluster: ${domainLabel}`,
      node_count: memberNodes.length,
      top_domains: topDomains,
      summary: `${memberNodes.length} learnings primarily about ${domainLabel}, mostly ${topType.replace("_", " ")}s`,
    });
  }

  return result;
}

// --- Hub Identification ---

export function identifyHubs(graph: KnowledgeGraph): string[] {
  const { nodes, edges } = graph;
  if (nodes.length === 0) return [];

  // Compute degree per node
  const degree = new Map<string, number>();
  for (const n of nodes) degree.set(n.id, 0);
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }

  // Compute mean and stddev
  const degrees = [...degree.values()];
  const mean = degrees.reduce((a, b) => a + b, 0) / degrees.length;
  const variance =
    degrees.reduce((sum, d) => sum + (d - mean) ** 2, 0) / degrees.length;
  const stddev = Math.sqrt(variance);

  const threshold = mean + stddev;
  const hubs: string[] = [];
  for (const [id, deg] of degree) {
    if (deg > threshold && deg > 1) {
      hubs.push(id);
    }
  }
  return hubs;
}

// --- Relevance Scoring ---

export function scoreRelevance(
  node: KnowledgeNode,
  context: { scopes: string[]; keywords: string[]; querySimilarity?: number; precomputedKeywords?: Set<string> },
  hubIds: Set<string>,
  graphTuning?: OrgTuning["graphScoring"],
): number {
  const recencyDecayDays = graphTuning?.recencyDecayDays ?? DEFAULT_ORG_TUNING.graphScoring.recencyDecayDays;
  // Domain overlap
  const scopeSet = new Set(context.scopes);
  let domainMatch = 0;
  for (const d of node.domains) {
    if (scopeSet.has(d)) domainMatch++;
  }
  const domainScore = node.domains.length > 0 ? domainMatch / node.domains.length : 0;

  // Keyword match
  const nodeKw = context.precomputedKeywords ?? extractKeywords(`${node.summary} ${node.details}`);
  let kwMatch = 0;
  for (const kw of context.keywords) {
    if (nodeKw.has(kw.toLowerCase())) kwMatch++;
  }
  const keywordScore =
    context.keywords.length > 0 ? Math.min(1, kwMatch / context.keywords.length) : 0;

  // Confidence
  const confidenceScore = node.confidence_score;

  // Recency — decay over configured window
  const ageMs = Date.now() - new Date(node.created_at).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  const recencyScore = Math.max(0, 1 - ageDays / recencyDecayDays);

  // Hub bonus
  const hubScore = hubIds.has(node.id) ? 1 : 0;

  // Hybrid scoring: when a query embedding is available and the node has one,
  // cosine similarity becomes the primary signal; keyword/domain become rerankers.
  if (context.querySimilarity !== undefined && node.embedding) {
    return (
      context.querySimilarity * 0.5 +
      keywordScore * 0.2 +
      domainScore * 0.15 +
      confidenceScore * 0.1 +
      recencyScore * 0.05
    );
  }

  // Fallback: keyword + domain scoring (original behavior)
  return (
    domainScore * 0.4 +
    keywordScore * 0.3 +
    confidenceScore * 0.15 +
    recencyScore * 0.1 +
    hubScore * 0.05
  );
}
