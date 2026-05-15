# Scaling Findings: Current EC2 Architecture

Analysis of the current EC2 + SQLite stack performance limits, migration trade-offs, and near-term headroom options. Informed by live graph data and code-path review.

---

## Current Stack (t3.medium EC2 + SQLite)

### Performance Cons

**Availability**
- Single EC2 instance: one AZ outage or process crash equals full downtime with no failover
- Deploys require a brief outage; no rolling replacement

**Data layer**
- ~225 synchronous `db.prepare()` call sites block the Node.js event loop; under concurrent load this serializes I/O that should be parallel
- SQLite is single-writer; concurrent writes queue behind a mutex, so throughput hits a hard ceiling
- No `busy_timeout` set (default 0ms); write collisions fail immediately rather than retrying
- Hourly cron dump is the only backup; worst-case data loss is ~1 hour

**Knowledge graph**
- Embeddings live in memory as JSON arrays; every semantic query scores all candidate nodes in a linear scan
- Edge maintenance is already incremental on graph ingestion (`newNodes × existingNodes`, plus intra-batch pairs), but it still runs synchronously on the main event loop
- Community detection, hub identification, JSON serialization, prune, and curation analysis also run synchronously; these are the remaining graph hot spots as node count grows
- Graph edges are nested JSON with no indexes; traversal requires full deserialization

**Operational isolation**
- Tunnel proxy, all cron jobs, and the API share one process; a cron runaway or tunnel bug can degrade or crash the API
- In-process EventEmitter for durable events: a crash drops any in-flight events with no retry

---

## Node Scaling Thresholds

| Threshold | Nodes | What happens |
|---|---|---|
| Early warning | ~2,000 | JSON graph file crosses the 10MB built-in warning; cold start after restart takes 40-80ms to parse; begin migration at this point |
| Degraded | ~5,000 | Synchronous graph analysis, edge maintenance, and JSON save work can visibly stall the event loop during archival, refresh, prune, or curation jobs |
| Graph file size warning | ~2,200 | Approximate crossover based on ~4.5KB per node with 512-dim embeddings |

**Current emc-sandbox graph: 194 nodes, 0 edges.**

Breakdown: 124 patterns, 45 anti-patterns, 12 resolved conflicts, 12 scope insights, 1 decision. Top domains: frontend (111), backend (99), design (68), infra (24).

The 0 edges is because the `refreshAnalysisIfStale` periodic job has not yet fired for the emc-sandbox org since the knowledge graph org-partitioning landed.

At 194 nodes there are no performance concerns. The graph needs to roughly 10x before any threshold is approached.

---

## Graph Query and Analysis: Current vs Target Architecture

The query path (`getRelevantLearnings`) is a linear scan, not a traditional graph traversal. It filters and scores every node on every request. The gap between architectures opens past ~2,000 nodes.

| Graph size | Current per-query | Target (pgvector HNSW) | Difference |
|---|---|---|---|
| ~500 nodes | 0.5-2ms | 0.5-2ms | Negligible |
| ~2,000 nodes | 3-8ms | 1-3ms | 2-3x |
| ~10,000 nodes | 20-60ms | 2-5ms | 10-20x |
| ~50,000 nodes | 200-500ms | 3-8ms | 50-100x |

**Graph analysis comparison (the bigger local CPU problem):**

The current ingestion path no longer rebuilds all edges from scratch. It compares newly added nodes against existing nodes, then computes intra-batch pairs. That is a good near-term shape, but the work is still synchronous in the API process, and full analysis still runs after some graph mutations.

| Scenario | Current EC2 process | Target architecture |
|---|---|---|
| Archive adds ~20 nodes to 500-node graph | ~10k pair comparisons on main event loop, plus analysis/save | Worker task or async job; API stays responsive |
| Archive adds ~20 nodes to 2,000-node graph | ~40k pair comparisons on main event loop, plus analysis/save | Worker task or async job; API stays responsive |
| Query at 10,000+ nodes | Linear cosine scan per request | `pgvector` ANN query via HNSW |
| Traversal/community analysis | JSON graph and in-process CPU | Indexed SQL edges plus worker-owned jobs |

---

## Concurrent Users and Pod Capacity

The primary user-visible bottleneck is not SQLite; it is PIM orchestration work awaited inside the context-update request handler. ConflictScout and merge analysis can make 1-2 Bedrock API calls per context update, each with a 30-second timeout. While those calls are in-flight, the response is held open.

| Scenario | Safe ceiling | What breaks first |
|---|---|---|
| Low conflict rate (additive updates only) | ~50 concurrent users | Sync SQLite writes saturate the event loop |
| Normal usage (LLM enabled, some conflicts) | ~20-30 concurrent users | Multiple 30s LLM calls stack, latency spikes |
| High conflict rate | ~5-10 concurrent users | Request queue backs up, timeouts cascade |

**Active pod capacity:**

| Active pods | Agents submitting | Status |
|---|---|---|
| 1-2 pods (5-10 agents) | Comfortable | No issues expected |
| 3-4 pods (15-20 agents) | Borderline | Latency visible under burst |
| 5+ pods (25+ agents) | Degraded | Dropped requests likely |

**For HZ and Express onboarding (2 teams, 1 pod each, ~10 agents):** well within the safe range. The risk is both teams hitting a high-conflict sprint simultaneously and flooding the LLM queue, not raw concurrency.

---

## EC2 Instance Sizing Does Not Help Nodes

Current instance: t3.medium (2 vCPU, 4GB RAM).

The graph-analysis bottleneck is single-threaded CPU (Node.js runs on one core). Upgrading to t3.large or t3.xlarge adds vCPUs that Node cannot use for this workload. The 2k and 5k thresholds stay roughly the same unless analysis moves off the main thread.

| Instance | vCPU | RAM | Node threshold change |
|---|---|---|---|
| t3.medium (current) | 2 | 4GB | Baseline |
| t3.large | 2 | 8GB | Negligible |
| t3.xlarge | 4 | 16GB | Negligible (extra CPUs unused by Node) |

RAM is not the constraint. At ~4.5KB per node, t3.medium's 4GB could hold ~800,000 nodes before RAM pressure. The bottleneck is single-threaded computation, not memory.

What instance sizing does help modestly: SQLite write throughput under concurrent load, and T3 CPU credit accumulation (larger instances throttle less under sustained burst). Concurrent user ceiling nudges from ~20-30 to ~30-40 on t3.xlarge.

---

## Near-Term Headroom Fixes (No Migration Required)

These changes to the current EC2 arch push the node ceiling significantly without touching the target architecture migration.

### Fix 1: Move PIM orchestration off the request path

After validation and the initial SQLite insert, return `201` quickly and process the update in a background queue. For the EC2 stopgap this can be an in-process queue; for stronger crash recovery, make it SQLite-backed:

- ConflictScout / merge LLM calls
- conflict creation
- living-doc regeneration
- cross-pod overlap detection
- async quality scoring and git-hook enrichment

This is the highest-impact latency fix because it removes 30-second Bedrock timeout exposure from the user-facing request. The API response should become "accepted and queued for PIM processing" rather than "accepted after all PIM agents finish."

**Files:** `packages/server/src/services/ingestion.ts`, `packages/server/src/pim/master.ts`, `packages/server/src/services/ingestion-queue.ts`

### Fix 2: SQLite busy_timeout (one line)

Add `PRAGMA busy_timeout = 5000` to the SQLite init. Currently write collisions fail immediately (0ms). This makes them retry for 5 seconds, eliminating most `SQLITE_BUSY` errors under concurrent load.

**File:** `packages/server/src/db/connection.ts`

### Fix 3: Move graph analysis to a worker thread or always defer it

Node.js `worker_threads` allows CPU-intensive work to run off the main event loop. Edge maintenance, community detection, and hub identification are pure CPU/data-structure work, making them a good fit. The main event loop keeps serving requests while graph analysis runs in the background.

The simplest version is to mark archival graph analysis stale and let the periodic refresh process it, matching the existing ad-hoc/synthesis behavior. The stronger version is a worker thread or background job that computes graph changes and swaps the updated graph back into memory.

**File:** `packages/server/src/services/graph-analysis.ts` plus the archival and periodic job trigger sites.

#### Shipped: PIM_GRAPH_WORKER flag

Both versions of Fix 3 are in the codebase as of this branch.

- **Defer-to-interval (always on):** archival in `routes/org.ts` calls `addLearningsToGraph(..., { skipAnalysis: true })`, matching the ad-hoc node POST path. The periodic `refreshAnalysisIfStale` interval picks up the work.
- **Worker thread (opt-in via `PIM_GRAPH_WORKER=true`):** `detectCommunities`, `identifyHubs`, and `buildEdges` dispatch through `services/graph-analysis-pool.ts` onto a separate OS thread. Version-stamp pattern: if `graph.version` changes between dispatch and result, the result is discarded and `analysisStale` stays true so the next tick re-runs.

Validation: parity test (`graph-analysis-worker.parity.test.ts`) asserts worker output equals inline output on a synthetic two-cluster graph. Race-condition test (`graph-analysis-worker.race.test.ts`) confirms version mismatches discard the stale result without corrupting graph state.

Worker startup uses a `.mjs` bootstrap that registers tsx's ESM loader inline so the worker runs the `.ts` entry without depending on parent-process `--import` flags.

### Fix 4: Preserve incremental edge maintenance

The code already computes edges between newly added nodes and the existing graph, plus intra-batch edges. Keep that behavior and add a regression test before touching graph migration work.

At current scale: archiving a pod adds ~20 nodes. That is 20 x 194 = 3,880 pairs instead of 214² = 45,796 pairs. A 12x reduction. The ratio improves as the graph grows.

### Combined effect

| State | Practical effect | Node-count ceiling |
|---|---|---|
| Today | Writes succeed, but request latency can spike behind LLM calls and synchronous graph analysis | ~5,000 |
| `busy_timeout` + defer-to-interval (shipped, always on) | Archive POST stays fast; periodic refresh still stalls main thread under heavy growth | ~5,000-7,000 |
| `PIM_ASYNC_ORCHESTRATION=true` (shipped, opt-in) | LLM-backed PIM stops blocking the request path; concurrent users move from ~20-30 to ~50+ | independent of node count |
| `PIM_GRAPH_WORKER=true` (shipped, opt-in) | Community / hub / edge CPU work moves off main thread; main loop stays responsive at any node count | **~20,000 comfortable, ~50,000 stretchy** |
| Fargate + Aurora + pgvector | HA, rolling deploys, true horizontal scale, indexed vector search, durable cross-task events | trigger pushed to ~50,000-75,000 |

**What still bounds the worker-on ceiling at ~50k:** per-query cosine scan stays O(n) (queries return on the main thread), and `saveGraph()` rewrites the full ~225MB JSON on every node add. Those are the next bottlenecks once `PIM_GRAPH_WORKER` is on.

---

## Target Architecture (Fargate + Aurora Serverless v2)

Full spec: `docs/TARGET_ARCHITECTURE_FARGATE.md`

**Gains**
- Multi-AZ HA: 2+ Fargate tasks survive a single AZ outage
- Zero-downtime rolling deploys
- pgvector with HNSW index replaces O(n) linear scan with O(log n) approximate nearest neighbor
- Graph edges become a relational table with indexed endpoints; traversal is a recursive CTE
- Aurora MVCC allows true concurrent reads and writes
- 35-day PITR via Aurora automated backups
- Postgres outbox for durable events; no events lost on crash
- `pim-api` autoscales on CPU; capacity grows with load

**Cons**
- Phase 0 refactor: ~225 `db.prepare()` call sites across nearly every server file, 2-3 weeks
- Sync-to-async conversion cascades up the entire call stack
- Cost: ~$55/mo today to ~$155/mo (3x); Aurora spikes to ~$350/mo at sustained peak
- `vector(512)` is baked into the schema; changing embedding dimensions later requires a full column rebuild
- Single-AZ NAT Gateway: if that AZ goes down, all outbound calls fail

**Migration trigger: 2,000 nodes.** Start the migration before hitting that threshold to land safely before 5,000.

---

## Recommendation Summary

For the current onboarding decision (HZ and Express):

- Scale to t3.large for the credit buffer and EBS throughput improvement (~$15-20/mo delta)
- Ship the near-term fixes in this order: `busy_timeout`, async PIM processing, deferred/worker graph analysis
- Preserve the already-incremental edge maintenance path and add a regression test around it
- Begin the Fargate migration in parallel with architect approval; do not rush it before onboarding
- The emc-sandbox graph at 194 nodes has no performance risk for any realistic stress test workload

## Rollout order for new feature flags

All three flags ship default-off. Recommended rollout:

1. **`PIM_ASYNC_ORCHESTRATION=true`** — verified in this PR's tests. Lift the concurrent-user ceiling without changing data flow. Lowest risk; data is still persisted synchronously before the response returns.
2. **`PIM_GRAPH_WORKER=true`** — verified by parity + race tests. The worker only computes derived data (community IDs, hub IDs); the graph itself is never mutated from the worker thread. Failure modes are bounded: at worst, analysis stays stale for an extra interval.
3. Set a CloudWatch alarm at **1,500 nodes per org** as the signal to scope the Fargate migration. That's still well below any post-worker ceiling.
