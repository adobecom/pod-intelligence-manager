# PIM — Pod Intelligence Manager

PIM is an Adobe-internal coordination and memory platform for AI-assisted engineering work. It
combines short-lived pod orchestration with long-lived project context, governed memory, search,
and agent integrations.

The repository is a pnpm/Turborepo monorepo. The implemented runtime is a Fastify service backed by
SQLite, a React UI, a TypeScript SDK and CLI, two MCP surfaces, and an AWS CDK deployment.

## What PIM provides

- **Pods:** submit structured progress, blockers, decisions, and questions; detect conflicts; keep a
  generated living document current; and archive completed work.
- **Projects:** retain context between pods and search bounded evidence from GitHub, Jira,
  Confluence, Slack, and local Git sources.
- **Canonical memory:** store governed codebase and harness lessons with exact resource bindings,
  immutable retrieval packs, evidence, review, retention, and reverification.
- **Agent access:** use the TypeScript SDK, `pim` CLI, hosted MCP tools, or the restricted Memory v2
  MCP data plane.
- **Skill catalog:** register, synchronize, search, and conflict-check reusable skills.
- **Development tunnels:** proxy a local development server through PIM for shared previews.

## Quick start

### Prerequisites

- Node.js 24 or newer
- pnpm 10.33.x (the workspace pins `pnpm@10.33.0`)

```sh
corepack enable
corepack prepare pnpm@10.33.0 --activate
pnpm install
cp .env.example .env
```

Run the API and UI in separate terminals:

```sh
pnpm --filter @pim/server dev
pnpm --filter @pim/ui dev
```

Open `http://localhost:5173`. The Vite server proxies `/api` and `/ws` to the Fastify server at
`http://localhost:4000`.

The default local authentication mode is `trust`, which creates a synthetic development identity.
Use `AUTH_MODE=ims` only with the IMS values documented in `.env.example`.

## Repository layout

| Path | Purpose |
| --- | --- |
| `packages/server` | Fastify API, SQLite schema and migrations, workers, orchestration, search, and memory |
| `packages/ui` | React 19/Vite 6/Spectrum 2 single-page application |
| `packages/shared` | Shared types plus generated Memory v1/v2 contracts |
| `packages/sdk` | Strict TypeScript clients, including `PimMemoryV2Client` |
| `packages/cli` | Published `ado-pim` package and `pim` executable |
| `packages/mcp-server` | Interactive PIM MCP server and reusable restricted-memory MCP implementation |
| `packages/infra` | Current EC2/SQLite AWS CDK stack and deployment tests |
| `packages/eval` | Reproducible evaluation protocols, fixtures, runners, and reports |
| `prompts` | Version-controlled LLM prompts |
| `docs` | Current runbooks, feature guides, architecture, and historical design records |

See [docs/README.md](docs/README.md) for the documentation map and status of each design document.

## Common commands

```sh
pnpm dev                 # Run package development tasks through Turbo
pnpm typecheck           # Type-check every package
pnpm test                # Run package test suites
pnpm build               # Build every package
pnpm docs:check          # Validate local Markdown links and documented pnpm scripts
pnpm check:npmrc         # Verify that the repository npm config contains no credentials
```

Useful focused commands:

```sh
pnpm --filter @pim/server test
pnpm --filter @pim/sdk test
pnpm --filter @pim/mcp-server test
pnpm --filter @pim/infra test
pnpm --filter @pim/shared contracts:check
```

## CLI

The published CLI package is `ado-pim`; its executable is `pim`.

For a contributor checkout:

```sh
pnpm bootstrap
pim --help
```

Without a global link, run the source CLI from the repository root:

```sh
pnpm pim pod list
pnpm pim project list
```

Common workflows:

```sh
pim login
pim init
pim context --brief
pim report --project PROJECT_ID --type progress --scope backend \
  --summary "Updated the memory adapter" --status completed
pim project search PROJECT_ID "where is repository authorization enforced?"
pim token list
```

The CLI defaults to the shared endpoint configured in `packages/cli/src/index.ts`. Override it with
`--server <url>` or `PIM_SERVER_URL` for local and alternate deployments.

For Artifactory installation and authentication, follow
[docs/NPM_ARTIFACTORY.md](docs/NPM_ARTIFACTORY.md). For first-time user setup, follow
[docs/ONBOARDING.md](docs/ONBOARDING.md).

## SDK and API

`@pim/sdk` contains clients for pods, projects, search, knowledge, and canonical memory. Memory v2
clients authenticate with a service token whose server-side binding establishes the maximum
organization, project, plane, operation, and exact repository or harness resource.

```ts
import { PimMemoryV2Client } from "@pim/sdk";

const memory = new PimMemoryV2Client({
  baseUrl: "http://localhost:4000",
  authToken: process.env.PIM_SERVICE_TOKEN!,
});

const capabilities = await memory.capabilities();
const binding = await memory.binding();
```

The current Memory v2 API supports:

- capability and effective-binding discovery;
- codebase and harness search;
- immutable record, history, and retrieval-pack reads;
- idempotent run receipts and codebase feedback;
- candidate status and HTTP-only review decisions;
- resource-scoped reverification readiness; and
- a restricted stateless MCP companion at `/mcp/memory`.

See [docs/MEMORY_API.md](docs/MEMORY_API.md) for the endpoint and MCP matrix. Generated schemas in
`packages/shared/contracts` are the wire-contract source of truth.

## MCP surfaces

PIM intentionally has two different MCP surfaces:

1. **Interactive PIM MCP (`@pim/mcp-server`)** — a local/stdio integration for pod, project,
   context-search, knowledge, and skill-catalog workflows.
2. **Restricted Memory v2 MCP (`POST /mcp/memory`)** — a private, stateless service-token data plane
   with eight bounded tools and two non-enumerable resource templates. HTTP v2 remains canonical;
   review, activation, credential administration, and runtime-attestation control are not exposed
   through MCP.

Do not configure `/mcp/memory` as though it were the interactive desktop server. Its protocol and
authorization profile are documented in
[docs/MCP_A_PRIVATE_PIM_SERVICE_TOKEN_PROFILE.md](docs/MCP_A_PRIVATE_PIM_SERVICE_TOKEN_PROFILE.md).

## Architecture at a glance

```text
CLI / SDK / MCP / Browser
          |
          v
  Fastify API + WebSocket
          |
          +-- pod and project orchestration
          +-- context and skill search
          +-- canonical Memory v1/v2
          +-- background workers
          |
          v
 SQLite (single writer) + local/S3 graph archives
```

The current hosted stack serves the UI from S3 through CloudFront and forwards API, MCP, WebSocket,
and tunnel traffic through CloudFront to an ALB and one EC2-hosted server container. SQLite lives on
an attached EBS data volume. S3 logical backups and AWS Backup EBS recovery points protect the
stateful deployment.

For details, read [docs/ARCHITECTURE_OVERVIEW.md](docs/ARCHITECTURE_OVERVIEW.md),
[docs/DEPLOY.md](docs/DEPLOY.md), and [docs/BACKUP_RESTORE.md](docs/BACKUP_RESTORE.md).

## Configuration

Copy `.env.example` to `.env` for local development. The server loads the root file first and an
optional `packages/server/.env` override second. Important groups include:

- server, CORS, storage, and authentication;
- Bedrock models and optional embeddings;
- canonical-memory authority, service-token, worker, and reverification settings;
- project-search and connector credentials;
- skill-catalog workers; and
- CLI/MCP endpoint selection.

Never commit `.env`, access tokens, private keys, or populated user npm configuration. The tracked
`.npmrc` contains only the package registry mapping.

## Documentation

- [Documentation index](docs/README.md)
- [Architecture overview](docs/ARCHITECTURE_OVERVIEW.md)
- [Onboarding](docs/ONBOARDING.md)
- [Pod agent protocol](docs/POD_AGENT_PROTOCOL.md)
- [Context search](docs/CONTEXT_SEARCH.md)
- [Project-search connectors](docs/PROJECT_SEARCH_CONNECTORS.md)
- [Skill catalog](docs/SKILL_CATALOG_USER_GUIDE.md)
- [Memory API](docs/MEMORY_API.md)
- [Memory operations](docs/MEMORY_OPERATIONS.md)
- [Deployment](docs/DEPLOY.md)
- [Backup and restore](docs/BACKUP_RESTORE.md)

`SPEC.md` records the original product vision and remains useful design history, but implemented
behavior is defined by the current code, generated contracts, tests, and the current documents
listed above.
