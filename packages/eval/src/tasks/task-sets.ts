/**
 * Named task sets for the eval framework.
 *
 * The primary set is the only default eval set. Diagnostic and excluded tasks
 * remain available by explicit ID/tag, but should not be blended into headline
 * comparisons.
 */

export const PRIMARY_15_TASK_IDS = [
  "real-emc-datatable-horizontal-edge-scroll",
  "real-emc-event-form-route-with-event-id",
  "real-emc-event-mod-time-sync-after-session",
  "real-emc-event-put-omit-detail-page-path",
  "real-emc-partner-put-sponsor-id-payload",
  "real-emc-ppn-ack-hydration",
  "real-emc-ppn-explicit-select",
  "real-emc-rbac-events-dashboard-gating",
  "real-emc-rte-quill-semantic-html",
  "real-emc-s2-tabs-crash-segmented-control",
  "real-emc-scope-group-my-filter",
  "real-emc-series-form-footer-alignment",
  "real-emc-session-api-batch-optimisation",
  "real-emc-session-api-error-toast",
  "real-emc-speaker-image-cache-invalidate",
] as const;

/**
 * New realistic-ticket KG headline slice.
 *
 * These are future-similar EMC issues derived from reviewed KG learnings rather
 * than historical PR replay. All tasks are point-in-time anchored after the
 * frozen KG node timestamps and include `kgExpectations` so the materiality gate
 * can prove the required learning survived asOf scoping.
 */
export const KG_FUTURE_20_TASK_IDS = [
  "future-emc-event-moderator-put-contract",
  "future-emc-session-track-put-sanitizer",
  "future-emc-breakout-time-response-state",
  "future-emc-rsvp-contact-methods-put",
  "future-emc-detail-page-path-filter-toggle",
  "future-emc-event-wizard-step-grouping",
  "future-emc-agenda-switcher-segmented-control",
  "future-emc-rich-text-semantic-export",
  "future-emc-prod-publish-confirmation",
  "future-emc-ppn-explicit-no-choice",
  "future-emc-speaker-photo-hydration-join",
  "future-emc-show-sponsors-default",
  "future-emc-events-dashboard-permission-filter",
  "future-emc-invite-only-rsvp-state",
  "future-emc-campaign-capacity-decision",
  "future-emc-rsvp-boolean-field-display",
  "future-emc-ticket-requirement-field-map",
  "future-emc-sessions-hub-search-scope",
  "future-emc-session-location-overlap",
  "future-emc-partner-tier-reorder",
] as const;

export const KG_FUTURE_20_TASK_REASONS = {
  "future-emc-event-moderator-put-contract":
    "API contract transfer: apply event-speaker narrow PUT body learning to a future event-moderator association.",
  "future-emc-session-track-put-sanitizer":
    "Stale-trap/API contract: choose per-resource PUT sanitizer and avoid read-only targetCms on a new session-track resource.",
  "future-emc-breakout-time-response-state":
    "State update convention: apply SessionTimeInfo response merge so saved breakout times refresh without page reload.",
  "future-emc-rsvp-contact-methods-put":
    "Required helper: use prepareContactMethodsForPut instead of spreading attendee GET contactMethods into PUT.",
  "future-emc-detail-page-path-filter-toggle":
    "Stale-trap: do not omit detailPagePath; toggle dataFilters submittable when title-driven saves need page-path updates.",
  "future-emc-event-wizard-step-grouping":
    "UI convention: preserve EMC's four-step EventForm grouping with the five-section first step.",
  "future-emc-agenda-switcher-segmented-control":
    "UI anti-pattern: avoid Spectrum 2 Tabs crash by choosing SegmentedControl plus conditional rendering.",
  "future-emc-rich-text-semantic-export":
    "Library convention: export Quill content via getSemanticHTML and normalize NBSP variants.",
  "future-emc-prod-publish-confirmation":
    "Environment-sensitive UI policy: require AlertDialog confirmation before production publish only.",
  "future-emc-ppn-explicit-no-choice":
    "Form-state convention: preserve explicit PPN No selections via the no-${fieldKey} sentinel.",
  "future-emc-speaker-photo-hydration-join":
    "Hydration pattern: attach speaker photos by joining separately loaded image records.",
  "future-emc-show-sponsors-default":
    "Boolean default convention: showSponsors defaults true on create and uses nullish fallback on load.",
  "future-emc-events-dashboard-permission-filter":
    "RBAC convention: wildcard resource permissions and 403 domain fallback should keep Events dashboard readable.",
  "future-emc-invite-only-rsvp-state":
    "Registration UI convention: invite-only events without campaign links show text instead of a disabled RSVP button.",
  "future-emc-campaign-capacity-decision":
    "Registration API policy: campaign capacity and waitlist rules take precedence before attendee creation.",
  "future-emc-rsvp-boolean-field-display":
    "Config convention: RSVP boolean metadata renders as Yes/No in UI and CSV surfaces.",
  "future-emc-ticket-requirement-field-map":
    "Stale field-name trap: map old requiresSxswTicket to canonical ESL requiresTicket.",
  "future-emc-sessions-hub-search-scope":
    "Search convention: sessions hub defaults to title, speaker names, and tag labels, with description as opt-in.",
  "future-emc-session-location-overlap":
    "Validation convention: frontend location-time overlap checks use UTC millisecond interval comparisons.",
  "future-emc-partner-tier-reorder":
    "Ordering convention: role/tier changes move to the end of the new group and recompute ordinals per group.",
} as const;

export const DIAGNOSTIC_TASK_IDS = [
  // Synthetic smoke/code-gen tasks.
  "config-cache-bust",
  "config-deep-merge",
  "event-create-rest",
  "form-localization",
  "rbac-403-fallback",
  "rbac-permission-resolution",
  "session-create-timezone",
  "session-render-time",

  // PIM/content-generation diagnostics.
  "config-decision-writeup",
  "memory-current-vs-stale",
  "memory-why-changed",
  "progress-update-permissions",
  "rbac-decision-rationale",
  "session-blocker-summary",

  // Non-primary real-EMC diagnostics.
  "real-emc-detail-page-path-put",
  "real-emc-include-partners-toggle",
  "real-emc-prod-publish-confirmation",
  "real-emc-series-put-readonly-targetcms",
  "real-emc-session-location-time-overlap",
  "real-emc-session-time-no-refresh",
  "real-emc-sxsw-ticket-field-config-service",

  // S6 archaeology diagnostics.
  "arch-delete-scope-blast-radius",
  "arch-event-form-render-flow",
  "arch-impact-of-removing-detail-page-path",
  "arch-rbac-permission-check-callsites",
  "arch-where-is-modification-time-set",
  "arch-who-consumes-use-group-hook",

  // Synthetic context-stress diagnostics.
  "synth-event-speaker-put-contract-context",
  "synth-session-time-response-state",
  "synth-registration-locale-overlay",
  "synth-event-route-after-create",
  "synth-session-speaker-sync-plan",
  "synth-series-put-update-plan",
  "synth-event-sort-negative-control",
] as const;

export const EXCLUDED_TASK_IDS = [
  "real-emc-attendee-export-csv-enhancements",
  "real-emc-attendee-registered-date-column",
  "real-emc-campaign-csv-export-helper",
  "real-emc-dashboard-publish-omit-invite-only",
  "real-emc-declined-rsvp-status",
  "real-emc-event-speaker-put-contract-vague",
  "real-emc-event-speaker-put-contract",
  "real-emc-event-title-max-length",
  "real-emc-event-type-config-hide-marketo-webinar",
  "real-emc-scope-group-name-match-show-members",
  "real-emc-series-mod-time-resilience",
  "real-emc-session-tag-placement",
  "real-emc-session-unsaved-changes-dialog",
  "real-emc-speaker-image-upload-defer",
  "real-emc-speaker-type-mapping-hotfix",
  "real-emc-venue-image-separation",
] as const;

/**
 * Hand-reviewed subset for the KG-decisive experiment.
 *
 * These are intentionally not inferred from tags alone: each entry names a
 * non-obvious learning shape the KG arm should surface and the control arm
 * should not reasonably infer from the prompt by itself.
 */
export const KG_DECISIVE_TASK_REASONS = {
  "real-emc-event-put-omit-detail-page-path":
    "ESP/ESL PUT payload contract: KG should name the detailPagePath omit rule and allowlist removal.",
  "real-emc-partner-put-sponsor-id-payload":
    "ESP sponsor PUT contract: KG should identify sponsorId, modificationTime, and locale merge behavior.",
  "real-emc-ppn-ack-hydration":
    "Prior hydration race pattern: KG should point to the pending backfill shape instead of counter gating.",
  "real-emc-rbac-events-dashboard-gating":
    "RBAC convention: KG should name useHasPermission and separate event/write from event/delete.",
  "real-emc-rte-quill-semantic-html":
    "UI editor house-style/API learning: KG should steer from innerHTML to getSemanticHTML and formats narrowing.",
  "real-emc-s2-tabs-crash-segmented-control":
    "Known Spectrum 2 failure mode: KG should identify SegmentedControl as the replacement despite off-scope tags.",
  "real-emc-session-api-batch-optimisation":
    "Prior redundant-roundtrip learning: KG should identify passing known speaker IDs through the save path.",
  "real-emc-speaker-image-cache-invalidate":
    "Cache invalidation recipe: KG should name tracking the removed image id through submit.",
} as const;

export const KG_DECISIVE_TASK_IDS = Object.keys(KG_DECISIVE_TASK_REASONS) as Array<keyof typeof KG_DECISIVE_TASK_REASONS>;

/**
 * Diagnostic splits for the current KG-decisive candidate bank. These are not
 * headline sets; they keep known confounds separate after a pilot.
 */
export const KG_NEGATIVE_CONTROL_TASK_IDS = [
  "real-emc-rte-quill-semantic-html",
  "real-emc-s2-tabs-crash-segmented-control",
] as const;

export const KG_LIC_FAVORABLE_TASK_IDS = [
  "real-emc-ppn-ack-hydration",
  "real-emc-rte-quill-semantic-html",
  "real-emc-s2-tabs-crash-segmented-control",
  "real-emc-session-api-batch-optimisation",
  "real-emc-speaker-image-cache-invalidate",
] as const;

export const KG_CONTROL_SOLVABLE_TASK_IDS = [
  "real-emc-rte-quill-semantic-html",
  "real-emc-partner-put-sponsor-id-payload",
  "real-emc-session-api-batch-optimisation",
  "real-emc-speaker-image-cache-invalidate",
] as const;
