# Indexed Project Search Plan

Status: planning note.

This plan restores the mind-map side of PIM without expanding workflow-management scope. It focuses on project-scoped search over current project artifacts, while keeping the org knowledge graph reserved for durable learnings.

## Goal

Give agents and humans one fast, cheap, project-aware search surface for:

- where something is implemented,
- where it was discussed,
- what the current status is,
- which tickets, PRs, docs, updates, people, files, and decisions are connected.

This should reduce dependence on loading many separate MCPs or live-fanning out to every external system on every query.

## Core Boundary

Use two different memory layers:

| Layer | Stores | Answers |
|---|---|---|
| Project search index | Current/raw project artifacts and chunks | "Where is this discussed, implemented, planned, or blocked?" |
| Org knowledge graph | Durable promoted learnings | "What decision, pattern, anti-pattern, or precedent should matter again?" |

Raw project facts do not belong directly in the org KG. They stay in the project index. Only selected durable learnings are promoted to KG nodes.

## Existing Starting Point

The repo already has the beginning of this shape:

- `project_context_updates` stores project-level updates.
- `project_evidence_items` stores normalized source evidence.
- `project_memory_candidates` stores promotion candidates for the KG.
- `project-answers.ts` searches project evidence, project updates, pod updates, and KG.

The gap: retrieval is currently mostly SQL keyword matching over evidence/update text plus KG lookup. It is not yet a hybrid indexed search layer.

## Proposed Local Data Model

Add project-search tables that can run on current SQLite and later migrate cleanly to Postgres.

### `project_search_documents`

One row per source artifact.

Fields:

- `id`
- `org_id`
- `project_id`
- `source`: `jira | github | confluence | slack | git | project_update | pod_update`
- `source_type`: issue, merged_pr, comment, page, thread, commit, file_summary, etc.
- `source_id`
- `source_url`
- `title`
- `author`
- `status`
- `occurred_at`
- `ingested_at`
- `updated_at`
- `content_hash`
- `metadata_json`
- `permissions_json`
- `freshness_state`: `fresh | stale | deleted | unknown`

### `project_search_chunks`

One row per searchable text chunk.

Fields:

- `id`
- `document_id`
- `org_id`
- `project_id`
- `chunk_index`
- `chunk_kind`: `title | body | comment | code | summary | metadata`
- `text`
- `retrieval_text`
- `embedding_json`
- `embedding_model`
- `embedding_text_hash`
- `token_estimate`
- `created_at`

For SQLite, add an FTS5 virtual table over `title`, `text`, and `retrieval_text`. For current hosted migration later, use Postgres full-text search plus `pgvector`.

### `project_search_entities`

Extracted nodes for the mind-map layer.

Fields:

- `id`
- `org_id`
- `project_id`
- `entity_type`: `ticket | pr | commit | file | symbol | person | doc | feature | decision | risk | blocker`
- `entity_key`
- `label`
- `aliases_json`
- `source_document_id`
- `metadata_json`
- `first_seen_at`
- `last_seen_at`

### `project_search_edges`

Extracted relationships for mind-map traversal.

Fields:

- `id`
- `org_id`
- `project_id`
- `source_entity_id`
- `target_entity_id`
- `edge_type`: `mentions | implements | fixes | blocks | owns | touches | discusses | supersedes | linked_to | cites_kg`
- `evidence_document_id`
- `confidence_score`
- `created_at`

These edges power navigation. They should not be treated as durable org truth unless promoted through the KG path.

## Ingestion Flow

1. Poll or receive project artifacts from configured resources.
2. Normalize into `project_search_documents`.
3. Chunk content into `project_search_chunks`.
4. Extract entities and relationships into `project_search_entities` and `project_search_edges`.
5. Embed changed chunks only.
6. Mirror high-signal artifacts into `project_evidence_items` when they may produce a durable learning.
7. Create or update `project_memory_candidates` only for facts that might deserve KG promotion.

Initial source order:

1. Project updates and pod updates.
2. GitHub PRs/issues/commits for configured repos.
3. Jira issues for configured project keys.
4. Confluence configured pages/spaces.
5. Slack only for explicitly configured channels or thread URLs.
6. Repo file/symbol summaries once local repo paths are configured.

## Query Flow

Endpoint shape:

```text
POST /api/projects/:projectId/search
```

Request:

```ts
{
  query: string;
  sources?: string[];
  entity_types?: string[];
  time_window_days?: number;
  include_kg?: boolean;
  include_mind_map?: boolean;
  max_hits?: number;
  synthesize?: boolean;
}
```

Retrieval:

1. Resolve `org_id` and `project_id`.
2. Detect exact identifiers: Jira keys, PR numbers, commit SHAs, file paths, symbols, people.
3. Run lexical search over FTS/BM25.
4. Run semantic search over chunk embeddings when embeddings are available.
5. Fuse lexical and semantic results.
6. Rerank with project metadata: recency, source type, status, exact identifier match, configured project resources.
7. Optionally attach project-scoped KG constraints using `query_text`.
8. Optionally return a small entity-edge neighborhood for the mind map.
9. Return citations and raw hits. Synthesis is optional and cached.

Do not live-fan out to all external systems by default. Live source calls are fallback, freshness repair, or explicit `use_live=true`.

## KG Promotion Rules

Project artifacts roll up only when they become durable learnings.

Promote:

- explicit decisions,
- resolved conflicts,
- repeated implementation patterns,
- verified anti-patterns/regressions,
- project-specific API or contract constraints,
- curated facts that should guide future agents.

Do not promote:

- raw Jira ticket descriptions,
- every PR summary,
- Slack discussion noise,
- temporary status updates,
- stale blockers,
- ordinary implementation details with no reuse value.

Promotion defaults:

- project-scoped KG node first, with `source_project_id`.
- org-wide visibility only after human curation, repeated use, or explicit promotion.
- every promoted node must keep source evidence IDs and URLs.

## UI And Mind Map

The mind map should render from `project_search_entities` and `project_search_edges`, with KG nodes as durable overlays.

Useful first map views:

- feature -> tickets -> PRs -> files,
- blocker -> owners -> discussion threads -> related decisions,
- file/symbol -> PRs -> bugs -> known constraints,
- decision -> affected tickets/files -> source evidence.

The map is a navigation and explanation layer, not the primary source of truth.

## Evaluation

Add a small labeled project-search eval before tuning weights.

Track:

- recall@k for known ticket/PR/doc/file answers,
- precision@k,
- wrong-project rate,
- stale-result rate,
- citation correctness,
- p50/p95 latency,
- embedding coverage,
- cache hit rate,
- cost per query.

Test cases should include:

- exact identifier lookup,
- vague semantic lookup,
- project alias lookup,
- actor/person lookup,
- stale source exclusion,
- wrong-project negative control,
- KG constraint attachment only when relevant.

## Implementation Phases

### Phase 1: Schema And Index Skeleton

- Add `project_search_documents`.
- Add `project_search_chunks`.
- Add SQLite FTS5 index for chunk text.
- Add basic repository helpers or narrowly scoped service functions.
- Backfill from existing `project_context_updates`, pod `context_updates`, and `project_evidence_items`.

Exit: project search can return cited lexical hits without live external fan-out.

### Phase 2: Hybrid Retrieval

- Generate embeddings for chunks using the existing embedding service.
- Store `embedding_json`, model, and text hash.
- Add semantic retrieval fallback using in-process cosine for SQLite.
- Add result fusion and source-aware ranking.
- Add a `POST /api/projects/:projectId/search` route.

Exit: project search handles exact and semantic queries with citations.

### Phase 3: Mind-Map Entities

- Add `project_search_entities`.
- Add `project_search_edges`.
- Extract obvious entities deterministically first: ticket keys, PRs, commits, file paths, URLs, people, KG node refs.
- Add map-neighborhood output to project search.

Exit: UI can render project artifact relationships without relying on KG as the raw corpus.

### Phase 4: KG Promotion Tightening

- Route only durable candidates into `project_memory_candidates`.
- Add promotion explanations: why this artifact is promotable and what source evidence supports it.
- Keep auto-promotion limited to high-confidence, non-Slack, non-contradicted evidence.
- Require human or repeated-use promotion before org-wide visibility.

Exit: project index remains broad/current; KG remains compact/durable.

### Phase 5: Evals And Contract Hardening

- Add retrieval eval fixtures.
- Add wrong-project and stale-result tests.
- Add embedding coverage telemetry.
- Add query logs for result fusion, top hits, and KG attachment decisions.

Exit: retrieval changes are measured before weight tuning or default rollout.

## Migration Note For Hosted Architecture

When moving to Aurora/Postgres, these project-search tables should migrate alongside the KG tables. The migration should not only move `knowledge_nodes` embeddings to `pgvector`; it should also move `project_search_chunks.embedding` to `pgvector` and replace SQLite FTS5 with Postgres full-text search.

Postgres v1 target:

- `project_search_chunks.embedding vector(EMBEDDING_DIMENSIONS)`
- HNSW or IVFFlat index on chunk embeddings
- GIN index over `to_tsvector(...)`
- composite indexes on `(org_id, project_id, source, occurred_at)`
- composite indexes on entity keys and edge endpoints

OpenSearch can be considered later if project-search volume or ranking needs outgrow Postgres. It should not be a prerequisite for proving the product value.
