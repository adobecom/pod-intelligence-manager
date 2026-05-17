# Target Architecture: Fargate + Aurora Serverless v2

Proposed evolution of the PIM AWS stack from single-instance EC2 + SQLite (`PimEc2Stack`, "Path A") to a horizontally-scalable, multi-AZ container deployment with native vector search and SQL graph queries.

Status: proposal. Not yet implemented. Supersedes the dormant `PimStack` (Lambda + DynamoDB) design in `packages/infra/lib/pim-stack.ts`.

> **Honest scope note.** The Fastify codebase keeps its overall shape (routes, agents, WS broadcast, scheduled jobs) but does not keep its data-access pattern unchanged. ~225 direct `db.prepare(...)` call sites use Node's synchronous `node:sqlite`; moving to `pg` requires a repository-layer refactor and a sync-to-async pass before the infra change can land. Plan for this as a prerequisite phase, not a driver swap.

## Goals

1. **High availability.** Survive a single AZ outage or task crash with no user-visible downtime for the API/UI surface.
2. **Zero-downtime deploys.** Rolling Fargate updates replace tasks one at a time behind the existing ALB.
3. **Real vector search.** Move embeddings from in-memory JSON to `pgvector`; eliminate the per-instance memory ceiling.
4. **Graph queries in SQL.** Replace JSON-on-disk graph storage with relational tables; use recursive CTEs for traversal.
5. **Preserve the application shape.** Fastify, agents, routes, and the existing Dockerfile stay. The data-access layer changes; everything above it does not.

## Service topology

Two Fargate services behind the existing ALB:

- **`pim-api`** (desiredCount 2+, multi-AZ). Owns API, UI WebSocket fanout, ingestion. Scales horizontally on CPU. Path: everything except `/tunnel/*` and `/ws/tunnel/*`.
- **`pim-worker`** (desiredCount 1, single-task). Owns tunnel proxy (the in-process `tunnel-connections.ts` map) and all periodic jobs (escalation, lint, graph refresh, prune, synthesis). Path: `/tunnel/*`, `/ws/tunnel/*`. Same image as `pim-api`, different env flag (`PIM_ROLE=worker`).

This split solves two problems together: tunnel state lives in a single process (no cross-task routing needed) and cron jobs fire once globally (no duplicate LLM work). Tunnel availability is the same as today; one process owns it; restart = reconnect (CLI already handles this). If we later need tunnel HA, introduce a broker (Redis pub/sub or Postgres registry + intra-VPC forward); for v1, single-task is sufficient and matches current production behavior.

## Component map

| Concern | Service | Notes |
|---|---|---|
| UI hosting | S3 + CloudFront | Reuse existing `pim-${owner}-ui-${account}` bucket and distribution |
| Edge routing | ALB | Reuse existing ALB; add two target groups (api, worker), path-routed |
| API + UI WS | ECS Fargate (`pim-api`) | 2+ tasks, multi-AZ, autoscale on CPU 70% |
| Tunnel proxy + crons | ECS Fargate (`pim-worker`) | 1 task; owns single-instance state |
| Container image | ECR | Reuse `pim-${owner}-server` repo |
| Primary DB | Aurora Serverless v2 Postgres 16 | `pgvector` extension; `LISTEN/NOTIFY` for UI invalidation only |
| Durable async events | Postgres outbox + NOTIFY pointer | NOTIFY is best-effort; outbox is authoritative |
| Knowledge graph snapshots | S3 (versioned) | Reuse `pim-${owner}-kg-${account}` for periodic dumps |
| Backups | Aurora automated (35-day PITR) | Replaces hourly SQLite cron dump |
| Secrets | SSM Parameter Store at `/pim/*` | Unchanged |
| AI | Bedrock + Claude API | Unchanged |
| Auth | Adobe IMS | Unchanged |
| Outbound to AWS APIs | NAT Gateway (single AZ) | Simpler and cheaper than 6× PrivateLink endpoints at PIM's egress volume |
| Logs | CloudWatch via awslogs driver | Same log group naming pattern |
| IaC | CDK (`PimFargateStack`) | New stack file alongside `pim-ec2-stack.ts` |

## Architecture

```
                            ┌────────────────────┐
                            │     CloudFront     │
                            └──────────┬─────────┘
                                       │
              ┌────────────────────────┼──────────────────────────┐
              │ /                      │ /api/*, /ws              │ /tunnel/*, /ws/tunnel/*
              ▼                        ▼                          ▼
        S3 (UI bucket)          ALB Target Group: api      ALB Target Group: worker
                                       │                          │
                                       ▼                          ▼
                          ┌─────────────────────┐      ┌────────────────────┐
                          │  Fargate: pim-api   │      │ Fargate: pim-worker│
                          │  task 1 (AZ-a)      │      │  task 1 (single)   │
                          │  task 2 (AZ-b)      │      │  desiredCount = 1  │
                          │  ... autoscaled     │      └──────────┬─────────┘
                          └──────────┬──────────┘                 │
                                     │                            │
                                     └────────────┬───────────────┘
                                                  │
                              ┌───────────────────┼────────────────────┐
                              ▼                   ▼                    ▼
                     Aurora Serverless v2    S3 (KG snapshots)   Bedrock / Claude API
                      (Postgres + pgvector,
                       outbox + NOTIFY)
                                                  │
                                                  ▼  (outbound only)
                                          NAT Gateway → Bedrock, ECR, SSM, CW Logs
```

Two event channels with different durability guarantees:
- **`LISTEN/NOTIFY`** for UI invalidation fanout ("tell connected WS clients to refetch"). Best-effort; payload ≤ 8 KB; missed if subscriber disconnected.
- **`pim_outbox` table + NOTIFY pointer** for durable workflow events (post-archive knowledge extraction, etc.). The worker polls the outbox; NOTIFY just wakes the poller faster. Survives task restarts.

## Data model migration

Current SQLite schemas port mostly 1:1 to Postgres. Three subsystems need explicit work:

1. **Embeddings.** Today: JSON arrays in `.data/knowledge-graph/*.json`. Target: `vector(N)` column on `knowledge_nodes` with an `ivfflat` or `hnsw` index. **N must equal `EMBEDDING_DIMENSIONS`**, which defaults to **512** (`packages/server/src/services/embeddings.ts:3`; Titan v2 supports `{256, 512, 1024}`). Pick one dimension, lock it in deployed config, and pin the column type to match. Reindexing if we later change dimensions is expensive.
2. **Graph edges.** Today: nested JSON. Target: `knowledge_edges (src_id, dst_id, type, weight, created_at)` with indexes on both endpoints. Traversal becomes a recursive CTE.
3. **Data-access layer.** The repository-layer refactor (Phase 0 below) is a hard prerequisite. ~225 sync `db.prepare(...)` call sites become async repository methods backed by `pg`. Without this, the SQLite → Postgres swap is impractical.

The graph-storage interface is already abstracted to three functions, so that subsystem's swap is localized to `packages/server/src/services/graph-storage.ts`. The rest of the data layer is not abstracted today.

## Migration phases

### Phase -1: Current-stack headroom before migration (1-3 days)

Goal: remove avoidable request latency on the EC2 stack before starting the larger data-access refactor. This phase is not a substitute for Fargate/Aurora; it buys onboarding runway while the migration is built carefully.

- Add SQLite `busy_timeout` so short write collisions retry instead of failing immediately.
- Move context-update PIM orchestration off the request path: persist and acknowledge the update first, then run ConflictScout, merge analysis, living-doc regeneration, and enrichment in a background queue.
- Defer or worker-thread graph analysis so community detection, hub identification, and graph persistence do not block unrelated API requests.
- Preserve the existing incremental edge-maintenance behavior and add a regression test before graph-storage migration work.

Exit criteria: context update submission returns quickly under normal LLM latency, no new `SQLITE_BUSY` errors in burst tests, and graph refresh work can run without stalling the API event loop.

### Phase 0: Repository layer behind SQLite (2–3 weeks)

Goal: introduce a data-access abstraction without changing the DB.

- Add `packages/server/src/db/repos/*` with one repository per table (`PodsRepo`, `ContextUpdatesRepo`, `ConflictsRepo`, etc.).
- Make every method async (returning Promises even when implemented synchronously over SQLite).
- Replace `db.prepare(...).get/all/run(...)` call sites with `await repo.method(...)`.
- Replace synchronous `withTransaction` with an async equivalent.
- Tests stay green against SQLite; CI gate on no remaining direct `db.*` imports outside `db/`.

Exit criteria: zero `db.prepare` references outside `packages/server/src/db/`. App functionally unchanged.

### Phase 1: Postgres + pgvector implementation (2–3 weeks)

- Add `pg` and `pgvector` drivers; add a Postgres implementation of every repository.
- Stand up a dev Postgres (RDS `db.t4g.micro` is fine for this stage) and run the test suite against it; fix dialect issues (placeholders, datetime, JSON1).
- Add a feature flag `DB_BACKEND=sqlite|postgres`.
- In a staging env, dual-write briefly to compare result sets on read paths.
- Cut over reads, then writes, to Postgres. Remove SQLite paths and the flag.

Exit criteria: `node:sqlite` not imported anywhere in the server package. `pgvector` queries return results consistent with the prior in-memory cosine path.

### Phase 2: Outbox + NOTIFY for cross-task events (1 week)

- Add a `pim_outbox(id, channel, payload, created_at, consumed_at)` table.
- Replace in-process EventEmitter calls used for durable events with an outbox insert + `NOTIFY pim_outbox, '${id}'`.
- The worker polls the outbox (LISTEN unblocks the poller; consumer marks rows consumed; failed rows retried with backoff).
- Keep plain in-process broadcast for transient UI WS fanout (one task pushes to its own WS clients on receipt of NOTIFY).

Exit criteria: a context update submitted to a `pim-api` task results in WS clients connected to any other `pim-api` task receiving the broadcast; durable jobs survive a worker restart mid-processing.

### Phase 3: Fargate stack + cutover (1 week)

- New CDK stack `PimFargateStack` (new file `packages/infra/lib/pim-fargate-stack.ts`).
- Provision: ECS cluster, two task definitions (api, worker), two services, Aurora Serverless v2 cluster, NAT gateway, security groups, IAM task roles.
- Reuse the existing ALB by adding two new target groups and path-based listener rules.
- Shift traffic at the ALB in steps (10% → 50% → 100%); validate at each step.
- Reuse the existing CloudFront distribution; no DNS change.

Exit criteria: 100% traffic on Fargate for 48 hours with no regression.

### Phase 4: Decommission EC2 (1 day)

- Final `pg_dump` to S3 for offline archive.
- Drain and delete the EC2 ALB target group.
- `cdk destroy PimEc2Stack-${owner}` (retains S3 buckets per existing policy).

## CDK additions

New file: `packages/infra/lib/pim-fargate-stack.ts`

Key constructs:
- `ec2.Vpc` with 2 public + 2 private subnets across 2 AZs; **one NAT gateway** in one AZ (~$32/mo). PrivateLink endpoints (~$88/mo for 6 services × 2 AZs at $0.01/AZ-hour) are cheaper only above ~600 GB/mo of outbound data processing; we are well below that.
- `rds.DatabaseCluster` with `engine: AuroraPostgresEngineVersion.VER_16_x`, `serverlessV2MinCapacity: 0.5`, `serverlessV2MaxCapacity: 4` for prod. For dev/sandbox, set `serverlessV2MinCapacity: 0` (Postgres 16.3+ supports auto-pause; trades a ~10–15 s cold start on first request after idle for ~$44/mo savings).
- `ecs.Cluster` (one cluster, both services).
- Two `ecs.FargateTaskDefinition`s (api, worker) using the same image; env distinguishes role.
- Two `ecs.FargateService`s:
  - api: `desiredCount: 2`, `minHealthyPercent: 100`, `maxHealthyPercent: 200`, `circuitBreaker: { rollback: true }`
  - worker: `desiredCount: 1`, `minHealthyPercent: 0`, `maxHealthyPercent: 100` (restart-in-place acceptable since tunnels reconnect today anyway)
- Two `elbv2.ApplicationTargetGroup`s; listener rules path-route `/tunnel/*` and `/ws/tunnel/*` to worker, everything else to api.
- `applicationautoscaling.ScalableTarget` on the api service CPU at 70%.

## Cost estimate (us-west-2)

| Component | Spec | Monthly |
|---|---|---|
| Fargate `pim-api` | 2 tasks × 0.5 vCPU × 1 GB, 24/7 | ~$30 |
| Fargate `pim-worker` | 1 task × 0.5 vCPU × 1 GB, 24/7 | ~$15 |
| Aurora Serverless v2 | 0.5 ACU floor, peaks to 4 ACU | $44 (idle) to ~$350 (sustained peak) |
| Aurora storage | 10 GB initial | ~$1 |
| ALB | reuse existing | $16 |
| CloudFront | reuse existing | $5 |
| S3 (KG + UI + backups) | minimal | $2 |
| NAT Gateway | 1× single-AZ + low egress | ~$35 |
| CloudWatch Logs | 5 GB/mo | $5 |
| **Steady-state total** | | **~$155/mo** |
| **vs. current EC2 stack** | | ~$55/mo |

Delta is ~$100/mo for HA, vector search, real graph queries, and zero-downtime deploys. Aurora is the dominant variable cost; the 4-ACU ceiling caps worst case at ~$350. Dev/sandbox with `min: 0 ACU` runs at ~$25–30/mo when idle.

## Risks and open questions

1. **Phase 0 effort.** The repository-layer refactor is the longest item and touches almost every server file. Highest risk for schedule slip and merge conflicts. Land it early before parallel feature work creates conflicts.
2. **Aurora cold start (dev only).** Min 0 ACU adds 10–15 s wakeup on first request after pause. Prod stays at 0.5 ACU floor because crons fire every 5 min and prevent meaningful pause anyway.
3. **Connection pooling.** Three Fargate tasks × Node pool size × `pg` connections can pressure Aurora limits. Mitigate with PgBouncer sidecar or RDS Proxy ($15/mo) if we exceed ~80 connections.
4. **Tunnel availability during worker deploys.** Rolling worker deploys (one task max) mean a brief tunnel gap; CLI already reconnects. Accepted trade.
5. **Outbox vs SQS.** Postgres outbox keeps the architecture simple (one durable store). If we later need fanout to non-PIM consumers (a Slack relay service, an external analytics pipeline), introduce EventBridge or SQS at that point, not now.
6. **Single-AZ NAT.** A single NAT gateway means an AZ outage breaks outbound calls from all tasks. Two NAT gateways for HA = $64/mo. Acceptable for v1; revisit if outbound dependency criticality grows.

## Rollback plan

- **During Phase 0:** changes are purely refactor; revert via git if anything regresses.
- **During Phase 1:** flip the `DB_BACKEND` flag back to SQLite. Old data still intact.
- **During Phase 3:** ALB weighted target groups let us cut Fargate traffic to 0 instantly. Old EC2 ASG remains live and healthy.
- **Post Phase 4:** Aurora point-in-time recovery covers 35 days; final SQLite dump archived in S3 covers anything earlier.

## Out of scope (for this doc)

- Multi-region failover (current pod model is region-local; revisit if Adobe asks for it).
- Tunnel HA via broker pattern (single-task worker is sufficient for v1).
- Read replicas (Aurora SLv2 supports them; add if read load justifies it).
- Redis cache layer (only if Postgres or query latency becomes a bottleneck).
- Moving to Lambda for specific endpoints (only if metrics show a bursty path that would benefit).

## Target architecture at a glance

| # | Layer | AWS Service | Spec / Tier | Purpose | Replaces (in current EC2 stack) | Scaling | Steady cost/mo |
|---|---|---|---|---|---|---|---|
| 1 | DNS / CDN | CloudFront | reuse existing distribution | TLS, edge caching, path routing to ALB or S3 | same | edge-managed | $5 |
| 2 | UI hosting | S3 | reuse `pim-${owner}-ui-${account}` | Static SPA bundle | same | n/a | $1 |
| 3 | Edge routing | ALB | reuse, add 2 target groups | Path routing to api / worker | same | static | $16 |
| 4 | API + UI WS | ECS Fargate (`pim-api`) | 2× 0.5 vCPU / 1 GB, multi-AZ | Fastify HTTP + WS broadcast | EC2 ASG (single task) | CPU target 70%, 2–4 tasks | $30 |
| 5 | Worker | ECS Fargate (`pim-worker`) | 1× 0.5 vCPU / 1 GB | Tunnel proxy + periodic jobs | EC2 cron + in-memory tunnel map | fixed 1 task | $15 |
| 6 | Container image | ECR | reuse `pim-${owner}-server`, 10-image retention | Image registry | same | n/a | <$1 |
| 7 | Primary DB | Aurora Serverless v2 Postgres 16 | 0.5–4 ACU (prod), 0–2 (dev) | Transactional store, pgvector, LISTEN/NOTIFY | SQLite on EBS | ACU autoscale | $44–$350 |
| 8 | Vector search | `pgvector` extension | `vector(512)` + hnsw index | Embedding similarity for KG retrieval | in-memory cosine over JSON | with DB | included |
| 9 | Durable async | `pim_outbox` table + NOTIFY pointer | n/a | Cross-task durable events | n/a (in-process EventEmitter) | with DB | included |
| 10 | KG snapshots | S3 versioned | reuse `pim-${owner}-kg-${account}` | Periodic full-graph dumps | same + on-EBS JSON | n/a | $1 |
| 11 | Backups | Aurora automated + S3 export | 35-day PITR | DR | hourly SQLite cron dump | n/a | $5 |
| 12 | Secrets | SSM Parameter Store at `/pim/*` | reuse | Env config loaded at task start | same | n/a | $0 |
| 13 | AI inference | Bedrock + Claude API | reuse | LLM calls | same | usage-based | variable |
| 14 | Auth | Adobe IMS | reuse | User identity | same | n/a | $0 |
| 15 | Outbound | NAT Gateway (single AZ) | 1× | Egress to Bedrock, ECR, SSM, CW Logs | EC2 public IP | n/a | $32 + egress |
| 16 | Logs | CloudWatch Logs | 30-day retention | App + access logs | same | n/a | $5 |
| 17 | IaC | CDK | new `PimFargateStack` | Infrastructure as code | `PimEc2Stack` | n/a | $0 |
| **Steady-state total (idle prod, multi-AZ HA on api tier)** | | | | | | | **~$155/mo** |

## References

- Current stack: `packages/infra/lib/pim-ec2-stack.ts`, `docs/DEPLOY.md`
- Dormant Lambda target: `packages/infra/lib/pim-stack.ts` (recommend deprecating once Phase 3 lands)
- Architecture overview: `docs/ARCHITECTURE_OVERVIEW.md`
- Knowledge graph design: `docs/ARCHITECTURE_OVERVIEW.md#knowledge-graph-persistent-org-memory`
- Tunnel implementation: `packages/server/src/ws/tunnel-connections.ts`, `packages/server/src/routes/tunnel-proxy.ts`
- Embeddings: `packages/server/src/services/embeddings.ts`
