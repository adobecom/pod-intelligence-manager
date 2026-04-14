import type {
  Pod,
  Conflict,
  ContextUpdate,
  Tunnel,
  OrgPodSummary,
  CrossPodOverlap,
  ArchivedPod,
  PendingWork,
} from "@council/shared";

// ── Pods ──────────────────────────────────────────────────────────────

export const pods: Record<string, Pod> = {
  "pod-checkout-redesign": {
    pod_id: "pod-checkout-redesign",
    name: "Checkout Redesign",
    sprint_start: "2026-04-06",
    sprint_end: "2026-04-10",
    day_number: 3,
    total_days: 5,
    conflict_pressure: 0.42,
    milestone: {
      name: "v0.1 — Cart + Summary Page",
      target_date: "2026-04-09",
      percent_complete: 62,
    },
    areas: [
      {
        scope: "frontend",
        owner: "fe-agent-01",
        status: "done",
        last_activity: "2026-04-08T14:32:00Z",
      },
      {
        scope: "backend",
        owner: "be-agent-01",
        status: "in_progress",
        last_activity: "2026-04-08T13:10:00Z",
      },
      {
        scope: "design",
        owner: "design-lead",
        status: "in_progress",
        last_activity: "2026-04-08T11:15:00Z",
      },
      {
        scope: "qa",
        owner: "qa-agent-01",
        status: "waiting",
        last_activity: null,
      },
    ],
  },
  "pod-auth-revamp": {
    pod_id: "pod-auth-revamp",
    name: "User Auth Revamp",
    sprint_start: "2026-04-06",
    sprint_end: "2026-04-10",
    day_number: 2,
    total_days: 5,
    conflict_pressure: 0.18,
    milestone: {
      name: "v0.1 — OAuth + Session Management",
      target_date: "2026-04-09",
      percent_complete: 35,
    },
    areas: [
      {
        scope: "backend",
        owner: "be-agent-02",
        status: "in_progress",
        last_activity: "2026-04-07T16:20:00Z",
      },
      {
        scope: "frontend",
        owner: "fe-agent-03",
        status: "in_progress",
        last_activity: "2026-04-07T15:45:00Z",
      },
      {
        scope: "infra",
        owner: "infra-agent-01",
        status: "done",
        last_activity: "2026-04-07T10:00:00Z",
      },
      {
        scope: "qa",
        owner: "qa-agent-02",
        status: "waiting",
        last_activity: null,
      },
    ],
  },
  "pod-search-infra": {
    pod_id: "pod-search-infra",
    name: "Search Infra v2",
    sprint_start: "2026-04-06",
    sprint_end: "2026-04-10",
    day_number: 4,
    total_days: 5,
    conflict_pressure: 0.81,
    milestone: {
      name: "v0.1 — Indexing Pipeline + Query API",
      target_date: "2026-04-09",
      percent_complete: 78,
    },
    areas: [
      {
        scope: "backend",
        owner: "be-agent-03",
        status: "blocked",
        last_activity: "2026-04-09T09:00:00Z",
      },
      {
        scope: "infra",
        owner: "infra-agent-02",
        status: "in_progress",
        last_activity: "2026-04-09T08:30:00Z",
      },
      {
        scope: "frontend",
        owner: "fe-agent-04",
        status: "in_progress",
        last_activity: "2026-04-08T17:00:00Z",
      },
      {
        scope: "qa",
        owner: "qa-agent-03",
        status: "in_progress",
        last_activity: "2026-04-09T07:45:00Z",
      },
    ],
  },
};

// ── Conflicts ─────────────────────────────────────────────────────────

export const conflicts: Record<string, Conflict[]> = {
  "pod-checkout-redesign": [
    {
      id: "C-007",
      pod_id: "pod-checkout-redesign",
      created_at: "2026-04-08T16:45:00Z",
      status: "open",
      severity: "blocking",
      summary: "Discount display: strikethrough vs. separate line item",
      sides: [
        {
          contributor: "fe-agent-01",
          position:
            "Strikethrough on original price, net price below. Implemented in CartSummary.tsx with CSS text-decoration.",
          context_update_id: "ctx-0042",
          timestamp: "2026-04-08T14:32:00Z",
        },
        {
          contributor: "design-lead",
          position:
            'Separate "You save $X" line item below subtotal. Matches mockup v3 and A/B test winner from Q1.',
          context_update_id: "ctx-0038",
          timestamp: "2026-04-08T11:15:00Z",
        },
      ],
      master_analysis:
        "These approaches are mutually exclusive. fe-agent-01 has already implemented strikethrough in CartSummary.tsx. design-lead's mockup v3 shows a separate line item, backed by Q1 A/B test data. Resolving in favor of design-lead's position would require fe-agent-01 to rework the CartSummary component. Resolving in favor of fe-agent-01 would deviate from the approved design spec.",
      impact: [
        "fe-agent-01 may need to rework CartSummary.tsx",
        "Blocks QA sign-off on cart flow",
      ],
      resolved_by: null,
      resolution: null,
      resolution_date: null,
    },
    {
      id: "C-009",
      pod_id: "pod-checkout-redesign",
      created_at: "2026-04-08T18:20:00Z",
      status: "open",
      severity: "non_blocking",
      summary: "Error message wording for invalid promo codes",
      sides: [
        {
          contributor: "fe-agent-02",
          position:
            '"Invalid promo code. Please check and try again." — generic, safe, matches existing error patterns.',
          context_update_id: "ctx-0045",
          timestamp: "2026-04-08T17:00:00Z",
        },
        {
          contributor: "pm-lead",
          position:
            '"This code isn\'t valid — did you mean [suggestion]?" — friendlier tone with smart suggestion from promo DB.',
          context_update_id: "ctx-0044",
          timestamp: "2026-04-08T16:30:00Z",
        },
      ],
      master_analysis:
        "Low severity — both approaches work. PM's version requires a new API call to the promo suggestion endpoint which is not yet built. fe-agent-02's version can ship now. Recommend shipping the generic version for v0.1 and implementing smart suggestions in a follow-up.",
      impact: [
        "Minor UX difference",
        "PM version requires additional API work",
      ],
      resolved_by: null,
      resolution: null,
      resolution_date: null,
    },
  ],
  "pod-auth-revamp": [],
  "pod-search-infra": [
    {
      id: "C-012",
      pod_id: "pod-search-infra",
      created_at: "2026-04-09T08:00:00Z",
      status: "open",
      severity: "blocking",
      summary: "Search index format: flat JSON vs. nested document structure",
      sides: [
        {
          contributor: "be-agent-03",
          position:
            "Flat JSON for faster indexing and simpler query parsing. Already built the indexer around this format.",
          context_update_id: "ctx-0060",
          timestamp: "2026-04-09T07:30:00Z",
        },
        {
          contributor: "infra-agent-02",
          position:
            "Nested document structure to preserve hierarchy for faceted search. Required by the query API contract.",
          context_update_id: "ctx-0061",
          timestamp: "2026-04-09T07:45:00Z",
        },
      ],
      master_analysis:
        "Fundamental architectural disagreement. The indexer (be-agent-03) and query API (infra-agent-02) are building against incompatible schemas. This must be resolved before either can proceed — both are blocked.",
      impact: [
        "Indexer and query API are incompatible",
        "Blocks all search functionality",
        "Day 4 of 5 — urgent",
      ],
      resolved_by: null,
      resolution: null,
      resolution_date: null,
    },
  ],
};

// ── Pending Work (per conflict) ───────────────────────────────────────

export const pendingWork: Record<string, PendingWork[]> = {
  "C-007": [
    {
      context_update_id: "ctx-0050",
      agent_id: "qa-agent-01",
      summary: "Wrote E2E test for cart with strikethrough discount display",
      presumes: "Position A (fe-agent-01: strikethrough)",
      rework_cost: "~2 hours to rewrite test assertions",
    },
  ],
  "C-009": [],
  "C-012": [
    {
      context_update_id: "ctx-0063",
      agent_id: "fe-agent-04",
      summary: "Built search results component assuming flat JSON response shape",
      presumes: "Position A (be-agent-03: flat JSON)",
      rework_cost: "~4 hours to refactor response parsing and component props",
    },
  ],
};

// ── Context Updates ───────────────────────────────────────────────────

export const contextUpdates: Record<string, ContextUpdate[]> = {
  "pod-checkout-redesign": [
    {
      id: "ctx-0042",
      agent_id: "fe-agent-01",
      timestamp: "2026-04-08T14:32:00Z",
      pod_id: "pod-checkout-redesign",
      type: "progress",
      scope: "frontend",
      summary: "Implemented cart summary component with strikethrough discounts",
      details:
        "CartSummary.tsx now renders line items with original price struck through and net price below. Uses useCartStore hook for state. Responsive layout tested at 1024px+.",
      artifacts: [
        { type: "component", path: "src/components/CartSummary.tsx" },
        { type: "screenshot", url: "https://tunnel.pod.dev/checkout/cart" },
      ],
      status: "completed",
      blocks: [],
      blocked_by: [],
      needs_input_from: [
        { role: "design", question: "Discount display preference?" },
      ],
    },
    {
      id: "ctx-0038",
      agent_id: "design-lead",
      timestamp: "2026-04-08T11:15:00Z",
      pod_id: "pod-checkout-redesign",
      type: "spec_change",
      scope: "design",
      summary: 'Updated mockup v3: separate "You save" line item for discounts',
      details:
        'Based on Q1 A/B test results showing 12% higher conversion with the "You save" pattern. Updated Figma file and design spec document.',
      artifacts: [{ type: "figma", url: "https://figma.com/file/xyz/mockup-v3" }],
      status: "completed",
      blocks: [],
      blocked_by: [],
      needs_input_from: [],
    },
    {
      id: "ctx-0040",
      agent_id: "be-agent-01",
      timestamp: "2026-04-08T13:10:00Z",
      pod_id: "pod-checkout-redesign",
      type: "progress",
      scope: "backend",
      summary: "/cart endpoint now returns discount metadata",
      details:
        "Added discount_amount, discount_type, and original_price fields to the /cart GET response. Prices in cents. Backward compatible — new fields are additive.",
      artifacts: [{ type: "api", path: "src/routes/cart.ts" }],
      status: "completed",
      blocks: [],
      blocked_by: [],
      needs_input_from: [],
    },
    {
      id: "ctx-0035",
      agent_id: "fe-agent-02",
      timestamp: "2026-04-08T10:00:00Z",
      pod_id: "pod-checkout-redesign",
      type: "progress",
      scope: "frontend",
      summary: "Cart page shell and routing complete",
      details:
        "Set up /checkout/cart route with layout, header, and empty cart state. Wired up useCartStore with mock data for development.",
      artifacts: [{ type: "component", path: "src/pages/CartPage.tsx" }],
      status: "completed",
      blocks: [],
      blocked_by: [],
      needs_input_from: [],
    },
    {
      id: "ctx-0033",
      agent_id: "pm-lead",
      timestamp: "2026-04-07T16:00:00Z",
      pod_id: "pod-checkout-redesign",
      type: "decision",
      scope: "pm",
      summary: "Use Zustand for cart state management",
      details:
        "Decision: Zustand over Redux for cart state. Rationale: smaller bundle, simpler API, sufficient for cart scope. No need for Redux devtools or middleware for this use case.",
      artifacts: [],
      status: "completed",
      blocks: [],
      blocked_by: [],
      needs_input_from: [],
    },
    {
      id: "ctx-0031",
      agent_id: "be-agent-01",
      timestamp: "2026-04-07T14:30:00Z",
      pod_id: "pod-checkout-redesign",
      type: "decision",
      scope: "backend",
      summary: "API returns prices in cents (integer), not dollars (float)",
      details:
        "All monetary values in API responses use integer cents to avoid floating-point precision issues. Frontend handles formatting to display currency.",
      artifacts: [],
      status: "completed",
      blocks: [],
      blocked_by: [],
      needs_input_from: [],
    },
    {
      id: "ctx-0045",
      agent_id: "fe-agent-02",
      timestamp: "2026-04-08T17:00:00Z",
      pod_id: "pod-checkout-redesign",
      type: "progress",
      scope: "frontend",
      summary: "Promo code input with basic validation",
      details:
        "Added PromoCodeInput component with client-side format validation and API call to /promo/validate. Shows generic error for invalid codes.",
      artifacts: [
        { type: "component", path: "src/components/PromoCodeInput.tsx" },
      ],
      status: "completed",
      blocks: [],
      blocked_by: [],
      needs_input_from: [],
    },
    {
      id: "ctx-0047",
      agent_id: "fe-agent-01",
      timestamp: "2026-04-08T18:00:00Z",
      pod_id: "pod-checkout-redesign",
      type: "blocker",
      scope: "frontend",
      summary: "Waiting on conflict C-007 resolution to finalize discount display",
      details:
        "CartSummary.tsx has strikethrough implementation but design-lead's mockup v3 shows a different approach. Cannot proceed with QA handoff until this is resolved.",
      artifacts: [],
      status: "blocked",
      blocks: ["qa-signoff"],
      blocked_by: ["C-007"],
      needs_input_from: [],
    },
  ],
  "pod-auth-revamp": [
    {
      id: "ctx-0100",
      agent_id: "infra-agent-01",
      timestamp: "2026-04-07T10:00:00Z",
      pod_id: "pod-auth-revamp",
      type: "progress",
      scope: "infra",
      summary: "Cognito user pool and app client configured",
      details:
        "Set up Cognito user pool with Adobe IMS as federated identity provider. App client configured for PKCE flow. Deployed to dev environment.",
      artifacts: [{ type: "config", path: "infra/cognito-stack.ts" }],
      status: "completed",
      blocks: [],
      blocked_by: [],
      needs_input_from: [],
    },
    {
      id: "ctx-0102",
      agent_id: "be-agent-02",
      timestamp: "2026-04-07T16:20:00Z",
      pod_id: "pod-auth-revamp",
      type: "progress",
      scope: "backend",
      summary: "Session management API with token refresh",
      details:
        "Implemented /auth/session endpoint with JWT validation and refresh token rotation. 15-minute access token TTL, 7-day refresh token.",
      artifacts: [{ type: "api", path: "src/routes/auth.ts" }],
      status: "in_progress",
      blocks: [],
      blocked_by: [],
      needs_input_from: [],
    },
  ],
  "pod-search-infra": [
    {
      id: "ctx-0060",
      agent_id: "be-agent-03",
      timestamp: "2026-04-09T07:30:00Z",
      pod_id: "pod-search-infra",
      type: "progress",
      scope: "backend",
      summary: "Search indexer built with flat JSON document format",
      details:
        "Indexer processes documents into flat key-value pairs for OpenSearch. Handles 1000 docs/sec in load testing. Format chosen for indexing speed.",
      artifacts: [{ type: "service", path: "src/indexer/pipeline.ts" }],
      status: "blocked",
      blocks: [],
      blocked_by: ["C-012"],
      needs_input_from: [],
    },
    {
      id: "ctx-0061",
      agent_id: "infra-agent-02",
      timestamp: "2026-04-09T07:45:00Z",
      pod_id: "pod-search-infra",
      type: "progress",
      scope: "infra",
      summary: "Query API expects nested document structure for faceted search",
      details:
        "The query API contract requires nested documents to support faceted search (category > subcategory > item). Flat format would require a mapping layer.",
      artifacts: [{ type: "api", path: "src/query/api.ts" }],
      status: "blocked",
      blocks: [],
      blocked_by: ["C-012"],
      needs_input_from: [],
    },
  ],
};

// ── Tunnels ───────────────────────────────────────────────────────────

export const tunnels: Record<string, Tunnel[]> = {
  "pod-checkout-redesign": [
    {
      tunnel_id: "tun-001",
      pod_id: "pod-checkout-redesign",
      dev_name: "alice",
      branch: "feat/cart-summary",
      url: "checkout-alice.council.acme.com",
      status: "active",
      last_activity: "2026-04-08T18:30:00Z",
    },
    {
      tunnel_id: "tun-002",
      pod_id: "pod-checkout-redesign",
      dev_name: "bob",
      branch: "feat/promo-codes",
      url: "checkout-bob.council.acme.com",
      status: "active",
      last_activity: "2026-04-08T17:45:00Z",
    },
    {
      tunnel_id: "tun-003",
      pod_id: "pod-checkout-redesign",
      dev_name: "carol",
      branch: "feat/cart-api",
      url: "checkout-carol.council.acme.com",
      status: "idle",
      last_activity: "2026-04-08T14:00:00Z",
    },
  ],
  "pod-auth-revamp": [
    {
      tunnel_id: "tun-004",
      pod_id: "pod-auth-revamp",
      dev_name: "dave",
      branch: "feat/oauth-flow",
      url: "auth-dave.council.acme.com",
      status: "active",
      last_activity: "2026-04-07T16:30:00Z",
    },
  ],
  "pod-search-infra": [
    {
      tunnel_id: "tun-005",
      pod_id: "pod-search-infra",
      dev_name: "eve",
      branch: "feat/search-ui",
      url: "search-eve.council.acme.com",
      status: "active",
      last_activity: "2026-04-09T09:10:00Z",
    },
    {
      tunnel_id: "tun-006",
      pod_id: "pod-search-infra",
      dev_name: "frank",
      branch: "feat/indexer",
      url: "search-frank.council.acme.com",
      status: "disconnected",
      last_activity: "2026-04-08T22:00:00Z",
    },
  ],
};

// ── Org-Level Data ────────────────────────────────────────────────────

export const orgPods: OrgPodSummary[] = [
  {
    pod_id: "pod-checkout-redesign",
    name: "Checkout Redesign",
    day_number: 3,
    total_days: 5,
    conflict_pressure: 0.42,
    open_conflicts: 2,
    active_tunnels: 3,
    agent_count: 5,
  },
  {
    pod_id: "pod-auth-revamp",
    name: "User Auth Revamp",
    day_number: 2,
    total_days: 5,
    conflict_pressure: 0.18,
    open_conflicts: 0,
    active_tunnels: 1,
    agent_count: 4,
  },
  {
    pod_id: "pod-search-infra",
    name: "Search Infra v2",
    day_number: 4,
    total_days: 5,
    conflict_pressure: 0.81,
    open_conflicts: 1,
    active_tunnels: 2,
    agent_count: 4,
  },
];

export const crossPodOverlaps: CrossPodOverlap[] = [
  {
    id: "overlap-001",
    pod_a: "Checkout Redesign",
    pod_b: "User Auth Revamp",
    description: "JWT format migration",
    advisory:
      "Both pods interact with JWT tokens. Auth Revamp is changing the token format — Checkout's session handling may need updates once the new format rolls out.",
  },
  {
    id: "overlap-002",
    pod_a: "Checkout Redesign",
    pod_b: "Search Infra v2",
    description: "Product catalog data model",
    advisory:
      "Search indexer and checkout cart both read from the product catalog. Schema changes in either pod may affect the other.",
  },
];

export const archivedPods: ArchivedPod[] = [
  {
    pod_id: "pod-onboarding-v2",
    name: "Onboarding Flow v2",
    completed_date: "2026-03-28",
    duration_days: 5,
    final_pressure: 0.12,
  },
  {
    pod_id: "pod-notifications",
    name: "Notification System",
    completed_date: "2026-03-21",
    duration_days: 5,
    final_pressure: 0.35,
  },
];

// ── Living Doc ────────────────────────────────────────────────────────

export const livingDocs: Record<string, string> = {
  "pod-checkout-redesign": `# Pod: Checkout Redesign — Living Doc

## Pod Health
**Conflict Pressure:** 0.42 (Cautious) | **Day 3 of 5** | Sprint: Apr 6–10

## Active Milestone
**v0.1 — Cart + Summary Page** (Target: Apr 9) — 62% complete

## Current Status

| Area | Owner | Status | Last Update |
|------|-------|--------|-------------|
| FE Shell | fe-agent-01 | Done | Apr 8 |
| Cart Logic | fe-agent-02 | In Progress | Apr 8 |
| Cart API | be-agent-01 | In Progress | Apr 8 |
| Design QA | qa-agent-01 | Waiting | — |

## Open Conflicts

- **C-007:** Discount display — strikethrough vs. separate line item — **BLOCKING**
- **C-009:** Error message wording for invalid promo codes — non-blocking

## Decisions Log

- **[Apr 7]** Use Zustand for cart state management (pm-lead)
- **[Apr 7]** API returns prices in cents, not dollars (be-agent-01)

## Context Stream (Recent)

- **[Apr 8 18:00]** fe-agent-01: Blocked — waiting on C-007 resolution for discount display
- **[Apr 8 17:00]** fe-agent-02: Promo code input with basic validation
- **[Apr 8 16:45]** Council: Conflict C-007 created — discount display approaches conflict
- **[Apr 8 14:32]** fe-agent-01: Implemented CartSummary with strikethrough discounts
- **[Apr 8 13:10]** be-agent-01: /cart endpoint now returns discount metadata
- **[Apr 8 11:15]** design-lead: Updated mockup v3 with "You save" line item

## Active Tunnels

- 🟢 alice: feat/cart-summary → checkout-alice.council.acme.com
- 🟢 bob: feat/promo-codes → checkout-bob.council.acme.com
- 🟡 carol: feat/cart-api → checkout-carol.council.acme.com (idle)
`,
  "pod-auth-revamp": `# Pod: User Auth Revamp — Living Doc

## Pod Health
**Conflict Pressure:** 0.18 (Normal) | **Day 2 of 5** | Sprint: Apr 6–10

## Active Milestone
**v0.1 — OAuth + Session Management** (Target: Apr 9) — 35% complete

## Current Status

| Area | Owner | Status | Last Update |
|------|-------|--------|-------------|
| Cognito Setup | infra-agent-01 | Done | Apr 7 |
| Session API | be-agent-02 | In Progress | Apr 7 |
| Auth UI | fe-agent-03 | In Progress | Apr 7 |
| QA | qa-agent-02 | Waiting | — |

## Open Conflicts

None

## Context Stream (Recent)

- **[Apr 7 16:20]** be-agent-02: Session management API with token refresh
- **[Apr 7 10:00]** infra-agent-01: Cognito user pool and app client configured
`,
  "pod-search-infra": `# Pod: Search Infra v2 — Living Doc

## Pod Health
**Conflict Pressure:** 0.81 (Critical) | **Day 4 of 5** | Sprint: Apr 6–10

## Active Milestone
**v0.1 — Indexing Pipeline + Query API** (Target: Apr 9) — 78% complete

## Current Status

| Area | Owner | Status | Last Update |
|------|-------|--------|-------------|
| Indexer | be-agent-03 | Blocked | Apr 9 |
| Query API | infra-agent-02 | In Progress | Apr 9 |
| Search UI | fe-agent-04 | In Progress | Apr 8 |
| QA | qa-agent-03 | In Progress | Apr 9 |

## Open Conflicts

- **C-012:** Search index format — flat JSON vs. nested document — **BLOCKING**

## Context Stream (Recent)

- **[Apr 9 07:45]** infra-agent-02: Query API expects nested documents for faceted search
- **[Apr 9 07:30]** be-agent-03: Indexer built with flat JSON — now blocked on C-012
`,
};
