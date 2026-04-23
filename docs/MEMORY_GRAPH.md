# The PIM Memory Graph: Persistent Organizational Intelligence

> **What this is:** A living, self-organizing knowledge graph that accumulates the institutional memory of every sprint your org has ever run — and makes it instantly queryable by any agent, in any future pod, at a fixed token cost.

---

## The Core Idea

Every organization that runs agentic pods is sitting on a problem it doesn't fully see yet: the knowledge generated in Sprint 14 is gone when Sprint 15 starts. Decisions, resolved conflicts, patterns that worked, patterns that failed — all of it lives in chat logs or Notion pages that no agent will ever read again.

PIM solves this with a graph that never forgets.

When a pod closes, its distilled learnings are extracted and added to a persistent knowledge graph — a structured network of nodes and edges that spans the entire org's history. When a new pod starts, it queries that graph and inherits everything relevant, instantly. No agent needs to ask "has anyone tried this before?" because the answer is already in their context window.

And unlike a document or a database, the graph gets *smarter* as it grows. New nodes are automatically connected to existing ones. Communities of related knowledge self-organize. The most cross-referenced facts rise to the top.

---

## What Lives in the Graph

### Five types of knowledge nodes

| Node Type | What it captures | Confidence at creation |
|-----------|-----------------|----------------------|
| `decision` | Architectural, product, or process decisions that were made and committed | 0.85–0.9 |
| `pattern` | Approaches that worked and should be repeated | 0.4–0.85 |
| `anti_pattern` | Approaches that failed and should be avoided | 0.4–0.85 |
| `resolved_conflict` | Contradictions that were surfaced and resolved, with the resolution captured | 0.9 |
| `scope_insight` | Domain-specific learnings (frontend, backend, design, qa, infra, pm) | 0.85 |

Every node carries:
- **`summary`** — 1–2 sentence distillation, the unit of retrieval
- **`details`** — full context, only delivered when explicitly requested
- **`domains`** — scope tags that control which agents receive this node
- **`confidence`** / **`confidence_score`** — how certain the system is (see below)
- **`source_pod_id`** / **`source_project_id`** — provenance, always traceable
- **`embedding`** — a 512-dimensional vector from Amazon Titan Text Embeddings v2, enabling semantic search
- **`curated`** — whether a human has reviewed and approved this node

### Five types of edges

Edges are the intelligence layer on top of the nodes. They encode *how* pieces of knowledge relate:

| Edge Type | Meaning |
|-----------|---------|
| `supersedes` | A newer decision replaces an older one. The older node is automatically hidden from queries. |
| `contradicts` | An anti_pattern and a pattern in the same domain conflict with each other |
| `builds_on` | A pattern extends or refines another pattern |
| `resolved_by` | A conflict was resolved by a specific decision or pattern |
| `relates_to` | General semantic or domain overlap |

Edges are not manually created. They are inferred automatically every time new nodes are added (see "Self-Organization" below).

---

## Three Entry Points: How Knowledge Flows In

Knowledge reaches the graph through three distinct pathways, each operating at a different point in the pod lifecycle.

### 1. Real-time: Decisions and Spec Changes During Active Sprints

```typescript
// From knowledge-graph.ts
export function maybeAddPodContextSignalToGraph(
  podId, podName, type, summary, details, scope, project
): { added: boolean }
// Only ingests type === "decision" | "spec_change"
// confidence_score: 0.85 — slightly discounted because the pod is still live
```

The moment any agent submits a `decision` or `spec_change` context update, it is immediately added to the graph — not after the sprint closes, but *now*. This means a concurrent pod running in parallel gets to see it on their next query. Decisions made in the morning are available to other teams by afternoon.

The 0.85 confidence score (slightly below the archival 0.9) is intentional: the pod is still live, the decision may still shift. Archival-time extraction can add a higher-confidence version once the outcome is confirmed.

### 2. Real-time: Conflict Resolutions

```typescript
export function addResolvedConflictToGraph(
  podId, podName, summary, details, scope, project
): { added: boolean }
// confidence_score: 0.9 — outcome is committed
```

The moment the Conflict Center resolves a contradiction, a `resolved_conflict` node is written to the graph at 0.9 confidence. Before this mechanism existed, conflict resolutions were invisible to concurrent pods — they only surfaced at archival, days later. Now, the resolution of "should we use REST or GraphQL for this API?" in Pod A becomes visible to Pod B within seconds of resolution.

### 3. Archival: Full Extraction at Pod Close

When a pod is archived, the Knowledge Extraction Agent runs a comprehensive pass over all of the pod's context updates, resolved conflicts, and decisions. This produces `EnhancedPodLearning[]` — structured node candidates that are then added to the graph via `addLearningsToGraph()`.

The extraction pipeline runs a near-duplicate check before adding any node:

```typescript
// Same-pod threshold: 0.85 — catches re-extracted versions of nodes already in the graph
// Cross-pod threshold: 0.95 — catches near-verbatim patterns from different pods
const isDuplicate = graph.nodes.some((existing) => {
  const sim = cosineSimilarity(node.embedding, existing.embedding);
  return existing.source_pod_id === podId ? sim >= samePodThreshold : sim >= crossPodThreshold;
});
if (isDuplicate) { skipped++; continue; }
```

The different thresholds are deliberate. A same-pod node at 0.85 cosine similarity is almost certainly a re-extraction of something already captured in real-time. A cross-pod node at 0.95 represents a genuinely separate team discovering the same pattern — different pods independently reaching the same conclusion is *high-signal confirmation* of a pattern, but 0.95 is conservative enough that meaningful variations get their own node.

---

## Self-Organization: How the Graph Structures Itself

Every time nodes are added, three analyses run automatically.

### Edge Building: Automated Relationship Inference

```typescript
// Scoring (with embeddings):
combinedScore = cosineSimilarity(a.embedding, b.embedding) * 0.7 + domainOverlap * 0.3

// Scoring (without embeddings, fallback):
combinedScore = keywordOverlap(a.summary, b.summary) * 0.6 + domainOverlap * 0.4

// Threshold: only edges with combinedScore >= 0.3 are created
```

Edge *types* are inferred from the node types:

```
anti_pattern ↔ pattern           → contradicts
newer decision ↔ older decision  → supersedes
resolved_conflict ↔ anything     → resolved_by
pattern ↔ pattern                → builds_on
everything else                  → relates_to
```

A node added today is instantly connected to every historically relevant node in the graph — no human action required.

### Community Detection: Label Propagation Clustering

After every mutation, the graph runs a weighted label propagation algorithm over all nodes. The algorithm:
1. Assigns each node its own label
2. Iteratively updates each node's label to the most frequent label among its weighted neighbors
3. Converges when no labels change (max 20 iterations)
4. Groups nodes with the same final label into a `CommunitySummary`

The result: naturally cohesive clusters of related knowledge. A "decision cluster: backend, auth" might contain 12 nodes from 4 different pods spanning 6 months. The algorithm uses a seeded PRNG (`mulberry32` initialized from `graph.version`) so community IDs are deterministic — the same graph always produces the same clusters.

Communities serve as the graph's table of contents: a quick scan of community summaries tells an agent where the dense concentrations of relevant knowledge are.

### Hub Identification: Statistical Prominence

After community detection, the graph identifies hubs — nodes that are exceptionally well-connected:

```typescript
const threshold = mean + stddev; // 1 standard deviation above average degree
if (degree > threshold && degree > 1) hubs.push(id);
```

Hub nodes receive a scoring bonus at query time. A node that 15 different pods have built edges toward is almost certainly one of the most important facts in the graph. The hub mechanism surfaces these facts automatically, without any human curation.

---

## Retrieval: The Hybrid Scoring Pipeline

When an agent queries the graph, five factors combine to score every candidate node:

**With query embeddings (semantic mode):**
```
final_score =
  cosine_similarity(query, node)   × 0.50   ← primary signal
  keyword_match                    × 0.20
  domain_match                     × 0.15
  confidence_score                 × 0.10
  recency_score (90-day decay)     × 0.05
```

**Without embeddings (keyword fallback):**
```
final_score =
  domain_match                     × 0.40
  keyword_match                    × 0.30
  confidence_score                 × 0.15
  recency_score (90-day decay)     × 0.10
  hub_bonus                        × 0.05
```

The recency decay is calibrated at 90 days — long enough that architectural decisions from last quarter still surface, short enough that two-year-old patterns from a deprecated stack don't crowd out recent ones. Nodes never expire; they just score lower over time unless their confidence or hub status compensates.

The query pipeline then enforces a hard token budget:

```typescript
for (const { node } of scored) {
  const nodeTokens = estimateNodeTokens(node, include_details); // 20 or 100 tokens/node
  if (tokenCount + nodeTokens > tokenBudget) break;
  resultNodes.push(node);
}
```

The highest-scoring nodes that fit within the budget are returned. The result always includes `truncated: true` when more matching nodes exist, so the caller knows it received a representative sample, not the complete set.

---

## The Human Curation Layer

Automated extraction is powerful but not infallible. PIM's `/knowledge` UI gives humans three curation actions on any node:

| Action | Effect |
|--------|--------|
| **Approve** | Sets `curated: true` — node can be queried with `curated_only: true` filter for high-trust contexts |
| **Edit** | Corrects summary, details, or domain tags; automatically sets `curated: true` |
| **Reject** | Permanently removes the node and all its edges; **critically, also clears `superseded_by`** on any nodes this node was superseding, restoring their visibility |

The reject-with-orphan-recovery behavior is important. If the system extracted a bad decision node that had automatically been flagged as superseding an older (correct) decision, a naive delete would leave the older node permanently hidden. The implementation explicitly restores visibility:

```typescript
if (action === "reject") {
  for (const n of graph.nodes) {
    if (n.superseded_by === nodeId) n.superseded_by = undefined;
  }
  graph.nodes.splice(nodeIndex, 1);
  graph.edges = graph.edges.filter(e => e.source !== nodeId && e.target !== nodeId);
}
```

This means human rejection is safe and reversible in all cases, including structurally complex ones.

---

## The Compounding Value Property

This is the most important property of the system, and the one that doesn't exist in any ephemeral context approach.

Each new pod that closes makes the graph more valuable for every future pod. This isn't a metaphor — it's structural:

- More nodes → more edges (edge count grows faster than node count due to cross-pod connections)
- More edges → better community detection (clusters become more coherent with more signal)
- More communities → more precise hub identification (hubs emerge from genuine cross-cluster importance)
- Better hubs → higher-quality retrieval (the most important facts surface first)

An org on its 5th pod has a graph that is qualitatively different from an org on its 1st. By the 20th pod, patterns that have been independently validated across multiple teams carry high confidence from multiple sources. Anti-patterns that burned three different pods are flagged with strong signals pointing to all three incidents. Conflict resolutions that were contentious the first time are pre-answered when the same tension surfaces again.

The graph doesn't just store the past. It makes the past actionable in the present — at a fixed retrieval cost, regardless of how large the graph grows.

---

## Architectural Constraints That Enable All of This

Three design choices make the above possible without a dedicated graph database, a vector store, or a search service:

**1. In-memory with versioned persistence**
The full graph is loaded into memory at server start and persisted to disk on every mutation. Community detection and hub identification run in-process. No round-trips to an external graph database for reads. The implementation notes explicitly: "No external graph library — adequate for hundreds to low-thousands of nodes." For a single org's accumulated knowledge, this is the right tradeoff.

**2. Embeddings as an enhancement, not a requirement**
The system degrades gracefully when Bedrock is unavailable. Every query and edge-building operation has a keyword/domain fallback that requires no vector math. Embeddings are backfilled asynchronously on server startup for any nodes that were created without them. This means the graph is useful from day one, even without AWS credentials configured.

**3. Single-file storage abstraction**
The storage layer (`graph-storage.ts`) exposes three functions: load, save, and check-existence. Swapping from local filesystem to S3-versioned storage is a single-file change. The rest of the system is storage-agnostic. Local dev uses `.data/knowledge-graph/`. Production uses S3 with versioned JSON snapshots and DynamoDB GSIs for indexed queries by domain, type, and confidence.

---

## Summary

The PIM memory graph is the answer to a question most agentic platforms haven't asked yet: *what happens to the intelligence generated in a sprint after the sprint is over?*

The answer is: it is distilled, structured, connected to everything relevant that came before it, and made instantly queryable by any future agent — at a token cost that doesn't grow with the size of the org's history.

It is not a log. It is not a search index. It is an evolving model of what your organization has learned, who learned it, how confident the system is that it's still true, and how it connects to everything else you know.
