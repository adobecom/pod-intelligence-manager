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

