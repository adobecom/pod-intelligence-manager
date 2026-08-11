import { randomUUID } from "node:crypto";
import { canonicalJsonSha256, canonicalizeJson } from "@pim/shared";
import db from "../db/connection.js";
import {
  memoryV2RepositoryResourceRowId,
  resolveMemoryV2HarnessResourceRowId,
} from "./memory-v2-resources.js";
import { getMemoryV2CandidateRuntimeEvidence } from "./memory-v2-runtime-attestations.js";

export type MemoryV2CanonicalPlane = "codebase" | "harness";
export type MemoryV2BroadKind = "decision" | "constraint" | "anti_pattern" | "test_strategy";
export type MemoryV2HarnessSubtype =
  | "workflow_strategy"
  | "failure_pattern"
  | "verification_sequence"
  | "tool_constraint"
  | "escalation_requirement";

type ProjectionStatus = "mapped" | "unmappable";
type FacetAggregateType = "record" | "candidate" | "receipt" | "feedback";
type FacetSourcePlane = MemoryV2CanonicalPlane | "org" | "unknown";
type FacetQuarantineReason =
  | "unsupported_plane"
  | "resource_missing"
  | "resource_ambiguous"
  | "plane_ambiguous"
  | "subtype_ambiguous"
  | "authority_mismatch";

interface FacetProjection {
  subtype: MemoryV2HarnessSubtype | null;
  projectionStatus: ProjectionStatus;
}

interface FacetRow {
  org_id: string;
  project_id: string;
  plane: MemoryV2CanonicalPlane;
  resource_row_id: string;
  broad_kind?: MemoryV2BroadKind;
  subtype?: MemoryV2HarnessSubtype | null;
  projection_status?: ProjectionStatus;
  facet_json: string;
}

export interface MemoryV2NativeHarnessCandidateProjectionInput {
  clientCandidateId: string;
  resourceRowId: string;
  subtype: MemoryV2HarnessSubtype;
  scopeSnapshotDigest: string;
  evidenceRefsDigest: string;
  configurationDigest: string;
  configurationSelectorDigest: string | null;
  activationRequirementRequested: "independently_verified_runtime" | "authorized_review";
  validationStrategy: string;
}

export function memoryV2NativeHarnessCandidateProjectionDigest(
  input: MemoryV2NativeHarnessCandidateProjectionInput,
): string {
  return canonicalJsonSha256({
    schema_version: "pim.memory-v2-native-harness-candidate-projection.v1",
    client_candidate_id: input.clientCandidateId,
    resource_row_id: input.resourceRowId,
    subtype: input.subtype,
    scope_snapshot_digest: input.scopeSnapshotDigest,
    evidence_refs_digest: input.evidenceRefsDigest,
    configuration_digest: input.configurationDigest,
    configuration_selector_digest: input.configurationSelectorDigest,
    activation_requirement_requested: input.activationRequirementRequested,
    validation_strategy: input.validationStrategy,
  });
}

export function memoryV2NativeHarnessRecordProjectionDigest(input: {
  candidateId: string;
  recordId: string;
  recordVersion: number;
  resourceRowId: string;
  subtype: MemoryV2HarnessSubtype;
  scopeSnapshotDigest: string;
  scopeConfigurationDigest: string;
  runtimeOriginIds: readonly string[];
  corroborationDomainIds: readonly string[];
  distinctCorroborationDomainCount: number;
  configurationDigests: readonly string[];
  runtimeEvidenceDigest: string;
}): string {
  return canonicalJsonSha256({
    schema_version: "pim.memory-v2-native-harness-record-projection.v1",
    candidate_id: input.candidateId,
    record_id: input.recordId,
    record_version: input.recordVersion,
    resource_row_id: input.resourceRowId,
    subtype: input.subtype,
    scope_snapshot_digest: input.scopeSnapshotDigest,
    scope_configuration_digest: input.scopeConfigurationDigest,
    runtime_origin_ids: [...input.runtimeOriginIds],
    corroboration_domain_ids: [...input.corroborationDomainIds],
    distinct_corroboration_domain_count: input.distinctCorroborationDomainCount,
    configuration_digests: [...input.configurationDigests],
    runtime_evidence_digest: input.runtimeEvidenceDigest,
  });
}

export function memoryV2NativeHarnessRuntimeEvidenceDigest(
  rows: readonly {
    evidenceRefId: string;
    originId: string;
    corroborationDomainId: string;
  }[],
): string {
  return canonicalJsonSha256([...rows]
    .sort((left, right) => (
      left.evidenceRefId.localeCompare(right.evidenceRefId)
      || left.originId.localeCompare(right.originId)
    ))
    .map((row) => ({
      evidence_ref_id: row.evidenceRefId,
      origin_id: row.originId,
      corroboration_domain_id: row.corroborationDomainId,
    })));
}

export class MemoryV2CanonicalWriteError extends Error {
  readonly statusCode = 409;
  readonly code = "idempotency_conflict";

  constructor(message: string) {
    super(message);
    this.name = "MemoryV2CanonicalWriteError";
  }
}

const HARNESS_SUBTYPE_KIND: Readonly<Record<MemoryV2HarnessSubtype, MemoryV2BroadKind>> = {
  workflow_strategy: "decision",
  failure_pattern: "anti_pattern",
  verification_sequence: "test_strategy",
  tool_constraint: "constraint",
  escalation_requirement: "constraint",
};

function projectionFor(input: {
  plane: MemoryV2CanonicalPlane;
  broadKind: MemoryV2BroadKind;
  subtype?: MemoryV2HarnessSubtype | null;
}): FacetProjection {
  if (input.plane === "codebase") {
    if (input.subtype) {
      throw new MemoryV2CanonicalWriteError("Codebase facets cannot carry a harness subtype");
    }
    return { subtype: null, projectionStatus: "mapped" };
  }
  if (input.subtype) {
    if (HARNESS_SUBTYPE_KIND[input.subtype] !== input.broadKind) {
      throw new MemoryV2CanonicalWriteError("Harness subtype does not map to the stored broad kind");
    }
    return { subtype: input.subtype, projectionStatus: "mapped" };
  }
  if (input.broadKind === "decision") {
    return { subtype: "workflow_strategy", projectionStatus: "mapped" };
  }
  if (input.broadKind === "anti_pattern") {
    return { subtype: "failure_pattern", projectionStatus: "mapped" };
  }
  if (input.broadKind === "test_strategy") {
    return { subtype: "verification_sequence", projectionStatus: "mapped" };
  }
  // A v1 harness constraint cannot distinguish tool_constraint from
  // escalation_requirement. Preserve it for audit, but never guess.
  return { subtype: null, projectionStatus: "unmappable" };
}

function assertResource(input: {
  orgId: string;
  projectId: string;
  plane: MemoryV2CanonicalPlane;
  resourceRowId: string;
}): void {
  const resource = db.prepare(
    `SELECT org_id, project_id, plane
     FROM memory_v2_resources WHERE resource_row_id = ?`,
  ).get(input.resourceRowId) as {
    org_id: string;
    project_id: string;
    plane: MemoryV2CanonicalPlane;
  } | undefined;
  if (!resource
      || resource.org_id !== input.orgId
      || resource.project_id !== input.projectId
      || resource.plane !== input.plane) {
    throw new MemoryV2CanonicalWriteError("Canonical companion resource is missing or mismatched");
  }
}

function assertFacetScope(
  row: FacetRow | undefined,
  expected: {
    orgId: string;
    projectId: string;
    plane: MemoryV2CanonicalPlane;
    resourceRowId: string;
  },
): asserts row is FacetRow {
  if (!row
      || row.org_id !== expected.orgId
      || row.project_id !== expected.projectId
      || row.plane !== expected.plane
      || row.resource_row_id !== expected.resourceRowId) {
    throw new MemoryV2CanonicalWriteError("Canonical companion facet is missing or mismatched");
  }
  try {
    const facet = JSON.parse(row.facet_json) as unknown;
    if (!facet || typeof facet !== "object" || Array.isArray(facet)) throw new Error("invalid facet");
  } catch {
    throw new MemoryV2CanonicalWriteError("Canonical companion facet JSON is invalid");
  }
}

function assertFacetJson(raw: string, expected: Record<string, unknown>): void {
  let actual: unknown;
  try {
    actual = JSON.parse(raw) as unknown;
  } catch {
    throw new MemoryV2CanonicalWriteError("Canonical companion facet JSON is invalid");
  }
  if (canonicalizeJson(actual) !== canonicalizeJson(expected)) {
    throw new MemoryV2CanonicalWriteError("Canonical companion facet JSON is mismatched");
  }
}

function recordFacetJson(input: {
  plane: MemoryV2CanonicalPlane;
  broadKind: MemoryV2BroadKind;
  nativeSubtype?: MemoryV2HarnessSubtype | null;
}): Record<string, unknown> {
  return {
    projection: input.nativeSubtype ? "v2_native" : "v1",
    source_plane: input.plane,
    projection_reason: input.nativeSubtype
      ? "native_subtype"
      : input.plane === "harness" && input.broadKind === "constraint"
      ? "ambiguous_legacy_subtype"
      : "lossless",
  };
}

interface NativeHarnessRuntimeClosure {
  runtimeOriginIds: string[];
  corroborationDomainIds: string[];
  distinctCorroborationDomainCount: number;
  scopeConfigurationDigest: string;
  configurationDigests: string[];
  runtimeEvidenceDigest: string;
}

type NativeHarnessValidationStrategy =
  | "stable_failure_fingerprint"
  | "runtime_attestation"
  | "authorized_review";

interface ValidatedNativeHarnessScope {
  validationStrategy: NativeHarnessValidationStrategy;
  failureFingerprint: string | null;
}

interface NativeHarnessRuntimeClosureInput {
  candidateId: string;
  receiptId: string;
  clientCandidateId: string;
  expectedResourceRowId: string;
  candidateJson: string;
  scopeSnapshotDigest: string;
  evidenceRefsDigest: string;
  configurationDigest: string;
  configurationSelectorDigest: string | null;
  validationStrategy: NativeHarnessValidationStrategy;
}

function assertNativeCandidateScope(
  input: NativeHarnessRuntimeClosureInput,
): ValidatedNativeHarnessScope {
  const snapshot = db.prepare(
    `SELECT snapshot.scope_snapshot_json, receipt.receipt_json
     FROM memory_v2_scope_snapshots AS snapshot
     INNER JOIN memory_run_receipts AS receipt ON receipt.receipt_id = snapshot.receipt_id
     WHERE snapshot.receipt_id = ? AND snapshot.plane = 'harness'
       AND snapshot.resource_row_id = ? AND snapshot.scope_snapshot_digest = ?`,
  ).get(
    input.receiptId,
    input.expectedResourceRowId,
    input.scopeSnapshotDigest,
  ) as { scope_snapshot_json: string; receipt_json: string } | undefined;
  if (!snapshot) {
    throw new MemoryV2CanonicalWriteError(
      "Native harness candidate marker lacks its exact v2 scope snapshot",
    );
  }
  let snapshotConfigurationDigest: unknown;
  let failureFingerprint: unknown;
  let bridgeStrategy: unknown;
  let receiptOutcome: {
    status?: unknown;
    verification_status?: unknown;
    failure_fingerprint?: unknown;
  } = {};
  try {
    snapshotConfigurationDigest = (JSON.parse(snapshot.scope_snapshot_json) as {
      configuration_digest?: unknown;
    }).configuration_digest;
    const candidate = JSON.parse(input.candidateJson) as {
      validation?: { strategy?: unknown; failure_fingerprint?: unknown };
    };
    bridgeStrategy = candidate.validation?.strategy;
    failureFingerprint = candidate.validation?.failure_fingerprint;
    receiptOutcome = (JSON.parse(snapshot.receipt_json) as {
      outcome?: typeof receiptOutcome;
    }).outcome ?? {};
  } catch {
    throw new MemoryV2CanonicalWriteError("Native harness candidate closure JSON is invalid");
  }
  const failureDerived = input.validationStrategy === "stable_failure_fingerprint";
  const validationMatches = failureDerived
    ? bridgeStrategy === "stable_failure_fingerprint"
      && typeof failureFingerprint === "string"
      && failureFingerprint.length > 0
      && receiptOutcome.failure_fingerprint === failureFingerprint
    : bridgeStrategy === "policy_owner_review"
      && failureFingerprint === undefined
      && receiptOutcome.status === "completed"
      && receiptOutcome.verification_status === "passed"
      && receiptOutcome.failure_fingerprint === null;
  if (!validationMatches
      || snapshotConfigurationDigest !== input.configurationDigest
      || (input.configurationSelectorDigest !== null
        && input.configurationSelectorDigest !== input.configurationDigest)) {
    throw new MemoryV2CanonicalWriteError(
      "Native harness candidate scope or validation marker is mismatched",
    );
  }
  return {
    validationStrategy: input.validationStrategy,
    failureFingerprint: failureDerived ? failureFingerprint as string : null,
  };
}

function hasRetainedTerminalRuntimeEvidence(input: {
  candidateId: string;
  receiptId: string;
}): boolean {
  return Boolean(db.prepare(
    `SELECT 1
     FROM memory_candidates_v1 AS candidate
     JOIN memory_erasure_tombstones AS tombstone
       ON tombstone.resource_class = 'evidence'
      AND tombstone.resource_id = 'memory_v2_runtime_receipt:' || candidate.receipt_id
      AND tombstone.erasure_method = 'physical_delete'
     JOIN memory_erasure_requests AS request
       ON request.request_id = tombstone.request_id
      AND request.org_id = candidate.org_id
      AND (request.project_id IS NULL OR request.project_id = candidate.project_id)
     WHERE candidate.candidate_id = ? AND candidate.receipt_id = ?
       AND candidate.current_status IN (
         'rejected','quarantined','validation_failed','activation_failed'
       )`,
  ).get(input.candidateId, input.receiptId));
}

function nativeCandidateRuntimeClosure(
  input: NativeHarnessRuntimeClosureInput,
  validatedScope: ValidatedNativeHarnessScope = assertNativeCandidateScope(input),
): NativeHarnessRuntimeClosure {
  const { failureFingerprint, validationStrategy } = validatedScope;
  let deepEvidence: ReturnType<typeof getMemoryV2CandidateRuntimeEvidence>;
  try {
    deepEvidence = getMemoryV2CandidateRuntimeEvidence(input.candidateId);
  } catch {
    throw new MemoryV2CanonicalWriteError(
      "Native harness candidate runtime-origin closure is incomplete or inconsistent",
    );
  }
  const rows = db.prepare(
    `SELECT link.client_candidate_id, link.receipt_id, link.resource_row_id,
            link.org_id, link.project_id, link.plane, link.producer_run_id,
            link.request_digest,
            link.evidence_ref_id, link.origin_id, link.corroboration_domain_id,
            origin.receipt_id AS origin_receipt_id,
            origin.resource_row_id AS origin_resource_row_id,
            origin.org_id AS origin_org_id,
            origin.project_id AS origin_project_id,
            origin.plane AS origin_plane,
            origin.producer_run_id AS origin_producer_run_id,
            origin.request_digest AS origin_request_digest,
            origin.evidence_ref_id AS origin_evidence_ref_id,
            origin.corroboration_domain_id AS origin_domain_id,
            origin.source_authority AS origin_source_authority,
            origin.outcome_json
     FROM memory_v2_candidate_origins AS link
     LEFT JOIN memory_v2_origins AS origin ON origin.origin_id = link.origin_id
     WHERE link.candidate_id = ?
     ORDER BY link.evidence_ref_id, link.origin_id`,
  ).all(input.candidateId) as unknown as Array<{
    client_candidate_id: string;
    receipt_id: string;
    resource_row_id: string;
    org_id: string;
    project_id: string;
    plane: string;
    producer_run_id: string;
    request_digest: string;
    evidence_ref_id: string;
    origin_id: string;
    corroboration_domain_id: string;
    origin_receipt_id: string | null;
    origin_resource_row_id: string | null;
    origin_org_id: string | null;
    origin_project_id: string | null;
    origin_plane: string | null;
    origin_producer_run_id: string | null;
    origin_request_digest: string | null;
    origin_evidence_ref_id: string | null;
    origin_domain_id: string | null;
    origin_source_authority: string | null;
    outcome_json: string | null;
  }>;
  const deepByIdentity = new Map(deepEvidence.map((item) => [
    `${item.evidenceRefId}\0${item.originId}`,
    item,
  ]));
  const evidenceRequired = validationStrategy !== "authorized_review";
  if ((evidenceRequired && rows.length < 1)
      || rows.length !== deepEvidence.length
      || canonicalJsonSha256(rows.map((row) => row.evidence_ref_id).sort())
        !== input.evidenceRefsDigest
      || rows.some((row) => {
        const deep = deepByIdentity.get(`${row.evidence_ref_id}\0${row.origin_id}`);
        if (row.client_candidate_id !== input.clientCandidateId
            || row.receipt_id !== input.receiptId
            || row.resource_row_id !== input.expectedResourceRowId
            || row.plane !== "harness"
            || row.origin_receipt_id !== input.receiptId
            || row.origin_resource_row_id !== input.expectedResourceRowId
            || row.origin_org_id !== row.org_id
            || row.origin_project_id !== row.project_id
            || row.origin_plane !== row.plane
            || row.origin_producer_run_id !== row.producer_run_id
            || row.origin_request_digest !== row.request_digest
            || row.origin_evidence_ref_id !== row.evidence_ref_id
            || row.origin_domain_id !== row.corroboration_domain_id
            || typeof row.outcome_json !== "string"
            || !deep
            || deep.candidateId !== input.candidateId
            || deep.clientCandidateId !== row.client_candidate_id
            || deep.receiptId !== row.receipt_id
            || deep.producerRunId !== row.producer_run_id
            || deep.requestDigest !== row.request_digest
            || deep.corroborationDomainId !== row.corroboration_domain_id) return true;
        try {
          const outcome = JSON.parse(row.outcome_json) as {
            status?: unknown;
            verification_status?: unknown;
            failure_fingerprint?: unknown;
          };
          return validationStrategy === "stable_failure_fingerprint"
            ? outcome.failure_fingerprint !== failureFingerprint
            : outcome.status !== "completed"
              || outcome.verification_status !== "passed"
              || outcome.failure_fingerprint !== null
              || (validationStrategy === "runtime_attestation"
                && row.origin_source_authority !== "verified");
        } catch {
          return true;
        }
      })) {
    throw new MemoryV2CanonicalWriteError(
      "Native harness candidate runtime-origin closure is missing or mismatched",
    );
  }
  const runtimeOriginIds = rows.map((row) => row.origin_id).sort();
  const corroborationDomainIds = [...new Set(
    rows.map((row) => row.corroboration_domain_id),
  )].sort();
  return {
    runtimeOriginIds,
    corroborationDomainIds,
    distinctCorroborationDomainCount: corroborationDomainIds.length,
    scopeConfigurationDigest: input.configurationDigest,
    configurationDigests: input.configurationSelectorDigest === null
      ? []
      : [input.configurationSelectorDigest],
    runtimeEvidenceDigest: memoryV2NativeHarnessRuntimeEvidenceDigest(rows.map((row) => ({
      evidenceRefId: row.evidence_ref_id,
      originId: row.origin_id,
      corroborationDomainId: row.corroboration_domain_id,
    }))),
  };
}

function nativeCandidateSubtype(input: {
  candidateId: string;
  candidateJson: string;
  receiptId: string;
  clientCandidateId: string;
  expectedResourceRowId: string;
}): MemoryV2HarnessSubtype | null {
  let candidate: {
    extensions?: Record<string, unknown>;
  };
  try {
    candidate = JSON.parse(input.candidateJson) as typeof candidate;
  } catch {
    throw new MemoryV2CanonicalWriteError("Canonical candidate JSON is invalid");
  }
  const extensions = candidate.extensions;
  const subtype = extensions?.v2_subtype;
  if (typeof subtype !== "string" || !(subtype in HARNESS_SUBTYPE_KIND)) return null;
  const scopeSnapshotDigest = extensions?.v2_scope_snapshot_digest;
  const evidenceRefsDigest = extensions?.v2_evidence_refs_digest;
  const configurationDigest = extensions?.v2_configuration_digest;
  const configurationSelectorDigest = extensions?.v2_configuration_selector_digest;
  const activationRequirementRequested = extensions?.v2_activation_requirement_requested;
  const validationStrategy = extensions?.v2_validation_strategy;
  const resourceRowId = extensions?.v2_resource_row_id;
  const projectionDigest = extensions?.v2_projection_digest;
  if (typeof scopeSnapshotDigest !== "string"
      || typeof evidenceRefsDigest !== "string"
      || typeof configurationDigest !== "string"
      || (configurationSelectorDigest !== null
        && typeof configurationSelectorDigest !== "string")
      || (activationRequirementRequested !== "independently_verified_runtime"
        && activationRequirementRequested !== "authorized_review")
      || (validationStrategy !== "stable_failure_fingerprint"
        && validationStrategy !== "runtime_attestation"
        && validationStrategy !== "authorized_review")
      || resourceRowId !== input.expectedResourceRowId
      || typeof projectionDigest !== "string") {
    throw new MemoryV2CanonicalWriteError("Native harness candidate marker is incomplete");
  }
  const nativeSubtype = subtype as MemoryV2HarnessSubtype;
  const expectedDigest = memoryV2NativeHarnessCandidateProjectionDigest({
    clientCandidateId: input.clientCandidateId,
    resourceRowId: input.expectedResourceRowId,
    subtype: nativeSubtype,
    scopeSnapshotDigest,
    evidenceRefsDigest,
    configurationDigest,
    configurationSelectorDigest,
    activationRequirementRequested,
    validationStrategy,
  });
  if (projectionDigest !== expectedDigest) {
    throw new MemoryV2CanonicalWriteError("Native harness candidate marker digest is invalid");
  }
  const closureInput: NativeHarnessRuntimeClosureInput = {
    candidateId: input.candidateId,
    receiptId: input.receiptId,
    clientCandidateId: input.clientCandidateId,
    expectedResourceRowId: input.expectedResourceRowId,
    candidateJson: input.candidateJson,
    scopeSnapshotDigest,
    evidenceRefsDigest,
    configurationDigest,
    configurationSelectorDigest,
    validationStrategy,
  };
  const validatedScope = assertNativeCandidateScope(closureInput);
  if (!hasRetainedTerminalRuntimeEvidence({
    candidateId: input.candidateId,
    receiptId: input.receiptId,
  })) {
    nativeCandidateRuntimeClosure(closureInput, validatedScope);
  }
  return nativeSubtype;
}

function nativeRecordSubtype(input: {
  recordId: string;
  recordVersion: number;
  expectedResourceRowId: string;
}): MemoryV2HarnessSubtype | null {
  const version = db.prepare(
    `SELECT provenance_json FROM memory_record_versions
     WHERE record_id = ? AND record_version = ?`,
  ).get(input.recordId, input.recordVersion) as { provenance_json: string } | undefined;
  if (!version) throw new MemoryV2CanonicalWriteError("Canonical record version is unavailable");
  let provenance: Record<string, unknown>;
  try {
    provenance = JSON.parse(version.provenance_json) as Record<string, unknown>;
  } catch {
    throw new MemoryV2CanonicalWriteError("Canonical record provenance is invalid");
  }
  const rawSubtype = provenance.v2_subtype;
  if (typeof rawSubtype !== "string" || !(rawSubtype in HARNESS_SUBTYPE_KIND)) return null;
  const candidateId = provenance.candidate_id;
  const scopeSnapshotDigest = provenance.scope_snapshot_digest;
  const projectionDigest = provenance.v2_projection_digest;
  const runtimeOriginIds = provenance.runtime_origin_ids;
  const corroborationDomainIds = provenance.v2_corroboration_domain_ids;
  const distinctCorroborationDomainCount = provenance.v2_distinct_corroboration_domain_count;
  const scopeConfigurationDigest = provenance.v2_scope_configuration_digest;
  const configurationDigests = provenance.v2_configuration_digests;
  const runtimeEvidenceDigest = provenance.runtime_evidence_digest;
  if (typeof candidateId !== "string" || typeof scopeSnapshotDigest !== "string"
      || typeof projectionDigest !== "string"
      || !Array.isArray(runtimeOriginIds)
      || runtimeOriginIds.some((value) => typeof value !== "string")
      || !Array.isArray(corroborationDomainIds)
      || corroborationDomainIds.some((value) => typeof value !== "string")
      || !Number.isSafeInteger(distinctCorroborationDomainCount)
      || typeof scopeConfigurationDigest !== "string"
      || !Array.isArray(configurationDigests)
      || configurationDigests.some((value) => typeof value !== "string")
      || typeof runtimeEvidenceDigest !== "string") {
    throw new MemoryV2CanonicalWriteError("Native harness record marker is incomplete");
  }
  const candidate = db.prepare(
    `SELECT candidate.receipt_id, candidate.client_candidate_id, candidate.candidate_json,
            candidate.active_record_id, candidate.active_record_version,
            record.current_version AS record_current_version
     FROM memory_candidates_v1 AS candidate
     INNER JOIN memory_records AS record ON record.record_id = candidate.active_record_id
     WHERE candidate.candidate_id = ? AND candidate.plane = 'harness'`,
  ).get(candidateId) as {
    receipt_id: string;
    client_candidate_id: string;
    candidate_json: string;
    active_record_id: string | null;
    active_record_version: number | null;
    record_current_version: number;
  } | undefined;
  if (!candidate || candidate.active_record_id !== input.recordId
      || candidate.active_record_version !== candidate.record_current_version
      || input.recordVersion > candidate.record_current_version) {
    throw new MemoryV2CanonicalWriteError(
      "Native harness record marker lacks its activated source candidate",
    );
  }
  const candidateSubtype = nativeCandidateSubtype({
    candidateId,
    candidateJson: candidate.candidate_json,
    receiptId: candidate.receipt_id,
    clientCandidateId: candidate.client_candidate_id,
    expectedResourceRowId: input.expectedResourceRowId,
  });
  if (candidateSubtype !== rawSubtype) {
    throw new MemoryV2CanonicalWriteError("Native harness record subtype is mismatched");
  }
  let extensions: Record<string, unknown>;
  try {
    extensions = (JSON.parse(candidate.candidate_json) as {
      extensions?: Record<string, unknown>;
    }).extensions ?? {};
  } catch {
    throw new MemoryV2CanonicalWriteError("Native harness candidate JSON is invalid");
  }
  const evidenceRefsDigest = extensions.v2_evidence_refs_digest;
  const configurationDigest = extensions.v2_configuration_digest;
  const configurationSelectorDigest = extensions.v2_configuration_selector_digest;
  const validationStrategy = extensions.v2_validation_strategy;
  if (typeof evidenceRefsDigest !== "string" || typeof configurationDigest !== "string"
      || (configurationSelectorDigest !== null
        && typeof configurationSelectorDigest !== "string")
      || (validationStrategy !== "stable_failure_fingerprint"
        && validationStrategy !== "runtime_attestation"
        && validationStrategy !== "authorized_review")) {
    throw new MemoryV2CanonicalWriteError("Native harness candidate marker is incomplete");
  }
  const closure = nativeCandidateRuntimeClosure({
    candidateId,
    receiptId: candidate.receipt_id,
    clientCandidateId: candidate.client_candidate_id,
    expectedResourceRowId: input.expectedResourceRowId,
    candidateJson: candidate.candidate_json,
    scopeSnapshotDigest,
    evidenceRefsDigest,
    configurationDigest,
    configurationSelectorDigest,
    validationStrategy,
  });
  if (canonicalizeJson(runtimeOriginIds) !== canonicalizeJson(closure.runtimeOriginIds)
      || canonicalizeJson(corroborationDomainIds)
        !== canonicalizeJson(closure.corroborationDomainIds)
      || distinctCorroborationDomainCount !== closure.distinctCorroborationDomainCount
      || scopeConfigurationDigest !== closure.scopeConfigurationDigest
      || canonicalizeJson(configurationDigests)
        !== canonicalizeJson(closure.configurationDigests)
      || runtimeEvidenceDigest !== closure.runtimeEvidenceDigest) {
    throw new MemoryV2CanonicalWriteError(
      "Native harness record provenance does not match its runtime-origin closure",
    );
  }
  const expectedDigest = memoryV2NativeHarnessRecordProjectionDigest({
    candidateId,
    recordId: input.recordId,
    recordVersion: input.recordVersion,
    resourceRowId: input.expectedResourceRowId,
    subtype: candidateSubtype,
    scopeSnapshotDigest,
    ...closure,
  });
  if (projectionDigest !== expectedDigest) {
    throw new MemoryV2CanonicalWriteError("Native harness record marker digest is invalid");
  }
  return candidateSubtype;
}

function resourceRowIdForStoredAggregate(input: {
  orgId: string;
  projectId: string;
  plane: MemoryV2CanonicalPlane;
  repositoryRowId: string | null;
  harnessId: string | null;
}): string {
  if (input.plane === "codebase" && input.repositoryRowId) {
    return memoryV2RepositoryResourceRowId(input.repositoryRowId);
  }
  if (input.plane === "harness" && input.harnessId) {
    const resourceRowId = resolveMemoryV2HarnessResourceRowId({
      orgId: input.orgId,
      projectId: input.projectId,
      harnessId: input.harnessId,
    });
    if (resourceRowId) return resourceRowId;
  }
  throw new MemoryV2CanonicalWriteError("Canonical aggregate has no exact implemented resource");
}

export function insertMemoryV2RecordFacet(input: {
  recordId: string;
  recordVersion: number;
  orgId: string;
  projectId: string;
  plane: MemoryV2CanonicalPlane;
  resourceRowId: string;
  broadKind: MemoryV2BroadKind;
  subtype?: MemoryV2HarnessSubtype | null;
  now: string;
}): void {
  assertResource(input);
  const projection = projectionFor(input);
  if (projection.projectionStatus === "unmappable") {
    const version = db.prepare(
      `SELECT content_digest, recorded_at FROM memory_record_versions
       WHERE record_id = ? AND record_version = ?`,
    ).get(input.recordId, input.recordVersion) as {
      content_digest: string;
      recorded_at: string;
    } | undefined;
    if (!version) {
      throw new MemoryV2CanonicalWriteError("Canonical record version is unavailable");
    }
    insertMemoryV2FacetQuarantine({
      quarantineRowId: `v2facetq:${randomUUID()}`,
      aggregateType: "record",
      aggregateId: input.recordId,
      aggregateVersion: input.recordVersion,
      orgId: input.orgId,
      projectId: input.projectId,
      sourcePlane: "harness",
      reasonCode: "subtype_ambiguous",
      sourceDigest: version.content_digest,
      now: version.recorded_at,
    });
    return;
  }
  db.prepare(
    `INSERT INTO memory_v2_record_facets
       (record_id, record_version, org_id, project_id, plane, resource_row_id,
        broad_kind, subtype, projection_status, facet_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.recordId,
    input.recordVersion,
    input.orgId,
    input.projectId,
    input.plane,
    input.resourceRowId,
    input.broadKind,
    projection.subtype,
    projection.projectionStatus,
    JSON.stringify(recordFacetJson({
      plane: input.plane,
      broadKind: input.broadKind,
      nativeSubtype: input.subtype,
    })),
    input.now,
  );
}

export function assertMemoryV2StoredRecordFacet(input: {
  recordId: string;
  recordVersion?: number;
}): void {
  const stored = db.prepare(
    `SELECT record.org_id, record.project_id, record.plane, record.repository_row_id,
            record.harness_id, record.kind, record.current_version
     FROM memory_records AS record WHERE record.record_id = ?`,
  ).get(input.recordId) as {
    org_id: string;
    project_id: string;
    plane: MemoryV2CanonicalPlane;
    repository_row_id: string | null;
    harness_id: string | null;
    kind: MemoryV2BroadKind;
    current_version: number;
  } | undefined;
  if (!stored || !["codebase", "harness"].includes(stored.plane)) {
    throw new MemoryV2CanonicalWriteError("Canonical record is unavailable or unimplemented");
  }
  const resourceRowId = resourceRowIdForStoredAggregate({
    orgId: stored.org_id,
    projectId: stored.project_id,
    plane: stored.plane,
    repositoryRowId: stored.repository_row_id,
    harnessId: stored.harness_id,
  });
  const recordVersion = input.recordVersion ?? stored.current_version;
  const nativeSubtype = stored.plane === "harness"
    ? nativeRecordSubtype({
      recordId: input.recordId,
      recordVersion,
      expectedResourceRowId: resourceRowId,
    })
    : null;
  const projection = projectionFor({
    plane: stored.plane,
    broadKind: stored.kind,
    subtype: nativeSubtype,
  });
  if (projection.projectionStatus === "unmappable") {
    const version = db.prepare(
      `SELECT content_digest FROM memory_record_versions
       WHERE record_id = ? AND record_version = ?`,
    ).get(input.recordId, recordVersion) as { content_digest: string } | undefined;
    const facet = db.prepare(
      `SELECT 1 FROM memory_v2_record_facets
       WHERE record_id = ? AND record_version = ?`,
    ).get(input.recordId, recordVersion);
    if (!version || facet) {
      throw new MemoryV2CanonicalWriteError("Ambiguous harness subtype must be quarantined");
    }
    assertMemoryV2StoredFacetQuarantine({
      aggregateType: "record",
      aggregateId: input.recordId,
      aggregateVersion: recordVersion,
      orgId: stored.org_id,
      projectId: stored.project_id,
      sourcePlane: "harness",
      reasonCode: "subtype_ambiguous",
      sourceDigest: version.content_digest,
    });
    return;
  }
  const row = db.prepare(
    `SELECT org_id, project_id, plane, resource_row_id, broad_kind, subtype,
            projection_status, facet_json
     FROM memory_v2_record_facets WHERE record_id = ? AND record_version = ?`,
  ).get(input.recordId, recordVersion) as FacetRow | undefined;
  assertFacetScope(row, {
    orgId: stored.org_id,
    projectId: stored.project_id,
    plane: stored.plane,
    resourceRowId,
  });
  if (row.broad_kind !== stored.kind
      || row.subtype !== projection.subtype
      || row.projection_status !== projection.projectionStatus) {
    throw new MemoryV2CanonicalWriteError("Canonical record facet classification is mismatched");
  }
  assertFacetJson(row.facet_json, recordFacetJson({
    plane: stored.plane,
    broadKind: stored.kind,
    nativeSubtype,
  }));
}

export function insertMemoryV2CandidateFacet(input: {
  candidateId: string;
  orgId: string;
  projectId: string;
  plane: MemoryV2CanonicalPlane;
  resourceRowId: string;
  broadKind: MemoryV2BroadKind;
  subtype?: MemoryV2HarnessSubtype | null;
  now: string;
}): void {
  assertResource(input);
  const projection = projectionFor(input);
  if (projection.projectionStatus === "unmappable") {
    const candidate = db.prepare(
      `SELECT candidate_digest, created_at FROM memory_candidates_v1
       WHERE candidate_id = ?`,
    ).get(input.candidateId) as {
      candidate_digest: string;
      created_at: string;
    } | undefined;
    if (!candidate) {
      throw new MemoryV2CanonicalWriteError("Canonical candidate is unavailable");
    }
    insertMemoryV2FacetQuarantine({
      quarantineRowId: `v2facetq:${randomUUID()}`,
      aggregateType: "candidate",
      aggregateId: input.candidateId,
      aggregateVersion: 0,
      orgId: input.orgId,
      projectId: input.projectId,
      sourcePlane: "harness",
      reasonCode: "subtype_ambiguous",
      sourceDigest: candidate.candidate_digest,
      now: candidate.created_at,
    });
    return;
  }
  db.prepare(
    `INSERT INTO memory_v2_candidate_facets
       (candidate_id, org_id, project_id, plane, resource_row_id, broad_kind,
        subtype, projection_status, facet_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.candidateId,
    input.orgId,
    input.projectId,
    input.plane,
    input.resourceRowId,
    input.broadKind,
    projection.subtype,
    projection.projectionStatus,
    JSON.stringify({
      projection: input.subtype ? "v2_native" : "v1",
      source_plane: input.plane,
    }),
    input.now,
  );
}

export function assertMemoryV2StoredCandidateFacet(candidateId: string): void {
  const stored = db.prepare(
    `SELECT org_id, project_id, plane, repository_row_id, producer_harness_id, kind,
            receipt_id, client_candidate_id, candidate_digest, candidate_json
     FROM memory_candidates_v1 WHERE candidate_id = ?`,
  ).get(candidateId) as {
    org_id: string;
    project_id: string;
    plane: MemoryV2CanonicalPlane | "org";
    repository_row_id: string | null;
    producer_harness_id: string;
    kind: MemoryV2BroadKind;
    receipt_id: string;
    client_candidate_id: string;
    candidate_digest: string;
    candidate_json: string;
  } | undefined;
  if (!stored) {
    throw new MemoryV2CanonicalWriteError("Canonical candidate is unavailable or unimplemented");
  }
  if (stored.plane === "org") {
    const facet = db.prepare(
      "SELECT 1 FROM memory_v2_candidate_facets WHERE candidate_id = ?",
    ).get(candidateId);
    if (facet) {
      throw new MemoryV2CanonicalWriteError("Unsupported organization candidate must be quarantined");
    }
    assertMemoryV2StoredFacetQuarantine({
      aggregateType: "candidate",
      aggregateId: candidateId,
      aggregateVersion: 0,
      orgId: stored.org_id,
      projectId: stored.project_id,
      sourcePlane: "org",
      reasonCode: "unsupported_plane",
      sourceDigest: stored.candidate_digest,
    });
    return;
  }
  const resourceRowId = resourceRowIdForStoredAggregate({
    orgId: stored.org_id,
    projectId: stored.project_id,
    plane: stored.plane,
    repositoryRowId: stored.repository_row_id,
    harnessId: stored.producer_harness_id,
  });
  const nativeSubtype = stored.plane === "harness"
    ? nativeCandidateSubtype({
      candidateId,
      candidateJson: stored.candidate_json,
      receiptId: stored.receipt_id,
      clientCandidateId: stored.client_candidate_id,
      expectedResourceRowId: resourceRowId,
    })
    : null;
  const projection = projectionFor({
    plane: stored.plane,
    broadKind: stored.kind,
    subtype: nativeSubtype,
  });
  if (projection.projectionStatus === "unmappable") {
    const source = db.prepare(
      "SELECT candidate_digest FROM memory_candidates_v1 WHERE candidate_id = ?",
    ).get(candidateId) as { candidate_digest: string } | undefined;
    const facet = db.prepare(
      "SELECT 1 FROM memory_v2_candidate_facets WHERE candidate_id = ?",
    ).get(candidateId);
    if (!source || facet) {
      throw new MemoryV2CanonicalWriteError("Ambiguous harness subtype must be quarantined");
    }
    assertMemoryV2StoredFacetQuarantine({
      aggregateType: "candidate",
      aggregateId: candidateId,
      aggregateVersion: 0,
      orgId: stored.org_id,
      projectId: stored.project_id,
      sourcePlane: "harness",
      reasonCode: "subtype_ambiguous",
      sourceDigest: source.candidate_digest,
    });
    return;
  }
  const row = db.prepare(
    `SELECT org_id, project_id, plane, resource_row_id, broad_kind, subtype,
            projection_status, facet_json
     FROM memory_v2_candidate_facets WHERE candidate_id = ?`,
  ).get(candidateId) as FacetRow | undefined;
  assertFacetScope(row, {
    orgId: stored.org_id,
    projectId: stored.project_id,
    plane: stored.plane,
    resourceRowId,
  });
  if (row.broad_kind !== stored.kind
      || row.subtype !== projection.subtype
      || row.projection_status !== projection.projectionStatus) {
    throw new MemoryV2CanonicalWriteError("Canonical candidate facet classification is mismatched");
  }
  assertFacetJson(row.facet_json, {
    projection: nativeSubtype ? "v2_native" : "v1",
    source_plane: stored.plane,
  });
}

export function insertMemoryV2ReceiptFacet(input: {
  receiptId: string;
  producerRunId: string;
  orgId: string;
  projectId: string;
  plane: MemoryV2CanonicalPlane;
  resourceRowId: string;
  now: string;
}): void {
  assertResource(input);
  db.prepare(
    `INSERT INTO memory_v2_receipt_facets
       (receipt_id, org_id, project_id, plane, resource_row_id, facet_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.receiptId,
    input.orgId,
    input.projectId,
    input.plane,
    input.resourceRowId,
    JSON.stringify({ projection: "v1", producer_run_id: input.producerRunId }),
    input.now,
  );
}

export function assertMemoryV2StoredReceiptAggregateFacets(receiptId: string): void {
  const stored = db.prepare(
    `SELECT org_id, project_id, producer_run_id, request_digest,
            repository_row_id, producer_harness_id
     FROM memory_run_receipts WHERE receipt_id = ?`,
  ).get(receiptId) as {
    org_id: string;
    project_id: string;
    producer_run_id: string;
    request_digest: string;
    repository_row_id: string | null;
    producer_harness_id: string;
  } | undefined;
  if (!stored) throw new MemoryV2CanonicalWriteError("Canonical receipt is unavailable");
  const linkedCandidates = db.prepare(
    `SELECT link.candidate_id, candidate.plane
     FROM memory_receipt_candidates AS link
     INNER JOIN memory_candidates_v1 AS candidate ON candidate.candidate_id = link.candidate_id
     WHERE link.receipt_id = ?`,
  ).all(receiptId) as unknown as Array<{
    candidate_id: string;
    plane: MemoryV2CanonicalPlane | "org";
  }>;
  const internalOrgReceipt = stored.repository_row_id === null
    && linkedCandidates.length > 0
    && linkedCandidates.every((candidate) => candidate.plane === "org");
  if (internalOrgReceipt) {
    const facet = db.prepare(
      "SELECT 1 FROM memory_v2_receipt_facets WHERE receipt_id = ?",
    ).get(receiptId);
    const feedback = db.prepare(
      "SELECT 1 FROM memory_feedback WHERE receipt_id = ? LIMIT 1",
    ).get(receiptId);
    if (facet || feedback) {
      throw new MemoryV2CanonicalWriteError("Unsupported organization receipt must be quarantined");
    }
    assertMemoryV2StoredFacetQuarantine({
      aggregateType: "receipt",
      aggregateId: receiptId,
      aggregateVersion: 0,
      orgId: stored.org_id,
      projectId: stored.project_id,
      sourcePlane: "org",
      reasonCode: "unsupported_plane",
      sourceDigest: stored.request_digest,
    });
    for (const candidate of linkedCandidates) {
      assertMemoryV2StoredCandidateFacet(candidate.candidate_id);
    }
    return;
  }
  const plane: MemoryV2CanonicalPlane = stored.repository_row_id ? "codebase" : "harness";
  const resourceRowId = resourceRowIdForStoredAggregate({
    orgId: stored.org_id,
    projectId: stored.project_id,
    plane,
    repositoryRowId: stored.repository_row_id,
    harnessId: stored.producer_harness_id,
  });
  const row = db.prepare(
    `SELECT org_id, project_id, plane, resource_row_id, facet_json
     FROM memory_v2_receipt_facets WHERE receipt_id = ?`,
  ).get(receiptId) as FacetRow | undefined;
  assertFacetScope(row, {
    orgId: stored.org_id,
    projectId: stored.project_id,
    plane,
    resourceRowId,
  });
  assertFacetJson(row.facet_json, {
    projection: "v1",
    producer_run_id: stored.producer_run_id,
  });
  for (const candidate of linkedCandidates) assertMemoryV2StoredCandidateFacet(candidate.candidate_id);
  const feedbackRows = db.prepare(
    "SELECT feedback_id FROM memory_feedback WHERE receipt_id = ?",
  ).all(receiptId) as unknown as Array<{ feedback_id: string }>;
  for (const feedback of feedbackRows) assertMemoryV2StoredFeedbackFacet(feedback.feedback_id);
}

export function insertMemoryV2FeedbackFacet(input: {
  feedbackId: string;
  retrievalPackId: string;
  orgId: string;
  projectId: string;
  plane: MemoryV2CanonicalPlane;
  resourceRowId: string;
  now: string;
}): void {
  assertResource(input);
  db.prepare(
    `INSERT INTO memory_v2_feedback_facets
       (feedback_id, org_id, project_id, plane, resource_row_id, facet_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.feedbackId,
    input.orgId,
    input.projectId,
    input.plane,
    input.resourceRowId,
    JSON.stringify({ projection: "v1", retrieval_pack_id: input.retrievalPackId }),
    input.now,
  );
}

export function assertMemoryV2StoredFeedbackFacet(feedbackId: string): void {
  const stored = db.prepare(
    `SELECT feedback.org_id, feedback.project_id, feedback.retrieval_pack_id,
            pack.plane, pack.repository_row_id, pack.harness_id
     FROM memory_feedback AS feedback
     INNER JOIN memory_retrieval_packs AS pack
       ON pack.retrieval_pack_id = feedback.retrieval_pack_id
     WHERE feedback.feedback_id = ?`,
  ).get(feedbackId) as {
    org_id: string;
    project_id: string;
    retrieval_pack_id: string;
    plane: MemoryV2CanonicalPlane;
    repository_row_id: string | null;
    harness_id: string | null;
  } | undefined;
  if (!stored || !["codebase", "harness"].includes(stored.plane)) {
    throw new MemoryV2CanonicalWriteError("Canonical feedback is unavailable or unimplemented");
  }
  const resourceRowId = resourceRowIdForStoredAggregate({
    orgId: stored.org_id,
    projectId: stored.project_id,
    plane: stored.plane,
    repositoryRowId: stored.repository_row_id,
    harnessId: stored.harness_id,
  });
  const row = db.prepare(
    `SELECT org_id, project_id, plane, resource_row_id, facet_json
     FROM memory_v2_feedback_facets WHERE feedback_id = ?`,
  ).get(feedbackId) as FacetRow | undefined;
  assertFacetScope(row, {
    orgId: stored.org_id,
    projectId: stored.project_id,
    plane: stored.plane,
    resourceRowId,
  });
  assertFacetJson(row.facet_json, {
    projection: "v1",
    retrieval_pack_id: stored.retrieval_pack_id,
  });
}

export function insertMemoryV2FacetQuarantine(input: {
  quarantineRowId: string;
  aggregateType: FacetAggregateType;
  aggregateId: string;
  aggregateVersion: number;
  orgId: string;
  projectId: string;
  sourcePlane: FacetSourcePlane;
  reasonCode: FacetQuarantineReason;
  sourceDigest: string;
  now: string;
}): void {
  db.prepare(
    `INSERT INTO memory_v2_facet_quarantine
       (quarantine_row_id, aggregate_type, aggregate_id, aggregate_version,
        org_id, project_id, source_plane, reason_code, source_digest, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.quarantineRowId,
    input.aggregateType,
    input.aggregateId,
    input.aggregateVersion,
    input.orgId,
    input.projectId,
    input.sourcePlane,
    input.reasonCode,
    input.sourceDigest,
    input.now,
  );
}

export function assertMemoryV2StoredFacetQuarantine(input: {
  aggregateType: FacetAggregateType;
  aggregateId: string;
  aggregateVersion: number;
  orgId: string;
  projectId: string;
  sourcePlane: FacetSourcePlane;
  reasonCode: FacetQuarantineReason;
  sourceDigest: string;
}): void {
  const row = db.prepare(
    `SELECT org_id, project_id, source_plane, reason_code, source_digest
     FROM memory_v2_facet_quarantine
     WHERE aggregate_type = ? AND aggregate_id = ? AND aggregate_version = ?`,
  ).get(input.aggregateType, input.aggregateId, input.aggregateVersion) as {
    org_id: string;
    project_id: string;
    source_plane: FacetSourcePlane;
    reason_code: FacetQuarantineReason;
    source_digest: string;
  } | undefined;
  if (!row
      || row.org_id !== input.orgId
      || row.project_id !== input.projectId
      || row.source_plane !== input.sourcePlane
      || row.reason_code !== input.reasonCode
      || row.source_digest !== input.sourceDigest) {
    throw new MemoryV2CanonicalWriteError("Canonical companion quarantine is missing or mismatched");
  }
}
