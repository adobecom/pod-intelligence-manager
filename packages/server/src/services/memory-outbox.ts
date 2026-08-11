import { randomUUID } from "node:crypto";
import { canonicalJsonSha256 } from "@pim/shared";
import db, { withImmediateTransaction } from "../db/connection.js";
import {
  markMemoryCandidateValidationFailed,
  validateMemoryCandidate,
} from "./memory-candidates.js";

interface OutboxRow {
  job_id: string;
  org_id: string;
  project_id: string;
  job_type: string;
  aggregate_type: string;
  aggregate_id: string;
  expected_version: number;
  payload_json: string;
  status: "pending" | "leased" | "completed" | "dead_letter";
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
}

export interface RunMemoryOutboxPassOptions {
  workerId?: string;
  maxJobs?: number;
  aggregateIds?: string[];
  jobTypes?: string[];
  now?: string;
  leaseMs?: number;
}

export interface MemoryOutboxPassResult {
  claimed: number;
  completed: number;
  retried: number;
  deadLettered: number;
}

function claimNext(input: {
  workerId: string;
  now: string;
  leaseMs: number;
  aggregateIds?: string[];
  jobTypes?: string[];
}): OutboxRow | null {
  return withImmediateTransaction(() => {
    const aggregateIds = input.aggregateIds?.length ? [...new Set(input.aggregateIds)] : null;
    const jobTypes = input.jobTypes?.length ? [...new Set(input.jobTypes)] : null;
    const restrictions = [
      ...(aggregateIds
        ? [`aggregate_id IN (${aggregateIds.map(() => "?").join(",")})`]
        : []),
      ...(jobTypes
        ? [`job_type IN (${jobTypes.map(() => "?").join(",")})`]
        : []),
    ];
    const restriction = restrictions.length ? ` AND ${restrictions.join(" AND ")}` : "";
    const params: string[] = [
      input.now,
      input.now,
      input.now,
      ...(aggregateIds ?? []),
      ...(jobTypes ?? []),
    ];
    const row = db.prepare(
      `SELECT * FROM memory_outbox
       WHERE (
         (status = 'pending' AND next_attempt_at <= ?)
         OR (status = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
       )
       AND next_attempt_at <= ?${restriction}
       ORDER BY next_attempt_at, created_at, job_id
       LIMIT 1`,
    ).get(...params) as unknown as OutboxRow | undefined;
    if (!row) return null;
    const leaseExpiresAt = new Date(Date.parse(input.now) + input.leaseMs).toISOString();
    const claimed = db.prepare(
      `UPDATE memory_outbox
       SET status = 'leased', lease_owner = ?, lease_expires_at = ?,
           attempt_count = attempt_count + 1, updated_at = ?
       WHERE job_id = ? AND (
         (status = 'pending' AND next_attempt_at <= ?)
         OR (status = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
       )`,
    ).run(input.workerId, leaseExpiresAt, input.now, row.job_id, input.now, input.now);
    if (claimed.changes !== 1) return null;
    const attemptNumber = row.attempt_count + 1;
    db.prepare(
      `INSERT INTO memory_outbox_attempts
         (attempt_id, job_id, attempt_number, worker_id, started_at, completed_at, outcome, error_code)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)`,
    ).run(`attempt_${randomUUID()}`, row.job_id, attemptNumber, input.workerId, input.now);
    return {
      ...row,
      status: "leased",
      attempt_count: attemptNumber,
      lease_owner: input.workerId,
      lease_expires_at: leaseExpiresAt,
    };
  });
}

function completeJob(row: OutboxRow, workerId: string, now: string): void {
  withImmediateTransaction(() => {
    const result = db.prepare(
      `UPDATE memory_outbox
       SET status = 'completed', lease_owner = NULL, lease_expires_at = NULL,
           completed_at = ?, updated_at = ?, last_error_code = NULL, last_error_message = NULL
       WHERE job_id = ? AND status = 'leased' AND lease_owner = ?`,
    ).run(now, now, row.job_id, workerId);
    if (result.changes !== 1) throw new Error("Memory outbox lease was lost before completion");
    db.prepare(
      `UPDATE memory_outbox_attempts
       SET completed_at = ?, outcome = 'completed'
       WHERE job_id = ? AND attempt_number = ?`,
    ).run(now, row.job_id, row.attempt_count);
  });
}

function failJob(row: OutboxRow, workerId: string, now: string, error: unknown): "retry" | "dead_letter" {
  const errorCode = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code.slice(0, 128)
    : "outbox_handler_failed";
  const safeMessage = "Memory outbox handler failed";
  return withImmediateTransaction(() => {
    const leased = db.prepare(
      `SELECT status, lease_owner FROM memory_outbox WHERE job_id = ?`,
    ).get(row.job_id) as { status: string; lease_owner: string | null } | undefined;
    if (!leased || leased.status !== "leased" || leased.lease_owner !== workerId) {
      throw new Error("Memory outbox lease was lost before failure handling");
    }
    if (row.attempt_count >= row.max_attempts) {
      db.prepare(
        `UPDATE memory_outbox
         SET status = 'dead_letter', lease_owner = NULL, lease_expires_at = NULL,
             last_error_code = ?, last_error_message = ?, updated_at = ?
         WHERE job_id = ?`,
      ).run(errorCode, safeMessage, now, row.job_id);
      db.prepare(
        `UPDATE memory_outbox_attempts
         SET completed_at = ?, outcome = 'dead_letter', error_code = ?
         WHERE job_id = ? AND attempt_number = ?`,
      ).run(now, errorCode, row.job_id, row.attempt_count);
      db.prepare(
        `INSERT OR IGNORE INTO memory_dead_letters
           (dead_letter_id, job_id, org_id, project_id, job_type, aggregate_type,
            aggregate_id, payload_digest, error_code, error_message, failed_at, replayed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      ).run(
        `dead_${randomUUID()}`,
        row.job_id,
        row.org_id,
        row.project_id,
        row.job_type,
        row.aggregate_type,
        row.aggregate_id,
        canonicalJsonSha256(JSON.parse(row.payload_json) as unknown),
        errorCode,
        safeMessage,
        now,
      );
      if (row.job_type === "candidate_validation") {
        markMemoryCandidateValidationFailed(row.aggregate_id, errorCode);
      }
      return "dead_letter";
    }
    const backoffMs = Math.min(60_000, 1_000 * (2 ** Math.max(0, row.attempt_count - 1)));
    const nextAttemptAt = new Date(Date.parse(now) + backoffMs).toISOString();
    db.prepare(
      `UPDATE memory_outbox
       SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL,
           next_attempt_at = ?, last_error_code = ?, last_error_message = ?, updated_at = ?
       WHERE job_id = ?`,
    ).run(nextAttemptAt, errorCode, safeMessage, now, row.job_id);
    db.prepare(
      `UPDATE memory_outbox_attempts
       SET completed_at = ?, outcome = 'retry', error_code = ?
       WHERE job_id = ? AND attempt_number = ?`,
    ).run(now, errorCode, row.job_id, row.attempt_count);
    return "retry";
  });
}

function dispatch(row: OutboxRow): void {
  if (row.job_type === "candidate_validation") {
    validateMemoryCandidate(row.aggregate_id, row.expected_version);
    return;
  }
  if (row.job_type === "record_search_index") {
    const record = db.prepare(
      `SELECT record.current_status, record.current_version,
              version.content_json, version.applicability_json
       FROM memory_records record
       INNER JOIN memory_record_versions version
         ON version.record_id = record.record_id
        AND version.record_version = record.current_version
       WHERE record.org_id = ? AND record.project_id = ? AND record.record_id = ?`,
    ).get(row.org_id, row.project_id, row.aggregate_id) as {
      current_status: string;
      current_version: number;
      content_json: string;
      applicability_json: string;
    } | undefined;
    if (!record) throw Object.assign(new Error("Record projection target is unavailable"), { code: "record_not_found" });
    const recordKey = `${row.aggregate_id}:${record.current_version}`;
    db.prepare("DELETE FROM memory_record_versions_fts WHERE record_key = ?").run(recordKey);
    if (record.current_status === "active") {
      const content = JSON.parse(record.content_json) as { summary: string; details: string };
      const applicability = JSON.parse(record.applicability_json) as Record<string, unknown>;
      const selectors = Object.values(applicability)
        .flatMap((value) => Array.isArray(value) ? value : typeof value === "string" ? [value] : [])
        .filter((value): value is string => typeof value === "string")
        .join(" ");
      db.prepare(
        `INSERT INTO memory_record_versions_fts (record_key, summary, details, selectors)
         VALUES (?, ?, ?, ?)`,
      ).run(recordKey, content.summary, content.details, selectors);
    }
    return;
  }
  if (row.job_type === "record_embedding") {
    // Thin v1 has no mutable embedding projection table. Validate the durable
    // canonical target and complete on lexical fallback; retrieval remains
    // immediately available as required when embeddings are unavailable.
    const target = db.prepare(
      `SELECT 1 FROM memory_records
       WHERE org_id = ? AND project_id = ? AND record_id = ?`,
    ).get(row.org_id, row.project_id, row.aggregate_id);
    if (!target) throw Object.assign(new Error("Record embedding target is unavailable"), { code: "record_not_found" });
    return;
  }
  if (row.job_type === "review_notification" || row.job_type === "record_revalidation") {
    let payload: {
      feedback_source?: unknown;
      feedback_id?: unknown;
      signal_id?: unknown;
      candidate_id?: unknown;
    };
    try {
      const parsed = JSON.parse(row.payload_json) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("invalid review payload");
      }
      payload = parsed;
    } catch {
      throw Object.assign(new Error("Review job payload is invalid"), {
        code: "outbox_payload_invalid",
      });
    }
    if (typeof payload.candidate_id === "string"
        && payload.feedback_source === undefined) {
      const candidate = db.prepare(
        `SELECT 1 FROM memory_candidates_v1
         WHERE org_id = ? AND project_id = ? AND candidate_id = ?`,
      ).get(row.org_id, row.project_id, payload.candidate_id);
      if (!candidate) throw Object.assign(new Error("Revalidation candidate is unavailable"), { code: "candidate_not_found" });
      return;
    }
    if (typeof payload.signal_id !== "string") {
      throw Object.assign(new Error("Review job payload is invalid"), { code: "outbox_payload_invalid" });
    }
    if (payload.feedback_source === "memory_v2_feedback_bindings") {
      if (typeof payload.feedback_id !== "string"
          || row.aggregate_type !== "record") {
        throw Object.assign(new Error("Review job payload is invalid"), {
          code: "outbox_payload_invalid",
        });
      }
      const signal = db.prepare(
        `SELECT 1
         FROM memory_v2_feedback_review_signals AS signal
         INNER JOIN memory_v2_feedback_bindings AS feedback
           ON feedback.feedback_id = signal.feedback_id
         WHERE signal.org_id = ? AND signal.project_id = ?
           AND signal.signal_id = ? AND signal.feedback_id = ?
           AND signal.status = 'open' AND signal.outbox_job_id = ?
           AND signal.record_id = ?
           AND feedback.org_id = signal.org_id
           AND feedback.project_id = signal.project_id
           AND feedback.feedback_stage = 'later'
           AND feedback.record_id = signal.record_id
           AND feedback.record_version = signal.record_version
           AND (
             (? = 'review_notification'
               AND signal.signal_type IN ('harmful_review','stale_review'))
             OR (? = 'record_revalidation'
               AND signal.signal_type = 'checkout_anchor_revalidation')
           )`,
      ).get(
        row.org_id,
        row.project_id,
        payload.signal_id,
        payload.feedback_id,
        row.job_id,
        row.aggregate_id,
        row.job_type,
        row.job_type,
      );
      if (!signal) {
        throw Object.assign(new Error("Review signal is unavailable"), {
          code: "review_signal_not_found",
        });
      }
      return;
    }
    if (payload.feedback_source !== undefined
        && payload.feedback_source !== "memory_feedback") {
      throw Object.assign(new Error("Review job payload is invalid"), {
        code: "outbox_payload_invalid",
      });
    }
    const signal = db.prepare(
      `SELECT 1 FROM memory_review_signals
       WHERE org_id = ? AND project_id = ? AND signal_id = ? AND status = 'open'`,
    ).get(row.org_id, row.project_id, payload.signal_id);
    if (!signal) throw Object.assign(new Error("Review signal is unavailable"), { code: "review_signal_not_found" });
    return;
  }
  throw Object.assign(new Error("Unsupported memory outbox job"), { code: "outbox_job_unsupported" });
}

export function runMemoryOutboxPass(options: RunMemoryOutboxPassOptions = {}): MemoryOutboxPassResult {
  const workerId = options.workerId?.trim() || `memory-worker-${randomUUID()}`;
  const maxJobs = Math.max(0, Math.min(options.maxJobs ?? 32, 256));
  const now = options.now ?? new Date().toISOString();
  const leaseMs = Math.max(1_000, options.leaseMs ?? 30_000);
  const result: MemoryOutboxPassResult = { claimed: 0, completed: 0, retried: 0, deadLettered: 0 };
  for (let index = 0; index < maxJobs; index += 1) {
    const row = claimNext({
      workerId,
      now,
      leaseMs,
      aggregateIds: options.aggregateIds,
      jobTypes: options.jobTypes,
    });
    if (!row) break;
    result.claimed += 1;
    try {
      dispatch(row);
      completeJob(row, workerId, now);
      result.completed += 1;
    } catch (error) {
      const outcome = failJob(row, workerId, now, error);
      if (outcome === "retry") result.retried += 1;
      else result.deadLettered += 1;
    }
  }
  return result;
}

export function listMemoryDeadLetters(orgId: string, projectId: string): unknown[] {
  return db.prepare(
    `SELECT dead_letter_id, job_id, job_type, aggregate_type, aggregate_id,
            error_code, error_message, failed_at, replayed_at
     FROM memory_dead_letters WHERE org_id = ? AND project_id = ? ORDER BY failed_at DESC`,
  ).all(orgId, projectId);
}

export function replayMemoryDeadLetter(jobId: string, now = new Date().toISOString()): boolean {
  return withImmediateTransaction(() => {
    const row = db.prepare(
      `SELECT dead.dead_letter_id, job.job_type, job.aggregate_id,
              job.expected_version
       FROM memory_dead_letters dead
       INNER JOIN memory_outbox job ON job.job_id = dead.job_id
       WHERE dead.job_id = ? AND job.status = 'dead_letter'`,
    ).get(jobId) as {
      dead_letter_id: string;
      job_type: string;
      aggregate_id: string;
      expected_version: number;
    } | undefined;
    if (!row) return false;
    let expectedVersion = row.expected_version;
    if (row.job_type === "candidate_validation") {
      const candidate = db.prepare(
        `SELECT aggregate_version, current_status
         FROM memory_candidates_v1 WHERE candidate_id = ?`,
      ).get(row.aggregate_id) as {
        aggregate_version: number;
        current_status: string;
      } | undefined;
      if (!candidate || candidate.current_status !== "validation_failed") return false;
      expectedVersion = candidate.aggregate_version;
    }
    db.prepare(
      `UPDATE memory_outbox
       SET status = 'pending', expected_version = ?,
           max_attempts = attempt_count + 5, next_attempt_at = ?,
           lease_owner = NULL, lease_expires_at = NULL, last_error_code = NULL,
           last_error_message = NULL, updated_at = ?, completed_at = NULL
       WHERE job_id = ?`,
    ).run(expectedVersion, now, now, jobId);
    db.prepare("UPDATE memory_dead_letters SET replayed_at = ? WHERE dead_letter_id = ?")
      .run(now, row.dead_letter_id);
    return true;
  });
}
