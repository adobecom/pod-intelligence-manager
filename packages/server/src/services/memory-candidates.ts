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
import {
  assertMemoryV2StoredCandidateFacet,
  insertMemoryV2CandidateFacet,
  insertMemoryV2FacetQuarantine,
  type MemoryV2HarnessSubtype,
} from "./memory-v2-canonical-writes.js";
import {
  memoryV2RepositoryResourceRowId,
  resolveMemoryV2HarnessResourceRowId,
} from "./memory-v2-resources.js";

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

interface NativeHarnessScopeRow {
  receipt_id: string;
  resource_row_id: string;
  producer_run_id: string;
  scope_snapshot_digest: string;
}

interface NativeHarnessRuntimeEvidenceRow {
  evidence_ref_id: string;
  outcome_json: string;
  source_authority: "observed" | "verified";
}

type NativeHarnessValidationStrategy =
  | "stable_failure_fingerprint"
  | "runtime_attestation"
  | "authorized_review";

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
  /** Native-v2 harness subtype; legacy v1 callers intentionally omit it. */
  candidateSubtype?: MemoryV2HarnessSubtype;
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

function insertMemoryCandidateInTransaction(
  input: InsertMemoryCandidateInput,
): InsertedMemoryCandidate {
  let resourceRowId: string | null;
  if (input.candidate.plane === "codebase" && input.repositoryRowId) {
    resourceRowId = memoryV2RepositoryResourceRowId(input.repositoryRowId);
  } else if (input.candidate.plane === "harness") {
    const applicability = input.candidate.applicability as HarnessApplicabilityV1;
    if (applicability.harness_id !== input.producerHarnessId) {
      throw new MemoryCandidateIdempotencyError(
        "Harness candidate does not match its authenticated producer resource",
      );
    }
    const harnessResourceRowId = resolveMemoryV2HarnessResourceRowId({
      orgId: input.orgId,
      projectId: input.projectId,
      harnessId: applicability.harness_id,
    });
    if (!harnessResourceRowId) {
      throw new MemoryCandidateIdempotencyError("Harness candidate resource is unavailable");
    }
    resourceRowId = harnessResourceRowId;
  } else if (input.candidate.plane === "org" && input.repositoryRowId === null) {
    resourceRowId = null;
  } else {
    throw new MemoryCandidateIdempotencyError(
      "Candidate plane has no exact implemented canonical resource",
    );
  }
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
    assertMemoryV2StoredCandidateFacet(existing.candidate_id);
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
  if (input.candidate.plane === "org") {
    insertMemoryV2FacetQuarantine({
      quarantineRowId: `v2facetq:${randomUUID()}`,
      aggregateType: "candidate",
      aggregateId: candidateId,
      aggregateVersion: 0,
      orgId: input.orgId,
      projectId: input.projectId,
      sourcePlane: "org",
      reasonCode: "unsupported_plane",
      sourceDigest: digest,
      now: input.now,
    });
  } else {
    insertMemoryV2CandidateFacet({
      candidateId,
      orgId: input.orgId,
      projectId: input.projectId,
      plane: input.candidate.plane,
      resourceRowId: resourceRowId!,
      broadKind: input.candidate.kind,
      subtype: input.candidateSubtype,
      now: input.now,
    });
  }
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

/**
 * Transaction-owning candidate writer. Receipt intake may call this inside its
 * aggregate transaction; the database wrapper uses a savepoint for that nested
 * call so direct callers receive the same all-or-nothing guarantee.
 */
export function insertMemoryCandidate(input: InsertMemoryCandidateInput): InsertedMemoryCandidate {
  return withImmediateTransaction(() => insertMemoryCandidateInTransaction(input));
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

function nativeHarnessScope(receiptId: string): NativeHarnessScopeRow | null {
  return (db.prepare(
    `SELECT receipt_id, resource_row_id, producer_run_id, scope_snapshot_digest
     FROM memory_v2_scope_snapshots
     WHERE receipt_id = ? AND plane = 'harness'`,
  ).get(receiptId) as NativeHarnessScopeRow | undefined) ?? null;
}

function validateNativeHarnessCandidate(input: {
  row: CandidateRow;
  candidate: MemoryCandidateV1;
  receipt: {
    producer_run_id: string;
    producer_harness_id: string;
    receipt_json: string;
  };
  scope: NativeHarnessScopeRow;
}): CandidateRow {
  const applicability = input.candidate.applicability as HarnessApplicabilityV1;
  const receiptPayload = parseMemoryContract(
    "RunReceiptV1",
    parseJson<RunReceiptV1>(input.receipt.receipt_json),
  );
  const extensions = input.candidate.extensions ?? {};
  const strategy = extensions.v2_validation_strategy;
  if (applicability.harness_id !== input.receipt.producer_harness_id
      || applicability.harness_id !== receiptPayload.producer.harness_id
      || input.scope.producer_run_id !== input.receipt.producer_run_id
      || extensions.v2_scope_snapshot_digest !== input.scope.scope_snapshot_digest) {
    return rejectCandidate(
      input.row,
      "candidate_harness_mismatch",
      "Native v2 harness applicability must exactly match its authenticated receipt scope.",
    );
  }
  if (strategy !== "stable_failure_fingerprint"
      && strategy !== "runtime_attestation"
      && strategy !== "authorized_review") {
    return rejectCandidate(
      input.row,
      "candidate_validation_strategy_invalid",
      "Native v2 harness validation strategy is unavailable or unsupported.",
    );
  }
  const validationStrategy = strategy as NativeHarnessValidationStrategy;
  const failureFingerprint = input.candidate.validation.failure_fingerprint;
  const failureDerived = validationStrategy === "stable_failure_fingerprint";
  if (failureDerived
      ? input.candidate.validation.strategy !== "stable_failure_fingerprint"
        || !failureFingerprint
        || failureFingerprint !== receiptPayload.outcome.failure_fingerprint
      : input.candidate.validation.strategy !== "policy_owner_review"
        || failureFingerprint !== undefined
        || receiptPayload.outcome.status !== "completed"
        || receiptPayload.outcome.verification_status !== "passed"
        || receiptPayload.outcome.failure_fingerprint !== null) {
    return rejectCandidate(
      input.row,
      failureDerived
        ? "stable_failure_fingerprint_mismatch"
        : "successful_runtime_evidence_mismatch",
      failureDerived
        ? "Native v2 failure-derived evidence must preserve the receipt's stable failure fingerprint."
        : "Native v2 successful-run evidence must preserve a completed, verified, fingerprint-free outcome.",
    );
  }
  const evidence = db.prepare(
    `SELECT origin.evidence_ref_id, origin.outcome_json, origin.source_authority
     FROM memory_v2_candidate_origins AS link
     INNER JOIN memory_v2_origins AS origin ON origin.origin_id = link.origin_id
     WHERE link.candidate_id = ? AND link.receipt_id = ?
       AND link.producer_run_id = ? AND link.resource_row_id = ?
       AND origin.receipt_id = link.receipt_id
       AND origin.evidence_ref_id = link.evidence_ref_id
     ORDER BY origin.evidence_ref_id`,
  ).all(
    input.row.candidate_id,
    input.scope.receipt_id,
    input.scope.producer_run_id,
    input.scope.resource_row_id,
  ) as unknown as NativeHarnessRuntimeEvidenceRow[];
  const evidenceRefs = evidence.map((item) => item.evidence_ref_id).sort();
  const evidenceRequired = validationStrategy !== "authorized_review";
  if ((evidenceRequired && evidence.length === 0)
      || extensions.v2_evidence_refs_digest !== canonicalJsonSha256(evidenceRefs)) {
    return rejectCandidate(
      input.row,
      "candidate_evidence_unresolvable",
      "Native v2 harness runtime evidence is incomplete or unavailable.",
    );
  }
  const outcomesMatch = evidence.every((item) => {
    try {
      const outcome = parseJson<{
        status?: unknown;
        verification_status?: unknown;
        failure_fingerprint?: unknown;
      }>(item.outcome_json);
      return failureDerived
        ? outcome.failure_fingerprint === failureFingerprint
        : outcome.status === "completed"
          && outcome.verification_status === "passed"
          && outcome.failure_fingerprint === null
          && (validationStrategy !== "runtime_attestation"
            || item.source_authority === "verified");
    } catch {
      return false;
    }
  });
  if (!outcomesMatch) {
    return rejectCandidate(
      input.row,
      failureDerived
        ? "stable_failure_fingerprint_mismatch"
        : "successful_runtime_evidence_mismatch",
      failureDerived
        ? "Native v2 runtime evidence does not match the candidate failure fingerprint."
        : "Native v2 runtime evidence does not verify the declared successful-run strategy.",
    );
  }
  const blockers = ["authorized_review_required"];
  if (extensions.v2_activation_requirement_requested === "independently_verified_runtime") {
    blockers.push("origin_quorum_unavailable");
  }
  return transitionCandidate({
    candidateId: input.row.candidate_id,
    expectedVersion: input.row.aggregate_version,
    toStatus: "pending_review",
    blockers,
    reasonCode: "authorized_review_required",
    explanation: "Structurally valid native v2 harness memory awaits authorized review before activation.",
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
  const nativeScope = candidate.plane === "harness"
    ? nativeHarnessScope(row.receipt_id)
    : null;
  if (candidate.plane === "harness" && nativeScope) {
    return validateNativeHarnessCandidate({
      row,
      candidate,
      receipt,
      scope: nativeScope,
    });
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
  if (candidate.plane === "org") {
    return transitionCandidate({
      candidateId,
      expectedVersion: row.aggregate_version,
      toStatus: "pending_review",
      blockers: ["manual_policy_owner_required"],
      reasonCode: "manual_policy_owner_required",
      explanation: "Structurally valid organization memory awaits explicit policy-owner validation and review.",
    });
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
    return transitionCandidate({
      candidateId,
      expectedVersion: row.aggregate_version,
      toStatus: "pending_review",
      blockers: ["authorized_review_required"],
      reasonCode: "authorized_review_required",
      explanation: "Structurally valid harness memory awaits authorized review.",
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
