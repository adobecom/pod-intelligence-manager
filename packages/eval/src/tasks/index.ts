import type { Task } from "./types.js";
import {
  DIAGNOSTIC_TASK_IDS,
  EXCLUDED_TASK_IDS,
  PRIMARY_15_TASK_IDS,
} from "./task-sets.js";

// Primary designated eval set.
import { datatableHorizontalEdgeScroll } from "./primary/real-emc/datatable-horizontal-edge-scroll.js";
import { eventFormRouteWithEventId } from "./primary/real-emc/event-form-route-with-event-id.js";
import { eventModTimeSyncAfterSession } from "./primary/real-emc/event-mod-time-sync-after-session.js";
import { eventPutOmitDetailPagePath } from "./primary/real-emc/event-put-omit-detail-page-path.js";
import { partnerPutSponsorIdPayload } from "./primary/real-emc/partner-put-sponsor-id-payload.js";
import { ppnAckHydration } from "./primary/real-emc/ppn-ack-hydration.js";
import { ppnExplicitSelect } from "./primary/real-emc/ppn-explicit-select.js";
import { rbacEventsDashboardGating } from "./primary/real-emc/rbac-events-dashboard-gating.js";
import { rteQuillSemanticHtml } from "./primary/real-emc/rte-quill-semantic-html.js";
import { s2TabsCrashSegmentedControl } from "./primary/real-emc/s2-tabs-crash-segmented-control.js";
import { scopeGroupMyFilter } from "./primary/real-emc/scope-group-my-filter.js";
import { seriesFormFooterAlignment } from "./primary/real-emc/series-form-footer-alignment.js";
import { sessionApiBatchOptimisation } from "./primary/real-emc/session-api-batch-optimisation.js";
import { sessionApiErrorToast } from "./primary/real-emc/session-api-error-toast.js";
import { speakerImageCacheInvalidate } from "./primary/real-emc/speaker-image-cache-invalidate.js";

// Diagnostics: smoke/code-gen.
import { configCacheBust } from "./diagnostics/code-gen/config-cache-bust.js";
import { configDeepMerge } from "./diagnostics/code-gen/config-deep-merge.js";
import { eventCreateRest } from "./diagnostics/code-gen/event-create-rest.js";
import { formLocalization } from "./diagnostics/code-gen/form-localization.js";
import { rbac403Fallback } from "./diagnostics/code-gen/rbac-403-fallback.js";
import { rbacPermissionResolution } from "./diagnostics/code-gen/rbac-permission-resolution.js";
import { sessionCreateTimezone } from "./diagnostics/code-gen/session-create-timezone.js";
import { sessionRenderTime } from "./diagnostics/code-gen/session-render-time.js";

// Diagnostics: content/PIM.
import { configDecisionWriteup } from "./diagnostics/content-gen/config-decision-writeup.js";
import { progressUpdatePermissions } from "./diagnostics/content-gen/progress-update-permissions.js";
import { rbacDecisionRationale } from "./diagnostics/content-gen/rbac-decision-rationale.js";
import { sessionBlockerSummary } from "./diagnostics/content-gen/session-blocker-summary.js";

// Diagnostics: non-primary real-EMC tasks.
import { detailPagePathPut } from "./diagnostics/real-emc/detail-page-path-put.js";
import { includePartnersToggle } from "./diagnostics/real-emc/include-partners-toggle.js";
import { prodPublishConfirmation } from "./diagnostics/real-emc/prod-publish-confirmation.js";
import { seriesPutReadonlyTargetCms } from "./diagnostics/real-emc/series-put-readonly-targetcms.js";
import { sessionLocationTimeOverlap } from "./diagnostics/real-emc/session-location-time-overlap.js";
import { sessionTimeNoRefresh } from "./diagnostics/real-emc/session-time-no-refresh.js";
import { sxswTicketFieldConfigService } from "./diagnostics/real-emc/sxsw-ticket-field-config-service.js";

// Diagnostics: archaeology.
import { deleteScopeBlastRadius } from "./diagnostics/archaeology/delete-scope-blast-radius.js";
import { eventFormRenderFlow } from "./diagnostics/archaeology/event-form-render-flow.js";
import { impactOfRemovingDetailPagePath } from "./diagnostics/archaeology/impact-of-removing-detail-page-path.js";
import { rbacPermissionCheckCallsites } from "./diagnostics/archaeology/rbac-permission-check-callsites.js";
import { whereIsModificationTimeSet } from "./diagnostics/archaeology/where-is-modification-time-set.js";
import { whoConsumesUseGroupHook } from "./diagnostics/archaeology/who-consumes-use-group-hook.js";

// Diagnostics: synthetic context-stress.
import { synthEventRouteAfterCreate } from "./diagnostics/synthetic-context/event-route-after-create.js";
import { synthEventSortNegativeControl } from "./diagnostics/synthetic-context/event-sort-negative-control.js";
import { synthEventSpeakerPutContractContext } from "./diagnostics/synthetic-context/event-speaker-put-contract-context.js";
import { synthRegistrationLocaleOverlay } from "./diagnostics/synthetic-context/registration-locale-overlay.js";
import { synthSeriesPutUpdatePlan } from "./diagnostics/synthetic-context/series-put-update-plan.js";
import { synthSessionSpeakerSyncPlan } from "./diagnostics/synthetic-context/session-speaker-sync-plan.js";
import { synthSessionTimeResponseState } from "./diagnostics/synthetic-context/session-time-response-state.js";

// Explicitly excluded/superseded tasks.
import { attendeeExportCsvEnhancements } from "./excluded/real-emc/attendee-export-csv-enhancements.js";
import { attendeeRegisteredDateColumn } from "./excluded/real-emc/attendee-registered-date-column.js";
import { campaignCsvExportHelper } from "./excluded/real-emc/campaign-csv-export-helper.js";
import { dashboardPublishOmitInviteOnly } from "./excluded/real-emc/dashboard-publish-omit-invite-only.js";
import { declinedRsvpStatus } from "./excluded/real-emc/declined-rsvp-status.js";
import { eventSpeakerPutContractVague } from "./excluded/real-emc/event-speaker-put-contract-vague.js";
import { eventSpeakerPutContract } from "./excluded/real-emc/event-speaker-put-contract.js";
import { eventTitleMaxLength } from "./excluded/real-emc/event-title-max-length.js";
import { eventTypeConfigHideMarketoWebinar } from "./excluded/real-emc/event-type-config-hide-marketo-webinar.js";
import { scopeGroupNameMatchShowMembers } from "./excluded/real-emc/scope-group-name-match-show-members.js";
import { seriesModTimeResilience } from "./excluded/real-emc/series-mod-time-resilience.js";
import { sessionTagPlacement } from "./excluded/real-emc/session-tag-placement.js";
import { sessionUnsavedChangesDialog } from "./excluded/real-emc/session-unsaved-changes-dialog.js";
import { speakerImageUploadDefer } from "./excluded/real-emc/speaker-image-upload-defer.js";
import { speakerTypeMappingHotfix } from "./excluded/real-emc/speaker-type-mapping-hotfix.js";
import { venueImageSeparation } from "./excluded/real-emc/venue-image-separation.js";

export const ALL_TASKS: Task[] = [
  datatableHorizontalEdgeScroll,
  eventFormRouteWithEventId,
  eventModTimeSyncAfterSession,
  eventPutOmitDetailPagePath,
  partnerPutSponsorIdPayload,
  ppnAckHydration,
  ppnExplicitSelect,
  rbacEventsDashboardGating,
  rteQuillSemanticHtml,
  s2TabsCrashSegmentedControl,
  scopeGroupMyFilter,
  seriesFormFooterAlignment,
  sessionApiBatchOptimisation,
  sessionApiErrorToast,
  speakerImageCacheInvalidate,

  configCacheBust,
  configDeepMerge,
  eventCreateRest,
  formLocalization,
  rbac403Fallback,
  rbacPermissionResolution,
  sessionCreateTimezone,
  sessionRenderTime,
  configDecisionWriteup,
  progressUpdatePermissions,
  rbacDecisionRationale,
  sessionBlockerSummary,
  detailPagePathPut,
  includePartnersToggle,
  prodPublishConfirmation,
  seriesPutReadonlyTargetCms,
  sessionLocationTimeOverlap,
  sessionTimeNoRefresh,
  sxswTicketFieldConfigService,
  deleteScopeBlastRadius,
  eventFormRenderFlow,
  impactOfRemovingDetailPagePath,
  rbacPermissionCheckCallsites,
  whereIsModificationTimeSet,
  whoConsumesUseGroupHook,
  synthEventSpeakerPutContractContext,
  synthSessionTimeResponseState,
  synthRegistrationLocaleOverlay,
  synthEventRouteAfterCreate,
  synthSessionSpeakerSyncPlan,
  synthSeriesPutUpdatePlan,
  synthEventSortNegativeControl,

  attendeeExportCsvEnhancements,
  attendeeRegisteredDateColumn,
  campaignCsvExportHelper,
  dashboardPublishOmitInviteOnly,
  declinedRsvpStatus,
  eventSpeakerPutContractVague,
  eventSpeakerPutContract,
  eventTitleMaxLength,
  eventTypeConfigHideMarketoWebinar,
  scopeGroupNameMatchShowMembers,
  seriesModTimeResilience,
  sessionTagPlacement,
  sessionUnsavedChangesDialog,
  speakerImageUploadDefer,
  speakerTypeMappingHotfix,
  venueImageSeparation,
];

const TASKS_BY_ID = new Map(ALL_TASKS.map((task) => [task.id, task]));

export const PRIMARY_TASKS = tasksFromIds(PRIMARY_15_TASK_IDS, "PRIMARY_15_TASK_IDS");
export const DIAGNOSTIC_TASKS = tasksFromIds(DIAGNOSTIC_TASK_IDS, "DIAGNOSTIC_TASK_IDS");
export const EXCLUDED_TASKS = tasksFromIds(EXCLUDED_TASK_IDS, "EXCLUDED_TASK_IDS");
export const DEFAULT_TASKS = PRIMARY_TASKS;

assertUniqueTaskIds(ALL_TASKS);

export function pickTasks(filter?: { ids?: string[]; tags?: string[] }): Task[] {
  if (!filter || (!filter.ids && !filter.tags)) return DEFAULT_TASKS;
  return ALL_TASKS.filter((t) => {
    if (filter.ids && filter.ids.length > 0 && !filter.ids.includes(t.id)) return false;
    if (filter.tags && filter.tags.length > 0) {
      const taskTags = t.tags ?? [];
      if (!filter.tags.some((tag) => taskTags.includes(tag))) return false;
    }
    return true;
  });
}

function tasksFromIds(ids: readonly string[], label: string): Task[] {
  return ids.map((id) => {
    const task = TASKS_BY_ID.get(id);
    if (!task) throw new Error(`${label} references unknown task ${id}`);
    return task;
  });
}

function assertUniqueTaskIds(tasks: Task[]): void {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const task of tasks) {
    if (seen.has(task.id)) duplicates.push(task.id);
    seen.add(task.id);
  }
  if (duplicates.length > 0) {
    throw new Error(`Duplicate task id(s): ${duplicates.join(", ")}`);
  }
}

export type { Task } from "./types.js";
export {
  DIAGNOSTIC_TASK_IDS,
  EXCLUDED_TASK_IDS,
  PRIMARY_15_TASK_IDS,
} from "./task-sets.js";

