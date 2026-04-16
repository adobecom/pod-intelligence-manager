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
} from "@council/shared";

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
]);

function extractKeywords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
  );
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

export function buildEdges(
  newNodes: KnowledgeNode[],
  existingNodes: KnowledgeNode[],
): KnowledgeEdge[] {
  const edges: KnowledgeEdge[] = [];

  for (const newNode of newNodes) {
    for (const existing of existingNodes) {
      if (newNode.id === existing.id) continue;

      const summaryOverlap = keywordOverlap(newNode.summary, existing.summary);
      const domOverlap = domainOverlap(newNode.domains, existing.domains);
      const combinedScore = summaryOverlap * 0.6 + domOverlap * 0.4;

      if (combinedScore < 0.3) continue;

      // Determine edge type based on node types
      const edgeType = inferEdgeType(newNode, existing);

      edges.push({
        source: newNode.id,
        target: existing.id,
        type: edgeType,
        weight: Math.min(1, combinedScore),
      });
    }
  }

  return edges;
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

  // Newer decision in the same domain supersedes older decision
  if (newer.type === "decision" && older.type === "decision") {
    return "supersedes";
  }

  // Pattern building on another pattern
  if (newer.type === "pattern" && older.type === "pattern") {
    return "builds_on";
  }

  return "relates_to";
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

  // Iterate
  const MAX_ITERATIONS = 20;
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let changed = false;

    // Process nodes in random order
    const order = [...Array(nodes.length).keys()];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
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
  context: { scopes: string[]; keywords: string[] },
  hubIds: Set<string>,
): number {
  // Domain overlap (0.4 weight)
  const scopeSet = new Set(context.scopes);
  let domainMatch = 0;
  for (const d of node.domains) {
    if (scopeSet.has(d)) domainMatch++;
  }
  const domainScore =
    node.domains.length > 0
      ? domainMatch / node.domains.length
      : 0;

  // Keyword match (0.3 weight)
  const nodeKw = extractKeywords(`${node.summary} ${node.details}`);
  let kwMatch = 0;
  for (const kw of context.keywords) {
    if (nodeKw.has(kw.toLowerCase())) kwMatch++;
  }
  const keywordScore =
    context.keywords.length > 0
      ? Math.min(1, kwMatch / context.keywords.length)
      : 0;

  // Confidence (0.15 weight)
  const confidenceScore = node.confidence_score;

  // Recency (0.1 weight) — newer = higher, decay over 90 days
  const ageMs = Date.now() - new Date(node.created_at).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  const recencyScore = Math.max(0, 1 - ageDays / 90);

  // Hub bonus (0.05 weight)
  const hubScore = hubIds.has(node.id) ? 1 : 0;

  return (
    domainScore * 0.4 +
    keywordScore * 0.3 +
    confidenceScore * 0.15 +
    recencyScore * 0.1 +
    hubScore * 0.05
  );
}
