# Current deployment vs target architecture

This document is the **single place** that states what runs **today** versus what **SPEC.md** and long-term plans describe. Other docs should align with it.

## Executive summary

| | **Shipped today (Path A)** | **Target vision (SPEC / Path C)** |
|---|---------------------------|----------------------------------|
| **Compute** | One **Fastify** Node process per EC2 instance (Docker); optional local `pnpm` dev | **Lambda** orchestrator + committee agents; thin routing at the edge |
| **Operational state** (pods, context updates, conflicts, tunnels, org metadata, living doc rows) | **SQLite** (`pim.db` on disk; EBS in prod) | **DynamoDB** for fast structured reads/writes at scale |
| **Living doc artifact** | Markdown stored in SQLite (`living_docs`) + regenerated in-process | Rendered **Summary Agent** output to **versioned S3**; canonical state in DynamoDB |
| **Knowledge graph** | **Filesystem JSON** under `KG_DATA_DIR` (default `.data/knowledge-graph/`); loaded into memory; optional **`KG_S3_BUCKET`** writethrough + restore when local is empty | **S3** full snapshots + **DynamoDB** GSIs for indexed queries without loading the entire graph |
| **API surface** | **ALB → EC2** (same process serves REST + WebSocket); **CloudFront** in front | **API Gateway** (REST + WebSocket), EventBridge |
| **Static UI** | **S3 + CloudFront** (matches target pattern) | Same |
| **Infra entrypoint** | **`PimEc2Stack`** in `packages/infra/lib/pim-ec2-stack.ts` — this is what `cdk deploy` runs | **`PimStack`** in `packages/infra/lib/pim-stack.ts` — **defined on disk, not wired in `app.ts`; not deployed** |

**Consistency rule:** For the **hosted product** (one org, one server URL), users share **one** SQLite database and **one** knowledge-graph directory on that instance — there is no per-client divergence. Scaling to **multiple app instances** or moving off a single host requires the **target** data plane (or another shared store), not more of Path A.

## Path A (current) — details

- **CDK:** `packages/infra/lib/app.ts` deploys only `PimEc2Stack`.
- **Server:** `packages/server` — validation, secret scan, orchestration, committee agents, WebSockets, periodic jobs — all **in process**.
- **Secrets:** SSM Parameter Store `/pim/*` at container boot (`fetch-secrets.sh`), per **docs/DEPLOY.md**.
- **Knowledge graph files:** `packages/server/src/services/graph-storage.ts` — **disk is authoritative at runtime**; if `KG_S3_BUCKET` is set, JSON is **mirrored** to S3 after each save, and **restore from S3** runs only when the local graph directory for an org is **empty** (new disk, fresh clone, etc.).

## Path C (target) — details

- **SPEC.md** and **docs/ARCHITECTURE_OVERVIEW.md** describe this shape: DynamoDB for structured state and knowledge-graph indexing, S3 for blobs and graph snapshots, Lambda-based ingestion and committee work, API Gateway + EventBridge.
- **Code:** `packages/infra/lib/pim-stack.ts` sketches tables and lambdas; it is **not** the active stack. Migrating means implementing adapters and cutover, not flipping a flag.

## Documentation convention

- Use **“target”** or **“SPEC”** when referring to Lambda + DynamoDB + API Gateway layouts.
- Use **“shipped”**, **“current”**, or **“Path A”** when referring to Fastify + SQLite + EC2.
- Avoid phrasing that implies DynamoDB or Lambda are already serving production traffic unless the sentence is explicitly scoped to the target design.
