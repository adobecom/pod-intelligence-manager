# Architecture Overview

> Repository-bound durable memory uses the strict v1 surface documented in [MEMORY_API.md](./MEMORY_API.md). The legacy organization knowledge graph is not a repository- or plane-authorized substitute for that API.

A quick reference for the PIM system. For full design rationale and resolved decisions, see [../SPEC.md](../SPEC.md).

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

## Key Architectural Decisions

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

### Knowledge Graph and Canonical Memory
- **Purpose:** The legacy knowledge graph remains the token-budgeted read source for Pod session context. Once legacy authority is frozen it is read-only; new durable learnings enter canonical memory as review-gated candidates instead of mutating the graph.
- **Storage:** S3 for full graph snapshots (versioned JSON) + DynamoDB for indexed queries. Local dev uses filesystem at `.data/knowledge-graph/`. The storage interface is 3 functions — swapping to S3 is a single-file change.
- **Graph structure:** Nodes (decision, pattern, anti_pattern, resolved_conflict, scope_insight) + Edges (relates_to, supersedes, contradicts, builds_on, resolved_by) + Communities (label propagation clustering) + Hubs (high-degree nodes).
- **Confidence levels:** `extracted` (deterministic from DB) vs `inferred` (LLM-generated, score 0.4–0.85). Deterministic patterns are scored by a Haiku **durability classifier** at archival (high/medium/low/junk → 0.85/0.7/0.5/0.3); resolved conflicts keep 0.9. Offline fallback: 0.7. Ad-hoc submissions default to 0.7. A per-pod ceiling of 20 learnings (sorted by `confidence_score` DESC) caps pathological pods. Inspired by graphify's approach.
- **Token-budgeted queries:** Agents call `getRelevantLearnings(2000)` — server filters by domain, ranks by relevance, truncates to budget. Never dumps the full graph.
- **Authority-aware producer paths:**
  1. **Pod archival** — `POST /api/pods/:podId/archive` persists the archive and runs `extractKnowledgeEnhanced()` in the background. Under legacy authority the existing graph ingestion remains unchanged. Under frozen authority, selected learnings are submitted through the in-process canonical v1 receipt service as internal `org` candidates. `/archive/status` reports additive selected/dropped counters and the `memory_candidates_submitted` event means pending validation/review, not active memory.
  2. **Ad-hoc submission** — `POST /api/knowledge/nodes` (including SDK/MCP callers) uses legacy embedding/dedup only before cutover. Under frozen authority it returns `202 candidate_submitted` with the canonical receipt/candidate and selection counters.
  3. **Agent run/session rollups** — use the same canonical intake after freeze and do not create or auto-promote rows in the legacy `memory_candidates` table.
  4. **Project evidence** — searchable project evidence remains available, while legacy project candidate creation and project/agent promotion are retired under frozen authority.
  5. **Scheduled synthesis and development seeding** — explicitly no-op under frozen authority. Legacy graph maintenance, curation, telemetry persistence, and pruning are likewise fenced/no-op.
- **Canonical intake:** `packages/server/src/services/canonical-legacy-intake.ts` maps frozen producer output deterministically, preserves source material in bounded candidate extensions, uses generic immutable `pim://memory-source/...` evidence, and submits one candidate per canonical v1 receipt. A real project is used when present; otherwise one stable reserved system project is created lazily per organization. Internal `org` candidates remain pending policy-owner validation/review and cannot auto-activate. Public v2 remains codebase/harness only.
- **Legacy auto-pruning:** Before cutover, `pruneStaleNodes` rescored/tiered old graph nodes. It is disabled after the freeze along with all graph mutation.
- **Storage hygiene:** Local `graph-v*.json` capped to the most recent 10 snapshots; S3 noncurrent versions expire after 30 days.
- **Human curation:** UI graph curation applies only while legacy authority is writable; canonical candidates use the canonical validation/review lifecycle.
- **Key files:** `packages/server/src/services/canonical-legacy-intake.ts` (frozen-producer intake), `knowledge-graph.ts` (legacy graph core/read path), `memory-receipts.ts` and `memory-candidates.ts` (canonical v1 receipt/candidate lifecycle), `graph-storage.ts` (legacy snapshot storage), and `packages/shared/src/types/graph.ts` (source learning types).

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
