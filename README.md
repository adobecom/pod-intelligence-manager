# AI Council

An orchestration layer for cross-functional AI+human "pods" (5-day sprints). Agents and humans submit structured context updates to a central Council, which classifies, merges, detects conflicts, and assembles a read-only "living doc" that keeps everyone synchronized.

Three pillars:

1. **AI Council (Brain)** -- A context bus: agents submit updates, a Council Master routes to Committee agents (Merge, Conflict, Summary), and a living `.md` doc is assembled from the current state.
2. **Council UI (Surface)** -- React + Spectrum 2 SPA for observing pod health, resolving conflicts, and viewing the live doc.
3. **FE Tunneling** -- Expo-style localhost tunneling (planned; not yet implemented).

## Quick Demo

Run these three commands in separate terminals to see everything working:

```bash
pnpm install
pnpm --filter @council/server dev      # Terminal 1 — backend on :4000
pnpm --filter @council/ui dev          # Terminal 2 — UI on :5173
```

Then run the guided demo (creates a pod, submits updates, triggers a conflict, resolves it):

```bash
npx tsx examples/demo-full.ts
```

Open **http://localhost:5173** and watch the Org Dashboard, Pod Dashboard, Conflict Center, and Living Doc update in real time as the demo runs.

## Prerequisites

- **Node.js** >= 20
- **pnpm** >= 10 (`corepack enable && corepack prepare pnpm@10.33.0 --activate`)

Optional:

- **`ANTHROPIC_API_KEY`** -- Enables LLM-powered merge analysis (Haiku) and conflict analysis (Sonnet). The system works fully without it using deterministic classification and merging.

## Quick Start

```bash
# Install dependencies
pnpm install

# Terminal 1 -- start the backend (port 4000)
pnpm --filter @council/server dev

# Terminal 2 -- start the UI (port 5173)
pnpm --filter @council/ui dev
```

Open **http://localhost:5173**. The database auto-seeds with three demo pods on first run.

## Project Structure

```
ai-council/
├── packages/
│   ├── shared/          # Types, interfaces, constants (single source of truth)
│   ├── server/          # Fastify backend + Council Master + Committee agents
│   ├── ui/              # React 19 + Vite 6 + Adobe Spectrum 2 SPA
│   ├── sdk/             # @council/sdk -- TypeScript client for agent integration
│   ├── mcp-server/      # MCP server for Claude.ai artifact integration
│   ├── cli/             # (scaffolded, not yet implemented)
│   └── infra/           # (scaffolded, not yet implemented -- AWS CDK)
├── examples/
│   └── demo-agent.ts    # End-to-end demo exercising the SDK
├── prompts/             # Version-controlled LLM system prompts
├── SPEC.md              # Full system specification
├── CLAUDE.md            # Guidance for Claude Code
├── turbo.json           # Turborepo pipeline config
└── pnpm-workspace.yaml  # Workspace definition
```

## Packages

### `@council/shared`

TypeScript types and constants shared across all packages. No runtime dependencies.

Key exports: `Pod`, `Conflict`, `ContextUpdate`, `Tunnel`, `OrgPodSummary`, `CrossPodOverlap`, `ArchivedPod`, `PendingWork`, `PRESSURE_THRESHOLDS`, `getPressureLevel()`.

### `@council/server`

Fastify server running on `localhost:4000`. Uses SQLite (via `better-sqlite3`) for storage and WebSocket for real-time events.

**API endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/pods/:podId` | Get pod with areas |
| POST | `/api/pods` | Create a new pod |
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

**Council Master pipeline:** When a context update is submitted via POST, it flows through:

1. **Zod validation** -- Schema enforcement
2. **Secret scan** -- Regex patterns for AWS keys, JWTs, connection strings, PEM blocks
3. **DB write** -- Persisted to SQLite
4. **WebSocket broadcast** -- All connected clients notified
5. **Classification** -- Categorized as `additive`, `overlapping`, or `contradictory`
6. **Routing** -- Additive: deterministic merge (no LLM). Overlapping: LLM merge (Haiku) or deterministic fallback. Contradictory: conflict record created with optional LLM analysis (Sonnet).
7. **Living doc regeneration** -- Template-based markdown assembled from current DB state
8. **Cross-pod overlap detection** -- Keyword analysis across active pods

**Periodic tasks:**

| Task | Default interval | Env var | Description |
|------|-----------------|---------|-------------|
| Escalation check | 5 min | `ESCALATION_INTERVAL_MS` | Auto-escalates unresolved conflicts at 4h/8h/16h/24h |
| Lint pass | 2 hours | `LINT_INTERVAL_MS` | Scans for staleness, coverage gaps, dependency risks |

For faster demo cycles, set shorter intervals:

```bash
ESCALATION_INTERVAL_MS=30000 LINT_INTERVAL_MS=60000 pnpm --filter @council/server dev
```

**Database:** SQLite file at `.data/council.db`. Auto-created and seeded on first run. Delete the file to reset:

```bash
rm .data/council.db
```

### `@council/ui`

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

### `@council/sdk`

TypeScript client for AI agent integration.

```typescript
import { CouncilClient } from '@council/sdk';

const council = new CouncilClient({
  baseUrl: 'http://localhost:4000',
  podId: 'pod-checkout-redesign',
  agentId: 'my-agent',
  scope: 'frontend',
});

// Submit a context update
const result = await council.report({
  type: 'progress',
  summary: 'Implemented cart summary component',
  details: 'CartSummary.tsx renders line items with discounts.',
  status: 'completed',
});

console.log(result.council.classification); // "additive" | "overlapping" | "contradictory"

// Fetch the living doc
const doc = await council.getContext();

// Fetch pod state, conflicts, updates
const pod = await council.getPod();
const conflicts = await council.getConflicts();
const updates = await council.getUpdates();
```

### `@council/mcp-server`

MCP (Model Context Protocol) server that exposes Council data to Claude.ai. When connected, Claude can render an interactive pod dashboard as an artifact in the side panel.

**Tools:**

| Tool | Input | Description |
|------|-------|-------------|
| `list_pods` | (none) | List all active pods with IDs, names, pressure, and conflict counts |
| `render_pod_dashboard` | `pod_id` | Fetch all pod data and return a self-contained React component for rendering as a Claude.ai artifact |

The `render_pod_dashboard` tool fetches pod state, conflicts, context updates, the living doc, tunnels, and lint findings, then embeds them as inline JSON into a single-file React component with a dark Spectrum-inspired theme. The artifact has four tabs: Dashboard, Conflicts, Feed, and Live Doc.

**Setup:**

1. Build the package:

```bash
pnpm --filter @council/mcp-server build
```

2. Add to your Claude Desktop or Claude.ai MCP configuration:

```json
{
  "mcpServers": {
    "ai-council": {
      "command": "node",
      "args": ["/absolute/path/to/ai-council/packages/mcp-server/dist/index.js"],
      "env": {
        "COUNCIL_API_URL": "http://localhost:4000"
      }
    }
  }
}
```

3. Start the Council server (`pnpm --filter @council/server dev`), then ask Claude: *"Show me pod Auth Revamp's dashboard"*

The artifact renders a read-only snapshot — no network requests from the artifact itself. To refresh, ask Claude to show it again.

**Environment variables:**

| Variable | Default | Description |
|----------|---------|-------------|
| `COUNCIL_API_URL` | `http://localhost:4000` | Base URL of the Council Fastify server |

### `@council/cli`

Command-line interface for pod management, context submission, and tunnel control. Run via `npx tsx packages/cli/src/index.ts` (or `council` after building).

**Pod management:**

```bash
council pod create --name "My Sprint"        # Create a new pod
council pod list                              # List active pods
council pod status pod-my-sprint              # Show pod details
council pod archive pod-my-sprint             # Archive a completed pod
```

**Context updates:**

```bash
council report \
  --pod pod-my-sprint \
  --type progress \
  --scope frontend \
  --summary "Built the hero section" \
  --details "Responsive layout with animated gradient." \
  --status completed
```

**Living doc and lint:**

```bash
council doc pod-my-sprint                     # Print the living doc
council lint pod-my-sprint                    # Run a lint pass
```

**Tunnel management:**

```bash
council tunnel start --pod pod-my-sprint --port 3000 --dev alice
council tunnel list --pod pod-my-sprint
council tunnel stop --pod pod-my-sprint --tunnel <tunnelId>
```

All commands accept `--server <url>` to override the default `http://localhost:4000`, or set `COUNCIL_SERVER_URL`.

## Running the Demo Agent

With the server running:

```bash
npx tsx examples/demo-agent.ts
```

This creates two agents (frontend + backend), submits various update types (progress, decision, blocker), fetches the regenerated living doc, and prints the Council's classification for each update.

## Running the Full Demo

The full demo walks through the complete lifecycle — pod creation, updates, conflicts, resolution, and lint:

```bash
npx tsx examples/demo-full.ts
```

Or use the CLI-based demo:

```bash
bash examples/demo-cli.sh
```

## What You'll See

With the server and UI running, here's what each view shows:

| View | URL | What to Look For |
|------|-----|------------------|
| **Org Dashboard** | `/org` | All pods with pressure gauges, conflict counts, and tunnel activity |
| **Pod Dashboard** | `/pod/:id` | Health banner, milestone progress, area status grid, lint findings |
| **Conflict Center** | `/pod/:id/conflicts` | Open vs. resolved conflicts, severity badges, jump to detail |
| **Conflict Detail** | `/pod/:id/conflict/:cid` | Side-by-side positions, Council Master analysis, resolution buttons |
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
pnpm --filter @council/server dev
pnpm --filter @council/ui dev
pnpm --filter @council/server typecheck
pnpm --filter @council/ui typecheck
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4000` | Server port |
| `ANTHROPIC_API_KEY` | (none) | Enables LLM features (Haiku for merges, Sonnet for conflicts) |
| `ESCALATION_INTERVAL_MS` | `300000` (5 min) | How often to check for conflict escalation |
| `LINT_INTERVAL_MS` | `7200000` (2 hr) | How often to run the lint pass across all pods |
| `COUNCIL_API_URL` | `http://localhost:4000` | (MCP server) Base URL of the Council server |

## Architecture

### Context Update Flow

```
Agent/Human submits update
        |
        v
  POST /api/pods/:podId/context-updates
        |
        v
  Ingestion Lambda (validation, secret scan, DB write, WS broadcast)
        |
        v
  Council Master (classify update)
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
| Database | SQLite (better-sqlite3, WAL mode) |
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

## Not Yet Implemented (Deferred to AWS Deployment)

- **FE Tunneling** -- Real outbound WebSocket tunnels with proxy (localhost stub works via CLI)
- **AWS Infrastructure** (`packages/infra`) -- CDK stack for API Gateway, Lambda, DynamoDB, S3, Route 53
- **Adobe IMS auth** -- Currently no authentication
- **Slack integration** -- Conflict notifications and emoji-based resolution
- **Notification system** -- In-app, email, Slack DM per-user preferences

See `SPEC.md` for the full specification and implementation milestones.
