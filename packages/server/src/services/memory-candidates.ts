import { randomUUID } from "node:crypto";
import {
  canonicalJsonSha256,
  parseMemoryContract,
  type HarnessApplicabilityV1,
  type MemoryCandidateStatusV1,
  type MemoryCandidateV1,
  type RunReceiptV1,
} from "@pim/shared";
import db, { withImmediateTransaction } from "../db/connection.js";
import {
  assertMemoryStructure,
  MemoryStructuralValidationError,
} from "./memory-structural-validator.js";

type CandidateStatus = MemoryCandidateStatusV1["status"];
type ActivationRequirement = MemoryCandidateStatusV1["activation_requirement"];

interface CandidateRow {
  candidate_id: string;
  org_id: string;
  project_id: string;
  receipt_id: string;
  repository_row_id: string | null;
  producer_harness_id: string;
  client_candidate_id: string;
  candidate_digest: string;
  candidate_json: string;
  plane: MemoryCandidateV1["plane"];
  kind: MemoryCandidateV1["kind"];
  current_status: CandidateStatus;
  aggregate_version: number;
  activation_requirement: ActivationRequirement;
  blockers_json: string;
  evidence_manifest_row_id: string | null;
  active_record_id: string | null;
  active_record_version: number | null;
  created_at: string;
  updated_at: string;
}

interface TransitionRow {
  transition_id: string;
  from_status: string | null;
  to_status: string;
  reason_code: string;
  committed_at: string;
}

export interface InsertMemoryCandidateInput {
  orgId: string;
  projectId: string;
  receiptId: string;
  repositoryRowId: string | null;
  producerHarnessId: string;
  producerRunId: string;
  evidenceManifestRowId: string | null;
  evidenceRowsByProducerRef: Map<string, string>;
  candidate: MemoryCandidateV1;
  now: string;
}

export interface InsertedMemoryCandidate {
  candidateId: string;
  status: CandidateStatus;
  blockers: string[];
  created: boolean;
}

export interface StoredMemoryCandidate {
  row: CandidateRow;
  candidate: MemoryCandidateV1;
}

export class MemoryCandidateIdempotencyError extends Error {
  readonly statusCode = 409;
  readonly code = "idempotency_conflict";

  constructor(message: string) {
    super(message);
    this.name = "MemoryCandidateIdempotencyError";
  }
}

export class MemoryCandidateTransitionError extends Error {
  readonly statusCode = 409;
  readonly code = "transition_invalid";

  constructor(message: string) {
    super(message);
    this.name = "MemoryCandidateTransitionError";
  }
}

function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

function getCandidateRow(candidateId: string): CandidateRow | null {
  return (db.prepare("SELECT * FROM memory_candidates_v1 WHERE candidate_id = ?")
    .get(candidateId) as unknown as CandidateRow | undefined) ?? null;
}

export function deriveActivationRequirement(candidate: MemoryCandidateV1): ActivationRequirement {
  if (candidate.plane === "org") return "manual_policy_owner";
  if (candidate.plane === "harness" || candidate.kind === "anti_pattern") return "authorized_review";
  return "verified_merge";
}

function insertTransition(input: {
  row: CandidateRow;
  fromStatus: CandidateStatus | null;
  toStatus: CandidateStatus;
  actorId: string;
  actorType?: string;
  reasonCode: string;
  explanation: string;
  evidenceRefs: string[];
  decisionRefs?: string[];
  now: string;
}): string {
  const transitionId = `transition_${randomUUID()}`;
  db.prepare(
    `INSERT INTO memory_transitions
       (transition_id, org_id, project_id, aggregate_type, aggregate_id, from_status,
        to_status, actor_type, actor_id, reason_code, explanation, evidence_refs_json,
        decision_refs_json, policy_version, occurred_at, committed_at)
     VALUES (?, ?, ?, 'candidate', ?, ?, ?, ?, ?, ?, ?, ?, ?,
             'memory-candidate-policy-v1', ?, ?)`,
  ).run(
    transitionId,
    input.row.org_id,
    input.row.project_id,
    input.row.candidate_id,
    input.fromStatus,
    input.toStatus,
    input.actorType ?? "system",
    input.actorId,
    input.reasonCode,
    input.explanation,
    JSON.stringify(input.evidenceRefs),
    JSON.stringify(input.decisionRefs ?? []),
    input.now,
    input.now,
  );
  return transitionId;
}

export function insertMemoryCandidate(input: InsertMemoryCandidateInput): InsertedMemoryCandidate {
  const digest = canonicalJsonSha256(input.candidate);
  const existing = db.prepare(
    `SELECT * FROM memory_candidates_v1
     WHERE org_id = ? AND project_id = ? AND producer_harness_id = ? AND client_candidate_id = ?`,
  ).get(
    input.orgId,
    input.projectId,
    input.producerHarnessId,
    input.candidate.client_candidate_id,
  ) as unknown as CandidateRow | undefined;
  if (existing) {
    if (existing.candidate_digest !== digest) {
      throw new MemoryCandidateIdempotencyError(
        "Producer candidate identity was reused with different immutable content",
      );
    }
    db.prepare(
      `INSERT OR IGNORE INTO memory_receipt_candidates
         (receipt_id, candidate_id, client_candidate_id, candidate_digest)
       VALUES (?, ?, ?, ?)`,
    ).run(input.receiptId, existing.candidate_id, existing.client_candidate_id, digest);
    return {
      candidateId: existing.candidate_id,
      status: existing.current_status,
      blockers: parseJson(existing.blockers_json),
      created: false,
    };
  }

  const candidateId = `candidate_${randomUUID()}`;
  const requirement = deriveActivationRequirement(input.candidate);
  const blockers = ["validation_pending"];
  db.prepare(
    `INSERT INTO memory_candidates_v1
       (candidate_id, org_id, project_id, receipt_id, repository_row_id,
        producer_harness_id, client_candidate_id, candidate_digest, candidate_json,
        plane, kind, current_status, aggregate_version, activation_requirement,
        blockers_json, evidence_manifest_row_id, active_record_id, active_record_version,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', 1, ?, ?, ?, NULL, NULL, ?, ?)`,
  ).run(
    candidateId,
    input.orgId,
    input.projectId,
    input.receiptId,
    input.repositoryRowId,
    input.producerHarnessId,
    input.candidate.client_candidate_id,
    digest,
    JSON.stringify(input.candidate),
    input.candidate.plane,
    input.candidate.kind,
    requirement,
    JSON.stringify(blockers),
    input.evidenceManifestRowId,
    input.now,
    input.now,
  );
  const row = getCandidateRow(candidateId)!;
  insertTransition({
    row,
    fromStatus: null,
    toStatus: "received",
    actorId: input.producerHarnessId,
    reasonCode: "candidate_received",
    explanation: "Typed candidate input was durably accepted for validation.",
    evidenceRefs: input.candidate.evidence_refs,
    now: input.now,
  });
  db.prepare(
    `INSERT INTO memory_receipt_candidates
       (receipt_id, candidate_id, client_candidate_id, candidate_digest)
     VALUES (?, ?, ?, ?)`,
  ).run(input.receiptId, candidateId, input.candidate.client_candidate_id, digest);
  const linkEvidence = db.prepare(
    `INSERT INTO memory_candidate_evidence (candidate_id, evidence_row_id) VALUES (?, ?)`,
  );
  for (const producerRef of input.candidate.evidence_refs) {
    const evidenceRowId = input.evidenceRowsByProducerRef.get(producerRef);
    if (!evidenceRowId) {
      throw new MemoryCandidateIdempotencyError("Candidate evidence reference is unavailable");
    }
    linkEvidence.run(candidateId, evidenceRowId);
  }
  const jobId = `job_candidate_validation_${canonicalJsonSha256({
    candidate_id: candidateId,
    expected_version: 1,
  }).slice("sha256:".length, "sha256:".length + 32)}`;
  db.prepare(
    `INSERT INTO memory_outbox
       (job_id, org_id, project_id, job_type, aggregate_type, aggregate_id,
        expected_version, payload_json, status, attempt_count, max_attempts,
        next_attempt_at, lease_owner, lease_expires_at, last_error_code,
        last_error_message, created_at, updated_at, completed_at)
     VALUES (?, ?, ?, 'candidate_validation', 'candidate', ?, 1, ?, 'pending', 0, 5,
             ?, NULL, NULL, NULL, NULL, ?, ?, NULL)`,
  ).run(
    jobId,
    input.orgId,
    input.projectId,
    candidateId,
    JSON.stringify({ candidate_id: candidateId }),
    input.now,
    input.now,
    input.now,
  );
  return { candidateId, status: "received", blockers, created: true };
}

const ALLOWED_TRANSITIONS: Record<CandidateStatus, CandidateStatus[]> = {
  received: ["validating"],
  validating: ["rejected", "pending_review", "pending_merge", "quarantined", "validation_failed"],
  pending_review: ["rejected", "pending_merge", "active", "quarantined"],
  pending_merge: ["active", "rejected", "quarantined", "activation_failed"],
  rejected: [],
  quarantined: [],
  validation_failed: ["validating"],
  active: [],
  activation_failed: ["validating"],
};

function transitionCandidate(input: {
  candidateId: string;
  expectedVersion: number;
  toStatus: CandidateStatus;
  blockers: string[];
  reasonCode: string;
  explanation: string;
  actorId?: string;
  actorType?: string;
  decisionRefs?: string[];
  now?: string;
}): CandidateRow {
  const now = input.now ?? new Date().toISOString();
  return withImmediateTransaction(() => {
    const row = getCandidateRow(input.candidateId);
    if (!row || row.aggregate_version !== input.expectedVersion) {
      throw new MemoryCandidateTransitionError("Candidate lifecycle version changed concurrently");
    }
    if (!ALLOWED_TRANSITIONS[row.current_status].includes(input.toStatus)) {
      throw new MemoryCandidateTransitionError(
        `Candidate cannot transition from ${row.current_status} to ${input.toStatus}`,
      );
    }
    const result = db.prepare(
      `UPDATE memory_candidates_v1
       SET current_status = ?, aggregate_version = aggregate_version + 1,
           blockers_json = ?, updated_at = ?
       WHERE candidate_id = ? AND aggregate_version = ? AND current_status = ?`,
    ).run(
      input.toStatus,
      JSON.stringify([...new Set(input.blockers)]),
      now,
      input.candidateId,
      input.expectedVersion,
      row.current_status,
    );
    if (result.changes !== 1) {
      throw new MemoryCandidateTransitionError("Candidate lifecycle version changed concurrently");
    }
    const candidate = parseMemoryContract("MemoryCandidateV1", parseJson(row.candidate_json));
    insertTransition({
      row,
      fromStatus: row.current_status,
      toStatus: input.toStatus,
      actorId: input.actorId ?? "memory-candidate-validator",
      actorType: input.actorType,
      reasonCode: input.reasonCode,
      explanation: input.explanation,
      evidenceRefs: candidate.evidence_refs,
      decisionRefs: input.decisionRefs,
      now,
    });
    return getCandidateRow(input.candidateId)!;
  });
}

function rejectCandidate(row: CandidateRow, blocker: string, explanation: string): CandidateRow {
  return transitionCandidate({
    candidateId: row.candidate_id,
    expectedVersion: row.aggregate_version,
    toStatus: "rejected",
    blockers: [blocker],
    reasonCode: blocker,
    explanation,
  });
}

export function validateMemoryCandidate(candidateId: string, expectedVersion: number): CandidateRow {
  let row = getCandidateRow(candidateId);
  if (!row) throw new Error("Candidate validation target is unavailable");
  if (row.aggregate_version !== expectedVersion && row.current_status !== "validating") {
    if (["pending_merge", "pending_review", "rejected"].includes(row.current_status)) return row;
    throw new MemoryCandidateTransitionError("Candidate validation job version is stale");
  }
  if (row.current_status === "received" || row.current_status === "validation_failed") {
    row = transitionCandidate({
      candidateId,
      expectedVersion: row.aggregate_version,
      toStatus: "validating",
      blockers: ["validation_in_progress"],
      reasonCode: "candidate_validation_started",
      explanation: "Candidate validation began under the canonical policy validator.",
    });
  }
  if (row.current_status !== "validating") return row;
  const candidate = parseMemoryContract("MemoryCandidateV1", parseJson(row.candidate_json));
  if (candidate.plane === "org") {
    return rejectCandidate(
      row,
      "organization_plane_not_supported",
      "Organization memory remains manual-only and is not enabled in this slice.",
    );
  }
  try {
    assertMemoryStructure({
      plane: candidate.plane,
      kind: candidate.kind,
      content: candidate.content,
      applicability: candidate.applicability,
      validation: candidate.validation,
      exceptions: candidate.exceptions,
    });
  } catch (error) {
    if (!(error instanceof MemoryStructuralValidationError)) throw error;
    return rejectCandidate(row, "candidate_structure_invalid", "Candidate failed the canonical structural validator.");
  }

  const receipt = db.prepare(
    `SELECT producer_run_id, producer_harness_id, repository_row_id, repository_id, receipt_json
     FROM memory_run_receipts WHERE receipt_id = ?`,
  ).get(row.receipt_id) as {
    producer_run_id: string;
    producer_harness_id: string;
    repository_row_id: string | null;
    repository_id: string | null;
    receipt_json: string;
  } | undefined;
  if (!receipt || !candidate.source_run_ids.includes(receipt.producer_run_id)) {
    return rejectCandidate(row, "producer_run_provenance_missing", "Candidate source runs do not include the receipt producer run.");
  }
  const linkedEvidence = db.prepare(
    `SELECT ref.type, ref.producer_ref_id
     FROM memory_candidate_evidence link
     INNER JOIN memory_evidence_refs ref ON ref.evidence_row_id = link.evidence_row_id
     WHERE link.candidate_id = ?`,
  ).all(candidateId) as unknown as Array<{ type: string; producer_ref_id: string }>;
  if (!row.evidence_manifest_row_id || linkedEvidence.length !== candidate.evidence_refs.length
      || candidate.evidence_refs.length === 0) {
    return rejectCandidate(row, "candidate_evidence_unresolvable", "Candidate evidence is incomplete or unavailable.");
  }
  if (candidate.plane === "harness") {
    const applicability = candidate.applicability as HarnessApplicabilityV1;
    const receiptPayload = parseMemoryContract("RunReceiptV1", parseJson<RunReceiptV1>(receipt.receipt_json));
    if (applicability.harness_id !== receipt.producer_harness_id
        || applicability.harness_id !== receiptPayload.producer.harness_id) {
      return rejectCandidate(
        row,
        "candidate_harness_mismatch",
        "Harness applicability must exactly match the authenticated receipt producer.",
      );
    }
    if (!candidate.validation.failure_fingerprint
        || candidate.validation.failure_fingerprint !== receiptPayload.outcome.failure_fingerprint) {
      return rejectCandidate(
        row,
        "stable_failure_fingerprint_mismatch",
        "Harness candidate fingerprint must exactly match the terminal receipt outcome.",
      );
    }
    if (!linkedEvidence.some((item) => item.type === "failure")) {
      return rejectCandidate(
        row,
        "failure_evidence_required",
        "Harness candidates require resolvable failure evidence for the stable fingerprint.",
      );
    }
    const blockers = ["authorized_review_required"];
    if (linkedEvidence.some((item) => item.type === "git_diff")) {
      blockers.push("verified_fiesta_merge_required");
    }
    return transitionCandidate({
      candidateId,
      expectedVersion: row.aggregate_version,
      toStatus: "pending_review",
      blockers,
      reasonCode: "authorized_review_required",
      explanation: "Structurally valid harness memory awaits authorized review in permanent shadow mode.",
    });
  }

  const repositoryId = (candidate.applicability as { repository_id?: string }).repository_id;
  if (!row.repository_row_id || receipt.repository_row_id !== row.repository_row_id
      || receipt.repository_id !== repositoryId) {
    return rejectCandidate(row, "candidate_repository_mismatch", "Candidate applicability does not match its authenticated receipt repository.");
  }
  if (candidate.kind === "anti_pattern") {
    if (!linkedEvidence.some((item) => item.type === "failure")) {
      return rejectCandidate(row, "failure_evidence_required", "Anti-pattern candidates require resolvable failure evidence.");
    }
    return transitionCandidate({
      candidateId,
      expectedVersion: row.aggregate_version,
      toStatus: "pending_review",
      blockers: ["authorized_review_required"],
      reasonCode: "authorized_review_required",
      explanation: "Structurally valid anti-pattern awaits authorized review.",
    });
  }
  return transitionCandidate({
    candidateId,
    expectedVersion: row.aggregate_version,
    toStatus: "pending_merge",
    blockers: ["verified_merge_required"],
    reasonCode: "verified_merge_required",
    explanation: "Structurally valid positive codebase candidate awaits independently verified merge evidence.",
  });
}

export function markMemoryCandidateValidationFailed(candidateId: string, errorCode: string): void {
  let row = getCandidateRow(candidateId);
  if (!row || ["rejected", "pending_merge", "pending_review", "active"].includes(row.current_status)) return;
  if (row.current_status === "received") {
    row = transitionCandidate({
      candidateId,
      expectedVersion: row.aggregate_version,
      toStatus: "validating",
      blockers: ["validation_in_progress"],
      reasonCode: "candidate_validation_started",
      explanation: "Candidate validation began under the canonical policy validator.",
    });
  }
  if (row.current_status === "validating") {
    transitionCandidate({
      candidateId,
      expectedVersion: row.aggregate_version,
      toStatus: "validation_failed",
      blockers: [errorCode],
      reasonCode: errorCode,
      explanation: "Candidate validation failed operationally and may be retried.",
    });
  }
}

export function markMemoryCandidateActive(input: {
  candidateId: string;
  expectedVersion: number;
  recordId: string;
  recordVersion: number;
  actorId: string;
  actorType?: string;
  fromStatus?: "pending_merge" | "pending_review";
  decisionRefs?: string[];
  reasonCode?: string;
  explanation?: string;
  now?: string;
}): CandidateRow {
  const now = input.now ?? new Date().toISOString();
  const fromStatus = input.fromStatus ?? "pending_merge";
  return withImmediateTransaction(() => {
    const row = getCandidateRow(input.candidateId);
    if (!row || row.aggregate_version !== input.expectedVersion || row.current_status !== fromStatus) {
      throw new MemoryCandidateTransitionError("Candidate is no longer eligible for activation");
    }
    const expectedRequirement = fromStatus === "pending_review" ? "authorized_review" : "verified_merge";
    if (row.activation_requirement !== expectedRequirement) {
      throw new MemoryCandidateTransitionError("Candidate activation policy does not match its lifecycle state");
    }
    const updated = db.prepare(
      `UPDATE memory_candidates_v1
       SET current_status = 'active', aggregate_version = aggregate_version + 1,
           blockers_json = '[]', active_record_id = ?, active_record_version = ?, updated_at = ?
       WHERE candidate_id = ? AND aggregate_version = ? AND current_status = ?`,
    ).run(
      input.recordId,
      input.recordVersion,
      now,
      input.candidateId,
      input.expectedVersion,
      fromStatus,
    );
    if (updated.changes !== 1) {
      throw new MemoryCandidateTransitionError("Candidate lifecycle version changed during activation");
    }
    const candidate = parseMemoryContract("MemoryCandidateV1", parseJson(row.candidate_json));
    insertTransition({
      row,
      fromStatus,
      toStatus: "active",
      actorId: input.actorId,
      actorType: input.actorType,
      reasonCode: input.reasonCode
        ?? (fromStatus === "pending_review" ? "authorized_review_activated" : "verified_merge_activated"),
      explanation: input.explanation
        ?? (fromStatus === "pending_review"
          ? "Authorized review satisfied the candidate activation policy."
          : "Independently verified merge evidence satisfied the candidate activation policy."),
      evidenceRefs: candidate.evidence_refs,
      decisionRefs: input.decisionRefs,
      now,
    });
    return getCandidateRow(input.candidateId)!;
  });
}

export function rejectMemoryCandidateByReview(input: {
  candidateId: string;
  expectedVersion: number;
  reviewerId: string;
  decisionId: string;
  reasonCode: string;
  explanation: string;
  now?: string;
}): CandidateRow {
  const row = getCandidateRow(input.candidateId);
  if (!row || row.current_status !== "pending_review" || row.activation_requirement !== "authorized_review") {
    throw new MemoryCandidateTransitionError("Candidate is not eligible for an authorized review decision");
  }
  return transitionCandidate({
    candidateId: input.candidateId,
    expectedVersion: input.expectedVersion,
    toStatus: "rejected",
    blockers: ["authorized_review_rejected"],
    actorId: input.reviewerId,
    actorType: "reviewer",
    decisionRefs: [input.decisionId],
    reasonCode: input.reasonCode,
    explanation: input.explanation,
    now: input.now,
  });
}

export function getStoredMemoryCandidate(
  orgId: string,
  projectId: string,
  candidateId: string,
): StoredMemoryCandidate | null {
  const row = db.prepare(
    "SELECT * FROM memory_candidates_v1 WHERE org_id = ? AND project_id = ? AND candidate_id = ?",
  ).get(orgId, projectId, candidateId) as unknown as CandidateRow | undefined;
  return row
    ? { row, candidate: parseMemoryContract("MemoryCandidateV1", parseJson(row.candidate_json)) }
    : null;
}

export function getMemoryCandidateStatus(
  orgId: string,
  projectId: string,
  candidateId: string,
): MemoryCandidateStatusV1 | null {
  const stored = getStoredMemoryCandidate(orgId, projectId, candidateId);
  if (!stored) return null;
  const transition = db.prepare(
    `SELECT transition_id, from_status, to_status, reason_code, committed_at
     FROM memory_transitions
     WHERE org_id = ? AND project_id = ? AND aggregate_type = 'candidate' AND aggregate_id = ?
     ORDER BY committed_at DESC, rowid DESC LIMIT 1`,
  ).get(orgId, projectId, candidateId) as TransitionRow | undefined;
  if (!transition) throw new Error("Memory candidate has no lifecycle transition");
  return parseMemoryContract("MemoryCandidateStatusV1", {
    schema_version: "pim.memory-candidate-status.v1",
    candidate_id: stored.row.candidate_id,
    client_candidate_id: stored.row.client_candidate_id,
    plane: stored.row.plane,
    kind: stored.row.kind,
    status: stored.row.current_status,
    activation_requirement: stored.row.activation_requirement,
    blockers: parseJson(stored.row.blockers_json),
    ...(stored.row.active_record_id && stored.row.active_record_version
      ? {
          active_record: {
            record_id: stored.row.active_record_id,
            record_version: stored.row.active_record_version,
          },
        }
      : {}),
    latest_transition: {
      transition_id: transition.transition_id,
      from_status: transition.from_status,
      to_status: transition.to_status,
      reason_code: transition.reason_code,
      committed_at: transition.committed_at,
    },
    created_at: stored.row.created_at,
    updated_at: stored.row.updated_at,
  });
}

export type { CandidateRow, CandidateStatus, ActivationRequirement };
