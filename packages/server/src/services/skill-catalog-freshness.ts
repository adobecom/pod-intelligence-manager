import {
  listEnabledSkillCatalogSourceRefs,
  syncSkillCatalogSource,
  type SnapshotBuildResult,
} from "./skill-catalog.js";
import { recordSkillCatalogMetric } from "./skill-catalog-metrics.js";

export interface SkillCatalogFreshnessLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
}

export interface ScheduleSkillCatalogSyncInput {
  orgId: string;
  sourceId: string;
  trigger: "poll" | "webhook";
  log: SkillCatalogFreshnessLogger;
  webhookReceivedAtMs?: number;
}

export interface ScheduledSkillCatalogSyncResult {
  failures: number;
  lastResult: SnapshotBuildResult | null;
  runs: number;
}

interface SourceSyncState {
  dirty: boolean;
  log: SkillCatalogFreshnessLogger;
  nextWebhookReceivedAtMs?: number;
  orgId: string;
  running?: Promise<ScheduledSkillCatalogSyncResult>;
  sourceId: string;
}

const sourceSyncStates = new Map<string, SourceSyncState>();
let activeRefPollTick: Promise<{
  failures: number;
  sourceCount: number;
}> | null = null;

function mergeWebhookReceivedAt(
  current: number | undefined,
  incoming: number | undefined,
): number | undefined {
  if (incoming === undefined) return current;
  if (current === undefined) return incoming;
  return Math.min(current, incoming);
}

async function runSourceSyncLoop(
  state: SourceSyncState,
): Promise<ScheduledSkillCatalogSyncResult> {
  let failures = 0;
  let lastResult: SnapshotBuildResult | null = null;
  let runs = 0;

  do {
    state.dirty = false;
    const webhookReceivedAtMs = state.nextWebhookReceivedAtMs;
    state.nextWebhookReceivedAtMs = undefined;
    runs += 1;

    try {
      lastResult = await syncSkillCatalogSource(state.orgId, state.sourceId);
      if (lastResult.state === "failed") {
        failures += 1;
        state.log.warn(
          {
            error: lastResult.error ?? "Catalog snapshot build failed",
            org_id: state.orgId,
            source_id: state.sourceId,
          },
          "Skill catalog source sync failed",
        );
      } else {
        state.log.info(
          {
            commit_sha: lastResult.snapshot.commitSha,
            org_id: state.orgId,
            source_id: state.sourceId,
          },
          "Skill catalog source synced",
        );
        if (webhookReceivedAtMs !== undefined) {
          recordSkillCatalogMetric({
            name: "WebhookToEntriesReadyLag",
            value: Math.max(0, Date.now() - webhookReceivedAtMs),
            unit: "Milliseconds",
            fields: {
              org_id: state.orgId,
              source_id: state.sourceId,
            },
          });
        }
      }
    } catch (error) {
      failures += 1;
      state.log.warn(
        {
          error: error instanceof Error ? error.message : String(error),
          org_id: state.orgId,
          source_id: state.sourceId,
        },
        "Skill catalog source sync failed",
      );
    }
  } while (state.dirty);

  return { failures, lastResult, runs };
}

/**
 * Coalesces sync requests per source. A signal received while a sync is already
 * running marks the source dirty, guaranteeing one follow-up ref resolution so
 * a push that lands after the current run resolved its ref is not lost.
 */
export function scheduleSkillCatalogSourceSync(
  input: ScheduleSkillCatalogSyncInput,
): Promise<ScheduledSkillCatalogSyncResult> {
  const active = sourceSyncStates.get(input.sourceId);
  if (active) {
    active.dirty = true;
    active.nextWebhookReceivedAtMs = mergeWebhookReceivedAt(
      active.nextWebhookReceivedAtMs,
      input.webhookReceivedAtMs,
    );
    return active.running!;
  }

  const state: SourceSyncState = {
    dirty: false,
    log: input.log,
    nextWebhookReceivedAtMs: input.webhookReceivedAtMs,
    orgId: input.orgId,
    sourceId: input.sourceId,
  };
  sourceSyncStates.set(input.sourceId, state);
  const running = runSourceSyncLoop(state).finally(() => {
    if (sourceSyncStates.get(input.sourceId) === state) {
      sourceSyncStates.delete(input.sourceId);
    }
  });
  state.running = running;
  return running;
}

async function performSkillCatalogRefPollTick(
  log: SkillCatalogFreshnessLogger,
): Promise<{ failures: number; sourceCount: number }> {
  const sources = listEnabledSkillCatalogSourceRefs();
  let failures = 0;
  for (const source of sources) {
    const result = await scheduleSkillCatalogSourceSync({
      ...source,
      trigger: "poll",
      log,
    });
    failures += result.failures;
  }
  log.info(
    {
      failures,
      source_count: sources.length,
    },
    "Skill catalog ref poll completed",
  );
  return { failures, sourceCount: sources.length };
}

/** Join an active global poll pass so interval overlap cannot dirty every source. */
export function runSkillCatalogRefPollTick(
  log: SkillCatalogFreshnessLogger,
): Promise<{ failures: number; sourceCount: number }> {
  if (activeRefPollTick) return activeRefPollTick;
  const promise = performSkillCatalogRefPollTick(log);
  activeRefPollTick = promise;
  const cleanup = () => {
    if (activeRefPollTick === promise) activeRefPollTick = null;
  };
  void promise.then(cleanup, cleanup);
  return promise;
}

export function resetSkillCatalogFreshnessForTests(): void {
  sourceSyncStates.clear();
  activeRefPollTick = null;
}
