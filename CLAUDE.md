# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Status

This is a **pre-implementation repository**. The full spec lives in `SPEC.md`. No code exists yet. All architectural decisions referenced below are sourced from that spec.

## What This Is

**AI Council** is an Adobe-internal orchestration layer for cross-functional AI+human "pods" (5-day sprints). It keeps every agent (AI or human) synchronized via a canonical read-only "living doc" — automatically, in real time. Three pillars:

1. **FE Tunneling** — Expo-style localhost tunneling (one CLI command exposes a dev's local server to a stable URL for designers/PMs)
2. **AI Council (Brain)** — A context bus: agents submit structured updates, a Council Master routes to Committee agents, a living `.md` is assembled from DynamoDB state and written to S3
3. **Council UI (Surface)** — React + Spectrum 2 SPA for observing pod health, resolving conflicts, and viewing the live doc

## Intended Monorepo Layout

```
council/
├── packages/
│   ├── shared/        # Schemas, types, constants — single source of truth
│   ├── sdk/           # @council/sdk (agent-facing client)
│   ├── cli/           # npx council (tunnel + pod management)
│   ├── ui/            # React Vite SPA + Adobe Spectrum 2
│   └── infra/         # AWS CDK stack
├── lambdas/
│   ├── ingestion/     # Context intake + secret scanning
│   ├── master/        # Council Master router
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

### Council Master
- Lightweight Lambda orchestrator — deterministic routing only, no large context window
- Does NOT do feature work; delegates reasoning to Committee agents
- Enforces role-based permissions for spec changes and conflict resolutions

### Committee Agents (Claude/Bedrock)
- **Merge Agent** — Haiku model; handles additive, non-overlapping updates without LLM when possible
- **Conflict Agent** — Sonnet model; detects contradictions, creates conflict records
- **Summary Agent** — Renders living doc `.md` from DynamoDB state to S3; runs periodic lint pass every 2 hours
- **Cross-Pod Agent** — Inter-pod advisory (read-only, non-blocking)
- **Knowledge Extraction Agent** — Distills learnings when a pod completes

### Living Doc
- **Read-only output** assembled from DynamoDB state — never edited directly
- Humans/agents influence it by submitting context updates to the Council
- Conflict Pressure score (0.0–1.0) gates merge behavior:
  - 0.0–0.3: Auto-merge freely
  - 0.3–0.6: Merge with disclaimers
  - 0.6–0.8: Hold contested areas
  - 0.8–1.0: Ingestion halted

### Context Update Schema
Every agent contribution must include: `agent_id`, `timestamp`, `pod_id`, `type` (progress|blocker|spec_change|question|decision), `scope` (frontend|backend|design|qa|infra|pm), `summary`, `details`, `artifacts`, `status`, `blocks`, `blocked_by`, `needs_input_from`.

### Tunneling
- Outbound WebSocket from CLI to API Gateway (NAT-friendly, no port forwarding)
- Tunnel health: heartbeat every 60s; idle after 20min of no traffic (yellow in UI); only disconnected on heartbeat failure — do NOT auto-disconnect idle tunnels
- Stable URLs: `{pod}-{dev}.council.{org}.com` via Route 53 wildcard + ACM cert

### Security (Three Checkpoints)
1. Ingestion Lambda: deterministic pattern scan for secrets (AWS keys, JWTs, connection strings)
2. LLM system prompts: explicit instruction to never output secrets
3. Summary Agent: pattern scan before every S3 write

### Cost Optimization
- Additive updates (~60%) → deterministic merge, no LLM call
- Routine merges (~30%) → Haiku
- Conflict analysis (~10%) → Sonnet
- Target: ~$5–8 per 5-day pod with 5 agents

## AWS Service Map

| Concern | Service |
|---------|---------|
| Agent/Human API | API Gateway (REST + WebSocket) |
| Event routing | EventBridge |
| Compute | Lambda |
| AI reasoning | Bedrock (Claude) or Claude API |
| Living doc storage | S3 (versioned) |
| State & metadata | DynamoDB |
| Auth | Adobe IMS |
| DNS | Route 53 |
| CDN / UI hosting | CloudFront + S3 |
| Notifications | SNS + SQS |
| Slack integration | Lambda + Secrets Manager |
| Infra-as-code | CDK |
| Observability | CloudWatch + X-Ray |

## V1 Out of Scope
- Tunnel preview embedded in Council UI
- Auto-recorded visual diffs
- Side-by-side tunnel comparison
- State injection into tunneled apps
- Annotation layer on live preview (interesting, flagged for post-v1)

## Implementation Milestones (from SPEC.md)
1. **Days 1–2:** Monorepo scaffold, shared types, CDK, DynamoDB schema, ingestion Lambda, secret scan, Council Master v0, SDK v0, CLI pod create, IMS auth
2. **Days 3–4:** Merge/Conflict/Summary agents + Bedrock prompts, lint pass, conflict pressure
3. **Days 4–6:** React Vite app, Pod Dashboard, Conflict Center, Live Doc View, WebSocket real-time
4. **Days 6–8:** Slack integration, escalation ladder, Org Dashboard, Cross-Pod Agent, Knowledge Extraction, pod archival
5. **Days 8–10:** Dogfooding, stress testing, prompt tuning, cost validation
