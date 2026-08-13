# CLAUDE.md

Guidance for coding agents working in this repository.

## Project snapshot

PIM is an Adobe-internal coordination and governed-memory platform for AI-assisted engineering.
The current implementation is a Node 24 pnpm monorepo with:

- a Fastify API and WebSocket server;
- a single-writer SQLite database with checksummed migrations;
- a React/Vite/Spectrum 2 UI;
- CLI, SDK, interactive MCP, and restricted Memory v2 MCP clients;
- pod, project, context-search, skill-catalog, and evaluation workflows; and
- an AWS CDK EC2/ALB/CloudFront deployment with EBS and S3 recovery layers.

Do not describe the current runtime as Lambda/DynamoDB. Those components belong to historical or
target-architecture material, not the deployed MVP stack.

## Start here

- [README.md](README.md) — setup, package map, and common commands
- [docs/README.md](docs/README.md) — current documentation and historical-design index
- [docs/ARCHITECTURE_OVERVIEW.md](docs/ARCHITECTURE_OVERVIEW.md) — implemented architecture
- [docs/MEMORY_API.md](docs/MEMORY_API.md) — canonical Memory v1/v2 and MCP surfaces
- [docs/DEPLOY.md](docs/DEPLOY.md) — deployment runbook

## Development commands

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm docs:check
pnpm --filter @pim/shared contracts:check
```

Use focused package checks while iterating, then run checks proportional to the final diff. Do not
edit generated Memory contract files directly; update the generator/schema source and run
`pnpm --filter @pim/shared contracts:generate`.

## Load-bearing memory rules

- Canonical SQL memory is the write and lifecycle authority after the terminal authority cutover.
- The legacy organization knowledge graph may remain a bounded pod-context read source, but its
  writers, curation, synthesis, pruning, and promotion paths must stay fenced once legacy writes are
  frozen.
- Memory v2 supports exactly the `codebase` and `harness` planes. Do not infer unavailable planes,
  fuzzy resource matches, or cross-plane fallback.
- A service token establishes the maximum org/project/plane/operation/resource authority. Request
  fields may narrow that authority but must never widen it.
- HTTP v2 is canonical. `/mcp/memory` delegates to the same domain services and must not grow a
  separate store, ranker, authorization model, review path, or control plane.
- Receipts and feedback are idempotent. Immutable packs and record versions must be reauthorized on
  every read.
- Candidate review and activation remain HTTP control-plane operations; the restricted MCP surface
  does not expose them.
- Startup migration, reconciliation, admission, or validation failure makes Memory v2 unavailable
  without making the rest of PIM silently serve partial v2 state.

## Repository hygiene

- Keep local state (`.env`, `.pim.json`, `.data`, build output, coverage, `.DS_Store`) untracked.
- Preserve user changes in a dirty worktree and avoid broad formatting or generated-file churn.
- Update current docs when behavior changes. Mark design plans and dated reviews as historical once
  superseded; do not leave removed commands in active runbooks.
- Run `pnpm docs:check` after changing Markdown or package scripts.
