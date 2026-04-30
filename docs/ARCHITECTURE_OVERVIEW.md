# Architecture Overview

A quick reference for the PIM system. For full design rationale and resolved decisions, see [../SPEC.md](../SPEC.md).

**Truth vs aspiration:** Shipped code runs **Fastify + SQLite + filesystem KG** on **EC2** (`PimEc2Stack`). SPEC and sections below also describe the **target** AWS-native stack (Lambda + DynamoDB + API Gateway). Read **[ARCHITECTURE_CURRENT_VS_TARGET.md](ARCHITECTURE_CURRENT_VS_TARGET.md)** first so you know which sentences refer to which era.

## Intended Monorepo Layout

```
pim/
├── packages/
│   ├── shared/        # Schemas, types, constants — single source of truth
│   ├── sdk/           # @pim/sdk (agent-facing client)
│   ├── cli/           # npx pim (tunnel + pod management)
│   ├── ui/            # React Vite SPA + Adobe Spectrum 2
│   ├── server/        # Fastify app — shipped orchestrator + committee agents (in-process)
│   └── infra/         # AWS CDK — deployed: PimEc2Stack; reference: pim-stack.ts (Lambda+DynamoDB)
├── prompts/           # Version-controlled Bedrock/Claude system prompts
├── turbo.json
└── pnpm-workspace.yaml
```

*(SPEC §architecture diagrams may show a `lambdas/` tree — that split is the **target** decomposition; committee logic currently lives under `packages/server/src/pim/`.)*

## Key Architectural Decisions

### PIM orchestrator
- **Shipped:** In-process orchestration in `packages/server` (Fastify routes → classifier → merge/conflict/summary paths).
- **Target:** Lightweight Lambda orchestrator — deterministic routing only, no large context window; delegates reasoning to Committee lambdas.
- Does NOT do feature work itself; delegates reasoning to Committee agents.
- Enforces role-based permissions for spec changes and conflict resolutions (target); shipped enforcement follows the same rules where implemented in server middleware.

### Committee Agents (Claude API — Anthropic SDK)
- **Merge Agent** — Haiku model; handles additive, non-overlapping updates without LLM when possible
- **Conflict Agent** — Sonnet model; detects contradictions, creates conflict records; queries knowledge graph for historical precedents
- **Summary Agent** — Renders living doc `.md` from DB state; runs periodic lint pass every 2 hours; includes "Knowledge Context" section from org memory
- **Cross-Pod Agent** — Inter-pod advisory (read-only, non-blocking); enriches advisories with historical learnings from the knowledge graph
- **Knowledge Extraction Agent** — Distills learnings when a pod is archived; deterministic base (substantive decisions and resolved conflicts only — blockers are not extracted, and decisions with `details < 30 chars` are skipped) + optional LLM-enhanced extraction (Sonnet) with cross-graph dedup. Domains come from the source row's authoritative `scope`, not keyword inference. Outputs `EnhancedPodLearning[]` with confidence levels and domain tags.

### Living Doc
- **Read-only output** — never edited directly. **Shipped:** assembled from **SQLite** state (`living_docs`, pods, conflicts, etc.) via in-process regeneration. **Target:** assembled from **DynamoDB** state by the Summary Agent and written to **S3**.
- Humans/agents influence it by submitting context updates to PIM
- Conflict Pressure score (0.0–1.0) gates merge behavior:
  - 0.0–0.3: Auto-merge freely
  - 0.3–0.6: Merge with disclaimers
  - 0.6–0.8: Hold contested areas
  - 0.8–1.0: Intake queued (validation + secret scan still run; PIM orchestration paused until conflicts resolve; backlog alerts fire via Slack at threshold)

### Context Update Schema
Every agent contribution must include: `agent_id`, `timestamp`, `pod_id`, `type` (progress|blocker|spec_change|question|decision), `scope` (frontend|backend|design|qa|infra|pm), `summary`, `details`, `artifacts`, `status`, `blocks`, `blocked_by`, `needs_input_from`.

### Tunneling
- **Shipped:** CLI ↔ Fastify server WebSocket/data plane; tunnel rows in **SQLite** (`tunnels` table). See SPEC §2 for the **target** (API Gateway broker + DynamoDB registry + stable DNS).
- Tunnel health: heartbeat every 60s; idle after 20min of no traffic (yellow in UI); only disconnected on heartbeat failure — do NOT auto-disconnect idle tunnels
- **Target:** Stable URLs `{pod}-{dev}.pim.{org}.com` via Route 53 wildcard + ACM cert

### Security (Three Checkpoints)
1. **Shipped:** Secret scan in the Fastify ingestion path (`packages/server`). **Target:** Ingestion Lambda — deterministic pattern scan for secrets (AWS keys, JWTs, connection strings).
2. LLM system prompts: explicit instruction to never output secrets
3. Summary Agent: pattern scan before persisting rendered markdown (**target:** before every S3 write; **shipped:** before DB write of living doc)

### Knowledge Graph (Persistent Org Memory)
- **Purpose:** The PIM is the org's persistent knowledge base. Learnings accumulate across all pod lifecycles. Agents in new pods query it with token budgets to get relevant historical context without context window bloat.
- **Storage — shipped:** Org-level JSON under `KG_DATA_DIR` (default `.data/knowledge-graph/`; prod `/data/knowledge-graph`). Disk is **authoritative at runtime**; the graph is loaded into memory on startup. If **`KG_S3_BUCKET`** is set, saves are **mirrored** to S3 and **restore-from-S3** runs when local files are missing — not a pluggable “S3-only” backend. **`graph-storage.ts`** centralizes load/save/versioning.
- **Storage — target (SPEC):** S3 for full graph snapshots (versioned JSON) + **DynamoDB** for indexed queries (GSIs on domain, type, confidence). Enables horizontal scaling without each instance holding the full graph on disk.
- **Graph structure:** Nodes (decision, pattern, anti_pattern, resolved_conflict, scope_insight) + Edges (relates_to, supersedes, contradicts, builds_on, resolved_by) + Communities (label propagation clustering) + Hubs (high-degree nodes).
- **Confidence levels:** `extracted` (deterministic from DB) vs `inferred` (LLM-generated, score 0.4–0.85). Deterministic patterns are scored by a Haiku **durability classifier** at archival (high/medium/low/junk → 0.85/0.7/0.5/0.3); resolved conflicts keep 0.9. Offline fallback: 0.7. Ad-hoc submissions default to 0.7. A per-pod ceiling of 20 learnings (sorted by `confidence_score` DESC) caps pathological pods. Inspired by graphify's approach.
- **Token-budgeted queries:** Agents call `getRelevantLearnings(2000)` — server filters by domain, ranks by relevance, truncates to budget. Never dumps the full graph.
- **Ingestion paths (only two):**
  1. **Pod archival** — `POST /api/pods/:podId/archive` → `extractKnowledgeEnhanced()` → `addLearningsToGraph()`. The graph crystallizes here. Live context updates do *not* flow into the graph during a sprint — that proved noisy and racy.
  2. **Ad-hoc submission** — `POST /api/knowledge/nodes` (REST), `submitLearning()` (SDK), `submit_knowledge_learning` (MCP) for confirmed learnings outside any pod (bug fixes, chatbot/agent conversations). Synchronous embedding + dedup; community detection is **deferred** (the request marks the graph stale and the periodic `refreshAnalysisIfStale` interval recomputes). Entries default to `confidence_score: 0.7`, `curated: false` so they enter the curation queue.
- **Auto-pruning:** A daily job (`pruneStaleNodes`) deletes uncurated nodes with `confidence_score < 0.5` older than 180 days. Curated and superseded nodes are protected. One-time backfill for legacy pre-classifier 0.9-confidence pattern nodes: `pnpm --filter @pim/server rescore-legacy [--dry-run]` reclassifies them via Haiku so junk eventually flows through the auto-pruner.
- **Storage hygiene:** Local `graph-v*.json` capped to the most recent 10 snapshots; S3 noncurrent versions expire after 30 days.
- **Human curation:** UI at `/knowledge` lets humans approve/reject/edit learnings.
- **Key files:** `packages/server/src/services/knowledge-graph.ts` (core), `graph-storage.ts` (disk + optional S3 mirror), `graph-analysis.ts` (algorithms), `packages/shared/src/types/graph.ts` (types)

### Cost Optimization
- Additive updates (~60%) → deterministic merge, no LLM call
- Routine merges (~30%) → Haiku
- Conflict analysis (~10%) → Sonnet
- Knowledge extraction → once per pod lifecycle (Sonnet + Haiku for edges), ~$0.05–0.15
- Target: ~$5–8 per 5-day pod with 5 agents

## AWS maps

### Shipped stack (`PimEc2Stack`)

| Concern | Service |
|---------|---------|
| Agent/Human API + WebSocket | **ALB → EC2** (single Fastify process) |
| Static UI | **S3 + CloudFront** |
| Operational DB | **SQLite on EBS** (container `/data/pim.db`) |
| Knowledge graph durability | **Optional S3** (`KG_S3_BUCKET`) mirroring JSON |
| DB / KG backups | **S3** backups bucket (host/cron — see **DEPLOY.md**) |
| Secrets | **SSM** Parameter Store `/pim/*` |
| Container registry | **ECR** |
| Observability | **CloudWatch** logs |

### Target stack (SPEC / `pim-stack.ts` reference — not deployed)

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

Historical sprint plan; much of this exists in **Fastify + SQLite** form. Future hardening aligns with **ARCHITECTURE_CURRENT_VS_TARGET.md**.

1. **Days 1–2:** Monorepo scaffold, shared types, CDK, ~~DynamoDB schema~~ *(reference in `pim-stack.ts`)*, ~~ingestion Lambda~~ *(shipped: Fastify ingestion)*, secret scan, PIM orchestrator v0, SDK v0, CLI pod create, IMS auth
2. **Days 3–4:** Merge/Conflict/Summary agents + Bedrock prompts, lint pass, conflict pressure
3. **Days 4–6:** React Vite app, Pod Dashboard, Conflict Center, Live Doc View, WebSocket real-time
4. **Days 6–8:** Slack integration, escalation ladder, Org Dashboard, Cross-Pod Agent, Knowledge Extraction, pod archival
5. **Days 8–10:** Dogfooding, stress testing, prompt tuning, cost validation
