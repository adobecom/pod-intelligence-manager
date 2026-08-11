import {
  canonicalJsonSha256,
  type HarnessRuntimeEvidenceHandleV2,
  type MemoryRuntimeOutcomeV2,
} from "@pim/shared";
import type { DatabaseSync } from "node:sqlite";
import db, { withImmediateTransaction } from "../db/connection.js";
import { recordMemoryMetric } from "./memory-metrics.js";
import type { MemoryV2ReverificationProviderResult } from "./memory-v2-reverification.js";
import type { AuthorizedMemoryV2ResourceContext } from "./memory-v2-request-authorization.js";

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const RUNTIME_SIGNAL_SOURCE = "memory_v2_review_signals" as const;

export interface RuntimeAttestationPrepareContext {
  orgId: string;
  projectId: string;
  resourceRowId: string;
  producerPrincipalId: string;
  producerRunId: string;
  evidenceRefId: string;
  clientCandidateIds: readonly string[];
}

export interface RuntimeAttestationCandidateBinding {
  clientCandidateId: string;
  candidateId: string;
}

export interface VerifiedRuntimeAttestation {
  providerIdentity: string;
  providerDomainKey: string;
  providerEventId: string;
  immutableDigest: string;
  occurredAt: string;
  verifiedAt: string;
  outcomeFingerprint: string;
  observationType: HarnessRuntimeEvidenceHandleV2["observation_type"];
  sourceAuthority: "observed" | "verified";
}

export type MemoryRuntimeAttestationVerifier = (input: {
  auth: RuntimeAttestationPrepareContext;
  handle: HarnessRuntimeEvidenceHandleV2;
  receivedAt: string;
}) => Promise<VerifiedRuntimeAttestation>;

export interface PreparedMemoryRuntimeAttestation {
  auth: RuntimeAttestationPrepareContext & { clientCandidateIds: readonly string[] };
  handle: HarnessRuntimeEvidenceHandleV2;
  verified: VerifiedRuntimeAttestation;
  preparationDigest: string;
  /** Request-start authority; present only for the native v2 receipt path. */
  authorizedResource?: AuthorizedMemoryV2ResourceContext;
}

export interface RuntimeReviewSignalRef {
  source: typeof RUNTIME_SIGNAL_SOURCE;
  signalId: string;
}

export interface RuntimeAttestationResolution {
  originId: string;
  effectiveRootOriginId: string | null;
  rootOriginIds: string[];
  corroborationDomainId: string;
  sourceAuthority: "observed" | "verified";
  requestDigest: string;
  duplicate: boolean;
  collapsedToExistingDomain: boolean;
  distinctCandidateDomainCount: number;
  reviewSignals: RuntimeReviewSignalRef[];
  activationEligible: false;
}

export interface StoredMemoryRuntimeReceiptEvidence {
  receiptId: string;
  producerRunId: string;
  evidenceRefId: string;
  originId: string;
  effectiveRootOriginId: string | null;
  rootOriginIds: string[];
  corroborationDomainId: string;
  requestDigest: string;
  sourceAuthority: "observed" | "verified";
  candidateBindings: RuntimeAttestationCandidateBinding[];
}

export interface MemoryV2CandidateRuntimeEvidence {
  candidateId: string;
  clientCandidateId: string;
  receiptId: string;
  producerRunId: string;
  evidenceRefId: string;
  originId: string;
  effectiveRootOriginId: string | null;
  rootOriginIds: string[];
  corroborationDomainId: string;
  requestDigest: string;
  immutableDigest: string;
  outcomeFingerprint: string;
  observationType: HarnessRuntimeEvidenceHandleV2["observation_type"];
  sourceAuthority: "observed" | "verified";
  occurredAt: string;
  verifiedAt: string;
}

export class MemoryRuntimeAttestationError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 403 | 409 | 422 | 503,
    readonly code:
      | "schema_invalid"
      | "resource_binding_mismatch"
      | "idempotency_conflict"
      | "evidence_mismatch"
      | "evidence_unresolvable"
      | "temporarily_unavailable",
  ) {
    super(message);
    this.name = "MemoryRuntimeAttestationError";
  }
}

interface OriginRow {
  origin_id: string;
  corroboration_domain_id: string;
  org_id: string;
  project_id: string;
  plane: "harness";
  resource_row_id: string;
  producer_principal_id: string;
  receipt_id: string;
  producer_run_id: string;
  evidence_ref_id: string;
  provider_identity: string;
  submitted_provider_event_id: string;
  provider_event_id: string;
  immutable_digest: string;
  request_digest: string;
  request_json: string;
  resolution_digest: string;
  resolution_json: string;
  candidate_set_digest: string;
  candidate_ids_json: string;
  client_candidate_ids_json: string;
  derivation_parent_refs_json: string;
  observation_type: HarnessRuntimeEvidenceHandleV2["observation_type"];
  outcome_fingerprint: string;
  outcome_json: string;
  source_authority: "observed" | "verified";
  effective_root_origin_id: string | null;
  root_set_digest: string;
  root_count: number;
  occurred_at: string;
  verified_at: string;
}

interface CanonicalEffect {
  body: Record<string, unknown>;
  json: string;
  digest: string;
  candidateIds: string[];
  clientCandidateIds: string[];
  candidateSetDigest: string;
}

function validTimestamp(value: string): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function boundedString(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function parseStringArray(raw: string): string[] {
  const value = JSON.parse(raw) as unknown;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return [];
  return value as string[];
}

function normalizeHandle(handle: HarnessRuntimeEvidenceHandleV2): HarnessRuntimeEvidenceHandleV2 {
  return {
    evidence_ref_id: handle.evidence_ref_id,
    handle_type: handle.handle_type,
    provider: handle.provider,
    provider_identity: null,
    provider_domain_key: null,
    provider_event_id: handle.provider_event_id,
    immutable_digest: handle.immutable_digest,
    producer_principal_id: null,
    effective_root_origin_id: null,
    corroboration_domain_id: null,
    observation_type: handle.observation_type,
    outcome: {
      status: handle.outcome.status,
      reason_code: handle.outcome.reason_code,
      verification_status: handle.outcome.verification_status,
      failure_fingerprint: handle.outcome.failure_fingerprint,
    },
    occurred_at: handle.occurred_at,
    verified_at: null,
    source_authority: null,
    derivation_parent_refs: [...handle.derivation_parent_refs],
  } as HarnessRuntimeEvidenceHandleV2;
}

function outcomeFingerprint(outcome: MemoryRuntimeOutcomeV2): string {
  return canonicalJsonSha256({
    status: outcome.status,
    reason_code: outcome.reason_code,
    verification_status: outcome.verification_status,
    failure_fingerprint: outcome.failure_fingerprint,
  });
}

function validatePrepareContext(auth: RuntimeAttestationPrepareContext): string[] {
  for (const [label, value, max] of [
    ["organization", auth.orgId, 256],
    ["project", auth.projectId, 256],
    ["resource", auth.resourceRowId, 512],
    ["producer principal", auth.producerPrincipalId, 128],
    ["producer run", auth.producerRunId, 256],
    ["evidence reference", auth.evidenceRefId, 128],
  ] as const) {
    if (!boundedString(value, 1, max)) {
      throw new MemoryRuntimeAttestationError(
        `Runtime attestation ${label} is invalid`,
        400,
        "schema_invalid",
      );
    }
  }
  if (auth.clientCandidateIds.length < 1 || auth.clientCandidateIds.length > 64
      || auth.clientCandidateIds.some((value) => !boundedString(value, 1, 128))) {
    throw new MemoryRuntimeAttestationError(
      "Runtime attestation candidate references are invalid",
      400,
      "schema_invalid",
    );
  }
  const normalized = sortedUnique(auth.clientCandidateIds);
  if (normalized.length !== auth.clientCandidateIds.length) {
    throw new MemoryRuntimeAttestationError(
      "Runtime attestation candidate references must be unique",
      400,
      "schema_invalid",
    );
  }
  return normalized;
}

function validateHandle(
  handle: HarnessRuntimeEvidenceHandleV2,
  auth: RuntimeAttestationPrepareContext,
): void {
  const parents = handle.derivation_parent_refs;
  if (handle.evidence_ref_id !== auth.evidenceRefId
      || !boundedString(handle.evidence_ref_id, 1, 128)
      || handle.provider !== "runtime_attestation"
      || !boundedString(handle.provider_event_id, 1, 128)
      || !SHA256_PATTERN.test(handle.immutable_digest)
      || !validTimestamp(handle.occurred_at)
      || handle.provider_identity !== null
      || handle.provider_domain_key !== null
      || handle.producer_principal_id !== null
      || handle.effective_root_origin_id !== null
      || handle.corroboration_domain_id !== null
      || handle.verified_at !== null
      || handle.source_authority !== null) {
    throw new MemoryRuntimeAttestationError(
      "Runtime attestation handle is invalid or attempts to declare server authority",
      400,
      "schema_invalid",
    );
  }
  if (!boundedString(handle.outcome.reason_code, 1, 128)
      || (handle.outcome.failure_fingerprint !== null
        && !boundedString(handle.outcome.failure_fingerprint, 1, 512))) {
    throw new MemoryRuntimeAttestationError(
      "Runtime attestation outcome is invalid",
      400,
      "schema_invalid",
    );
  }
  if (parents.length > 32
      || parents.some((value) => !boundedString(value, 1, 128))
      || sortedUnique(parents).length !== parents.length) {
    throw new MemoryRuntimeAttestationError(
      "Runtime attestation derivation parents are invalid",
      400,
      "schema_invalid",
    );
  }
  const isRoot = handle.handle_type === "root_origin" && handle.observation_type === "root";
  const isDerivation = handle.handle_type === "derivation";
  if ((!isRoot && !isDerivation) || (isRoot && parents.length !== 0)) {
    throw new MemoryRuntimeAttestationError(
      "Runtime attestation handle and observation type do not match",
      422,
      "evidence_mismatch",
    );
  }
  if (isDerivation && parents.length === 0) {
    throw new MemoryRuntimeAttestationError(
      "Derived runtime evidence requires a receipt-local parent",
      422,
      "evidence_unresolvable",
    );
  }
}

/** Receipt-level identity/order validation that JSON Schema uniqueItems cannot express. */
export function assertMemoryRuntimeEvidenceHandleSet(
  handles: readonly HarnessRuntimeEvidenceHandleV2[],
): void {
  if (handles.length < 1 || handles.length > 128) {
    throw new MemoryRuntimeAttestationError(
      "A harness receipt must carry between one and 128 runtime evidence handles",
      400,
      "schema_invalid",
    );
  }
  const seen = new Set<string>();
  for (const handle of handles) {
    if (seen.has(handle.evidence_ref_id)) {
      throw new MemoryRuntimeAttestationError(
        "Runtime receipt evidence_ref_id values must be unique",
        400,
        "schema_invalid",
      );
    }
    for (const parentRef of handle.derivation_parent_refs) {
      if (!seen.has(parentRef)) {
        throw new MemoryRuntimeAttestationError(
          "Runtime derivation parents must refer to earlier receipt-local evidence handles",
          422,
          "evidence_unresolvable",
        );
      }
    }
    seen.add(handle.evidence_ref_id);
  }
}

function assertPrepareScope(
  auth: RuntimeAttestationPrepareContext,
  authorizedResource?: AuthorizedMemoryV2ResourceContext,
): void {
  if (authorizedResource) {
    if (authorizedResource.operation !== "receipt_write"
        || authorizedResource.resource.plane !== "harness"
        || authorizedResource.resource.resourceType !== "harness"
        || authorizedResource.source.kind !== "harness"
        || authorizedResource.principal.orgId !== auth.orgId
        || authorizedResource.principal.projectId !== auth.projectId
        || authorizedResource.principal.servicePrincipalId !== auth.producerPrincipalId
        || authorizedResource.resource.resourceRowId !== auth.resourceRowId) {
      throw new MemoryRuntimeAttestationError(
        "Runtime attestation does not match the authorized harness context",
        403,
        "resource_binding_mismatch",
      );
    }
    return;
  }
  const row = db.prepare(
    `SELECT 1
     FROM memory_v2_resources AS resource
     JOIN service_principals AS principal
       ON principal.service_principal_id = ?
     JOIN memory_harness_principal_bindings AS harness_binding
       ON harness_binding.service_principal_id = principal.service_principal_id
      AND harness_binding.org_id = resource.org_id
      AND harness_binding.project_id = resource.project_id
      AND harness_binding.harness_id = resource.canonical_resource_id
     WHERE resource.resource_row_id = ?
       AND resource.org_id = ? AND resource.project_id = ?
       AND resource.plane = 'harness' AND resource.resource_type = 'harness'
       AND resource.valid_until IS NULL
       AND principal.org_id = ? AND principal.disabled_at IS NULL`,
  ).get(
    auth.producerPrincipalId,
    auth.resourceRowId,
    auth.orgId,
    auth.projectId,
    auth.orgId,
  );
  if (!row) {
    throw new MemoryRuntimeAttestationError(
      "Runtime attestation is outside the authenticated harness binding",
      403,
      "resource_binding_mismatch",
    );
  }
}

async function authenticatedRuntimeVerifier(input: {
  auth: RuntimeAttestationPrepareContext;
  handle: HarnessRuntimeEvidenceHandleV2;
  receivedAt: string;
}): Promise<VerifiedRuntimeAttestation> {
  return {
    providerIdentity: `service_principal:${input.auth.producerPrincipalId}`,
    providerDomainKey: `service_principal:${input.auth.producerPrincipalId}`,
    providerEventId: input.handle.provider_event_id,
    immutableDigest: input.handle.immutable_digest,
    occurredAt: input.handle.occurred_at,
    verifiedAt: input.receivedAt,
    outcomeFingerprint: outcomeFingerprint(input.handle.outcome),
    observationType: input.handle.observation_type,
    sourceAuthority: "observed",
  };
}

let runtimeVerifier: MemoryRuntimeAttestationVerifier = authenticatedRuntimeVerifier;

/** Test/provider seam for the one concrete runtime-attestation resolver. */
export function setMemoryRuntimeAttestationVerifier(
  verifier: MemoryRuntimeAttestationVerifier | null,
): void {
  runtimeVerifier = verifier ?? authenticatedRuntimeVerifier;
}

function validateVerified(
  verified: VerifiedRuntimeAttestation,
  handle: HarnessRuntimeEvidenceHandleV2,
): void {
  if (!boundedString(verified.providerIdentity, 1, 256)
      || !boundedString(verified.providerDomainKey, 1, 256)
      || !boundedString(verified.providerEventId, 1, 256)
      || !SHA256_PATTERN.test(verified.immutableDigest)
      || !SHA256_PATTERN.test(verified.outcomeFingerprint)
      || !validTimestamp(verified.occurredAt)
      || !validTimestamp(verified.verifiedAt)
      || !["observed", "verified"].includes(verified.sourceAuthority)) {
    throw new MemoryRuntimeAttestationError(
      "Runtime provider returned an invalid bounded attestation",
      503,
      "temporarily_unavailable",
    );
  }
  if (verified.providerEventId !== handle.provider_event_id
      || verified.immutableDigest !== handle.immutable_digest
      || verified.occurredAt !== handle.occurred_at
      || verified.observationType !== handle.observation_type
      || verified.outcomeFingerprint !== outcomeFingerprint(handle.outcome)) {
    throw new MemoryRuntimeAttestationError(
      "Runtime provider result does not match the submitted immutable handle",
      422,
      "evidence_mismatch",
    );
  }
}

function preparationBody(input: {
  auth: RuntimeAttestationPrepareContext & { clientCandidateIds: readonly string[] };
  handle: HarnessRuntimeEvidenceHandleV2;
  verified: VerifiedRuntimeAttestation;
}): Record<string, unknown> {
  return {
    schema_version: "pim.memory-runtime-attestation-prepared.v1",
    auth: input.auth,
    handle: input.handle,
    verified: input.verified,
  };
}

export async function prepareMemoryRuntimeAttestation(input: {
  auth: RuntimeAttestationPrepareContext;
  handle: HarnessRuntimeEvidenceHandleV2;
  authorizedResource?: AuthorizedMemoryV2ResourceContext;
  now?: string;
}): Promise<PreparedMemoryRuntimeAttestation> {
  const clientCandidateIds = validatePrepareContext(input.auth);
  validateHandle(input.handle, input.auth);
  assertPrepareScope(input.auth, input.authorizedResource);
  const now = input.now ?? new Date().toISOString();
  if (!validTimestamp(now)) {
    throw new MemoryRuntimeAttestationError("Resolver time is invalid", 400, "schema_invalid");
  }
  const auth = { ...input.auth, clientCandidateIds };
  const handle = normalizeHandle(input.handle);
  let verified: VerifiedRuntimeAttestation;
  try {
    verified = await runtimeVerifier({ auth, handle, receivedAt: now });
  } catch (error) {
    if (error instanceof MemoryRuntimeAttestationError) throw error;
    throw new MemoryRuntimeAttestationError(
      "Runtime attestation provider is unavailable",
      503,
      "temporarily_unavailable",
    );
  }
  validateVerified(verified, handle);
  return {
    auth,
    handle,
    verified: { ...verified },
    preparationDigest: canonicalJsonSha256(preparationBody({ auth, handle, verified })),
    ...(input.authorizedResource ? { authorizedResource: input.authorizedResource } : {}),
  };
}

function canonicalBindings(
  prepared: PreparedMemoryRuntimeAttestation,
  candidateBindings: readonly RuntimeAttestationCandidateBinding[],
): RuntimeAttestationCandidateBinding[] {
  if (candidateBindings.length < 1 || candidateBindings.length > 64) {
    throw new MemoryRuntimeAttestationError(
      "Runtime attestation candidate binding is invalid",
      422,
      "evidence_mismatch",
    );
  }
  const normalized = candidateBindings.map((binding) => ({ ...binding })).sort((left, right) => (
    left.clientCandidateId.localeCompare(right.clientCandidateId)
      || left.candidateId.localeCompare(right.candidateId)
  ));
  if (normalized.some((binding) => (
    !boundedString(binding.clientCandidateId, 1, 128)
      || !boundedString(binding.candidateId, 1, 128)
  ))
      || sortedUnique(normalized.map((binding) => binding.clientCandidateId)).length !== normalized.length
      || sortedUnique(normalized.map((binding) => binding.candidateId)).length !== normalized.length
      || JSON.stringify(normalized.map((binding) => binding.clientCandidateId))
        !== JSON.stringify(prepared.auth.clientCandidateIds)) {
    throw new MemoryRuntimeAttestationError(
      "Runtime attestation candidate binding does not match the prepared receipt handle",
      422,
      "evidence_mismatch",
    );
  }
  return normalized;
}

function canonicalEffect(input: {
  prepared: PreparedMemoryRuntimeAttestation;
  receiptId: string;
  candidateBindings: readonly RuntimeAttestationCandidateBinding[];
}): CanonicalEffect {
  const bindings = canonicalBindings(input.prepared, input.candidateBindings);
  const candidateIds = bindings.map((binding) => binding.candidateId);
  const clientCandidateIds = bindings.map((binding) => binding.clientCandidateId);
  const body = {
    schema_version: "pim.memory-runtime-origin-effect.v1",
    organization_id: input.prepared.auth.orgId,
    project_id: input.prepared.auth.projectId,
    resource_row_id: input.prepared.auth.resourceRowId,
    producer_principal_id: input.prepared.auth.producerPrincipalId,
    producer_run_id: input.prepared.auth.producerRunId,
    receipt_id: input.receiptId,
    evidence_ref_id: input.prepared.auth.evidenceRefId,
    candidate_bindings: bindings,
    handle: input.prepared.handle,
  };
  return {
    body,
    json: JSON.stringify(body),
    digest: canonicalJsonSha256(body),
    candidateIds,
    clientCandidateIds,
    candidateSetDigest: canonicalJsonSha256(bindings),
  };
}

function resolutionBody(verified: VerifiedRuntimeAttestation): Record<string, unknown> {
  return {
    schema_version: "pim.memory-runtime-provider-resolution.v1",
    provider: "runtime_attestation",
    provider_identity: verified.providerIdentity,
    provider_domain_key: verified.providerDomainKey,
    provider_event_id: verified.providerEventId,
    immutable_digest: verified.immutableDigest,
    occurred_at: verified.occurredAt,
    verified_at: verified.verifiedAt,
    outcome_fingerprint: verified.outcomeFingerprint,
    observation_type: verified.observationType,
    source_authority: verified.sourceAuthority,
  };
}

function assertPersistScope(input: {
  prepared: PreparedMemoryRuntimeAttestation;
  receiptId: string;
  candidateBindings: readonly RuntimeAttestationCandidateBinding[];
}): void {
  assertPrepareScope(input.prepared.auth, input.prepared.authorizedResource);
  const auth = input.prepared.auth;
  const receipt = db.prepare(
    `SELECT 1
     FROM memory_run_receipts AS receipt
     JOIN memory_v2_receipt_facets AS receipt_facet
       ON receipt_facet.receipt_id = receipt.receipt_id
     JOIN memory_v2_scope_snapshots AS snapshot
       ON snapshot.receipt_id = receipt.receipt_id
     WHERE receipt.receipt_id = ?
       AND receipt.org_id = ? AND receipt.project_id = ?
       AND receipt.producer_run_id = ?
       AND receipt_facet.org_id = receipt.org_id
       AND receipt_facet.project_id = receipt.project_id
       AND receipt_facet.plane = 'harness'
       AND receipt_facet.resource_row_id = ?
       AND snapshot.org_id = receipt.org_id
       AND snapshot.project_id = receipt.project_id
       AND snapshot.plane = 'harness'
       AND snapshot.resource_row_id = ?
       AND snapshot.producer_principal_id = ?
       AND snapshot.producer_run_id = receipt.producer_run_id`,
  ).get(
    input.receiptId,
    auth.orgId,
    auth.projectId,
    auth.producerRunId,
    auth.resourceRowId,
    auth.resourceRowId,
    auth.producerPrincipalId,
  );
  if (!receipt) {
    throw new MemoryRuntimeAttestationError(
      "Runtime attestation receipt is outside the authenticated harness binding",
      403,
      "resource_binding_mismatch",
    );
  }
  const candidate = db.prepare(
    `SELECT 1
     FROM memory_candidates_v1 AS candidate
     JOIN memory_v2_candidate_facets AS facet
       ON facet.candidate_id = candidate.candidate_id
     WHERE candidate.candidate_id = ? AND candidate.client_candidate_id = ?
       AND candidate.receipt_id = ?
       AND candidate.org_id = ? AND candidate.project_id = ?
       AND candidate.plane = 'harness'
       AND facet.org_id = candidate.org_id
       AND facet.project_id = candidate.project_id
       AND facet.plane = 'harness'
       AND facet.resource_row_id = ?
       AND facet.projection_status = 'mapped'`,
  );
  for (const binding of input.candidateBindings) {
    if (!candidate.get(
      binding.candidateId,
      binding.clientCandidateId,
      input.receiptId,
      auth.orgId,
      auth.projectId,
      auth.resourceRowId,
    )) {
      throw new MemoryRuntimeAttestationError(
        "Runtime attestation candidate is outside the receipt-local harness binding",
        403,
        "resource_binding_mismatch",
      );
    }
  }
}

function hasFinalizedReceiptClaim(input: {
  prepared: PreparedMemoryRuntimeAttestation;
  receiptId: string;
}): boolean {
  const auth = input.prepared.auth;
  return Boolean(db.prepare(
    `SELECT 1 FROM memory_idempotency_keys
     WHERE org_id = ? AND project_id = ?
       AND operation = 'memory_run_receipt_v2'
       AND response_resource_type = 'memory_v2_scope_snapshot'
       AND response_resource_id = ?`,
  ).get(auth.orgId, auth.projectId, input.receiptId));
}

function assertPreparedIntegrity(prepared: PreparedMemoryRuntimeAttestation): void {
  const expected = canonicalJsonSha256(preparationBody({
    auth: prepared.auth,
    handle: prepared.handle,
    verified: prepared.verified,
  }));
  if (expected !== prepared.preparationDigest) {
    throw new MemoryRuntimeAttestationError(
      "Prepared runtime attestation was mutated after verification",
      409,
      "evidence_mismatch",
    );
  }
  validateHandle(prepared.handle, prepared.auth);
  validateVerified(prepared.verified, prepared.handle);
}

function ensureTransaction(): void {
  if (db.isTransaction !== true) {
    throw new TypeError(
      "persistPreparedMemoryRuntimeAttestationInTransaction requires an active database transaction",
    );
  }
}

function domainFor(prepared: PreparedMemoryRuntimeAttestation, now: string): {
  domainId: string;
  prior: boolean;
} {
  const auth = prepared.auth;
  const domainBody = {
    schema_version: "pim.memory-v2-corroboration-domain.v1",
    org_id: auth.orgId,
    project_id: auth.projectId,
    plane: "harness",
    resource_row_id: auth.resourceRowId,
    producer_principal_id: auth.producerPrincipalId,
    provider: "runtime_attestation",
    provider_domain_key: prepared.verified.providerDomainKey,
  };
  const domainDigest = canonicalJsonSha256(domainBody);
  const domainId = `corroboration_domain_${domainDigest.slice("sha256:".length, 47)}`;
  const prior = db.prepare(
    `SELECT corroboration_domain_id, domain_digest
     FROM memory_v2_corroboration_domains
     WHERE org_id = ? AND project_id = ? AND plane = 'harness'
       AND resource_row_id = ? AND producer_principal_id = ?
       AND provider = 'runtime_attestation' AND provider_domain_key = ?`,
  ).get(
    auth.orgId,
    auth.projectId,
    auth.resourceRowId,
    auth.producerPrincipalId,
    prepared.verified.providerDomainKey,
  ) as { corroboration_domain_id: string; domain_digest: string } | undefined;
  db.prepare(
    `INSERT OR IGNORE INTO memory_v2_corroboration_domains
       (corroboration_domain_id, org_id, project_id, plane, resource_row_id,
        producer_principal_id, provider, provider_domain_key, domain_digest, created_at)
     VALUES (?, ?, ?, 'harness', ?, ?, 'runtime_attestation', ?, ?, ?)`,
  ).run(
    domainId,
    auth.orgId,
    auth.projectId,
    auth.resourceRowId,
    auth.producerPrincipalId,
    prepared.verified.providerDomainKey,
    domainDigest,
    now,
  );
  const stored = db.prepare(
    `SELECT corroboration_domain_id, domain_digest
     FROM memory_v2_corroboration_domains
     WHERE org_id = ? AND project_id = ? AND plane = 'harness'
       AND resource_row_id = ? AND producer_principal_id = ?
       AND provider = 'runtime_attestation' AND provider_domain_key = ?`,
  ).get(
    auth.orgId,
    auth.projectId,
    auth.resourceRowId,
    auth.producerPrincipalId,
    prepared.verified.providerDomainKey,
  ) as { corroboration_domain_id: string; domain_digest: string } | undefined;
  if (!stored || stored.corroboration_domain_id !== domainId || stored.domain_digest !== domainDigest) {
    throw new MemoryRuntimeAttestationError(
      "Runtime authority domain does not reconcile",
      409,
      "evidence_mismatch",
    );
  }
  return { domainId, prior: Boolean(prior) };
}

function originRoots(originId: string): string[] {
  return (db.prepare(
    `SELECT root_origin_id FROM memory_v2_origin_roots
     WHERE origin_id = ? ORDER BY root_origin_id`,
  ).all(originId) as unknown as Array<{ root_origin_id: string }>)
    .map((row) => row.root_origin_id);
}

function candidateBindingsForOrigin(originId: string): RuntimeAttestationCandidateBinding[] {
  return (db.prepare(
    `SELECT client_candidate_id, candidate_id
     FROM memory_v2_candidate_origins
     WHERE origin_id = ? ORDER BY client_candidate_id, candidate_id`,
  ).all(originId) as unknown as Array<{
    client_candidate_id: string;
    candidate_id: string;
  }>).map((row) => ({
    clientCandidateId: row.client_candidate_id,
    candidateId: row.candidate_id,
  }));
}

function reviewSignalsForOrigin(originId: string): RuntimeReviewSignalRef[] {
  return (db.prepare(
    `SELECT signal_id FROM memory_v2_review_signals
     WHERE repeated_origin_id = ? ORDER BY signal_id`,
  ).all(originId) as unknown as Array<{ signal_id: string }>).map((row) => ({
    source: RUNTIME_SIGNAL_SOURCE,
    signalId: row.signal_id,
  }));
}

function distinctCandidateDomains(candidateIds: readonly string[]): number {
  const marks = candidateIds.map(() => "?").join(",");
  const row = db.prepare(
    `SELECT COUNT(DISTINCT corroboration_domain_id) AS count
     FROM memory_v2_candidate_origins WHERE candidate_id IN (${marks})`,
  ).get(...candidateIds) as { count: number };
  return Number(row.count);
}

function storedOriginForProviderEvent(prepared: PreparedMemoryRuntimeAttestation): OriginRow | undefined {
  return db.prepare(
    `SELECT * FROM memory_v2_origins
     WHERE org_id = ? AND provider = 'runtime_attestation'
       AND provider_identity = ? AND provider_event_id = ?`,
  ).get(
    prepared.auth.orgId,
    prepared.verified.providerIdentity,
    prepared.verified.providerEventId,
  ) as OriginRow | undefined;
}

function replayOrConflict(input: {
  existing: OriginRow;
  prepared: PreparedMemoryRuntimeAttestation;
  receiptId: string;
  effect: CanonicalEffect;
  resolutionDigest: string;
  resolutionJson: string;
  candidateBindings: readonly RuntimeAttestationCandidateBinding[];
}): RuntimeAttestationResolution {
  // A replay is read-only validation of the already-persisted effect. Corrupt
  // closure must fail closed here; it must never be treated as a repair path.
  assertOriginClosure(input.existing);
  const expectedBindings = canonicalBindings(input.prepared, input.candidateBindings);
  const roots = originRoots(input.existing.origin_id);
  const matches = input.existing.org_id === input.prepared.auth.orgId
    && input.existing.project_id === input.prepared.auth.projectId
    && input.existing.resource_row_id === input.prepared.auth.resourceRowId
    && input.existing.producer_principal_id === input.prepared.auth.producerPrincipalId
    && input.existing.receipt_id === input.receiptId
    && input.existing.producer_run_id === input.prepared.auth.producerRunId
    && input.existing.evidence_ref_id === input.prepared.auth.evidenceRefId
    && input.existing.immutable_digest === input.prepared.verified.immutableDigest
    && input.existing.request_digest === input.effect.digest
    && input.existing.request_json === input.effect.json
    && input.existing.resolution_digest === input.resolutionDigest
    && input.existing.resolution_json === input.resolutionJson
    && input.existing.candidate_set_digest === input.effect.candidateSetDigest
    && input.existing.candidate_ids_json === JSON.stringify(input.effect.candidateIds)
    && input.existing.client_candidate_ids_json === JSON.stringify(input.effect.clientCandidateIds)
    && input.existing.root_set_digest === canonicalJsonSha256(roots)
    && input.existing.root_count === roots.length
    && JSON.stringify(candidateBindingsForOrigin(input.existing.origin_id))
      === JSON.stringify(expectedBindings);
  if (!matches) {
    throw new MemoryRuntimeAttestationError(
      "Runtime provider event identity was reused with a different receipt effect",
      409,
      "idempotency_conflict",
    );
  }
  return {
    originId: input.existing.origin_id,
    effectiveRootOriginId: input.existing.effective_root_origin_id,
    rootOriginIds: roots,
    corroborationDomainId: input.existing.corroboration_domain_id,
    sourceAuthority: input.existing.source_authority,
    requestDigest: input.existing.request_digest,
    duplicate: true,
    collapsedToExistingDomain: true,
    distinctCandidateDomainCount: distinctCandidateDomains(input.effect.candidateIds),
    reviewSignals: reviewSignalsForOrigin(input.existing.origin_id),
    activationEligible: false,
  };
}

function resolveParents(input: {
  prepared: PreparedMemoryRuntimeAttestation;
  receiptId: string;
  domainId: string;
  parentOriginsByEvidenceRef: ReadonlyMap<string, string>;
}): Array<{ evidenceRefId: string; originId: string; rootIds: string[] }> {
  return input.prepared.handle.derivation_parent_refs.map((evidenceRefId) => {
    const originId = input.parentOriginsByEvidenceRef.get(evidenceRefId);
    if (!originId) {
      throw new MemoryRuntimeAttestationError(
        "Runtime derivation parent is not an earlier receipt-local evidence handle",
        422,
        "evidence_unresolvable",
      );
    }
    const parent = db.prepare(
      `SELECT origin_id, evidence_ref_id, receipt_id, corroboration_domain_id,
              org_id, project_id, resource_row_id, producer_principal_id,
              root_set_digest, root_count
       FROM memory_v2_origins WHERE origin_id = ?`,
    ).get(originId) as {
      origin_id: string;
      evidence_ref_id: string;
      receipt_id: string;
      corroboration_domain_id: string;
      org_id: string;
      project_id: string;
      resource_row_id: string;
      producer_principal_id: string;
      root_set_digest: string;
      root_count: number;
    } | undefined;
    const roots = parent ? originRoots(parent.origin_id) : [];
    const auth = input.prepared.auth;
    if (!parent
        || parent.evidence_ref_id !== evidenceRefId
        || parent.receipt_id !== input.receiptId
        || parent.corroboration_domain_id !== input.domainId
        || parent.org_id !== auth.orgId
        || parent.project_id !== auth.projectId
        || parent.resource_row_id !== auth.resourceRowId
        || parent.producer_principal_id !== auth.producerPrincipalId
        || roots.length < 1
        || roots.length !== parent.root_count
        || canonicalJsonSha256(roots) !== parent.root_set_digest) {
      throw new MemoryRuntimeAttestationError(
        "Runtime derivation parent is unavailable in the authenticated authority domain",
        422,
        "evidence_unresolvable",
      );
    }
    return { evidenceRefId, originId: parent.origin_id, rootIds: roots };
  });
}

function createReviewSignals(input: {
  prepared: PreparedMemoryRuntimeAttestation;
  originId: string;
  domainId: string;
  candidateIds: readonly string[];
  now: string;
}): RuntimeReviewSignalRef[] {
  if (input.prepared.verified.sourceAuthority !== "verified") return [];
  const auth = input.prepared.auth;
  const prior = db.prepare(
    `SELECT origin_id, corroboration_domain_id, producer_principal_id, producer_run_id
     FROM memory_v2_origins
     WHERE org_id = ? AND project_id = ? AND plane = 'harness'
       AND resource_row_id = ? AND source_authority = 'verified'
       AND outcome_fingerprint = ?
       AND corroboration_domain_id <> ?
       AND producer_principal_id <> ?
       AND producer_run_id <> ?
       AND origin_id <> ?
     ORDER BY occurred_at, origin_id LIMIT 1`,
  ).get(
    auth.orgId,
    auth.projectId,
    auth.resourceRowId,
    input.prepared.verified.outcomeFingerprint,
    input.domainId,
    auth.producerPrincipalId,
    auth.producerRunId,
    input.originId,
  ) as {
    origin_id: string;
    corroboration_domain_id: string;
    producer_principal_id: string;
    producer_run_id: string;
  } | undefined;
  if (!prior) return [];

  const refs: RuntimeReviewSignalRef[] = [];
  for (const candidateId of input.candidateIds) {
    const signalDigest = canonicalJsonSha256({
      schema_version: "pim.memory-runtime-review-signal.v1",
      resource_row_id: auth.resourceRowId,
      candidate_id: candidateId,
      outcome_fingerprint: input.prepared.verified.outcomeFingerprint,
      first_corroboration_domain_id: prior.corroboration_domain_id,
      repeated_corroboration_domain_id: input.domainId,
      first_producer_run_id: prior.producer_run_id,
      repeated_producer_run_id: auth.producerRunId,
      signal_type: "repeated_runtime_outcome",
    });
    const signalId = `review_signal_v2_runtime_${signalDigest.slice("sha256:".length, 43)}`;
    db.prepare(
      `INSERT OR IGNORE INTO memory_v2_review_signals
         (signal_id, org_id, project_id, plane, resource_row_id, candidate_id,
          first_corroboration_domain_id, repeated_corroboration_domain_id,
          first_origin_id, repeated_origin_id, first_producer_principal_id,
          repeated_producer_principal_id, first_producer_run_id, repeated_producer_run_id,
          outcome_fingerprint, signal_type, status, created_at, resolved_at,
          resolution_actor_id)
       VALUES (?, ?, ?, 'harness', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
               'repeated_runtime_outcome', 'open', ?, NULL, NULL)`,
    ).run(
      signalId,
      auth.orgId,
      auth.projectId,
      auth.resourceRowId,
      candidateId,
      prior.corroboration_domain_id,
      input.domainId,
      prior.origin_id,
      input.originId,
      prior.producer_principal_id,
      auth.producerPrincipalId,
      prior.producer_run_id,
      auth.producerRunId,
      input.prepared.verified.outcomeFingerprint,
      input.now,
    );
    const stored = db.prepare(
      `SELECT signal_id FROM memory_v2_review_signals
       WHERE org_id = ? AND project_id = ? AND resource_row_id = ?
         AND candidate_id = ? AND outcome_fingerprint = ?
         AND signal_type = 'repeated_runtime_outcome' AND status = 'open'`,
    ).get(
      auth.orgId,
      auth.projectId,
      auth.resourceRowId,
      candidateId,
      input.prepared.verified.outcomeFingerprint,
    ) as { signal_id: string } | undefined;
    if (stored) refs.push({ source: RUNTIME_SIGNAL_SOURCE, signalId: stored.signal_id });
  }
  return refs;
}

export function persistPreparedMemoryRuntimeAttestationInTransaction(input: {
  prepared: PreparedMemoryRuntimeAttestation;
  receiptId: string;
  candidateBindings: readonly RuntimeAttestationCandidateBinding[];
  parentOriginsByEvidenceRef: ReadonlyMap<string, string>;
  now?: string;
}): RuntimeAttestationResolution {
  ensureTransaction();
  assertPreparedIntegrity(input.prepared);
  if (!boundedString(input.receiptId, 1, 128)) {
    throw new MemoryRuntimeAttestationError("Runtime receipt identity is invalid", 400, "schema_invalid");
  }
  const now = input.now ?? input.prepared.verified.verifiedAt;
  if (!validTimestamp(now)) {
    throw new MemoryRuntimeAttestationError("Resolver time is invalid", 400, "schema_invalid");
  }
  const bindings = canonicalBindings(input.prepared, input.candidateBindings);
  assertPersistScope({ prepared: input.prepared, receiptId: input.receiptId, candidateBindings: bindings });
  const effect = canonicalEffect({
    prepared: input.prepared,
    receiptId: input.receiptId,
    candidateBindings: bindings,
  });
  const resolved = resolutionBody(input.prepared.verified);
  const resolutionJson = JSON.stringify(resolved);
  const resolutionDigest = canonicalJsonSha256(resolved);
  const existing = storedOriginForProviderEvent(input.prepared);
  if (existing) {
    return replayOrConflict({
      existing,
      prepared: input.prepared,
      receiptId: input.receiptId,
      effect,
      resolutionDigest,
      resolutionJson,
      candidateBindings: bindings,
    });
  }
  if (hasFinalizedReceiptClaim({ prepared: input.prepared, receiptId: input.receiptId })) {
    throw new MemoryRuntimeAttestationError(
      "Finalized harness receipt evidence cannot be extended",
      409,
      "idempotency_conflict",
    );
  }

  const domain = domainFor(input.prepared, now);
  const parents = resolveParents({
    prepared: input.prepared,
    receiptId: input.receiptId,
    domainId: domain.domainId,
    parentOriginsByEvidenceRef: input.parentOriginsByEvidenceRef,
  });
  const originDigest = canonicalJsonSha256({
    schema_version: "pim.memory-v2-origin.v1",
    corroboration_domain_id: domain.domainId,
    request_digest: effect.digest,
    resolution_digest: resolutionDigest,
  });
  const originId = `origin_v2_${originDigest.slice("sha256:".length, 47)}`;
  const rootIds = input.prepared.handle.observation_type === "root"
    ? [originId]
    : sortedUnique(parents.flatMap((parent) => parent.rootIds));
  if (rootIds.length < 1 || rootIds.length > 128) {
    throw new MemoryRuntimeAttestationError(
      "Runtime attestation derivation root set is unrepresentable",
      422,
      "evidence_unresolvable",
    );
  }
  const effectiveRootOriginId = rootIds.length === 1 ? rootIds[0]! : null;
  const rootSetDigest = canonicalJsonSha256(rootIds);
  const auth = input.prepared.auth;
  db.prepare(
    `INSERT INTO memory_v2_origins
       (origin_id, corroboration_domain_id, org_id, project_id, plane,
        resource_row_id, producer_principal_id, receipt_id, producer_run_id,
        evidence_ref_id, provider, provider_identity, submitted_provider_event_id,
        provider_event_id, immutable_digest, request_digest, request_json,
        resolution_digest, resolution_json, candidate_set_digest, candidate_ids_json,
        client_candidate_ids_json, derivation_parent_refs_json, observation_type,
        outcome_fingerprint, outcome_json, source_authority, effective_root_origin_id,
        root_set_digest, root_count, occurred_at, verified_at, created_at)
     VALUES (?, ?, ?, ?, 'harness', ?, ?, ?, ?, ?, 'runtime_attestation', ?, ?, ?, ?,
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    originId,
    domain.domainId,
    auth.orgId,
    auth.projectId,
    auth.resourceRowId,
    auth.producerPrincipalId,
    input.receiptId,
    auth.producerRunId,
    auth.evidenceRefId,
    input.prepared.verified.providerIdentity,
    input.prepared.handle.provider_event_id,
    input.prepared.verified.providerEventId,
    input.prepared.verified.immutableDigest,
    effect.digest,
    effect.json,
    resolutionDigest,
    resolutionJson,
    effect.candidateSetDigest,
    JSON.stringify(effect.candidateIds),
    JSON.stringify(effect.clientCandidateIds),
    JSON.stringify(input.prepared.handle.derivation_parent_refs),
    input.prepared.verified.observationType,
    input.prepared.verified.outcomeFingerprint,
    JSON.stringify(input.prepared.handle.outcome),
    input.prepared.verified.sourceAuthority,
    effectiveRootOriginId,
    rootSetDigest,
    rootIds.length,
    input.prepared.verified.occurredAt,
    input.prepared.verified.verifiedAt,
    now,
  );

  const insertDerivation = db.prepare(
    `INSERT INTO memory_v2_origin_derivations
       (origin_id, parent_origin_id, parent_evidence_ref_id,
        corroboration_domain_id, derivation_type, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const parent of parents) {
    insertDerivation.run(
      originId,
      parent.originId,
      parent.evidenceRefId,
      domain.domainId,
      input.prepared.verified.observationType,
      now,
    );
  }
  const insertRoot = db.prepare(
    `INSERT INTO memory_v2_origin_roots
       (origin_id, root_origin_id, corroboration_domain_id, created_at)
     VALUES (?, ?, ?, ?)`,
  );
  for (const rootId of rootIds) insertRoot.run(originId, rootId, domain.domainId, now);

  const insertCandidate = db.prepare(
    `INSERT INTO memory_v2_candidate_origins
       (candidate_id, client_candidate_id, origin_id, corroboration_domain_id,
        org_id, project_id, plane, resource_row_id, receipt_id, producer_run_id,
        evidence_ref_id, request_digest, linked_at)
     VALUES (?, ?, ?, ?, ?, ?, 'harness', ?, ?, ?, ?, ?, ?)`,
  );
  for (const binding of bindings) {
    insertCandidate.run(
      binding.candidateId,
      binding.clientCandidateId,
      originId,
      domain.domainId,
      auth.orgId,
      auth.projectId,
      auth.resourceRowId,
      input.receiptId,
      auth.producerRunId,
      auth.evidenceRefId,
      effect.digest,
      now,
    );
  }
  const reviewSignals = createReviewSignals({
    prepared: input.prepared,
    originId,
    domainId: domain.domainId,
    candidateIds: effect.candidateIds,
    now,
  });
  return {
    originId,
    effectiveRootOriginId,
    rootOriginIds: rootIds,
    corroborationDomainId: domain.domainId,
    sourceAuthority: input.prepared.verified.sourceAuthority,
    requestDigest: effect.digest,
    duplicate: false,
    collapsedToExistingDomain: domain.prior,
    distinctCandidateDomainCount: distinctCandidateDomains(effect.candidateIds),
    reviewSignals,
    activationEligible: false,
  };
}

/** Emit only after the caller's receipt transaction commits. */
export function recordMemoryRuntimeAttestationResolutionMetrics(
  resolution: RuntimeAttestationResolution,
): void {
  recordMemoryMetric({
    name: "RuntimeOriginDomainCount",
    value: resolution.distinctCandidateDomainCount,
    unit: "Count",
    dimensions: { plane: "harness", resource_type: "harness" },
  });
  if (resolution.duplicate || resolution.collapsedToExistingDomain) {
    recordMemoryMetric({
      name: "CollapsedRuntimeOriginObservationCount",
      value: 1,
      unit: "Count",
      dimensions: { plane: "harness", resource_type: "harness" },
    });
  }
  if (resolution.reviewSignals.length > 0) {
    recordMemoryMetric({
      name: "ReviewSignalCount",
      value: resolution.reviewSignals.length,
      unit: "Count",
      dimensions: {
        plane: "harness",
        signal_type: "repeated_runtime_outcome",
        signal_source: RUNTIME_SIGNAL_SOURCE,
      },
    });
  }
}

/** Convenience wrapper for non-receipt callers. Receipt intake must own the outer transaction. */
export async function resolveMemoryRuntimeAttestation(input: {
  auth: RuntimeAttestationPrepareContext;
  handle: HarnessRuntimeEvidenceHandleV2;
  receiptId: string;
  candidateBindings: readonly RuntimeAttestationCandidateBinding[];
  parentOriginsByEvidenceRef: ReadonlyMap<string, string>;
  now?: string;
}): Promise<RuntimeAttestationResolution> {
  const prepared = await prepareMemoryRuntimeAttestation({
    auth: input.auth,
    handle: input.handle,
    now: input.now,
  });
  const result = withImmediateTransaction(() => persistPreparedMemoryRuntimeAttestationInTransaction({
    prepared,
    receiptId: input.receiptId,
    candidateBindings: input.candidateBindings,
    parentOriginsByEvidenceRef: input.parentOriginsByEvidenceRef,
    now: input.now,
  }));
  recordMemoryRuntimeAttestationResolutionMetrics(result);
  return result;
}

function getOriginRow(originId: string): OriginRow | null {
  const row = db.prepare("SELECT * FROM memory_v2_origins WHERE origin_id = ?").get(originId) as
    | OriginRow
    | undefined;
  return row ?? null;
}

interface StoredResolutionBody {
  schema_version: "pim.memory-runtime-provider-resolution.v1";
  provider: "runtime_attestation";
  provider_identity: string;
  provider_domain_key: string;
  provider_event_id: string;
  immutable_digest: string;
  occurred_at: string;
  verified_at: string;
  outcome_fingerprint: string;
  observation_type: HarnessRuntimeEvidenceHandleV2["observation_type"];
  source_authority: "observed" | "verified";
}

function storedResolution(row: OriginRow): StoredResolutionBody {
  let value: unknown;
  try {
    value = JSON.parse(row.resolution_json) as unknown;
  } catch {
    value = null;
  }
  const resolution = value as Partial<StoredResolutionBody> | null;
  const domain = db.prepare(
    `SELECT provider_domain_key FROM memory_v2_corroboration_domains
     WHERE corroboration_domain_id = ?`,
  ).get(row.corroboration_domain_id) as { provider_domain_key: string } | undefined;
  if (!resolution
      || canonicalJsonSha256(resolution) !== row.resolution_digest
      || resolution.schema_version !== "pim.memory-runtime-provider-resolution.v1"
      || resolution.provider !== "runtime_attestation"
      || resolution.provider_identity !== row.provider_identity
      || resolution.provider_domain_key !== domain?.provider_domain_key
      || resolution.provider_event_id !== row.provider_event_id
      || resolution.immutable_digest !== row.immutable_digest
      || resolution.occurred_at !== row.occurred_at
      || resolution.verified_at !== row.verified_at
      || resolution.outcome_fingerprint !== row.outcome_fingerprint
      || resolution.observation_type !== row.observation_type
      || resolution.source_authority !== row.source_authority) {
    throw new MemoryRuntimeAttestationError(
      "Stored runtime provider resolution is inconsistent",
      503,
      "temporarily_unavailable",
    );
  }
  return resolution as StoredResolutionBody;
}

function storedRequestHandle(row: OriginRow): HarnessRuntimeEvidenceHandleV2 {
  let requestValue: unknown;
  let outcomeValue: unknown;
  try {
    requestValue = JSON.parse(row.request_json) as unknown;
    outcomeValue = JSON.parse(row.outcome_json) as unknown;
  } catch {
    requestValue = null;
    outcomeValue = null;
  }
  const request = requestValue as {
    schema_version?: unknown;
    organization_id?: unknown;
    project_id?: unknown;
    resource_row_id?: unknown;
    producer_principal_id?: unknown;
    producer_run_id?: unknown;
    receipt_id?: unknown;
    evidence_ref_id?: unknown;
    candidate_bindings?: unknown;
    handle?: unknown;
  } | null;
  const handle = request?.handle as HarnessRuntimeEvidenceHandleV2 | undefined;
  const candidates = candidateBindingsForOrigin(row.origin_id);
  if (!request || !handle
      || canonicalJsonSha256(request) !== row.request_digest
      || request.schema_version !== "pim.memory-runtime-origin-effect.v1"
      || request.organization_id !== row.org_id
      || request.project_id !== row.project_id
      || request.resource_row_id !== row.resource_row_id
      || request.producer_principal_id !== row.producer_principal_id
      || request.producer_run_id !== row.producer_run_id
      || request.receipt_id !== row.receipt_id
      || request.evidence_ref_id !== row.evidence_ref_id
      || JSON.stringify(request.candidate_bindings) !== JSON.stringify(candidates)
      || handle.evidence_ref_id !== row.evidence_ref_id
      || handle.provider !== "runtime_attestation"
      || handle.provider_event_id !== row.submitted_provider_event_id
      || row.submitted_provider_event_id !== row.provider_event_id
      || handle.immutable_digest !== row.immutable_digest
      || handle.observation_type !== row.observation_type
      || handle.occurred_at !== row.occurred_at
      || JSON.stringify(handle.derivation_parent_refs)
        !== row.derivation_parent_refs_json
      || JSON.stringify(handle.outcome) !== row.outcome_json
      || JSON.stringify(outcomeValue) !== row.outcome_json
      || canonicalJsonSha256(outcomeValue) !== row.outcome_fingerprint) {
    throw new MemoryRuntimeAttestationError(
      "Stored runtime request or outcome is inconsistent",
      503,
      "temporarily_unavailable",
    );
  }
  validateHandle(handle, {
    orgId: row.org_id,
    projectId: row.project_id,
    resourceRowId: row.resource_row_id,
    producerPrincipalId: row.producer_principal_id,
    producerRunId: row.producer_run_id,
    evidenceRefId: row.evidence_ref_id,
    clientCandidateIds: parseStringArray(row.client_candidate_ids_json),
  });
  return handle;
}

function assertOriginClosure(row: OriginRow): void {
  storedResolution(row);
  storedRequestHandle(row);
  const roots = originRoots(row.origin_id);
  const parents = db.prepare(
    `SELECT parent_evidence_ref_id, parent_origin_id
     FROM memory_v2_origin_derivations
     WHERE origin_id = ? ORDER BY parent_evidence_ref_id, parent_origin_id`,
  ).all(row.origin_id) as unknown as Array<{
    parent_evidence_ref_id: string;
    parent_origin_id: string;
  }>;
  const parentRefs = parseStringArray(row.derivation_parent_refs_json);
  const candidates = candidateBindingsForOrigin(row.origin_id);
  const storedCandidateIds = parseStringArray(row.candidate_ids_json);
  const storedClientIds = parseStringArray(row.client_candidate_ids_json);
  const expectedEffective = roots.length === 1 ? roots[0]! : null;
  const rootShapeOk = row.observation_type === "root"
    ? parents.length === 0 && parentRefs.length === 0 && roots.length === 1 && roots[0] === row.origin_id
    : parents.length > 0
      && JSON.stringify(parents.map((parent) => parent.parent_evidence_ref_id))
        === JSON.stringify([...parentRefs].sort((left, right) => left.localeCompare(right)));
  const expectedDerivedRoots = row.observation_type === "root"
    ? roots
    : sortedUnique(parents.flatMap((parent) => originRoots(parent.parent_origin_id)));
  if (!rootShapeOk
      || JSON.stringify(roots) !== JSON.stringify(expectedDerivedRoots)
      || roots.length !== row.root_count
      || roots.length < 1
      || canonicalJsonSha256(roots) !== row.root_set_digest
      || row.effective_root_origin_id !== expectedEffective
      || canonicalJsonSha256(candidates) !== row.candidate_set_digest
      || JSON.stringify(candidates.map((binding) => binding.candidateId))
        !== JSON.stringify(storedCandidateIds)
      || JSON.stringify(candidates.map((binding) => binding.clientCandidateId))
        !== JSON.stringify(storedClientIds)) {
    throw new MemoryRuntimeAttestationError(
      "Stored runtime origin closure is incomplete",
      503,
      "temporarily_unavailable",
    );
  }
}

export function getMemoryV2CandidateRuntimeEvidence(
  candidateId: string,
): MemoryV2CandidateRuntimeEvidence[] {
  const rows = db.prepare(
    `SELECT link.candidate_id, link.client_candidate_id, link.receipt_id,
            link.producer_run_id, link.evidence_ref_id, link.request_digest,
            origin.origin_id, origin.effective_root_origin_id,
            origin.corroboration_domain_id, origin.immutable_digest,
            origin.outcome_fingerprint, origin.observation_type,
            origin.source_authority, origin.occurred_at, origin.verified_at
     FROM memory_v2_candidate_origins AS link
     JOIN memory_v2_origins AS origin ON origin.origin_id = link.origin_id
     WHERE link.candidate_id = ?
     ORDER BY link.receipt_id, link.evidence_ref_id, origin.origin_id`,
  ).all(candidateId) as unknown as Array<{
    candidate_id: string;
    client_candidate_id: string;
    receipt_id: string;
    producer_run_id: string;
    evidence_ref_id: string;
    request_digest: string;
    origin_id: string;
    effective_root_origin_id: string | null;
    corroboration_domain_id: string;
    immutable_digest: string;
    outcome_fingerprint: string;
    observation_type: HarnessRuntimeEvidenceHandleV2["observation_type"];
    source_authority: "observed" | "verified";
    occurred_at: string;
    verified_at: string;
  }>;
  return rows.map((row) => {
    const origin = getOriginRow(row.origin_id);
    if (!origin) {
      throw new MemoryRuntimeAttestationError(
        "Stored runtime origin is unavailable",
        503,
        "temporarily_unavailable",
      );
    }
    assertOriginClosure(origin);
    return {
      candidateId: row.candidate_id,
      clientCandidateId: row.client_candidate_id,
      receiptId: row.receipt_id,
      producerRunId: row.producer_run_id,
      evidenceRefId: row.evidence_ref_id,
      originId: row.origin_id,
      effectiveRootOriginId: row.effective_root_origin_id,
      rootOriginIds: originRoots(row.origin_id),
      corroborationDomainId: row.corroboration_domain_id,
      requestDigest: row.request_digest,
      immutableDigest: row.immutable_digest,
      outcomeFingerprint: row.outcome_fingerprint,
      observationType: row.observation_type,
      sourceAuthority: row.source_authority,
      occurredAt: row.occurred_at,
      verifiedAt: row.verified_at,
    };
  });
}

export interface ReverifyMemoryV2RuntimeRecordInput {
  recordId: string;
  recordVersion: number;
  orgId: string;
  projectId: string;
  resourceRowId: string;
  attemptedAt: string;
}

interface RuntimeReverificationSourceRow {
  provenance_json: string;
  facet_subtype: string;
}

interface RuntimeReverificationCandidateRow {
  candidate_id: string;
  receipt_id: string;
  candidate_digest: string;
  candidate_json: string;
}

interface RuntimeReverificationScopeRow {
  scope_snapshot_json: string;
  scope_snapshot_digest: string;
}

function unavailableRuntimeReverification(
  errorCode: string,
): MemoryV2ReverificationProviderResult {
  return { outcome: "unavailable", errorCode };
}

function runtimeReverificationDigest(input: {
  outcome: "verified" | "contradicted" | "withdrawn";
  recordId: string;
  recordVersion: number;
  origins: readonly Record<string, unknown>[];
}): string {
  return canonicalJsonSha256({
    schema_version: "pim.memory-v2-runtime-reverification-evidence.v1",
    outcome: input.outcome,
    record_id: input.recordId,
    record_version: input.recordVersion,
    origins: input.origins,
  });
}

function storedRuntimeOriginSummary(row: OriginRow): Record<string, unknown> {
  return {
    origin_id: row.origin_id,
    corroboration_domain_id: row.corroboration_domain_id,
    provider_identity: row.provider_identity,
    provider_event_id: row.provider_event_id,
    immutable_digest: row.immutable_digest,
    outcome_fingerprint: row.outcome_fingerprint,
    observation_type: row.observation_type,
    source_authority: row.source_authority,
    occurred_at: row.occurred_at,
  };
}

/**
 * Re-run the concrete runtime verifier over the immutable native-v2 origin
 * closure that produced one active harness record. Only a digest of the
 * bounded provider comparison is returned to the worker.
 */
export async function reverifyMemoryV2RuntimeRecord(
  input: ReverifyMemoryV2RuntimeRecordInput,
): Promise<MemoryV2ReverificationProviderResult> {
  if (!validTimestamp(input.attemptedAt)) {
    return unavailableRuntimeReverification("runtime_reverification_time_invalid");
  }
  const source = db.prepare(
    `SELECT version.provenance_json, facet.subtype AS facet_subtype
     FROM memory_records AS record
     JOIN memory_record_versions AS version
       ON version.record_id = record.record_id AND version.record_version = ?
     JOIN memory_v2_record_facets AS facet
       ON facet.record_id = record.record_id AND facet.record_version = ?
     JOIN memory_v2_resources AS resource
       ON resource.resource_row_id = facet.resource_row_id
     WHERE record.record_id = ? AND record.current_version = ?
       AND record.current_status = 'active'
       AND record.org_id = ? AND record.project_id = ? AND record.plane = 'harness'
       AND facet.org_id = record.org_id AND facet.project_id = record.project_id
       AND facet.plane = 'harness' AND facet.resource_row_id = ?
       AND facet.projection_status = 'mapped' AND facet.subtype IS NOT NULL
       AND resource.org_id = record.org_id AND resource.project_id = record.project_id
       AND resource.plane = 'harness' AND resource.resource_type = 'harness'
       AND resource.source_authority = 'memory_harness_principal_bindings'
       AND resource.valid_until IS NULL`,
  ).get(
    input.recordVersion,
    input.recordVersion,
    input.recordId,
    input.recordVersion,
    input.orgId,
    input.projectId,
    input.resourceRowId,
  ) as RuntimeReverificationSourceRow | undefined;
  if (!source) {
    return unavailableRuntimeReverification("runtime_record_source_unavailable");
  }

  let candidateId: string | null = null;
  let originIds: string[] = [];
  let storedEvidenceDigest: string | null = null;
  let scopeSnapshotDigest: string | null = null;
  let scopeConfigurationDigest: string | null = null;
  let configurationDigests: string[] = [];
  let corroborationDomainIds: string[] = [];
  let distinctCorroborationDomainCount: number | null = null;
  let nativeSubtype: string | null = null;
  let projectionDigest: string | null = null;
  let nativeProvenancePresent = false;
  try {
    const provenance = JSON.parse(source.provenance_json) as Record<string, unknown>;
    nativeProvenancePresent = provenance.runtime_origin_ids !== undefined
      || provenance.runtime_evidence_digest !== undefined
      || provenance.v2_subtype !== undefined
      || provenance.v2_projection_digest !== undefined;
    candidateId = typeof provenance.candidate_id === "string"
      ? provenance.candidate_id
      : null;
    originIds = Array.isArray(provenance.runtime_origin_ids)
      && provenance.runtime_origin_ids.every((value) => typeof value === "string")
      ? provenance.runtime_origin_ids as string[]
      : [];
    storedEvidenceDigest = typeof provenance.runtime_evidence_digest === "string"
      ? provenance.runtime_evidence_digest
      : null;
    scopeSnapshotDigest = typeof provenance.scope_snapshot_digest === "string"
      ? provenance.scope_snapshot_digest
      : null;
    scopeConfigurationDigest = typeof provenance.v2_scope_configuration_digest === "string"
      ? provenance.v2_scope_configuration_digest
      : null;
    configurationDigests = Array.isArray(provenance.v2_configuration_digests)
      && provenance.v2_configuration_digests.every((value) => typeof value === "string")
      ? provenance.v2_configuration_digests as string[]
      : [];
    corroborationDomainIds = Array.isArray(provenance.v2_corroboration_domain_ids)
      && provenance.v2_corroboration_domain_ids.every((value) => typeof value === "string")
      ? provenance.v2_corroboration_domain_ids as string[]
      : [];
    distinctCorroborationDomainCount = Number.isSafeInteger(
      provenance.v2_distinct_corroboration_domain_count,
    ) ? provenance.v2_distinct_corroboration_domain_count as number : null;
    nativeSubtype = typeof provenance.v2_subtype === "string"
      ? provenance.v2_subtype
      : null;
    projectionDigest = typeof provenance.v2_projection_digest === "string"
      ? provenance.v2_projection_digest
      : null;
  } catch {
    return unavailableRuntimeReverification("runtime_record_provenance_invalid");
  }
  if (!nativeProvenancePresent) {
    return unavailableRuntimeReverification("runtime_native_provenance_unavailable");
  }
  const canonicalOriginIds = sortedUnique(originIds);
  if (!candidateId || canonicalOriginIds.length === 0
      || JSON.stringify(originIds) !== JSON.stringify(canonicalOriginIds)
      || !storedEvidenceDigest || !SHA256_PATTERN.test(storedEvidenceDigest)
      || !scopeSnapshotDigest || !SHA256_PATTERN.test(scopeSnapshotDigest)
      || !scopeConfigurationDigest || !SHA256_PATTERN.test(scopeConfigurationDigest)
      || JSON.stringify(configurationDigests) !== JSON.stringify(sortedUnique(configurationDigests))
      || JSON.stringify(corroborationDomainIds)
        !== JSON.stringify(sortedUnique(corroborationDomainIds))
      || distinctCorroborationDomainCount !== corroborationDomainIds.length
      || nativeSubtype !== source.facet_subtype
      || !projectionDigest || !SHA256_PATTERN.test(projectionDigest)) {
    return unavailableRuntimeReverification("runtime_record_provenance_invalid");
  }
  const candidate = db.prepare(
    `SELECT candidate_id, receipt_id, candidate_digest, candidate_json
     FROM memory_candidates_v1
     WHERE candidate_id = ? AND org_id = ? AND project_id = ? AND plane = 'harness'
       AND current_status = 'active' AND active_record_id = ?
       AND active_record_version = ?`,
  ).get(
    candidateId,
    input.orgId,
    input.projectId,
    input.recordId,
    input.recordVersion,
  ) as RuntimeReverificationCandidateRow | undefined;
  if (!candidate) {
    return unavailableRuntimeReverification("runtime_record_candidate_unavailable");
  }
  const scope = db.prepare(
    `SELECT scope_snapshot_json, scope_snapshot_digest
     FROM memory_v2_scope_snapshots
     WHERE receipt_id = ? AND org_id = ? AND project_id = ? AND plane = 'harness'
       AND resource_row_id = ? AND scope_snapshot_digest = ?`,
  ).get(
    candidate.receipt_id,
    input.orgId,
    input.projectId,
    input.resourceRowId,
    scopeSnapshotDigest,
  ) as RuntimeReverificationScopeRow | undefined;
  try {
    const candidateBody = JSON.parse(candidate.candidate_json) as {
      resource_row_id?: unknown;
      scope_snapshot_digest?: unknown;
      extensions?: Record<string, unknown>;
    };
    const scopeBody = scope
      ? JSON.parse(scope.scope_snapshot_json) as { configuration_digest?: unknown }
      : null;
    const extensions = candidateBody.extensions;
    const configurationSelectorDigest = extensions?.v2_configuration_selector_digest;
    const expectedConfigurationDigests = configurationSelectorDigest === null
      ? []
      : [scopeConfigurationDigest];
    if (!scope || canonicalJsonSha256(candidateBody) !== candidate.candidate_digest
        || candidateBody.resource_row_id !== input.resourceRowId
        || candidateBody.scope_snapshot_digest !== scopeSnapshotDigest
        || extensions?.v2_scope_snapshot_digest !== scopeSnapshotDigest
        || extensions.v2_configuration_digest !== scopeConfigurationDigest
        || (configurationSelectorDigest !== null
          && configurationSelectorDigest !== scopeConfigurationDigest)
        || JSON.stringify(configurationDigests) !== JSON.stringify(expectedConfigurationDigests)
        || scope.scope_snapshot_digest !== scopeSnapshotDigest
        || scopeBody?.configuration_digest !== scopeConfigurationDigest) {
      return unavailableRuntimeReverification("runtime_configuration_binding_invalid");
    }
  } catch {
    return unavailableRuntimeReverification("runtime_configuration_binding_invalid");
  }

  let evidence: MemoryV2CandidateRuntimeEvidence[];
  try {
    evidence = getMemoryV2CandidateRuntimeEvidence(candidateId);
  } catch {
    return unavailableRuntimeReverification("runtime_origin_closure_invalid");
  }
  const evidenceOriginIds = evidence.map((item) => item.originId).sort();
  const evidenceDigest = canonicalJsonSha256([...evidence]
    .sort((left, right) => (
      left.evidenceRefId.localeCompare(right.evidenceRefId)
      || left.originId.localeCompare(right.originId)
    ))
    .map((item) => ({
      evidence_ref_id: item.evidenceRefId,
      origin_id: item.originId,
      corroboration_domain_id: item.corroborationDomainId,
    })));
  if (JSON.stringify(evidenceOriginIds) !== JSON.stringify(canonicalOriginIds)
      || evidenceDigest !== storedEvidenceDigest
      || JSON.stringify(sortedUnique(evidence.map((item) => item.corroborationDomainId)))
        !== JSON.stringify(corroborationDomainIds)) {
    return unavailableRuntimeReverification("runtime_origin_closure_invalid");
  }

  const origins: OriginRow[] = [];
  for (const originId of canonicalOriginIds) {
    const row = getOriginRow(originId);
    if (!row || row.org_id !== input.orgId || row.project_id !== input.projectId
        || row.resource_row_id !== input.resourceRowId || row.plane !== "harness") {
      return unavailableRuntimeReverification("runtime_origin_closure_invalid");
    }
    try {
      assertOriginClosure(row);
    } catch {
      return unavailableRuntimeReverification("runtime_origin_closure_invalid");
    }
    origins.push(row);
  }

  const verifiedSummaries: Record<string, unknown>[] = [];
  let latestSourceOccurredAt = origins[0]!.occurred_at;
  for (const row of origins) {
    const clientCandidateIds = parseStringArray(row.client_candidate_ids_json);
    const auth: RuntimeAttestationPrepareContext = {
      orgId: row.org_id,
      projectId: row.project_id,
      resourceRowId: row.resource_row_id,
      producerPrincipalId: row.producer_principal_id,
      producerRunId: row.producer_run_id,
      evidenceRefId: row.evidence_ref_id,
      clientCandidateIds,
    };
    let handle: HarnessRuntimeEvidenceHandleV2;
    let prior: StoredResolutionBody;
    try {
      validatePrepareContext(auth);
      assertPrepareScope(auth);
      handle = storedRequestHandle(row);
      prior = storedResolution(row);
    } catch (error) {
      if (error instanceof MemoryRuntimeAttestationError
          && error.code === "resource_binding_mismatch") {
        return {
          outcome: "withdrawn",
          evidenceDigest: runtimeReverificationDigest({
            outcome: "withdrawn",
            recordId: input.recordId,
            recordVersion: input.recordVersion,
            origins: origins.map(storedRuntimeOriginSummary),
          }),
          sourceOccurredAt: input.attemptedAt,
          reasonCode: "runtime_authority_withdrawn",
        };
      }
      return unavailableRuntimeReverification("runtime_origin_closure_invalid");
    }

    let verified: VerifiedRuntimeAttestation;
    try {
      verified = await runtimeVerifier({ auth, handle, receivedAt: input.attemptedAt });
    } catch (error) {
      if (error instanceof MemoryRuntimeAttestationError
          && error.code === "resource_binding_mismatch") {
        return {
          outcome: "withdrawn",
          evidenceDigest: runtimeReverificationDigest({
            outcome: "withdrawn",
            recordId: input.recordId,
            recordVersion: input.recordVersion,
            origins: origins.map(storedRuntimeOriginSummary),
          }),
          sourceOccurredAt: input.attemptedAt,
          reasonCode: "runtime_authority_withdrawn",
        };
      }
      if (error instanceof MemoryRuntimeAttestationError
          && error.code === "evidence_mismatch") {
        return {
          outcome: "contradicted",
          evidenceDigest: runtimeReverificationDigest({
            outcome: "contradicted",
            recordId: input.recordId,
            recordVersion: input.recordVersion,
            origins: origins.map(storedRuntimeOriginSummary),
          }),
          sourceOccurredAt: input.attemptedAt,
          reasonCode: "runtime_authoritative_state_changed",
        };
      }
      return unavailableRuntimeReverification("runtime_provider_unavailable");
    }
    try {
      validateVerified(verified, handle);
    } catch (error) {
      if (error instanceof MemoryRuntimeAttestationError
          && error.code === "evidence_mismatch") {
        return {
          outcome: "contradicted",
          evidenceDigest: runtimeReverificationDigest({
            outcome: "contradicted",
            recordId: input.recordId,
            recordVersion: input.recordVersion,
            origins: [
              ...verifiedSummaries,
              { ...storedRuntimeOriginSummary(row), provider_result: "mismatched" },
            ],
          }),
          sourceOccurredAt: validTimestamp(verified.occurredAt)
            ? verified.occurredAt
            : input.attemptedAt,
          reasonCode: "runtime_authoritative_state_changed",
        };
      }
      return unavailableRuntimeReverification("runtime_provider_result_invalid");
    }
    if (verified.providerIdentity !== prior.provider_identity
        || verified.providerDomainKey !== prior.provider_domain_key
        || verified.providerEventId !== prior.provider_event_id
        || verified.immutableDigest !== prior.immutable_digest
        || verified.occurredAt !== prior.occurred_at
        || verified.outcomeFingerprint !== prior.outcome_fingerprint
        || verified.observationType !== prior.observation_type
        || verified.sourceAuthority !== prior.source_authority) {
      return {
        outcome: "contradicted",
        evidenceDigest: runtimeReverificationDigest({
          outcome: "contradicted",
          recordId: input.recordId,
          recordVersion: input.recordVersion,
          origins: [
            ...verifiedSummaries,
            { ...storedRuntimeOriginSummary(row), provider_result: "changed" },
          ],
        }),
        sourceOccurredAt: verified.occurredAt,
        reasonCode: "runtime_authoritative_state_changed",
      };
    }
    if (Date.parse(verified.occurredAt) > Date.parse(latestSourceOccurredAt)) {
      latestSourceOccurredAt = verified.occurredAt;
    }
    verifiedSummaries.push({
      ...storedRuntimeOriginSummary(row),
      provider_resolution_digest: canonicalJsonSha256({
        provider_identity: verified.providerIdentity,
        provider_domain_key: verified.providerDomainKey,
        provider_event_id: verified.providerEventId,
        immutable_digest: verified.immutableDigest,
        occurred_at: verified.occurredAt,
        outcome_fingerprint: verified.outcomeFingerprint,
        observation_type: verified.observationType,
        source_authority: verified.sourceAuthority,
      }),
    });
  }

  return {
    outcome: "verified",
    verifiedAt: input.attemptedAt,
    evidenceDigest: runtimeReverificationDigest({
      outcome: "verified",
      recordId: input.recordId,
      recordVersion: input.recordVersion,
      origins: verifiedSummaries,
    }),
    sourceOccurredAt: latestSourceOccurredAt,
  };
}

export function assertStoredMemoryRuntimeReceiptEvidence(input: {
  orgId: string;
  projectId: string;
  resourceRowId: string;
  producerPrincipalId: string;
  producerRunId: string;
  receiptId: string;
  handles: readonly HarnessRuntimeEvidenceHandleV2[];
  candidateBindingsByEvidenceRef: ReadonlyMap<
    string,
    readonly RuntimeAttestationCandidateBinding[]
  >;
}): StoredMemoryRuntimeReceiptEvidence[] {
  assertMemoryRuntimeEvidenceHandleSet(input.handles);
  const stored: StoredMemoryRuntimeReceiptEvidence[] = [];
  for (const handle of input.handles) {
    const bindings = input.candidateBindingsByEvidenceRef.get(handle.evidence_ref_id);
    if (!bindings || bindings.length === 0) {
      throw new MemoryRuntimeAttestationError(
        "Runtime receipt handle has no exact candidate association",
        409,
        "evidence_mismatch",
      );
    }
    const row = db.prepare(
      `SELECT * FROM memory_v2_origins
       WHERE receipt_id = ? AND evidence_ref_id = ?`,
    ).get(input.receiptId, handle.evidence_ref_id) as OriginRow | undefined;
    if (!row) {
      throw new MemoryRuntimeAttestationError(
        "Stored runtime receipt evidence is incomplete",
        503,
        "temporarily_unavailable",
      );
    }
    const auth: RuntimeAttestationPrepareContext & { clientCandidateIds: readonly string[] } = {
      orgId: input.orgId,
      projectId: input.projectId,
      resourceRowId: input.resourceRowId,
      producerPrincipalId: input.producerPrincipalId,
      producerRunId: input.producerRunId,
      evidenceRefId: handle.evidence_ref_id,
      clientCandidateIds: sortedUnique(bindings.map((binding) => binding.clientCandidateId)),
    };
    const resolution = storedResolution(row);
    const prepared = {
      auth,
      handle: normalizeHandle(handle),
      verified: {
        providerIdentity: resolution.provider_identity,
        providerDomainKey: resolution.provider_domain_key,
        providerEventId: resolution.provider_event_id,
        immutableDigest: resolution.immutable_digest,
        occurredAt: resolution.occurred_at,
        verifiedAt: resolution.verified_at,
        outcomeFingerprint: resolution.outcome_fingerprint,
        observationType: resolution.observation_type,
        sourceAuthority: resolution.source_authority,
      },
      preparationDigest: "",
    } satisfies PreparedMemoryRuntimeAttestation;
    const effect = canonicalEffect({
      prepared,
      receiptId: input.receiptId,
      candidateBindings: bindings,
    });
    if (row.org_id !== input.orgId
        || row.project_id !== input.projectId
        || row.resource_row_id !== input.resourceRowId
        || row.producer_principal_id !== input.producerPrincipalId
        || row.producer_run_id !== input.producerRunId
        || row.request_digest !== effect.digest
        || row.request_json !== effect.json
        || row.candidate_set_digest !== effect.candidateSetDigest
        || JSON.stringify(candidateBindingsForOrigin(row.origin_id))
          !== JSON.stringify(canonicalBindings(prepared, bindings))) {
      throw new MemoryRuntimeAttestationError(
        "Stored runtime receipt evidence does not match its submitted effect",
        409,
        "idempotency_conflict",
      );
    }
    assertOriginClosure(row);
    stored.push({
      receiptId: row.receipt_id,
      producerRunId: row.producer_run_id,
      evidenceRefId: row.evidence_ref_id,
      originId: row.origin_id,
      effectiveRootOriginId: row.effective_root_origin_id,
      rootOriginIds: originRoots(row.origin_id),
      corroborationDomainId: row.corroboration_domain_id,
      requestDigest: row.request_digest,
      sourceAuthority: row.source_authority,
      candidateBindings: candidateBindingsForOrigin(row.origin_id),
    });
  }
  const extra = db.prepare(
    `SELECT COUNT(*) AS count FROM memory_v2_origins WHERE receipt_id = ?`,
  ).get(input.receiptId) as { count: number };
  if (Number(extra.count) !== stored.length) {
    throw new MemoryRuntimeAttestationError(
      "Stored runtime receipt has unexpected evidence effects",
      409,
      "evidence_mismatch",
    );
  }
  return stored;
}

export interface MemoryV2RuntimeOriginReconciliation {
  domainCount: number;
  originCount: number;
  derivationCount: number;
  rootLinkCount: number;
  candidateLinkCount: number;
  reviewSignalCount: number;
  mismatchCount: number;
  foreignKeyViolationCount: number;
  ok: boolean;
}

export function reconcileMemoryV2RuntimeOrigins(
  database: DatabaseSync = db,
): MemoryV2RuntimeOriginReconciliation {
  const count = (table: string): number => Number((database.prepare(
    `SELECT COUNT(*) AS count FROM ${table}`,
  ).get() as { count: number }).count);
  const origins = database.prepare("SELECT * FROM memory_v2_origins ORDER BY origin_id")
    .all() as unknown as OriginRow[];
  let mismatchCount = 0;
  const domains = database.prepare(
    "SELECT * FROM memory_v2_corroboration_domains ORDER BY corroboration_domain_id",
  ).all() as unknown as Array<{
    corroboration_domain_id: string;
    org_id: string;
    project_id: string;
    plane: string;
    resource_row_id: string;
    producer_principal_id: string;
    provider: string;
    provider_domain_key: string;
    domain_digest: string;
  }>;
  for (const domain of domains) {
    const expectedDigest = canonicalJsonSha256({
      schema_version: "pim.memory-v2-corroboration-domain.v1",
      org_id: domain.org_id,
      project_id: domain.project_id,
      plane: "harness",
      resource_row_id: domain.resource_row_id,
      producer_principal_id: domain.producer_principal_id,
      provider: "runtime_attestation",
      provider_domain_key: domain.provider_domain_key,
    });
    const expectedId = `corroboration_domain_${expectedDigest.slice("sha256:".length, 47)}`;
    const originCount = Number((database.prepare(
      `SELECT COUNT(*) AS count FROM memory_v2_origins
       WHERE corroboration_domain_id = ?`,
    ).get(domain.corroboration_domain_id) as { count: number }).count);
    if (domain.plane !== "harness"
        || domain.provider !== "runtime_attestation"
        || domain.domain_digest !== expectedDigest
        || domain.corroboration_domain_id !== expectedId
        || originCount < 1) mismatchCount += 1;
  }
  for (const row of origins) {
    try {
      const roots = (database.prepare(
        `SELECT root_origin_id FROM memory_v2_origin_roots
         WHERE origin_id = ? ORDER BY root_origin_id`,
      ).all(row.origin_id) as unknown as Array<{ root_origin_id: string }>)
        .map((root) => root.root_origin_id);
      const candidates = database.prepare(
        `SELECT client_candidate_id, candidate_id
         FROM memory_v2_candidate_origins
         WHERE origin_id = ? ORDER BY client_candidate_id, candidate_id`,
      ).all(row.origin_id) as unknown as Array<{
        client_candidate_id: string;
        candidate_id: string;
      }>;
      const candidateBindings = candidates.map((candidate) => ({
        clientCandidateId: candidate.client_candidate_id,
        candidateId: candidate.candidate_id,
      }));
      const parentRefs = parseStringArray(row.derivation_parent_refs_json);
      const derivations = database.prepare(
        `SELECT parent_evidence_ref_id FROM memory_v2_origin_derivations
         WHERE origin_id = ? ORDER BY parent_evidence_ref_id`,
      ).all(row.origin_id) as unknown as Array<{ parent_evidence_ref_id: string }>;
      const rootShapeOk = row.observation_type === "root"
        ? roots.length === 1 && roots[0] === row.origin_id
          && parentRefs.length === 0 && derivations.length === 0
        : parentRefs.length > 0
          && JSON.stringify(derivations.map((item) => item.parent_evidence_ref_id))
            === JSON.stringify([...parentRefs].sort((left, right) => left.localeCompare(right)));
      const expectedResolution = JSON.parse(row.resolution_json) as unknown;
      const expectedRequest = JSON.parse(row.request_json) as unknown;
      const expectedOutcome = JSON.parse(row.outcome_json) as unknown;
      if (!rootShapeOk
          || canonicalJsonSha256(expectedRequest) !== row.request_digest
          || canonicalJsonSha256(expectedResolution) !== row.resolution_digest
          || canonicalJsonSha256(expectedOutcome) !== row.outcome_fingerprint
          || canonicalJsonSha256(roots) !== row.root_set_digest
          || roots.length !== row.root_count
          || row.effective_root_origin_id !== (roots.length === 1 ? roots[0]! : null)
          || canonicalJsonSha256(candidateBindings) !== row.candidate_set_digest
          || JSON.stringify(candidateBindings.map((binding) => binding.candidateId))
            !== row.candidate_ids_json
          || JSON.stringify(candidateBindings.map((binding) => binding.clientCandidateId))
            !== row.client_candidate_ids_json) mismatchCount += 1;
    } catch {
      mismatchCount += 1;
    }
  }
  const invalidSignals = Number((database.prepare(
    `SELECT COUNT(*) AS count
     FROM memory_v2_review_signals AS signal
     LEFT JOIN memory_v2_origins AS first_origin
       ON first_origin.origin_id = signal.first_origin_id
     LEFT JOIN memory_v2_origins AS repeated_origin
       ON repeated_origin.origin_id = signal.repeated_origin_id
     LEFT JOIN memory_v2_candidate_origins AS candidate_origin
       ON candidate_origin.origin_id = signal.repeated_origin_id
      AND candidate_origin.candidate_id = signal.candidate_id
     WHERE first_origin.origin_id IS NULL
        OR repeated_origin.origin_id IS NULL
        OR candidate_origin.origin_id IS NULL
        OR first_origin.source_authority <> 'verified'
        OR repeated_origin.source_authority <> 'verified'
        OR first_origin.corroboration_domain_id
          <> signal.first_corroboration_domain_id
        OR repeated_origin.corroboration_domain_id
          <> signal.repeated_corroboration_domain_id
        OR first_origin.corroboration_domain_id
          = repeated_origin.corroboration_domain_id
        OR first_origin.producer_principal_id
          <> signal.first_producer_principal_id
        OR repeated_origin.producer_principal_id
          <> signal.repeated_producer_principal_id
        OR first_origin.producer_principal_id
          = repeated_origin.producer_principal_id
        OR first_origin.producer_run_id <> signal.first_producer_run_id
        OR repeated_origin.producer_run_id <> signal.repeated_producer_run_id
        OR first_origin.producer_run_id = repeated_origin.producer_run_id
        OR first_origin.outcome_fingerprint <> signal.outcome_fingerprint
        OR repeated_origin.outcome_fingerprint <> signal.outcome_fingerprint`,
  ).get() as { count: number }).count);
  mismatchCount += invalidSignals;
  const relevantTables = new Set([
    "memory_v2_corroboration_domains",
    "memory_v2_origins",
    "memory_v2_origin_derivations",
    "memory_v2_origin_roots",
    "memory_v2_candidate_origins",
    "memory_v2_review_signals",
  ]);
  const foreignKeyRows = database.prepare("PRAGMA foreign_key_check").all() as unknown as Array<{
    table: string;
  }>;
  const foreignKeyViolationCount = foreignKeyRows
    .filter((row) => relevantTables.has(row.table)).length;
  return {
    domainCount: domains.length,
    originCount: origins.length,
    derivationCount: count("memory_v2_origin_derivations"),
    rootLinkCount: count("memory_v2_origin_roots"),
    candidateLinkCount: count("memory_v2_candidate_origins"),
    reviewSignalCount: count("memory_v2_review_signals"),
    mismatchCount,
    foreignKeyViolationCount,
    ok: mismatchCount === 0 && foreignKeyViolationCount === 0,
  };
}
