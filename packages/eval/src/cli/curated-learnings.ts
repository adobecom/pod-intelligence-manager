/**
 * Hand-curated subset of org learnings to inject as `relevantLearnings` per pod.
 * In production these come from `getRelevantLearnings(tokenBudget)` against the
 * knowledge graph (`packages/server/src/services/knowledge-graph.ts:350`).
 * For offline reproducibility we hard-code the subset that a relevance query
 * keyed on each pod's milestone would return — same shape, no DB required.
 */

interface LearningNode {
  type: string;
  summary: string;
  details: string;
  domains: string[];
  confidence_score: number;
  source_pod_name?: string;
}

interface LearningResult {
  nodes: LearningNode[];
  total_matching: number;
  truncated: boolean;
}

const EVENT_CRUD = "Event CRUD v1";
const REGISTRATION = "Registration Forms v1";

const RBAC_LEARNINGS: LearningNode[] = [
  {
    type: "decision",
    summary:
      "Use Adobe IMS org_id as the tenant isolation boundary for all event data",
    details:
      "All event data is partitioned by IMS org_id. Every query includes org_id in the WHERE clause. Row-level security ensures one org cannot access another org's events even with a valid event ID. The org_id is extracted from the IMS token on every request.",
    domains: ["backend", "infra"],
    confidence_score: 0.9,
    source_pod_name: EVENT_CRUD,
  },
  {
    type: "decision",
    summary:
      "Use REST endpoints for event CRUD instead of GraphQL — aligns with ESP platform conventions",
    details:
      "Decision: REST chosen over GraphQL because the team has stronger REST experience and the ESP platform's other services are REST-based. Standard REST endpoints with query params for filtering/pagination.",
    domains: ["backend"],
    confidence_score: 0.9,
    source_pod_name: EVENT_CRUD,
  },
  {
    type: "anti_pattern",
    summary:
      "Validating registration form submissions only on the frontend allowed invalid data through",
    details:
      "Direct API calls (third-party integrations, curl) bypassed FE-only validation. Fix: server-side validation against the JSON schema on every POST. Frontend validation is for UX only.",
    domains: ["backend", "frontend"],
    confidence_score: 0.9,
    source_pod_name: REGISTRATION,
  },
];

const EMC_ESP = "EMC ESP Integration v1";

const SESSIONS_LEARNINGS: LearningNode[] = [
  {
    type: "decision",
    summary:
      "ESP event-speaker PUT body contract is { speakerId, speakerType, ordinal, creationTime, modificationTime } and nothing else",
    details:
      "Per ESP OpenAPI, /v1/events/:eventId/speakers/:speakerId PUT accepts only those five fields. Echoing the full GET response (spreading dependentData) fails server-side validation and has been the root cause of repeated 400s on edit. When using callWithDependency's body-builder, fall back to dependentData per-field: body.X ?? dependentData.X. creationTime and modificationTime are server-issued; do not let callers override them. The same pattern applies to all ESP PUTs on speaker resources.",
    domains: ["frontend", "backend"],
    confidence_score: 0.95,
    source_pod_name: EMC_ESP,
  },
  {
    type: "pattern",
    summary:
      "Session-time helpers must return SessionTimeInfo so React state can update without a page refresh",
    details:
      "createSessionTimeForSession and upsertSessionTimeForSession previously returned Promise<void>, which dropped the API's sessionTimeId, creationTime, and modificationTime on the floor. Calling components could not update local state with the new optimistic-concurrency values, so users saw stale data and had to refresh the page after every session-time edit. Fix is to return the API response from both helpers and have handleAddSession / handleUpdateSession capture and propagate sessionTimeId + creationTime + modificationTime into local React session state. This is the EMC-wide convention for any API helper that yields server-issued timestamps.",
    domains: ["frontend"],
    confidence_score: 0.9,
    source_pod_name: EMC_ESP,
  },
  {
    type: "anti_pattern",
    summary:
      "Spreading a GET response back into an ESP PUT body trips readOnly.openapi.validation",
    details:
      "ESP marks several fields as read-only on PUT (e.g. targetCms on /v1/series/:id). Series unpublish / archive / external-update flows previously echoed the full GET response into the PUT body, which fails ESP's OpenAPI validator with readOnly.openapi.validation. Fix: always filter the payload through the resource-specific prepareEsp*PutPayload helper before PUT. For series use prepareEspSeriesPutPayload (wraps filterSeriesData in 'update' mode). For events use prepareEslEventPutPayload. New ESP PUT endpoints should add a sibling helper in utils/dataFilters.ts before the call site is added.",
    domains: ["frontend"],
    confidence_score: 0.95,
    source_pod_name: EMC_ESP,
  },
  {
    type: "decision",
    summary:
      "Per-resource PUT payload sanitizers live in utils/dataFilters.ts and follow prepareEsp{Resource}PutPayload naming",
    details:
      "Convention adopted across the EMC frontend: every ESP PUT endpoint has a corresponding prepareEsp{Resource}PutPayload function in web-src/src/utils/dataFilters.ts that calls filterSeriesData (or the resource-specific equivalent) in 'update' mode. This centralizes read-only-field stripping and ensures unpublish, archive, and external-update flows all go through the same validation layer. Do not invent ad-hoc filtering at the call site.",
    domains: ["frontend"],
    confidence_score: 0.9,
    source_pod_name: EMC_ESP,
  },
  {
    type: "pattern",
    summary:
      "ESP resources use modificationTime for optimistic concurrency on PUT; clients must round-trip it",
    details:
      "Every ESP PUT on an updatable resource (event, series, session, speaker) requires the modificationTime field to match the server's last-known value. If they differ, PUT returns 409 with the current server state. Clients must therefore: (a) capture modificationTime on every GET, (b) send it back unchanged on the next PUT, (c) re-fetch on 409 and merge. Dropping or recomputing modificationTime client-side is the most common cause of silent edit failures on EMC.",
    domains: ["frontend", "backend"],
    confidence_score: 0.95,
    source_pod_name: EMC_ESP,
  },
];

const CONFIGS_LEARNINGS: LearningNode[] = [
  {
    type: "decision",
    summary:
      "RSVP form fields defined as a JSON schema stored at scope level, rendered by a generic FormRenderer component",
    details:
      "Form schema (field types, labels, placeholders, validation, ordering) is stored at the scope level in the Configs service. A generic FormRenderer interprets the schema and renders the form. Decouples form layout from code so organizers can customize without developer involvement.",
    domains: ["backend", "frontend"],
    confidence_score: 0.9,
    source_pod_name: REGISTRATION,
  },
  {
    type: "pattern",
    summary:
      "Localization overlays on RSVP forms: base field definitions + per-locale label/placeholder overrides",
    details:
      "Form schema has a base layer (field types, ordering, validation) and per-locale overlays that override only label and placeholder strings. FormRenderer selects the overlay matching the user's locale, falling back to the base layer.",
    domains: ["frontend", "design"],
    confidence_score: 0.9,
    source_pod_name: REGISTRATION,
  },
  {
    type: "decision",
    summary:
      "Registration data stored separately from RSVP form schema — registrations are immutable once submitted",
    details:
      "Submitted registration records reference the form schema version they were submitted against. If the form schema changes after submission, existing registrations retain their original field values and validation.",
    domains: ["backend"],
    confidence_score: 0.9,
    source_pod_name: REGISTRATION,
  },
];

const BY_POD: Record<string, LearningNode[]> = {
  "pod-emc-rbac": RBAC_LEARNINGS,
  "pod-emc-sessions": SESSIONS_LEARNINGS,
  "pod-emc-configs": CONFIGS_LEARNINGS,
};

export function getCuratedLearnings(podId: string): LearningResult {
  const nodes = BY_POD[podId] ?? [];
  return { nodes, total_matching: nodes.length, truncated: false };
}
