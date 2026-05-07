# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Pod agent requirement

When working **in a pod managed by PIM** (yours or a consumer repo using `@pim/sdk`), you **must**:

1. **Pull session context before substantive work** — use `PimClient.pullSessionContext()`, the MCP tool `get_agent_session_context`, or `pim context` (see `docs/POD_AGENT_PROTOCOL.md`).
2. **Report to PIM after lock-in** — commits, reverts, or equivalent; use `report()`, `pim report`, MCP `submit_context_update`, or install git hooks with `pim hooks install`.

Full normative text: [docs/POD_AGENT_PROTOCOL.md](docs/POD_AGENT_PROTOCOL.md).

## Project Status

Active implementation. Core backend (Fastify server, SQLite, WebSocket), PIM orchestrator, Committee agents (merge, conflict, summary, cross-pod, knowledge-extraction, lint), React + Spectrum 2 UI (all views), and SDK are implemented. **Hosted at `https://d1ygncl0yqo6sv.cloudfront.net/`** (CloudFront + EC2 via CDK). Local dev runs on `:4000` (server) and `:5173` (UI).

## What This Is

**PIM** is an Adobe-internal orchestration layer for cross-functional AI+human "pods" (5-day sprints). It keeps every agent (AI or human) synchronized via a canonical read-only "living doc" — automatically, in real time. Three pillars:

1. **FE Tunneling** — Expo-style localhost tunneling (one CLI command exposes a dev's local server to a stable URL for designers/PMs)
2. **PIM (Brain)** — Context bus: agents submit structured updates → orchestrator routes to Committee agents → living `.md` is assembled from DynamoDB state and written to S3
3. **PIM UI (Surface)** — React + Spectrum 2 SPA for pod health, conflicts, and the live doc

## Knowledge Graph — load-bearing rules

The graph is the org's persistent memory. Two ingestion paths only — do not add a third:

1. **Pod archival** — `POST /api/pods/:podId/archive` → `extractKnowledgeEnhanced()` → `addLearningsToGraph()`. The graph crystallizes here. Live context updates do *not* flow into the graph during a sprint (that proved noisy and racy).
2. **Ad-hoc submission** — `POST /api/knowledge/nodes` (REST), `submitLearning()` (SDK), `submit_knowledge_learning` (MCP) for confirmed learnings outside any pod. Synchronous embedding + dedup; community detection is **deferred** to the periodic `refreshAnalysisIfStale` interval. Defaults: `confidence_score: 0.7`, `curated: false`.

Agents query via `getRelevantLearnings(tokenBudget)` — never dump the full graph. Full details, confidence scoring, pruning, and storage layout in [docs/ARCHITECTURE_OVERVIEW.md](docs/ARCHITECTURE_OVERVIEW.md#knowledge-graph-persistent-org-memory).

## Where to look

- **Full spec & design rationale:** [SPEC.md](SPEC.md)
- **Architecture quick reference** (orchestrator, committee, living doc, tunneling, security, knowledge graph, AWS map, milestones, monorepo layout): [docs/ARCHITECTURE_OVERVIEW.md](docs/ARCHITECTURE_OVERVIEW.md)
- **Pod agent protocol:** [docs/POD_AGENT_PROTOCOL.md](docs/POD_AGENT_PROTOCOL.md)
- **Deployment:** [docs/DEPLOY.md](docs/DEPLOY.md), [docs/DEPLOYMENT_CHECKLIST.md](docs/DEPLOYMENT_CHECKLIST.md)
- **Context search:** [docs/CONTEXT_SEARCH.md](docs/CONTEXT_SEARCH.md)


<!-- pim-pod-agent-begin -->

## PIM — Pod Agent Protocol

This project is connected to PIM pod `pod-pim-live-demo-prep-848a3e`.
PIM server: `https://d1ygncl0yqo6sv.cloudfront.net`

### Automatic Reporting

Context updates are automatically reported to PIM when you:
- **Make a git commit** — via post-commit hook (captures subject, body, changed files)
- **Create a pull request** — via Claude Code hook (captures PR URL and title)

You do not need to manually report routine progress — it flows automatically.

### PIM MCP Tools (Preferred)

If the PIM MCP server is configured in Claude Code, **always use these tools
instead of CLI commands** — they are faster and don't require a shell.

**Context & Session**

| Tool | When to use |
|------|-------------|
| `get_agent_session_context` | Pull pod state, living doc, conflicts, and token-budgeted org learnings in one call |
| `context_search` | Search external sources (Slack archives, Jira, Confluence, GitHub, git) via PIM's aggregated search — no separate Slack/Jira MCPs needed |
| `query_knowledge` | Search the org knowledge graph for historical precedents and resolved decisions |

**Reporting**

| Tool | When to use |
|------|-------------|
| `submit_context_update` | Report progress, blockers, decisions, spec changes, or questions |

**Conflicts**

| Tool | When to use |
|------|-------------|
| `get_conflict_details` | Inspect a specific open conflict and its suggested resolutions |
| `resolve_conflict` | Mark a conflict as resolved with a chosen approach |

**Observability**

| Tool | When to use |
|------|-------------|
| `render_pod_dashboard` | Get a full interactive React artifact showing pod health, conflicts, feed, and live doc |
| `list_pods` | See all active pods in the org |

### Fallback: CLI Commands

Use these only when the PIM MCP server is not configured.

#### Getting Current Pod Context

```bash
pim context --pod pod-pim-live-demo-prep-848a3e --scope frontend
```

Use `--brief` for a quick summary or `--diff` to see only what changed since
your last pull. If conflict pressure is >= 0.6, check open conflicts before
proceeding in contested areas.

#### Manual Reporting

Report blockers, decisions, spec changes, and questions manually:

```bash
pim report --pod pod-pim-live-demo-prep-848a3e --type decision --scope frontend \
  --summary "Chose Redis over Memcached for session cache" \
  --details "Redis supports pub/sub which we need for real-time invalidation..."
```

Types: `progress` | `blocker` | `spec_change` | `question` | `decision`

### Quality Guidelines

- Summaries should be specific and actionable (avoid "made progress" or "working on it")
- Include file paths, function names, or API endpoints when relevant
- Declare blockers and input requests — this triggers PIM's escalation system
- Artifacts (changed files) are automatically included with commit reports

### Conflict Awareness

- Check pod pressure with `pim context --pod pod-pim-live-demo-prep-848a3e --brief`
- If pressure is >= 0.8, ingestion is halted — resolve conflicts first
- When your work overlaps with another area, PIM will detect it automatically

<!-- pim-pod-agent-end -->
