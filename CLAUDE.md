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
