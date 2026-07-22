import db from "../db/connection.js";
import type { ProjectResources, ProjectSourceChange } from "@pim/shared";
import {
  pollSlackProjectSource,
  type PollSlackProjectSourceOptions,
  type SlackPollState,
} from "./project-slack-source.js";
import {
  applySourceChanges,
  purgeProjectEvidenceIdentity,
  recordProjectSourceReconciliation,
  recordProjectSourceSyncAttempt,
  recordProjectSourceSyncFailure,
  recordProjectSourceSyncSuccess,
} from "./project-source-change.js";
import { connectorBindingVersion } from "./project-resource-bindings.js";

const SLACK_STATE_CURSOR = "poll_state:v1";

export interface SlackProjectSyncResult {
  source: "slack";
  ingested: number;
  deleted: number;
  quarantined: number;
  missing?: string;
}

type SlackPollOverrides = Omit<PollSlackProjectSourceOptions, "org_id" | "project_id" | "bindings" | "previous_state">;

function loadSlackPollState(orgId: string, projectId: string): SlackPollState | undefined {
  const row = db.prepare(
    `SELECT cursor_value FROM project_ingestion_cursors
     WHERE org_id = ? AND project_id = ? AND source = 'slack' AND cursor_key = ?`,
  ).get(orgId, projectId, SLACK_STATE_CURSOR) as { cursor_value: string } | undefined;
  if (!row) return undefined;
  try {
    const value = JSON.parse(row.cursor_value) as SlackPollState;
    return value && typeof value === "object" && value.channels && typeof value.channels === "object"
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function saveSlackPollState(orgId: string, projectId: string, state: SlackPollState): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO project_ingestion_cursors
       (org_id, project_id, source, cursor_key, cursor_value, updated_at)
     VALUES (?, ?, 'slack', ?, ?, ?)
     ON CONFLICT(org_id, project_id, source, cursor_key) DO UPDATE SET
       cursor_value = excluded.cursor_value,
       updated_at = excluded.updated_at`,
  ).run(orgId, projectId, SLACK_STATE_CURSOR, JSON.stringify(state), now);
}

function indexedSlackThreads(
  orgId: string,
  projectId: string,
  sourceInstance?: string,
  channelId?: string,
): number {
  const row = sourceInstance && channelId
    ? db.prepare(
        `SELECT COUNT(*) AS count FROM project_evidence_items
         WHERE org_id = ? AND project_id = ? AND source = 'slack'
           AND source_instance = ? AND native_id LIKE ?`,
      ).get(orgId, projectId, sourceInstance, `${channelId}:%`)
    : sourceInstance
    ? db.prepare(
        `SELECT COUNT(*) AS count FROM project_evidence_items
         WHERE org_id = ? AND project_id = ? AND source = 'slack' AND source_instance = ?`,
      ).get(orgId, projectId, sourceInstance)
    : db.prepare(
        `SELECT COUNT(*) AS count FROM project_evidence_items
         WHERE org_id = ? AND project_id = ? AND source = 'slack'`,
      ).get(orgId, projectId);
  return Number((row as { count?: number } | undefined)?.count ?? 0);
}

function purgePersistedSlackChannel(
  orgId: string,
  projectId: string,
  workspaceId: string,
  channelId: string,
): number {
  const rows = db.prepare(
    `SELECT native_id FROM project_evidence_items
     WHERE org_id = ? AND project_id = ? AND source = 'slack'
       AND source_instance = ? AND native_id LIKE ?
     UNION
     SELECT native_id FROM project_search_documents
     WHERE org_id = ? AND project_id = ? AND source = 'slack'
       AND source_instance = ? AND native_id LIKE ?`,
  ).all(
    orgId,
    projectId,
    workspaceId,
    `${channelId}:%`,
    orgId,
    projectId,
    workspaceId,
    `${channelId}:%`,
  ) as Array<{ native_id: string }>;
  let deleted = 0;
  for (const row of rows) {
    deleted += purgeProjectEvidenceIdentity(orgId, projectId, "slack", workspaceId, row.native_id);
  }
  return deleted;
}

/** Persist one Slack poll using the common SourceChange spine. Cursor state
 * contains only routing IDs, hashes, and timestamps—never message bodies. */
export async function syncSlackProjectSource(
  orgId: string,
  projectId: string,
  resources: ProjectResources,
  overrides: SlackPollOverrides = {},
): Promise<SlackProjectSyncResult> {
  const bindings = resources.slack?.channels ?? [];
  if (bindings.length === 0) return { source: "slack", ingested: 0, deleted: 0, quarantined: 0 };

  const attemptedAt = new Date().toISOString();
  const previousState = loadSlackPollState(orgId, projectId);
  const poll = await pollSlackProjectSource({
    org_id: orgId,
    project_id: projectId,
    bindings,
    ...(previousState ? { previous_state: previousState } : {}),
    ...overrides,
  });

  let boundaryDeleted = 0;
  const definitivelyIneligible = new Set(["not_public", "not_member"]);
  for (const binding of poll.health.bindings) {
    if (!definitivelyIneligible.has(binding.status) || !binding.workspace_id || !binding.channel_id) continue;
    // Covers lost/corrupt cursor state: positive channel visibility or
    // membership revocation purges only that channel, never healthy siblings.
    boundaryDeleted += purgePersistedSlackChannel(
      orgId,
      projectId,
      binding.workspace_id,
      binding.channel_id,
    );
  }

  const resourceBindingVersion = connectorBindingVersion(resources, "slack");
  const changes: ProjectSourceChange[] = poll.changes.map((change) => change.kind === "upsert"
    ? {
        ...change,
        evidence: {
          ...change.evidence,
          metadata: {
            ...(change.evidence.metadata ?? {}),
            resource_binding_version: resourceBindingVersion,
          },
        },
      }
    : change);
  const applied = await applySourceChanges(orgId, projectId, changes);
  // Advance successful channels, remove positively ineligible channels, and
  // retain the last known-good cursor for transient/credential failures.
  const state: SlackPollState = structuredClone(previousState ?? { channels: {} });
  for (const binding of poll.health.bindings) {
    if (!binding.workspace_id || !binding.channel_id) continue;
    const key = `${binding.workspace_id}:${binding.channel_id}`;
    if (binding.status === "ok") {
      if (poll.state.channels[key]) state.channels[key] = poll.state.channels[key];
      else delete state.channels[key];
    } else if (definitivelyIneligible.has(binding.status)) {
      delete state.channels[key];
    }
  }
  if (applied.quarantined > 0) {
    const quarantined = db.prepare(
      `SELECT source_instance, native_id FROM project_source_quarantine
       WHERE org_id = ? AND project_id = ? AND source = 'slack'`,
    ).all(orgId, projectId) as Array<{ source_instance: string; native_id: string }>;
    for (const row of quarantined) {
      const [channelId, rootTs] = row.native_id.split(":");
      const channel = state.channels[`${row.source_instance}:${channelId}`];
      if (!channel || !rootTs) continue;
      delete channel.threads[rootTs];
      delete channel.watermark;
      delete channel.reconciliation_cursor;
      delete channel.last_reconciliation_at;
    }
  }
  saveSlackPollState(orgId, projectId, state);

  const recordedInstances = new Set<string>();
  for (const binding of poll.health.bindings) {
    const instance = binding.workspace_id && binding.channel_id
      ? `${binding.workspace_id}:${binding.channel_id}`
      : `binding:${binding.binding}`;
    recordedInstances.add(instance);
    recordProjectSourceSyncAttempt(orgId, projectId, "slack", instance, attemptedAt);
    if (binding.status === "ok") {
      recordProjectSourceSyncSuccess(orgId, projectId, "slack", instance, {
        attempted_at: attemptedAt,
        indexed_count: indexedSlackThreads(orgId, projectId, binding.workspace_id, binding.channel_id),
        ...(binding.lag_seconds !== undefined ? { lag_seconds: binding.lag_seconds } : {}),
      });
      if (binding.last_reconciliation_at) {
        recordProjectSourceReconciliation(
          orgId,
          projectId,
          "slack",
          instance,
          binding.last_reconciliation_at,
        );
      }
    } else {
      recordProjectSourceSyncFailure(
        orgId,
        projectId,
        "slack",
        instance,
        `slack_${binding.status}`,
        `slack_${binding.status}`,
        attemptedAt,
      );
    }
  }

  if (recordedInstances.size === 0) {
    const instance = "configured";
    recordProjectSourceSyncAttempt(orgId, projectId, "slack", instance, attemptedAt);
    recordProjectSourceSyncFailure(
      orgId,
      projectId,
      "slack",
      instance,
      `slack_${poll.health.credential_state}`,
      `slack_${poll.health.credential_state}`,
      attemptedAt,
    );
  }

  const failed = poll.health.credential_state !== "ok"
    || poll.health.admitted_bindings !== poll.health.configured_bindings
    || poll.health.bindings.some((binding) => binding.status !== "ok");
  return {
    source: "slack",
    ingested: applied.upserted,
    deleted: applied.deleted + boundaryDeleted,
    quarantined: applied.quarantined,
    ...(failed ? { missing: "slack_source_partial_or_total_failure" } : {}),
  };
}
