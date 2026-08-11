import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  canonicalJsonSha256,
  type HarnessRuntimeEvidenceHandleV2,
  type ResourceBindingV2,
} from "@pim/shared";
import db, { withImmediateTransaction } from "../../db/connection.js";
import {
  createMemoryTestContext,
  type MemoryTestContext,
} from "../../routes/__tests__/memory-test-app.js";
import { getMemoryV2Binding } from "../memory-v2-binding.js";
import {
  getMemoryOperationalSnapshot,
  setMemoryMetricSink,
  type MemoryMetric,
} from "../memory-metrics.js";
import {
  applyMemoryErasurePlan,
  createMemoryRetentionPolicyVersion,
  planMemoryErasure,
  planMemoryRetention,
} from "../memory-data-governance.js";
import { importActiveHarnessMemoryRecord } from "../memory-harness-records.js";
import { memoryV2ProductionReverificationProvider } from "../memory-v2-reverification-provider.js";
import {
  assertMemoryRuntimeEvidenceHandleSet,
  assertStoredMemoryRuntimeReceiptEvidence,
  getMemoryV2CandidateRuntimeEvidence,
  MemoryRuntimeAttestationError,
  persistPreparedMemoryRuntimeAttestationInTransaction,
  prepareMemoryRuntimeAttestation,
  reconcileMemoryV2RuntimeOrigins,
  recordMemoryRuntimeAttestationResolutionMetrics,
  setMemoryRuntimeAttestationVerifier,
  type PreparedMemoryRuntimeAttestation,
  type RuntimeAttestationCandidateBinding,
  type RuntimeAttestationPrepareContext,
} from "../memory-v2-runtime-attestations.js";
import {
  createServiceToken,
  verifyMemoryV2ServiceToken,
  type MemoryV2RequestAuthorizationSnapshot,
} from "../service-tokens.js";

const NOW = "2026-08-10T12:00:00.000Z";
const CONFIG_DIGEST = `sha256:${"c".repeat(64)}`;

let context: MemoryTestContext;
let principalA: MemoryV2RequestAuthorizationSnapshot;
let principalB: MemoryV2RequestAuthorizationSnapshot;
let resource: ResourceBindingV2;

function marker(): string {
  return randomUUID().replaceAll("-", "").slice(0, 16);
}

function harnessResource(principal: MemoryV2RequestAuthorizationSnapshot): ResourceBindingV2 {
  return getMemoryV2Binding(principal).resources.find((binding) => (
    binding.plane === "harness" && binding.canonical_resource_id === "example-harness-a"
  ))!;
}

function seedReceipt(input: {
  principal: MemoryV2RequestAuthorizationSnapshot;
  producerRunId: string;
  clientCandidateIds: string[];
  nativeReverification?: boolean;
}): { receiptId: string; bindings: RuntimeAttestationCandidateBinding[] } {
  const receiptId = `runtime-receipt-${marker()}`;
  const createdAt = NOW;
  const coreDigest = canonicalJsonSha256({ receiptId, core: true });
  const requestDigest = canonicalJsonSha256({ receiptId, v2: true });
  const scopeWithoutDigest = {
    schema_version: "pim.memory-scope-snapshot.harness.v2",
    plane: "harness",
    resource_binding: resource,
    harness_id: "example-harness-a",
    harness_version: "harness-shadow-v1",
    workflow_version: "code-change.v3",
    adapter_version: "example-harness-a-pim-adapter.v1",
    configuration_id: "routing-default-v2",
    configuration_digest: CONFIG_DIGEST,
  };
  const scopeDigest = canonicalJsonSha256(scopeWithoutDigest);
  const scope = { ...scopeWithoutDigest, scope_snapshot_digest: scopeDigest };
  const response = {
    schema_version: "pim.run-receipt-result.v2",
    receipt_id: receiptId,
    producer_run_id: input.producerRunId,
    request_digest: requestDigest,
    tenant: { organization_id: context.orgA.id, project_id: context.projectA },
    plane: "harness",
    resource_binding: resource,
    scope_snapshot_digest: scopeDigest,
    status: "accepted",
    duplicate: false,
    candidate_results: [],
  };
  db.prepare(
    `INSERT INTO memory_run_receipts
       (receipt_id, org_id, project_id, producer_run_id, schema_major,
        idempotency_key, request_digest, receipt_json, response_json,
        producer_harness_id, repository_row_id, repository_id, base_sha,
        outcome_status, created_at)
     VALUES (?, ?, ?, ?, 'pim.run-receipt.v1', ?, ?, '{}', '{}',
             'example-harness-a', NULL, NULL, NULL, 'completed', ?)`,
  ).run(
    receiptId,
    context.orgA.id,
    context.projectA,
    input.producerRunId,
    `runtime-key-${receiptId}`,
    coreDigest,
    createdAt,
  );
  db.prepare(
    `INSERT INTO memory_v2_receipt_facets
       (receipt_id, org_id, project_id, plane, resource_row_id, facet_json, created_at)
     VALUES (?, ?, ?, 'harness', ?, '{}', ?)`,
  ).run(receiptId, context.orgA.id, context.projectA, resource.resource_row_id, createdAt);
  db.prepare(
    `INSERT INTO memory_v2_scope_snapshots
       (receipt_id, org_id, project_id, plane, resource_row_id,
        producer_principal_id, producer_run_id, request_digest, core_request_digest,
        scope_snapshot_json, scope_snapshot_digest, response_json, created_at)
     VALUES (?, ?, ?, 'harness', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    receiptId,
    context.orgA.id,
    context.projectA,
    resource.resource_row_id,
    input.principal.servicePrincipalId,
    input.producerRunId,
    requestDigest,
    coreDigest,
    JSON.stringify(scope),
    scopeDigest,
    JSON.stringify(response),
    createdAt,
  );
  const bindings = input.clientCandidateIds.map((clientCandidateId) => ({
    clientCandidateId,
    candidateId: `runtime-candidate-${marker()}`,
  }));
  for (const binding of bindings) {
    const candidate = {
      schema_version: "pim.memory-candidate.v2",
      client_candidate_id: binding.clientCandidateId,
      plane: "harness",
      resource_row_id: resource.resource_row_id,
      scope_snapshot_digest: scopeDigest,
      kind: "anti_pattern",
      subkind: "failure_pattern",
      ...(input.nativeReverification ? {
        extensions: {
          v2_scope_snapshot_digest: scopeDigest,
          v2_configuration_digest: CONFIG_DIGEST,
          v2_configuration_selector_digest: CONFIG_DIGEST,
        },
      } : {}),
    };
    const digest = canonicalJsonSha256(candidate);
    db.prepare(
      `INSERT INTO memory_candidates_v1
         (candidate_id, org_id, project_id, receipt_id, repository_row_id,
          producer_harness_id, client_candidate_id, candidate_digest,
          candidate_json, plane, kind, current_status, aggregate_version,
          activation_requirement, blockers_json, evidence_manifest_row_id,
          active_record_id, active_record_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, 'example-harness-a', ?, ?, ?, 'harness', 'anti_pattern',
               'pending_review', 1, 'authorized_review', '[]', NULL, NULL, NULL, ?, ?)`,
    ).run(
      binding.candidateId,
      context.orgA.id,
      context.projectA,
      receiptId,
      binding.clientCandidateId,
      digest,
      JSON.stringify(candidate),
      createdAt,
      createdAt,
    );
    db.prepare(
      `INSERT INTO memory_receipt_candidates
         (receipt_id, candidate_id, client_candidate_id, candidate_digest)
       VALUES (?, ?, ?, ?)`,
    ).run(receiptId, binding.candidateId, binding.clientCandidateId, digest);
    db.prepare(
      `INSERT INTO memory_v2_candidate_facets
         (candidate_id, org_id, project_id, plane, resource_row_id, broad_kind,
          subtype, projection_status, facet_json, created_at)
       VALUES (?, ?, ?, 'harness', ?, 'anti_pattern', 'failure_pattern',
               'mapped', '{}', ?)`,
    ).run(
      binding.candidateId,
      context.orgA.id,
      context.projectA,
      resource.resource_row_id,
      createdAt,
    );
  }
  return { receiptId, bindings };
}

function rootHandle(input: {
  evidenceRefId: string;
  providerEventId?: string;
  sourceMarker?: string;
}): HarnessRuntimeEvidenceHandleV2 {
  const sourceMarker = input.sourceMarker ?? input.evidenceRefId;
  return {
    evidence_ref_id: input.evidenceRefId,
    handle_type: "root_origin",
    provider: "runtime_attestation",
    provider_identity: null,
    provider_domain_key: null,
    provider_event_id: input.providerEventId ?? `provider-event-${sourceMarker}`,
    immutable_digest: canonicalJsonSha256({ sourceMarker }),
    producer_principal_id: null,
    effective_root_origin_id: null,
    corroboration_domain_id: null,
    observation_type: "root",
    outcome: {
      status: "failed",
      reason_code: "tool_timeout",
      verification_status: "failed",
      failure_fingerprint: "runtime:tool-timeout:terminal-state-unknown:v1",
    },
    occurred_at: NOW,
    verified_at: null,
    source_authority: null,
    derivation_parent_refs: [],
  };
}

function derivedHandle(input: {
  evidenceRefId: string;
  parentRefs: string[];
}): HarnessRuntimeEvidenceHandleV2 {
  return {
    ...rootHandle({ evidenceRefId: input.evidenceRefId }),
    handle_type: "derivation",
    observation_type: "summary",
    derivation_parent_refs: input.parentRefs,
  };
}

function insertLegacyRuntimeSignalCollision(input: {
  signalId: string;
  receiptId: string;
  producerRunId: string;
}): void {
  const packId = `runtime-signal-collision-pack-${marker()}`;
  const repository = db.prepare(
    `SELECT repository_row_id, repository_id
     FROM memory_repository_registry
     WHERE org_id = ? AND project_id = ?
     ORDER BY repository_row_id LIMIT 1`,
  ).get(context.orgA.id, context.projectA) as {
    repository_row_id: string;
    repository_id: string;
  };
  const record = db.prepare(
    `SELECT record_id, current_version FROM memory_records
     WHERE record_id = ?`,
  ).get(context.seededRecordId) as { record_id: string; current_version: number };
  db.prepare(
    `INSERT INTO memory_retrieval_packs
       (retrieval_pack_id, org_id, project_id, request_id, request_digest,
        repository_row_id, repository_id, harness_id, plane, query, policy_version,
        ranker_version, authorized_scope_json, token_count, omitted_count,
        response_json, created_at, expires_at, consumer_run_id, request_base_sha)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'codebase', 'runtime signal collision',
             'slice5-test', 'slice5-test', '[]', 1, 0, '{}', ?, ?, ?, ?)`,
  ).run(
    packId,
    context.orgA.id,
    context.projectA,
    `runtime-signal-collision-request-${marker()}`,
    canonicalJsonSha256({ packId }),
    repository.repository_row_id,
    repository.repository_id,
    NOW,
    "2026-08-10T13:00:00.000Z",
    input.producerRunId,
    "c".repeat(40),
  );
  db.prepare(
    `INSERT INTO memory_retrieval_pack_items
       (retrieval_pack_id, item_order, record_id, record_version, token_count,
        rank_score, match_reasons_json, prompt_eligible)
     VALUES (?, 0, ?, ?, 1, 1, '[]', 0)`,
  ).run(packId, record.record_id, record.current_version);
  const feedbackId = `runtime-signal-collision-feedback-${marker()}`;
  const feedback = {
    disposition: "harmful",
    reason_code: "slice5_source_qualified_collision",
  };
  db.prepare(
    `INSERT INTO memory_feedback
       (feedback_id, org_id, project_id, receipt_id, producer_run_id,
        retrieval_pack_id, record_id, record_version, feedback_stage,
        feedback_revision, feedback_json, feedback_digest, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'later', 1, ?, ?, ?)`,
  ).run(
    feedbackId,
    context.orgA.id,
    context.projectA,
    input.receiptId,
    input.producerRunId,
    packId,
    record.record_id,
    record.current_version,
    JSON.stringify(feedback),
    canonicalJsonSha256(feedback),
    NOW,
  );
  db.prepare(
    `INSERT INTO memory_review_signals
       (signal_id, org_id, project_id, feedback_id, record_id, record_version,
        signal_type, reason_code, status, created_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, 'harmful_review',
             'slice5_source_qualified_collision', 'open', ?, NULL)`,
  ).run(
    input.signalId,
    context.orgA.id,
    context.projectA,
    feedbackId,
    record.record_id,
    record.current_version,
    NOW,
  );
}

function authFor(input: {
  principal: MemoryV2RequestAuthorizationSnapshot;
  producerRunId: string;
  handle: HarnessRuntimeEvidenceHandleV2;
  bindings: RuntimeAttestationCandidateBinding[];
}): RuntimeAttestationPrepareContext {
  return {
    orgId: context.orgA.id,
    projectId: context.projectA,
    resourceRowId: resource.resource_row_id,
    producerPrincipalId: input.principal.servicePrincipalId,
    producerRunId: input.producerRunId,
    evidenceRefId: input.handle.evidence_ref_id,
    clientCandidateIds: input.bindings.map((binding) => binding.clientCandidateId),
  };
}

function verifiedProvider(
  sourceAuthority: "observed" | "verified",
  providerDomainKey?: string,
) {
  setMemoryRuntimeAttestationVerifier(async ({ auth, handle, receivedAt }) => ({
    providerIdentity: `service_principal:${auth.producerPrincipalId}`,
    providerDomainKey: providerDomainKey ?? `approved-domain:${auth.producerPrincipalId}`,
    providerEventId: handle.provider_event_id,
    immutableDigest: handle.immutable_digest,
    occurredAt: handle.occurred_at,
    verifiedAt: receivedAt,
    outcomeFingerprint: canonicalJsonSha256(handle.outcome),
    observationType: handle.observation_type,
    sourceAuthority,
  }));
}

async function prepare(input: {
  principal: MemoryV2RequestAuthorizationSnapshot;
  producerRunId: string;
  handle: HarnessRuntimeEvidenceHandleV2;
  bindings: RuntimeAttestationCandidateBinding[];
}): Promise<PreparedMemoryRuntimeAttestation> {
  return prepareMemoryRuntimeAttestation({
    auth: authFor(input),
    handle: input.handle,
    now: NOW,
  });
}

beforeAll(async () => {
  context = await createMemoryTestContext();
  if (!db.prepare("SELECT 1 FROM memory_authority_transitions LIMIT 1").get()) {
    const digest = canonicalJsonSha256({ fixture: "slice5-runtime-governance" });
    db.prepare(
      `INSERT INTO memory_legacy_import_runs
         (import_run_id, inventory_digest, resolution_digest, source_bundle_digest,
          source_item_count, imported_count, pending_count, quarantined_count,
          deduplicated_count, report_json, created_at)
       VALUES ('slice5-runtime-cutover', ?, ?, ?, 0, 0, 0, 0, 0, '{}', ?)`,
    ).run(digest, digest, digest, NOW);
    db.prepare(
      `INSERT INTO memory_authority_transitions
         (transition_id, revision, from_authority, to_authority,
          legacy_writes_frozen, import_run_id, actor_id, reason_code, occurred_at)
       VALUES
         ('slice5-runtime-authority-1', 1, 'legacy', 'migration_locked', 1,
          'slice5-runtime-cutover', 'slice5-test', 'cutover_started', ?),
         ('slice5-runtime-authority-2', 2, 'migration_locked', 'canonical', 1,
          'slice5-runtime-cutover', 'slice5-test', 'cutover_complete', ?)`,
    ).run(NOW, NOW);
  }
  principalA = verifyMemoryV2ServiceToken(context.harnessReceiptTokenA)!.authorization;
  const creator = db.prepare(
    "SELECT created_by_user_id FROM service_principals WHERE service_principal_id = ?",
  ).get(principalA.servicePrincipalId) as { created_by_user_id: string };
  const second = createServiceToken({
    orgId: context.orgA.id,
    name: `Runtime verifier B ${marker()}`,
    scopes: ["memory:harness:receipt:write"],
    createdByUserId: creator.created_by_user_id,
    projectId: context.projectA,
    harnessIds: ["example-harness-a"],
    expiresAt: "2027-08-10T00:00:00.000Z",
  });
  principalB = verifyMemoryV2ServiceToken(second.token)!.authorization;
  resource = harnessResource(principalA);
});

afterEach(() => {
  setMemoryRuntimeAttestationVerifier(null);
  setMemoryMetricSink(null);
});

afterAll(async () => {
  setMemoryRuntimeAttestationVerifier(null);
  if (context) await context.app.close();
});

describe("Slice 5 runtime origin resolver", () => {
  it("rejects duplicate receipt refs and forward derivation parents", () => {
    const root = rootHandle({ evidenceRefId: `root-${marker()}` });
    const duplicate = rootHandle({ evidenceRefId: root.evidence_ref_id });
    expect(() => assertMemoryRuntimeEvidenceHandleSet([root, duplicate]))
      .toThrow(/evidence_ref_id values must be unique/);

    const parent = rootHandle({ evidenceRefId: `root-${marker()}` });
    const derived = derivedHandle({
      evidenceRefId: `summary-${marker()}`,
      parentRefs: [parent.evidence_ref_id],
    });
    expect(() => assertMemoryRuntimeEvidenceHandleSet([derived, parent]))
      .toThrow(/earlier receipt-local evidence handles/);
    expect(() => assertMemoryRuntimeEvidenceHandleSet([parent, derived])).not.toThrow();
  });

  it("collapses reruns in one authenticated domain and never creates a repeated signal", async () => {
    verifiedProvider("verified");
    const firstRun = `runtime-run-${marker()}`;
    const firstSeed = seedReceipt({
      principal: principalA,
      producerRunId: firstRun,
      clientCandidateIds: [`client-${marker()}`],
    });
    const firstHandle = rootHandle({ evidenceRefId: `root-${marker()}` });
    const firstPrepared = await prepare({
      principal: principalA,
      producerRunId: firstRun,
      handle: firstHandle,
      bindings: firstSeed.bindings,
    });
    const first = withImmediateTransaction(() => (
      persistPreparedMemoryRuntimeAttestationInTransaction({
        prepared: firstPrepared,
        receiptId: firstSeed.receiptId,
        candidateBindings: firstSeed.bindings,
        parentOriginsByEvidenceRef: new Map(),
        now: NOW,
      })
    ));

    const secondRun = `runtime-run-${marker()}`;
    const secondSeed = seedReceipt({
      principal: principalA,
      producerRunId: secondRun,
      clientCandidateIds: [`client-${marker()}`],
    });
    const secondHandle = rootHandle({ evidenceRefId: `root-${marker()}` });
    const secondPrepared = await prepare({
      principal: principalA,
      producerRunId: secondRun,
      handle: secondHandle,
      bindings: secondSeed.bindings,
    });
    const second = withImmediateTransaction(() => (
      persistPreparedMemoryRuntimeAttestationInTransaction({
        prepared: secondPrepared,
        receiptId: secondSeed.receiptId,
        candidateBindings: secondSeed.bindings,
        parentOriginsByEvidenceRef: new Map(),
        now: NOW,
      })
    ));

    expect(second.corroborationDomainId).toBe(first.corroborationDomainId);
    expect(second.collapsedToExistingDomain).toBe(true);
    expect(second.reviewSignals).toEqual([]);
    expect(second.activationEligible).toBe(false);
  });

  it("collapses derived artifacts and a multi-root receipt to its explicit domain/root set", async () => {
    verifiedProvider("verified");
    const runId = `runtime-run-${marker()}`;
    const seed = seedReceipt({
      principal: principalA,
      producerRunId: runId,
      clientCandidateIds: [`client-${marker()}`],
    });
    const rootOne = rootHandle({ evidenceRefId: `root-${marker()}` });
    const rootTwo = rootHandle({ evidenceRefId: `root-${marker()}` });
    const summary = derivedHandle({
      evidenceRefId: `summary-${marker()}`,
      parentRefs: [rootOne.evidence_ref_id, rootTwo.evidence_ref_id],
    });
    const prepared = await Promise.all([rootOne, rootTwo, summary].map((handle) => prepare({
      principal: principalA,
      producerRunId: runId,
      handle,
      bindings: seed.bindings,
    })));
    const results = withImmediateTransaction(() => {
      const origins = new Map<string, string>();
      return prepared.map((item) => {
        const result = persistPreparedMemoryRuntimeAttestationInTransaction({
          prepared: item,
          receiptId: seed.receiptId,
          candidateBindings: seed.bindings,
          parentOriginsByEvidenceRef: origins,
          now: NOW,
        });
        origins.set(item.handle.evidence_ref_id, result.originId);
        return result;
      });
    });
    expect(new Set(results.map((result) => result.corroborationDomainId)).size).toBe(1);
    expect(results[2]).toMatchObject({
      effectiveRootOriginId: null,
      rootOriginIds: [results[0]!.originId, results[1]!.originId].sort(),
      reviewSignals: [],
      activationEligible: false,
    });
    expect(getMemoryV2CandidateRuntimeEvidence(seed.bindings[0]!.candidateId))
      .toHaveLength(3);

    const changedParentHandle = derivedHandle({
      evidenceRefId: summary.evidence_ref_id,
      parentRefs: [rootTwo.evidence_ref_id],
    });
    const changedParentPrepared = await prepare({
      principal: principalA,
      producerRunId: runId,
      handle: changedParentHandle,
      bindings: seed.bindings,
    });
    const beforeConflict = reconcileMemoryV2RuntimeOrigins();
    expect(() => withImmediateTransaction(() => (
      persistPreparedMemoryRuntimeAttestationInTransaction({
        prepared: changedParentPrepared,
        receiptId: seed.receiptId,
        candidateBindings: seed.bindings,
        parentOriginsByEvidenceRef: new Map([[rootTwo.evidence_ref_id, results[1]!.originId]]),
        now: NOW,
      })
    ))).toThrow(/different receipt effect/);
    expect(reconcileMemoryV2RuntimeOrigins()).toEqual(beforeConflict);
  });

  it("opens review only for verified observations from distinct domains, principals, and runs", async () => {
    verifiedProvider("verified");
    const firstRun = `runtime-run-${marker()}`;
    const firstSeed = seedReceipt({
      principal: principalA,
      producerRunId: firstRun,
      clientCandidateIds: [`client-${marker()}`],
    });
    const firstHandle = rootHandle({ evidenceRefId: `root-${marker()}` });
    const firstPrepared = await prepare({
      principal: principalA,
      producerRunId: firstRun,
      handle: firstHandle,
      bindings: firstSeed.bindings,
    });
    withImmediateTransaction(() => persistPreparedMemoryRuntimeAttestationInTransaction({
      prepared: firstPrepared,
      receiptId: firstSeed.receiptId,
      candidateBindings: firstSeed.bindings,
      parentOriginsByEvidenceRef: new Map(),
      now: NOW,
    }));

    const secondRun = `runtime-run-${marker()}`;
    const secondSeed = seedReceipt({
      principal: principalB,
      producerRunId: secondRun,
      clientCandidateIds: [`client-${marker()}`],
    });
    const secondHandle = rootHandle({ evidenceRefId: `root-${marker()}` });
    const secondPrepared = await prepare({
      principal: principalB,
      producerRunId: secondRun,
      handle: secondHandle,
      bindings: secondSeed.bindings,
    });
    const operationalBefore = getMemoryOperationalSnapshot(context.orgA.id, context.projectA);
    const repeated = withImmediateTransaction(() => (
      persistPreparedMemoryRuntimeAttestationInTransaction({
        prepared: secondPrepared,
        receiptId: secondSeed.receiptId,
        candidateBindings: secondSeed.bindings,
        parentOriginsByEvidenceRef: new Map(),
        now: NOW,
      })
    ));
    expect(repeated.reviewSignals).toEqual([
      expect.objectContaining({ source: "memory_v2_review_signals" }),
    ]);
    expect(repeated.activationEligible).toBe(false);
    const repeatedCandidateId = secondSeed.bindings[0]!.candidateId;
    expect(db.prepare(
      `SELECT current_status, active_record_id, active_record_version
       FROM memory_candidates_v1 WHERE candidate_id = ?`,
    ).get(repeatedCandidateId)).toEqual({
      current_status: "pending_review",
      active_record_id: null,
      active_record_version: null,
    });
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM memory_candidate_decisions WHERE candidate_id = ?",
    ).get(repeatedCandidateId)).toEqual({ count: 0 });
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM memory_activation_claims WHERE current_candidate_id = ?",
    ).get(repeatedCandidateId)).toEqual({ count: 0 });
    const signal = db.prepare(
      `SELECT first_corroboration_domain_id, repeated_corroboration_domain_id,
              first_producer_principal_id, repeated_producer_principal_id,
              first_producer_run_id, repeated_producer_run_id, status
       FROM memory_v2_review_signals WHERE signal_id = ?`,
    ).get(repeated.reviewSignals[0]!.signalId) as Record<string, string>;
    expect(signal.first_corroboration_domain_id)
      .not.toBe(signal.repeated_corroboration_domain_id);
    expect(signal.first_producer_principal_id)
      .not.toBe(signal.repeated_producer_principal_id);
    expect(signal.first_producer_run_id).not.toBe(signal.repeated_producer_run_id);
    expect(signal.status).toBe("open");
    const operationalAfter = getMemoryOperationalSnapshot(context.orgA.id, context.projectA);
    expect(operationalAfter.openReviewSignalsBySource.memory_v2_review_signals)
      .toBe(operationalBefore.openReviewSignalsBySource.memory_v2_review_signals + 1);
    expect(operationalAfter.openReviewSignalCount)
      .toBe(operationalBefore.openReviewSignalCount + 1);

    const signalId = repeated.reviewSignals[0]!.signalId;
    insertLegacyRuntimeSignalCollision({
      signalId,
      receiptId: secondSeed.receiptId,
      producerRunId: secondRun,
    });
    expect(db.prepare(
      `SELECT signal_id, signal_source
       FROM (
         SELECT signal_id, 'memory_review_signals' AS signal_source
         FROM memory_review_signals WHERE signal_id = ?
         UNION ALL
         SELECT signal_id, 'memory_v2_review_signals' AS signal_source
         FROM memory_v2_review_signals WHERE signal_id = ?
       ) ORDER BY signal_source`,
    ).all(signalId, signalId)).toEqual([
      { signal_id: signalId, signal_source: "memory_review_signals" },
      { signal_id: signalId, signal_source: "memory_v2_review_signals" },
    ]);
    const collisionSnapshot = getMemoryOperationalSnapshot(context.orgA.id, context.projectA);
    expect(collisionSnapshot.openReviewSignalsBySource).toEqual({
      memory_review_signals:
        operationalBefore.openReviewSignalsBySource.memory_review_signals + 1,
      memory_v2_feedback_review_signals:
        operationalBefore.openReviewSignalsBySource.memory_v2_feedback_review_signals,
      memory_v2_review_signals:
        operationalBefore.openReviewSignalsBySource.memory_v2_review_signals + 1,
    });
    expect(collisionSnapshot.openReviewSignalCount)
      .toBe(operationalBefore.openReviewSignalCount + 2);
  });

  it("emits bounded domain/collapse/review measures without identity dimensions", () => {
    const metrics: MemoryMetric[] = [];
    setMemoryMetricSink((metric) => metrics.push(metric));
    recordMemoryRuntimeAttestationResolutionMetrics({
      originId: "origin-sensitive",
      effectiveRootOriginId: "root-sensitive",
      rootOriginIds: ["root-sensitive"],
      corroborationDomainId: "domain-sensitive",
      sourceAuthority: "verified",
      requestDigest: `sha256:${"a".repeat(64)}`,
      duplicate: false,
      collapsedToExistingDomain: true,
      distinctCandidateDomainCount: 2,
      reviewSignals: [{ source: "memory_v2_review_signals", signalId: "signal-sensitive" }],
      activationEligible: false,
    });
    expect(metrics.map((metric) => [metric.name, metric.value])).toEqual([
      ["RuntimeOriginDomainCount", 2],
      ["CollapsedRuntimeOriginObservationCount", 1],
      ["ReviewSignalCount", 1],
    ]);
    for (const metric of metrics) {
      expect(metric.dimensions).toMatchObject({ plane: "harness" });
      expect(JSON.stringify(metric.dimensions)).not.toMatch(/sensitive/);
    }
  });

  it("does not treat observed outcomes from distinct domains as approved review evidence", async () => {
    verifiedProvider("observed");
    const results = [];
    for (const principal of [principalA, principalB]) {
      const runId = `runtime-run-${marker()}`;
      const seed = seedReceipt({
        principal,
        producerRunId: runId,
        clientCandidateIds: [`client-${marker()}`],
      });
      const handle = rootHandle({ evidenceRefId: `root-${marker()}` });
      const prepared = await prepare({ principal, producerRunId: runId, handle, bindings: seed.bindings });
      results.push(withImmediateTransaction(() => (
        persistPreparedMemoryRuntimeAttestationInTransaction({
          prepared,
          receiptId: seed.receiptId,
          candidateBindings: seed.bindings,
          parentOriginsByEvidenceRef: new Map(),
          now: NOW,
        })
      )));
    }
    expect(results[1]!.corroborationDomainId).not.toBe(results[0]!.corroborationDomainId);
    expect(results[1]!.reviewSignals).toEqual([]);
  });

  it("replays one exact provider event without effects and conflicts on a new run/candidate binding", async () => {
    verifiedProvider("verified");
    const runId = `runtime-run-${marker()}`;
    const seed = seedReceipt({
      principal: principalA,
      producerRunId: runId,
      clientCandidateIds: [`client-${marker()}`],
    });
    const eventId = `provider-event-${marker()}`;
    const handle = rootHandle({ evidenceRefId: `root-${marker()}`, providerEventId: eventId });
    const prepared = await prepare({ principal: principalA, producerRunId: runId, handle, bindings: seed.bindings });
    const first = withImmediateTransaction(() => (
      persistPreparedMemoryRuntimeAttestationInTransaction({
        prepared,
        receiptId: seed.receiptId,
        candidateBindings: seed.bindings,
        parentOriginsByEvidenceRef: new Map(),
        now: NOW,
      })
    ));
    const before = reconcileMemoryV2RuntimeOrigins();
    const replay = withImmediateTransaction(() => (
      persistPreparedMemoryRuntimeAttestationInTransaction({
        prepared,
        receiptId: seed.receiptId,
        candidateBindings: seed.bindings,
        parentOriginsByEvidenceRef: new Map(),
        now: NOW,
      })
    ));
    expect(replay).toMatchObject({ originId: first.originId, duplicate: true });
    expect(reconcileMemoryV2RuntimeOrigins()).toEqual(before);

    const changedRun = `runtime-run-${marker()}`;
    const changedSeed = seedReceipt({
      principal: principalA,
      producerRunId: changedRun,
      clientCandidateIds: [`client-${marker()}`],
    });
    const changedHandle = rootHandle({
      evidenceRefId: `root-${marker()}`,
      providerEventId: eventId,
      sourceMarker: handle.evidence_ref_id,
    });
    // Keep immutable provider content exact; only the receipt/run/candidate effect changes.
    changedHandle.immutable_digest = handle.immutable_digest;
    const changedPrepared = await prepare({
      principal: principalA,
      producerRunId: changedRun,
      handle: changedHandle,
      bindings: changedSeed.bindings,
    });
    expect(() => withImmediateTransaction(() => (
      persistPreparedMemoryRuntimeAttestationInTransaction({
        prepared: changedPrepared,
        receiptId: changedSeed.receiptId,
        candidateBindings: changedSeed.bindings,
        parentOriginsByEvidenceRef: new Map(),
        now: NOW,
      })
    ))).toThrow(/different receipt effect/);
    expect(reconcileMemoryV2RuntimeOrigins()).toEqual(before);
  });

  it("does not let a provider-event replay expand its receipt-local candidate set", async () => {
    verifiedProvider("verified");
    const runId = `runtime-run-${marker()}`;
    const seed = seedReceipt({
      principal: principalA,
      producerRunId: runId,
      clientCandidateIds: [`client-${marker()}`, `client-${marker()}`],
    });
    const handle = rootHandle({ evidenceRefId: `root-${marker()}` });
    const firstBindings = [seed.bindings[0]!];
    const firstPrepared = await prepare({
      principal: principalA,
      producerRunId: runId,
      handle,
      bindings: firstBindings,
    });
    withImmediateTransaction(() => persistPreparedMemoryRuntimeAttestationInTransaction({
      prepared: firstPrepared,
      receiptId: seed.receiptId,
      candidateBindings: firstBindings,
      parentOriginsByEvidenceRef: new Map(),
      now: NOW,
    }));
    const before = reconcileMemoryV2RuntimeOrigins();
    const expandedPrepared = await prepare({
      principal: principalA,
      producerRunId: runId,
      handle,
      bindings: seed.bindings,
    });
    expect(() => withImmediateTransaction(() => (
      persistPreparedMemoryRuntimeAttestationInTransaction({
        prepared: expandedPrepared,
        receiptId: seed.receiptId,
        candidateBindings: seed.bindings,
        parentOriginsByEvidenceRef: new Map(),
        now: NOW,
      })
    ))).toThrow(/different receipt effect/);
    expect(getMemoryV2CandidateRuntimeEvidence(seed.bindings[1]!.candidateId)).toEqual([]);
    expect(reconcileMemoryV2RuntimeOrigins()).toEqual(before);
  });

  it("fails provider outage before any origin/domain/link/signal write", async () => {
    const runId = `runtime-run-${marker()}`;
    const seed = seedReceipt({
      principal: principalA,
      producerRunId: runId,
      clientCandidateIds: [`client-${marker()}`],
    });
    const handle = rootHandle({ evidenceRefId: `root-${marker()}` });
    const before = reconcileMemoryV2RuntimeOrigins();
    setMemoryRuntimeAttestationVerifier(async () => {
      throw new Error("provider unavailable");
    });
    await expect(prepare({
      principal: principalA,
      producerRunId: runId,
      handle,
      bindings: seed.bindings,
    })).rejects.toMatchObject({ statusCode: 503, code: "temporarily_unavailable" });
    expect(reconcileMemoryV2RuntimeOrigins()).toEqual(before);
  });

  it("reverifies an active native record through its exact runtime origin, config, and authority binding", async () => {
    verifiedProvider("verified");
    const runId = `runtime-reverify-${marker()}`;
    const seed = seedReceipt({
      principal: principalA,
      producerRunId: runId,
      clientCandidateIds: [`client-${marker()}`],
      nativeReverification: true,
    });
    const candidateId = seed.bindings[0]!.candidateId;
    const storedCandidate = db.prepare(
      "SELECT candidate_json FROM memory_candidates_v1 WHERE candidate_id = ?",
    ).get(candidateId) as { candidate_json: string };
    const candidateBody = JSON.parse(storedCandidate.candidate_json) as Record<string, unknown>;
    const scopeSnapshotDigest = candidateBody.scope_snapshot_digest as string;

    const handle = rootHandle({ evidenceRefId: `root-${marker()}` });
    const prepared = await prepare({
      principal: principalA,
      producerRunId: runId,
      handle,
      bindings: seed.bindings,
    });
    const origin = withImmediateTransaction(() => (
      persistPreparedMemoryRuntimeAttestationInTransaction({
        prepared,
        receiptId: seed.receiptId,
        candidateBindings: seed.bindings,
        parentOriginsByEvidenceRef: new Map(),
        now: NOW,
      })
    ));
    const runtimeEvidenceDigest = canonicalJsonSha256([{
      evidence_ref_id: handle.evidence_ref_id,
      origin_id: origin.originId,
      corroboration_domain_id: origin.corroborationDomainId,
    }]);
    const recordId = `runtime-reverify-record-${marker()}`;
    const projectionDigest = canonicalJsonSha256({ recordId, candidateId });
    const record = importActiveHarnessMemoryRecord({
      orgId: context.orgA.id,
      projectId: context.projectA,
      recordId,
      kind: "anti_pattern",
      subtype: "failure_pattern",
      content: {
        summary: `Runtime reverification ${recordId}`,
        details: "The exact native runtime origin remains authoritative for this lesson.",
        rationale: "Scheduled checks must preserve resource, configuration, and root identity.",
      },
      applicability: {
        harness_id: "example-harness-a",
        harness_version_range: "harness-shadow-v1",
        workflow_version_range: "code-change.v3",
        adapter_version_range: "example-harness-a-pim-adapter.v1",
        configuration_ids: ["routing-default-v2"],
      },
      exceptions: [],
      compatibility: {
        harness_version_range: "harness-shadow-v1",
        workflow_version_range: "code-change.v3",
        adapter_version_range: "example-harness-a-pim-adapter.v1",
      },
      validation: {
        strategy: "stable_failure_fingerprint",
        failure_fingerprint: handle.outcome.failure_fingerprint!,
      },
      evidence: [{
        evidence_ref_id: origin.originId,
        type: "runtime_attestation",
        digest: handle.immutable_digest,
        origin_id: origin.effectiveRootOriginId ?? origin.originId,
        source_authority: "verified",
      }],
      evidenceSummary: { strength: "reviewed", ref_count: 1 },
      freshness: { last_confirmed_at: NOW, expires_at: null },
      provenance: {
        candidate_id: candidateId,
        extractor_version: "runtime-reverification-test.v1",
        runtime_origin_ids: [origin.originId],
        runtime_evidence_digest: runtimeEvidenceDigest,
        v2_corroboration_domain_ids: [origin.corroborationDomainId],
        v2_distinct_corroboration_domain_count: 1,
        v2_scope_configuration_digest: CONFIG_DIGEST,
        v2_configuration_digests: [CONFIG_DIGEST],
        v2_subtype: "failure_pattern",
        scope_snapshot_digest: scopeSnapshotDigest,
        v2_projection_digest: projectionDigest,
      },
      actorId: "runtime-reverification-reviewer",
      decisionRefs: [`runtime-reverification-${recordId}`],
      reasonCode: "runtime_reverification_fixture_activated",
      explanation: "A native runtime lesson was admitted for authoritative resolver testing.",
      now: NOW,
    });
    db.prepare(
      `UPDATE memory_candidates_v1
       SET current_status = 'active', aggregate_version = aggregate_version + 1,
           active_record_id = ?, active_record_version = ?, updated_at = ?
       WHERE candidate_id = ?`,
    ).run(record.recordId, record.recordVersion, NOW, candidateId);
    const attemptedAt = "2026-08-10T13:00:00.000Z";
    const providerContext = {
      recordId: record.recordId,
      recordVersion: record.recordVersion,
      orgId: context.orgA.id,
      projectId: context.projectA,
      plane: "harness" as const,
      resourceRowId: resource.resource_row_id,
      resolverType: "runtime_attestation" as const,
      policyRevision: 1,
      attemptNumber: 1,
      attemptedAt,
    };

    verifiedProvider("verified");
    const verified = await memoryV2ProductionReverificationProvider(providerContext);
    expect(verified).toMatchObject({
      outcome: "verified",
      verifiedAt: attemptedAt,
      sourceOccurredAt: NOW,
      evidenceDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    expect(JSON.stringify(verified)).not.toContain(handle.provider_event_id);

    verifiedProvider("verified", `changed-domain-${marker()}`);
    await expect(memoryV2ProductionReverificationProvider(providerContext))
      .resolves.toMatchObject({
        outcome: "contradicted",
        reasonCode: "runtime_authoritative_state_changed",
      });

    setMemoryRuntimeAttestationVerifier(async () => {
      throw new MemoryRuntimeAttestationError(
        "runtime authority was withdrawn",
        403,
        "resource_binding_mismatch",
      );
    });
    await expect(memoryV2ProductionReverificationProvider(providerContext))
      .resolves.toMatchObject({
        outcome: "withdrawn",
        reasonCode: "runtime_authority_withdrawn",
      });

    setMemoryRuntimeAttestationVerifier(async () => {
      throw new Error("runtime provider offline");
    });
    await expect(memoryV2ProductionReverificationProvider(providerContext))
      .resolves.toEqual({
        outcome: "unavailable",
        errorCode: "runtime_provider_unavailable",
      });

    db.prepare(
      `UPDATE memory_candidates_v1
       SET current_status = 'rejected', aggregate_version = aggregate_version + 1,
           updated_at = ?
       WHERE candidate_id = ?`,
    ).run(attemptedAt, candidateId);
    await expect(memoryV2ProductionReverificationProvider(providerContext))
      .resolves.toEqual({
        outcome: "unavailable",
        errorCode: "runtime_record_candidate_unavailable",
      });
  });

  it("keeps migrated harness detail immutable when no native runtime provenance exists", async () => {
    const recordId = `runtime-migrated-record-${marker()}`;
    const record = importActiveHarnessMemoryRecord({
      orgId: context.orgA.id,
      projectId: context.projectA,
      recordId,
      kind: "test_strategy",
      content: {
        summary: `Migrated harness record ${recordId}`,
        details: "This preserved v1 lesson predates native runtime-origin closure tracking.",
        rationale: "Historical detail remains readable even when authority cannot be guessed.",
      },
      applicability: {
        harness_id: "example-harness-a",
        harness_version_range: "harness-shadow-v1",
        workflow_version_range: "code-change.v3",
        adapter_version_range: "example-harness-a-pim-adapter.v1",
      },
      exceptions: [],
      compatibility: {
        harness_version_range: "harness-shadow-v1",
        workflow_version_range: "code-change.v3",
        adapter_version_range: "example-harness-a-pim-adapter.v1",
      },
      validation: {
        strategy: "stable_failure_fingerprint",
        failure_fingerprint: `legacy-runtime:${recordId}`,
      },
      evidence: [{
        evidence_ref_id: `migrated-evidence-${recordId}`,
        type: "failure",
        digest: canonicalJsonSha256({ recordId, migrated: true }),
        origin_id: `legacy-runtime:${recordId}`,
        source_authority: "observed",
      }],
      evidenceSummary: { strength: "observed", ref_count: 1 },
      freshness: { last_confirmed_at: NOW, expires_at: null },
      provenance: {
        extractor_version: "legacy-harness-import.v1",
        migration_source: "v1",
      },
      actorId: "legacy-harness-migration",
      decisionRefs: [`legacy-harness-${recordId}`],
      reasonCode: "legacy_harness_record_migrated",
      explanation: "The v1 harness lesson was retained without inventing native runtime origins.",
      now: NOW,
    });
    const facet = db.prepare(
      `SELECT resource_row_id FROM memory_v2_record_facets
       WHERE record_id = ? AND record_version = ?`,
    ).get(record.recordId, record.recordVersion) as { resource_row_id: string };
    const before = db.prepare(
      `SELECT record.current_status, record.current_version, version.content_digest,
              version.provenance_json
       FROM memory_records AS record
       JOIN memory_record_versions AS version
         ON version.record_id = record.record_id
        AND version.record_version = record.current_version
       WHERE record.record_id = ?`,
    ).get(record.recordId);

    await expect(memoryV2ProductionReverificationProvider({
      recordId: record.recordId,
      recordVersion: record.recordVersion,
      orgId: context.orgA.id,
      projectId: context.projectA,
      plane: "harness",
      resourceRowId: facet.resource_row_id,
      resolverType: "runtime_attestation",
      policyRevision: 1,
      attemptNumber: 1,
      attemptedAt: "2026-08-10T13:00:00.000Z",
    })).resolves.toEqual({
      outcome: "unavailable",
      errorCode: "runtime_native_provenance_unavailable",
    });
    expect(db.prepare(
      `SELECT record.current_status, record.current_version, version.content_digest,
              version.provenance_json
       FROM memory_records AS record
       JOIN memory_record_versions AS version
         ON version.record_id = record.record_id
        AND version.record_version = record.current_version
       WHERE record.record_id = ?`,
    ).get(record.recordId)).toEqual(before);
  });

  it("physically expires source-qualified runtime evidence once no live candidate depends on it", async () => {
    verifiedProvider("observed", `retention-domain-${marker()}`);
    const runId = `runtime-retention-${marker()}`;
    const seed = seedReceipt({
      principal: principalA,
      producerRunId: runId,
      clientCandidateIds: [`client-${marker()}`],
    });
    const handle = rootHandle({ evidenceRefId: `root-${marker()}` });
    const prepared = await prepare({
      principal: principalA,
      producerRunId: runId,
      handle,
      bindings: seed.bindings,
    });
    const result = withImmediateTransaction(() => (
      persistPreparedMemoryRuntimeAttestationInTransaction({
        prepared,
        receiptId: seed.receiptId,
        candidateBindings: seed.bindings,
        parentOriginsByEvidenceRef: new Map(),
        now: NOW,
      })
    ));
    db.prepare(
      `UPDATE memory_candidates_v1
       SET current_status = 'rejected', aggregate_version = aggregate_version + 1,
           updated_at = ? WHERE candidate_id = ?`,
    ).run("2026-08-10T13:00:00.000Z", seed.bindings[0]!.candidateId);
    createMemoryRetentionPolicyVersion({
      orgId: context.orgA.id,
      projectId: context.projectA,
      dataClass: "evidence",
      retentionDays: 0,
      actorId: "slice5-retention-admin",
      reasonCode: "runtime_evidence_expired",
      effectiveAt: "2026-08-10T13:00:00.000Z",
      now: "2026-08-10T13:00:00.000Z",
    });
    const plan = planMemoryRetention({
      orgId: context.orgA.id,
      projectId: context.projectA,
      dataClass: "evidence",
      actorId: "slice5-retention-admin",
      reasonCode: "runtime_evidence_expired",
      now: "2026-08-10T14:00:00.000Z",
      backupRetentionDays: 0,
    });
    expect(plan.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        resource_class: "evidence",
        resource_id: `memory_v2_runtime_receipt:${seed.receiptId}`,
        action: "physical_delete",
      }),
    ]));
    const domain = db.prepare(
      `SELECT provider_domain_key FROM memory_v2_corroboration_domains
       WHERE corroboration_domain_id = ?`,
    ).get(result.corroborationDomainId) as { provider_domain_key: string };
    const domainGuard = db.prepare(
      `SELECT sql FROM sqlite_schema
       WHERE type = 'trigger'
         AND name = 'memory_v2_corroboration_domains_no_update'`,
    ).get() as { sql: string };
    const setProviderDomainKey = (value: string): void => {
      db.exec("DROP TRIGGER memory_v2_corroboration_domains_no_update");
      try {
        db.prepare(
          `UPDATE memory_v2_corroboration_domains SET provider_domain_key = ?
           WHERE corroboration_domain_id = ?`,
        ).run(value, result.corroborationDomainId);
      } finally {
        db.exec(domainGuard.sql);
      }
    };
    setProviderDomainKey(`stale-domain-${marker()}`);
    expect(() => applyMemoryErasurePlan({
      plan,
      expectedPlanDigest: plan.plan_digest,
      downtimeConfirmed: true,
      compact: false,
      now: "2026-08-10T14:00:00.000Z",
    })).toThrow(expect.objectContaining({ code: "plan_stale" }));
    setProviderDomainKey(domain.provider_domain_key);
    applyMemoryErasurePlan({
      plan,
      expectedPlanDigest: plan.plan_digest,
      downtimeConfirmed: true,
      compact: false,
      now: "2026-08-10T14:00:00.000Z",
    });
    expect(db.prepare(
      "SELECT 1 FROM memory_v2_origins WHERE origin_id = ?",
    ).get(result.originId)).toBeUndefined();
    expect(db.prepare(
      "SELECT 1 FROM memory_v2_candidate_origins WHERE candidate_id = ?",
    ).get(seed.bindings[0]!.candidateId)).toBeUndefined();
    expect(db.prepare(
      "SELECT 1 FROM memory_v2_corroboration_domains WHERE corroboration_domain_id = ?",
    ).get(result.corroborationDomainId)).toBeUndefined();
    expect(reconcileMemoryV2RuntimeOrigins().ok).toBe(true);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("fails closed on stored resolution or association corruption and never repairs it", async () => {
    verifiedProvider("verified");
    const runId = `runtime-run-${marker()}`;
    const seed = seedReceipt({
      principal: principalA,
      producerRunId: runId,
      clientCandidateIds: [`client-${marker()}`],
    });
    const handle = rootHandle({ evidenceRefId: `root-${marker()}` });
    const prepared = await prepare({ principal: principalA, producerRunId: runId, handle, bindings: seed.bindings });
    const result = withImmediateTransaction(() => (
      persistPreparedMemoryRuntimeAttestationInTransaction({
        prepared,
        receiptId: seed.receiptId,
        candidateBindings: seed.bindings,
        parentOriginsByEvidenceRef: new Map(),
        now: NOW,
      })
    ));
    const closureInput = {
      orgId: context.orgA.id,
      projectId: context.projectA,
      resourceRowId: resource.resource_row_id,
      producerPrincipalId: principalA.servicePrincipalId,
      producerRunId: runId,
      receiptId: seed.receiptId,
      handles: [handle],
      candidateBindingsByEvidenceRef: new Map([[handle.evidence_ref_id, seed.bindings]]),
    };
    expect(assertStoredMemoryRuntimeReceiptEvidence(closureInput)).toHaveLength(1);

    expect(() => withImmediateTransaction(() => {
      const trigger = db.prepare(
        `SELECT sql FROM sqlite_schema
         WHERE type = 'trigger' AND name = 'memory_v2_origins_no_update'`,
      ).get() as { sql: string };
      db.exec("DROP TRIGGER memory_v2_origins_no_update");
      db.prepare("UPDATE memory_v2_origins SET resolution_json = '{}' WHERE origin_id = ?")
        .run(result.originId);
      expect(() => persistPreparedMemoryRuntimeAttestationInTransaction({
        prepared,
        receiptId: seed.receiptId,
        candidateBindings: seed.bindings,
        parentOriginsByEvidenceRef: new Map(),
        now: NOW,
      })).toThrow(/provider resolution is inconsistent/);
      expect(() => assertStoredMemoryRuntimeReceiptEvidence(closureInput))
        .toThrow(/provider resolution is inconsistent/);
      expect(reconcileMemoryV2RuntimeOrigins().ok).toBe(false);
      expect(db.prepare(
        "SELECT resolution_json FROM memory_v2_origins WHERE origin_id = ?",
      ).get(result.originId)).toEqual({ resolution_json: "{}" });
      db.exec(trigger.sql);
      throw new Error("rollback-corruption-probe");
    })).toThrow("rollback-corruption-probe");
    expect(assertStoredMemoryRuntimeReceiptEvidence(closureInput)).toHaveLength(1);

    expect(() => withImmediateTransaction(() => {
      const trigger = db.prepare(
        `SELECT sql FROM sqlite_schema
         WHERE type = 'trigger' AND name = 'memory_v2_candidate_origins_no_delete'`,
      ).get() as { sql: string };
      db.exec("DROP TRIGGER memory_v2_candidate_origins_no_delete");
      db.prepare("DELETE FROM memory_v2_candidate_origins WHERE origin_id = ?").run(result.originId);
      expect(() => assertStoredMemoryRuntimeReceiptEvidence(closureInput))
        .toThrow(/submitted effect|origin closure/);
      expect(reconcileMemoryV2RuntimeOrigins().ok).toBe(false);
      expect(db.prepare(
        "SELECT COUNT(*) AS count FROM memory_v2_candidate_origins WHERE origin_id = ?",
      ).get(result.originId)).toEqual({ count: 0 });
      db.exec(trigger.sql);
      throw new Error("rollback-association-probe");
    })).toThrow("rollback-association-probe");
    expect(assertStoredMemoryRuntimeReceiptEvidence(closureInput)).toHaveLength(1);
    expect(reconcileMemoryV2RuntimeOrigins().ok).toBe(true);
  });

  it("erases the complete runtime-origin graph for a project without weakening immutable guards", () => {
    const scopedOriginIds = (db.prepare(
      `SELECT origin_id FROM memory_v2_origins
       WHERE org_id = ? AND project_id = ? ORDER BY origin_id`,
    ).all(context.orgA.id, context.projectA) as unknown as Array<{ origin_id: string }>)
      .map((row) => row.origin_id);
    const otherProjectResourceCount = db.prepare(
      `SELECT COUNT(*) AS count FROM memory_v2_resources
       WHERE org_id = ? AND project_id = ?`,
    ).get(context.orgA.id, context.projectA2);
    const plan = planMemoryErasure({
      orgId: context.orgA.id,
      projectId: context.projectA,
      dataClass: "tenant",
      method: "physical_delete",
      actorId: "slice5-privacy-admin",
      reasonCode: "erase_runtime_origin_project",
      now: "2026-08-10T15:00:00.000Z",
      backupRetentionDays: 0,
    });
    applyMemoryErasurePlan({
      plan,
      expectedPlanDigest: plan.plan_digest,
      downtimeConfirmed: true,
      compact: false,
    });
    for (const table of [
      "memory_v2_review_signals",
      "memory_v2_candidate_origins",
      "memory_v2_origins",
      "memory_v2_corroboration_domains",
    ]) {
      expect(db.prepare(
        `SELECT COUNT(*) AS count FROM ${table} WHERE project_id = ?`,
      ).get(context.projectA)).toEqual({ count: 0 });
    }
    if (scopedOriginIds.length > 0) {
      const marks = scopedOriginIds.map(() => "?").join(", ");
      expect(db.prepare(
        `SELECT COUNT(*) AS count FROM memory_v2_origin_roots
         WHERE origin_id IN (${marks}) OR root_origin_id IN (${marks})`,
      ).get(...scopedOriginIds, ...scopedOriginIds)).toEqual({ count: 0 });
      expect(db.prepare(
        `SELECT COUNT(*) AS count FROM memory_v2_origin_derivations
         WHERE origin_id IN (${marks}) OR parent_origin_id IN (${marks})`,
      ).get(...scopedOriginIds, ...scopedOriginIds)).toEqual({ count: 0 });
    }
    expect(db.prepare(
      `SELECT COUNT(*) AS count FROM memory_v2_resources
       WHERE org_id = ? AND project_id = ?`,
    ).get(context.orgA.id, context.projectA2)).toEqual(otherProjectResourceCount);
    expect(db.prepare(
      `SELECT 1 FROM sqlite_schema
       WHERE type = 'trigger' AND name = 'memory_v2_origins_no_delete'`,
    ).get()).toEqual({ 1: 1 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
