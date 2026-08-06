import { randomUUID } from "node:crypto";
import {
  canonicalJsonSha256,
  type CodebaseApplicabilityV1,
  type EvidenceHandleV1,
  type EvidenceSummaryV1,
  type MemoryAttestationV1,
  type MemoryCandidateDecisionV1,
  type MemoryCandidateV1,
  type MemoryRecordV1,
  type RunReceiptV1,
} from "@pim/shared";
import db, { withImmediateTransaction } from "../db/connection.js";
import {
  getStoredMemoryCandidate,
  markMemoryCandidateActive,
  type StoredMemoryCandidate,
} from "./memory-candidates.js";
import {
  canonicalMemoryConflictKey,
  canonicalMemoryClaimKey,
  getMemoryRecord,
  importActiveMemoryRecord,
  transitionMemoryRecordStatus,
} from "./memory-records.js";
import { automaticVerifiedMergePromptEligibilityEnabled } from "./memory-prompt-policy.js";

export interface AuthoritativeGithubState {
  repositoryId: string;
  providerPullRequestId: string;
  merged: boolean;
  reverted?: boolean;
  baseSha: string;
  headSha: string;
  mergeSha: string;
  manifestDigest: string;
  finalDiffDigest: string;
  occurredAt: string;
  sourceCursor?: string;
}

export interface MemoryActivationResult {
  status: "activated" | "reverted" | "unmatched";
  candidateIds: string[];
  recordIds: string[];
  errorCode?: "candidate_not_found" | "activation_requirement_unsatisfied" | "evidence_mismatch" | "transition_invalid";
}

interface CorrelationRow {
  candidate_id: string;
  aggregate_version: number;
  current_status: string;
  candidate_json: string;
  receipt_json: string;
  producer_run_id: string;
  repository_row_id: string;
  repository_id: string;
  base_sha: string;
  provider_pull_request_id: string | null;
  pr_head_sha: string | null;
  candidate_tree_sha: string | null;
  evidence_manifest_row_id: string;
  manifest_digest: string;
}

interface EvidenceRow {
  evidence_row_id: string;
  producer_ref_id: string;
  type: string;
  digest: string;
  origin_id: string;
  source_authority: EvidenceHandleV1["source_authority"];
}

interface AttestationRow {
  attestation_row_id: string;
  provider_event_id: string;
  payload_digest: string;
}

interface ActivationClaimRow {
  aggregate_version: number;
  current_candidate_id: string | null;
  current_record_id: string | null;
  current_record_version: number | null;
}

export class MemoryActivationError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: "evidence_unresolvable" | "evidence_mismatch" | "activation_requirement_unsatisfied" | "transition_invalid",
  ) {
    super(message);
    this.name = "MemoryActivationError";
  }
}

function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

function correlationRows(input: {
  orgId: string;
  projectId: string;
  repositoryRowId: string;
  providerPullRequestId: string | undefined;
  statuses: string[];
}): CorrelationRow[] {
  if (!input.providerPullRequestId || input.statuses.length === 0) return [];
  return db.prepare(
    `SELECT candidate.candidate_id, candidate.aggregate_version, candidate.current_status,
            candidate.candidate_json, receipt.receipt_json, receipt.producer_run_id,
            receipt.repository_row_id, receipt.repository_id, receipt.base_sha,
            json_extract(receipt.receipt_json, '$.repository.provider_pull_request_id') AS provider_pull_request_id,
            json_extract(receipt.receipt_json, '$.repository.pr_head_sha') AS pr_head_sha,
            json_extract(receipt.receipt_json, '$.repository.candidate_tree_sha') AS candidate_tree_sha,
            candidate.evidence_manifest_row_id, manifest.manifest_digest
     FROM memory_candidates_v1 candidate
     INNER JOIN memory_run_receipts receipt ON receipt.receipt_id = candidate.receipt_id
     INNER JOIN memory_evidence_manifests manifest
       ON manifest.evidence_manifest_row_id = candidate.evidence_manifest_row_id
     WHERE candidate.org_id = ? AND candidate.project_id = ?
       AND candidate.repository_row_id = ?
       AND candidate.current_status IN (${input.statuses.map(() => "?").join(",")})
       AND json_extract(receipt.receipt_json, '$.repository.provider_pull_request_id') = ?
     ORDER BY candidate.created_at, candidate.candidate_id`,
  ).all(
    input.orgId,
    input.projectId,
    input.repositoryRowId,
    ...input.statuses,
    input.providerPullRequestId,
  ) as unknown as CorrelationRow[];
}

function candidateEvidence(candidateId: string): EvidenceRow[] {
  return db.prepare(
    `SELECT ref.evidence_row_id, ref.producer_ref_id, ref.type, ref.digest,
            ref.origin_id, ref.source_authority
     FROM memory_candidate_evidence link
     INNER JOIN memory_evidence_refs ref ON ref.evidence_row_id = link.evidence_row_id
     WHERE link.candidate_id = ?
     ORDER BY ref.producer_ref_id`,
  ).all(candidateId) as unknown as EvidenceRow[];
}

function claimKey(candidate: MemoryCandidateV1): string {
  return canonicalMemoryClaimKey({
    kind: candidate.kind,
    content: candidate.content,
    applicability: candidate.applicability as CodebaseApplicabilityV1,
    provenance: { extractor_version: candidate.extraction.extractor_version },
  });
}

function conflictKey(candidate: MemoryCandidateV1): string {
  return canonicalMemoryConflictKey({
    kind: candidate.kind,
    applicability: candidate.applicability as CodebaseApplicabilityV1,
  });
}

function requestedPredecessor(candidate: MemoryCandidateV1): string | null {
  const value = candidate.extensions?.supersedes_record_id;
  if (value === undefined) return null;
  if (typeof value === "string" && /^mem_[A-Za-z0-9_-]{1,124}$/.test(value)) return value;
  throw new MemoryActivationError(
    "The declared predecessor record identifier is invalid",
    409,
    "activation_requirement_unsatisfied",
  );
}

function enqueueIndependentOriginRevalidation(input: {
  orgId: string;
  projectId: string;
  recordId: string;
  candidateId: string;
  now: string;
}): void {
  const aggregate = db.prepare(
    "SELECT aggregate_version FROM memory_records WHERE record_id = ?",
  ).get(input.recordId) as { aggregate_version: number } | undefined;
  if (!aggregate) return;
  const jobId = `job_record_revalidation_${canonicalJsonSha256({
    record_id: input.recordId,
    candidate_id: input.candidateId,
  }).slice("sha256:".length, "sha256:".length + 32)}`;
  db.prepare(
    `INSERT OR IGNORE INTO memory_outbox
       (job_id, org_id, project_id, job_type, aggregate_type, aggregate_id,
        expected_version, payload_json, status, attempt_count, max_attempts,
        next_attempt_at, lease_owner, lease_expires_at, last_error_code,
        last_error_message, created_at, updated_at, completed_at)
     VALUES (?, ?, ?, 'record_revalidation', 'record', ?, ?, ?, 'pending', 0, 5,
             ?, NULL, NULL, NULL, NULL, ?, ?, NULL)`,
  ).run(
    jobId,
    input.orgId,
    input.projectId,
    input.recordId,
    aggregate.aggregate_version,
    JSON.stringify({ candidate_id: input.candidateId }),
    input.now,
    input.now,
    input.now,
  );
}

function persistEvidenceOrigins(input: {
  orgId: string;
  projectId: string;
  evidence: EvidenceRow[];
  now: string;
}): Map<string, EvidenceHandleV1> {
  const handles = new Map<string, EvidenceHandleV1>();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO memory_origins
       (origin_row_id, org_id, project_id, origin_key, source_type, source_identity,
        immutable_digest, source_authority, evidence_row_id, attestation_row_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const evidence of input.evidence) {
    const key = canonicalJsonSha256({
      source_type: "evidence_ref",
      source_identity: evidence.origin_id,
      immutable_digest: evidence.digest,
    });
    insert.run(
      `origin_${randomUUID()}`,
      input.orgId,
      input.projectId,
      key,
      "evidence_ref",
      evidence.origin_id,
      evidence.digest,
      evidence.source_authority,
      evidence.evidence_row_id,
      null,
      input.now,
    );
    if (!handles.has(key)) {
      handles.set(key, {
        evidence_ref_id: evidence.evidence_row_id,
        type: evidence.type,
        digest: evidence.digest,
        origin_id: evidence.origin_id,
        source_authority: evidence.source_authority,
      });
    }
  }
  return handles;
}

function persistOrigins(input: {
  orgId: string;
  projectId: string;
  attestationRow: AttestationRow;
  evidence: EvidenceRow[];
  now: string;
}): EvidenceHandleV1[] {
  const handles = persistEvidenceOrigins(input);
  const attestationOrigin = canonicalJsonSha256({
    source_type: "github_attestation",
    source_identity: input.attestationRow.provider_event_id,
    immutable_digest: input.attestationRow.payload_digest,
  });
  const insert = db.prepare(
    `INSERT OR IGNORE INTO memory_origins
       (origin_row_id, org_id, project_id, origin_key, source_type, source_identity,
        immutable_digest, source_authority, evidence_row_id, attestation_row_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run(
    `origin_${randomUUID()}`,
    input.orgId,
    input.projectId,
    attestationOrigin,
    "github_attestation",
    input.attestationRow.provider_event_id,
    input.attestationRow.payload_digest,
    "verified",
    null,
    input.attestationRow.attestation_row_id,
    input.now,
  );
  handles.set(attestationOrigin, {
    evidence_ref_id: input.attestationRow.attestation_row_id,
    type: "github_merge",
    digest: input.attestationRow.payload_digest,
    origin_id: input.attestationRow.provider_event_id,
    source_authority: "verified",
  });
  return [...handles.values()];
}

function persistReviewOrigin(input: {
  orgId: string;
  projectId: string;
  decisionId: string;
  reviewerId: string;
  decisionDigest: string;
  evidence: EvidenceRow[];
  now: string;
}): EvidenceHandleV1[] {
  const handles = persistEvidenceOrigins(input);
  const originKey = canonicalJsonSha256({
    source_type: "authorized_review",
    source_identity: `${input.reviewerId}:${input.decisionId}`,
    immutable_digest: input.decisionDigest,
  });
  db.prepare(
    `INSERT OR IGNORE INTO memory_origins
       (origin_row_id, org_id, project_id, origin_key, source_type, source_identity,
        immutable_digest, source_authority, evidence_row_id, attestation_row_id,
        decision_id, created_at)
     VALUES (?, ?, ?, ?, 'authorized_review', ?, ?, 'authorized_review',
             NULL, NULL, ?, ?)`,
  ).run(
    `origin_${randomUUID()}`,
    input.orgId,
    input.projectId,
    originKey,
    `${input.reviewerId}:${input.decisionId}`,
    input.decisionDigest,
    input.decisionId,
    input.now,
  );
  handles.set(originKey, {
    evidence_ref_id: input.decisionId,
    type: "authorized_review",
    digest: input.decisionDigest,
    origin_id: input.reviewerId,
    source_authority: "authorized_review",
  });
  return [...handles.values()];
}

function enqueueRecordProjectionJobs(input: {
  orgId: string;
  projectId: string;
  recordId: string;
  recordVersion: number;
  now: string;
}): void {
  const projection = db.prepare(
    `SELECT aggregate_version, current_status
     FROM memory_records WHERE record_id = ?`,
  ).get(input.recordId) as { aggregate_version: number; current_status: string } | undefined;
  if (!projection) throw new MemoryActivationError("Record projection target is unavailable", 409, "transition_invalid");
  const insert = db.prepare(
    `INSERT OR IGNORE INTO memory_outbox
       (job_id, org_id, project_id, job_type, aggregate_type, aggregate_id,
        expected_version, payload_json, status, attempt_count, max_attempts,
        next_attempt_at, lease_owner, lease_expires_at, last_error_code,
        last_error_message, created_at, updated_at, completed_at)
     VALUES (?, ?, ?, ?, 'record', ?, ?, ?, 'pending', 0, 5, ?, NULL, NULL,
             NULL, NULL, ?, ?, NULL)`,
  );
  for (const jobType of ["record_embedding", "record_search_index"] as const) {
    const jobId = `job_${jobType}_${canonicalJsonSha256({
      record_id: input.recordId,
      record_version: input.recordVersion,
      aggregate_version: projection.aggregate_version,
      status: projection.current_status,
    }).slice("sha256:".length, "sha256:".length + 32)}`;
    insert.run(
      jobId,
      input.orgId,
      input.projectId,
      jobType,
      input.recordId,
      projection.aggregate_version,
      JSON.stringify({
        record_id: input.recordId,
        record_version: input.recordVersion,
        status: projection.current_status,
      }),
      input.now,
      input.now,
      input.now,
    );
  }
}

function commitCandidateActivation(input: {
  orgId: string;
  projectId: string;
  repositoryRowId: string;
  stored: StoredMemoryCandidate;
  receipt: RunReceiptV1;
  producerRunId: string;
  manifestDigest: string;
  evidence: EvidenceHandleV1[];
  evidenceStrength: EvidenceSummaryV1["strength"];
  promptEligible: boolean;
  lastConfirmedAt: string;
  actorId: string;
  actorType: string;
  reasonCode: string;
  explanation: string;
  fromStatus: "pending_merge" | "pending_review";
  decisionRefs?: string[];
  attestationRowId?: string | null;
  provenance: Record<string, unknown>;
  now: string;
}): MemoryRecordV1 {
  const stored = input.stored;
  const candidate = stored.candidate;
  return withImmediateTransaction(() => {
    const key = conflictKey(candidate);
    const canonicalKey = claimKey(candidate);
    const predecessorRecordId = requestedPredecessor(candidate);
    db.prepare(
      `INSERT OR IGNORE INTO memory_activation_claims
         (org_id, project_id, repository_row_id, plane, conflict_key, aggregate_version,
          current_candidate_id, current_record_id, current_record_version, created_at, updated_at)
       VALUES (?, ?, ?, 'codebase', ?, 1, NULL, NULL, NULL, ?, ?)`,
    ).run(input.orgId, input.projectId, input.repositoryRowId, key, input.now, input.now);
    const claim = db.prepare(
      `SELECT aggregate_version, current_candidate_id, current_record_id, current_record_version
       FROM memory_activation_claims
       WHERE org_id = ? AND project_id = ? AND repository_row_id = ?
         AND plane = 'codebase' AND conflict_key = ?`,
    ).get(
      input.orgId,
      input.projectId,
      input.repositoryRowId,
      key,
    ) as unknown as ActivationClaimRow;

    if (claim.current_record_id && claim.current_record_version) {
      const current = db.prepare(
        `SELECT current_status, claim_key
         FROM memory_records
         WHERE org_id = ? AND project_id = ? AND repository_row_id = ?
           AND record_id = ? AND current_version = ?`,
      ).get(
        input.orgId,
        input.projectId,
        input.repositoryRowId,
        claim.current_record_id,
        claim.current_record_version,
      ) as { current_status: string; claim_key: string } | undefined;
      if (!current || current.current_status !== "active") {
        throw new MemoryActivationError(
          "The applicability conflict lock does not resolve to an active record",
          409,
          "transition_invalid",
        );
      }
      const reusesCurrentClaim = current.claim_key === canonicalKey;
      const explicitlySupersedesCurrent = predecessorRecordId === claim.current_record_id;
      if ((predecessorRecordId && !explicitlySupersedesCurrent)
          || (reusesCurrentClaim && predecessorRecordId)
          || (!reusesCurrentClaim && !explicitlySupersedesCurrent)) {
        throw new MemoryActivationError(
          predecessorRecordId
            ? "The declared predecessor is not a valid successor target for this applicability scope"
            : "A different active claim already owns this applicability scope",
          409,
          "activation_requirement_unsatisfied",
        );
      }
    } else if (predecessorRecordId) {
      throw new MemoryActivationError(
        "The declared predecessor is not the current record for this applicability scope",
        409,
        "activation_requirement_unsatisfied",
      );
    }

    const inactiveCanonical = db.prepare(
      `SELECT record_id FROM memory_records
       WHERE org_id = ? AND project_id = ? AND claim_key = ?
         AND current_status <> 'active'`,
    ).get(input.orgId, input.projectId, canonicalKey);
    if (inactiveCanonical) {
      throw new MemoryActivationError(
        "The canonical claim exists only in inactive history and requires explicit revalidation",
        409,
        "activation_requirement_unsatisfied",
      );
    }

    const recordId = `mem_${stored.row.candidate_id.slice("candidate_".length)}`;
    const applicability = candidate.applicability as CodebaseApplicabilityV1;
    const record = importActiveMemoryRecord({
      orgId: input.orgId,
      projectId: input.projectId,
      repositoryRowId: input.repositoryRowId,
      recordId,
      kind: candidate.kind,
      content: candidate.content,
      applicability,
      exceptions: candidate.exceptions,
      compatibility: {
        harness_version_range: input.receipt.producer.harness_version,
        workflow_version_range: input.receipt.producer.workflow_version,
        adapter_version_range: input.receipt.producer.adapter_version,
      },
      validation: candidate.validation,
      evidence: input.evidence,
      evidenceSummary: { strength: input.evidenceStrength, ref_count: input.evidence.length },
      freshness: { last_confirmed_at: input.lastConfirmedAt, expires_at: null },
      promptEligible: input.promptEligible,
      provenance: {
        candidate_id: stored.row.candidate_id,
        producer_run_id: input.producerRunId,
        producer: input.receipt.producer,
        extraction: candidate.extraction,
        extractor_version: candidate.extraction.extractor_version,
        manifest_digest: input.manifestDigest,
        ...input.provenance,
      },
      validFrom: input.lastConfirmedAt,
      actorId: input.actorId,
      actorType: input.actorType,
      decisionRefs: input.decisionRefs,
      reasonCode: input.reasonCode,
      transitionExplanation: input.explanation,
      now: input.now,
    });
    const reusedCanonicalClaim = record.record_id !== recordId;
    db.prepare(
      "UPDATE memory_records SET shadow_recall_eligible = 1 WHERE record_id = ?",
    ).run(record.record_id);

    let supersessionTransitionId: string | null = null;
    let predecessorVersion: number | null = null;
    if (predecessorRecordId) {
      if (predecessorRecordId === record.record_id) {
        throw new MemoryActivationError("A record cannot supersede itself", 409, "transition_invalid");
      }
      const predecessorState = db.prepare(
        `SELECT current_version, current_status
         FROM memory_records
         WHERE org_id = ? AND project_id = ? AND repository_row_id = ?
           AND record_id = ?`,
      ).get(
        input.orgId,
        input.projectId,
        input.repositoryRowId,
        predecessorRecordId,
      ) as { current_version: number; current_status: string } | undefined;
      if (!predecessorState || predecessorState.current_status !== "active") {
        throw new MemoryActivationError(
          "The declared predecessor is not an active record in this repository scope",
          409,
          "activation_requirement_unsatisfied",
        );
      }
      predecessorVersion = predecessorState.current_version;
      const predecessorRecord = transitionMemoryRecordStatus({
        orgId: input.orgId,
        projectId: input.projectId,
        recordId: predecessorRecordId,
        toStatus: "superseded",
        actorId: input.actorId,
        reasonCode: "verified_successor_activated",
        explanation: "A verified successor replaced this applicability claim.",
        now: input.now,
      });
      supersessionTransitionId = predecessorRecord?.transition_summary.transition_id ?? null;
    }

    markMemoryCandidateActive({
      candidateId: stored.row.candidate_id,
      expectedVersion: stored.row.aggregate_version,
      recordId: record.record_id,
      recordVersion: record.record_version,
      actorId: input.actorId,
      actorType: input.actorType,
      fromStatus: input.fromStatus,
      decisionRefs: input.decisionRefs,
      reasonCode: input.reasonCode,
      explanation: input.explanation,
      now: input.now,
    });
    const claimUpdate = db.prepare(
      `UPDATE memory_activation_claims
       SET aggregate_version = aggregate_version + 1, current_candidate_id = ?,
           current_record_id = ?, current_record_version = ?, updated_at = ?
       WHERE org_id = ? AND project_id = ? AND repository_row_id = ?
         AND plane = 'codebase' AND conflict_key = ? AND aggregate_version = ?`,
    ).run(
      stored.row.candidate_id,
      record.record_id,
      record.record_version,
      input.now,
      input.orgId,
      input.projectId,
      input.repositoryRowId,
      key,
      claim.aggregate_version,
    );
    if (claimUpdate.changes !== 1) {
      throw new MemoryActivationError("Activation claim changed concurrently", 409, "transition_invalid");
    }
    if (supersessionTransitionId && predecessorRecordId && predecessorVersion) {
      db.prepare(
        `INSERT INTO memory_record_supersessions
           (supersession_id, org_id, project_id, predecessor_record_id,
            predecessor_record_version, successor_record_id, successor_record_version,
            candidate_id, attestation_row_id, transition_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        `supersession_${randomUUID()}`,
        input.orgId,
        input.projectId,
        predecessorRecordId,
        predecessorVersion,
        record.record_id,
        record.record_version,
        stored.row.candidate_id,
        input.attestationRowId ?? null,
        supersessionTransitionId,
        input.now,
      );
    }
    if (reusedCanonicalClaim) {
      enqueueIndependentOriginRevalidation({
        orgId: input.orgId,
        projectId: input.projectId,
        recordId: record.record_id,
        candidateId: stored.row.candidate_id,
        now: input.now,
      });
    }
    enqueueRecordProjectionJobs({
      orgId: input.orgId,
      projectId: input.projectId,
      recordId: record.record_id,
      recordVersion: record.record_version,
      now: input.now,
    });
    return record;
  });
}

function activateCandidate(input: {
  orgId: string;
  projectId: string;
  repositoryRowId: string;
  correlation: CorrelationRow;
  attestationRow: AttestationRow;
  state: AuthoritativeGithubState;
  now: string;
}): MemoryRecordV1 {
  return withImmediateTransaction(() => {
    const stored = getStoredMemoryCandidate(
      input.orgId,
      input.projectId,
      input.correlation.candidate_id,
    );
    if (!stored) throw new MemoryActivationError("Candidate is unavailable", 409, "transition_invalid");
    if (stored.row.current_status === "active" && stored.row.active_record_id && stored.row.active_record_version) {
      const record = getMemoryRecord(
        input.orgId,
        input.projectId,
        stored.row.active_record_id,
        stored.row.active_record_version,
      );
      if (!record) throw new MemoryActivationError("Active candidate projection is inconsistent", 409, "transition_invalid");
      return record;
    }
    if (stored.row.current_status !== "pending_merge") {
      throw new MemoryActivationError("Candidate is not pending verified merge", 409, "transition_invalid");
    }
    const evidence = persistOrigins({
      orgId: input.orgId,
      projectId: input.projectId,
      attestationRow: input.attestationRow,
      evidence: candidateEvidence(stored.row.candidate_id),
      now: input.now,
    });
    return commitCandidateActivation({
      orgId: input.orgId,
      projectId: input.projectId,
      repositoryRowId: input.repositoryRowId,
      stored,
      receipt: parseJson<RunReceiptV1>(input.correlation.receipt_json),
      producerRunId: input.correlation.producer_run_id,
      manifestDigest: input.correlation.manifest_digest,
      evidence,
      evidenceStrength: "verified_merge",
      promptEligible: automaticVerifiedMergePromptEligibilityEnabled(
        input.orgId,
        input.projectId,
      ),
      lastConfirmedAt: input.state.occurredAt,
      actorId: input.attestationRow.attestation_row_id,
      actorType: "system",
      reasonCode: "verified_merge_activated",
      explanation: "Independently verified merge evidence satisfied the candidate activation policy.",
      fromStatus: "pending_merge",
      attestationRowId: input.attestationRow.attestation_row_id,
      provenance: { attestation_id: input.attestationRow.attestation_row_id },
      now: input.now,
    });
  });
}

export function activateReviewedMemoryCandidate(input: {
  orgId: string;
  projectId: string;
  candidateId: string;
  reviewerId: string;
  decisionId: string;
  decision: MemoryCandidateDecisionV1;
  now?: string;
}): MemoryRecordV1 {
  const now = input.now ?? new Date().toISOString();
  return withImmediateTransaction(() => {
    const stored = getStoredMemoryCandidate(input.orgId, input.projectId, input.candidateId);
    if (!stored) throw new MemoryActivationError("Candidate is unavailable", 404, "transition_invalid");
    if (stored.row.current_status !== "pending_review"
        || stored.row.activation_requirement !== "authorized_review"
        || stored.candidate.plane !== "codebase"
        || stored.candidate.kind !== "anti_pattern") {
      throw new MemoryActivationError(
        "Only structurally valid pending-review codebase anti-patterns may use authorized review",
        409,
        "activation_requirement_unsatisfied",
      );
    }
    const applicability = stored.candidate.applicability as CodebaseApplicabilityV1;
    const receipt = db.prepare(
      `SELECT run.receipt_json, run.producer_run_id, run.repository_row_id,
              run.repository_id, manifest.manifest_digest
       FROM memory_run_receipts run
       INNER JOIN memory_evidence_manifests manifest
         ON manifest.evidence_manifest_row_id = ? AND manifest.receipt_id = run.receipt_id
       WHERE run.receipt_id = ? AND run.org_id = ? AND run.project_id = ?`,
    ).get(
      stored.row.evidence_manifest_row_id,
      stored.row.receipt_id,
      input.orgId,
      input.projectId,
    ) as {
      receipt_json: string;
      producer_run_id: string;
      repository_row_id: string | null;
      repository_id: string | null;
      manifest_digest: string;
    } | undefined;
    if (!receipt || !receipt.repository_row_id
        || receipt.repository_row_id !== stored.row.repository_row_id
        || receipt.repository_id !== applicability.repository_id) {
      throw new MemoryActivationError(
        "Candidate review cannot resolve its authenticated repository provenance",
        422,
        "evidence_mismatch",
      );
    }
    const evidenceRows = candidateEvidence(input.candidateId);
    if (!evidenceRows.some((row) => row.type === "failure")) {
      throw new MemoryActivationError(
        "Authorized anti-pattern review requires resolvable failure evidence",
        422,
        "evidence_unresolvable",
      );
    }
    const availableProducerRefs = new Set(evidenceRows.map((row) => row.producer_ref_id));
    if ((input.decision.evidence_refs ?? []).some((ref) => !availableProducerRefs.has(ref))) {
      throw new MemoryActivationError(
        "Review decision cites evidence outside the candidate manifest",
        422,
        "evidence_unresolvable",
      );
    }
    const decisionDigest = canonicalJsonSha256(input.decision);
    const evidence = persistReviewOrigin({
      orgId: input.orgId,
      projectId: input.projectId,
      decisionId: input.decisionId,
      reviewerId: input.reviewerId,
      decisionDigest,
      evidence: evidenceRows,
      now,
    });
    return commitCandidateActivation({
      orgId: input.orgId,
      projectId: input.projectId,
      repositoryRowId: receipt.repository_row_id,
      stored,
      receipt: parseJson<RunReceiptV1>(receipt.receipt_json),
      producerRunId: receipt.producer_run_id,
      manifestDigest: receipt.manifest_digest,
      evidence,
      evidenceStrength: "reviewed",
      promptEligible: true,
      lastConfirmedAt: input.decision.event_time,
      actorId: input.reviewerId,
      actorType: "reviewer",
      reasonCode: input.decision.reason_code,
      explanation: input.decision.explanation ?? "Authorized reviewer approved the anti-pattern evidence.",
      fromStatus: "pending_review",
      decisionRefs: [input.decisionId],
      provenance: {
        decision_id: input.decisionId,
        reviewer_principal_id: input.reviewerId,
      },
      now,
    });
  });
}

function correlationsMatch(
  row: CorrelationRow,
  attestation: MemoryAttestationV1,
  state: AuthoritativeGithubState,
): boolean {
  if (row.repository_id !== state.repositoryId || row.repository_id !== attestation.repository_id) return false;
  if (row.provider_pull_request_id !== state.providerPullRequestId
      || row.provider_pull_request_id !== attestation.provider_pull_request_id) return false;
  if (row.base_sha !== state.baseSha || row.base_sha !== attestation.base_sha) return false;
  if (!row.pr_head_sha || row.pr_head_sha !== state.headSha || row.pr_head_sha !== attestation.head_sha) return false;
  if (!row.candidate_tree_sha || row.candidate_tree_sha !== row.pr_head_sha) return false;
  if (row.manifest_digest !== state.manifestDigest || row.manifest_digest !== attestation.manifest_digest) return false;
  const diff = candidateEvidence(row.candidate_id).find((evidence) => evidence.type === "git_diff");
  return Boolean(diff && diff.digest === state.finalDiffDigest);
}

function revertCandidateRecord(input: {
  orgId: string;
  projectId: string;
  repositoryRowId: string;
  correlation: CorrelationRow;
  attestationRow: AttestationRow;
  now: string;
}): string {
  return withImmediateTransaction(() => {
    const stored = getStoredMemoryCandidate(
      input.orgId,
      input.projectId,
      input.correlation.candidate_id,
    );
    if (!stored?.row.active_record_id || !stored.row.active_record_version) {
      throw new MemoryActivationError("Revert target is not active", 409, "transition_invalid");
    }
    const record = transitionMemoryRecordStatus({
      orgId: input.orgId,
      projectId: input.projectId,
      recordId: stored.row.active_record_id,
      toStatus: "revoked",
      actorId: input.attestationRow.attestation_row_id,
      reasonCode: "verified_merge_reverted",
      explanation: "Authoritative provider state verified that the activating merge was reverted.",
      now: input.now,
    });
    if (!record) throw new MemoryActivationError("Revert target record is unavailable", 409, "transition_invalid");
    db.prepare(
      `UPDATE memory_activation_claims
       SET aggregate_version = aggregate_version + 1, current_candidate_id = NULL,
           current_record_id = NULL, current_record_version = NULL, updated_at = ?
       WHERE org_id = ? AND project_id = ? AND repository_row_id = ?
         AND current_record_id = ? AND current_record_version = ?`,
    ).run(
      input.now,
      input.orgId,
      input.projectId,
      input.repositoryRowId,
      record.record_id,
      record.record_version,
    );
    enqueueRecordProjectionJobs({
      orgId: input.orgId,
      projectId: input.projectId,
      recordId: record.record_id,
      recordVersion: record.record_version,
      now: input.now,
    });
    return record.record_id;
  });
}

export function reconcileVerifiedGithubState(input: {
  orgId: string;
  projectId: string;
  repositoryRowId: string;
  attestationRowId: string;
  attestation: MemoryAttestationV1;
  state: AuthoritativeGithubState;
  now?: string;
}): MemoryActivationResult {
  const now = input.now ?? new Date().toISOString();
  const attestationRow = db.prepare(
    `SELECT attestation_row_id, provider_event_id, payload_digest
     FROM memory_attestations WHERE attestation_row_id = ?`,
  ).get(input.attestationRowId) as AttestationRow | undefined;
  if (!attestationRow) throw new MemoryActivationError("Verified attestation is unavailable", 409, "transition_invalid");
  if (input.state.repositoryId !== input.attestation.repository_id
      || input.state.providerPullRequestId !== input.attestation.provider_pull_request_id
      || input.state.manifestDigest !== input.attestation.manifest_digest) {
    return { status: "unmatched", candidateIds: [], recordIds: [], errorCode: "evidence_mismatch" };
  }

  if (input.attestation.type === "github_merge") {
    if (!input.state.merged || !input.state.mergeSha
        || (input.attestation.merge_sha && input.attestation.merge_sha !== input.state.mergeSha)) {
      return {
        status: "unmatched",
        candidateIds: [],
        recordIds: [],
        errorCode: "activation_requirement_unsatisfied",
      };
    }
    const rows = correlationRows({
      orgId: input.orgId,
      projectId: input.projectId,
      repositoryRowId: input.repositoryRowId,
      providerPullRequestId: input.attestation.provider_pull_request_id,
      statuses: ["pending_merge", "active"],
    });
    if (rows.length === 0) {
      return { status: "unmatched", candidateIds: [], recordIds: [], errorCode: "candidate_not_found" };
    }
    const matches = rows.filter((row) => correlationsMatch(row, input.attestation, input.state));
    if (matches.length !== 1) {
      return {
        status: "unmatched",
        candidateIds: matches.map((row) => row.candidate_id),
        recordIds: [],
        errorCode: "evidence_mismatch",
      };
    }
    const match = matches[0];
    const stored = getStoredMemoryCandidate(input.orgId, input.projectId, match.candidate_id);
    if (stored?.row.current_status === "active" && stored.row.active_record_id) {
      return {
        status: "activated",
        candidateIds: [match.candidate_id],
        recordIds: [stored.row.active_record_id],
      };
    }
    const record = activateCandidate({
      orgId: input.orgId,
      projectId: input.projectId,
      repositoryRowId: input.repositoryRowId,
      correlation: match,
      attestationRow,
      state: input.state,
      now,
    });
    return { status: "activated", candidateIds: [match.candidate_id], recordIds: [record.record_id] };
  }

  if (!input.state.reverted) {
    return {
      status: "unmatched",
      candidateIds: [],
      recordIds: [],
      errorCode: "activation_requirement_unsatisfied",
    };
  }
  const rows = correlationRows({
    orgId: input.orgId,
    projectId: input.projectId,
    repositoryRowId: input.repositoryRowId,
    providerPullRequestId: input.attestation.provider_pull_request_id,
    statuses: ["active"],
  });
  const matches = rows.filter((row) => correlationsMatch(row, input.attestation, input.state));
  if (matches.length !== 1) {
    return {
      status: "unmatched",
      candidateIds: matches.map((row) => row.candidate_id),
      recordIds: [],
      errorCode: matches.length === 0 ? "candidate_not_found" : "evidence_mismatch",
    };
  }
  const recordId = revertCandidateRecord({
    orgId: input.orgId,
    projectId: input.projectId,
    repositoryRowId: input.repositoryRowId,
    correlation: matches[0],
    attestationRow,
    now,
  });
  return { status: "reverted", candidateIds: [matches[0].candidate_id], recordIds: [recordId] };
}
