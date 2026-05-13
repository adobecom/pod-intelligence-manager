/**
 * Seeds the knowledge graph with realistic learnings from the two
 * archived EMC pods (Event CRUD v1, Registration Forms v1) so the
 * /knowledge UI has data to display out of the box.
 */

import type { EnhancedPodLearning } from "@pim/shared";
import { getGraph, addLearningsToGraph } from "../services/knowledge-graph.js";

// --- Event CRUD v1 (pod-emc-event-crud, completed 2026-04-04) ---

const eventCrudLearnings: EnhancedPodLearning[] = [
  {
    type: "decision",
    summary:
      "Use REST endpoints for event CRUD instead of GraphQL — simpler for the current team and aligns with ESP platform conventions",
    details:
      "Decision by be-agent-events: GraphQL was considered for flexibility but the team has stronger REST experience and the ESP platform's other services are REST-based. Standard REST endpoints: POST /events, GET /events/:id, PUT /events/:id, DELETE /events/:id. Query params for filtering/pagination on the list endpoint.",
    domains: ["backend"],
    confidence: "extracted",
    confidence_score: 0.9,
  },
  {
    type: "decision",
    summary:
      "Event status lifecycle: draft → published → active → completed → archived with explicit transitions",
    details:
      "Decision by be-agent-events: Events follow a strict status lifecycle. Each transition has validation rules (e.g., draft→published requires at least one session, published→active requires a start date in the past). Status transitions exposed as POST /events/:id/transition with the target status in the body. Invalid transitions return 422.",
    domains: ["backend", "pm"],
    confidence: "extracted",
    confidence_score: 0.9,
  },
  {
    type: "pattern",
    summary:
      "Optimistic concurrency via modificationTime prevents lost updates on concurrent event edits",
    details:
      "Implemented by be-agent-events: Every PUT /events/:id requires a modificationTime field matching the server's last-known value. If they differ, the update returns 409 Conflict with the current server state. The frontend shows a diff dialog allowing the user to merge or overwrite. This pattern prevents the classic 'last write wins' problem when two admins edit the same event.",
    domains: ["backend", "frontend"],
    confidence: "extracted",
    confidence_score: 0.9,
  },
  {
    type: "resolved_conflict",
    summary:
      "Event slug generation: auto-generated from title vs. user-specified — resolved: auto-generated with manual override",
    details:
      "Conflict between fe-agent-events (wanted user-specified slugs for SEO control) and be-agent-events (wanted auto-generation for consistency and uniqueness guarantee). Resolution: slugs are auto-generated from the event title using kebab-case + random suffix, but users can override the slug in the event settings. Uniqueness enforced at the database level.",
    domains: ["backend", "frontend"],
    confidence: "extracted",
    confidence_score: 0.9,
  },
  {
    type: "anti_pattern",
    summary:
      "Loading all event sessions in the event detail API response caused 4s load times for events with 200+ sessions",
    details:
      "Reported by qa-agent-events: The initial GET /events/:id response included a full sessions array. For large conferences with 200+ sessions, this payload was 1.5MB and took 4 seconds to parse client-side. Fixed by making sessions a separate paginated endpoint: GET /events/:id/sessions?page=1&limit=25. Event detail now loads in <200ms.",
    domains: ["backend", "frontend"],
    confidence: "extracted",
    confidence_score: 0.9,
  },
  {
    type: "pattern",
    summary:
      "Event cloning as a first-class API operation saves organizers from recreating recurring events",
    details:
      "Implemented by be-agent-events: POST /events/:id/clone creates a deep copy of an event including its config overrides (but not sessions or registrations). The clone is created in draft status with '(Copy)' appended to the title. Organizers use this for recurring annual events — clone last year's event and update dates/sessions.",
    domains: ["backend", "pm"],
    confidence: "extracted",
    confidence_score: 0.9,
  },
  {
    type: "scope_insight",
    summary:
      "Event creation-to-publish time is the key organizer productivity metric — target under 15 minutes",
    details:
      "Analysis by pm-lead: Tracking data from the existing EMC shows average event creation-to-publish time of 35 minutes. Most time is spent on session scheduling and RSVP form configuration. Reducing this to 15 minutes requires: (1) cloning from templates, (2) default configs at org level, (3) bulk session creation. These insights should inform the Sessions and Configs pods.",
    domains: ["pm"],
    confidence: "inferred",
    confidence_score: 0.75,
  },
  {
    type: "decision",
    summary:
      "Use Adobe IMS org_id as the tenant isolation boundary for all event data",
    details:
      "Decision by infra-agent-events: All event data is partitioned by IMS org_id. Every query includes org_id in the WHERE clause. Row-level security ensures one org cannot access another org's events even with a valid event ID. The org_id is extracted from the IMS token on every request.",
    domains: ["backend", "infra"],
    confidence: "extracted",
    confidence_score: 0.9,
  },
  {
    type: "anti_pattern",
    summary:
      "Client-side date validation without timezone awareness caused events to appear with wrong dates for cross-timezone organizers",
    details:
      "Reported by qa-agent-events: The event creation form validated dates using JavaScript Date() which uses the browser's local timezone. An organizer in PST creating a Tokyo event entered '2026-06-15' as the start date, but the API received '2026-06-14T07:00:00Z' due to timezone offset. Fix: all date inputs explicitly paired with timezone selector, validation runs against the event's timezone, not the browser's.",
    domains: ["frontend"],
    confidence: "extracted",
    confidence_score: 0.9,
  },
  {
    type: "pattern",
    summary:
      "Soft-delete with 30-day retention for events prevents accidental permanent data loss",
    details:
      "Implemented by be-agent-events: DELETE /events/:id sets a deleted_at timestamp and a purge_after date 30 days out. A nightly cleanup job permanently removes events past their purge_after date. Deleted events are excluded from all queries by default but can be listed via GET /events?include_deleted=true for recovery. Organizers have accidentally deleted events and this saved multiple incidents.",
    domains: ["backend"],
    confidence: "extracted",
    confidence_score: 0.9,
  },
];

// --- Registration Forms v1 (pod-emc-registration, completed 2026-03-28) ---

const registrationLearnings: EnhancedPodLearning[] = [
  {
    type: "decision",
    summary:
      "RSVP form fields defined as a JSON schema stored at scope level, rendered dynamically by a generic FormRenderer component",
    details:
      "Decision by be-agent-registration: Each RSVP form is a JSON schema defining field types, labels, placeholders, validation rules, and ordering. The schema is stored in the Configs service at the scope level. A generic FormRenderer component on the frontend interprets the schema and renders the form. This decouples form layout from code — organizers can customize forms without developer involvement.",
    domains: ["backend", "frontend"],
    confidence: "extracted",
    confidence_score: 0.9,
  },
  {
    type: "decision",
    summary:
      "Registration data stored separately from RSVP form schema — registrations are immutable once submitted",
    details:
      "Decision by be-agent-registration: Submitted registration records reference the form schema version they were submitted against. If the form schema changes after submission, existing registrations retain their original field values and validation. This prevents data integrity issues when organizers update forms mid-event.",
    domains: ["backend"],
    confidence: "extracted",
    confidence_score: 0.9,
  },
  {
    type: "pattern",
    summary:
      "Localization overlays on RSVP forms: base field definitions + per-locale label/placeholder overrides",
    details:
      "Implemented by fe-agent-registration: The RSVP form schema has a base layer (field types, ordering, validation rules) and per-locale overlays that override only label and placeholder strings. The FormRenderer selects the overlay matching the user's locale, falling back to the base layer. This keeps form structure consistent across locales while allowing full translation of user-facing text.",
    domains: ["frontend", "design"],
    confidence: "extracted",
    confidence_score: 0.9,
  },
  {
    type: "resolved_conflict",
    summary:
      "Registration confirmation: email-only vs. email + in-app notification — resolved: email always, in-app optional per event config",
    details:
      "Conflict between pm-lead (wanted in-app notification for all registrations for engagement) and be-agent-registration (wanted email-only for simplicity and reliability). Resolution: email confirmation is always sent via SES. In-app notification is configurable per event via a boolean in event config. Default: email-only. This avoids over-notifying attendees at events that don't use the in-app experience.",
    domains: ["backend", "pm"],
    confidence: "extracted",
    confidence_score: 0.9,
  },
  {
    type: "anti_pattern",
    summary:
      "Validating registration form submissions only on the frontend allowed invalid data to reach the database",
    details:
      "Reported by qa-agent-registration: Initial implementation validated RSVP form inputs only in the FormRenderer component. Direct API calls (e.g., from third-party integrations or curl) bypassed validation entirely. One test submission had an email field with 'not-an-email'. Fix: server-side validation against the JSON schema on every POST /registrations. Frontend validation is for UX only.",
    domains: ["backend", "frontend"],
    confidence: "extracted",
    confidence_score: 0.9,
  },
  {
    type: "pattern",
    summary:
      "Idempotent registration submissions using email + event_id composite key prevent duplicate registrations",
    details:
      "Implemented by be-agent-registration: POST /registrations uses a composite unique key of (email, event_id). If a duplicate is submitted, the endpoint returns the existing registration with a 200 (not 409) to gracefully handle double-clicks and page refreshes. The registration record is updated only if the form data differs (upsert semantics).",
    domains: ["backend"],
    confidence: "extracted",
    confidence_score: 0.9,
  },
  {
    type: "scope_insight",
    summary:
      "90% of registrations happen within 48 hours of event announcement — registration form load time is critical in that window",
    details:
      "Analysis by pm-lead: Data from existing EMC shows a sharp registration spike in the 48 hours after an event is announced via email blast. The registration form must handle burst traffic and load in under 2 seconds. This informed the decision to CDN-cache the form schema and pre-warm the registration API Lambda.",
    domains: ["pm", "infra"],
    confidence: "inferred",
    confidence_score: 0.7,
  },
  {
    type: "decision",
    summary:
      "Export registrations as CSV with configurable column mapping — no Excel format to avoid dependency",
    details:
      "Decision by be-agent-registration: Registration export uses CSV format with a column mapping configuration (which form fields become which CSV columns, in what order). Excel (.xlsx) was considered but requires a heavy library (exceljs) and most organizers import into Google Sheets anyway. CSV is universal and keeps the export Lambda fast.",
    domains: ["backend", "pm"],
    confidence: "extracted",
    confidence_score: 0.9,
  },
  {
    type: "anti_pattern",
    summary:
      "Rendering registration counts as a live counter on the event page caused N+1 query issues",
    details:
      "Reported by qa-agent-registration: The event list page showed a live registration count per event. Each event row triggered a separate COUNT query against the registrations table. For an org with 50 active events, this produced 50 queries per page load. Fix: maintain a registration_count column on the events table, updated via a database trigger on registration insert/delete.",
    domains: ["backend", "frontend"],
    confidence: "extracted",
    confidence_score: 0.9,
  },
  {
    type: "pattern",
    summary:
      "Registration form preview mode renders the form with sample data without creating records — essential for organizer testing",
    details:
      "Implemented by fe-agent-registration: The RSVP form editor includes a 'Preview' button that renders the FormRenderer in read-only mode with sample data. The preview uses the same rendering path as the live form but submits to a no-op endpoint. This lets organizers see exactly how their form will look before publishing, including locale overlays and custom attributes.",
    domains: ["frontend", "design"],
    confidence: "extracted",
    confidence_score: 0.9,
  },
];

export async function seedKnowledgeGraph(orgId: string): Promise<void> {
  const graph = getGraph(orgId);
  if (graph.nodes.length > 0) return; // Already seeded

  console.log(`[knowledge-graph] Seeding mock knowledge from archived EMC pods (org "${orgId}")...`);

  const result1 = await addLearningsToGraph(
    orgId,
    eventCrudLearnings,
    "pod-emc-event-crud",
    "Event CRUD v1",
  );
  console.log(
    `[knowledge-graph] Event CRUD v1: ${result1.nodesAdded} nodes, ${result1.edgesAdded} edges`,
  );

  const result2 = await addLearningsToGraph(
    orgId,
    registrationLearnings,
    "pod-emc-registration",
    "Registration Forms v1",
  );
  console.log(
    `[knowledge-graph] Registration Forms v1: ${result2.nodesAdded} nodes, ${result2.edgesAdded} edges`,
  );

  console.log(
    `[knowledge-graph] Seeding complete: ${graph.nodes.length} total nodes, ${graph.edges.length} total edges, ${graph.communities.length} communities`,
  );
}
