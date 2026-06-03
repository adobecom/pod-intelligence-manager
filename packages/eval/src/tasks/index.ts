import type { Task } from "./types.js";

import { rbacPermissionResolution } from "./code-gen/rbac-permission-resolution.js";
import { rbac403Fallback } from "./code-gen/rbac-403-fallback.js";
import { sessionCreateTimezone } from "./code-gen/session-create-timezone.js";
import { sessionRenderTime } from "./code-gen/session-render-time.js";
import { configDeepMerge } from "./code-gen/config-deep-merge.js";
import { configCacheBust } from "./code-gen/config-cache-bust.js";
import { eventCreateRest } from "./code-gen/event-create-rest.js";
import { formLocalization } from "./code-gen/form-localization.js";

import { rbacDecisionRationale } from "./content-gen/rbac-decision-rationale.js";
import { sessionBlockerSummary } from "./content-gen/session-blocker-summary.js";
import { configDecisionWriteup } from "./content-gen/config-decision-writeup.js";
import { progressUpdatePermissions } from "./content-gen/progress-update-permissions.js";

import { eventSpeakerPutContract } from "./real-emc/event-speaker-put-contract.js";
import { eventSpeakerPutContractVague } from "./real-emc/event-speaker-put-contract-vague.js";
import { sessionTimeNoRefresh } from "./real-emc/session-time-no-refresh.js";
import { seriesPutReadonlyTargetCms } from "./real-emc/series-put-readonly-targetcms.js";
import { eventTitleMaxLength } from "./real-emc/event-title-max-length.js";
import { ppnExplicitSelect } from "./real-emc/ppn-explicit-select.js";
import { declinedRsvpStatus } from "./real-emc/declined-rsvp-status.js";
import { detailPagePathPut } from "./real-emc/detail-page-path-put.js";
import { includePartnersToggle } from "./real-emc/include-partners-toggle.js";
import { prodPublishConfirmation } from "./real-emc/prod-publish-confirmation.js";
import { sessionLocationTimeOverlap } from "./real-emc/session-location-time-overlap.js";
import { rteQuillSemanticHtml } from "./real-emc/rte-quill-semantic-html.js";
import { s2TabsCrashSegmentedControl } from "./real-emc/s2-tabs-crash-segmented-control.js";
import { sxswTicketFieldConfigService } from "./real-emc/sxsw-ticket-field-config-service.js";

export const ALL_TASKS: Task[] = [
  rbacPermissionResolution,
  rbac403Fallback,
  sessionCreateTimezone,
  sessionRenderTime,
  configDeepMerge,
  configCacheBust,
  eventCreateRest,
  formLocalization,
  rbacDecisionRationale,
  sessionBlockerSummary,
  configDecisionWriteup,
  progressUpdatePermissions,
  eventSpeakerPutContract,
  eventSpeakerPutContractVague,
  sessionTimeNoRefresh,
  seriesPutReadonlyTargetCms,
  eventTitleMaxLength,
  ppnExplicitSelect,
  declinedRsvpStatus,
  detailPagePathPut,
  includePartnersToggle,
  prodPublishConfirmation,
  sessionLocationTimeOverlap,
  rteQuillSemanticHtml,
  s2TabsCrashSegmentedControl,
  sxswTicketFieldConfigService,
];

export function pickTasks(filter?: { ids?: string[]; tags?: string[] }): Task[] {
  if (!filter || (!filter.ids && !filter.tags)) return ALL_TASKS;
  return ALL_TASKS.filter((t) => {
    if (filter.ids && filter.ids.length > 0 && !filter.ids.includes(t.id)) return false;
    if (filter.tags && filter.tags.length > 0) {
      const taskTags = t.tags ?? [];
      if (!filter.tags.some((tag) => taskTags.includes(tag))) return false;
    }
    return true;
  });
}

export type { Task } from "./types.js";
