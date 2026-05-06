# PIM

An orchestration layer for cross-functional AI+human "pods" (5-day sprints). Agents and humans submit structured context updates to **PIM (Pod Intelligence Manager)**, which classifies, merges, detects conflicts, and assembles a read-only "living doc" that keeps everyone synchronized.

Three pillars:

1. **PIM (Brain)** -- A context bus: agents submit updates, a PIM orchestrator routes to Committee agents (Merge, Conflict, Summary), and a living `.md` doc is assembled from the current state.
2. **PIM UI (Surface)** -- React + Spectrum 2 SPA for observing pod health, resolving conflicts, and viewing the live doc.
3. **FE Tunneling** -- Expo-style localhost tunneling (**prototype implemented**: CLI + server routes for WebSocket request proxying).

## Quick Start

**Hosted instance (no setup required):** Open **https://d1ygncl0yqo6sv.cloudfront.net/** to use the shared deployment.

**Local development:** Run these commands in separate terminals:

```bash
pnpm install
pnpm --filter @pim/server dev      # Terminal 1 — backend on :4000
pnpm --filter @pim/ui dev          # Terminal 2 — UI on :5173
```

Open **http://localhost:5173**. The database auto-seeds with three demo pods on first run.

## Prerequisites

- **Node.js** >= 20
- **pnpm** >= 10 (`corepack enable && corepack prepare pnpm@10.33.0 --activate`)

Optional:

- **`AWS_BEARER_TOKEN_BEDROCK`** -- Enables LLM-powered merge analysis (Haiku) and conflict analysis (Sonnet) via AWS Bedrock. Set `AWS_REGION` (defaults to `us-west-2`) and optionally override `BEDROCK_MODEL_FAST` / `BEDROCK_MODEL_SMART`. The system works fully without it using deterministic classification and merging.

## Setup (pick one path)

| Goal | Easiest command |
|------|----------------|
| **Contributors — global `pim` CLI + built MCP server** | From this repo’s root, run **`pnpm bootstrap`** once per clone. It installs deps, builds `@pim/mcp-server` and **`ado-pim`** (CLI package), links `pim` globally, then prints a **PATH** reminder if `pim` is not visible in new terminals. Same as **`pnpm install-cli`**. |
| **Run the stack only** (backend + UI in dev; no global `pim`) | **`pnpm install`**, then follow **Quick Start** below (`pnpm --filter @pim/server dev` and `pnpm --filter @pim/ui dev`). Use **`pnpm pim`** from the repo root when you need the CLI without linking (example: `pnpm pim pod list`). |

For MCP + Claude Desktop setup details, see **`@pim/mcp-server`** later in this file.

## Project Structure

```
pim/
├── packages/
│   ├── shared/          # Types, interfaces, constants (single source of truth)
│   ├── server/          # Fastify backend + PIM orchestrator + Committee agents
│   ├── ui/              # React 19 + Vite 6 + Adobe Spectrum 2 SPA
│   ├── sdk/             # @pim/sdk -- TypeScript client for agent integration
│   ├── mcp-server/      # MCP server for Claude.ai artifact integration
│   ├── cli/             # pim CLI — pods, context, hooks, tunnel, init, leave
│   └── infra/           # AWS CDK stack (tables, lambdas, APIs, buckets, CloudFront)
├── prompts/             # Version-controlled LLM system prompts
├── SPEC.md              # Full system specification
├── CLAUDE.md            # Guidance for Claude Code
├── turbo.json           # Turborepo pipeline config
└── pnpm-workspace.yaml  # Workspace definition
```

## Packages

### `@pim/shared`

TypeScript types and constants shared across all packages. No runtime dependencies.

Key exports: `Pod`, `Conflict`, `ContextUpdate`, `Tunnel`, `OrgPodSummary`, `CrossPodOverlap`, `ArchivedPod`, `PendingWork`, `PRESSURE_THRESHOLDS`, `getPressureLevel()`.

### `@pim/server`

Fastify server running on `localhost:4000`. Uses SQLite via Node's built-in [`node:sqlite`](https://nodejs.org/api/sqlite.html) (`DatabaseSync`) for storage and WebSocket for real-time events.

**API endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/pods/:podId` | Get pod with areas |
| POST | `/api/pods` | Create a new pod |
| PATCH | `/api/pods/:podId/milestone` | Update milestone fields (`name`, `target_date`, `percent_complete`) and regenerate living doc |
| GET | `/api/pods/:podId/conflicts` | List conflicts |
| GET | `/api/pods/:podId/conflicts/:id` | Get single conflict |
| POST | `/api/pods/:podId/conflicts/:id/resolve` | Resolve a conflict |
| GET | `/api/pods/:podId/context-updates` | List context updates |
| POST | `/api/pods/:podId/context-updates` | Submit a context update (full pipeline) |
| GET | `/api/pods/:podId/tunnels` | List tunnels |
| GET | `/api/pods/:podId/living-doc` | Get rendered living doc (markdown) |
| GET | `/api/pods/:podId/lint-findings` | Get lint findings |
| POST | `/api/pods/:podId/lint` | Trigger a manual lint pass |
| GET | `/api/org/pods` | List active pods (org view) |
| GET | `/api/org/overlaps` | List cross-pod overlaps |
| GET | `/api/org/archived` | List archived pods |
| POST | `/api/pods/:podId/archive` | Archive a pod |
| WS | `/ws?podId=X` | WebSocket for real-time events |

**WebSocket events:** `context_update_added`, `conflict_created`, `conflict_resolved`, `conflict_escalated`, `pressure_changed`, `living_doc_updated`, `tunnel_status_changed`, `lint_completed`.

**PIM orchestrator pipeline:** When a context update is submitted via POST, it flows through:

1. **Zod validation** -- Schema enforcement
2. **Secret scan** -- Regex patterns for AWS keys, JWTs, connection strings, PEM blocks
3. **DB write** -- Persisted to SQLite
4. **Pod snapshot refresh** -- Denormalize `pod_areas` from the latest context update per scope (updates with `type: blocker` force that scope to `blocked`), recompute milestone `percent_complete` as a sprint-health proxy (round of done scopes / 6), and refresh org `agent_count` (distinct `agent_id` values). This is deterministic, not LLM-inferred.
5. **WebSocket broadcast** -- All connected clients notified
6. **Classification** -- Categorized as `additive`, `overlapping`, or `contradictory`
7. **Routing** -- Additive: deterministic merge (no LLM). Overlapping: LLM merge (Haiku) or deterministic fallback. Contradictory: conflict record created with optional LLM analysis (Sonnet).
8. **Living doc regeneration** -- Template-based markdown assembled from current DB state (including the updated areas and milestone)
9. **Cross-pod overlap detection** -- Keyword analysis across active pods

The living doc’s **Current Status** and milestone progress line follow this snapshot plus conflicts/pressure from the DB. Humans may override milestone fields with `PATCH /api/pods/:podId/milestone`; **`percent_complete` is recomputed again on the next context ingestion** from scope `done` counts, while `name` and `target_date` persist until changed.

**Periodic tasks:**

| Task | Default interval | Env var | Description |
|------|-----------------|---------|-------------|
| Escalation check | 5 min | `ESCALATION_INTERVAL_MS` | Auto-escalates unresolved conflicts at 4h/8h/16h/24h |
| Lint pass | 2 hours | `LINT_INTERVAL_MS` | Scans for staleness, coverage gaps, dependency risks |

For faster demo cycles, set shorter intervals:

```bash
ESCALATION_INTERVAL_MS=30000 LINT_INTERVAL_MS=60000 pnpm --filter @pim/server dev
```

**Database:** SQLite file at `.data/pim.db`. Auto-created and seeded on first run. Delete the file to reset:

```bash
rm .data/pim.db
```

### `@pim/ui`

React 19 SPA built with Vite 6 and Adobe Spectrum 2.

**Views:**

| Route | View | Description |
|-------|------|-------------|
| `/org` | Org Dashboard | All active pods, cross-pod overlaps, archived pods, pod creation |
| `/pod/:podId` | Pod Dashboard | Health, milestones, area status, conflicts, tunnels, lint findings |
| `/pod/:podId/conflicts` | Conflict Center | Filterable table of all conflicts |
| `/pod/:podId/conflict/:id` | Conflict Detail | Side-by-side positions, analysis, pending work, resolution buttons |
| `/pod/:podId/doc` | Live Doc | Real-time rendered living doc (updates via WebSocket) |
| `/pod/:podId/feed` | Context Feed | Filterable stream of all context updates + submission form |
| `/pod/:podId/tunnels` | Tunnel Dashboard | Active dev tunnels with status |

**State management:** Zustand stores (`podStore`, `orgStore`) with API fetching and optimistic updates.

**Real-time:** WebSocket connection managed by `useWebSocket` hook. Connection status shown in the pod sidebar. All views refresh automatically on relevant events.

The Vite dev server proxies `/api` and `/ws` to `localhost:4000`.

### `@pim/sdk`

TypeScript client for AI agent integration.

```typescript
import { PimClient } from '@pim/sdk';

const pim = new PimClient({
  baseUrl: 'http://localhost:4000',
  podId: 'pod-checkout-redesign',
  agentId: 'my-agent',
  scope: 'frontend',
});

// Submit a context update
const result = await pim.report({
  type: 'progress',
  summary: 'Implemented cart summary component',
  details: 'CartSummary.tsx renders line items with discounts.',
  status: 'completed',
});

console.log(result.pim.classification); // "additive" | "overlapping" | "contradictory"

// Fetch the living doc
const doc = await pim.getContext();

// Fetch pod state, conflicts, updates
const pod = await pim.getPod();
const conflicts = await pim.getConflicts();
const updates = await pim.getUpdates();
```

### `@pim/mcp-server`

MCP (Model Context Protocol) server that exposes PIM data to Claude.ai. When connected, Claude can render an interactive pod dashboard as an artifact in the side panel.

**Tools:**

| Tool | Input | Description |
|------|-------|-------------|
| `list_pods` | (none) | List all active pods with IDs, names, pressure, and conflict counts |
| `render_pod_dashboard` | `pod_id` | Fetch all pod data and return a self-contained React component for rendering as a Claude.ai artifact |

The `render_pod_dashboard` tool fetches pod state, conflicts, context updates, the living doc, tunnels, and lint findings, then embeds them as inline JSON into a single-file React component with a dark Spectrum-inspired theme. The artifact has four tabs: Dashboard, Conflicts, Feed, and Live Doc.

**Setup:**

1. Build the package (or run `pnpm bootstrap` from the repo root to build MCP server and CLI and link `pim` globally):

```bash
pnpm --filter @pim/mcp-server build
```

2. Add to your Claude Desktop or Claude.ai MCP configuration:

```json
{
  "mcpServers": {
    "pim": {
      "command": "node",
      "args": ["/absolute/path/to/pim/packages/mcp-server/dist/index.js"],
      "env": {
        "PIM_API_URL": "https://d1ygncl0yqo6sv.cloudfront.net",
        "PIM_ORG_SLUG": "your-org-slug"
      }
    }
  }
}
```

Use `http://localhost:4000` for `PIM_API_URL` if pointing at a local dev server instead.

3. Ask Claude: *"Show me pod Auth Revamp's dashboard"*

The artifact renders a read-only snapshot — no network requests from the artifact itself. To refresh, ask Claude to show it again.

**Authentication:**

The MCP server detects the PIM server's auth mode from `/api/health` on first request and caches it for the process lifetime.

- **Trust mode** (server default for local dev): no auth required. `PIM_ORG_SLUG` is optional and `~/.pim/credentials.json` is ignored — the server upserts `dev@local` in the `demo` org for every request.
- **IMS mode**: the MCP reads `~/.pim/credentials.json` (written by `pim login`) and injects `Authorization: Bearer <token>` + `X-Pim-Org: <slug>` on every request. Tokens are refreshed automatically when within 60s of expiry. If the refresh token is missing or invalid, the MCP logs a hint to stderr and the request surfaces a 401 back to Claude.

To use MCP in IMS mode:

1. Run `pim login` on the host first to populate `~/.pim/credentials.json` (chmod 600).
2. Set `PIM_ORG_SLUG` in the MCP server `env` block above — or run the MCP from a repo that has `orgSlug` set in its `.pim.json` (via `pim init`).

**Environment variables:**

| Variable | Default | Description |
|----------|---------|-------------|
| `PIM_API_URL` | `http://localhost:4000` | Base URL of the PIM Fastify server |
| `PIM_ORG_SLUG` | (from `.pim.json` in cwd) | Org slug sent as `X-Pim-Org`. Required in IMS mode if no `.pim.json` is present. |

### CLI (`ado-pim` npm package)

Command-line interface for pod and project updates, per-repo setup (`init` / `leave`), session context, tunnels, and related commands. The published npm name is **`ado-pim`**; the workspace path is `packages/cli`.

**Easiest install from this clone:** run **`pnpm bootstrap`** at the monorepo root (see **Setup** above). It builds the bundled CLI (`packages/cli/dist/pim.bundle.cjs`) and runs **`pnpm -C packages/cli link --global`**, so **`pim` works from any directory** (for example `pim init` in another repo) once your shell **`PATH`** includes pnpm’s global executables directory. **`pnpm install-cli`** is the same script.

| Alternative | When to use |
|-------------|-------------|
| `pnpm pim <args>` | No global install; run only from the monorepo root (e.g. `pnpm pim pod list`). |
| `npx tsx packages/cli/src/index.ts` | Debug / run from TypeScript without building the bundle first. |

Before deleting a clone you linked globally, run **`pnpm unlink --global`** from `packages/cli` if you want to remove the global `pim` shim.

**If `pim: command not found` after bootstrap:** the link step may have succeeded but your terminal may not put **`$(pnpm bin -g)`** on `PATH` (see the reminder printed at the end of **`pnpm bootstrap`**). Re-run bootstrap or add `export PATH="$(pnpm bin -g):$PATH"` to `~/.zshrc`, then `source ~/.zshrc` or open a new terminal. Confirm with **`ls "$(pnpm bin -g)/pim"`** and **`which pim`**. If you only have an old shim from a prior link, run **`pnpm bootstrap`** again to refresh the **`pim`** shim.

**Repository setup (per clone):**

`pim init` wires this git repo to the PIM server: writes `.pim.json`, optional git hooks, Claude Code sync command, and a Pod Agent Protocol addendum in `CLAUDE.md`. Use it after the pod exists on the server (create it via UI or `pim pod create`). From an interactive terminal, run `pim init` without `--pod` to use a guided wizard (pod list, optional project, optional scope, agent). In CI or non-interactive use, pass `--pod` explicitly.

```bash
pim init --pod pod-my-sprint-a1b2c3
pim init --pod pod-my-sprint-a1b2c3 --project project-demo
pim init --pod pod-my-sprint-a1b2c3 --scope frontend --agent my-agent
```

- `--pod` is required when stdin is not a TTY (e.g. CI); otherwise the wizard prompts for a pod. `--scope` must be an **id** from org config (`GET /api/org/config`, labels are for display only). `--project` is optional; the project must already exist (`GET /api/projects/:id`). If set, `projectId` is stored for long-lived context alongside the sprint pod.
- Skip flags: `--skip-hooks`, `--skip-claude`, `--skip-claude-md` to avoid installing hooks or touching `.claude/` / `CLAUDE.md`.

`pim leave` removes **pod** binding from this repo (clears `podId` in `.pim.json`, strips the protocol block from `CLAUDE.md`, neutralizes the Claude sync command). Hooks stay installed; `projectId` is left in place if present so you can still run project-scoped reports.

```bash
pim leave
pim leave --skip-claude-md --skip-sync --skip-config   # only adjust .pim.json, etc.
```

**Pod management:**

```bash
pim pod create --name "My Sprint"        # Create a new pod
pim pod list                              # List active pods
pim pod status pod-my-sprint-a1b2c3       # Show pod details (ids include a short slug + suffix)
pim pod archive pod-my-sprint-a1b2c3      # Archive a completed pod
```

**Context updates:**

Submit exactly one of `--pod` or `--project` (not both). Pod mode runs the full PIM pipeline for the sprint; project mode records off-pod / between-sprint updates without a living doc or conflict flow.

```bash
pim report \
  --pod pod-my-sprint-a1b2c3 \
  --type progress \
  --scope frontend \
  --summary "Built the hero section" \
  --details "Responsive layout with animated gradient." \
  --status completed

pim report \
  --project project-demo \
  --type progress \
  --scope backend \
  --summary "Refactored auth module" \
  --status in_progress
```

**Pod agent protocol** (pull before substantive work, report after lock-in — see `docs/POD_AGENT_PROTOCOL.md`):

```bash
# Flags or env: PIM_POD_ID, PIM_AGENT_ID, PIM_SCOPE (and PIM_SERVER_URL), or `.pim.json` via `pim init`
pim context --pod <podId> --agent <id> --scope frontend
pim context --brief --diff --pod <podId> --agent <id> --scope frontend
pim context --write .pim/last-context.md    # optional explicit path
pim hooks install                                # optional: post-commit / post-rewrite → PIM API
```

Omit `--pod` / `--agent` / `--scope` when the same values are set in the environment.

**Living doc and lint:**

```bash
pim doc pod-my-sprint-a1b2c3              # Print the living doc
pim lint pod-my-sprint-a1b2c3             # Run a lint pass
```

**Tunnel management:**

```bash
pim tunnel start --pod pod-my-sprint-a1b2c3 --port 3000 --dev alice
pim tunnel list --pod pod-my-sprint-a1b2c3
pim tunnel stop --pod pod-my-sprint-a1b2c3 --tunnel <tunnelId>
```

All commands accept `--server <url>` to override the default `http://localhost:4000`, or set `PIM_SERVER_URL`.

## What You'll See

With the server and UI running, here's what each view shows:

| View | URL | What to Look For |
|------|-----|------------------|
| **Org Dashboard** | `/org` | All pods with pressure gauges, conflict counts, and tunnel activity |
| **Pod Dashboard** | `/pod/:id` | Health banner, milestone progress, area status grid, lint findings |
| **Conflict Center** | `/pod/:id/conflicts` | Open vs. resolved conflicts, severity badges, jump to detail |
| **Conflict Detail** | `/pod/:id/conflict/:cid` | Side-by-side positions, PIM orchestrator analysis, resolution buttons |
| **Living Doc** | `/pod/:id/doc` | Auto-generated markdown with health, decisions, context stream |
| **Context Feed** | `/pod/:id/feed` | Filterable stream of all updates + submission form at the top |
| **Tunnel Dashboard** | `/pod/:id/tunnels` | Active tunnels with status lights, dev names, branches, URLs |

Everything updates in real time via WebSocket. Submit a context update and watch the Living Doc regenerate instantly.

## Scripts

```bash
pnpm dev           # Start all packages in dev mode (via Turbo)
pnpm build         # Build all packages
pnpm typecheck     # Type-check all packages

# Per-package
pnpm --filter @pim/server dev
pnpm --filter @pim/ui dev
pnpm --filter @pim/server typecheck
pnpm --filter @pim/ui typecheck
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4000` | Server port |
| `AWS_BEARER_TOKEN_BEDROCK` | (none) | Enables LLM features via Bedrock (Haiku for merges, Sonnet for conflicts) |
| `AWS_REGION` | `us-west-2` | AWS region for Bedrock Converse endpoint |
| `BEDROCK_MODEL_FAST` | `us.anthropic.claude-3-5-haiku-20241022-v1:0` | Bedrock model ID for fast/merge agent |
| `BEDROCK_MODEL_SMART` | `us.anthropic.claude-3-5-sonnet-20241022-v2:0` | Bedrock model ID for smart/conflict agent |
| `ESCALATION_INTERVAL_MS` | `300000` (5 min) | How often to check for conflict escalation |
| `LINT_INTERVAL_MS` | `7200000` (2 hr) | How often to run the lint pass across all pods |
| `PIM_API_URL` | `http://localhost:4000` | (MCP server) Base URL of the PIM server |
| `PIM_ORG_SLUG` | (from `.pim.json`) | (MCP server + CLI) Org slug sent as `X-Pim-Org`. Required in IMS mode unless a `.pim.json` is present in cwd. |
| `AUTH_MODE` | `trust` | (Server) `trust` upserts `dev@local` per request; `ims` verifies IMS JWTs via JWKS. |
| `IMS_CLIENT_ID` | (none) | (Server, IMS mode) Adobe IMS client id for audience validation. Also advertised via `/api/health` so the CLI can auto-discover. |
| `IMS_ENV` | `stg1` | (Server) `stg1` or `prod`. Selects the IMS JWKS and issuer. |
| `IMS_EXPECTED_ISSUER` | *(IMS default)* | (Server) Override for the expected `iss` claim. Leave unset unless using a non-standard IMS deployment. |
| `VITE_AUTH_MODE` | `trust` | (UI) Must match the server's `AUTH_MODE`. In `ims` the UI redirects to Adobe IMS; in `trust` it stubs a `dev@local` identity. |
| `VITE_IMS_CLIENT_ID` | (none) | (UI, IMS mode) Adobe IMS client id (same value as `IMS_CLIENT_ID`). |
| `VITE_IMS_ENV` | `stg1` | (UI) `stg1` or `prod`. |

## Architecture

### Context Update Flow

```
Agent/Human submits update
        |
        v
  POST /api/pods/:podId/context-updates
        |
        v
  Ingestion (validation, secret scan, DB write, pod snapshot, WS broadcast)
        |
        v
  PIM orchestrator (classify update)
        |
  additive ---------> Deterministic merge (no LLM, ~60% of traffic)
  overlapping ------> LLM merge via Haiku (or deterministic fallback)
  contradictory ----> Create conflict record (optional Sonnet analysis)
        |
        v
  Regenerate living doc from DB state
        |
        v
  Detect cross-pod overlaps
```

### Conflict Pressure

A score from 0.0 to 1.0 that gates merge behavior:

| Range | Mode | Behavior |
|-------|------|----------|
| 0.0--0.3 | Normal | Auto-merge freely |
| 0.3--0.6 | Cautious | Merge with disclaimers |
| 0.6--0.8 | Degraded | Hold contested areas, no auto-merge |
| 0.8--1.0 | Critical | Ingestion paused, urgent alerts |

### Escalation Ladder

Unresolved conflicts auto-escalate on a compressed timeline (designed for 5-day sprints):

- **>4h** -- Ping contributors
- **>8h** -- Re-ping, flag for pod lead
- **>16h** -- Escalate to pod lead
- **>24h** -- Force pressure to 1.0 (critical)

### Tech Stack

| Concern | Choice |
|---------|--------|
| Monorepo | Turborepo + pnpm workspaces |
| Backend | Fastify 5 |
| Database | SQLite (`node:sqlite` / `DatabaseSync`, WAL mode) |
| AI/LLM | Anthropic Claude API (Haiku + Sonnet) |
| Validation | Zod |
| Frontend | React 19 + Vite 6 |
| Components | Adobe Spectrum 2 (`@react-spectrum/s2`) |
| Styling | Spectrum 2 `style()` macro via `unplugin-parcel-macros` |
| State | Zustand |
| Routing | React Router v7 |
| Markdown | react-markdown + remark-gfm |
| Real-time | WebSocket (native, via `@fastify/websocket`) |
| Claude integration | MCP server (`@modelcontextprotocol/sdk`) |
| TypeScript | Strict mode, ES2022 target |

## Not Yet Implemented

- **Production FE tunneling** — The local tunnel prototype (CLI + server routes + WS proxying) exists, but the hosted “stable URL” deployment story (custom domains, edge, auth) is still a deployment milestone.
- **Adobe IMS auth** -- Currently no authentication
- **Slack integration** -- Conflict notifications and emoji-based resolution
- **Notification system** -- In-app, email, Slack DM per-user preferences

See `SPEC.md` for the full specification and implementation milestones.

## Hardening checklist (consolidated)

This is a lightweight “production readiness” checklist that used to live in `HARDENING.md`. Items marked **[DONE]** are already implemented; they’re kept as a quick map of what exists and where.

### Tier 1 — Credibility **[DONE]**

- **Unit tests** — vitest set up in `packages/server` with broad coverage of core services. Run: `pnpm test`.
- **Request validation** — Zod schemas + `validateBody()` middleware on POST routes (`packages/server/src/middleware/validation.ts`).
- **Health check** — `GET /api/health` in `packages/server/src/index.ts` validates DB connectivity.

### Tier 2 — Production readiness (local) **[DONE]**

- **Global error handler** — `app.setErrorHandler` in `packages/server/src/index.ts` returns structured errors and avoids leaking stacks.
- **Auth middleware skeleton** — `packages/server/src/middleware/auth.ts` (`AUTH_MODE=trust|ims`, IMS verification is TODO).
- **CORS** — `@fastify/cors` in `packages/server/src/index.ts` (config via `CORS_ORIGIN`).
- **Rate limiting** — `@fastify/rate-limit` in `packages/server/src/index.ts` plus route-level limits where needed.

### Tier 3 — Testing & demo polish **[DONE]**

- **Expanded unit/integration tests** — Includes ingestion, pressure, classification, merge/conflict/summary agents, and Fastify `inject()` integration tests.
- **SDK + CLI tests** — vitest coverage for client methods + command registration.
- **CDK stack** — present in `packages/infra/lib/pim-stack.ts` (see note above about production deployment/ops).
