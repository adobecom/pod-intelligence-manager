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

const SESSIONS_LEARNINGS: LearningNode[] = [
  {
    type: "anti_pattern",
    summary:
      "Client-side date validation without timezone awareness caused events to appear with wrong dates for cross-timezone organizers",
    details:
      "JavaScript Date() uses the browser's local timezone. An organizer in PST creating a Tokyo event entered '2026-06-15' but the API received '2026-06-14T07:00:00Z' due to offset. Fix: pair every date input with an explicit timezone selector and validate against the event's timezone, not the browser's.",
    domains: ["frontend"],
    confidence_score: 0.9,
    source_pod_name: EVENT_CRUD,
  },
  {
    type: "pattern",
    summary:
      "Optimistic concurrency via modificationTime prevents lost updates on concurrent edits",
    details:
      "Every PUT requires a modificationTime field matching the server's last-known value. If they differ, the update returns 409 with the current server state. The frontend shows a diff dialog allowing merge or overwrite.",
    domains: ["backend", "frontend"],
    confidence_score: 0.9,
    source_pod_name: EVENT_CRUD,
  },
  {
    type: "decision",
    summary:
      "Event status lifecycle: draft → published → active → completed → archived with explicit transitions",
    details:
      "Each transition has validation rules (e.g., draft→published requires at least one session). Status transitions exposed as POST /:id/transition. Invalid transitions return 422.",
    domains: ["backend", "pm"],
    confidence_score: 0.9,
    source_pod_name: EVENT_CRUD,
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
