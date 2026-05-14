# Knowledge graph: tiered layers (org + team)

This note captures the integration plan for a two-layer knowledge graph once the in-memory index layer (O(n) → O(result) query cost) is in place. Without that indexing work, a team layer simply defers the same scan bottleneck to team scale rather than solving it.

## Why layering makes sense now

The current graph is partitioned by `org_id`. All learnings from all teams land in one flat pool, which means:

- Agents always retrieve against the full org corpus, even when their question is team-scoped.
- Dedup thresholds are org-wide, so a team-specific pattern that's "obvious within the team" but not org-wide may get duplicated or suppressed incorrectly.
- There's no concept of "this learning graduated from a team to the org" — everything enters as equals regardless of provenance breadth.

A team layer introduces a natural funnel: learnings start in the team graph, and only those that reach broad-enough confidence or curator approval get promoted to the org graph. Org-wide queries stay fast because the org graph stays lean.

## Design

Two distinct `KnowledgeGraph` instances per org:

- **Team graph** — keyed by `(org_id, team_id)`. Holds pod-originated learnings for the life of the team. High node count, lower average confidence. Agents in the same team query here first.
- **Org graph** — keyed by `org_id` (current). Holds promoted learnings only. Lower node count, higher average confidence. Used for cross-team precedents, onboarding, and conflict resolution.

`OrgGraphState` gains a `teamGraphs: Map<team_id, OrgGraphState>` field. Team graphs use the same `NodeIndexes` infrastructure (domain/type/pod/keyword indexes) built by `buildIndexes()`, so query cost at team scope is already O(result) after the indexing work.

Storage: `{org_id}/teams/{team_id}/graph-latest.json` on disk, mirroring the existing per-org path convention.

## Ingestion routing

Add `team_id` to the pods schema (nullable for backward compatibility):

```sql
ALTER TABLE pods ADD COLUMN team_id TEXT;
```

In `addLearningsToGraph()`, when a pod has a `team_id`, route to the team graph instead of the org graph:

```typescript
const targetGraph = pod.team_id
  ? getTeamState(orgId, pod.team_id)
  : getOrgState(orgId);
```

The org graph receives learnings only via the promotion path (see below). Direct ad-hoc POSTs to `/api/knowledge/nodes` without a `team_id` continue to land in the org graph as today.

## Promotion rule

A team learning is eligible for org promotion when either condition is met:

1. `confidence_score >= 0.75` AND `curated = true` — a human approved a high-confidence signal
2. The same learning (cosine similarity >= 0.85) appears in **3 or more distinct pods** within the team — broad enough to be org-relevant

Promotion is a copy operation: a new org-graph node is created with `ingestion_provenance.kind = "team_promotion"` and a `source_team_node_ids[]` field pointing back. The original team node gains a `promoted_to_org_node_id` field. No deletion; both copies persist for provenance tracing.

The promotion check runs at archival time (already a batch operation) and as part of the existing `refreshAnalysisIfStale` interval. Synchronous promotion is not required.

**Why this matters**: the org graph stays curated and lean. Team-specific patterns that are only relevant within a team never pollute org-wide queries. Agents searching for cross-team precedents get higher signal-to-noise.

## Query waterfall

`getRelevantLearnings()` gains an optional `team_id` parameter. When provided:

1. Query the team graph with the full token budget.
2. If result set uses less than 60% of the budget, escalate to the org graph to fill the remainder.
3. Merge results; team results rank first (proximity signal).

```typescript
export async function getRelevantLearnings(
  orgId: string,
  scopes: string[],
  activeConflictSummaries: string[],
  maxTokens: number,
  projectId?: string | null,
  teamId?: string | null,   // ← new
): Promise<KnowledgeQueryResult>
```

When `team_id` is absent (no team context), the function queries the org graph only — existing behavior unchanged.

**Why this matters**: agents working within a team surface team-specific patterns first (faster, more relevant) without losing access to org-wide precedents when team coverage is sparse.

## Cross-layer edges

Team nodes and org nodes live in separate graph objects, so intra-graph edges continue to work as today. Cross-layer linkage is handled via fields rather than edges (which would require a merged graph object):

- Team node: `promoted_to_org_node_id?: string`
- Org node: `source_team_node_ids?: string[]`

The UI can render these as soft cross-graph links ("this org pattern was promoted from team X"). No bidirectional sync; the link is a one-way promotion trail.

## API surface changes

| Endpoint | Change |
|----------|--------|
| `POST /api/knowledge/query` | Add optional `team_id` filter; routes to team graph when present |
| `GET /api/knowledge/relevant` | Add optional `team_id` query param |
| `GET /api/knowledge/graph` | Add optional `team_id` query param; returns team graph when present |
| `GET /api/knowledge/stats` | Add optional `team_id`; scopes stats to team graph |
| `POST /api/knowledge/nodes` | Accept optional `team_id`; routes to team graph |

The server resolves `team_id` from pod context when the caller is a pod agent, so most callers don't need to pass it explicitly.

## Suggested next step (small, high leverage)

1. Add `team_id` (nullable) to the pods schema migration guard in `schema.ts`.
2. Thread `team_id` through `addLearningsToGraph()` with a routing conditional — team pods write to `{org_id}/teams/{team_id}/graph-latest.json`, org-direct pods continue as today.
3. Verify that `initializeKnowledgeGraph` eagerly loads team graphs for all teams whose pods are active in the current server instance.

That gets ingestion correct before building the query waterfall. The promotion logic and waterfall can follow as the team graphs accumulate enough data to validate the thresholds.
