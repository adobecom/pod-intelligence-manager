import { randomUUID } from "node:crypto";
import {
  canonicalJsonSha256,
  type EvidenceHandleV1,
  type HarnessApplicabilityV1,
  type MemoryCandidateDecisionV1,
  type RunReceiptV1,
} from "@pim/shared";
import db, { withImmediateTransaction } from "../db/connection.js";
import {
  getStoredMemoryCandidate,
  markMemoryCandidateActive,
} from "./memory-candidates.js";
import {
  importActiveHarnessMemoryRecord,
  type HarnessMemoryRecord,
} from "./memory-harness-records.js";

interface EvidenceRow {
  evidence_row_id: string;
  producer_ref_id: string;
  type: string;
  digest: string;
  origin_id: string;
  source_authority: EvidenceHandleV1["source_authority"];
}

interface VerifiedFiestaMergeRow {
  attestation_row_id: string;
  provider_event_id: string;
  payload_digest: string;
  repository_id: string;
  merge_sha: string;
}

export class MemoryHarnessActivationError extends Error {
  constructor(
    message: string,
    readonly statusCode: 409 | 422,
    readonly code:
      | "activation_requirement_unsatisfied"
      | "evidence_unresolvable"
      | "evidence_mismatch"
      | "transition_invalid",
  ) {
    super(message);
    this.name = "MemoryHarnessActivationError";
  }
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

function verifiedFiestaMerge(input: {
  orgId: string;
  projectId: string;
  manifestDigest: string;
  diffDigest: string;
}): VerifiedFiestaMergeRow | null {
  const repositoryId = process.env.MEMORY_FIESTA_REPOSITORY_ID?.trim().toLowerCase();
  if (!repositoryId?.startsWith("github.com/") || repositoryId.split("/").length !== 3) {
    return null;
  }
  return (db.prepare(
    `SELECT attestation.attestation_row_id, attestation.provider_event_id,
            attestation.payload_digest, repository.repository_id,
            attestation.merge_sha
     FROM memory_attestations attestation
     INNER JOIN memory_repository_registry repository
       ON repository.repository_row_id = attestation.repository_row_id
     WHERE attestation.org_id = ? AND attestation.project_id = ?
       AND attestation.attestation_type = 'github_merge'
       AND repository.repository_id = ?
       AND attestation.manifest_digest = ?
       AND attestation.authoritative_diff_digest = ?
       AND attestation.merge_sha IS NOT NULL
     ORDER BY attestation.verified_at, attestation.attestation_row_id
     LIMIT 1`,
  ).get(
    input.orgId,
    input.projectId,
    repositoryId,
    input.manifestDigest,
    input.diffDigest,
  ) as VerifiedFiestaMergeRow | undefined) ?? null;
}

function persistReviewEvidence(input: {
  orgId: string;
  projectId: string;
  decisionId: string;
  reviewerId: string;
  decision: MemoryCandidateDecisionV1;
  evidence: EvidenceRow[];
  verifiedMerge: VerifiedFiestaMergeRow | null;
  now: string;
}): EvidenceHandleV1[] {
  const handles: EvidenceHandleV1[] = [];
  const insert = db.prepare(
    `INSERT OR IGNORE INTO memory_origins
       (origin_row_id, org_id, project_id, origin_key, source_type, source_identity,
        immutable_digest, source_authority, evidence_row_id, attestation_row_id,
        decision_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const evidence of input.evidence) {
    const originKey = canonicalJsonSha256({
      source_type: "evidence_ref",
      source_identity: evidence.origin_id,
      immutable_digest: evidence.digest,
    });
    insert.run(
      `origin_${randomUUID()}`,
      input.orgId,
      input.projectId,
      originKey,
      "evidence_ref",
      evidence.origin_id,
      evidence.digest,
      evidence.source_authority,
      evidence.evidence_row_id,
      null,
      null,
      input.now,
    );
    handles.push({
      evidence_ref_id: evidence.evidence_row_id,
      type: evidence.type,
      digest: evidence.digest,
      origin_id: evidence.origin_id,
      source_authority: evidence.source_authority,
    });
  }

  if (input.verifiedMerge) {
    const mergeOriginKey = canonicalJsonSha256({
      source_type: "github_attestation",
      source_identity: input.verifiedMerge.provider_event_id,
      immutable_digest: input.verifiedMerge.payload_digest,
    });
    insert.run(
      `origin_${randomUUID()}`,
      input.orgId,
      input.projectId,
      mergeOriginKey,
      "github_attestation",
      input.verifiedMerge.provider_event_id,
      input.verifiedMerge.payload_digest,
      "verified",
      null,
      input.verifiedMerge.attestation_row_id,
      null,
      input.now,
    );
    handles.push({
      evidence_ref_id: input.verifiedMerge.attestation_row_id,
      type: "github_merge",
      digest: input.verifiedMerge.payload_digest,
      origin_id: input.verifiedMerge.provider_event_id,
      source_authority: "verified",
    });
  }

  const decisionDigest = canonicalJsonSha256(input.decision);
  const reviewOriginKey = canonicalJsonSha256({
    source_type: "authorized_review",
    source_identity: `${input.reviewerId}:${input.decisionId}`,
    immutable_digest: decisionDigest,
  });
  insert.run(
    `origin_${randomUUID()}`,
    input.orgId,
    input.projectId,
    reviewOriginKey,
    "authorized_review",
    `${input.reviewerId}:${input.decisionId}`,
    decisionDigest,
    "authorized_review",
    null,
    null,
    input.decisionId,
    input.now,
  );
  handles.push({
    evidence_ref_id: input.decisionId,
    type: "authorized_review",
    digest: decisionDigest,
    origin_id: input.reviewerId,
    source_authority: "authorized_review",
  });
  return handles;
}

export function activateReviewedHarnessMemoryCandidate(input: {
  orgId: string;
  projectId: string;
  candidateId: string;
  reviewerId: string;
  decisionId: string;
  decision: MemoryCandidateDecisionV1;
  now?: string;
}): HarnessMemoryRecord {
  const now = input.now ?? new Date().toISOString();
  return withImmediateTransaction(() => {
    const stored = getStoredMemoryCandidate(input.orgId, input.projectId, input.candidateId);
    if (!stored || stored.row.current_status !== "pending_review"
        || stored.row.activation_requirement !== "authorized_review"
        || stored.candidate.plane !== "harness") {
      throw new MemoryHarnessActivationError(
        "Only validated pending-review harness candidates may activate",
        409,
        "activation_requirement_unsatisfied",
      );
    }
    const blockers = JSON.parse(stored.row.blockers_json) as string[];

    const receipt = db.prepare(
      `SELECT run.receipt_json, run.producer_run_id, run.producer_harness_id,
              manifest.manifest_digest
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
      producer_harness_id: string;
      manifest_digest: string;
    } | undefined;
    if (!receipt) {
      throw new MemoryHarnessActivationError(
        "Harness candidate evidence manifest is unavailable",
        422,
        "evidence_unresolvable",
      );
    }
    const receiptPayload = JSON.parse(receipt.receipt_json) as RunReceiptV1;
    const applicability = stored.candidate.applicability as HarnessApplicabilityV1;
    if (applicability.harness_id !== receipt.producer_harness_id
        || applicability.harness_id !== receiptPayload.producer.harness_id
        || stored.candidate.validation.failure_fingerprint !== receiptPayload.outcome.failure_fingerprint) {
      throw new MemoryHarnessActivationError(
        "Harness identity or stable failure fingerprint does not match its receipt",
        422,
        "evidence_mismatch",
      );
    }

    const evidenceRows = candidateEvidence(input.candidateId);
    if (evidenceRows.length !== stored.candidate.evidence_refs.length
        || !evidenceRows.some((row) => row.type === "failure")) {
      throw new MemoryHarnessActivationError(
        "Harness activation requires resolvable failure evidence",
        422,
        "evidence_unresolvable",
      );
    }
    const gitDiffs = evidenceRows.filter((row) => row.type === "git_diff");
    let verifiedMerge: VerifiedFiestaMergeRow | null = null;
    if (blockers.includes("verified_fiesta_merge_required") || gitDiffs.length > 0) {
      verifiedMerge = gitDiffs.length === 1
        ? verifiedFiestaMerge({
            orgId: input.orgId,
            projectId: input.projectId,
            manifestDigest: receipt.manifest_digest,
            diffDigest: gitDiffs[0]!.digest,
          })
        : null;
      if (!verifiedMerge) {
        throw new MemoryHarnessActivationError(
          "Harness code-change lessons require verified Fiesta merge evidence",
          409,
          "activation_requirement_unsatisfied",
        );
      }
    }
    const producerRefs = new Set(evidenceRows.map((row) => row.producer_ref_id));
    if ((input.decision.evidence_refs ?? []).some((ref) => !producerRefs.has(ref))) {
      throw new MemoryHarnessActivationError(
        "Review cites evidence outside the candidate manifest",
        422,
        "evidence_unresolvable",
      );
    }

    const evidence = persistReviewEvidence({
      orgId: input.orgId,
      projectId: input.projectId,
      decisionId: input.decisionId,
      reviewerId: input.reviewerId,
      decision: input.decision,
      evidence: evidenceRows,
      verifiedMerge,
      now,
    });
    const record = importActiveHarnessMemoryRecord({
      orgId: input.orgId,
      projectId: input.projectId,
      recordId: `mem_${stored.row.candidate_id.slice("candidate_".length)}`,
      kind: stored.candidate.kind,
      content: stored.candidate.content,
      applicability,
      exceptions: stored.candidate.exceptions,
      compatibility: {
        harness_version_range: applicability.harness_version_range
          ?? receiptPayload.producer.harness_version,
        workflow_version_range: applicability.workflow_version_range
          ?? receiptPayload.producer.workflow_version,
        adapter_version_range: applicability.adapter_version_range
          ?? receiptPayload.producer.adapter_version,
      },
      validation: stored.candidate.validation,
      evidence,
      evidenceSummary: { strength: "reviewed", ref_count: evidence.length },
      freshness: { last_confirmed_at: input.decision.event_time, expires_at: null },
      provenance: {
        candidate_id: stored.row.candidate_id,
        producer_run_id: receipt.producer_run_id,
        producer: receiptPayload.producer,
        extraction: stored.candidate.extraction,
        extractor_version: stored.candidate.extraction.extractor_version,
        manifest_digest: receipt.manifest_digest,
        failure_fingerprint: stored.candidate.validation.failure_fingerprint,
        decision_id: input.decisionId,
        reviewer_principal_id: input.reviewerId,
        fiesta_merge_attestation_id: verifiedMerge?.attestation_row_id ?? null,
        fiesta_merge_repository_id: verifiedMerge?.repository_id ?? null,
        fiesta_merge_sha: verifiedMerge?.merge_sha ?? null,
        shadow_only: true,
      },
      actorId: input.reviewerId,
      decisionRefs: [input.decisionId],
      reasonCode: input.decision.reason_code,
      explanation: input.decision.explanation
        ?? "Authorized review approved this harness lesson for shadow-only retrieval.",
      now,
    });
    markMemoryCandidateActive({
      candidateId: stored.row.candidate_id,
      expectedVersion: stored.row.aggregate_version,
      recordId: record.recordId,
      recordVersion: record.recordVersion,
      actorId: input.reviewerId,
      actorType: "reviewer",
      fromStatus: "pending_review",
      decisionRefs: [input.decisionId],
      reasonCode: input.decision.reason_code,
      explanation: input.decision.explanation
        ?? "Authorized review activated this harness lesson in permanent shadow mode.",
      now,
    });
    return record;
  });
}
