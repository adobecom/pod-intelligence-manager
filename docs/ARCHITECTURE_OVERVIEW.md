# Architecture overview

**Status:** current implementation as of 2026-08-13

PIM is a modular monolith: one Fastify process owns the HTTP/WebSocket surfaces, orchestration,
search, and background workers, while SQLite is the transactional source of truth. The React UI,
CLI, SDK, and MCP adapters are clients of that server.

## Runtime shape

```text
Browser / CLI / SDK / interactive MCP / restricted Memory MCP
                              |
                              v
                    Fastify API (:4000)
                    + HTTP + WebSocket
                    + auth and org context
                    + pod/project workflows
                    + search and skill catalog
                    + canonical memory
                    + background workers
                              |
                    +---------+----------+
                    |                    |
                    v                    v
             SQLite /data          external sources
             (single writer)       Bedrock, GitHub,
                                   Jira, Confluence,
                                   Slack, S3
```

Local development uses `.data/pim.db` and `.data/knowledge-graph`. The hosted MVP uses an attached
EBS volume mounted at `/data`.

## Monorepo responsibilities

| Package | Responsibility |
| --- | --- |
| `@pim/server` | Fastify routes, middleware, SQLite, orchestration, workers, search, memory, and connectors |
| `@pim/ui` | React/Vite/Spectrum 2 SPA |
| `@pim/shared` | Shared domain types and generated Memory v1/v2 contracts |
| `@pim/sdk` | Strict client libraries for PIM consumers |
| `ado-pim` | `pim` CLI and repository/agent integration |
| `@pim/mcp-server` | Interactive MCP server plus restricted-memory MCP library |
| `@pim/infra` | AWS CDK stacks and infrastructure tests |
| `@pim/eval` | Evaluation protocols, runners, fixtures, and audit tooling |

## Request boundary

Requests pass through global error handling, rate limiting, authentication, organization context,
and route-specific authorization.

- `AUTH_MODE=trust` is the local default and creates a synthetic development identity.
- `AUTH_MODE=ims` verifies Adobe IMS JWTs and applies organization membership/role checks.
- Service tokens use the `pim_svc_...` format and carry bounded org/project/pod scopes plus exact
  Memory v2 resource bindings where applicable.
- Memory v2 derives its effective principal and resource authority from the token. Caller-provided
  selectors can narrow the request but cannot widen the binding.
- `/mcp` and `/mcp/memory` perform stricter service-token authentication than ordinary user routes.

The UI and CLI discover server authentication configuration through `/api/health` and
`/api/cli-config`.

## Pod and project model

Pods are short-lived coordination units. A context update is validated, scanned for secrets,
persisted, broadcast over WebSocket, classified, merged or converted into a conflict, and reflected
in the generated living document. Deterministic processing is preferred; Bedrock augments merge,
conflict, extraction, and synthesis paths when configured.

Projects are long-lived context boundaries. They own source configuration and resource bindings,
can span multiple pods, and support indexed plus separately gated live search over GitHub, Jira,
Confluence, Slack, local Git, project updates, pod updates, and knowledge-graph evidence.

The skill catalog is another project/org-scoped subsystem. It synchronizes configured Git sources,
builds deterministic catalog entries, optionally embeds them, and supports advisory search and
conflict checks.

## Storage and migrations

SQLite uses Node's built-in `node:sqlite` driver. Migrations are ordered and checksummed in
`packages/server/src/db/migrations.ts`; committed migration SQL is immutable. The current sequence
runs through migration `018`.

The database contains:

- pod, project, context, conflict, archive, membership, and tunnel state;
- source evidence and project-search indexes;
- agent session/run/event/checkpoint state;
- service-token hashes and bindings;
- canonical memory records, versions, candidates, receipts, evidence, transitions, feedback,
  retrieval packs, retention/erasure ledgers, resource facets, runtime origins, and reverification
  state; and
- terminal memory-authority transitions and immutable legacy-import ledgers.

SQLite is intentionally single-writer. Do not run multiple server instances against independent
copies or share one database file across multiple active hosts.

## Canonical memory

The canonical SQL model is the only write and lifecycle authority after the terminal cutover.
Memory v1 remains a compatibility surface for supported migrated codebase/harness records. Memory
v2 adds strict generated contracts, exact resource facets, immutable retrieval packs, source-aware
ledgers, harness-native evidence, and resource readiness.

V2 supports exactly two planes:

| Plane | Resource boundary | Main behavior |
| --- | --- | --- |
| `codebase` | exact canonical repository and code revision | search, detail/history, packs, receipts, feedback, candidates, review, reverification |
| `harness` | exact harness/principal/configuration binding | search, detail/history, packs, receipts with runtime origins, candidates, review, reverification |

There is no fuzzy repository match, unavailable-plane fallback, or implicit cross-plane retrieval.
Search filters authorization, lifecycle, trust, compatibility, and applicability before ranking.
Every successful search stores an immutable pack; replaying the same request identity with changed
content is rejected.

### Memory transports

- **HTTP v2** at `/api/v2/memory/*` is canonical.
- **Restricted MCP** at `POST /mcp/memory` exposes the same domain behavior through eight bounded
  tools and two non-enumerable immutable resources.
- MCP does not expose candidate review/activation, token administration, runtime-attestation
  adjudication, or record lifecycle administration.

See [MEMORY_API.md](./MEMORY_API.md) for the exact surface.

### Startup and background work

Server startup runs the v2 migration, resource/facet reconciliation, reverification admission, and
startup validation chain. A failure marks Memory v2 unavailable and makes v2/MCP memory calls
return a bounded retryable error; unrelated PIM features remain available.

Background memory work includes provider inbox/outbox processing, reconciliation, operational
metrics, and optional v2 reverification. Reverification is disabled unless
`MEMORY_V2_REVERIFICATION_ENABLED=1`; enabling it admits validated policies and periodically checks
GitHub or runtime evidence before records remain influence-eligible.

## Legacy knowledge graph

The JSON organization graph remains useful for bounded pod-context reads and historical recovery.
Once `memory_authority_transitions.legacy_writes_frozen` is true:

- graph mutation, curation, synthesis, pruning, development seeding, and legacy candidate promotion
  stay disabled;
- pod archives, ad-hoc submissions, and agent rollups route selected lessons into canonical
  review-gated candidates; and
- SQL triggers plus application guards prevent legacy candidate writers from reactivating.

The graph is not a repository- or harness-authorized substitute for canonical Memory v2.

## WebSocket and tunnels

`/ws` publishes pod events used by the UI. `/ws/tunnel` and `/tunnel/*` implement the development
preview proxy. The CLI opens an outbound WebSocket to PIM, so a developer does not need inbound
port forwarding.

## Hosted AWS MVP

`PimEc2Stack` is the current deployment:

- CloudFront serves the S3-hosted SPA and forwards `/api/*`, `/mcp*`, `/ws*`, and `/tunnel/*`;
- an internet-facing ALB targets an Auto Scaling Group constrained to one active EC2 instance;
- the server runs as a Docker container under systemd;
- a dedicated EBS volume stores `/data`;
- S3 stores portable logical backups and versioned legacy graph objects;
- AWS Backup protects the full data volume;
- ECR stores server images, SSM Parameter Store supplies runtime secrets, and CloudWatch/SNS carry
  logs, metrics, alarms, and backup failures.

This is not a multi-writer, multi-AZ, or zero-downtime architecture.

## Recovery and authority safety

Deployments pin reviewed server images by digest when provided. Once the memory cutover flag is
raised, infrastructure mounts the legacy graph read-only and requires terminal canonical authority
at startup. Restoring a pre-cutover database directly into service is forbidden; it must be
re-cut over in isolation first.

Portable S3 dumps omit rebuildable project-search indexes. A restore validates checksum, gzip,
SQLite integrity, foreign keys, and non-empty organizations before atomically publishing the
database, then requests project-search reconstruction. Full EBS recovery points retain the exact
index.

See [BACKUP_RESTORE.md](./BACKUP_RESTORE.md) and
[MEMORY_OPERATIONS.md](./MEMORY_OPERATIONS.md).
