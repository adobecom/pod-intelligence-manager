import db from "../db/connection.js";

export type MemoryMetricUnit = "Count" | "Milliseconds" | "Seconds";

export interface MemoryMetric {
  name:
    | "ActivationOutcome"
    | "ActivePointerViolationCount"
    | "BoundaryLeakageCount"
    | "DeadLetterCount"
    | "FeedbackOutcome"
    | "OldestDeadLetterAgeSeconds"
    | "OldestOutboxAgeSeconds"
    | "OutboxBacklog"
    | "PromptVisibleRecordCount"
    | "ReviewSignalCount"
    | "SearchLatency"
    | "SearchOutcome"
    | "SearchResultCount";
  value: number;
  unit: MemoryMetricUnit;
  timestampMs: number;
  dimensions?: Record<string, string>;
  fields?: Record<string, string | number | boolean | null>;
}

export type MemoryMetricSink = (metric: MemoryMetric) => void;

export interface MemoryMetricLogger {
  info: (obj: unknown, msg?: string) => void;
}

export interface MemoryOperationalSnapshot {
  generatedAt: string;
  orgId: string;
  projectId: string;
  retrievalPackCount: number;
  receiptCount: number;
  candidateCount: number;
  laterFeedbackCount: number;
  openReviewSignalCount: number;
  outboxBacklog: number;
  deadLetterCount: number;
  activeCandidatesWithoutCanonicalRecords: number;
  recordsByStatus: Record<"active" | "stale" | "superseded" | "revoked" | "expired", number>;
  /** Distinct immutable record versions included in prompt-eligible pack items. */
  promptVisibleRecordCount: number;
  /** Persisted pack-item scope violations; ordinary authorization denials do not count. */
  crossBoundaryLeakageCount: number;
}

/** Global, low-cardinality health values used by the production alarms. */
export interface MemorySloSnapshot {
  generatedAt: string;
  outboxBacklog: number;
  oldestOutboxAgeSeconds: number;
  deadLetterCount: number;
  oldestDeadLetterAgeSeconds: number;
  activePointerViolationCount: number;
  boundaryLeakageCount: number;
}

export interface MemoryTraceRetrieval {
  feedbackId: string;
  feedbackStage: "receipt" | "later";
  retrievalPackId: string;
  recordId: string;
  recordVersion: number;
}

export interface MemoryTraceTransition {
  transitionId: string;
  fromStatus: string | null;
  toStatus: string;
  reasonCode: string;
}

export interface MemoryTraceCandidate {
  candidateId: string;
  manifestId: string | null;
  activeRecordId: string | null;
  activeRecordVersion: number | null;
  transitions: MemoryTraceTransition[];
  futureRetrievalPackIds: string[];
}

export interface MemoryIdChainTrace {
  producerRunId: string;
  receiptId: string;
  retrievals: MemoryTraceRetrieval[];
  candidates: MemoryTraceCandidate[];
}

const CLOUDWATCH_NAMESPACE = "PIM/Memory";

let metricSink: MemoryMetricSink = () => undefined;

function count(sql: string, ...params: Array<string | number>): number {
  const row = db.prepare(sql).get(...params) as { count: number } | undefined;
  return row?.count ?? 0;
}

function ageSeconds(timestamp: string | null, nowMs: number): number {
  if (!timestamp) return 0;
  const timestampMs = Date.parse(timestamp);
  if (!Number.isFinite(timestampMs)) return 0;
  return Math.max(0, Math.floor((nowMs - timestampMs) / 1_000));
}

export function recordMemoryMetric(
  metric: Omit<MemoryMetric, "timestampMs"> & { timestampMs?: number },
): void {
  try {
    metricSink({
      ...metric,
      timestampMs: metric.timestampMs ?? Date.now(),
    });
  } catch {
    // Observability must never alter memory availability or lifecycle outcomes.
  }
}

/**
 * Emits CloudWatch Embedded Metric Format through the structured application
 * logger. Request and resource IDs stay in fields, never metric dimensions.
 */
export function createCloudWatchMemoryMetricSink(
  log: MemoryMetricLogger,
): MemoryMetricSink {
  return (metric) => {
    const dimensions = metric.dimensions ?? {};
    log.info(
      {
        _aws: {
          Timestamp: metric.timestampMs,
          CloudWatchMetrics: [
            {
              Namespace: CLOUDWATCH_NAMESPACE,
              Dimensions: [Object.keys(dimensions)],
              Metrics: [{ Name: metric.name, Unit: metric.unit }],
            },
          ],
        },
        ...dimensions,
        ...metric.fields,
        [metric.name]: metric.value,
      },
      "Memory metric",
    );
  };
}

export function setMemoryMetricSink(sink: MemoryMetricSink | null): void {
  metricSink = sink ?? (() => undefined);
}

export function getMemoryOperationalSnapshot(
  orgId: string,
  projectId: string,
  now = new Date().toISOString(),
): MemoryOperationalSnapshot {
  const recordsByStatus: MemoryOperationalSnapshot["recordsByStatus"] = {
    active: 0,
    stale: 0,
    superseded: 0,
    revoked: 0,
    expired: 0,
  };
  const statuses = db.prepare(
    `SELECT current_status, COUNT(*) AS count
     FROM memory_records
     WHERE org_id = ? AND project_id = ?
     GROUP BY current_status`,
  ).all(orgId, projectId) as unknown as Array<{
    current_status: keyof typeof recordsByStatus;
    count: number;
  }>;
  for (const row of statuses) recordsByStatus[row.current_status] = row.count;

  return {
    generatedAt: now,
    orgId,
    projectId,
    retrievalPackCount: count(
      "SELECT COUNT(*) AS count FROM memory_retrieval_packs WHERE org_id = ? AND project_id = ?",
      orgId,
      projectId,
    ),
    receiptCount: count(
      "SELECT COUNT(*) AS count FROM memory_run_receipts WHERE org_id = ? AND project_id = ?",
      orgId,
      projectId,
    ),
    candidateCount: count(
      "SELECT COUNT(*) AS count FROM memory_candidates_v1 WHERE org_id = ? AND project_id = ?",
      orgId,
      projectId,
    ),
    laterFeedbackCount: count(
      `SELECT COUNT(*) AS count FROM memory_feedback
       WHERE org_id = ? AND project_id = ? AND feedback_stage = 'later'`,
      orgId,
      projectId,
    ),
    openReviewSignalCount: count(
      `SELECT COUNT(*) AS count FROM memory_review_signals
       WHERE org_id = ? AND project_id = ? AND status = 'open'`,
      orgId,
      projectId,
    ),
    outboxBacklog: count(
      `SELECT COUNT(*) AS count FROM memory_outbox
       WHERE org_id = ? AND project_id = ? AND status IN ('pending','leased')`,
      orgId,
      projectId,
    ),
    deadLetterCount: count(
      `SELECT
         (SELECT COUNT(*) FROM memory_outbox
          WHERE org_id = ? AND project_id = ? AND status = 'dead_letter')
         +
         (SELECT COUNT(*) FROM memory_inbox
          WHERE org_id = ? AND project_id = ? AND status = 'dead_letter') AS count`,
      orgId,
      projectId,
      orgId,
      projectId,
    ),
    activeCandidatesWithoutCanonicalRecords: count(
      `SELECT COUNT(*) AS count
       FROM memory_candidates_v1 candidate
       LEFT JOIN memory_records record
         ON record.record_id = candidate.active_record_id
       WHERE candidate.org_id = ? AND candidate.project_id = ?
         AND candidate.current_status = 'active'
         AND (
           record.record_id IS NULL
           OR record.org_id <> candidate.org_id
           OR record.project_id <> candidate.project_id
           OR record.plane <> candidate.plane
           OR record.repository_row_id IS NOT candidate.repository_row_id
           OR (
             candidate.plane = 'harness'
             AND record.harness_id IS NOT candidate.producer_harness_id
           )
           OR record.current_version IS NOT candidate.active_record_version
         )`,
      orgId,
      projectId,
    ),
    recordsByStatus,
    promptVisibleRecordCount: count(
      `SELECT COUNT(DISTINCT item.record_id || ':' || item.record_version) AS count
       FROM memory_retrieval_pack_items item
       INNER JOIN memory_retrieval_packs pack
         ON pack.retrieval_pack_id = item.retrieval_pack_id
       WHERE pack.org_id = ? AND pack.project_id = ?
         AND item.prompt_eligible = 1`,
      orgId,
      projectId,
    ),
    crossBoundaryLeakageCount: count(
      `SELECT COUNT(*) AS count
       FROM memory_retrieval_pack_items item
       INNER JOIN memory_retrieval_packs pack
         ON pack.retrieval_pack_id = item.retrieval_pack_id
       LEFT JOIN memory_records record
         ON record.record_id = item.record_id
       WHERE pack.org_id = ? AND pack.project_id = ?
         AND (
           record.record_id IS NULL
           OR record.org_id <> pack.org_id
           OR record.project_id <> pack.project_id
           OR record.plane <> pack.plane
           OR record.repository_row_id IS NOT pack.repository_row_id
           OR record.harness_id IS NOT pack.harness_id
         )`,
      orgId,
      projectId,
    ),
  };
}

export function getMemorySloSnapshot(
  now = new Date().toISOString(),
): MemorySloSnapshot {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new TypeError("now must be a valid ISO timestamp");

  const outbox = db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM memory_outbox
        WHERE status IN ('pending','leased')) AS count,
       (SELECT MIN(due_at)
        FROM (
          SELECT next_attempt_at AS due_at
          FROM memory_outbox
          WHERE status = 'pending' AND next_attempt_at <= ?
          UNION ALL
          SELECT lease_expires_at AS due_at
          FROM memory_outbox
          WHERE status = 'leased' AND lease_expires_at <= ?
        )) AS oldest_at`,
  ).get(now, now) as { count: number; oldest_at: string | null };
  const deadLetters = db.prepare(
    `SELECT COUNT(*) AS count, MIN(failed_at) AS oldest_at
     FROM (
       SELECT COALESCE(dead.failed_at, job.updated_at) AS failed_at
       FROM memory_outbox job
       LEFT JOIN memory_dead_letters dead
         ON dead.job_id = job.job_id AND dead.replayed_at IS NULL
       WHERE job.status = 'dead_letter'
       UNION ALL
       SELECT dead_lettered_at AS failed_at
       FROM memory_inbox
       WHERE status = 'dead_letter'
     )`,
  ).get() as { count: number; oldest_at: string | null };

  return {
    generatedAt: now,
    outboxBacklog: outbox.count,
    oldestOutboxAgeSeconds: ageSeconds(outbox.oldest_at, nowMs),
    deadLetterCount: deadLetters.count,
    oldestDeadLetterAgeSeconds: ageSeconds(deadLetters.oldest_at, nowMs),
    activePointerViolationCount: count(
      `SELECT COUNT(*) AS count
       FROM memory_candidates_v1 candidate
       LEFT JOIN memory_records record
         ON record.record_id = candidate.active_record_id
       WHERE candidate.current_status = 'active'
         AND (
           record.record_id IS NULL
           OR record.org_id <> candidate.org_id
           OR record.project_id <> candidate.project_id
           OR record.plane <> candidate.plane
           OR record.repository_row_id IS NOT candidate.repository_row_id
           OR (
             candidate.plane = 'harness'
             AND record.harness_id IS NOT candidate.producer_harness_id
           )
           OR record.current_version IS NOT candidate.active_record_version
         )`,
    ),
    boundaryLeakageCount: count(
      `SELECT COUNT(*) AS count
       FROM memory_retrieval_pack_items item
       INNER JOIN memory_retrieval_packs pack
         ON pack.retrieval_pack_id = item.retrieval_pack_id
       LEFT JOIN memory_records record
         ON record.record_id = item.record_id
       WHERE record.record_id IS NULL
          OR record.org_id <> pack.org_id
          OR record.project_id <> pack.project_id
          OR record.plane <> pack.plane
          OR record.repository_row_id IS NOT pack.repository_row_id
          OR record.harness_id IS NOT pack.harness_id`,
    ),
  };
}

/** Publish one aggregate sample without creating tenant/project metric dimensions. */
export function emitMemoryOperationalMetrics(
  now = new Date().toISOString(),
): MemorySloSnapshot {
  const snapshot = getMemorySloSnapshot(now);
  const timestampMs = Date.parse(snapshot.generatedAt);
  const fields = { generated_at: snapshot.generatedAt };
  for (const metric of [
    { name: "OutboxBacklog", value: snapshot.outboxBacklog, unit: "Count" },
    {
      name: "OldestOutboxAgeSeconds",
      value: snapshot.oldestOutboxAgeSeconds,
      unit: "Seconds",
    },
    { name: "DeadLetterCount", value: snapshot.deadLetterCount, unit: "Count" },
    {
      name: "OldestDeadLetterAgeSeconds",
      value: snapshot.oldestDeadLetterAgeSeconds,
      unit: "Seconds",
    },
    {
      name: "ActivePointerViolationCount",
      value: snapshot.activePointerViolationCount,
      unit: "Count",
    },
    {
      name: "BoundaryLeakageCount",
      value: snapshot.boundaryLeakageCount,
      unit: "Count",
    },
  ] as const) {
    recordMemoryMetric({ ...metric, timestampMs, fields });
  }
  return snapshot;
}

export function getMemoryIdChainTrace(
  orgId: string,
  projectId: string,
  producerRunId: string,
): MemoryIdChainTrace | null {
  const receipt = db.prepare(
    `SELECT receipt_id
     FROM memory_run_receipts
     WHERE org_id = ? AND project_id = ? AND producer_run_id = ?`,
  ).get(orgId, projectId, producerRunId) as { receipt_id: string } | undefined;
  if (!receipt) return null;

  const retrievals = db.prepare(
    `SELECT feedback_id, feedback_stage, retrieval_pack_id, record_id, record_version
     FROM memory_feedback
     WHERE org_id = ? AND project_id = ? AND receipt_id = ?
     ORDER BY created_at, feedback_id`,
  ).all(orgId, projectId, receipt.receipt_id) as unknown as Array<{
    feedback_id: string;
    feedback_stage: MemoryTraceRetrieval["feedbackStage"];
    retrieval_pack_id: string;
    record_id: string;
    record_version: number;
  }>;

  const candidateRows = db.prepare(
    `SELECT candidate.candidate_id, candidate.active_record_id,
            candidate.active_record_version, manifest.producer_manifest_id
     FROM memory_receipt_candidates link
     INNER JOIN memory_candidates_v1 candidate
       ON candidate.candidate_id = link.candidate_id
     LEFT JOIN memory_evidence_manifests manifest
       ON manifest.evidence_manifest_row_id = candidate.evidence_manifest_row_id
     WHERE link.receipt_id = ?
     ORDER BY candidate.created_at, candidate.candidate_id`,
  ).all(receipt.receipt_id) as unknown as Array<{
    candidate_id: string;
    active_record_id: string | null;
    active_record_version: number | null;
    producer_manifest_id: string | null;
  }>;

  const transitionsStatement = db.prepare(
    `SELECT transition_id, from_status, to_status, reason_code
     FROM memory_transitions
     WHERE org_id = ? AND project_id = ?
       AND aggregate_type = 'candidate' AND aggregate_id = ?
     ORDER BY committed_at, rowid`,
  );
  const futurePacksStatement = db.prepare(
    `SELECT DISTINCT pack.retrieval_pack_id
     FROM memory_retrieval_pack_items item
     INNER JOIN memory_retrieval_packs pack
       ON pack.retrieval_pack_id = item.retrieval_pack_id
     WHERE pack.org_id = ? AND pack.project_id = ?
       AND item.record_id = ? AND item.record_version = ?
     ORDER BY pack.created_at, pack.retrieval_pack_id`,
  );

  const candidates: MemoryTraceCandidate[] = candidateRows.map((candidate) => {
    const transitions = transitionsStatement.all(
      orgId,
      projectId,
      candidate.candidate_id,
    ) as unknown as Array<{
      transition_id: string;
      from_status: string | null;
      to_status: string;
      reason_code: string;
    }>;
    const futurePacks = candidate.active_record_id && candidate.active_record_version
      ? futurePacksStatement.all(
        orgId,
        projectId,
        candidate.active_record_id,
        candidate.active_record_version,
      ) as unknown as Array<{ retrieval_pack_id: string }>
      : [];
    return {
      candidateId: candidate.candidate_id,
      manifestId: candidate.producer_manifest_id,
      activeRecordId: candidate.active_record_id,
      activeRecordVersion: candidate.active_record_version,
      transitions: transitions.map((transition) => ({
        transitionId: transition.transition_id,
        fromStatus: transition.from_status,
        toStatus: transition.to_status,
        reasonCode: transition.reason_code,
      })),
      futureRetrievalPackIds: futurePacks.map((pack) => pack.retrieval_pack_id),
    };
  });

  return {
    producerRunId,
    receiptId: receipt.receipt_id,
    retrievals: retrievals.map((retrieval) => ({
      feedbackId: retrieval.feedback_id,
      feedbackStage: retrieval.feedback_stage,
      retrievalPackId: retrieval.retrieval_pack_id,
      recordId: retrieval.record_id,
      recordVersion: retrieval.record_version,
    })),
    candidates,
  };
}
