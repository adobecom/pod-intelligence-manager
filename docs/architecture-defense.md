# PIM — Architecture Defense

> Prepared for architect review, April 2026.
> This document defends and justifies every major design decision in the PIM system.

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Why Existing Tools Don't Solve This](#2-why-existing-tools-dont-solve-this)
3. [What PIM Is](#3-what-pim-is)
4. [Pillar 1 — FE Tunneling](#4-pillar-1--fe-tunneling)
5. [Pillar 2 — The PIM Brain (Orchestrator + Committee)](#5-pillar-2--the-pim-brain-orchestrator--committee)
6. [Pillar 3 — PIM UI](#6-pillar-3--pim-ui)
7. [Knowledge Graph — Persistent Org Memory](#7-knowledge-graph--persistent-org-memory)
8. [Security Model](#8-security-model)
9. [Cost Model](#9-cost-model)
10. [Infrastructure Model](#10-infrastructure-model)
11. [What Is Already Built](#11-what-is-already-built)
12. [Anticipated Architect Questions](#12-anticipated-architect-questions)

---

## 1. Problem Statement

Cross-functional pods today run on implicit context. Agents (AI or human) each hold a local mental model of the sprint state: what's been decided, what's blocked, what assumptions are in play. When those models diverge — and they always do — the divergence is invisible until a blocker surfaces in QA or a PR review, days after the bad assumption was made.

The cost of late divergence detection in a 5-day sprint is disproportionate. A conflict discovered on Day 4 may require rewinding 2–3 days of parallel work. With multiple AI agents working concurrently, the rate of context delta production is an order of magnitude higher than humans can manually route and reconcile.

The problem is not agent intelligence — it is **coordination infrastructure**. Agents are capable of doing excellent work in isolation. What they lack is a shared, structured, real-time source of truth that they can read from and write to. Without that, every agent is effectively working in a fork of reality.

---

## 2. Why Existing Tools Don't Solve This

| Tool | Gap |
|---|---|
| **Slack** | No schema. No conflict detection. No API that agents can call to get a token-budgeted slice of relevant context. Conversations are ephemeral; decisions get buried. Search quality is poor for semantic queries. |
| **Confluence / Notion** | Write-by-humans only. No structured schema. No real-time merge semantics. No concept of "this update contradicts that one." Stale within hours on a fast-moving sprint. |
| **Jira** | Tracks tickets, not reasoning. Cannot represent "fe-agent-01 and be-agent-01 have incompatible assumptions about the cart API response shape." No living doc synthesis. |
| **GitHub PRs** | Catches code-level conflicts post-hoc, after the work is done. Does not catch semantic conflicts during work. Does not give agents a place to pull current sprint state before starting. |
| **Shared Google Doc** | No schema. No merge protocol. No conflict detection. No programmatic API. Multiple simultaneous agents editing produces chaos, not synthesis. |

None of these tools have:
- A structured context update schema that agents can write to
- Automatic semantic merge with conflict detection
- A canonical read-only living doc derived from structured state
- A token-budgeted API for agents to pull relevant context without bloating their context windows
- An escalation protocol tied to sprint pace (not arbitrary SLAs)

---

## 3. What PIM Is

PIM (Pod Intelligence Manager) is a **context bus with memory**. It sits between all agents in a pod and ensures:

1. Every agent writes structured context updates into a single system.
2. The system attempts to merge those updates automatically, with confidence-gated behavior.
3. When updates contradict, a conflict record is created with full attribution, both positions, and an automated impact analysis.
4. A living markdown document is continuously re-assembled from the canonical state and broadcast to all agents.
5. When a pod ends, durable learnings are extracted and added to an org-level knowledge graph that future pods can query.

The system has three visible surfaces: **FE Tunneling** (for dev-to-stakeholder feedback loops), **PIM Brain** (the orchestration engine), and **PIM UI** (the human control plane).

---

## 4. Pillar 1 — FE Tunneling

### The Problem

Feature branches live on local machines or behind CI gates. Designers and PMs cannot see progress without a deploy, a screen share, or waiting for a staging environment that may be days behind the active branch. The feedback loop is asynchronous in the worst way — by the time feedback arrives, the developer has moved on.

### Architecture

The mental model is Expo's tunnel mode: a dev runs their local server, a single CLI command exposes it to a stable remote URL, and any pod member can visit the live app — no deploy, no port forwarding required.

```
Dev's localhost:3000
       │
  pim tunnel start  (CLI outbound WebSocket — NAT/firewall friendly)
       │
  AWS API Gateway (WebSocket API, persistent session per dev)
       │
  Lambda tunnel-broker (maps incoming HTTP → correct dev tunnel session via DynamoDB lookup)
       │
  Route 53 wildcard: {pod}-{dev}.pim.{org}.com
       │  (ACM wildcard cert, auto-provisioned, zero config per tunnel)
  CloudFront distribution
```

**Key decisions and their reasoning:**

- **Outbound WebSocket, not inbound port forwarding.** Port forwarding requires network configuration that varies across Adobe's internal environments. An outbound WebSocket works behind any NAT or corporate firewall with no setup. This is the same model Expo, ngrok, and VS Code Dev Tunnels use.

- **Stable subdomain per dev per pod.** `checkout-alice.pim.adobe.com` is predictable, linkable, and bookmarkable. A random-token URL would require the designer to re-ask for the link every session. Stability is a UX property that reduces synchronous interrupts.

- **Idle ≠ disconnected.** Tunnels are marked idle (yellow in UI) after 20 minutes of no HTTP traffic but are only disconnected on heartbeat failure (heartbeat every 60 seconds). This is non-obvious but critical: in AI-assisted development, a dev may be waiting 15+ minutes for code generation with no localhost changes. The reviewer should still be able to access the last-served state. Auto-disconnecting an idle tunnel would force the dev to re-share a link mid-session — an unnecessary interrupt.

- **No asset splitting.** All traffic proxies through the WebSocket connection. The dev's local bundler already serves optimized dev builds. Splitting static assets to S3/CloudFront adds complexity for a marginal latency gain that reviewers (designers, PMs observing progress) won't notice at 200ms round-trip.

- **Wildcard ACM cert, not per-tunnel cert provisioning.** Per-tunnel cert provisioning via ACM/Let's Encrypt takes 30–60 seconds and adds latency to tunnel creation. A wildcard cert on `*.pim.{org}.com` is provisioned once during org setup (CDK stack) and applies to all tunnels automatically.

### Multi-tunnel support

Multiple devs tunnel simultaneously, each with their own stable URL. The PIM UI shows a live tunnel dashboard listing all active tunnels per pod:

| Dev | Branch | URL | Status | Last Activity |
|---|---|---|---|---|
| alice | feat/cart-summary | checkout-alice.pim.adobe.com | Live | 2 min ago |
| bob | feat/checkout-flow | checkout-bob.pim.adobe.com | Live | 14 min ago |
| carol | fix/price-rounding | checkout-carol.pim.adobe.com | Idle | 1 hr ago |

Tunnel state is stored in a `pim-tunnels` DynamoDB table with a GSI on `pod_id`, so the dashboard query is a single indexed lookup — not a full-table scan.

### Developer experience

```bash
npx pim tunnel start --pod checkout-redesign --port 3000
```

The CLI:
1. Authenticates via Adobe IMS (cached token; browser-based IMS login flow on first run).
2. Registers the tunnel in DynamoDB: `pod_id`, `dev_identity`, `branch_name`, `started_at`.
3. Opens an outbound WebSocket to API Gateway.
4. Prints the stable URL.
5. Sends a context update to PIM: "Tunnel active — alice: feat/cart-summary at checkout-alice.pim.adobe.com."

No infra setup required per team. The org deploys the CDK stack once; any pod uses it immediately.

---

## 5. Pillar 2 — The PIM Brain (Orchestrator + Committee)

### Core loop

```
Agent does work
       │
  POST /api/pods/{podId}/context-updates
  (schema-validated, secret-scanned at ingestion Lambda)
       │
  PIM orchestrator receives delta
       │
  Deterministic routing → appropriate Committee agent
       │
  Committee agent processes → returns structured result
       │
  PIM orchestrator applies result to DynamoDB
       │
  Summary Agent re-renders living doc (.md) → S3
       │
  WebSocket broadcast to all connected agents/UI clients
       │
  Agents pull updated context before next action
```

### Why the orchestrator is deterministic, not agentic

This is the most important architectural decision in the system. The PIM orchestrator does **no reasoning**. Its job is routing, gating, and state application — not analysis.

Why: an agentic orchestrator holding a large context window would be slow (every decision involves an LLM call), expensive (LLM cost on every incoming update), and unpredictable (reasoning quality degrades as context grows). By contrast, a deterministic router is fast, auditable, and scales to any throughput.

All LLM reasoning is delegated to Committee agents with **scoped context windows** — each Committee member only loads the slice of state it needs for its specific job. A Conflict Agent analyzing C-007 doesn't need the full living doc — it needs the two conflicting updates, the affected spec section, and any prior conflict precedents from the knowledge graph.

```
PIM orchestrator (Orchestrator — Lambda, no LLM)
    │
    ├── Merge Agent (Haiku)
    │   Handles additive, non-overlapping updates.
    │   ~60% of all updates never need an LLM — pure deterministic merge.
    │   Haiku handles the ~30% that are routine but need light reasoning.
    │
    ├── Conflict Agent (Sonnet)
    │   Detects contradictions. Creates conflict records with full attribution.
    │   Queries the knowledge graph for historical precedents before analysis.
    │   Runs conflict alignment analysis: for each pending update,
    │   what is the rework cost under each possible resolution outcome?
    │
    ├── Summary Agent (Haiku)
    │   Re-renders the living doc from DynamoDB state.
    │   Runs a lint pass every 2 hours (EventBridge scheduled Lambda).
    │   Pattern-scans the rendered doc for secrets before every S3 write.
    │
    ├── Cross-Pod Agent (Haiku)
    │   Advisory only. Reads the org-level context registry to detect
    │   when an update in this pod may affect another pod's scope.
    │   Non-blocking. Cannot create conflicts in another pod.
    │
    └── Knowledge Extraction Agent (Sonnet + Haiku for edges)
        Runs once at pod archival. Distills durable learnings from
        decisions log, resolved conflicts, and final living doc.
        Outputs EnhancedPodLearning[] with confidence levels and domain tags.
```

### Context update schema

Every agent contribution must match this schema, validated at ingestion:

```yaml
context_update:
  agent_id: "fe-agent-01"
  timestamp: "2026-04-02T14:32:00Z"
  pod_id: "pod-checkout-redesign"
  type: progress | blocker | spec_change | question | decision
  scope: frontend | backend | design | qa | infra | pm
  summary: "Implemented cart summary component with live price calculation"
  details: |
    - Component: CartSummary.tsx
    - Reads from useCartStore hook
    - Open question: should discounts show strikethrough or separate line?
  artifacts:
    - type: component
      path: src/components/CartSummary.tsx
    - type: screenshot
      url: https://tunnel.pod.dev/checkout/cart
  status: completed | in_progress | blocked
  blocks: []
  blocked_by: []
  needs_input_from:
    - role: design
      question: "Discount display preference?"
```

Structure is not optional — it is what makes automatic merge and conflict detection possible. Unstructured text (Slack messages, Confluence pages) cannot be semantically merged or conflict-detected without an expensive full-context LLM pass on every update.

### The living doc

The living doc is a **read-only output** assembled by the Summary Agent from DynamoDB state. No one edits it directly. This is the central architectural discipline that keeps the system coherent:

- There is no edit conflict on the document itself because no one writes to it.
- The canonical state is always in DynamoDB — versioned, queryable, attributable.
- The `.md` is a projection of that state, not a source of truth.
- Any agent or human who wants to influence the doc does so by submitting a context update to PIM. The orchestrator processes it, and the Summary Agent re-renders.

This is analogous to event sourcing: the document is the read model, the context updates are the events, DynamoDB is the event store.

### Conflict Pressure System

Open conflicts degrade the orchestrator's ability to do confident semantic merging. Every unresolved conflict represents an ambiguous fork in the spec. New updates that touch contested areas must be held until the fork is resolved — otherwise the orchestrator is merging against an unknown ground truth.

The Conflict Pressure score (0.0–1.0) quantifies this degradation and gates ingestion behavior:

| Pressure | Mode | Behavior |
|---|---|---|
| 0.0–0.3 | **Normal** | Auto-merge freely. Business as usual. |
| 0.3–0.6 | **Cautious** | Merges that touch areas near open conflicts get a disclaimer flag. Still merged. |
| 0.6–0.8 | **Degraded** | Auto-merge halted for anything touching contested areas. Updates held in pending queue. |
| 0.8–1.0 | **Critical** | Context intake still accepted (validation + secret scan run). PIM orchestration paused. Incoming updates written to `ingestion_queue`, replayed automatically when pressure drops below 0.8. Escalation fires to Slack if queue grows past backlog threshold. |

**Pressure calculation:**
- Each open conflict adds base pressure (blocking > non-blocking).
- Pressure increases over time — a 36-hour-old unresolved conflict weighs more than a 1-hour-old one.
- Conflicts touching high-dependency areas (shared data models, API contracts) apply a multiplier.
- Resolved conflicts reduce pressure immediately.

**Escalation ladder (compressed for 5-day pods):**
- Created → ping contributors immediately (PIM UI + Slack).
- Unresolved >4h → re-ping, mark urgent.
- Unresolved >8h → escalate to pod lead.
- Unresolved >16h → escalate to eng manager.
- Unresolved >24h → pod health forced to critical regardless of pressure score. In a 5-day sprint, 24h = 20% of total sprint time burning.

**Agent behavior under pressure:** Agents are warned with full conflict context but NOT blocked. If they proceed, their completed work is tagged with a presumption label (`"This update assumes C-007 resolves in favor of Position A"`) and the Conflict Agent runs a rework cost analysis. Humans see this in the UI alongside the conflict. The system surfaces information — it does not make decisions for humans.

### Proactive lint pass

Beyond reactive conflict detection, the Summary Agent runs a proactive **lint pass every 2 hours** (EventBridge scheduled Lambda) scanning the full DynamoDB state for problems that no one has explicitly reported:

| Finding type | What it catches |
|---|---|
| **Staleness** | An area/agent hasn't reported in an unusually long time relative to pod pace. |
| **Implicit assumption** | An agent's work depends on something that was never formally decided. |
| **Coverage gap** | A milestone item has no owner or no reported progress. |
| **Dependency risk** | Multiple agents touching the same system without explicit coordination. |
| **Spec drift** | Agent work references concepts not present in the current spec. |

Lint findings are advisory — they don't create conflict records or affect the pressure score. But if a lint finding goes unaddressed and becomes an actual conflict, the Conflict Agent references it: "This conflict was flagged as a dependency risk 6 hours ago." This creates an accountability loop.

**Cost of lint pass:** A single Haiku-class call reading current DynamoDB state. At 2-hour intervals over a 5-day pod, that is ~60 calls — approximately $0.30 total.

### MCP server integration

PIM ships an MCP server (`@pim/mcp-server`) that exposes all PIM operations as MCP tools. This means any Claude Code agent or IDE-integrated agent can call `submit_context_update`, `get_agent_session_context`, `list_conflicts`, `resolve_conflict`, and `query_knowledge` natively — without any SDK installation. The MCP server is the integration path for agents that can't or don't want to install `@pim/sdk`.

---

## 6. Pillar 3 — PIM UI

The PIM UI is a React + Adobe Spectrum 2 SPA running against the same REST + WebSocket API. It is the human control plane for a pod. It provides:

- **Pod Dashboard** — live status table by area/agent, active tunnel list, conflict count, Conflict Pressure gauge.
- **Conflict Center** — full conflict records with both positions, the orchestrator's impact analysis, and one-click resolution that writes back to PIM.
- **Live Doc View** — real-time rendered living doc, updating via WebSocket. No page refresh required.
- **Knowledge Graph browser** — the org's accumulated learnings, filterable by domain, type, and confidence level. Humans can approve, reject, or edit inferred learnings before they enter the graph.
- **Org Dashboard** — cross-pod health overview. See all active pods, their conflict pressure scores, and whether any cross-pod scope overlaps are active.

The UI is purely a surface — it writes to PIM via the same REST API that agents use. There is no UI-specific backend. This means every action a human takes in the UI is also something an agent can do programmatically.

---

## 7. Knowledge Graph — Persistent Org Memory

### The problem with ephemeral pods

Without a compounding mechanism, every new pod starts from zero context. Teams re-discover the same architectural answers, re-debate the same tradeoffs, and re-resolve the same classes of conflict. The org accumulates no institutional memory from its agentic workflows.

PIM solves this at pod archival time.

### Extraction pipeline

When a pod is archived via `POST /api/pods/{podId}/archive`:

1. **Deterministic extraction** (confidence: 0.9) — The Knowledge Extraction Agent reads the decisions log, resolved conflicts, and blocker records directly from DynamoDB. These are facts with full source attribution — no LLM needed.

2. **LLM-enhanced extraction** (confidence: 0.4–0.85, Sonnet) — The agent runs an optional enrichment pass: inferring broader patterns from the pod's conflict resolution history, identifying anti-patterns from blockers, and noting scope-specific insights ("discount logic was consistently underestimated").

3. **Edge generation** (Haiku) — Relationships between new learnings and existing knowledge graph nodes are computed via keyword overlap + type-specific rules, optionally enriched by LLM.

4. **Community detection** — Label propagation clustering identifies communities of related learnings (e.g., "all state management decisions across 8 pods").

5. **Persistence** — Full graph snapshot written to versioned S3. DynamoDB tables indexed by `type`, `domain`, and `confidence_score` for fast queries.

### Graph structure

```
Nodes:
  - decision        (e.g., "Zustand chosen over Redux for cart state")
  - pattern         (e.g., "Formalize API contracts before parallel FE+BE work")
  - anti_pattern    (e.g., "Starting parallel work without API contract → 2 blocking conflicts")
  - resolved_conflict
  - scope_insight   (e.g., "Discount logic: allocate 1.5x estimated time")

Edges:
  - relates_to
  - supersedes      (a newer decision supersedes an older one in the same domain)
  - contradicts
  - builds_on
  - resolved_by

Communities: label propagation clusters of related learnings
Hubs: high-degree nodes = key organizational patterns
```

### Token-budgeted queries

Agents never see the full graph. They call `getRelevantLearnings(maxTokens)` and the server returns the highest-value subset that fits the budget:

```typescript
// From @pim/sdk — agent calls this before starting work
const learnings = await client.getRelevantLearnings(2000, {
  projectId: pod.project_id,
  query: pod.milestone?.name,   // semantic scoring via embedding
});
// Returns: { nodes, edges, total_matching, token_estimate, truncated }
```

The server filters by domain match, ranks by confidence score and relevance (keyword + optional embedding similarity), and truncates to the token budget. An agent working on checkout-related frontend work will get learnings tagged `[frontend, state_management]` and `[checkout, payments]` — not the entire org knowledge base.

**Why this matters architecturally:** Without token budgets, knowledge retrieval is binary — dump everything or dump nothing. Dumping everything bloats agent context windows and degrades reasoning quality. Dumping nothing wastes the graph entirely. Token-budgeted ranked retrieval is the correct middle path.

### Human curation

Not all LLM-inferred learnings are correct. The Knowledge Graph UI (`/knowledge`) lets humans review inferred learnings before they propagate to future pods:

- **Approve** — learning enters the graph with `human_verified: true`
- **Reject** — learning is discarded
- **Edit** — human corrects the learning; it enters as `human_edited: true`

Deterministically extracted learnings (from DB facts) enter with `confidence: 0.9` and don't require review, though humans can edit them.

---

## 8. Security Model

Security is built in at three independent checkpoints, not added as an afterthought.

### Checkpoint 1 — Ingestion Lambda (deterministic pattern scan)

Every context update passes through a secret scan before entering DynamoDB. The scan uses deterministic regex patterns for:
- AWS access keys (`AKIA[0-9A-Z]{16}`)
- AWS secret keys
- JWT tokens (`eyJ[A-Za-z0-9-_]+\.eyJ[A-Za-z0-9-_]+\.`)
- Common connection string patterns (PostgreSQL, MySQL, Redis, MongoDB)
- Generic high-entropy strings that match private key headers

If a match is found, the update is rejected with a 422 and a sanitized error message — the matched pattern is not reflected back in the error. The agent receives: "Context update rejected: potential secret detected. Remove sensitive values before resubmitting."

This checkpoint runs on 100% of context updates, regardless of downstream processing path.

### Checkpoint 2 — LLM system prompts

All Committee agent system prompts include an explicit instruction: **never output secrets, credentials, API keys, passwords, or connection strings in any response**. This applies regardless of what appears in the context window passed to the agent. Even if a secret somehow passed Checkpoint 1, the LLM would refuse to reproduce it in its output.

This is defense-in-depth against prompt injection: a malicious context update crafted to trick the Conflict Agent into repeating a stored secret in its analysis output would hit this guardrail.

### Checkpoint 3 — Summary Agent pre-write scan

Before the Summary Agent writes any content to S3 (the living doc), it runs the same deterministic pattern scan used at ingestion. If a match is found, the write is aborted and an alert fires. The previous living doc version remains on S3 unmodified.

S3 buckets are versioned with `RemovalPolicy.RETAIN` (defined in `packages/infra/lib/pim-stack.ts`), so any accidental write can be rolled back to a prior version.

### Auth

All API endpoints require Adobe IMS authentication. The server creates an auth hook (`packages/server/src/middleware/auth.ts`) that runs on every non-public route, validating IMS JWTs. Public paths (`/api/health`, `/api/cli-config`, WebSocket upgrades, tunnel proxy URLs with per-tunnel `share_token`) are explicitly allowlisted — everything else requires authentication.

Tunnel URLs are protected by the same IMS token at the proxy layer. External stakeholders (non-IMS users) access tunnel URLs via a per-tunnel `share_token` in the path, which is time-limited and revocable.

---

## 9. Cost Model

LLM cost is the primary variable cost in this system. The architecture is explicitly tiered to minimize LLM usage:

| Category | Frequency | Model | Why |
|---|---|---|---|
| Additive, non-overlapping updates | ~60% of all updates | **No LLM** | Deterministic merge. FE agent reports a new component while BE agent reports a new endpoint. Zero reasoning needed. |
| Routine updates (non-conflicting, same area) | ~30% of all updates | **Haiku** | Light reasoning needed to confirm compatibility, add merge notes. |
| Conflict detection + analysis | ~10% of all updates | **Sonnet** | Contradictions require nuanced analysis, impact assessment, knowledge graph querying for precedents. |
| Lint pass | Every 2 hours | **Haiku** | Single structured pass over current pod state. |
| Knowledge extraction | Once per pod lifecycle | **Sonnet + Haiku** | Sonnet for insight extraction, Haiku for edge generation. |

**Per-pod cost estimate (5-day pod, 5 agents):**

Assuming 100 context updates per day × 5 days = 500 updates:
- 300 deterministic merges: $0.00
- 150 Haiku routine merges: ~$0.30
- 50 Sonnet conflict analyses: ~$2.50
- 60 lint passes (Haiku): ~$0.30
- Knowledge extraction (Sonnet): ~$0.05–0.15

**Total: ~$3.15–$3.25 per pod**, well within the $5–8 target. The model is predictable and scales linearly — a pod with twice as many agents producing twice as many updates costs roughly twice as much. There is no quadratic scaling lurking in the architecture.

---

## 10. Infrastructure Model

The full AWS stack is defined in `packages/infra/lib/pim-stack.ts` as a CDK stack — one `cdk deploy` provisions the entire org infrastructure. There is no per-pod provisioning.

**Compute:** Entirely serverless Lambda. No persistent EC2. No idle compute cost.

**DynamoDB tables provisioned:**

| Table | Key | GSIs | Purpose |
|---|---|---|---|
| `pim-pods` | `pod_id` | — | Pod metadata |
| `pim-context-updates` | `id` | `pod-timestamp-index` | Context update stream |
| `pim-conflicts` | `id` | `pod-status-index` | Conflict records |
| `pim-knowledge-nodes` | `id` | `type-confidence-index` | Knowledge graph nodes |
| `pim-living-docs` | `pod_id` | — | Living doc metadata |
| `pim-tunnels` | `tunnel_id` | `pod-index` | Active tunnel registry |
| `pim-org-summaries` | `pod_id` | — | Cross-pod context registry |

All tables use `PAY_PER_REQUEST` billing — no capacity planning required. All are `RETAIN` on stack removal, protecting against accidental data loss.

**S3 buckets:**

- `pim-living-docs-{account}` — versioned, S3-managed encryption. Living doc history is never deleted.
- `pim-knowledge-graph-{account}` — versioned, S3-managed encryption. Full graph snapshots.
- `pim-ui-{account}` — SPA hosting, served via CloudFront.

**Scheduled Lambdas (EventBridge):**

- `EscalationSchedule` — every 5 minutes, checks for unresolved conflicts past escalation thresholds.
- `LintSchedule` — every 2 hours, runs the proactive lint pass.

**Networking:** API Gateway handles all HTTP + WebSocket. CloudFront fronts both the UI and the REST API (`/api/*` passes through, cache disabled). No VPC required.

**Zero per-pod ops:** Org deploys once. Any team creates a pod via `pim pod create` and immediately has access to tunneling, conflict detection, living docs, and knowledge graph queries. No infra tickets, no platform team involvement per pod.

---

## 11. What Is Already Built

This is not a proposal — it is a running system. As of April 2026:

**Backend (`packages/server`):**
- Fastify server with full route coverage: pods, projects, context updates, conflicts, living doc, knowledge graph, tunnels, org config, context search.
- SQLite for local dev with the same schema as the DynamoDB production target.
- WebSocket broadcast (`/ws`) — real-time updates to all connected clients on every state change.
- WebSocket tunnel proxy (`/ws-tunnel`, `/tunnel/`) — full tunnel implementation serving local dev traffic.
- PIM orchestrator with all 5 Committee agents implemented: Merge, Conflict, Summary, Cross-Pod, Knowledge Extraction.
- Proactive lint pass (Summary Agent, runs on schedule).
- Escalation service — checks and fires time-based escalation per the ladder.
- Knowledge graph service with community detection, confidence scoring, token-budgeted queries.
- Auth middleware supporting IMS JWT verification and a dev trust mode.
- Org-context middleware for multi-org request scoping.
- Rate limiting (100 req/min global, configurable per route).
- Structured error handling — no stack traces exposed to clients.

**SDK (`packages/sdk`):**
```typescript
// Full API surface shipped:
client.report(input)                    // submit context update
client.getContext()                     // fetch living doc markdown
client.getPod()                         // fetch pod state
client.getConflicts()                   // fetch active conflicts
client.getRelevantLearnings(maxTokens)  // token-budgeted knowledge query
client.getPrecedents(conflictSummary)   // historical conflict precedents
client.pullSessionContext()             // bundled: pod + doc + conflicts + learnings
client.searchContext(query)             // cross-source: Slack, Jira, Confluence, GitHub, git
```

**CLI (`packages/cli`):**
- `pim pod create / list / join / leave`
- `pim tunnel start / stop / list`
- `pim context` — pull and display session context in terminal
- `pim report` — submit a context update from CLI
- `pim hooks install` — install git hooks that auto-report to PIM on commit
- `pim search` — semantic context search across external sources
- Adobe IMS auth flow (browser-based, token cached)

**MCP Server (`packages/mcp-server`):**
- Full set of MCP tools: `submit_context_update`, `get_agent_session_context`, `list_pods`, `get_conflict`, `resolve_conflict`, `query_knowledge`, `list_tunnels`, and more.
- Runs alongside Claude Code — agents can call PIM without any SDK installation.

**UI (`packages/ui`):**
- Pod Dashboard, Conflict Center, Live Doc View, Knowledge Graph browser, Org Dashboard — all views implemented.
- WebSocket real-time updates.
- IMS authentication flow.
- Spectrum 2 design system throughout.

**Infra (`packages/infra`):**
- Full CDK stack: all DynamoDB tables with GSIs, S3 buckets, Lambda functions, API Gateway (REST + WebSocket), CloudFront distribution, EventBridge scheduled rules.
- EC2 variant stack for orgs that prefer a persistent server deployment.

**Running locally:** Server on `:4000`, UI on `:5173`.

---

## 12. Anticipated Architect Questions

### "Why not just use an existing agent orchestration framework (LangGraph, CrewAI, AutoGen)?"

Those frameworks are designed for orchestrating LLM reasoning pipelines — chains of AI calls producing a final output. PIM solves a different problem: coordinating the outputs of independent agents (which may use any framework or no framework) that are working in parallel over days, not seconds. PIM is the coordination layer above and orthogonal to any reasoning framework. An agent running CrewAI can call `pim report` at the end of a task.

Additionally, none of those frameworks have: conflict detection with human escalation, a persistent knowledge graph with pod lifecycle management, FE tunneling for stakeholder feedback, or Slack integration tied to sprint escalation ladders. PIM is purpose-built for Adobe's pod model.

### "Why not build this on top of an existing event streaming platform (Kafka, EventBridge alone)?"

Event streaming handles event routing — it doesn't do semantic merge, conflict detection, or living doc synthesis. PIM uses EventBridge for scheduled tasks (lint pass, escalation check) exactly where it's appropriate. The context update flow runs through API Gateway + Lambda + DynamoDB, not a streaming topic, because the processing of each update is stateful — it requires reading existing DynamoDB state (open conflicts, current living doc, pod scope) to decide whether to merge or escalate. Streaming systems are designed for stateless event processing; PIM's core logic is inherently stateful.

### "Why SQLite locally instead of a local DynamoDB emulator?"

DynamoDB Local requires Docker and has subtle behavioral differences from the production service (especially around GSI consistency). SQLite with a matching schema is faster to spin up, zero-dependency, and sufficient for the local development and testing use case. The production path is DynamoDB via CDK — the schema is the same, the query patterns are validated in CI. This is a developer experience trade-off, not an architectural one.

### "What's the failure mode if PIM is down?"

Agents can continue working. PIM unavailability means agents can't report context updates and can't pull the living doc. Work doesn't stop — it just becomes unsynchronized, which is the pre-PIM baseline. When PIM comes back, agents resubmit any missed updates. The context update schema includes a `timestamp` field so the orchestrator can reconstruct the correct ordering from the submission time, not the receipt time.

The ingestion queue (active in degraded/critical mode) is replay-capable: all queued updates are held in DynamoDB and processed in order once the system unblocks. Nothing is dropped.

### "What happens to the knowledge graph over time as the org accumulates more pods?"

The graph grows incrementally — one pod's learnings are a bounded addition. Token-budgeted queries mean agent context windows never grow with the graph; they always get a fixed-size, relevance-ranked slice. The server loads the graph into memory on startup (from the S3 snapshot), and community detection clusters it so queries can be scoped to a community rather than the full graph. High-degree hub nodes (organizational patterns referenced by many pods) naturally surface to the top of relevance rankings. The graph is designed to get more useful, not more expensive, as it grows.

### "Why DynamoDB and not PostgreSQL/RDS?"

For the production deployment: no capacity planning, no connection pooling management, no database server to patch or scale. All access patterns in PIM are key-value or GSI lookups — there are no complex relational joins. The DynamoDB `PAY_PER_REQUEST` billing model means zero idle cost between pods. RDS would add a persistent server cost, maintenance overhead, and operational complexity for a use case that doesn't require relational semantics.

For local dev: SQLite sidesteps the RDS vs DynamoDB question entirely and gives developers an instant-on zero-config experience.

### "Why build the living doc as markdown on S3 rather than a structured API response?"

The living doc markdown is the human-readable surface of the canonical DynamoDB state. Markdown is universally renderable — in the PIM UI, in Slack messages, in agent context windows, in email notifications. A structured API response would require every consumer (agents, humans, Slack bots) to implement their own rendering logic. Markdown is the lingua franca.

S3 versioning gives us a complete history of every living doc snapshot — useful for debugging and for understanding how a pod's ground truth evolved over time.

### "How does PIM handle a malicious or malfunctioning agent submitting junk context updates?"

Three layers:

1. **Schema validation at ingestion** — updates that don't match the Zod schema are rejected 422 before they reach the orchestrator or DynamoDB.
2. **Rate limiting** — 100 req/min global (configurable per route). A runaway agent can't flood the system.
3. **Attribution on every update** — every context update carries `agent_id` and `timestamp`. If an agent submits problematic data, it can be identified, its updates filtered from the living doc view, and the DynamoDB records corrected. Nothing is irrevocably merged — the living doc is always re-derivable from the corrected DynamoDB state.

Conflict detection also acts as a natural filter: if a malfunctioning agent submits updates that contradict established decisions, the Conflict Agent will surface this immediately with full attribution, alerting humans before it affects other agents' work.
