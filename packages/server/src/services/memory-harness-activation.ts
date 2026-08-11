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
  type StoredMemoryCandidate,
} from "./memory-candidates.js";
import {
  importActiveHarnessMemoryRecord,
  type HarnessMemoryRecord,
} from "./memory-harness-records.js";
import {
  assertMemoryV2StoredCandidateFacet,
  memoryV2NativeHarnessRecordProjectionDigest,
  memoryV2NativeHarnessRuntimeEvidenceDigest,
  type MemoryV2HarnessSubtype,
} from "./memory-v2-canonical-writes.js";
import { ensureMemoryV2ReverificationAdmission } from "./memory-v2-reverification-admission.js";
import { memoryV2ReverificationEnabled } from "./memory-v2-reverification.js";
import { ensureMemoryV2EvidenceVerifiedTrust } from "./memory-v2-trust.js";

interface EvidenceRow {
  evidence_row_id: string;
  producer_ref_id: string;
  type: string;
  digest: string;
  origin_id: string;
  source_authority: EvidenceHandleV1["source_authority"];
}

interface NativeHarnessScopeRow {
  receipt_id: string;
  resource_row_id: string;
  producer_run_id: string;
  scope_snapshot_digest: string;
  scope_snapshot_json: string;
}

interface NativeRuntimeEvidenceRow {
  evidence_ref_id: string;
  origin_id: string;
  corroboration_domain_id: string;
  immutable_digest: string;
  source_authority: "observed" | "verified";
  effective_root_origin_id: string | null;
  observation_type: string;
  outcome_json: string;
  occurred_at: string;
}

type NativeHarnessValidationStrategy =
  | "stable_failure_fingerprint"
  | "runtime_attestation"
  | "authorized_review";

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

function persistReviewEvidence(input: {
  orgId: string;
  projectId: string;
  decisionId: string;
  reviewerId: string;
  decision: MemoryCandidateDecisionV1;
  evidence: EvidenceRow[];
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

function persistNativeReviewOrigin(input: {
  orgId: string;
  projectId: string;
  decisionId: string;
  reviewerId: string;
  decision: MemoryCandidateDecisionV1;
  now: string;
}): EvidenceHandleV1 {
  const decisionDigest = canonicalJsonSha256(input.decision);
  const reviewOriginKey = canonicalJsonSha256({
    source_type: "authorized_review",
    source_identity: `${input.reviewerId}:${input.decisionId}`,
    immutable_digest: decisionDigest,
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
    reviewOriginKey,
    `${input.reviewerId}:${input.decisionId}`,
    decisionDigest,
    input.decisionId,
    input.now,
  );
  return {
    evidence_ref_id: input.decisionId,
    type: "authorized_review",
    digest: decisionDigest,
    origin_id: input.reviewerId,
    source_authority: "authorized_review",
  };
}

function nativeHarnessScope(receiptId: string): NativeHarnessScopeRow | null {
  return (db.prepare(
    `SELECT receipt_id, resource_row_id, producer_run_id, scope_snapshot_digest,
            scope_snapshot_json
     FROM memory_v2_scope_snapshots
     WHERE receipt_id = ? AND plane = 'harness'`,
  ).get(receiptId) as NativeHarnessScopeRow | undefined) ?? null;
}

function activateReviewedNativeHarnessMemoryCandidate(input: {
  stored: StoredMemoryCandidate;
  scope: NativeHarnessScopeRow;
  orgId: string;
  projectId: string;
  reviewerId: string;
  decisionId: string;
  decision: MemoryCandidateDecisionV1;
  now: string;
}): HarnessMemoryRecord {
  assertMemoryV2StoredCandidateFacet(input.stored.row.candidate_id);
  const facet = db.prepare(
    `SELECT resource_row_id, broad_kind, subtype, projection_status
     FROM memory_v2_candidate_facets
     WHERE candidate_id = ? AND org_id = ? AND project_id = ? AND plane = 'harness'`,
  ).get(
    input.stored.row.candidate_id,
    input.orgId,
    input.projectId,
  ) as {
    resource_row_id: string;
    broad_kind: string;
    subtype: MemoryV2HarnessSubtype | null;
    projection_status: string;
  } | undefined;
  if (!facet || facet.resource_row_id !== input.scope.resource_row_id
      || facet.broad_kind !== input.stored.candidate.kind
      || facet.projection_status !== "mapped" || !facet.subtype) {
    throw new MemoryHarnessActivationError(
      "Native v2 harness candidate classification is unavailable",
      409,
      "activation_requirement_unsatisfied",
    );
  }
  const receipt = db.prepare(
    `SELECT receipt_json, producer_run_id, producer_harness_id
     FROM memory_run_receipts
     WHERE receipt_id = ? AND org_id = ? AND project_id = ?`,
  ).get(input.stored.row.receipt_id, input.orgId, input.projectId) as {
    receipt_json: string;
    producer_run_id: string;
    producer_harness_id: string;
  } | undefined;
  if (!receipt || receipt.producer_run_id !== input.scope.producer_run_id) {
    throw new MemoryHarnessActivationError(
      "Native v2 harness receipt scope is unavailable",
      422,
      "evidence_unresolvable",
    );
  }
  const receiptPayload = JSON.parse(receipt.receipt_json) as RunReceiptV1;
  const applicability = input.stored.candidate.applicability as HarnessApplicabilityV1;
  const extensions = input.stored.candidate.extensions ?? {};
  const strategy = extensions.v2_validation_strategy;
  if (applicability.harness_id !== receipt.producer_harness_id
      || applicability.harness_id !== receiptPayload.producer.harness_id
      || extensions.v2_scope_snapshot_digest !== input.scope.scope_snapshot_digest) {
    throw new MemoryHarnessActivationError(
      "Native v2 harness identity does not match its receipt",
      422,
      "evidence_mismatch",
    );
  }
  if (strategy !== "stable_failure_fingerprint"
      && strategy !== "runtime_attestation"
      && strategy !== "authorized_review") {
    throw new MemoryHarnessActivationError(
      "Native v2 harness validation strategy is unavailable",
      422,
      "evidence_mismatch",
    );
  }
  const validationStrategy = strategy as NativeHarnessValidationStrategy;
  const failureFingerprint = input.stored.candidate.validation.failure_fingerprint;
  const failureDerived = validationStrategy === "stable_failure_fingerprint";
  if (failureDerived
      ? input.stored.candidate.validation.strategy !== "stable_failure_fingerprint"
        || !failureFingerprint
        || failureFingerprint !== receiptPayload.outcome.failure_fingerprint
      : input.stored.candidate.validation.strategy !== "policy_owner_review"
        || failureFingerprint !== undefined
        || receiptPayload.outcome.status !== "completed"
        || receiptPayload.outcome.verification_status !== "passed"
        || receiptPayload.outcome.failure_fingerprint !== null) {
    throw new MemoryHarnessActivationError(
      failureDerived
        ? "Native v2 harness failure fingerprint does not match its receipt"
        : "Native v2 harness successful-run validation does not match its receipt",
      422,
      "evidence_mismatch",
    );
  }
  const evidenceRows = db.prepare(
    `SELECT origin.evidence_ref_id, origin.origin_id,
            origin.corroboration_domain_id, origin.immutable_digest,
            origin.source_authority, origin.effective_root_origin_id,
            origin.observation_type, origin.outcome_json, origin.occurred_at
     FROM memory_v2_candidate_origins AS link
     INNER JOIN memory_v2_origins AS origin ON origin.origin_id = link.origin_id
     WHERE link.candidate_id = ? AND link.receipt_id = ?
       AND link.producer_run_id = ? AND link.resource_row_id = ?
       AND origin.receipt_id = link.receipt_id
       AND origin.evidence_ref_id = link.evidence_ref_id
     ORDER BY origin.occurred_at, origin.evidence_ref_id`,
  ).all(
    input.stored.row.candidate_id,
    input.scope.receipt_id,
    input.scope.producer_run_id,
    input.scope.resource_row_id,
  ) as unknown as NativeRuntimeEvidenceRow[];
  const evidenceRefs = evidenceRows.map((item) => item.evidence_ref_id).sort();
  const evidenceRequired = validationStrategy !== "authorized_review";
  if ((evidenceRequired && evidenceRows.length === 0)
      || extensions.v2_evidence_refs_digest !== canonicalJsonSha256(evidenceRefs)) {
    throw new MemoryHarnessActivationError(
      "Native v2 harness runtime evidence is incomplete",
      422,
      "evidence_unresolvable",
    );
  }
  if (evidenceRows.some((item) => {
    try {
      const outcome = JSON.parse(item.outcome_json) as {
        status?: unknown;
        verification_status?: unknown;
        failure_fingerprint?: unknown;
      };
      return failureDerived
        ? outcome.failure_fingerprint !== failureFingerprint
        : outcome.status !== "completed"
          || outcome.verification_status !== "passed"
          || outcome.failure_fingerprint !== null
          || (validationStrategy === "runtime_attestation"
            && item.source_authority !== "verified");
    } catch {
      return true;
    }
  })) {
    throw new MemoryHarnessActivationError(
      failureDerived
        ? "Native v2 runtime evidence does not match the stable failure fingerprint"
        : "Native v2 runtime evidence does not verify the successful-run strategy",
      422,
      "evidence_mismatch",
    );
  }
  const producerRefs = new Set(evidenceRows.map((item) => item.evidence_ref_id));
  if ((input.decision.evidence_refs ?? []).some((ref) => !producerRefs.has(ref))) {
    throw new MemoryHarnessActivationError(
      "Review cites runtime evidence outside the candidate receipt",
      422,
      "evidence_unresolvable",
    );
  }

  // Multiple roots, retries, summaries, and derived artifacts in one approved
  // authority domain contribute one runtime observation to the activated row.
  const representativeByDomain = new Map<string, NativeRuntimeEvidenceRow>();
  for (const row of evidenceRows) {
    const current = representativeByDomain.get(row.corroboration_domain_id);
    if (!current || (row.observation_type === "root" && current.observation_type !== "root")) {
      representativeByDomain.set(row.corroboration_domain_id, row);
    }
  }
  const runtimeEvidence: EvidenceHandleV1[] = [...representativeByDomain.values()]
    .map((row) => ({
      evidence_ref_id: row.origin_id,
      type: "runtime_attestation",
      digest: row.immutable_digest,
      origin_id: row.effective_root_origin_id ?? row.origin_id,
      source_authority: row.source_authority,
    }));
  const reviewEvidence = persistNativeReviewOrigin({
    orgId: input.orgId,
    projectId: input.projectId,
    decisionId: input.decisionId,
    reviewerId: input.reviewerId,
    decision: input.decision,
    now: input.now,
  });
  const evidence = [...runtimeEvidence, reviewEvidence];
  const scopePayload = JSON.parse(input.scope.scope_snapshot_json) as {
    configuration_digest?: unknown;
  };
  const configurationDigest = typeof scopePayload.configuration_digest === "string"
    ? scopePayload.configuration_digest
    : null;
  if (!configurationDigest) {
    throw new MemoryHarnessActivationError(
      "Native v2 harness configuration scope is unavailable",
      422,
      "evidence_unresolvable",
    );
  }
  const configurationSelectorDigest = extensions.v2_configuration_selector_digest;
  if (configurationSelectorDigest !== null
      && configurationSelectorDigest !== configurationDigest) {
    throw new MemoryHarnessActivationError(
      "Native v2 harness configuration selector does not match its authenticated scope",
      422,
      "evidence_mismatch",
    );
  }
  const domainIds = [...representativeByDomain.keys()].sort();
  const runtimeOriginIds = evidenceRows.map((row) => row.origin_id).sort();
  const runtimeEvidenceDigest = memoryV2NativeHarnessRuntimeEvidenceDigest(
    evidenceRows.map((row) => ({
      evidenceRefId: row.evidence_ref_id,
      originId: row.origin_id,
      corroborationDomainId: row.corroboration_domain_id,
    })),
  );
  const configurationDigests = configurationSelectorDigest === null
    ? []
    : [configurationDigest];
  const recordId = `mem_${input.stored.row.candidate_id.slice("candidate_".length)}`;
  const record = importActiveHarnessMemoryRecord({
    orgId: input.orgId,
    projectId: input.projectId,
    recordId,
    kind: input.stored.candidate.kind,
    subtype: facet.subtype,
    configurationDigests,
    content: input.stored.candidate.content,
    applicability,
    exceptions: input.stored.candidate.exceptions,
    compatibility: {
      harness_version_range: applicability.harness_version_range
        ?? receiptPayload.producer.harness_version,
      workflow_version_range: applicability.workflow_version_range
        ?? receiptPayload.producer.workflow_version,
      adapter_version_range: applicability.adapter_version_range
        ?? receiptPayload.producer.adapter_version,
    },
    validation: input.stored.candidate.validation,
    evidence,
    evidenceSummary: { strength: "reviewed", ref_count: evidence.length },
    freshness: { last_confirmed_at: input.decision.event_time, expires_at: null },
    provenance: {
      candidate_id: input.stored.row.candidate_id,
      producer_run_id: receipt.producer_run_id,
      producer: receiptPayload.producer,
      extraction: input.stored.candidate.extraction,
      extractor_version: input.stored.candidate.extraction.extractor_version,
      runtime_evidence_digest: runtimeEvidenceDigest,
      runtime_origin_ids: runtimeOriginIds,
      v2_corroboration_domain_ids: domainIds,
      v2_distinct_corroboration_domain_count: domainIds.length,
      v2_scope_configuration_digest: configurationDigest,
      v2_configuration_digests: configurationDigests,
      v2_subtype: facet.subtype,
      v2_validation_strategy: validationStrategy,
      scope_snapshot_digest: input.scope.scope_snapshot_digest,
      v2_projection_digest: memoryV2NativeHarnessRecordProjectionDigest({
        candidateId: input.stored.row.candidate_id,
        recordId,
        recordVersion: 1,
        resourceRowId: input.scope.resource_row_id,
        subtype: facet.subtype,
        scopeSnapshotDigest: input.scope.scope_snapshot_digest,
        scopeConfigurationDigest: configurationDigest,
        runtimeOriginIds,
        corroborationDomainIds: domainIds,
        distinctCorroborationDomainCount: domainIds.length,
        configurationDigests,
        runtimeEvidenceDigest,
      }),
      failure_fingerprint: receiptPayload.outcome.failure_fingerprint,
      decision_id: input.decisionId,
      reviewer_principal_id: input.reviewerId,
    },
    actorId: input.reviewerId,
    decisionRefs: [input.decisionId],
    reasonCode: input.decision.reason_code,
    explanation: input.decision.explanation
      ?? "Authorized review approved this native v2 harness lesson for retrieval.",
    now: input.now,
  });
  const trust = ensureMemoryV2EvidenceVerifiedTrust({
    recordId: record.recordId,
    recordVersion: record.recordVersion,
    orgId: input.orgId,
    projectId: input.projectId,
    evidenceVerifiedAt: input.decision.event_time,
    now: input.now,
  });
  if (trust.trustBasis === "evidence_verified" && memoryV2ReverificationEnabled()) {
    ensureMemoryV2ReverificationAdmission({
      recordId: record.recordId,
      recordVersion: record.recordVersion,
      createdBy: "memory-v2-harness-activation",
      now: input.now,
    });
  }
  markMemoryCandidateActive({
    candidateId: input.stored.row.candidate_id,
    expectedVersion: input.stored.row.aggregate_version,
    recordId: record.recordId,
    recordVersion: record.recordVersion,
    actorId: input.reviewerId,
    actorType: "reviewer",
    fromStatus: "pending_review",
    decisionRefs: [input.decisionId],
    reasonCode: input.decision.reason_code,
    explanation: input.decision.explanation
      ?? "Authorized review activated this native v2 harness lesson.",
    now: input.now,
  });
  return record;
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
    const nativeScope = nativeHarnessScope(stored.row.receipt_id);
    if (nativeScope) {
      return activateReviewedNativeHarnessMemoryCandidate({
        stored,
        scope: nativeScope,
        orgId: input.orgId,
        projectId: input.projectId,
        reviewerId: input.reviewerId,
        decisionId: input.decisionId,
        decision: input.decision,
        now,
      });
    }

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
      },
      actorId: input.reviewerId,
      decisionRefs: [input.decisionId],
      reasonCode: input.decision.reason_code,
      explanation: input.decision.explanation
        ?? "Authorized review approved this harness lesson for retrieval.",
      now,
    });
    const trust = ensureMemoryV2EvidenceVerifiedTrust({
      recordId: record.recordId,
      recordVersion: record.recordVersion,
      orgId: input.orgId,
      projectId: input.projectId,
      evidenceVerifiedAt: input.decision.event_time,
      now,
    });
    if (trust.trustBasis === "evidence_verified" && memoryV2ReverificationEnabled()) {
      ensureMemoryV2ReverificationAdmission({
        recordId: record.recordId,
        recordVersion: record.recordVersion,
        createdBy: "memory-v2-harness-activation",
        now,
      });
    }
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
        ?? "Authorized review activated this harness lesson.",
      now,
    });
    return record;
  });
}
