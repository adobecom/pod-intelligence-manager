# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Pod agent requirement

When working **in a pod managed by PIM** (yours or a consumer repo using `@pim/sdk`), you **must**:

1. **Pull session context before substantive work** — use `PimClient.pullSessionContext()`, the MCP tool `get_agent_session_context`, or `pim context` (see `docs/POD_AGENT_PROTOCOL.md`).
2. **Report to PIM after lock-in** — commits, reverts, or equivalent; use `report()`, `pim report`, MCP `submit_context_update`, or install git hooks with `pim hooks install`.

Full normative text: [docs/POD_AGENT_PROTOCOL.md](docs/POD_AGENT_PROTOCOL.md).

## Project Status

Active implementation. Core backend (Fastify server, SQLite, WebSocket), PIM orchestrator, Committee agents (merge, conflict, summary, cross-pod, knowledge-extraction, lint), React + Spectrum 2 UI (all views), and SDK are implemented. **Hosted at `https://d1ygncl0yqo6sv.cloudfront.net/`** (CloudFront + EC2 via CDK). Local dev runs on `:4000` (server) and `:5173` (UI). The full spec lives in `SPEC.md`.

## What This Is

**PIM** is an Adobe-internal orchestration layer for cross-functional AI+human "pods" (5-day sprints). It keeps every agent (AI or human) synchronized via a canonical read-only "living doc" — automatically, in real time. Three pillars:

1. **FE Tunneling** — Expo-style localhost tunneling (one CLI command exposes a dev's local server to a stable URL for designers/PMs)
2. **PIM (Brain)** — A context bus: agents submit structured updates, a PIM orchestrator routes to Committee agents, a living `.md` is assembled from DynamoDB state and written to S3
3. **PIM UI (Surface)** — React + Spectrum 2 SPA for observing pod health, resolving conflicts, and viewing the live doc

## Intended Monorepo Layout

```
pim/
├── packages/
│   ├── shared/        # Schemas, types, constants — single source of truth
│   ├── sdk/           # @pim/sdk (agent-facing client)
│   ├── cli/           # npx pim (tunnel + pod management)
│   ├── ui/            # React Vite SPA + Adobe Spectrum 2
│   └── infra/         # AWS CDK stack
├── lambdas/
│   ├── ingestion/     # Context intake + secret scanning
│   ├── master/        # PIM orchestrator router
│   ├── agents/
│   │   ├── merge/
│   │   ├── conflict/
│   │   ├── summary/
│   │   ├── cross-pod/
│   │   └── knowledge-extraction/
│   ├── tunnel-broker/
│   ├── notifications/
│   └── escalation/
├── prompts/           # Version-controlled Bedrock/Claude system prompts
├── turbo.json
└── pnpm-workspace.yaml
```

## Key Architectural Decisions (from SPEC.md)

### PIM orchestrator
- Lightweight Lambda orchestrator — deterministic routing only, no large context window
- Does NOT do feature work; delegates reasoning to Committee agents
- Enforces role-based permissions for spec changes and conflict resolutions

### Committee Agents (Claude API — Anthropic SDK)
- **Merge Agent** — Haiku model; handles additive, non-overlapping updates without LLM when possible
- **Conflict Agent** — Sonnet model; detects contradictions, creates conflict records; queries knowledge graph for historical precedents
- **Summary Agent** — Renders living doc `.md` from DB state; runs periodic lint pass every 2 hours; includes "Knowledge Context" section from org memory
- **Cross-Pod Agent** — Inter-pod advisory (read-only, non-blocking); enriches advisories with historical learnings from the knowledge graph
- **Knowledge Extraction Agent** — Distills learnings when a pod is archived; deterministic base (substantive decisions and resolved conflicts only — blockers are not extracted, and decisions with `details < 30 chars` are skipped) + optional LLM-enhanced extraction (Sonnet) with cross-graph dedup. Domains come from the source row's authoritative `scope`, not keyword inference. Outputs `EnhancedPodLearning[]` with confidence levels and domain tags.

### Living Doc
- **Read-only output** assembled from DynamoDB state — never edited directly
- Humans/agents influence it by submitting context updates to PIM
- Conflict Pressure score (0.0–1.0) gates merge behavior:
  - 0.0–0.3: Auto-merge freely
  - 0.3–0.6: Merge with disclaimers
  - 0.6–0.8: Hold contested areas
  - 0.8–1.0: Intake queued (validation + secret scan still run; PIM orchestration paused until conflicts resolve; backlog alerts fire via Slack at threshold)

### Context Update Schema
Every agent contribution must include: `agent_id`, `timestamp`, `pod_id`, `type` (progress|blocker|spec_change|question|decision), `scope` (frontend|backend|design|qa|infra|pm), `summary`, `details`, `artifacts`, `status`, `blocks`, `blocked_by`, `needs_input_from`.

### Tunneling
- Outbound WebSocket from CLI to API Gateway (NAT-friendly, no port forwarding)
- Tunnel health: heartbeat every 60s; idle after 20min of no traffic (yellow in UI); only disconnected on heartbeat failure — do NOT auto-disconnect idle tunnels
- Stable URLs: `{pod}-{dev}.pim.{org}.com` via Route 53 wildcard + ACM cert

### Security (Three Checkpoints)
1. Ingestion Lambda: deterministic pattern scan for secrets (AWS keys, JWTs, connection strings)
2. LLM system prompts: explicit instruction to never output secrets
3. Summary Agent: pattern scan before every S3 write

### Knowledge Graph (Persistent Org Memory)
- **Purpose:** The PIM is the org's persistent knowledge base. Learnings accumulate across all pod lifecycles. Agents in new pods query it with token budgets to get relevant historical context without context window bloat.
- **Storage:** S3 for full graph snapshots (versioned JSON) + DynamoDB for indexed queries. Local dev uses filesystem at `.data/knowledge-graph/`. The storage interface is 3 functions — swapping to S3 is a single-file change.
- **Graph structure:** Nodes (decision, pattern, anti_pattern, resolved_conflict, scope_insight) + Edges (relates_to, supersedes, contradicts, builds_on, resolved_by) + Communities (label propagation clustering) + Hubs (high-degree nodes).
- **Confidence levels:** `extracted` (deterministic from DB, score 0.9) vs `inferred` (LLM-generated, score 0.4–0.85). Ad-hoc submissions default to 0.7. Inspired by graphify's approach.
- **Token-budgeted queries:** Agents call `getRelevantLearnings(2000)` — server filters by domain, ranks by relevance, truncates to budget. Never dumps the full graph.
- **Ingestion paths (only two):**
  1. **Pod archival** — `POST /api/pods/:podId/archive` → `extractKnowledgeEnhanced()` → `addLearningsToGraph()`. The graph crystallizes here. Live context updates do *not* flow into the graph during a sprint — that proved noisy and racy.
  2. **Ad-hoc submission** — `POST /api/knowledge/nodes` (REST), `submitLearning()` (SDK), `submit_knowledge_learning` (MCP) for confirmed learnings outside any pod (bug fixes, chatbot/agent conversations). Synchronous embedding + dedup; entries default to `confidence_score: 0.7`, `curated: false` so they enter the curation queue.
- **Auto-pruning:** A daily job (`pruneStaleNodes`) deletes uncurated nodes with `confidence_score < 0.5` older than 180 days. Curated and superseded nodes are protected.
- **Storage hygiene:** Local `graph-v*.json` capped to the most recent 10 snapshots; S3 noncurrent versions expire after 30 days.
- **Human curation:** UI at `/knowledge` lets humans approve/reject/edit learnings.
- **Key files:** `packages/server/src/services/knowledge-graph.ts` (core), `graph-storage.ts` (S3 abstraction), `graph-analysis.ts` (algorithms), `packages/shared/src/types/graph.ts` (types)

### Cost Optimization
- Additive updates (~60%) → deterministic merge, no LLM call
- Routine merges (~30%) → Haiku
- Conflict analysis (~10%) → Sonnet
- Knowledge extraction → once per pod lifecycle (Sonnet + Haiku for edges), ~$0.05–0.15
- Target: ~$5–8 per 5-day pod with 5 agents

## AWS Service Map

| Concern | Service |
|---------|---------|
| Agent/Human API | API Gateway (REST + WebSocket) |
| Event routing | EventBridge |
| Compute | Lambda |
| AI reasoning | Bedrock (Claude) or Claude API |
| Living doc storage | S3 (versioned) |
| Knowledge graph snapshots | S3 (versioned JSON) |
| Knowledge graph queries | DynamoDB (GSIs on domain, type, confidence) |
| State & metadata | DynamoDB |
| Auth | Adobe IMS |
| DNS | Route 53 |
| CDN / UI hosting | CloudFront + S3 |
| Notifications | SNS + SQS |
| Slack integration | Lambda + Secrets Manager |
| Infra-as-code | CDK |
| Observability | CloudWatch + X-Ray |

## V1 Out of Scope
- Tunnel preview embedded in PIM UI
- Auto-recorded visual diffs
- Side-by-side tunnel comparison
- State injection into tunneled apps
- Annotation layer on live preview (interesting, flagged for post-v1)

## Implementation Milestones (from SPEC.md)
1. **Days 1–2:** Monorepo scaffold, shared types, CDK, DynamoDB schema, ingestion Lambda, secret scan, PIM orchestrator v0, SDK v0, CLI pod create, IMS auth
2. **Days 3–4:** Merge/Conflict/Summary agents + Bedrock prompts, lint pass, conflict pressure
3. **Days 4–6:** React Vite app, Pod Dashboard, Conflict Center, Live Doc View, WebSocket real-time
4. **Days 6–8:** Slack integration, escalation ladder, Org Dashboard, Cross-Pod Agent, Knowledge Extraction, pod archival
5. **Days 8–10:** Dogfooding, stress testing, prompt tuning, cost validation
