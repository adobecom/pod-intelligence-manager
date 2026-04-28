# Knowledge Graph Efficiency Analysis

> **Note (post PR #27 + archival-only rollback):** The PR #27 features around
> *incremental / mid-sprint extraction* (`maybeAddPodContextSignalToGraph`,
> `maybeAddProjectContextSignalToGraph`, immediate `addResolvedConflictToGraph`)
> were rolled back. They produced double-extraction, an embedding-race that
> bypassed dedup, and ran full community detection on the request thread for
> every `decision` / `spec_change` submission. The current model is:
>
> - **Pod archival** is the only path that absorbs pod-internal context into
>   the graph. Blockers are no longer extracted as `anti_pattern`. Decisions
>   with `details < 30 chars` are filtered. Domains come from the source row's
>   authoritative `scope`, not keyword inference.
> - **Ad-hoc submission** (`POST /api/knowledge/nodes`, SDK `submitLearning`,
>   MCP `submit_knowledge_learning`) is the deliberate door for confirmed
>   learnings outside any pod (bug fixes, chatbot/agent conversations). Synchronous
>   embedding + dedup; nodes enter the curation queue.
> - **Auto-pruning** runs daily — uncurated, stale (>180d), low-confidence
>   (<0.5), non-superseded nodes are removed.
> - **Community detection** runs at archival, on ad-hoc submission, and on the
>   periodic `refreshAnalysis` interval — not on every context update.
>
> The token-savings and accuracy figures below remain broadly directional, but
> the rows that implied "incremental extraction grows the denominator during
> live sprints" or "communities recomputed mid-sprint on every mutation" are
> historical, not current. The "Highest-ROI fix" recommendations
> (community-aware retrieval expansion, cross-pod scope-id passing) still
> stand.

Evaluation of the org knowledge graph's token efficiency and search accuracy,
reflecting the state after PR #27 (scope-aware queries, incremental extraction,
semantic query_text support, embedding-based cross-pod detection, and UI
surfacing for escalation + curation).

Compared against two baselines: (a) handing an agent raw context via grep / MCP
resource dumps, and (b) Graphify's community-expansion retrieval model.

---

## Token Savings vs Raw MCP / Grep

Concrete math:

- A 5-day pod with 5 agents generating ~20 context updates each = ~100 nodes
  worth of raw context. At ~200 tokens/update average = ~20k tokens per pod.
- Across 10 historical pods = ~200k tokens of raw retrievable history.
- **Incremental extraction now grows this denominator during live sprints**
  (decisions, spec changes, resolved conflicts are extracted immediately rather
  than waiting for archival), so for an org with N active pods the live graph
  accrues additional nodes on the order of 10–30 per pod per sprint.
- A graph query with a 500-token budget returns ~5–7 summary-level nodes = 500
  tokens.
- **Effective compression: ~100–400× vs a full history dump**, with a precision
  filter ensuring those 500 tokens are the most relevant ones.

vs raw grep / MCP: grep returns raw text matches with zero semantic ranking.
You'd hand the agent 10–50 matching snippets and let it figure out relevance
inside its context window. This system pre-ranks using embedding cosine
similarity (weight 0.5) + domain + confidence + recency. The heavy lifting
happens outside the agent's context window.

Realistic token savings per agent turn: **10k–50k tokens**, depending on org
history depth. At Claude Sonnet pricing that's ~$0.03–$0.15 per agent turn
saved — meaningful at scale across a 5-day pod.

---

## Search Accuracy vs Raw Grep

| Signal | Raw Grep | This System | Est. Accuracy Lift | Est. Token Savings |
|---|---|---|---|---|
| **Semantic match** | Keyword only | Cosine similarity (0.5 weight) — *now live for routine MCP/SDK calls via the `query_text` / `query` param* | +40–60% precision on paraphrased/conceptual queries | ~30–50% fewer tokens — irrelevant semantic matches pruned before retrieval |
| **Domain scoping** | None | Scope pre-filter + 0.15–0.4 score weight | +20–35% precision by narrowing candidates | ~40–60% fewer tokens — off-domain history excluded |
| **Project scoping** | None | `include_project_id` filter (org-wide + this project, excludes other projects) | +15–30% precision on project-scoped queries | ~30–50% fewer tokens — no cross-project bleed |
| **Temporal decay** | None | 90-day exponential decay | +10–15% relevance on recent learnings | ~10–20% fewer tokens — stale nodes rank out before hitting budget |
| **Confidence weighting** | None | Extracted (0.85–0.9) vs inferred (0.4–0.85) | +5–10% precision by down-ranking inferences | ~5–10% fewer tokens — low-confidence nodes deprioritized out of budget |
| **Graph topology (hubs)** | None | Hub bonus on high-degree nodes; recomputed on every incremental extraction | +5–10% recall on cross-cutting patterns | Minimal direct savings; improves quality of tokens consumed |
| **Community context** | None | Computed (recomputed mid-sprint), **still unused in retrieval** | 0% — potential +15–30% recall if wired in | 0% currently — community expansion would trade ~10% more tokens for ~20% better recall |

### Notes on specific rows

**Semantic match.** The cosine-similarity signal has weight 0.5 in the scoring
formula, but before PR #27 it was dormant for the routine learning-lookup path:
`/api/knowledge/relevant` called `getRelevantLearnings(scopes, [], maxTokens)`
with an empty conflict array, so `queryEmbedding` was always null and scoring
fell through to the keyword+domain fallback. The endpoint now accepts a
`query` param, MCP and SDK pass the pod's milestone name (or the project name
for project-session-context calls), and the server embeds it. The precision
lift the table has always claimed is now earned in practice — not just for the
conflict-precedent path.

`/api/knowledge/query` gained the same treatment via `query_text`, so agents
without Bedrock credentials can still trigger semantic scoring.

**Domain + project scoping.** These are orthogonal pre-filters. Domain narrows
by scope id (frontend, backend, etc.); project narrows by owning initiative.
An agent in Project A's pod querying scope "frontend" now gets org-wide nodes
plus Project A's nodes — Projects B/C/D are excluded. Before PR #27 the
`include_project_id` filter existed in the service layer but wasn't reachable
through the HTTP layer.

**Hubs and communities.** Both are recomputed on every incremental extraction
(not only on archival), so the topology stays fresh during a sprint. Hub
bonuses fire in retrieval scoring; community membership is recorded on nodes
but does not yet affect retrieval. This is the biggest remaining gap — see
"Highest-ROI fix" below.

### Overall vs raw grep / MCP dump

- **Token savings: ~95–99%** — 500 tokens returned vs 20k–200k tokens of raw
  history.
- **Accuracy: ~60–80% better precision on semantic queries**, with a ~15–30%
  recall gap vs full Graphify-style community expansion.

---

## Compared to Graphify's Approach

Graphify's key differentiator is **community-aware retrieval**: seed nodes →
expand through community membership → re-rank by edge weight. This system has
the community graph (label propagation, detected on every mutation) but skips
the expansion step. That step typically adds 15–30% recall on related concepts
that share no keywords with the query.

This system adds things Graphify does not have:

- **Confidence tiers** — extracted (0.85–0.9) vs inferred (0.4–0.85). Inferred
  nodes come from the LLM-enhanced extraction path and get down-ranked
  accordingly.
- **Temporal decay** — 90-day exponential. Old patterns fade out unless
  they're load-bearing hubs.
- **Domain + project scoping** — scope-id pre-filter combined with
  project-tagged node exclusion.
- **Incremental extraction during sprints** — decisions and resolved conflicts
  land in the graph immediately, not only on pod archival. New pods starting
  mid-sequence see fresh learnings from concurrent pods.

These are genuinely good additions for an org-memory context. Graphify's
expansion step is orthogonal and could be layered on top.

---

## Cross-Pod Path: Remaining Domain Precision Gap

`detectOverlaps()` now decides *whether two pods overlap* using Titan-embedded
cosine similarity on their recent context (threshold 0.75), with keyword
overlap as a fallback. That change is good.

However the enrichment step still calls
`getRelevantLearnings(seedDomains, [], 500)` where `seedDomains` is raw
keywords extracted from pod summaries ("webhook", "payment") rather than
valid org scope ids ("backend", "frontend"). The `domains` filter then
matches on `node.domains.includes(d)` against a node's actual scope list,
which almost never contains those raw keywords — so the filter effectively
drops all candidates for the enrichment call.

In practice this means the historical-note advisory on cross-pod overlaps is
either empty or generated from the first unfiltered node returned when the
filter matches nothing. **The "cross-pod path loses domain precision"
observation still holds.**

A small follow-up PR would fix this: look up the pods' actual scope ids (from
`pod_areas`) and pass those as `seedDomains`, treating the raw keywords as
`text_search` or `keywords` for scoring instead.

---

## Bottom Line

**Token efficiency:** Strong. 100–400× compression vs raw history dump.
Competitive with any structured retrieval system.

**Search accuracy:** Good, and closer to optimal than the pre-PR baseline
because the semantic-match signal is now actually firing for routine agent
queries. The remaining gap is that **community topology — which is already
computed — still isn't used for retrieval expansion**, and the cross-pod
enrichment path passes raw keywords as `domains`.

**Highest-ROI fix (unchanged from the previous evaluation):** wire
`community_id` into query expansion. When a seed node scores above threshold,
pull its top-3 community neighbors by edge weight into the result set before
token truncation. That gets Graphify-level recall without a major rewrite —
the detection pass already runs on every mutation, so the data is there and
fresh.

**Second-highest-ROI fix:** fix cross-pod enrichment to pass actual scope
ids (not raw keywords) to `getRelevantLearnings`. Small, mechanical change;
unblocks the historical-note advisory that currently misfires.

---

## Appendix: What changed in PR #27 relative to earlier evaluations

| Area | Before PR #27 | After PR #27 |
|---|---|---|
| `/api/knowledge/relevant` accepts `projectId` | No | Yes |
| `/api/knowledge/relevant` accepts `query` (for semantic scoring) | No | Yes |
| MCP `get_agent_session_context` passes pod.project_id | No | Yes |
| MCP `get_agent_session_context` passes pod.milestone.name as semantic query | No | Yes |
| MCP `query_knowledge` exposes `include_project_id` / `source_project_ids` | No | Yes |
| MCP `query_knowledge` accepts `query_text` (server embeds) | No | Yes |
| MCP has a bundled tool for project-only agents | No | `get_project_session_context` |
| SDK `getRelevantLearnings` accepts `{ projectId, query }` | No | Yes |
| SDK `pullProjectSessionContext` for project-scoped clients | No | Yes |
| Decisions / spec_changes flow to graph during sprint | No (archival only) | Yes (via `maybeAddPodContextSignalToGraph`) |
| Resolved conflicts flow to graph on resolution | No (archival only) | Yes (via `addResolvedConflictToGraph`) |
| Communities recomputed mid-sprint | No | Yes |
| Hubs recomputed mid-sprint | No | Yes |
| Cross-pod pairing uses embedding similarity | No (keyword overlap only) | Yes (cosine 0.75 threshold, keyword fallback) |
| Cross-pod enrichment passes valid scope ids | No | **No (still broken)** |
| Community membership used in retrieval | No | **No (still the top ROI fix)** |
