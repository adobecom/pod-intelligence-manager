# Indexed Project Search Plan

> **Historical implementation plan.** For current behavior and operator controls, use
> [CONTEXT_SEARCH.md](./CONTEXT_SEARCH.md), [PROJECT_SEARCH_CONNECTORS.md](./PROJECT_SEARCH_CONNECTORS.md),
> and [PROJECT_SEARCH_SCRUB_RUNBOOK.md](./PROJECT_SEARCH_SCRUB_RUNBOOK.md).

Status: **Phases 1–3 implemented** (schema + index, hybrid retrieval, deterministic mind-map). Phase 4 (KG promotion) reuses the existing project-memory promotion path; Phase 5 (evals) has a focused test suite — see [Implementation status](#implementation-status).

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

## Implementation status

Landed on branch `pimUpdates`. The index is a layer *over* the existing project working memory (evidence items, project updates, linked pod updates) — it does not replace `project_evidence_items` or the KG promotion path.

### Schema (`packages/server/src/db/schema.ts`)
- `project_search_documents`, `project_search_chunks`, `project_search_entities`, `project_search_edges` (all org+project scoped, FK-cascading).
- `project_search_fts` — FTS5 (`porter unicode61`) over chunk title+body, created in a **guarded** block so a SQLite build without FTS5 degrades to a keyword-LIKE fallback instead of failing boot.

### Write path (`services/project-search-index.ts`)
- `indexProjectDocument()` — content-hash-guarded upsert: rebuilds chunks + FTS + the deterministic entity/edge mind-map only when content changes. Title is always its own chunk; bodies window at ~1000 chars with overlap; each chunk's `retrieval_text` carries title context.
- Deterministic mind-map extraction: self-entity (ticket/pr/commit/doc/decision/blocker), author→`owns`, and mentioned Jira keys / PR numbers / file paths as `mentions`/`fixes`/`touches` edges.
- `indexEvidenceItem()` is called from `recordProjectEvidence()` so every polled artifact (GitHub/Jira/Slack/Confluence/project update) lands in the index live.
- `backfillProjectSearch()` rebuilds from existing evidence + project updates + linked pod updates (idempotent, dedup-keyed by `source:source_id`).
- `embedProjectSearchChunks()` — incremental, rate-limited Bedrock embeddings (skips unchanged chunks by text hash).
- `purgeProjectSearch()` — archive cleanup.

### Read path (`services/project-search.ts`)
- Hybrid: exact-identifier lookup + FTS bm25 lexical + cosine semantic, fused with reciprocal-rank fusion, reranked by identifier match (dominant), in-scope resource, recency, source authority, **intent** (release/backlog/active/done questions boost the matching doc-type), and a stale penalty. A **diversity cap** stops one doc-type (e.g. 54 releases) from flooding the answer. `deleted` docs are excluded. Hard-scoped to `(org_id, project_id)`.
- **Readable answer** (`synthesize: true`): an LLM (Bedrock `MODELS.fast`, `prompts/project-search-synthesis.md`) turns the top hits into a plain-language, cited answer (`summary_md`) for non-technical *and* technical readers — leads with a direct answer, cites tickets/PRs/releases by ref (`MWPW-196040`, `PR #159`, `T3-26.25`), groups by release/status, and refuses to invent facts. Degrades gracefully (omitted) when no LLM/credentials.
- `retrieval_mode` is `"hybrid"` only when the query embedded **and** the corpus has embedded chunks; otherwise `"lexical"`. Reports `embedding_coverage`, `detected_identifiers`, optional project-scoped KG overlay, and optional mind-map neighborhood.

### Source ingestion (`services/project-memory.ts`)
- **Jira tickets** (`pollJira`) — scoped by `project_keys` + `team` (e.g. "Strata") and/or `components` (e.g. "Events Tier 3"); paginated (up to 500); rich readable body (type, status, priority, assignee, components, fix versions, labels, parent, description); `source_type` reflects lifecycle: `backlog_issue` / `active_issue` / `resolved_issue`.
- **Jira releases** (`pollJiraReleases`) — ingests project versions matching `version_prefixes` (e.g. "T3-") as `source_type: "release"` docs (Upcoming/Released, date), so "what's shipping" is answerable.
- **GitHub** (`pollGithub`) — PRs/issues/commits for configured repos (already present).
- All flow through `recordProjectEvidence` → `indexEvidenceItem`, so a poll lands in the search index live. `ProjectResources.jira` gained `components` and `version_prefixes`.

### Surfaces
- REST: `POST /api/projects/:projectId/search` (supports `synthesize`, `sources`, `time_window_days`, `include_kg`, `include_mind_map`, `max_hits`), `POST /api/projects/:projectId/search/reindex`.
- MCP tool `project_search` (incl. `synthesize`); SDK `PimClient.searchProjectIndex()`; CLI `pim project search [--answer] [--mind-map] [--sources] [--days] [--max]` / `pim project reindex [--embed]`.
- Local scripts: `npm --prefix packages/server run seed-project-search -- <projectId> [--poll] [--embed] [--answer] [--query "…"]`; `tsx src/scripts/ask-project.ts <projectId> <question…>` (read-only Q&A, no server); `bash scripts/set-secrets.sh` + `node scripts/check-tokens.mjs` (token rotation + masked health).

### Tests
- `services/__tests__/project-search.test.ts` — exact-identifier lookup, lexical keyword search, wrong-project negative control, deleted-doc exclusion, source filter, pod-update backfill, mind-map neighborhood, reindex stats.
- `services/__tests__/project-search-semantic.test.ts` — embedding + hybrid fusion + incremental re-embed (offline deterministic embedding mock).

### Seeding T3 Events (`project-event-management-console-emc-cbaff6`)

This project is the whole **T3 Events** initiative (Event Management Console is part of it). It is seeded locally from real data:

- **Resources:** GitHub `adobecom/EMC` + `adobecom/event-libs`; Jira `project_keys: ["MWPW"]`, `team: "Strata"`, `version_prefixes: ["T3-"]`; aliases T3 Events / EMC / Event Management Console.
- **Seeded:** ~100 GitHub PRs/commits + 500 Strata Jira tickets (backlog/active/resolved) + 54 T3 releases ≈ **654 documents** (1.5k chunks, ~800 entities, ~1.1k edges), embedded for hybrid search.
- Run `tsx src/scripts/ask-project.ts project-event-management-console-emc-cbaff6 "what is shipping next?"` for a synthesized answer.

Reproduce / refresh:

1. **Reset tokens** (in your own terminal — keeps secrets out of any transcript):
   ```bash
   bash scripts/set-secrets.sh        # silent prompts for GH_TOKEN, GITCORP_TOKEN, JIRA_TOKEN
   node scripts/check-tokens.mjs      # masked health check — all ✓ (corp hosts need VPN)
   ```
   The generic-account PAT (`pimagent`) goes in `JIRA_TOKEN` (on-prem `jira.corp.adobe.com` uses Bearer PAT).

2. **Resources** are already configured on the project (`Team = Strata` scopes the whole T3 Events ticket set; `version_prefixes` selects the T3 release trains).

3. **Enrich + embed:**
   ```bash
   npm --prefix packages/server run seed-project-search -- project-event-management-console-emc-cbaff6 --poll --embed --answer
   ```

4. **Hosted:** deploy this branch, set `GH_TOKEN`/`JIRA_TOKEN`/`AWS_*` on the host, ensure the project's resources are configured (`configure_project_resources` MCP tool or `PUT /api/projects/:id/resources`), then `POST /api/projects/project-event-management-console-emc-cbaff6/search/reindex {"embed":true}` after `/ingest/poll`, or run the seed script there.
