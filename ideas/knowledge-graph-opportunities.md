# Knowledge graph: opportunities to improve agent recall

This note captures opportunities identified while reviewing the current knowledge-graph implementation and how agents will retrieve historical context over time.

## Current behavior (baseline)

- Retrieval is primarily **node-centric**: filter nodes → relevance score → truncate to a token budget.
- Graph structure is currently used mainly for:
  - **hub bonus** in scoring (high-degree nodes)
  - **communities** for clustering / UI organization
  - optional **edge inclusion** in responses (only edges among returned nodes)

## Opportunities

### 1) Make retrieval *edge-aware* (1–2 hop expansion)

Today, edges are not used to expand context. Add an optional step:

- After selecting the top-\(k\) “seed” nodes, expand by 1–2 hops to pull:
  - `supersedes` chains (what replaced what)
  - `contradicts` neighbors (what disagrees)
  - `resolved_by` / `resolved_conflict` precedents
  - high-weight `builds_on` dependencies
- Budget expansion with explicit quotas (e.g., max 2 neighbors per seed, prioritize by edge type/weight).

**Why this matters**: this is the main access advantage a graph can offer future agents vs. a tagged list.

### 2) Fix keyword-driven relevance in `getRelevantLearnings()`

`getRelevantLearnings(scopes, activeConflictSummaries, maxTokens)` currently computes keywords from conflicts but does not pass them into query filters/scoring. Options:

- Add a `text_search` filter derived from conflicts (top N keywords / phrases)
- Or extend `queryKnowledge()` to accept an explicit `keywords` array (so scoring can use it)

**Why this matters**: without this, “bring me relevant historical context for *this* conflict” collapses to “bring me domain-matched nodes.”

### 3) Make edges more semantic (reduce noisy “relates_to”)

Edge building today is keyword/domain overlap with a few type rules. As the graph grows, this can create many edges that don’t improve retrieval.

Improvements:

- Require stronger evidence for `relates_to` (higher threshold or minimum keyword overlap count)
- Prefer typed edges when possible (e.g., decision supersedes decision only with explicit cues)
- Add a lightweight “edge justification” field (even a short string) for debugging and trust

### 4) Add “precedent-first” query paths for conflicts/decisions

Common agent questions are not “show me relevant nodes,” but:

- “What’s the most recent **decision** in this domain, and what does it supersede?”
- “What **resolved conflicts** look like this conflict?”
- “What **anti-patterns** should we avoid in this area?”

Provide convenience endpoints / SDK helpers that encode these patterns (typed filters + edge expansion + budgets).

### 5) Use curation more aggressively in ranking

You already have `curated` on nodes. Future agents benefit if:

- curated nodes get a meaningful ranking boost
- non-curated nodes are still retrievable but de-prioritized unless they match strongly
- UI workflows make “approve/edit/reject” low-friction

### 6) Add stable, agent-friendly “source trails”

Nodes store `source_pod_id` and `source_pod_name`. Consider also:

- a stable `source_artifact_refs[]` (e.g., conflict IDs, decision IDs, doc section IDs)
- optional `source_urls[]` (PR, issue, doc snapshot) where available

This makes it easier for future agents to *verify* context quickly.

### 7) Plan for scale: keep query cost predictable

Current storage is a single JSON file loaded into memory. That’s fine for hundreds–low-thousands of nodes, but:

- scoring today is \(O(n)\) over candidates each query
- community detection is randomized label propagation

Future-proofing ideas:

- maintain per-domain/type indices in memory
- precompute keyword signatures (tokens) per node
- migrate storage to S3/DynamoDB while keeping the same query API

## Suggested next step (small, high leverage)

Implement:

1) keyword-aware retrieval in `getRelevantLearnings()`, and
2) an optional 1-hop expansion that pulls `supersedes/contradicts/resolved_by` neighbors under a strict budget.

That’s the fastest path to making the “graph” materially more helpful than a flat, tagged knowledge base for future agents.

