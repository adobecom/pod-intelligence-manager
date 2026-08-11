import { randomUUID } from "node:crypto";
import {
  canonicalJsonSha256,
  parseMemoryContract,
  type MemoryFeedbackResultV1,
  type MemoryFeedbackV1,
  type PimErrorV1,
} from "@pim/shared";
import db, { withImmediateTransaction } from "../db/connection.js";
import type { MemoryRepositoryBinding } from "./memory-repository-registry.js";
import {
  assertMemoryV2StoredFeedbackFacet,
  insertMemoryV2FeedbackFacet,
  MemoryV2CanonicalWriteError,
} from "./memory-v2-canonical-writes.js";
import { memoryV2RepositoryResourceRowId } from "./memory-v2-resources.js";

type FeedbackErrorCode = PimErrorV1["code"];

interface FeedbackRow {
  feedback_id: string;
  feedback_digest: string;
  feedback_revision: number;
}

interface PackRow {
  repository_row_id: string;
  repository_id: string;
  consumer_run_id: string | null;
  request_base_sha: string | null;
}

export class MemoryFeedbackError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: FeedbackErrorCode,
  ) {
    super(message);
    this.name = "MemoryFeedbackError";
  }
}

function existingFeedback(input: {
  orgId: string;
  projectId: string;
  feedback: MemoryFeedbackV1;
}): FeedbackRow | null {
  return (db.prepare(
    `SELECT feedback_id, feedback_digest, feedback_revision
     FROM memory_feedback
     WHERE org_id = ? AND project_id = ? AND producer_run_id = ?
       AND retrieval_pack_id = ? AND record_id = ? AND record_version = ?
       AND feedback_stage = 'later' AND feedback_revision = ?`,
  ).get(
    input.orgId,
    input.projectId,
    input.feedback.producer_run_id,
    input.feedback.retrieval_pack_id,
    input.feedback.record_id,
    input.feedback.record_version,
    input.feedback.feedback_revision,
  ) as FeedbackRow | undefined) ?? null;
}

function reviewSignalIds(feedbackId: string): string[] {
  return (db.prepare(
    `SELECT signal_id FROM memory_review_signals
     WHERE feedback_id = ? ORDER BY signal_type`,
  ).all(feedbackId) as unknown as Array<{ signal_id: string }>).map((row) => row.signal_id);
}

function resultFor(row: FeedbackRow, _duplicate: boolean): MemoryFeedbackResultV1 {
  return parseMemoryContract("MemoryFeedbackResultV1", {
    schema_version: "pim.memory-feedback-result.v1",
    feedback_id: row.feedback_id,
    feedback_revision: row.feedback_revision,
    duplicate: false,
    review_signal_ids: reviewSignalIds(row.feedback_id),
  });
}

function replayFeedback(row: FeedbackRow): MemoryFeedbackResultV1 {
  try {
    assertMemoryV2StoredFeedbackFacet(row.feedback_id);
  } catch (error) {
    if (!(error instanceof MemoryV2CanonicalWriteError)) throw error;
    throw new MemoryFeedbackError(error.message, 409, "idempotency_conflict");
  }
  return resultFor(row, true);
}

function assertFeedbackTarget(input: {
  orgId: string;
  projectId: string;
  repository: MemoryRepositoryBinding;
  feedback: MemoryFeedbackV1;
}): string | null {
  const pack = db.prepare(
    `SELECT repository_row_id, repository_id, consumer_run_id, request_base_sha
     FROM memory_retrieval_packs
     WHERE org_id = ? AND project_id = ? AND retrieval_pack_id = ?`,
  ).get(
    input.orgId,
    input.projectId,
    input.feedback.retrieval_pack_id,
  ) as PackRow | undefined;
  if (!pack
      || pack.repository_row_id !== input.repository.repository_row_id
      || pack.repository_id !== input.feedback.repository_id
      || pack.consumer_run_id !== input.feedback.producer_run_id
      || pack.request_base_sha !== input.feedback.base_sha) {
    throw new MemoryFeedbackError(
      "Feedback does not match the immutable retrieval-pack run and repository binding",
      422,
      "evidence_mismatch",
    );
  }
  const packed = db.prepare(
    `SELECT 1 FROM memory_retrieval_pack_items
     WHERE retrieval_pack_id = ? AND record_id = ? AND record_version = ?`,
  ).get(
    input.feedback.retrieval_pack_id,
    input.feedback.record_id,
    input.feedback.record_version,
  );
  if (!packed) {
    throw new MemoryFeedbackError(
      "Feedback must name the exact record version from its retrieval pack",
      422,
      "evidence_mismatch",
    );
  }
  const receipt = db.prepare(
    `SELECT receipt_id FROM memory_run_receipts
     WHERE org_id = ? AND project_id = ? AND producer_run_id = ?
       AND repository_row_id = ? AND repository_id = ? AND base_sha = ?`,
  ).get(
    input.orgId,
    input.projectId,
    input.feedback.producer_run_id,
    input.repository.repository_row_id,
    input.feedback.repository_id,
    input.feedback.base_sha,
  ) as { receipt_id: string } | undefined;
  if (!receipt) {
    throw new MemoryFeedbackError(
      "Feedback producer run has no matching immutable receipt",
      422,
      "evidence_unresolvable",
    );
  }
  for (const producerRefId of input.feedback.outcome_evidence_refs ?? []) {
    const evidence = db.prepare(
      `SELECT 1
       FROM memory_evidence_refs ref
       INNER JOIN memory_evidence_manifests manifest
         ON manifest.evidence_manifest_row_id = ref.evidence_manifest_row_id
       WHERE manifest.receipt_id = ? AND ref.producer_ref_id = ?`,
    ).get(receipt.receipt_id, producerRefId);
    if (!evidence) {
      throw new MemoryFeedbackError(
        "Feedback outcome evidence is unavailable in the named producer run",
        422,
        "evidence_unresolvable",
      );
    }
  }
  return receipt.receipt_id;
}

function insertReviewSignals(input: {
  orgId: string;
  projectId: string;
  feedbackId: string;
  feedback: MemoryFeedbackV1;
  now: string;
}): void {
  const signalTypes = input.feedback.disposition === "harmful"
    ? ["harmful_review"]
    : input.feedback.disposition === "stale"
      ? ["stale_review", "checkout_anchor_revalidation"]
      : [];
  const insertSignal = db.prepare(
    `INSERT INTO memory_review_signals
       (signal_id, org_id, project_id, feedback_id, record_id, record_version,
        signal_type, reason_code, status, created_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, NULL)`,
  );
  const aggregate = db.prepare(
    "SELECT aggregate_version FROM memory_records WHERE record_id = ?",
  ).get(input.feedback.record_id) as { aggregate_version: number } | undefined;
  for (const signalType of signalTypes) {
    const signalId = `review_${randomUUID()}`;
    insertSignal.run(
      signalId,
      input.orgId,
      input.projectId,
      input.feedbackId,
      input.feedback.record_id,
      input.feedback.record_version,
      signalType,
      input.feedback.reason_code,
      input.now,
    );
    const jobType = signalType === "checkout_anchor_revalidation"
      ? "record_revalidation"
      : "review_notification";
    const jobId = `job_${jobType}_${canonicalJsonSha256({ signal_id: signalId }).slice(7, 39)}`;
    db.prepare(
      `INSERT INTO memory_outbox
         (job_id, org_id, project_id, job_type, aggregate_type, aggregate_id,
          expected_version, payload_json, status, attempt_count, max_attempts,
          next_attempt_at, lease_owner, lease_expires_at, last_error_code,
          last_error_message, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, 'record', ?, ?, ?, 'pending', 0, 5, ?, NULL, NULL,
               NULL, NULL, ?, ?, NULL)`,
    ).run(
      jobId,
      input.orgId,
      input.projectId,
      jobType,
      input.feedback.record_id,
      aggregate?.aggregate_version ?? 1,
      JSON.stringify({ signal_id: signalId, feedback_id: input.feedbackId }),
      input.now,
      input.now,
      input.now,
    );
  }
}

export function appendMemoryFeedback(input: {
  orgId: string;
  projectId: string;
  repository: MemoryRepositoryBinding;
  feedback: MemoryFeedbackV1;
  now?: string;
}): MemoryFeedbackResultV1 {
  const digest = canonicalJsonSha256(input.feedback);
  const replay = existingFeedback(input);
  if (replay) {
    if (replay.feedback_digest !== digest) {
      throw new MemoryFeedbackError(
        "Feedback revision was reused with different content",
        409,
        "idempotency_conflict",
      );
    }
    return replayFeedback(replay);
  }
  const now = input.now ?? new Date().toISOString();
  return withImmediateTransaction(() => {
    const concurrent = existingFeedback(input);
    if (concurrent) {
      if (concurrent.feedback_digest !== digest) {
        throw new MemoryFeedbackError(
          "Feedback revision was reused with different content",
          409,
          "idempotency_conflict",
        );
      }
      return replayFeedback(concurrent);
    }
    const receiptId = assertFeedbackTarget(input);
    const row: FeedbackRow = {
      feedback_id: `feedback_${randomUUID()}`,
      feedback_digest: digest,
      feedback_revision: input.feedback.feedback_revision,
    };
    db.prepare(
      `INSERT INTO memory_feedback
         (feedback_id, org_id, project_id, receipt_id, producer_run_id,
          retrieval_pack_id, record_id, record_version, feedback_stage,
          feedback_revision, feedback_json, feedback_digest, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'later', ?, ?, ?, ?)`,
    ).run(
      row.feedback_id,
      input.orgId,
      input.projectId,
      receiptId,
      input.feedback.producer_run_id,
      input.feedback.retrieval_pack_id,
      input.feedback.record_id,
      input.feedback.record_version,
      input.feedback.feedback_revision,
      JSON.stringify(input.feedback),
      digest,
      now,
    );
    insertMemoryV2FeedbackFacet({
      feedbackId: row.feedback_id,
      retrievalPackId: input.feedback.retrieval_pack_id,
      orgId: input.orgId,
      projectId: input.projectId,
      plane: "codebase",
      resourceRowId: memoryV2RepositoryResourceRowId(input.repository.repository_row_id),
      now,
    });
    insertReviewSignals({ ...input, feedbackId: row.feedback_id, now });
    return resultFor(row, false);
  });
}

export function listOpenMemoryReviewSignals(orgId: string, projectId: string): unknown[] {
  return db.prepare(
    `SELECT signal_id, feedback_id, record_id, record_version, signal_type,
            reason_code, status, created_at
     FROM memory_review_signals
     WHERE org_id = ? AND project_id = ? AND status = 'open'
     ORDER BY created_at, signal_id`,
  ).all(orgId, projectId);
}
