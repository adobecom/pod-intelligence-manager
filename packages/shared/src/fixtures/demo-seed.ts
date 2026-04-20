import type { Pod } from "../types/pod";
import type { Conflict, PendingWork } from "../types/conflict";
import type { ContextUpdate } from "../types/context-update";
import type { Tunnel } from "../types/tunnel";
import type { OrgPodSummary, CrossPodOverlap, ArchivedPod } from "../types/org";

// ── Pods ──────────────────────────────────────────────────────────────

export const pods: Record<string, Pod> = {
  "pod-emc-rbac": {
    pod_id: "pod-emc-rbac",
    name: "RBAC Permission System",
    sprint_start: "2026-04-14",
    sprint_end: "2026-04-18",
    day_number: 4,
    total_days: 5,
    conflict_pressure: 0.65,
    milestone: {
      name: "v0.1 — Permission Gating + Group Context",
      target_date: "2026-04-17",
      percent_complete: 72,
    },
    areas: [
      {
        scope: "frontend",
        owner: "fe-agent-rbac",
        status: "in_progress",
        last_activity: "2026-04-17T10:45:00Z",
      },
      {
        scope: "backend",
        owner: "be-agent-rbac",
        status: "in_progress",
        last_activity: "2026-04-17T09:30:00Z",
      },
      {
        scope: "design",
        owner: "design-lead",
        status: "done",
        last_activity: "2026-04-16T14:00:00Z",
      },
      {
        scope: "qa",
        owner: "qa-agent-rbac",
        status: "waiting",
        last_activity: null,
      },
    ],
  },
  "pod-emc-sessions": {
    pod_id: "pod-emc-sessions",
    name: "Session Management",
    sprint_start: "2026-04-14",
    sprint_end: "2026-04-18",
    day_number: 3,
    total_days: 5,
    conflict_pressure: 0.38,
    milestone: {
      name: "v0.1 — Session CRUD + Timezone Handling",
      target_date: "2026-04-17",
      percent_complete: 55,
    },
    areas: [
      {
        scope: "frontend",
        owner: "fe-agent-sessions",
        status: "in_progress",
        last_activity: "2026-04-16T16:20:00Z",
      },
      {
        scope: "backend",
        owner: "be-agent-sessions",
        status: "in_progress",
        last_activity: "2026-04-16T15:10:00Z",
      },
      {
        scope: "design",
        owner: "design-sessions",
        status: "done",
        last_activity: "2026-04-15T11:30:00Z",
      },
      {
        scope: "qa",
        owner: "qa-agent-sessions",
        status: "in_progress",
        last_activity: "2026-04-16T17:00:00Z",
      },
    ],
  },
  "pod-emc-configs": {
    pod_id: "pod-emc-configs",
    name: "Scope Level Configs Service",
    sprint_start: "2026-04-14",
    sprint_end: "2026-04-18",
    day_number: 3,
    total_days: 5,
    conflict_pressure: 0.52,
    milestone: {
      name: "v0.1 — Config CRUD + Inheritance Model",
      target_date: "2026-04-17",
      percent_complete: 48,
    },
    areas: [
      {
        scope: "frontend",
        owner: "fe-agent-configs",
        status: "in_progress",
        last_activity: "2026-04-16T14:45:00Z",
      },
      {
        scope: "backend",
        owner: "be-agent-configs",
        status: "blocked",
        last_activity: "2026-04-17T08:00:00Z",
      },
      {
        scope: "design",
        owner: "design-configs",
        status: "done",
        last_activity: "2026-04-15T16:00:00Z",
      },
      {
        scope: "qa",
        owner: "qa-agent-configs",
        status: "waiting",
        last_activity: null,
      },
      {
        scope: "pm",
        owner: "pm-configs",
        status: "in_progress",
        last_activity: "2026-04-16T11:00:00Z",
      },
    ],
  },
};

// ── Conflicts ─────────────────────────────────────────────────────────

export const conflicts: Record<string, Conflict[]> = {
  "pod-emc-rbac": [
    {
      id: "C-101",
      pod_id: "pod-emc-rbac",
      created_at: "2026-04-16T14:30:00Z",
      status: "open",
      severity: "blocking",
      summary:
        "Static users.json RBAC vs. ESP API-driven GroupContext: deprecate or keep as fallback",
      sides: [
        {
          contributor: "be-agent-rbac",
          position:
            "Fully deprecate static users.json. The ESP API groups endpoint is production-ready and GroupContext provides real-time role resolution via x-adobe-esp-group-id header. Maintaining two permission systems creates inconsistency — the static file already has role definitions that conflict with API-returned scopes for 3 users.",
          context_update_id: "ctx-1004",
          timestamp: "2026-04-16T13:30:00Z",
        },
        {
          contributor: "fe-agent-rbac",
          position:
            "Keep users.json as a fallback for the 403 path. When role:read returns 403, the frontend currently falls back to domain-only permissions derived from the static file. Removing it breaks permission gating on TopNav tabs and Home cards for users whose groups haven't synced. We've seen this happen in staging for ~8% of first-time logins.",
          context_update_id: "ctx-1005",
          timestamp: "2026-04-16T14:00:00Z",
        },
      ],
      master_analysis:
        "The two RBAC systems are partially redundant. be-agent-rbac's position eliminates maintenance burden and data drift, but fe-agent-rbac has documented evidence that 8% of first logins hit the 403 fallback path in staging. Fully removing the static file without a replacement fallback would break TopNav permission gating for those users. A middle path: deprecate users.json for primary auth but generate a cached fallback from the last successful API response stored in sessionStorage.",
      impact: [
        "Blocks QA sign-off on permission gating",
        "TopNav tabs, Home cards, and Overview stats all depend on resolved permissions",
        "Admin UI cannot be tested until permission source is finalized",
      ],
      resolved_by: null,
      resolution: null,
      resolution_date: null,
    },
    {
      id: "C-102",
      pod_id: "pod-emc-rbac",
      created_at: "2026-04-17T09:15:00Z",
      status: "open",
      severity: "non_blocking",
      summary:
        "403 fallback scope: grant domain-only read permissions vs. deny all until role:read succeeds",
      sides: [
        {
          contributor: "fe-agent-rbac",
          position:
            "Grant domain-only read permissions (event:read, session:read, config:read) on 403 fallback. Users can at least browse content. Write operations still blocked. This matches the current behavior and prevents a blank screen on first login.",
          context_update_id: "ctx-1008",
          timestamp: "2026-04-17T08:45:00Z",
        },
        {
          contributor: "be-agent-rbac",
          position:
            "Deny all permissions and show a retry prompt. Granting any permissions without API confirmation is a security concern — we could be granting access to users who have been removed from a group. The retry should auto-fire after 3 seconds.",
          context_update_id: "ctx-1009",
          timestamp: "2026-04-17T09:00:00Z",
        },
      ],
      master_analysis:
        "Low urgency — this only affects the 403 edge case. fe-agent-rbac's approach provides a better UX and matches existing behavior. be-agent-rbac raises a valid security concern about stale permissions. A compromise: grant read-only fallback for 30 seconds while retrying the API, then deny all if retries exhaust. Non-blocking because the primary permission path works.",
      impact: [
        "Affects UX for ~8% of first logins in staging",
        "Security posture of fallback path",
      ],
      resolved_by: null,
      resolution: null,
      resolution_date: null,
    },
  ],
  "pod-emc-sessions": [
    {
      id: "C-201",
      pod_id: "pod-emc-sessions",
      created_at: "2026-04-16T11:00:00Z",
      status: "open",
      severity: "blocking",
      summary:
        "Timezone handling: naive ISO strings with IANA timezone vs. UTC-everywhere with client conversion",
      sides: [
        {
          contributor: "be-agent-sessions",
          position:
            "Store UTC millis everywhere. naiveDateTimeToUTCMillis() at write time, millisToNaiveDateTimeString() at read time. Single source of truth. Already implemented the conversion utilities and all API endpoints use UTC millis internally. The IANA timezone string is stored alongside for display but never used in comparisons.",
          context_update_id: "ctx-2003",
          timestamp: "2026-04-16T10:30:00Z",
        },
        {
          contributor: "design-sessions",
          position:
            "UI must display and accept naive datetime strings (what the user sees on the clock at the venue). The session creation form should work with local times — converting to UTC at the form boundary creates confusion when the organizer is in a different timezone than the venue. The mockup shows time inputs as naive strings with an explicit timezone selector.",
          context_update_id: "ctx-2002",
          timestamp: "2026-04-15T11:30:00Z",
        },
      ],
      master_analysis:
        "Both positions are partially correct and actually compatible. The backend stores UTC millis (be-agent-sessions has this built), while the frontend works with naive strings + IANA timezone at the form level (design-sessions' mockup). The disagreement is about who does the conversion: backend says the API accepts/returns UTC millis and frontend converts; design says the API should accept naive strings + timezone and convert server-side. This must be resolved because fe-agent-sessions needs to know the API contract to build the session form.",
      impact: [
        "Blocks session creation form implementation",
        "Affects auto-registration time window logic",
        "Speaker assignment modal depends on session time display",
      ],
      resolved_by: null,
      resolution: null,
      resolution_date: null,
    },
    {
      id: "C-202",
      pod_id: "pod-emc-sessions",
      created_at: "2026-04-16T15:30:00Z",
      status: "open",
      severity: "non_blocking",
      summary:
        "Auto-registration default for new sessions: enabled by default vs. disabled by default",
      sides: [
        {
          contributor: "pm-configs",
          position:
            "Default auto-registration ON for new sessions. Most Adobe events want attendees auto-registered. Turning it off is the exception. This reduces a step for the 80% use case.",
          context_update_id: "ctx-2006",
          timestamp: "2026-04-16T15:00:00Z",
        },
        {
          contributor: "be-agent-sessions",
          position:
            "Default OFF. Auto-registration triggers downstream webhook calls to the registration service. If an organizer creates a session accidentally or as a draft, auto-registration would fire webhooks and create registration records that need cleanup. Safer to require explicit opt-in.",
          context_update_id: "ctx-2007",
          timestamp: "2026-04-16T15:15:00Z",
        },
      ],
      master_analysis:
        "Non-blocking — the session CRUD works either way, this is a default value question. PM's argument is about UX convenience, backend's is about data integrity. A compromise: default ON only when the session has a linked event with auto-registration enabled at the event level, otherwise OFF. Recommend defaulting OFF for v0.1 and revisiting based on usage data.",
      impact: [
        "Minor UX difference in session creation flow",
        "Downstream registration webhook behavior",
      ],
      resolved_by: null,
      resolution: null,
      resolution_date: null,
    },
  ],
  "pod-emc-configs": [
    {
      id: "C-301",
      pod_id: "pod-emc-configs",
      created_at: "2026-04-16T10:00:00Z",
      status: "open",
      severity: "blocking",
      summary:
        "Config inheritance model: full-replace (child completely overrides parent) vs. deep-merge (child overrides individual fields)",
      sides: [
        {
          contributor: "be-agent-configs",
          position:
            "Full-replace inheritance. The ConfigService is already built with full-replace semantics — when a team-level scope has RSVP config, it completely replaces the org-level RSVP config. This is simpler to reason about, easier to debug, and avoids merge ambiguity for ordered lists like custom attribute values. The 5-minute cache TTL and request deduplication are built around this model.",
          context_update_id: "ctx-3003",
          timestamp: "2026-04-16T09:30:00Z",
        },
        {
          contributor: "pm-configs",
          position:
            "Deep-merge inheritance. Event organizers want to add a few custom fields at the team level without re-specifying all 15 base RSVP fields from the org level. Full-replace means every team must duplicate the org config and add their changes — this is error-prone and creates config drift when the org updates base fields.",
          context_update_id: "ctx-3004",
          timestamp: "2026-04-16T09:45:00Z",
        },
      ],
      master_analysis:
        "Fundamental architectural decision. be-agent-configs has a working implementation with full-replace. pm-configs raises a valid UX concern about config duplication and drift. Deep-merge would require: (1) rewriting ConfigService resolution logic, (2) defining merge rules for each config type, (3) handling ordered-list merges for custom attribute values. This is blocking because the frontend config editor UI depends on knowing whether users are editing a full config or a delta overlay.",
      impact: [
        "Blocks config editor UI implementation",
        "Affects RSVP form customization workflow",
        "Custom attribute ordering depends on inheritance model",
        "ConfigService rewrite if deep-merge wins",
      ],
      resolved_by: null,
      resolution: null,
      resolution_date: null,
    },
    {
      id: "C-302",
      pod_id: "pod-emc-configs",
      created_at: "2026-04-17T08:30:00Z",
      status: "open",
      severity: "non_blocking",
      summary:
        "ConfigService cache: 5-minute TTL with deduplication vs. real-time invalidation via webhooks",
      sides: [
        {
          contributor: "be-agent-configs",
          position:
            "5-minute TTL cache with request deduplication and 2 retries on miss. Simple, predictable, already implemented. Config changes are infrequent (~3 times per day per scope) so a 5-minute delay is acceptable. Real-time invalidation adds infrastructure complexity (webhook registration, event bus, cache-key targeting).",
          context_update_id: "ctx-3007",
          timestamp: "2026-04-17T08:00:00Z",
        },
        {
          contributor: "fe-agent-configs",
          position:
            "Config changes should be visible immediately in the UI. An admin editing RSVP fields expects to see the changes reflected in the preview immediately, not up to 5 minutes later. At minimum, the editing user's session should invalidate its cache on write. Other users can tolerate the TTL.",
          context_update_id: "ctx-3008",
          timestamp: "2026-04-17T08:15:00Z",
        },
      ],
      master_analysis:
        "Non-blocking because the config CRUD endpoints work regardless of cache behavior. fe-agent-configs has a valid point about the editing UX. A pragmatic middle ground: keep the 5-minute TTL for cross-session reads, but add a write-through cache bust for the current user's session. This avoids the infrastructure overhead of webhooks while solving the immediate UX issue.",
      impact: [
        "Config editor UX for admins making changes",
        "No impact on end-user-facing config reads",
      ],
      resolved_by: null,
      resolution: null,
      resolution_date: null,
    },
  ],
};

// ── Pending Work (per conflict) ───────────────────────────────────────

/** Pending-work rows grouped by conflict id (demo seed). */
export const pendingWorkByConflictId: Record<string, PendingWork[]> = {
  "C-101": [
    {
      context_update_id: "ctx-1010",
      agent_id: "qa-agent-rbac",
      summary:
        "Wrote integration tests for TopNav permission gating using static users.json role lookups",
      presumes: "Position B (fe-agent-rbac: keep users.json as fallback)",
      rework_cost:
        "~3 hours to rewrite permission resolution mocks if static file is removed",
    },
  ],
  "C-102": [],
  "C-201": [
    {
      context_update_id: "ctx-2008",
      agent_id: "fe-agent-sessions",
      summary:
        "Built session creation form with naive datetime inputs and client-side UTC conversion via naiveDateTimeToUTCMillis()",
      presumes:
        "Position A (be-agent-sessions: API accepts UTC millis, frontend converts)",
      rework_cost:
        "~4 hours to refactor form to submit naive strings + timezone if API contract changes",
    },
  ],
  "C-202": [],
  "C-301": [
    {
      context_update_id: "ctx-3009",
      agent_id: "fe-agent-configs",
      summary:
        "Built config editor UI with full-config editing (no delta/overlay mode) assuming full-replace inheritance",
      presumes: "Position A (be-agent-configs: full-replace)",
      rework_cost:
        "~6 hours to add delta editing mode, diff viewer, and inherited-field indicators if deep-merge wins",
    },
  ],
  "C-302": [],
};

// ── Context Updates ───────────────────────────────────────────────────

export const contextUpdates: Record<string, ContextUpdate[]> = {
  "pod-emc-rbac": [
    {
      id: "ctx-1001",
      agent_id: "be-agent-rbac",
      timestamp: "2026-04-14T10:00:00Z",
      pod_id: "pod-emc-rbac",
      type: "decision",
      scope: "backend",
      summary: "Permission format: resource:action with wildcard support",
      details:
        "Decision: all permissions follow resource:action format. Wildcards supported (*:* for super-admin, event:* for full event access). Resources: event, series, session, cloud, config, integration, scope, group, role, user. Actions: read, write, delete, manage. Stored in role definitions and evaluated by a central hasPermission() utility.",
      artifacts: [{ type: "service", path: "src/lib/permissions.ts" }],
      status: "completed",
      blocks: [],
      blocked_by: [],
      needs_input_from: [],
    },
    {
      id: "ctx-1002",
      agent_id: "be-agent-rbac",
      timestamp: "2026-04-15T09:30:00Z",
      pod_id: "pod-emc-rbac",
      type: "progress",
      scope: "backend",
      summary:
        "ESP API GroupContext integration — groups, scopes, and roles fetched via x-adobe-esp-group-id header",
      details:
        "Implemented GroupContext provider that reads the selected group from sessionStorage, sends x-adobe-esp-group-id header on all API calls, and resolves the user's roles and scopes from the ESP API response. Scope hierarchy: platform > org > team. Group selection UI wired to sessionStorage for persistence.",
      artifacts: [
        { type: "component", path: "src/context/GroupContext.tsx" },
        { type: "api", path: "src/api/esp-groups.ts" },
      ],
      status: "completed",
      blocks: [],
      blocked_by: [],
      needs_input_from: [],
    },
    {
      id: "ctx-1003",
      agent_id: "fe-agent-rbac",
      timestamp: "2026-04-15T14:00:00Z",
      pod_id: "pod-emc-rbac",
      type: "progress",
      scope: "frontend",
      summary:
        "Permission gating implemented on TopNav tabs and Home cards",
      details:
        "TopNav tabs (Events, Sessions, Config, Admin) now conditionally render based on resolved permissions. Home dashboard cards check for resource:read before rendering stats. Uses usePermissions() hook backed by GroupContext. Falls back to domain-only permissions from users.json when role:read returns 403.",
      artifacts: [
        { type: "component", path: "src/components/TopNav.tsx" },
        { type: "component", path: "src/components/HomeCards.tsx" },
      ],
      status: "completed",
      blocks: [],
      blocked_by: [],
      needs_input_from: [],
    },
    {
      id: "ctx-1004",
      agent_id: "be-agent-rbac",
      timestamp: "2026-04-16T13:30:00Z",
      pod_id: "pod-emc-rbac",
      type: "progress",
      scope: "backend",
      summary:
        "Proposed full deprecation of static users.json — ESP API covers all role resolution",
      details:
        "Analyzed users.json vs. ESP API role mappings. Found 3 users with conflicting role definitions between the two systems. Static file has stale admin role for a user removed from the org 2 weeks ago. Recommending full migration to API-only role resolution to eliminate data drift.",
      artifacts: [
        { type: "api", path: "docs/rbac-migration-analysis.md" },
      ],
      status: "completed",
      blocks: [],
      blocked_by: [],
      needs_input_from: [
        {
          role: "frontend",
          question: "Can the 403 fallback work without users.json?",
        },
      ],
    },
    {
      id: "ctx-1005",
      agent_id: "fe-agent-rbac",
      timestamp: "2026-04-16T14:00:00Z",
      pod_id: "pod-emc-rbac",
      type: "progress",
      scope: "frontend",
      summary:
        "403 fallback path documented — 8% of staging first-logins hit role:read 403",
      details:
        "Instrumented the 403 fallback path in staging. 8% of first-time logins trigger role:read 403 because the ESP group sync hasn't completed yet. Current fallback reads users.json to resolve domain-only permissions (event:read, session:read). Without this, those users see a blank TopNav and empty Home page until group sync completes (typically 5-15 seconds, but up to 60 seconds for new org members).",
      artifacts: [
        { type: "api", path: "docs/403-fallback-staging-data.md" },
      ],
      status: "completed",
      blocks: [],
      blocked_by: [],
      needs_input_from: [],
    },
    {
      id: "ctx-1006",
      agent_id: "design-lead",
      timestamp: "2026-04-16T14:00:00Z",
      pod_id: "pod-emc-rbac",
      type: "spec_change",
      scope: "design",
      summary:
        "Updated Admin UI mockup: permission-aware Overview dashboard with gated stat cards",
      details:
        "Updated Figma mockup for the Overview dashboard. Stat cards (total events, active sessions, pending registrations) only render if user has the corresponding resource:read permission. Users without admin scope see a reduced dashboard with only their assigned events. Added loading skeleton for permission-resolution-in-progress state.",
      artifacts: [
        {
          type: "figma",
          url: "https://figma.com/file/emc-rbac/admin-overview-v2",
        },
      ],
      status: "completed",
      blocks: [],
      blocked_by: [],
      needs_input_from: [],
    },
    {
      id: "ctx-1008",
      agent_id: "fe-agent-rbac",
      timestamp: "2026-04-17T08:45:00Z",
      pod_id: "pod-emc-rbac",
      type: "question",
      scope: "frontend",
      summary:
        "Question: should 403 fallback grant domain-only read permissions or deny all?",
      details:
        "Need a decision on the fallback behavior. Current implementation grants event:read, session:read, config:read so users can browse while group sync completes. Alternative: deny all and show a loading/retry screen. The deny-all approach is more secure but produces a worse first-login experience. Asking backend team for security perspective.",
      artifacts: [],
      status: "in_progress",
      blocks: [],
      blocked_by: [],
      needs_input_from: [
        {
          role: "backend",
          question:
            "Security implications of granting read-only fallback permissions?",
        },
      ],
    },
    {
      id: "ctx-1009",
      agent_id: "be-agent-rbac",
      timestamp: "2026-04-17T09:00:00Z",
      pod_id: "pod-emc-rbac",
      type: "progress",
      scope: "backend",
      summary:
        "Recommends deny-all fallback with auto-retry — granting permissions without API confirmation is a security risk",
      details:
        "Responding to fe-agent-rbac's question. Granting any permissions on 403 means users who have been removed from a group could still access content if the API is slow or down. Recommend: show a loading state with 'Resolving permissions...' message, auto-retry role:read after 3 seconds (up to 3 attempts), then show an error with manual retry button. This keeps the security boundary clean.",
      artifacts: [],
      status: "completed",
      blocks: [],
      blocked_by: [],
      needs_input_from: [],
    },
  ],
  "pod-emc-sessions": [
    {
      id: "ctx-2001",
      agent_id: "be-agent-sessions",
      timestamp: "2026-04-14T11:00:00Z",
      pod_id: "pod-emc-sessions",
      type: "decision",
      scope: "backend",
      summary:
        "Session time storage: UTC millis for persistence, naive ISO strings for API transport with IANA timezone",
      details:
        "Decision: all session start/end times stored as UTC millis in the database. API responses include naive ISO datetime strings (e.g., '2026-06-15T09:00:00') plus an IANA timezone string (e.g., 'America/Los_Angeles'). Two utility functions: naiveDateTimeToUTCMillis(naive, tz) and millisToNaiveDateTimeString(millis, tz). This separates display concerns from storage concerns.",
      artifacts: [{ type: "service", path: "src/utils/timezone.ts" }],
      status: "completed",
      blocks: [],
      blocked_by: [],
      needs_input_from: [],
    },
    {
      id: "ctx-2002",
      agent_id: "design-sessions",
      timestamp: "2026-04-15T11:30:00Z",
      pod_id: "pod-emc-sessions",
      type: "spec_change",
      scope: "design",
      summary:
        "Session form mockup: naive datetime inputs with explicit venue timezone selector",
      details:
        "Figma mockup for session creation form. Start/end time inputs show the time as it appears at the venue (naive). A timezone dropdown defaults to the venue's IANA timezone (derived from locationId). Users can override the timezone if the session is virtual. Auto-registration toggle below the time inputs. Speaker assignment section with search and change detection.",
      artifacts: [
        {
          type: "figma",
          url: "https://figma.com/file/emc-sessions/session-form-v1",
        },
      ],
      status: "completed",
      blocks: [],
      blocked_by: [],
      needs_input_from: [],
    },
    {
      id: "ctx-2003",
      agent_id: "be-agent-sessions",
      timestamp: "2026-04-16T10:30:00Z",
      pod_id: "pod-emc-sessions",
      type: "progress",
      scope: "backend",
      summary:
        "Session CRUD API complete — all endpoints use UTC millis, timezone conversion utilities tested",
      details:
        "Implemented POST/GET/PUT/DELETE /sessions endpoints. Create and update accept UTC millis for start/end with IANA timezone string. Response includes both UTC millis and naive datetime strings for frontend convenience. Speaker assignment handled via speakerIds array with originalSpeakerIds for change detection. Optimistic concurrency via creationTime/modificationTime comparison. locationId references venue locations table.",
      artifacts: [
        { type: "api", path: "src/routes/sessions.ts" },
        { type: "service", path: "src/utils/timezone.ts" },
      ],
      status: "completed",
      blocks: [],
      blocked_by: [],
      needs_input_from: [
        {
          role: "frontend",
          question: "Will the form submit UTC millis or naive strings?",
        },
      ],
    },
    {
      id: "ctx-2004",
      agent_id: "fe-agent-sessions",
      timestamp: "2026-04-16T14:00:00Z",
      pod_id: "pod-emc-sessions",
      type: "progress",
      scope: "frontend",
      summary:
        "Session list view with timezone-aware display and venue location badges",
      details:
        "SessionListView renders sessions with venue-local times using millisToNaiveDateTimeString(). Each session row shows: title, naive start/end times, venue name badge, speaker count, auto-registration status icon. Sortable by start time (sorts on UTC millis). Pagination via cursor-based API.",
      artifacts: [
        { type: "component", path: "src/components/SessionListView.tsx" },
      ],
      status: "completed",
      blocks: [],
      blocked_by: [],
      needs_input_from: [],
    },
    {
      id: "ctx-2005",
      agent_id: "fe-agent-sessions",
      timestamp: "2026-04-16T16:20:00Z",
      pod_id: "pod-emc-sessions",
      type: "progress",
      scope: "frontend",
      summary:
        "Session creation form with naive datetime inputs — blocked on API contract for timezone conversion responsibility",
      details:
        "Session form has naive datetime inputs and venue timezone selector per design mockup. Speaker assignment with search and change detection (tracks originalSpeakerIds). Auto-registration toggle. Currently converting to UTC millis client-side before API call, but unsure if this is the agreed contract — backend API accepts UTC millis but design mockup implies the API should accept naive strings.",
      artifacts: [
        { type: "component", path: "src/components/SessionForm.tsx" },
      ],
      status: "in_progress",
      blocks: [],
      blocked_by: ["C-201"],
      needs_input_from: [],
    },
    {
      id: "ctx-2006",
      agent_id: "pm-configs",
      timestamp: "2026-04-16T15:00:00Z",
      pod_id: "pod-emc-sessions",
      type: "question",
      scope: "pm",
      summary:
        "Proposal: auto-registration should default ON for new sessions",
      details:
        "Based on data from the current EMC: 78% of sessions at Adobe events have auto-registration enabled. Defaulting it ON saves organizers a click and matches the majority use case. Organizers creating invite-only or capacity-limited sessions can turn it off.",
      artifacts: [],
      status: "completed",
      blocks: [],
      blocked_by: [],
      needs_input_from: [
        {
          role: "backend",
          question:
            "Any technical risk to defaulting auto-registration ON?",
        },
      ],
    },
    {
      id: "ctx-2007",
      agent_id: "be-agent-sessions",
      timestamp: "2026-04-16T15:15:00Z",
      pod_id: "pod-emc-sessions",
      type: "progress",
      scope: "backend",
      summary:
        "Recommends auto-registration default OFF — downstream webhook implications",
      details:
        "Responding to pm-configs. Auto-registration ON triggers a webhook to the registration service immediately on session create. If a session is created as a draft or accidentally, this creates registration records that require manual cleanup. The registration service has no 'undo' endpoint. Safer to default OFF and let organizers explicitly enable it when the session is finalized.",
      artifacts: [],
      status: "completed",
      blocks: [],
      blocked_by: [],
      needs_input_from: [],
    },
  ],
  "pod-emc-configs": [
    {
      id: "ctx-3001",
      agent_id: "be-agent-configs",
      timestamp: "2026-04-14T09:00:00Z",
      pod_id: "pod-emc-configs",
      type: "decision",
      scope: "backend",
      summary:
        "Three config types at scope level: RSVP form fields, Locales, Custom Attributes",
      details:
        "Decision: the config service manages three config types, all scoped to org or team level. (1) RSVP form fields: defines which fields appear on registration forms, with localization overlays for label/placeholder per locale. (2) Locales: list of supported locales for the scope with URL codes. (3) Custom Attributes: single-select, multi-select, or text input fields with ordered value lists. Each config type is independently versioned and cached.",
      artifacts: [{ type: "service", path: "src/types/config-types.ts" }],
      status: "completed",
      blocks: [],
      blocked_by: [],
      needs_input_from: [],
    },
    {
      id: "ctx-3002",
      agent_id: "be-agent-configs",
      timestamp: "2026-04-14T14:00:00Z",
      pod_id: "pod-emc-configs",
      type: "decision",
      scope: "backend",
      summary:
        "ConfigService singleton with 5-minute cache TTL, 2 retries, and request deduplication",
      details:
        "ConfigService is a singleton (one instance per server process). Caches resolved configs for 5 minutes. On cache miss, retries up to 2 times with 500ms backoff. Request deduplication: if multiple callers request the same config simultaneously, only one API call is made and the result is shared. Cache key: scope_type:scope_id:config_type.",
      artifacts: [
        { type: "service", path: "src/services/ConfigService.ts" },
      ],
      status: "completed",
      blocks: [],
      blocked_by: [],
      needs_input_from: [],
    },
    {
      id: "ctx-3003",
      agent_id: "be-agent-configs",
      timestamp: "2026-04-16T09:30:00Z",
      pod_id: "pod-emc-configs",
      type: "progress",
      scope: "backend",
      summary:
        "Config CRUD endpoints complete with full-replace inheritance — child scope completely replaces parent",
      details:
        "Implemented GET/POST/PUT/DELETE /configs/:scopeType/:scopeId/:configType. Inheritance: when resolving a config, the service checks team-level first; if not found, falls back to org-level. This is full-replace — a team config completely replaces the org config, no field-level merging. Permissions: config:read for GET, config:write for POST/PUT, config:delete for DELETE. All endpoints integrated with ConfigService cache.",
      artifacts: [
        { type: "api", path: "src/routes/configs.ts" },
        { type: "service", path: "src/services/ConfigService.ts" },
      ],
      status: "completed",
      blocks: [],
      blocked_by: [],
      needs_input_from: [],
    },
    {
      id: "ctx-3004",
      agent_id: "pm-configs",
      timestamp: "2026-04-16T09:45:00Z",
      pod_id: "pod-emc-configs",
      type: "spec_change",
      scope: "pm",
      summary:
        "PM requests deep-merge inheritance: team configs should only specify overrides, not duplicate all org fields",
      details:
        "Feedback from event organizer interviews: teams want to add 2-3 custom RSVP fields without re-specifying all 15 base fields from the org config. With full-replace, every team must copy the full org config and append their additions. When the org updates a base field (e.g., changes 'Company' label to 'Organization'), teams don't see the change unless they manually update their copy. Deep-merge would solve this.",
      artifacts: [],
      status: "completed",
      blocks: [],
      blocked_by: [],
      needs_input_from: [
        {
          role: "backend",
          question:
            "Feasibility of switching to deep-merge at this stage?",
        },
      ],
    },
    {
      id: "ctx-3005",
      agent_id: "fe-agent-configs",
      timestamp: "2026-04-15T16:00:00Z",
      pod_id: "pod-emc-configs",
      type: "progress",
      scope: "frontend",
      summary: "RSVP config editor with localization overlay UI",
      details:
        "Built the RSVP config editor. Users can add/remove/reorder form fields. Each field has a base label/placeholder and locale-specific overrides displayed in a tabbed overlay panel. Locale tabs are driven by the Locales config for the current scope. Custom Attributes editor shows single-select, multi-select, and text input types with drag-to-reorder value lists.",
      artifacts: [
        { type: "component", path: "src/components/RSVPConfigEditor.tsx" },
        {
          type: "component",
          path: "src/components/CustomAttributeEditor.tsx",
        },
      ],
      status: "completed",
      blocks: [],
      blocked_by: [],
      needs_input_from: [],
    },
    {
      id: "ctx-3006",
      agent_id: "be-agent-configs",
      timestamp: "2026-04-17T08:00:00Z",
      pod_id: "pod-emc-configs",
      type: "blocker",
      scope: "backend",
      summary:
        "Blocked on inheritance model decision — cannot proceed with config resolution refactor until C-301 is resolved",
      details:
        "If deep-merge wins, the ConfigService resolution logic needs a complete rewrite: (1) fetch both org and team configs, (2) deep-merge with team taking precedence, (3) handle ordered list merging for custom attribute values (append? replace? interleave?), (4) update cache invalidation to bust both scope levels when either changes. Estimated 2-3 days of work. Cannot start until the decision is made.",
      artifacts: [],
      status: "blocked",
      blocks: ["config-editor-qa"],
      blocked_by: ["C-301"],
      needs_input_from: [],
    },
    {
      id: "ctx-3007",
      agent_id: "be-agent-configs",
      timestamp: "2026-04-17T08:00:00Z",
      pod_id: "pod-emc-configs",
      type: "progress",
      scope: "backend",
      summary:
        "ConfigService cache: 5-minute TTL is sufficient for config read patterns",
      details:
        "Analyzed config read patterns from the existing EMC deployment. Configs are read ~500 times per minute across all scopes. Config writes happen ~3 times per day per scope. The 5-minute TTL means a worst-case 5-minute delay for config changes to propagate, which is acceptable given the write frequency. Real-time invalidation would require an event bus (SNS/SQS or WebSocket) which adds operational complexity.",
      artifacts: [
        { type: "api", path: "docs/config-cache-analysis.md" },
      ],
      status: "completed",
      blocks: [],
      blocked_by: [],
      needs_input_from: [],
    },
    {
      id: "ctx-3008",
      agent_id: "fe-agent-configs",
      timestamp: "2026-04-17T08:15:00Z",
      pod_id: "pod-emc-configs",
      type: "question",
      scope: "frontend",
      summary:
        "Request: config writes should immediately reflect in the editing user's UI",
      details:
        "When an admin saves RSVP config changes, the preview panel should show the updated config immediately — not after up to 5 minutes. Proposal: the POST/PUT response should return the saved config, and the frontend should update its local cache/state from the response. This doesn't require server-side cache invalidation — just a write-through pattern on the client.",
      artifacts: [],
      status: "in_progress",
      blocks: [],
      blocked_by: [],
      needs_input_from: [
        {
          role: "backend",
          question:
            "Can config write endpoints return the saved config in the response body?",
        },
      ],
    },
  ],
};

// ── Tunnels ───────────────────────────────────────────────────────────

export const tunnels: Record<string, Tunnel[]> = {
  "pod-emc-rbac": [
    {
      tunnel_id: "tun-101",
      pod_id: "pod-emc-rbac",
      dev_name: "priya",
      branch: "feat/rbac-permission-gating",
      url: "rbac-priya.emc.adobe.dev",
      status: "active",
      last_activity: "2026-04-17T10:50:00Z",
    },
    {
      tunnel_id: "tun-102",
      pod_id: "pod-emc-rbac",
      dev_name: "raj",
      branch: "feat/esp-group-context",
      url: "rbac-raj.emc.adobe.dev",
      status: "active",
      last_activity: "2026-04-17T09:35:00Z",
    },
  ],
  "pod-emc-sessions": [
    {
      tunnel_id: "tun-201",
      pod_id: "pod-emc-sessions",
      dev_name: "maria",
      branch: "feat/session-crud",
      url: "sessions-maria.emc.adobe.dev",
      status: "active",
      last_activity: "2026-04-16T16:30:00Z",
    },
    {
      tunnel_id: "tun-202",
      pod_id: "pod-emc-sessions",
      dev_name: "chen",
      branch: "feat/session-timezone",
      url: "sessions-chen.emc.adobe.dev",
      status: "idle",
      last_activity: "2026-04-16T12:00:00Z",
    },
  ],
  "pod-emc-configs": [
    {
      tunnel_id: "tun-301",
      pod_id: "pod-emc-configs",
      dev_name: "alex",
      branch: "feat/config-service",
      url: "configs-alex.emc.adobe.dev",
      status: "active",
      last_activity: "2026-04-17T08:20:00Z",
    },
  ],
};

// ── Org-Level Data ────────────────────────────────────────────────────

export const orgPods: OrgPodSummary[] = [
  {
    pod_id: "pod-emc-rbac",
    name: "RBAC Permission System",
    day_number: 4,
    total_days: 5,
    conflict_pressure: 0.65,
    open_conflicts: 2,
    active_tunnels: 2,
    agent_count: 4,
  },
  {
    pod_id: "pod-emc-sessions",
    name: "Session Management",
    day_number: 3,
    total_days: 5,
    conflict_pressure: 0.38,
    open_conflicts: 2,
    active_tunnels: 2,
    agent_count: 4,
  },
  {
    pod_id: "pod-emc-configs",
    name: "Scope Level Configs Service",
    day_number: 3,
    total_days: 5,
    conflict_pressure: 0.52,
    open_conflicts: 2,
    active_tunnels: 1,
    agent_count: 5,
  },
];

export const crossPodOverlaps: CrossPodOverlap[] = [
  {
    id: "overlap-001",
    pod_a: "RBAC Permission System",
    pod_b: "Scope Level Configs Service",
    description: "Permission gating on config endpoints",
    advisory:
      "Config CRUD endpoints (config:read, config:write, config:delete) depend on RBAC permission resolution being finalized. If RBAC changes the permission format or the 403 fallback behavior, config endpoints may need permission check updates.",
  },
  {
    id: "overlap-002",
    pod_a: "RBAC Permission System",
    pod_b: "Session Management",
    description: "Session permission checks",
    advisory:
      "Session management endpoints require session:read and session:write permissions from the RBAC system. Speaker assignment also checks user:read for speaker lookups. The RBAC pod's decision on static vs. API-driven roles affects how session permissions are resolved.",
  },
  {
    id: "overlap-003",
    pod_a: "Session Management",
    pod_b: "Scope Level Configs Service",
    description: "Locale configs for multi-language session support",
    advisory:
      "Sessions need locale configurations from the Configs service for multi-language event support. If the config inheritance model changes (full-replace vs. deep-merge), the resolved locale list for a session's scope may differ, affecting how session content is localized.",
  },
];

export const archivedPods: ArchivedPod[] = [
  {
    pod_id: "pod-emc-event-crud",
    name: "Event CRUD v1",
    completed_date: "2026-04-04",
    duration_days: 5,
    final_pressure: 0.15,
  },
  {
    pod_id: "pod-emc-registration",
    name: "Registration Forms v1",
    completed_date: "2026-03-28",
    duration_days: 5,
    final_pressure: 0.28,
  },
];

// ── Living Doc ────────────────────────────────────────────────────────

export const livingDocs: Record<string, string> = {
  "pod-emc-rbac": `# Pod: RBAC Permission System — Living Doc

## Pod Health
**Conflict Pressure:** 0.65 (Degraded) | **Day 4 of 5** | Sprint: Apr 14–18

## Active Milestone
**v0.1 — Permission Gating + Group Context** (Target: Apr 17) — 72% complete

## Current Status

| Area | Owner | Status | Last Update |
|------|-------|--------|-------------|
| Permission Gating UI | fe-agent-rbac | In Progress | Apr 17 |
| ESP API + GroupContext | be-agent-rbac | In Progress | Apr 17 |
| Admin Overview Mockup | design-lead | Done | Apr 16 |
| Integration Tests | qa-agent-rbac | Waiting | — |

## Open Conflicts

- **C-101:** Static users.json vs. ESP API-driven GroupContext — **BLOCKING**
- **C-102:** 403 fallback permissiveness — non-blocking

## Decisions Log

- **[Apr 14]** Permission format: resource:action with wildcard support (be-agent-rbac)
- **[Apr 16]** Admin UI mockup with permission-aware gated stat cards (design-lead)

## Context Stream (Recent)

- **[Apr 17 09:00]** be-agent-rbac: Recommends deny-all fallback with auto-retry
- **[Apr 17 08:45]** fe-agent-rbac: Question — 403 fallback scope for read permissions
- **[Apr 16 14:00]** fe-agent-rbac: 8% of staging first-logins hit 403 fallback path
- **[Apr 16 13:30]** be-agent-rbac: Proposed full deprecation of static users.json
- **[Apr 15 14:00]** fe-agent-rbac: Permission gating on TopNav tabs and Home cards
- **[Apr 15 09:30]** be-agent-rbac: ESP API GroupContext integration complete

## Active Tunnels

- 🟢 priya: feat/rbac-permission-gating → rbac-priya.emc.adobe.dev
- 🟢 raj: feat/esp-group-context → rbac-raj.emc.adobe.dev

## Cross-Pod Dependencies

- Config endpoints depend on RBAC permission resolution (config:read/write/delete)
- Session endpoints need session:read/session:write from RBAC
`,
  "pod-emc-sessions": `# Pod: Session Management — Living Doc

## Pod Health
**Conflict Pressure:** 0.38 (Cautious) | **Day 3 of 5** | Sprint: Apr 14–18

## Active Milestone
**v0.1 — Session CRUD + Timezone Handling** (Target: Apr 17) — 55% complete

## Current Status

| Area | Owner | Status | Last Update |
|------|-------|--------|-------------|
| Session Form + List | fe-agent-sessions | In Progress | Apr 16 |
| Session CRUD API | be-agent-sessions | In Progress | Apr 16 |
| Session Form Mockup | design-sessions | Done | Apr 15 |
| Session Tests | qa-agent-sessions | In Progress | Apr 16 |

## Open Conflicts

- **C-201:** Timezone handling — naive strings vs. UTC everywhere — **BLOCKING**
- **C-202:** Auto-registration default for new sessions — non-blocking

## Decisions Log

- **[Apr 14]** UTC millis for storage, naive ISO + IANA timezone for transport (be-agent-sessions)

## Context Stream (Recent)

- **[Apr 16 16:20]** fe-agent-sessions: Session form built — blocked on API timezone contract
- **[Apr 16 15:15]** be-agent-sessions: Recommends auto-registration default OFF
- **[Apr 16 15:00]** pm-configs: Proposes auto-registration default ON
- **[Apr 16 14:00]** fe-agent-sessions: Session list view with timezone-aware display
- **[Apr 16 10:30]** be-agent-sessions: Session CRUD API complete with UTC millis
- **[Apr 15 11:30]** design-sessions: Session form mockup with naive datetime inputs

## Active Tunnels

- 🟢 maria: feat/session-crud → sessions-maria.emc.adobe.dev
- 🟡 chen: feat/session-timezone → sessions-chen.emc.adobe.dev (idle)
`,
  "pod-emc-configs": `# Pod: Scope Level Configs Service — Living Doc

## Pod Health
**Conflict Pressure:** 0.52 (Cautious) | **Day 3 of 5** | Sprint: Apr 14–18

## Active Milestone
**v0.1 — Config CRUD + Inheritance Model** (Target: Apr 17) — 48% complete

## Current Status

| Area | Owner | Status | Last Update |
|------|-------|--------|-------------|
| Config Editor UI | fe-agent-configs | In Progress | Apr 16 |
| Config Service + API | be-agent-configs | Blocked | Apr 17 |
| Config Type Mockups | design-configs | Done | Apr 15 |
| Config Tests | qa-agent-configs | Waiting | — |
| Config Requirements | pm-configs | In Progress | Apr 16 |

## Open Conflicts

- **C-301:** Config inheritance — full-replace vs. deep-merge — **BLOCKING**
- **C-302:** Config cache TTL vs. real-time invalidation — non-blocking

## Decisions Log

- **[Apr 14]** Three config types: RSVP form fields, Locales, Custom Attributes (be-agent-configs)
- **[Apr 14]** ConfigService singleton: 5-min cache TTL, 2 retries, request dedup (be-agent-configs)

## Context Stream (Recent)

- **[Apr 17 08:15]** fe-agent-configs: Config writes should reflect immediately in editor UI
- **[Apr 17 08:00]** be-agent-configs: Blocked on inheritance model decision (C-301)
- **[Apr 17 08:00]** be-agent-configs: 5-min cache TTL analysis — sufficient for read patterns
- **[Apr 16 09:45]** pm-configs: Requests deep-merge inheritance for easier overrides
- **[Apr 16 09:30]** be-agent-configs: Config CRUD endpoints complete with full-replace inheritance
- **[Apr 15 16:00]** fe-agent-configs: RSVP config editor with localization overlays

## Active Tunnels

- 🟢 alex: feat/config-service → configs-alex.emc.adobe.dev

## Cross-Pod Dependencies

- Config endpoints gated by RBAC permissions (config:read/write/delete)
- Sessions pod needs Locales config for multi-language support
`,
};
