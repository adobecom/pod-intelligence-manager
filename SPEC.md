# AI Council System — Living Doc

> **Status:** v1 Spec Complete — Ready for Implementation Planning
> **Last Updated:** 2026-04-03
> **Pod Lifecycle:** 5-day sprints (3-4 days dev, 1-2 days QA/polish)
> **Infrastructure:** AWS-only
> **Auth:** Adobe IMS
> **Design System:** Adobe Spectrum 2
> **Context:** Adobe internal tool — stack decisions are recommendations that yield to org-level mandates

---

## 1. Vision

An **AI Council** is the connective tissue of a cross-functional pod. It is a persistent, living orchestration layer that ensures every agent (AI or human) contributing to a project shares one source of truth — automatically, in real time, with zero manual sync overhead.

The system has three pillars:

| Pillar | Core Idea |
|---|---|
| **FE Tunneling** | Expo-style localhost tunneling so anyone can visit a dev's running app remotely. Multiple tunnels per pod. |
| **AI Council (Brain)** | An autonomous context bus with a Council Master orchestrator and specialized Committee agents. Maintains a canonical read-only living doc. |
| **Council UI (Surface)** | A Spectrum 2 dashboard where all pod members observe progress, contribute context by talking to the Council, and resolve conflicts. |

---

## 2. Pillar 1 — FE Tunneling

### Problem
Feature branches live on local machines or behind CI gates. Designers and PMs can't see progress until a deploy or screen-share, and they never know which deployed link is up-to-date. Feedback loops are slow and asynchronous in the worst way.

### How It Works (Expo-Style Tunneling on AWS)

The mental model is Expo's tunnel mode: a dev runs their local dev server, a CLI command exposes it to a stable remote URL, and anyone with the link can interact with the live app — no deploy needed.

**Architecture:**
```
Dev's localhost:3000
       │
  Council CLI (tunnel start)
       │
  WebSocket/HTTP tunnel client
       │  ── outbound connection (no port forwarding needed) ──
       ▼
  AWS API Gateway (WebSocket API)
       │
  Lambda@Edge / Lambda (connection broker)
       │
  Route: {pod-id}-{dev-alias}.council.{org}.aws
       │
  ──► Proxied back to dev's localhost in real time
```

**AWS Services Used:**
- **API Gateway (WebSocket API)** — Persistent connection endpoint. Each tunnel is a WebSocket session.
- **Lambda** — Connection broker that maps incoming HTTP requests to the correct dev tunnel session.
- **Route 53** — Stable subdomain routing: `{pod}-{dev}.council.yourdomain.com`
- **DynamoDB** — Tunnel registry: tracks which dev tunnels are live, their pod, branch, and health status.
- **CloudFront** — CDN layer in front of API Gateway for the tunnel URLs.
- **Cognito** — Auth for tunnel URLs. Pod members get access automatically; external stakeholders via invite link.
- **ACM** — Wildcard cert on `*.council.{org}.com`, auto-provisioned, zero config per tunnel.

### Multi-Tunnel Support

Multiple FE devs can tunnel simultaneously. Each gets their own stable URL:

```
checkout-redesign-alice.council.acme.com  ← Alice's local branch
checkout-redesign-bob.council.acme.com    ← Bob's local branch
checkout-redesign-carol.council.acme.com  ← Carol's local branch
```

The Council UI shows a **tunnel dashboard** listing all active tunnels for the pod:

| Dev | Branch | URL | Status | Last Activity |
|-----|--------|-----|--------|---------------|
| Alice | feat/cart-summary | [link] | 🟢 Live | 2 min ago |
| Bob | feat/checkout-flow | [link] | 🟢 Live | 14 min ago |
| Carol | fix/price-rounding | [link] | 🟡 Idle | 1 hr ago |

### Developer Experience (Plug & Play)

Starting a tunnel should be one command:

```bash
npx council tunnel start --pod checkout-redesign --port 3000
```

The CLI:
1. Authenticates via Adobe IMS (cached token, or prompts browser-based login on first run).
2. Registers the tunnel in DynamoDB with pod ID, dev identity, branch name.
3. Opens outbound WebSocket to API Gateway (works behind NAT/firewalls, no port forwarding).
4. Prints the live URL.
5. Council Master is automatically notified → logs "tunnel active" in the living doc context stream.

**No infra setup required by the team.** The org deploys the Council infra stack once (CDK), and any pod just uses it.

### Key Design Decisions (Resolved)

- **Latency:** 200ms is acceptable. The tunnel is for designers/PMs to observe real-time progress, not for the dev's own workflow. No regional edge nodes needed.
- **Asset handling:** Tunnel everything through the WebSocket connection as-is. The dev's local bundler already serves optimized dev builds. No S3/CloudFront asset splitting — it adds complexity for a marginal gain that reviewers won't notice.
- **HTTPS:** Wildcard cert on `*.council.{org}.com` via ACM, attached to the CloudFront distribution / API Gateway custom domain. Auto-provisioned, zero config per tunnel.
- **Tunnel health:** Heartbeat every 60 seconds from the CLI client. A tunnel is marked **idle** (yellow in the dashboard) after 20 minutes of no HTTP requests flowing through it. A tunnel is **disconnected** only if the heartbeat stops (dev closes laptop, kills terminal, network drops). We do NOT auto-disconnect idle tunnels — in AI pod workflows, a dev might be waiting 15+ minutes for code generation with no localhost changes, but the tunnel should stay up so reviewers can still access the last-served state. Tunnels are cleaned up only on explicit `council tunnel stop`, terminal exit, or heartbeat failure.
- **State injection:** Out of scope for v1.
- **Multi-device / responsiveness:** Not a tunneling concern. The tunnel serves whatever the dev's localhost serves.

### Decided Out of Scope (v1)
- ~~Embed tunnel preview inside Council UI~~ — Nice-to-have, revisit post-v1.
- ~~Auto-record visual diffs~~ — Token cost too high for the Council Master to process screenshots on every push.
- ~~Side-by-side tunnel comparison~~ — Users can open two browser tabs if needed.

### Future Exploration: Annotation Layer on Live Preview
> *Flagged as interesting but not v1.*

The idea: reviewers visiting a tunnel URL see a floating toolbar that lets them click any element on the page and leave a comment, anchored to that DOM node. Think Figma comments but on the live running app.

How it would work:
- The Council CLI injects a lightweight script tag into the tunneled response (a ~5KB overlay).
- Clicking "annotate mode" dims the page and makes elements hoverable/clickable.
- A comment is saved with a CSS selector path + viewport coordinates + screenshot snippet of the target area.
- Comments are posted to the Council as context updates (type: `feedback`, scope: `design` or `qa`).
- The Council Master includes them in the living doc under a "Review Feedback" section.
- The dev sees the comments as a list in their terminal (via CLI) or in the Council UI.

---

## 3. Pillar 2 — AI Council (The Brain)

### 3.1 Core Loop

```
Agent does work ──► Agent reports context delta to Council
                              │
                    Council Master receives delta
                              │
                    Master routes to appropriate Committee agent
                              │
                    Committee agent processes + returns result
                              │
                    Master applies result to DynamoDB state
                              │
                    Summary Agent re-renders living doc (.md) → S3
                              │
                    Master broadcasts updated context to all agents
                              │
                    Agents fetch latest context before next action
```

### 3.2 Council Master — Responsibilities

The Council Master is a dedicated lightweight orchestrator. It does NOT do feature work and does NOT hold large context windows. Its job:

1. **Receive** — Accept context updates from any agent or human.
2. **Route** — Delegate processing to the appropriate Committee agent (Merge, Conflict, Summary, Cross-Pod).
3. **Apply** — Write Committee agent results to DynamoDB.
4. **Broadcast** — Notify relevant agents/humans when context changes materially.
5. **Gate-keep** — Enforce org-level permissions. Validate that spec changes and conflict resolutions come from authorized roles.

### 3.3 Context Schema

Every context update from an agent should carry:

```yaml
context_update:
  agent_id: "fe-agent-01"
  timestamp: "2026-04-02T14:32:00Z"
  pod_id: "pod-checkout-redesign"
  type: progress | blocker | spec_change | question | decision
  scope: frontend | backend | design | qa | infra | pm
  summary: "Implemented cart summary component with live price calc"
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
  blocks: []           # IDs of items this blocks
  blocked_by: []       # IDs of items blocking this
  needs_input_from:
    - role: design
      question: "Discount display preference?"
```

### 3.4 Living Doc Structure

The living doc is a **read-only output** assembled from DynamoDB state by the Summary Agent. No one edits it directly — humans and agents alike contribute by talking to the Council (submitting context updates), and the doc reflects the current state.

```
# Pod: Checkout Redesign — Living Doc

## Pod Health
Conflict Pressure: 0.42 (Cautious) | Day 3 of 5 | Sprint: Apr 1–5

## Active Milestone
v0.1 — Cart + Summary Page (Target: Apr 4)

## Current Status
| Area       | Owner        | Status      | Last Update |
|------------|-------------|-------------|-------------|
| FE Shell   | fe-agent-01 | ✅ Done      | Apr 2       |
| Cart Logic | fe-agent-02 | 🔄 In Prog  | Apr 2       |
| API        | be-agent-01 | 🔄 In Prog  | Apr 1       |
| Design QA  | design-lead | ⏳ Waiting   | —           |

## ⚠️ Open Conflicts
- C-007: Discount display — fe-agent-01 vs design-lead [BLOCKING]
- C-009: Error msg wording — fe-agent-02 vs pm-lead [non-blocking]

## Decisions Log
- [Apr 1] Use Zustand for cart state (decided by: eng-lead)
- [Apr 1] API returns prices in cents (decided by: be-agent-01 + fe-agent-01)

## Spec (Current)
[Link to or inline the current agreed spec]

## Context Stream (Recent)
- [Apr 2 14:32] fe-agent-01: Implemented CartSummary component...
- [Apr 2 13:10] be-agent-01: /cart endpoint now returns discount metadata...
- [Apr 1 17:45] design-lead: Uploaded revised cart mockups v3...

## Active Tunnels
- 🟢 alice: feat/cart-summary → checkout-alice.council.acme.com
- 🟢 bob: feat/checkout-flow → checkout-bob.council.acme.com
```

### 3.5 Conflict Resolution Protocol

The Council Master encounters contradictions — two agents making incompatible assumptions, a design spec that conflicts with an engineering decision. The Master does NOT silently pick a winner. It operates on a **confidence threshold model**:

```
Incoming context delta
       │
  Council Master routes to Merge Agent
       │
  ┌────┴──────────────────────────┐
  │  Can I merge this confidently? │
  └────┬──────────────┬───────────┘
      YES              NO
       │                │
  Merge into           Route to Conflict Agent
  DynamoDB state       │
       │               Create Conflict Record
  Log decision         Identify contributors on each side
  with reasoning       │
                  Notify contributors
                  (Council UI + optional Slack)
                        │
                  Await human resolution
                        │
                  Human resolves → Master applies
                  resolution + logs in Decisions Log
```

**Confidence Threshold Rules:**
- **Auto-merge (high confidence):** Additive, non-overlapping updates. e.g., FE agent reports a new component while BE agent reports a new endpoint. No conflict.
- **Auto-merge with note (medium confidence):** Updates touch the same area but are compatible. e.g., two agents both reference the cart state shape consistently. Master merges and logs that it inferred compatibility.
- **Escalate to humans (low confidence):** Updates contradict each other, imply different assumptions about scope/spec, or change something another contributor depends on. Master does NOT merge — it creates a conflict record.

**Conflict Record Schema:**

```yaml
conflict:
  id: "C-007"
  pod_id: "pod-checkout-redesign"
  created_at: "2026-04-02T16:45:00Z"
  status: open | in_discussion | resolved
  severity: blocking | non_blocking
  summary: "Discount display: strikethrough vs. separate line item"
  sides:
    - contributor: "fe-agent-01"
      position: "Strikethrough on original price, net price below"
      context_update_id: "ctx-0042"
      timestamp: "2026-04-02T14:32:00Z"
    - contributor: "design-lead"
      position: "Separate 'You save $X' line item, no strikethrough"
      context_update_id: "ctx-0038"
      timestamp: "2026-04-02T11:15:00Z"
  master_analysis: |
    These approaches are mutually exclusive in the current CartSummary
    component layout. fe-agent-01 has already implemented strikethrough.
    design-lead's latest mockup v3 shows a separate line item.
    Merging either would invalidate the other's work.
  impact:
    - "fe-agent-01 may need to rework CartSummary.tsx"
    - "Blocks QA sign-off on cart milestone"
  resolved_by: null
  resolution: null
  resolution_date: null
```

### 3.6 Slack Integration for Conflict Escalation

When the Council Master creates a conflict record, it can optionally push a notification to a Slack channel via the Slack API.

**AWS Implementation:**
- **EventBridge rule** triggers on `conflict.created` events.
- **Lambda** formats the Slack message and calls the Slack Web API (`chat.postMessage`).
- **Secrets Manager** stores the Slack Bot OAuth token.

**Slack Message Format:**

```
🔴 New Conflict in Pod: Checkout Redesign

C-007: Discount display approach [BLOCKING]

@alice (fe-agent-01) says: Strikethrough on original price
@dana (design-lead) says: Separate "You save" line item

Council Master's take:
> Approaches are mutually exclusive. One side's work
> will need revision. Blocks QA sign-off.

→ Resolve in Council UI: [link]
  or react here:
  :one: Strikethrough   :two: Separate line   :three: Need to discuss
```

**Slack Resolution Flow (Optional Enhancement):**
- If a tagged person reacts with an emoji vote, Lambda picks it up via Slack Events API.
- If consensus is reached (e.g., both parties pick the same option), the Council Master auto-resolves the conflict and merges the decision into the living doc.
- If reactions conflict or someone picks `:three:`, the Master keeps it open and suggests a sync.
- All Slack interactions are logged back into the context stream so nothing is lost outside the system.

### 3.6.1 Conflict Accumulation & Council Health

**The Problem:**
Open conflicts aren't just a backlog — they're **ambiguity in the spec**. Every unresolved conflict means the Master doesn't know which version of reality is true. When a new context update arrives, the Master has to reason about whether it depends on, assumes, or is affected by any open conflict. With N open conflicts, the reconciliation complexity grows combinatorially — the Master can't confidently place new updates against a spec that has multiple contested forks.

At some threshold, the Master's ability to do its core job — confident semantic merging — degrades to the point where it either:
1. Starts escalating *everything* as a conflict (because nothing is safe to auto-merge against an ambiguous spec), or
2. Makes bad merges by guessing which side of an open conflict the new update assumes.

Both are failure modes. The system jams.

**Solution: Conflict Pressure System**

The Council tracks a **conflict pressure score** — a health metric for the pod:

```yaml
council_health:
  pod_id: "pod-checkout-redesign"
  open_conflicts: 4
  blocking_conflicts: 2
  oldest_unresolved: "36 hours"
  conflict_pressure: 0.72    # 0.0 (clean) → 1.0 (critical)
  status: degraded            # healthy | degraded | critical
  ingestion_mode: cautious    # normal | cautious | paused
```

**Pressure Calculation:**
- Each open conflict adds base pressure (blocking = more than non-blocking).
- Pressure increases over time — a 1-hour-old conflict weighs less than a 12-hour-old one.
- Conflicts that touch high-dependency areas (e.g., shared data models, API contracts) weigh more.
- Resolved conflicts reduce pressure immediately.

**Ingestion Mode Tiers (Calibrated for 5-Day Pod Sprints):**

| Pressure | Mode | Master Behavior |
|---|---|---|
| 0.0–0.3 | **Normal** | Auto-merge with full confidence. Business as usual. |
| 0.3–0.6 | **Cautious** | Master adds disclaimers to merges that touch areas near open conflicts. Flags potential entanglement but still merges. |
| 0.6–0.8 | **Degraded** | Master stops auto-merging anything that could be affected by an open conflict. New updates in contested areas are held in a **pending queue** with a note: "Cannot merge until C-007, C-012 are resolved." |
| 0.8–1.0 | **Critical / Paused** | Master pauses all non-trivial ingestion. Posts an urgent alert to Council UI + Slack: "Pod checkout-redesign is blocked. X conflicts must be resolved before work can continue." |

**Escalation Ladder (Compressed for 5-Day Pods):**
- Conflict created → Ping contributors immediately (Council UI + Slack).
- Unresolved >4h → Re-ping contributors, mark as urgent.
- Unresolved >8h → Escalate to pod lead.
- Unresolved >16h → Escalate to eng manager + flag in org dashboard.
- Unresolved >24h → Mark pod health as critical regardless of pressure score. In a 5-day sprint, a 24h unresolved conflict means 20% of the pod's time is burning.

**What Happens in Degraded/Critical Mode:**
- Agents that submit updates in contested areas receive a **warning with full context** — which conflict their work touches, what the competing positions are, and what assumptions they'd be making by proceeding. The agent (and the developer driving it) decides whether to continue. The system does not block them.
- If the agent proceeds and reports completed work, the update is held in the pending queue with a **presumption tag**: "This update assumes conflict C-007 resolves in favor of Position A (strikethrough). If Position B is chosen, this work will need revision." The Council Master runs a **conflict alignment analysis** — a brief assessment of how much rework each pending update would require under each possible resolution.
- The living doc shows a visible health banner at the top:
  ```
  ⛔ COUNCIL HEALTH: CRITICAL (4 open conflicts, 2 blocking)
  Ingestion is paused for contested areas. Resolve conflicts to unblock.
  ```
- The Slack bot escalates to the pod lead / eng manager, not just the individual contributors.

**Automatic Pressure Relief Mechanisms:**
- **Auto-escalation ladder:** Conflict unresolved >4h → re-ping contributors. >8h → escalate to pod lead. >16h → escalate to eng manager. >24h → force critical status.
- **Suggested resolution:** The Master (or a committee member — see 3.8) can propose a resolution with reasoning ("Based on the current spec and 3 subsequent updates that assume strikethrough, I recommend adopting fe-agent-01's approach. design-lead's mockup v3 may need a revision."). Humans can accept with one click.
- **Conflict grouping:** If multiple conflicts stem from the same root disagreement (e.g., three conflicts all trace back to an ambiguous spec section), the Master groups them and presents a single root-cause decision that resolves all three.
- **Partial resolution:** Allow humans to resolve one side of a conflict to unblock progress, while leaving a follow-up for the full decision. ("Proceed with strikethrough for now. Revisit in design review Thursday.")

**Decided Design Questions:**
- **Pressure thresholds:** Bands stay as-is (0.3/0.6/0.8) but the escalation ladder is compressed for 5-day pod sprints. 4h/8h/16h/24h instead of 24h/48h/72h.
- **Agent behavior under pressure:** Agents are warned with full conflict context but NOT blocked. If they proceed, their completed work is tagged with presumption metadata and the Master runs a conflict alignment analysis showing rework cost per resolution outcome.
- **Conflict dependency graph:** Yes — delegated to a Council Committee sub-agent (see 3.8) to keep the Master's context window manageable.
- **Pressure visibility:** Visible to all — agents, humans, and the org dashboard. Full transparency.

### 3.7 Key Design Decisions
(Resolved — see 3.10)

### 3.8 Council Committee Architecture

The Council Master can't do everything in a single context window. As the living doc grows and conflict graphs get complex, we decompose the Master's responsibilities across **sub-agents** — the Council Committee.

```
                    Council Master (Orchestrator)
                    ├── Delegates, routes, owns DynamoDB state
                    │
        ┌───────────┼──────────────┬──────────────────┬──────────────────┐
        ▼           ▼              ▼                  ▼                  ▼
   Merge Agent   Conflict Agent  Summary Agent   Cross-Pod Agent   Knowledge
   │             │               │                │               Extraction
   Handles       Maintains       Keeps living     Handles          Agent
   semantic      conflict graph, doc readable,    inter-pod        │
   merging of    dependency      archives stale   context          Distills
   context       analysis,       context,         sharing          durable
   deltas        alignment       compresses                       learnings
                 analysis        history,                          from
                                 runs lint                         completed
                                 passes                            pods
```

**How it works:**
- The Master receives every incoming context update and routes it to the right committee member.
- Each committee member has a **scoped context window** — it only loads the portion of the living doc + state it needs for its job.
- Committee members return structured outputs to the Master, who applies them to DynamoDB.
- This is implemented as Lambda functions calling Bedrock/Claude with role-specific system prompts + scoped context.

**Example flow — new update arrives in a contested area:**
1. Master receives update from fe-agent-01.
2. Master checks conflict registry (DynamoDB lookup, not LLM reasoning) → sees C-007 is open in the same area.
3. Master routes to **Conflict Agent**: "Analyze this update against C-007. What does it assume? What's the rework cost?"
4. Conflict Agent returns: `{ presumption: "Position A", rework_if_B: "medium — CartSummary.tsx line 42-78 would need restructuring" }`
5. Master tags the update with this metadata, warns the agent, and holds it in pending.
6. No single agent needed to hold the full living doc + full conflict history + dependency graph in one context window.

### 3.9 Multi-Pod Context Sharing

Pods within the same org can share knowledge and context. If two pods run concurrently and touch related systems, they shouldn't operate in total isolation.

**How it works:**
- Each pod's Council Master registers its living doc scope in a shared **org-level context registry** (DynamoDB table scoped to the org).
- When a context update arrives that references a system or component owned by another pod, the **Cross-Pod Agent** detects the overlap and fetches a summary from the other pod's living doc.
- Cross-pod context is read-only — Pod A can't modify Pod B's living doc. But it can surface: "Pod B has an active decision about the user auth token format that may affect your API contract."

**Shared context mechanics:**
```yaml
org_context_registry:
  org_id: "acme-corp"
  pods:
    - pod_id: "pod-checkout-redesign"
      scope: ["checkout", "cart", "payments"]
      active_conflicts: ["C-007"]
      key_decisions: ["Zustand for cart state", "prices in cents"]
    - pod_id: "pod-user-auth-revamp"
      scope: ["auth", "tokens", "sessions"]
      active_conflicts: ["C-012"]
      key_decisions: ["JWT → opaque tokens migration"]
```

When the checkout pod's BE agent reports an update touching the auth token format, the Cross-Pod Agent surfaces:
> "⚠️ Cross-pod note: Pod user-auth-revamp is actively migrating from JWT to opaque tokens (decision made Apr 1). Your update assumes JWT. You may want to align with their pod lead."

**Boundaries:**
- Cross-pod context is advisory, not blocking. No pod can create conflicts in another pod.
- The Cross-Pod Agent works off summaries, not full living docs — it doesn't need to load another pod's entire context.
- Org admins can define explicit scope overlaps ("these two pods are known to share the payments API") to improve detection.

### 3.10 Proactive Linting Pass

The Council shouldn't only react to incoming context updates — it should actively scan the living doc for problems that no one has explicitly reported. This is inspired by the pattern of running health checks and consistency lints against a knowledge base, rather than waiting for contradictions to surface organically.

**The Summary Agent runs a periodic lint pass** (every 2 hours, or triggered manually from the Council UI). It scans the current DynamoDB state and flags:

```yaml
lint_results:
  pod_id: "pod-checkout-redesign"
  timestamp: "2026-04-03T10:00:00Z"
  findings:
    - type: staleness
      severity: warning
      summary: "No updates from be-agent-01 in 8 hours"
      area: backend
      suggestion: "API work may be blocked. Check in with backend team."

    - type: implicit_assumption
      severity: info
      summary: "fe-agent-02's cart total logic assumes USD-only pricing,
               but no currency decision is in the Decisions Log"
      area: frontend
      suggestion: "Surface as a question or formalize as a decision."

    - type: coverage_gap
      severity: warning
      summary: "Milestone v0.1 includes 'error handling' but no agent
               has reported any error-handling work or claimed ownership"
      area: unassigned
      suggestion: "Assign ownership or descope from milestone."

    - type: dependency_risk
      severity: info
      summary: "fe-agent-01 and fe-agent-02 both reference useCartStore
               but have not coordinated on the store shape"
      area: frontend
      suggestion: "Consider a shared interface decision before both
                   implementations diverge."

    - type: spec_drift
      severity: warning
      summary: "3 context updates reference 'discount percentage' but
               the current spec only mentions flat discount amounts"
      area: spec
      suggestion: "Spec may need updating, or agents are working
                   against outdated assumptions."
```

**Lint finding types:**

| Type | What it catches |
|---|---|
| **Staleness** | An area or agent hasn't reported in an unusually long time relative to pod pace. |
| **Implicit assumption** | An agent's work depends on something that was never formally decided. |
| **Coverage gap** | A milestone item has no owner or no reported progress. |
| **Dependency risk** | Multiple agents are working on things that touch the same system without explicit coordination. |
| **Spec drift** | Agent work references concepts or behaviors not in the current spec. |

**How findings surface:**
- Added to the living doc under a "Lint Findings" section (auto-cleared when addressed).
- Shown in the Pod Dashboard as a collapsible panel alongside the conflict list.
- High-severity findings trigger notifications via the same per-user preference system as conflicts.
- Findings are NOT conflicts — they're advisory. They don't create conflict records or affect pressure score. But if a lint finding goes unaddressed and later becomes an actual conflict, the Council Master can reference it: "This conflict was flagged as a dependency risk 6 hours ago."

**Cost:** The lint pass is a single Summary Agent call (Haiku-class) reading the current state. At once per 2 hours across a 5-day pod, that's ~60 calls — roughly $0.30 total. Negligible.

### 3.11 Knowledge Compounding Loop

Pods are 5-day sprints — they end. But the decisions, patterns, and lessons from each pod are valuable to future pods in the same org. Without a compounding mechanism, every new pod starts from zero context, and the org re-discovers the same answers to the same architectural questions.

**How it works:**

When a pod is archived (via org dashboard), the system doesn't just tombstone the data. A **Knowledge Extraction Agent** (new Committee member, runs once at pod completion) reads the pod's decisions log, resolved conflicts, and final living doc, and distills **durable org-level learnings**:

```yaml
knowledge_extraction:
  pod_id: "pod-checkout-redesign"
  extracted_at: "2026-04-06T18:00:00Z"
  learnings:
    - type: pattern
      domain: ["frontend", "state_management"]
      summary: "Zustand chosen over Redux for cart state. Team found
               Zustand's simplicity better suited to 5-day sprint pace."
      confidence: high
      source_decision: "D-001"

    - type: resolved_conflict
      domain: ["frontend", "design"]
      summary: "When FE implementation and design mockups diverge,
               the org tends to favor the implemented approach if 2+
               downstream dependencies already assume it."
      confidence: medium
      source_conflicts: ["C-007"]

    - type: anti_pattern
      domain: ["api", "contracts"]
      summary: "Starting FE and BE work before finalizing the API
               contract led to 2 blocking conflicts. Future pods
               should formalize API contracts in the spec before
               parallel work begins."
      confidence: high
      source_conflicts: ["C-003", "C-011"]

    - type: scope_insight
      domain: ["checkout", "payments"]
      summary: "Discount logic was more complex than estimated.
               Future pods touching pricing should allocate 1.5x
               time for discount/promo edge cases."
      confidence: medium
      source_context: "ctx-0042 through ctx-0067"
```

**Where learnings live — the Knowledge Graph:**

Learnings are stored as a **persistent knowledge graph** — a connected structure of nodes (learnings) and edges (semantic relationships). This graph is the org's accumulated intelligence, queryable by agents with token budgets to minimize context window bloat.

- **Storage layer (production target):** S3 for full graph snapshots (versioned JSON) + DynamoDB for indexed queries (GSIs on domain, type, confidence, source pod). The graph is loaded into memory on server start for fast traversal.
- **Storage layer (local dev):** Filesystem at `.data/knowledge-graph/{org_id}/graph-latest.json` with versioned snapshots. The interface is designed so swapping to S3 requires re-implementing 3 functions.
- **Graph structure:**
  - **Nodes** (types: `decision`, `pattern`, `anti_pattern`, `resolved_conflict`, `scope_insight`) — each tagged by domain, confidence level (`extracted` from DB vs `inferred` by LLM), and source pod.
  - **Edges** (types: `relates_to`, `supersedes`, `contradicts`, `builds_on`, `resolved_by`) — computed via keyword overlap + type-specific rules, optionally enriched by LLM.
  - **Communities** — clusters of related learnings detected via label propagation algorithm.
  - **Hubs** — high-degree nodes representing key organizational patterns.
- **Confidence levels** (inspired by graphify): `extracted` = deterministic from DB data (0.9 confidence), `inferred` = LLM-generated insights (0.4–0.85 depending on model confidence).

**How agents query the graph (token-budgeted):**

The critical design principle: agents never see the full graph. They request context with a token budget, and the server returns the highest-value subset that fits.

```typescript
// SDK usage — an agent gets relevant learnings in 1 line
const learnings = await agent.getRelevantLearnings(2000); // 2000 token budget

// Server-side: filter by domain → rank by relevance → truncate to budget
// Relevance = domain overlap (0.4) + keyword match (0.3) + confidence (0.15) + recency (0.1) + hub bonus (0.05)
```

API endpoints:
- `POST /api/knowledge/query` — token-budgeted query with filters (domains, types, confidence min, text search)
- `GET /api/knowledge/relevant?scopes=frontend&maxTokens=2000` — convenience for agents
- `GET /api/knowledge/precedents?conflict=<summary>&maxTokens=1000` — conflict precedent lookup
- `POST /api/knowledge/nodes/:id/curate` — human approval/rejection/editing of learnings

**How learnings are used:**
- **New pod seeding:** When `npx council pod create` runs, the server queries the knowledge graph for learnings matching the pod's scopes (3000 token budget) and appends a "Historical Knowledge Context" section to the initial living doc.
- **Living doc enrichment:** The Summary Agent includes a "Knowledge Context" section in every living doc regeneration (1500 token budget, confidence >= 0.6). This evolves as the pod's scopes and conflicts narrow.
- **Conflict precedents:** When the Conflict Agent creates a conflict, it queries `getPrecedents()` and includes historical resolutions in its LLM analysis prompt, enabling it to say: "A similar conflict in the Onboarding pod was resolved by adopting approach X."
- **Cross-pod historical enrichment:** The Cross-Pod Agent enriches overlap advisories with historical learnings from the knowledge graph, connecting current inter-pod overlaps to organizational memory.
- These are advisory — new pods can override any prior learning. But they prevent the org from repeating the same mistakes or re-debating settled questions.

**The compounding effect:**
After 10 pods, the knowledge graph has a rich network of patterns, anti-patterns, and scope insights with semantic relationships between them. Community detection groups related learnings, hub identification highlights the most interconnected organizational patterns. New pods start with increasingly useful context. The Cross-Pod Agent gets smarter because it draws on historical data, not just active pod overlap.

**Human curation:**
The Knowledge Graph UI (`/knowledge` route in the Council UI) lets humans inspect, approve, reject, and edit extracted learnings before they become trusted organizational memory. Uncurated learnings are still queryable but can be filtered out with `curated_only: true`.

**Cost:** One Knowledge Extraction Agent call per completed pod (Sonnet for LLM extraction + Haiku for edge inference). ~$0.05–0.15 per pod. Deterministic extraction (from DB) is free. The system gracefully degrades: no API key = deterministic-only extraction, which still provides useful knowledge.

### 3.12 Key Design Decisions (Resolved)

- **Storage:** S3 for the living doc files (versioned bucket), DynamoDB for all structured state — conflict records, tunnel registry, pod metadata, context index, org registry. DynamoDB is the right choice because the Council agents need fast, structured reads/writes constantly (conflict lookups, pressure calculations, cross-pod registry scans). S3 is for the rendered `.md` artifact that humans read. The living doc is *assembled* from DynamoDB state, not the other way around.
- **Conflict resolution:** Semantic merge handled by the Merge Agent (committee member). Before any merge that touches a previously contested area, the resolution is presented to the human who resolved the conflict for a quick confirmation: "You decided strikethrough. This merge applies that decision to CartSummary.tsx. Confirm?" One-click approval.
- **Context window:** Full doc for now. Agents fetch the entire living doc when requesting context. As docs grow, we can scope by role/area later — but for 5-day pods the doc won't get unmanageably large.
- **Retention:** Manual for now. The org dashboard includes a pod management view where admins can archive completed pods. Archived pods move the living doc to S3 (cheaper tier) and tombstone the DynamoDB records. No automatic lifecycle policies yet.
- **Multi-pod:** Yes — supported via the org-level context registry and Cross-Pod Agent (see 3.9). Read-only cross-pollination, advisory not blocking.

---

## 4. Pillar 3 — Council UI

### 4.1 Core Surfaces

| Surface | Purpose | Priority |
|---|---|---|
| **Pod Dashboard** | Pod health at a glance — conflict pressure, milestone progress, active blockers, tunnel status, last activity per area. | v1 |
| **Live Doc View** | The rendered living doc — **read-only**. The doc is the Council's output, not an editable surface. To change it, talk to the Council. | v1 |
| **Context Feed** | Real-time stream of all agent/human contributions, filterable by scope/type/agent. Think GitHub activity feed for the pod. | v1 |
| **Conflict Center** | Dedicated view for open conflicts — full detail, Master's analysis, presumption-tagged pending work, one-click resolution. | v1 |
| **Tunnel Dashboard** | All active tunnels for the pod with status, branch, and clickable URLs. | v1 |
| **Org Dashboard** | Cross-pod view for org admins — all active pods, their health scores, cross-pod overlaps, archived pod management. | v1 |
| **Spec Editor** | Collaborative spec editing with change-request/approval flow. | v2 |
| **Milestone Tracker** | Visual timeline with dependencies and status. | v2 |

### 4.2 Interaction Model

- **Humans** contribute by talking to the Council — they submit context updates, resolve conflicts, and adjust milestones through the Council UI's input interface. The Council Master processes every input identically whether it came from a human or an AI agent.
- **AI agents** contribute via the SDK/API — they post structured context updates after each work unit.
- **Council Master** is the single merge authority — it treats human and agent inputs identically.

**The living doc is read-only.** No one — human or agent — edits the `.md` directly. The canonical living doc is an output assembled from DynamoDB state by the Summary Agent. If you want to change something in the doc, you talk to the Council: submit a context update, a spec change request, or a conflict resolution. The Master processes it and the doc reflects the new state.

This is the same model as a conversation with an AI — you don't edit the AI's output, you give it new input and it produces updated output. The living doc is the Council's output. The context stream is the input.

### 4.3 Real-Time Architecture — AWS Stack
```
                    ┌──────────────────────────────────────┐
  AI Agents ──API──►│  API Gateway (REST + WebSocket)      │◄──WebSocket── Human Users
                    │         │                            │
                    │  Lambda (Context Ingestion +          │
                    │         Secret Scan)                  │
                    │         │                            │
                    │  EventBridge (Event Bus)              │
                    │         │                            │
                    │  Lambda (Council Master Router)       │
                    │    ├── Lambda (Merge Agent)           │
                    │    ├── Lambda (Conflict Agent)        │
                    │    ├── Lambda (Summary Agent)         │
                    │    ├── Lambda (Cross-Pod Agent)       │
                    │    └── Bedrock / Claude API           │
                    │                                      │
                    │  S3 (Living Doc Render)               │
                    │  DynamoDB (All Structured State)      │
                    │  SNS/SQS (Notifications)              │
                    └──────────────────────────────────────┘
                              │
                    ┌─────────┴─────────┐
                    │   Council UI       │
                    │   (CloudFront +    │
                    │    S3 static       │
                    │    hosting)        │
                    └───────────────────┘
```

**Full AWS Service Map:**

| Concern | AWS Service |
|---|---|
| Agent/Human API | API Gateway (REST + WebSocket) |
| Event routing | EventBridge |
| Compute (stateless) | Lambda |
| Council Master AI | Bedrock (Claude) or external Claude API |
| Council Committee Agents | Lambda (per-agent) + Bedrock |
| Living doc storage | S3 (versioned bucket) |
| State & metadata | DynamoDB |
| Tunnel registry | DynamoDB + API Gateway WebSocket |
| Org context registry | DynamoDB (global table if multi-region) |
| Auth | Adobe IMS |
| DNS | Route 53 |
| CDN / UI hosting | CloudFront + S3 |
| Notifications | SNS + SQS |
| Slack integration | Lambda + Secrets Manager (bot token) |
| Secrets | Secrets Manager |
| Infra-as-code | CDK |
| Observability | CloudWatch + X-Ray |

### 4.4 Pod Dashboard — Layout

```
┌──────────────────────────────────────────────────────────────┐
│  Pod: Checkout Redesign                    Day 3 of 5        │
│  Health: ██████████░░░░ 0.42 (Cautious)    Sprint: Apr 1–5   │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─── Active Milestone ──────────────────────────────────┐   │
│  │ v0.1 — Cart + Summary Page          Target: Apr 4     │   │
│  │ ████████████░░░░░░░░ 62% complete                     │   │
│  └───────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌─── Status by Area ───────────────────────────────────┐    │
│  │ FE Shell    ✅ Done      fe-agent-01     2h ago       │    │
│  │ Cart Logic  🔄 In Prog   fe-agent-02     15m ago      │    │
│  │ API         🔄 In Prog   be-agent-01     1h ago       │    │
│  │ Design QA   ⏳ Waiting    design-lead     —            │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─── Open Conflicts (2) ───────────────────────────────┐    │
│  │ 🔴 C-007  Discount display    BLOCKING   4h old       │    │
│  │    Between: fe-agent-01 vs design-lead                │    │
│  │    [View] [Resolve]                                   │    │
│  │ 🟡 C-009  Error msg wording   non-blocking  1h old    │    │
│  │    Between: fe-agent-02 vs pm-lead                    │    │
│  │    [View] [Resolve]                                   │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─── Active Tunnels (2) ───────────────────────────────┐    │
│  │ 🟢 alice  feat/cart-summary   checkout-alice.council…  │    │
│  │ 🟢 bob    feat/checkout-flow  checkout-bob.council…    │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─── Recent Activity ──────────────────────────────────┐    │
│  │ 15m ago  fe-agent-02  Cart price calc implemented     │    │
│  │ 1h ago   be-agent-01  /cart endpoint discount meta    │    │
│  │ 2h ago   fe-agent-01  CartSummary component done      │    │
│  │ 4h ago   design-lead  Uploaded mockups v3             │    │
│  │                                    [View full feed]   │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 4.5 Conflict Center — Layout

```
┌──────────────────────────────────────────────────────────────┐
│  Conflict C-007: Discount Display Approach        BLOCKING   │
│  Opened: Apr 2, 4:45 PM (4 hours ago)                       │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─── Position A ──────────────┐ ┌─── Position B ──────────┐│
│  │ fe-agent-01                 │ │ design-lead             ││
│  │                             │ │                         ││
│  │ Strikethrough on original   │ │ Separate "You save $X"  ││
│  │ price, net price below.     │ │ line item. No           ││
│  │                             │ │ strikethrough.          ││
│  │ Status: Implemented         │ │ Status: In mockup v3    ││
│  │ Artifact: CartSummary.tsx   │ │ Artifact: mockup-v3.fig ││
│  └─────────────────────────────┘ └─────────────────────────┘│
│                                                              │
│  ┌─── Council Master Analysis ──────────────────────────┐    │
│  │ These approaches are mutually exclusive in the        │    │
│  │ current CartSummary layout. fe-agent-01 has already   │    │
│  │ shipped strikethrough (lines 42-78). design-lead's    │    │
│  │ mockup v3 shows a separate line item.                 │    │
│  │                                                       │    │
│  │ Recommendation: Adopt Position A. Three subsequent    │    │
│  │ updates from other agents already assume              │    │
│  │ strikethrough. Rework cost for B is higher.           │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─── Pending Work (built on assumptions) ──────────────┐    │
│  │ ctx-0051  fe-agent-02  "Cart total uses strikethrough │    │
│  │           price as base"  Assumes: Position A         │    │
│  │           Rework if B: Medium (recalc display logic)  │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─── Resolution ───────────────────────────────────────┐    │
│  │  [Accept A: Strikethrough]  [Accept B: Separate Line] │    │
│  │  [Partial: Proceed with A, revisit later]             │    │
│  │  [Custom resolution: _____________________ ]          │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 4.6 Org Dashboard — Layout

```
┌──────────────────────────────────────────────────────────────┐
│  Acme Corp — AI Pod Council                                  │
│  Active Pods: 3    Archived: 12    Total Agents: 14          │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─── Active Pods ──────────────────────────────────────┐    │
│  │                                                      │    │
│  │ Checkout Redesign     Day 3/5  ██████░░ 0.42 Cautious│    │
│  │   2 conflicts (1 blocking)   3 tunnels   5 agents    │    │
│  │   [Open Pod]                                         │    │
│  │                                                      │    │
│  │ User Auth Revamp      Day 2/5  ████░░░░ 0.18 Normal  │    │
│  │   1 conflict (0 blocking)   2 tunnels   4 agents     │    │
│  │   [Open Pod]                                         │    │
│  │                                                      │    │
│  │ Search Infra v2       Day 4/5  ██████████ 0.81 Degrad│    │
│  │   4 conflicts (3 blocking)   1 tunnel    6 agents    │    │
│  │   ⚠️ Needs attention                                 │    │
│  │   [Open Pod]                                         │    │
│  │                                                      │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─── Cross-Pod Overlaps ───────────────────────────────┐    │
│  │ Checkout ↔ Auth: "auth token format" — Auth pod is    │    │
│  │   migrating JWT→opaque. Checkout pod references JWT.  │    │
│  │   Status: Advisory surfaced, no action needed yet.    │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─── Archived Pods ────────────────────────────────────┐    │
│  │ [Search] [Filter by date]                            │    │
│  │ Homepage Redesign    Completed Apr 1   [View] [Delete]│    │
│  │ Onboarding Flow v3   Completed Mar 28  [View] [Delete]│    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 4.7 UI Tech Stack

| Concern | Choice | Reasoning |
|---|---|---|
| Framework | React (Vite SPA) | Fast build tooling, Spectrum 2 has first-class React bindings |
| Component library | Adobe Spectrum 2 (`@adobe/react-spectrum`) | Mature, accessible, consistent design system. No custom design token work. |
| Real-time | WebSocket via API Gateway | Already in the stack for tunneling. Reuse the same connection layer. |
| Hosting | S3 + CloudFront (static) | Fits the all-AWS constraint. No server for the UI itself. |
| Auth | Cognito hosted UI + Amplify Auth SDK | Shared with tunnel auth. SSO-ready. |
| State management | Zustand or Redux Toolkit | WebSocket events push DynamoDB state changes to the client in real time. |

### 4.8 Key Design Decisions (Resolved)

- **Permissions model:** Role-based, managed at the **org level** and inherited by every pod. Roles and their permissions are persistent across pods — no per-pod configuration. Examples: "Lead" can resolve blocking conflicts, "Member" can resolve non-blocking only, "Viewer" can observe but not contribute. Stored in DynamoDB under the org, enforced at the API Gateway / Lambda layer.
- **Notification preferences:** Per-user settings. Each user configures what events they want to be notified about (conflicts, pressure changes, cross-pod advisories, tunnel status) and through which channel (Slack DM, email via SES, in-app). Stored in DynamoDB per user, evaluated by the notification Lambda when EventBridge fires.
- **Mobile:** Desktop-only for v1. No responsive layout work.
- **Design system:** Adobe Spectrum 2. Mature, accessible component library out of the box.

---

## 5. Architecture Decisions (All Resolved)

### 5.1 Agent Protocol
Formal protocol via the `@council/sdk`. The SDK wraps REST calls to API Gateway. The context update schema (section 3.3) is the contract. Agents that don't use the SDK can post raw JSON to the API Gateway endpoint following the same schema. MCP-adjacent in spirit but purpose-built for the council use case.

### 5.2 Council Master Model
Hybrid. The Master is a lightweight Lambda orchestrator (deterministic routing logic) that delegates AI reasoning to the Committee agents (section 3.8) running on Bedrock/Claude. The Master itself does NOT hold a large context window — it reads structured state from DynamoDB and routes to the right sub-agent.

### 5.3 Multi-Council Topology
Org-level context registry in DynamoDB (section 3.9). Cross-Pod Agent handles inter-pod awareness. No meta-council — the org dashboard gives humans the cross-pod view, and the Cross-Pod Agent handles automated advisory.

### 5.4 Security Boundary

**Code access:** No. The Council never has read access to the actual codebase. Agents report summaries, metadata, and artifact references (file paths, tunnel URLs) — not source code. The Council reasons about *what changed and why*, not implementation details. Trust verification is handled by the tunnel (reviewers see live results) and normal code review processes. If a future need arises for code-aware reasoning, it would be a scoped, opt-in Committee agent — not blanket repo access.

**Secret handling — Defense in Depth:**

The responsibility is shared across two layers:

**Layer 1 — Agent self-diligence (pod-level):**
Agents running in pods are expected to be self-diligent about never committing or reporting secrets in their own processes. The `@council/sdk` documentation and agent onboarding make this expectation explicit. Agents strip secrets from their own outputs before reporting to the Council.

**Layer 2 — Council-wide ironclad diligence (system-level):**
The Council as a whole — every component in the pipeline — treats secret prevention as a non-negotiable invariant:

```
Agent submits context update
       │
  ┌────▼────────────────────────────────┐
  │  API Gateway → Ingestion Lambda     │
  │  Pattern scan: AWS keys (AKIA...),  │
  │  JWTs, high-entropy strings,        │
  │  API key prefixes, connection       │
  │  strings, PEM blocks                │
  │                                     │
  │  MATCH → Reject update, notify      │
  │          contributor: "Your update  │
  │          appears to contain a       │
  │          secret. Revise & resubmit."│
  │                                     │
  │  NO MATCH → Pass through            │
  └────┬────────────────────────────────┘
       │
  ┌────▼────────────────────────────────┐
  │  Council Master / Committee Agents  │
  │  System prompts include explicit    │
  │  instruction: "If you encounter     │
  │  anything that appears to be a      │
  │  secret, credential, or key in      │
  │  context, do NOT include it in any  │
  │  output. Flag it and request the    │
  │  contributor redact."               │
  └────┬────────────────────────────────┘
       │
  ┌────▼────────────────────────────────┐
  │  Living Doc Render (S3)             │
  │  Final output scan before write.    │
  │  Same pattern match as ingestion.   │
  │  Belt and suspenders.               │
  └─────────────────────────────────────┘
```

Three checkpoints: ingestion gate (deterministic, fast), LLM-level awareness (in all Committee agent prompts), and output scan (final safety net before the doc is persisted/rendered). No single point of failure.

### 5.5 Cost Model

Every context update triggers at minimum a DynamoDB write + EventBridge event. LLM calls only happen when the Master routes to a Committee agent — and only the Merge Agent and Conflict Agent use LLM reasoning. The Summary Agent can run on a schedule (every N updates or every X minutes) rather than on every event.

**Cost levers:**
- **Batching:** Buffer rapid-fire updates (e.g., an agent reporting 5 small changes in 30 seconds) and send them to the Merge Agent as one batch.
- **Scoped context:** Committee agents only load the relevant slice of DynamoDB state. Smaller prompts = fewer tokens.
- **Model tiering:** Use Haiku-class models for routine merges (additive, non-conflicting). Use Sonnet/Opus-class only for conflict analysis and cross-pod reasoning.
- **Cache:** If an update is purely additive (no overlap with anything), skip the LLM entirely — deterministic merge via Lambda.

**Rough estimate for a 5-day pod with 5 agents:**
- ~200-400 context updates over 5 days
- ~60% are additive (deterministic merge, no LLM) = ~$0
- ~30% need Merge Agent (Haiku) = ~150 calls × ~$0.005 = ~$0.75
- ~10% need Conflict Agent (Sonnet) = ~30 calls × ~$0.05 = ~$1.50
- Summary Agent runs ~50 times (Haiku) = ~$0.25
- DynamoDB + Lambda + API Gateway = ~$2-5 for the sprint
- **Total: ~$5-8 per pod per sprint.** Negligible.

### 5.6 Bootstrap Flow
One CLI command (section 6). `npx council pod create` initializes everything from a template. The CDK stack is the org-level one-time setup.

---

## 6. Plug & Play — Onboarding a New Pod

### Stack Flexibility Note
This is an Adobe internal tool. The stack decisions in this doc are recommendations based on the architectural requirements. Where org-level mandates exist (CI/CD pipelines, approved AWS configurations, internal package registries, deployment patterns, security review gates), those take precedence. The architecture is designed to be loosely coupled — swapping a component (e.g., a different event bus, a different notification channel) should not require a rewrite of the system.

### Repo Structure — Monorepo

The system uses a **monorepo** with clear package boundaries. The core reason: the context update schema (3.3) is a shared contract across the SDK, ingestion Lambda, every Committee agent, and the UI's type definitions. In a polyrepo setup, keeping that contract in sync across 4-5 repos is a constant source of drift, especially at sprint speed. A monorepo gives you shared types, atomic PRs when the schema changes, and one CI pipeline.

```
council/
├── packages/
│   ├── shared/                    # Shared types, schemas, constants
│   │   ├── src/
│   │   │   ├── schemas/           # Context update schema, conflict schema, etc.
│   │   │   ├── types/             # TypeScript types used everywhere
│   │   │   └── constants/         # Status enums, pressure thresholds, etc.
│   │   └── package.json
│   │
│   ├── sdk/                       # @council/sdk — agent-facing client
│   │   ├── src/
│   │   │   ├── client.ts          # CouncilClient: report(), getContext()
│   │   │   ├── auth.ts            # IMS token handling for agents
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── cli/                       # npx council — tunnel + pod management
│   │   ├── src/
│   │   │   ├── commands/
│   │   │   │   ├── tunnel.ts      # tunnel start/stop
│   │   │   │   ├── pod.ts         # pod create/archive/list
│   │   │   │   └── auth.ts        # IMS login flow
│   │   │   ├── tunnel/
│   │   │   │   ├── client.ts      # WebSocket tunnel client
│   │   │   │   └── heartbeat.ts   # 60s heartbeat manager
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── ui/                        # Council UI — Vite + React + Spectrum 2
│   │   ├── src/
│   │   │   ├── views/
│   │   │   │   ├── PodDashboard/
│   │   │   │   ├── ConflictCenter/
│   │   │   │   ├── ContextFeed/
│   │   │   │   ├── LiveDocView/
│   │   │   │   ├── TunnelDashboard/
│   │   │   │   └── OrgDashboard/
│   │   │   ├── hooks/             # WebSocket, auth, real-time state
│   │   │   ├── components/        # Shared Spectrum 2 components
│   │   │   └── store/             # Zustand stores
│   │   └── package.json
│   │
│   └── infra/                     # CDK stack — all AWS resources
│       ├── lib/
│       │   ├── api-stack.ts       # API Gateway (REST + WebSocket)
│       │   ├── compute-stack.ts   # All Lambdas (Master, Committee, ingestion)
│       │   ├── data-stack.ts      # DynamoDB tables, S3 buckets
│       │   ├── dns-stack.ts       # Route 53, ACM certs, CloudFront
│       │   ├── auth-stack.ts      # IMS integration config
│       │   └── monitoring-stack.ts # CloudWatch, X-Ray
│       └── package.json
│
├── lambdas/                       # Lambda function source code
│   ├── ingestion/                 # Context update intake + secret scan
│   ├── master/                    # Council Master router
│   ├── agents/
│   │   ├── merge/                 # Merge Agent + Bedrock prompt
│   │   ├── conflict/              # Conflict Agent + Bedrock prompt
│   │   ├── summary/               # Summary Agent + lint pass + Bedrock prompt
│   │   ├── cross-pod/             # Cross-Pod Agent + Bedrock prompt
│   │   └── knowledge-extraction/  # Knowledge Extraction Agent + Bedrock prompt
│   ├── tunnel-broker/             # WebSocket tunnel connection broker
│   ├── notifications/             # Slack + email notification handler
│   └── escalation/                # Conflict escalation ladder logic
│
├── prompts/                       # Bedrock system prompts (version-controlled)
│   ├── merge-agent.md
│   ├── conflict-agent.md
│   ├── summary-agent.md
│   ├── cross-pod-agent.md
│   └── knowledge-extraction-agent.md
│
├── turbo.json                     # Turborepo config (build orchestration)
├── pnpm-workspace.yaml            # Workspace config
└── package.json
```

**Key decisions:**
- **`packages/shared/`** is the single source of truth for every schema and type. SDK, CLI, UI, and all Lambdas import from it. Change the context update schema once, and every consumer gets the update atomically.
- **`prompts/`** lives at the repo root, version-controlled alongside the code. Prompt changes are PRs with diffs, not ad-hoc edits in a console. This is important because the Committee agents' behavior IS the product — prompt changes should be reviewed like code changes.
- **`lambdas/`** is separate from `packages/` because Lambdas have different build/deploy concerns (bundling, layer management) but still import from `packages/shared/`.
- **Turborepo** for build orchestration — it understands the dependency graph between packages and only rebuilds what changed. Fast CI.
- **pnpm workspaces** for dependency management — strict, fast, disk-efficient.

### Org-Level Setup (One-Time)
1. Deploy the Council CDK stack to the org's AWS account.
2. Configure Route 53 domain (`council.{org}.com`).
3. Configure Adobe IMS integration (client ID, allowed scopes, redirect URIs).
4. Configure org-level roles and permissions in DynamoDB.
5. Done. All pods share this infra.

### Pod-Level Setup (Per Team)
```bash
npx council pod create --name "checkout-redesign" --members alice,bob,carol
```

This command:
1. Creates a DynamoDB entry for the pod.
2. Provisions an S3 prefix for the pod's living doc and artifacts.
3. Initializes the living doc from a template.
4. Registers the pod in the org-level context registry with scope tags.
5. Spins up the Council Master context (system prompt + pod config).
6. Returns a Council UI link and invite codes for members.

**No Terraform, no YAML, no infra tickets.** A PM or eng lead runs one command and the pod is live.

### Agent Integration (Plug-In)
Any AI agent joins the council by adding a lightweight SDK:

```typescript
import { CouncilClient } from '@council/sdk';

const council = new CouncilClient({
  podId: 'checkout-redesign',
  agentId: 'fe-agent-01',
  scope: 'frontend'
});

// Report progress
await council.report({
  type: 'progress',
  summary: 'Implemented CartSummary component',
  artifacts: [{ type: 'component', path: 'src/components/CartSummary.tsx' }],
  status: 'completed'
});

// Fetch latest context before starting work
const context = await council.getContext();
```

---

## 7. Implementation Milestones

> **Estimated total: 8–10 working days** with AI-assisted development (agents handling boilerplate, CDK stacks, Lambda scaffolding, SDK generation, UI component wiring). A small team (2-3 engineers + AI agents) can ship the dogfood-ready system in two weeks.

### Milestone 1: Foundation + Tunneling (Days 1–2)
**Goal:** Core infra is live. Agents can report context. Devs can tunnel.

These are independent workstreams that can be built in parallel on Day 1.

**Foundation (Day 1):**
- [ ] Monorepo scaffold: Turborepo + pnpm workspaces, `packages/shared`, `packages/sdk`, `packages/cli`, `packages/ui`, `packages/infra`, `lambdas/`, `prompts/`
- [ ] `packages/shared`: context update schema, conflict schema, TypeScript types, status enums, pressure thresholds
- [ ] CDK stack: API Gateway (REST + WebSocket), Lambda, DynamoDB tables, S3 bucket, Route 53 domain
- [ ] DynamoDB schema: pods, context_updates, conflicts, tunnels, org_registry, users, permissions, org_knowledge
- [ ] Context ingestion Lambda: receives updates via API Gateway, validates against shared schema, writes to DynamoDB
- [ ] Secret scan in ingestion Lambda: pattern-match rejection for common secret formats
- [ ] Council Master Lambda (v0): deterministic router — receives EventBridge events, classifies update type, logs routing decision. No LLM yet.
- [ ] `@council/sdk` v0: `report()` and `getContext()` over REST, imports types from `packages/shared`
- [ ] `npx council pod create` CLI command: provisions DynamoDB entries + S3 prefix
- [ ] Adobe IMS auth integration: CLI login flow (browser-based), token caching, API Gateway authorizer validates IMS tokens

**Tunneling (Days 1–2):**
- [ ] Tunnel CLI: `npx council tunnel start --pod X --port Y`
- [ ] WebSocket tunnel client in the CLI: outbound connection to API Gateway
- [ ] Lambda connection broker: maps inbound HTTP requests to the correct tunnel WebSocket session
- [ ] Route 53 wildcard DNS + ACM wildcard cert for `*.council.{org}.com`
- [ ] DynamoDB tunnel registry: tracks active tunnels, branch, heartbeat
- [ ] Heartbeat mechanism: 60s ping from CLI, idle detection at 20 min, disconnect on heartbeat failure
- [ ] Tunnel status reported as context updates to the Council

**Exit criteria:** An agent can submit a context update via the SDK, it passes the secret scan, lands in DynamoDB, and can be fetched back. Two devs can each tunnel their localhost and a third person can visit both URLs.

### Milestone 2: Council Intelligence (Days 3–4)
**Goal:** The Council Master can do semantic merging and detect conflicts.

- [ ] Merge Agent Lambda + Bedrock prompt: semantic merge of context deltas, confidence scoring
- [ ] Conflict Agent Lambda + Bedrock prompt: conflict detection, record creation, analysis generation
- [ ] Summary Agent Lambda + Bedrock prompt: assembles living doc `.md` from DynamoDB state, writes to S3
- [ ] Summary Agent lint pass: periodic scan for staleness, implicit assumptions, coverage gaps, dependency risks, spec drift (per 3.10)
- [ ] Model tiering: Haiku for Merge Agent routine work + lint pass, Sonnet for Conflict Agent
- [ ] Deterministic fast-path: additive updates skip LLM, merge directly via Lambda
- [ ] Conflict record schema in DynamoDB (per 3.5)
- [ ] Conflict pressure calculation Lambda: computes score from open conflicts, age, severity, dependency area
- [ ] EventBridge rules for conflict lifecycle events

**Exit criteria:** Two contradictory updates produce a conflict record with analysis. Additive updates merge without LLM. Living doc renders correctly from state.

### Milestone 3: Council UI (Days 4–6)
**Goal:** Humans can see pod health, read the living doc, and resolve conflicts.

- [ ] Vite + React + Spectrum 2 project setup in `packages/ui`, S3 + CloudFront hosting
- [ ] WebSocket connection for real-time state updates
- [ ] Adobe IMS auth integration (IMS client library, token refresh)
- [ ] Pod Dashboard view (per 4.4 wireframe): health score, status by area, open conflicts, active tunnels, recent activity
- [ ] Conflict Center view (per 4.5 wireframe): side-by-side positions, Master analysis, pending work with presumptions, resolution buttons
- [ ] Context Feed view: filterable real-time stream
- [ ] Live Doc View: read-only rendered `.md` from S3
- [ ] Tunnel Dashboard: active tunnels with status and clickable URLs
- [ ] Human context input: talk-to-the-council interface

**Exit criteria:** A PM can open the dashboard, see pod health, view a conflict, read the Master's analysis, and resolve it. Living doc updates within seconds.

### Milestone 4: Notifications + Slack + Org Layer (Days 6–8)
**Goal:** Conflicts reach people where they are. Org-wide visibility is live.

- [ ] EventBridge → Lambda → Slack Web API for conflict notifications (per 3.6)
- [ ] Slack emoji reaction handler for lightweight resolution
- [ ] Slack interactions logged back into context stream
- [ ] Escalation ladder logic: 4h/8h/16h/24h auto-escalation
- [ ] Per-user notification preferences in DynamoDB + settings UI
- [ ] Org Dashboard view (per 4.6 wireframe): active pods, health, cross-pod overlaps, archive
- [ ] Cross-Pod Agent Lambda + Bedrock prompt: scope overlap detection, advisory generation
- [ ] Knowledge Extraction Agent Lambda + Bedrock prompt: runs on pod archival, distills durable learnings (per 3.11)
- [ ] Org knowledge base DynamoDB table: stores extracted learnings tagged by domain
- [ ] Pod bootstrap seeds "Prior Org Knowledge" section from matching learnings
- [ ] Org-level role/permission management UI
- [ ] Pod archival flow (triggers knowledge extraction before tombstoning)

**Exit criteria:** Conflicts trigger Slack DMs with auto-escalation. Org admin can see all pods and cross-pod advisories. Archiving works.

### Milestone 5: Dogfooding (Days 8–10)
**Goal:** Run a real pod on the system. Fix what breaks.

- [ ] Select a real internal pod to dogfood
- [ ] Agent integration: connect actual AI agents via `@council/sdk`
- [ ] Tunnel stress testing under realistic load
- [ ] Conflict pressure calibration with real data
- [ ] LLM prompt tuning based on real context updates
- [ ] Secret scan + output scan validation
- [ ] CloudWatch dashboards + X-Ray tracing
- [ ] Cost validation against $5-8/pod/sprint estimate
- [ ] SDK docs, CLI docs, onboarding guide

**Exit criteria:** A real pod completes a 5-day sprint using the Council. Post-mortem identifies what worked and what needs iteration.

---

## 8. Glossary

| Term | Definition |
|---|---|
| **Pod** | A cross-functional team running a time-boxed sprint (typically 5 days). |
| **Council** | The AI orchestration layer for a pod — Master + Committee + living doc. |
| **Council Master** | The lightweight Lambda orchestrator that routes context updates to Committee agents. |
| **Committee** | Specialized sub-agents (Merge, Conflict, Summary, Cross-Pod, Knowledge Extraction) that handle specific reasoning tasks. |
| **Living Doc** | The read-only canonical `.md` file assembled from DynamoDB state. The Council's output. |
| **Context Update** | A structured report from an agent or human describing work done, decisions made, or blockers encountered. |
| **Conflict** | A detected contradiction between two or more context updates that the Council cannot confidently resolve. |
| **Conflict Pressure** | A 0.0–1.0 health score reflecting how many open conflicts exist and how long they've been unresolved. |
| **Lint Pass** | A periodic proactive scan of the living doc state for staleness, implicit assumptions, coverage gaps, dependency risks, and spec drift. |
| **Tunnel** | An Expo-style outbound WebSocket connection from a dev's localhost to a stable remote URL. |
| **Org Registry** | A DynamoDB table tracking all pods, their scopes, and key decisions for cross-pod awareness. |
| **Org Knowledge Base** | A DynamoDB table of durable learnings extracted from completed pods — patterns, anti-patterns, and scope insights that seed future pods. |

---

*This is a living document. It will be updated as implementation progresses.*
