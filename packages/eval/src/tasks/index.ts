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
