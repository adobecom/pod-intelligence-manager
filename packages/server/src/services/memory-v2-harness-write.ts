import { randomUUID } from "node:crypto";
import {
  canonicalJsonSha256,
  parseMemoryContract,
  parseMemoryContractV2,
  type HarnessRunReceiptCandidateV2,
  type HarnessRunReceiptV2,
  type HarnessRuntimeEvidenceHandleV2,
  type MemoryCandidateDecisionResultV2,
  type MemoryCandidateDecisionV2,
  type MemoryCandidateStatusV1,
  type MemoryCandidateStatusV2,
  type MemoryCandidateV1,
  type PimErrorV2,
  type ResourceBindingV2,
  type ResourceSelectorV2,
  type RunReceiptResultV2,
  type RunReceiptV1,
} from "@pim/shared";
import db from "../db/connection.js";
import { authorizeMemoryV2Resource } from "../middleware/service-authz.js";
import {
  MemoryDecisionError,
} from "./memory-decisions.js";
import {
  MemoryReceiptError,
} from "./memory-receipts.js";
import {
  memoryV2NativeHarnessCandidateProjectionDigest,
  MemoryV2CanonicalWriteError,
  type MemoryV2HarnessSubtype,
} from "./memory-v2-canonical-writes.js";
import {
  MEMORY_V2_SUBTYPE_KIND,
} from "./memory-v2-constants.js";
import {
  assertMemoryRuntimeEvidenceHandleSet,
  assertStoredMemoryRuntimeReceiptEvidence,
  MemoryRuntimeAttestationError,
  persistPreparedMemoryRuntimeAttestationInTransaction,
  prepareMemoryRuntimeAttestation,
  recordMemoryRuntimeAttestationResolutionMetrics,
  type PreparedMemoryRuntimeAttestation,
  type RuntimeAttestationCandidateBinding,
  type RuntimeAttestationResolution,
} from "./memory-v2-runtime-attestations.js";
import {
  beginMemoryV2ReceiptWrite,
  commitMemoryV2ReceiptWrite,
  decideAuthorizedMemoryV2Candidate,
  getMemoryV2AuthorizedCandidate,
  memoryV2CandidateStatusValue,
  memoryV2CandidateTransitionValue,
  memoryV2CanonicalValuesEqual,
  memoryV2ScopeSnapshotDigest,
  MemoryV2WriteCoreError,
  type MemoryV2ReceiptCandidateBinding,
  type MemoryV2ReplayVerificationInput,
} from "./memory-v2-write-core.js";
import type {
  AuthorizedMemoryV2ResourceContext,
  MemoryV2RequestAuthorizationSnapshot,
} from "./memory-v2-request-authorization.js";

type HarnessWriteErrorCode = PimErrorV2["code"];
type HarnessOperation = "receipt_write" | "candidate_read" | "review";

export interface MemoryV2HarnessWriteDependencies {
  /** Test-only failure seam; production adapters never supply it. */
  beforeScopeSnapshotInsert?: () => void;
  /** Test-only failure seam; production adapters never supply it. */
  beforeRuntimeEvidenceInsert?: () => void;
  /** Test-only failure seam; production adapters never supply it. */
  beforeFeedbackBindingInsert?: () => void;
}

export class MemoryV2HarnessWriteError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: HarnessWriteErrorCode,
    readonly details: Array<{ path: string; reason: string }> = [],
  ) {
    super(message);
    this.name = "MemoryV2HarnessWriteError";
  }
}

interface NormalizedHarnessReceipt {
  receipt: RunReceiptV1;
  subtypeByClientCandidateId: ReadonlyMap<string, MemoryV2HarnessSubtype>;
  clientCandidateIdsByEvidenceRef: ReadonlyMap<string, readonly string[]>;
  orderedHandles: readonly HarnessRuntimeEvidenceHandleV2[];
}

function requirePrincipal(
  principal: MemoryV2RequestAuthorizationSnapshot | null | undefined,
): MemoryV2RequestAuthorizationSnapshot & { projectId: string } {
  if (!principal) {
    throw new MemoryV2HarnessWriteError(
      "A PIM service-token principal is required",
      401,
      "authentication_required",
    );
  }
  if (!principal.projectId || principal.podId) {
    throw new MemoryV2HarnessWriteError(
      "A project-bound PIM service-token principal is required",
      403,
      "resource_binding_mismatch",
    );
  }
  return principal as MemoryV2RequestAuthorizationSnapshot & { projectId: string };
}

function mapHarnessWriteError(error: unknown): never {
  if (error instanceof MemoryV2HarnessWriteError) throw error;
  if (error instanceof MemoryV2WriteCoreError) {
    throw new MemoryV2HarnessWriteError(
      error.message,
      error.statusCode,
      error.code,
      error.details,
    );
  }
  if (error instanceof MemoryRuntimeAttestationError) {
    throw new MemoryV2HarnessWriteError(error.message, error.statusCode, error.code);
  }
  if (error instanceof MemoryReceiptError || error instanceof MemoryDecisionError) {
    throw new MemoryV2HarnessWriteError(
      error.message,
      error.statusCode,
      error.code,
      "details" in error && Array.isArray(error.details) ? error.details : [],
    );
  }
  if (error instanceof MemoryV2CanonicalWriteError) {
    throw new MemoryV2HarnessWriteError(error.message, 409, "idempotency_conflict");
  }
  throw error;
}

function operationBinding(input: {
  principal: MemoryV2RequestAuthorizationSnapshot | null | undefined;
  operation: HarnessOperation;
  selector: ResourceSelectorV2;
  projectId?: string;
}): {
  authorization: AuthorizedMemoryV2ResourceContext;
  principal: MemoryV2RequestAuthorizationSnapshot & { projectId: string };
  binding: ResourceBindingV2;
} {
  const principal = requirePrincipal(input.principal);
  if (input.projectId !== undefined && principal.projectId !== input.projectId) {
    throw new MemoryV2HarnessWriteError(
      "Request project is outside the authenticated service-token binding",
      403,
      "resource_binding_mismatch",
    );
  }
  const matches = principal.resources.filter((binding) => {
    if (binding.resource.plane !== "harness"
        || binding.resource.resourceType !== "harness") return false;
    if (input.selector === null) return true;
    return "resource_row_id" in input.selector
      ? binding.resourceRowId === input.selector.resource_row_id
      : binding.resource.canonicalResourceId === input.selector.canonical_resource_id;
  });
  if (matches.length !== 1) {
    throw new MemoryV2HarnessWriteError(
      input.selector === null
        ? "Exactly one authenticated harness resource is required"
        : "The selected harness resource is outside the authenticated binding",
      403,
      input.selector === null ? "scope_required" : "resource_binding_mismatch",
    );
  }
  const selected = matches[0]!;
  const authorization = authorizeMemoryV2Resource({
    principal,
    operation: input.operation,
    plane: "harness",
    projectId: principal.projectId,
    resourceRowId: selected.resourceRowId,
  });
  if (authorization.decision === "deny") {
    const scopeFailure = authorization.reason === "scope_missing"
      || authorization.reason === "operation_unavailable";
    throw new MemoryV2HarnessWriteError(
      "The authenticated principal cannot perform this harness memory operation",
      authorization.reason === "principal_unavailable" ? 401 : 403,
      scopeFailure ? "scope_required" : "resource_binding_mismatch",
    );
  }
  if (authorization.context.source.kind !== "harness") {
    throw new MemoryV2HarnessWriteError(
      "Authenticated harness source is unavailable",
      503,
      "temporarily_unavailable",
    );
  }
  return {
    authorization: authorization.context,
    principal,
    binding: {
      ...authorization.context.binding,
      permitted_operations: [...authorization.context.binding.permitted_operations],
    },
  };
}

function authorityFromAuthorization(
  authorization: AuthorizedMemoryV2ResourceContext,
  operation: HarnessOperation,
): ReturnType<typeof operationBinding> {
  if (authorization.operation !== operation
      || authorization.resource.plane !== "harness"
      || authorization.resource.resourceType !== "harness"
      || authorization.source.kind !== "harness"
      || !authorization.principal.projectId
      || authorization.principal.podId
      || authorization.binding.resource_row_id !== authorization.resource.resourceRowId) {
    throw new MemoryV2HarnessWriteError(
      "Authorized harness resource context is inconsistent",
      503,
      "temporarily_unavailable",
    );
  }
  return {
    authorization,
    principal: authorization.principal as MemoryV2RequestAuthorizationSnapshot & {
      projectId: string;
    },
    binding: {
      ...authorization.binding,
      permitted_operations: [...authorization.binding.permitted_operations],
    },
  };
}

export function authorizeHarnessMemoryV2Operation(input: {
  principal: MemoryV2RequestAuthorizationSnapshot | null | undefined;
  operation: HarnessOperation;
  selector: ResourceSelectorV2;
  projectId?: string;
}): AuthorizedMemoryV2ResourceContext {
  return operationBinding(input).authorization;
}

function representabilityError(path: string, reason: string): never {
  throw new MemoryV2HarnessWriteError(
    "Harness receipt cannot be represented by the canonical intake ledger",
    409,
    "activation_requirement_unsatisfied",
    [{ path, reason }],
  );
}

function evidenceError(path: string, reason: string): never {
  throw new MemoryV2HarnessWriteError(
    "Harness runtime evidence does not match its candidate",
    422,
    "evidence_mismatch",
    [{ path, reason }],
  );
}

function orderedRuntimeHandles(
  handles: readonly HarnessRuntimeEvidenceHandleV2[],
): HarnessRuntimeEvidenceHandleV2[] {
  const byRef = new Map<string, HarnessRuntimeEvidenceHandleV2>();
  const events = new Set<string>();
  for (const handle of handles) {
    if (byRef.has(handle.evidence_ref_id)) {
      evidenceError("/evidence_handles", "evidence_ref_id values must be unique");
    }
    if (events.has(handle.provider_event_id)) {
      evidenceError("/evidence_handles", "provider_event_id values must be unique per receipt");
    }
    byRef.set(handle.evidence_ref_id, handle);
    events.add(handle.provider_event_id);
  }
  const ordered: HarnessRuntimeEvidenceHandleV2[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (evidenceRefId: string): void => {
    if (visited.has(evidenceRefId)) return;
    if (visiting.has(evidenceRefId)) {
      evidenceError("/evidence_handles/derivation_parent_refs", "derivation graph contains a cycle");
    }
    const handle = byRef.get(evidenceRefId);
    if (!handle) {
      throw new MemoryV2HarnessWriteError(
        "Runtime derivation parent does not resolve within the receipt",
        422,
        "evidence_unresolvable",
        [{
          path: "/evidence_handles/derivation_parent_refs",
          reason: "derivation parent must resolve within the same receipt",
        }],
      );
    }
    visiting.add(evidenceRefId);
    for (const parent of handle.derivation_parent_refs) visit(parent);
    visiting.delete(evidenceRefId);
    visited.add(evidenceRefId);
    ordered.push(handle);
  };
  for (const ref of [...byRef.keys()].sort()) visit(ref);
  return ordered;
}

function assertStringListRepresentable(
  values: readonly string[],
  input: { path: string; maxItems: number; maxLength: number },
): void {
  if (values.length > input.maxItems) {
    representabilityError(input.path, `canonical limit is ${input.maxItems} items`);
  }
  if (values.some((value) => value.length > input.maxLength)) {
    representabilityError(input.path, `canonical item limit is ${input.maxLength} characters`);
  }
}

function v1Candidate(input: {
  candidate: HarnessRunReceiptCandidateV2;
  receipt: HarnessRunReceiptV2;
  producerRunId: string;
  binding: ResourceBindingV2;
  handlesByRef: ReadonlyMap<string, HarnessRuntimeEvidenceHandleV2>;
}): MemoryCandidateV1 {
  const { candidate, receipt, producerRunId, binding } = input;
  if (candidate.resource_row_id !== binding.resource_row_id
      || candidate.scope_snapshot_digest !== receipt.scope_snapshot.scope_snapshot_digest
      || candidate.applicability.harness_id !== binding.canonical_resource_id
      || !candidate.source_run_ids.includes(producerRunId)) {
    throw new MemoryV2HarnessWriteError(
      "Candidate does not match its authenticated harness receipt scope",
      403,
      "resource_binding_mismatch",
    );
  }
  if (MEMORY_V2_SUBTYPE_KIND[candidate.subkind] !== candidate.kind) {
    evidenceError("/candidates/subkind", "subkind does not map to the stored broad kind");
  }
  const contentLimits = [
    ["summary", candidate.content.summary.length, 10, 500],
    ["details", candidate.content.details.length, 30, 8_000],
    ["rationale", candidate.content.rationale.length, 10, 4_000],
  ] as const;
  for (const [field, length, minimum, maximum] of contentLimits) {
    if (length < minimum || length > maximum) {
      representabilityError(
        `/candidates/0/content/${field}`,
        `canonical bridge requires ${minimum} to ${maximum} characters`,
      );
    }
  }
  if (candidate.source_run_ids.length > 16) {
    representabilityError("/candidates/source_run_ids", "canonical limit is 16 source runs");
  }
  if (candidate.evidence_refs.length > 64) {
    representabilityError(
      "/candidates/evidence_refs",
      "canonical native-v2 bridge supports at most 64 evidence references",
    );
  }
  if (candidate.exceptions.some((value) => value.length > 1_000)) {
    representabilityError("/candidates/exceptions", "canonical item limit is 1000 characters");
  }
  assertStringListRepresentable(candidate.applicability.model_ids, {
    path: "/candidates/applicability/model_ids",
    maxItems: 32,
    maxLength: 160,
  });
  assertStringListRepresentable(candidate.applicability.tool_ids, {
    path: "/candidates/applicability/tool_ids",
    maxItems: 32,
    maxLength: 160,
  });
  if (candidate.applicability.configuration_digests.length > 1
      || (candidate.applicability.configuration_digests.length === 1
        && candidate.applicability.configuration_digests[0]
          !== receipt.scope_snapshot.configuration_digest)) {
    representabilityError(
      "/candidates/applicability/configuration_digests",
      "only the exact receipt configuration digest can be preserved in this slice",
    );
  }
  if (candidate.applicability.configuration_ids.length > 0
      && !candidate.applicability.configuration_ids.includes(
        receipt.scope_snapshot.configuration_id,
      )) {
    evidenceError(
      "/candidates/applicability/configuration_ids",
      "configuration must include the receipt snapshot configuration",
    );
  }
  if (candidate.validation.anchor_refs.length !== 0) {
    evidenceError(
      "/candidates/validation",
      "harness candidates cannot use repository anchor validation",
    );
  }
  const missing = candidate.evidence_refs.find((ref) => !input.handlesByRef.has(ref));
  if (missing) {
    throw new MemoryV2HarnessWriteError(
      "Candidate evidence does not resolve within the receipt handles",
      422,
      "evidence_unresolvable",
      [{ path: "/candidates/evidence_refs", reason: "unresolvable evidence reference" }],
    );
  }
  const referencedHandles = candidate.evidence_refs.map((ref) => input.handlesByRef.get(ref)!);
  if (candidate.validation.strategy === "stable_failure_fingerprint") {
    const fingerprint = candidate.validation.failure_fingerprint;
    if (!fingerprint || fingerprint.length < 8
        || fingerprint !== receipt.outcome.failure_fingerprint
        || referencedHandles.length === 0
        || referencedHandles.some((handle) => handle.outcome.failure_fingerprint !== fingerprint)) {
      evidenceError(
        "/candidates/validation",
        "failure-derived harness candidates require the exact stable receipt fingerprint",
      );
    }
  } else if (candidate.validation.strategy === "runtime_attestation"
      || candidate.validation.strategy === "authorized_review") {
    if (candidate.validation.failure_fingerprint !== null
        || receipt.outcome.failure_fingerprint !== null
        || receipt.outcome.status !== "completed"
        || receipt.outcome.verification_status !== "passed"
        || (candidate.validation.strategy === "runtime_attestation"
          && referencedHandles.length === 0)
        || referencedHandles.some((handle) => (
          handle.outcome.status !== "completed"
          || handle.outcome.verification_status !== "passed"
          || handle.outcome.failure_fingerprint !== null
        ))) {
      evidenceError(
        "/candidates/validation",
        "successful-run harness candidates require matching successful evidence",
      );
    }
  } else {
    evidenceError(
      "/candidates/validation/strategy",
      "harness validation strategy is unsupported",
    );
  }
  const evidenceRefs = [...candidate.evidence_refs].sort();
  // The applicability list controls selector specificity. The immutable native
  // marker always retains the authenticated snapshot configuration itself.
  const configurationDigest = receipt.scope_snapshot.configuration_digest;
  const configurationSelectorDigest = candidate.applicability.configuration_digests[0] ?? null;
  const projection = {
    clientCandidateId: candidate.client_candidate_id,
    resourceRowId: binding.resource_row_id,
    subtype: candidate.subkind,
    scopeSnapshotDigest: receipt.scope_snapshot.scope_snapshot_digest,
    evidenceRefsDigest: canonicalJsonSha256(evidenceRefs),
    configurationDigest,
    configurationSelectorDigest,
    activationRequirementRequested: candidate.activation_requirement_requested,
    validationStrategy: candidate.validation.strategy,
  } as const;
  return parseMemoryContract("MemoryCandidateV1", {
    schema_version: "pim.memory-candidate.v1",
    client_candidate_id: candidate.client_candidate_id,
    plane: "harness",
    kind: candidate.kind,
    content: candidate.content,
    applicability: {
      harness_id: candidate.applicability.harness_id,
      harness_version_range: candidate.applicability.harness_version_range,
      workflow_version_range: candidate.applicability.workflow_version_range,
      adapter_version_range: candidate.applicability.adapter_version_range,
      configuration_ids: candidate.applicability.configuration_ids,
      model_ids: candidate.applicability.model_ids,
      tool_ids: candidate.applicability.tool_ids,
    },
    validation: {
      ...(candidate.validation.strategy === "stable_failure_fingerprint"
        ? {
            strategy: "stable_failure_fingerprint" as const,
            failure_fingerprint: candidate.validation.failure_fingerprint!,
          }
        : { strategy: "policy_owner_review" as const }),
    },
    exceptions: candidate.exceptions,
    source_run_ids: candidate.source_run_ids,
    // Runtime references remain only in the additive v2 origin ledger. No
    // synthetic code-evidence manifest or legacy HTTPS evidence is manufactured.
    evidence_refs: [],
    extraction: candidate.extraction,
    activation_requirement_requested: "authorized_review",
    extensions: {
      v2_subtype: candidate.subkind,
      v2_resource_row_id: binding.resource_row_id,
      v2_scope_snapshot_digest: receipt.scope_snapshot.scope_snapshot_digest,
      v2_evidence_refs_digest: projection.evidenceRefsDigest,
      v2_configuration_digest: configurationDigest,
      v2_configuration_selector_digest: configurationSelectorDigest,
      v2_activation_requirement_requested: candidate.activation_requirement_requested,
      v2_validation_strategy: candidate.validation.strategy,
      v2_projection_digest: memoryV2NativeHarnessCandidateProjectionDigest(projection),
    },
  });
}

function normalizeReceipt(input: {
  receipt: HarnessRunReceiptV2;
  producerRunId: string;
  binding: ResourceBindingV2;
}): NormalizedHarnessReceipt {
  const { receipt, producerRunId, binding } = input;
  if (receipt.producer.consumer_run_id !== producerRunId) {
    throw new MemoryV2HarnessWriteError(
      "Receipt producer identity does not match the path producer run",
      409,
      "idempotency_conflict",
    );
  }
  if (receipt.candidates.length > 1) {
    representabilityError(
      "/candidates",
      "the canonical receipt supports at most one harness candidate",
    );
  }
  if (receipt.outcome.terminal_stage.length > 64) {
    representabilityError("/outcome/terminal_stage", "canonical limit is 64 characters");
  }
  if (receipt.outcome.failure_fingerprint !== null
      && receipt.outcome.failure_fingerprint.length < 8) {
    representabilityError(
      "/outcome/failure_fingerprint",
      "canonical minimum is 8 characters",
    );
  }
  if (receipt.outcome.verification_status === "inconclusive") {
    representabilityError(
      "/outcome/verification_status",
      "canonical harness intake cannot preserve an inconclusive verification outcome",
    );
  }
  if (!memoryV2CanonicalValuesEqual(receipt.scope_snapshot.resource_binding, binding)
      || receipt.scope_snapshot.harness_id !== binding.canonical_resource_id
      || receipt.producer.harness_id !== binding.canonical_resource_id
      || receipt.scope_snapshot.harness_version !== receipt.producer.harness_version
      || receipt.scope_snapshot.workflow_version !== receipt.producer.workflow_version
      || receipt.scope_snapshot.adapter_version !== receipt.producer.adapter_version
      || memoryV2ScopeSnapshotDigest(receipt.scope_snapshot)
        !== receipt.scope_snapshot.scope_snapshot_digest) {
    throw new MemoryV2HarnessWriteError(
      "Receipt scope snapshot does not match current authenticated harness authority",
      403,
      "resource_binding_mismatch",
    );
  }
  const orderedHandles = orderedRuntimeHandles(receipt.evidence_handles);
  const handlesByRef = new Map(orderedHandles.map((handle) => [handle.evidence_ref_id, handle]));
  const normalizedCandidates = receipt.candidates.map((candidate) => v1Candidate({
    candidate,
    receipt,
    producerRunId,
    binding,
    handlesByRef,
  }));
  const associations = new Map<string, string[]>();
  for (const candidate of receipt.candidates) {
    for (const ref of candidate.evidence_refs) {
      const values = associations.get(ref) ?? [];
      values.push(candidate.client_candidate_id);
      associations.set(ref, values);
    }
  }
  const unreferenced = orderedHandles.find((handle) => !associations.has(handle.evidence_ref_id));
  if (unreferenced) {
    evidenceError(
      "/evidence_handles",
      "every runtime handle must be referenced by a candidate in the same receipt",
    );
  }
  const normalized = parseMemoryContract("RunReceiptV1", {
    schema_version: "pim.run-receipt.v1",
    external_session_id: receipt.external_session_id,
    producer: {
      harness_id: receipt.producer.harness_id,
      harness_version: receipt.producer.harness_version,
      workflow_version: receipt.producer.workflow_version,
      adapter_version: receipt.producer.adapter_version,
    },
    tenant: { project_id: binding.project_id },
    task: receipt.task,
    outcome: {
      ...receipt.outcome,
      verification_status: receipt.outcome.verification_status,
      publication_status: "none",
      gate_attestation_ids: [],
    },
    retrieval_feedback: [],
    candidates: normalizedCandidates,
  }) as RunReceiptV1;
  return {
    receipt: normalized,
    subtypeByClientCandidateId: new Map(
      receipt.candidates.map((candidate) => [candidate.client_candidate_id, candidate.subkind]),
    ),
    clientCandidateIdsByEvidenceRef: new Map(
      [...associations].map(([ref, values]) => [ref, [...new Set(values)].sort()]),
    ),
    orderedHandles,
  };
}

function projectHarnessCandidateStatus(input: {
  status: MemoryCandidateStatusV1;
  binding: ResourceBindingV2;
  subtype: MemoryV2HarnessSubtype;
  orgId: string;
  projectId: string;
}): MemoryCandidateStatusV2 {
  return parseMemoryContractV2("MemoryCandidateStatusV2", {
    schema_version: "pim.memory-candidate-status.v2",
    candidate_id: input.status.candidate_id,
    client_candidate_id: input.status.client_candidate_id,
    tenant: { organization_id: input.orgId, project_id: input.projectId },
    plane: "harness",
    resource_binding: structuredClone(input.binding),
    kind: input.status.kind,
    subkind: input.subtype,
    status: memoryV2CandidateStatusValue(input.status.status),
    // Until a Sybil-resistant quorum exists, runtime repetition is review-only.
    activation_requirement: "authorized_review",
    blockers: input.status.blockers,
    latest_transition: memoryV2CandidateTransitionValue(input.status.latest_transition),
    active_record: input.status.active_record ?? null,
    created_at: input.status.created_at,
    updated_at: input.status.updated_at,
  });
}

function candidateStatusResult(input: {
  orgId: string;
  projectId: string;
  candidateId: string;
  binding: ResourceBindingV2;
  assertClosure?: boolean;
}): MemoryCandidateStatusV2 {
  let status: MemoryCandidateStatusV1;
  let subtype: MemoryV2HarnessSubtype;
  try {
    const closure = getMemoryV2AuthorizedCandidate({
      orgId: input.orgId,
      projectId: input.projectId,
      candidateId: input.candidateId,
      plane: "harness",
      resourceRowId: input.binding.resource_row_id,
      ...(input.assertClosure === undefined ? {} : { assertClosure: input.assertClosure }),
    });
    status = closure.status;
    subtype = closure.facet.subtype as MemoryV2HarnessSubtype;
  } catch (error) {
    return mapHarnessWriteError(error);
  }
  return projectHarnessCandidateStatus({
    status,
    binding: input.binding,
    subtype,
    orgId: input.orgId,
    projectId: input.projectId,
  });
}

function bindingsByEvidenceRef(input: {
  normalized: NormalizedHarnessReceipt;
  candidateBindings: readonly MemoryV2ReceiptCandidateBinding[];
}): ReadonlyMap<string, readonly RuntimeAttestationCandidateBinding[]> {
  const byClient = new Map(input.candidateBindings.map((item) => [item.clientCandidateId, item]));
  return new Map([...input.normalized.clientCandidateIdsByEvidenceRef].map(([ref, clientIds]) => {
    const bindings = clientIds.map((clientId) => byClient.get(clientId)).filter(
      (value): value is RuntimeAttestationCandidateBinding => Boolean(value),
    );
    if (bindings.length !== clientIds.length) {
      throw new MemoryV2HarnessWriteError(
        "Canonical candidate association is unavailable",
        503,
        "temporarily_unavailable",
      );
    }
    return [ref, bindings] as const;
  }));
}

export async function submitAuthorizedHarnessMemoryRunReceiptV2(input: {
  authorization: AuthorizedMemoryV2ResourceContext;
  producerRunId: string;
  idempotencyKey: string;
  receipt: HarnessRunReceiptV2;
  now?: string;
  dependencies?: MemoryV2HarnessWriteDependencies;
}): Promise<RunReceiptResultV2> {
  const authority = authorityFromAuthorization(input.authorization, "receipt_write");
  const selector = input.receipt.resource_selector;
  if (authority.principal.projectId !== input.receipt.tenant.project_id
      || (selector !== null
        && ("resource_row_id" in selector
          ? authority.binding.resource_row_id !== selector.resource_row_id
          : authority.binding.canonical_resource_id !== selector.canonical_resource_id))) {
    throw new MemoryV2HarnessWriteError(
      "Receipt does not match the authorized harness",
      403,
      "resource_binding_mismatch",
    );
  }
  const normalized = normalizeReceipt({
    receipt: input.receipt,
    producerRunId: input.producerRunId,
    binding: authority.binding,
  });
  try {
    // Run the runtime service's canonical receipt-level identity/order checks
    // against the topologically normalized handle set before any provider call.
    if (normalized.orderedHandles.length > 0) {
      assertMemoryRuntimeEvidenceHandleSet(normalized.orderedHandles);
    }
    const verifyReplay = ({ row, candidateBindings }: MemoryV2ReplayVerificationInput): void => {
      if (normalized.orderedHandles.length === 0) return;
      assertStoredMemoryRuntimeReceiptEvidence({
        orgId: authority.principal.orgId,
        projectId: authority.principal.projectId,
        resourceRowId: authority.binding.resource_row_id,
        producerPrincipalId: authority.principal.servicePrincipalId,
        producerRunId: input.producerRunId,
        receiptId: row.receipt_id,
        handles: normalized.orderedHandles,
        candidateBindingsByEvidenceRef: bindingsByEvidenceRef({
          normalized,
          candidateBindings,
        }),
      });
    };
    const begun = beginMemoryV2ReceiptWrite({
      principal: authority.principal,
      binding: authority.binding,
      plane: "harness",
      producerRunId: input.producerRunId,
      idempotencyKey: input.idempotencyKey,
      receipt: input.receipt,
      scopeSnapshot: input.receipt.scope_snapshot,
      feedback: input.receipt.retrieval_feedback,
      now: input.now,
      verifyReplay,
    });
    if (begun.replayed) return begun.replayed;
    const prepared: PreparedMemoryRuntimeAttestation[] = await Promise.all(
      normalized.orderedHandles.map((handle) => (
      prepareMemoryRuntimeAttestation({
        authorizedResource: input.authorization,
        auth: {
          orgId: authority.principal.orgId,
          projectId: authority.principal.projectId,
          resourceRowId: authority.binding.resource_row_id,
          producerPrincipalId: authority.principal.servicePrincipalId,
          producerRunId: input.producerRunId,
          evidenceRefId: handle.evidence_ref_id,
          clientCandidateIds: normalized.clientCandidateIdsByEvidenceRef.get(
            handle.evidence_ref_id,
          ) ?? [],
        },
        handle,
        now: begun.context.now,
      })
      )),
    );
    const preparedByEvidenceRef = new Map(
      prepared.map((item) => [item.handle.evidence_ref_id, item]),
    );
    for (const candidate of input.receipt.candidates) {
      if (candidate.validation.strategy !== "runtime_attestation") continue;
      if (candidate.evidence_refs.some((ref) => (
        preparedByEvidenceRef.get(ref)?.verified.sourceAuthority !== "verified"
      ))) {
        evidenceError(
          "/candidates/validation",
          "runtime-attestation validation requires provider-verified successful evidence",
        );
      }
    }
    const receiptId = `receipt_${randomUUID()}`;
    const committed = commitMemoryV2ReceiptWrite({
      context: begun.context,
      canonicalReceipt: {
        orgId: authority.principal.orgId,
        projectId: authority.principal.projectId,
        principalId: authority.principal.servicePrincipalId,
        producerRunId: input.producerRunId,
        idempotencyKey: input.idempotencyKey,
        repository: null,
        receipt: normalized.receipt,
        receiptId,
        candidateSubtypes: normalized.subtypeByClientCandidateId,
        authorizedScope: {
          plane: "harness",
          resourceRowId: authority.binding.resource_row_id,
        },
        now: begun.context.now,
      },
      expectedReceiptId: receiptId,
      projectCandidate: (candidateId) => candidateStatusResult({
        orgId: authority.principal.orgId,
        projectId: authority.principal.projectId,
        candidateId,
        binding: authority.binding,
        assertClosure: false,
      }),
      verifyReplay,
      beforeScopeSnapshotInsert: input.dependencies?.beforeScopeSnapshotInsert,
      beforeFeedbackBindingInsert: input.dependencies?.beforeFeedbackBindingInsert,
      beforePlaneSpecificInsert: input.dependencies?.beforeRuntimeEvidenceInsert,
      persistPlaneSpecific: ({ receiptId: committedReceiptId, candidateBindings }) => {
        const bindingsByRef = bindingsByEvidenceRef({ normalized, candidateBindings });
        const preparedByRef = new Map(
          prepared.map((item) => [item.handle.evidence_ref_id, item]),
        );
        const originsByEvidenceRef = new Map<string, string>();
        const resolutions: RuntimeAttestationResolution[] = [];
        for (const handle of normalized.orderedHandles) {
          const preparedHandle = preparedByRef.get(handle.evidence_ref_id);
          const bindings = bindingsByRef.get(handle.evidence_ref_id);
          if (!preparedHandle || !bindings) {
            throw new MemoryV2HarnessWriteError(
              "Prepared runtime evidence closure is unavailable",
              503,
              "temporarily_unavailable",
            );
          }
          const resolution = persistPreparedMemoryRuntimeAttestationInTransaction({
            prepared: preparedHandle,
            receiptId: committedReceiptId,
            candidateBindings: bindings,
            parentOriginsByEvidenceRef: originsByEvidenceRef,
            now: begun.context.now,
          });
          originsByEvidenceRef.set(handle.evidence_ref_id, resolution.originId);
          resolutions.push(resolution);
        }
        if (normalized.orderedHandles.length > 0) {
          assertStoredMemoryRuntimeReceiptEvidence({
            orgId: authority.principal.orgId,
            projectId: authority.principal.projectId,
            resourceRowId: authority.binding.resource_row_id,
            producerPrincipalId: authority.principal.servicePrincipalId,
            producerRunId: input.producerRunId,
            receiptId: committedReceiptId,
            handles: normalized.orderedHandles,
            candidateBindingsByEvidenceRef: bindingsByRef,
          });
        }
        return resolutions;
      },
      replayEffect: () => [],
    });
    // Metrics describe committed effects only. Replays and rolled-back
    // attempts intentionally do not emit runtime-resolution observations.
    for (const resolution of committed.effect) {
      recordMemoryRuntimeAttestationResolutionMetrics(resolution);
    }
    return committed.result;
  } catch (error) {
    return mapHarnessWriteError(error);
  }
}

export async function submitHarnessMemoryRunReceiptV2(input: {
  principal: MemoryV2RequestAuthorizationSnapshot | null | undefined;
  producerRunId: string;
  idempotencyKey: string;
  receipt: HarnessRunReceiptV2;
  now?: string;
  dependencies?: MemoryV2HarnessWriteDependencies;
}): Promise<RunReceiptResultV2> {
  return submitAuthorizedHarnessMemoryRunReceiptV2({
    authorization: authorizeHarnessMemoryV2Operation({
      principal: input.principal,
      operation: "receipt_write",
      selector: input.receipt.resource_selector,
      projectId: input.receipt.tenant.project_id,
    }),
    producerRunId: input.producerRunId,
    idempotencyKey: input.idempotencyKey,
    receipt: input.receipt,
    ...(input.now ? { now: input.now } : {}),
    ...(input.dependencies ? { dependencies: input.dependencies } : {}),
  });
}

export function getAuthorizedHarnessMemoryCandidateStatusV2(input: {
  authorization: AuthorizedMemoryV2ResourceContext;
  candidateId: string;
  resourceSelector: ResourceSelectorV2;
  receiptId: string;
  producerRunId: string;
}): MemoryCandidateStatusV2 {
  const authority = authorityFromAuthorization(input.authorization, "candidate_read");
  if (input.resourceSelector !== null && (
    "resource_row_id" in input.resourceSelector
      ? input.resourceSelector.resource_row_id !== authority.binding.resource_row_id
      : input.resourceSelector.canonical_resource_id
        !== authority.binding.canonical_resource_id
  )) {
    throw new MemoryV2HarnessWriteError(
      "Memory candidate is unavailable",
      404,
      "resource_not_found",
    );
  }
  const exact = db.prepare(
    `SELECT 1
     FROM memory_v2_scope_snapshots AS snapshot
     INNER JOIN memory_receipt_candidates AS link ON link.receipt_id = snapshot.receipt_id
     INNER JOIN memory_v2_candidate_facets AS facet ON facet.candidate_id = link.candidate_id
     WHERE snapshot.receipt_id = ? AND snapshot.org_id = ? AND snapshot.project_id = ?
       AND snapshot.plane = 'harness' AND snapshot.resource_row_id = ?
       AND snapshot.producer_principal_id = ? AND snapshot.producer_run_id = ?
       AND link.candidate_id = ?
       AND facet.plane = 'harness' AND facet.resource_row_id = snapshot.resource_row_id
       AND facet.projection_status = 'mapped'`,
  ).get(
    input.receiptId,
    authority.principal.orgId,
    authority.principal.projectId,
    authority.binding.resource_row_id,
    authority.principal.servicePrincipalId,
    input.producerRunId,
    input.candidateId,
  );
  if (!exact) {
    throw new MemoryV2HarnessWriteError(
      "Memory candidate is unavailable",
      404,
      "resource_not_found",
    );
  }
  return candidateStatusResult({
    orgId: authority.principal.orgId,
    projectId: authority.principal.projectId,
    candidateId: input.candidateId,
    binding: authority.binding,
  });
}

export function getHarnessMemoryCandidateStatusV2(input: {
  principal: MemoryV2RequestAuthorizationSnapshot | null | undefined;
  candidateId: string;
  resourceSelector: ResourceSelectorV2;
  receiptId: string;
  producerRunId: string;
}): MemoryCandidateStatusV2 {
  return getAuthorizedHarnessMemoryCandidateStatusV2({
    authorization: authorizeHarnessMemoryCandidateStatusV2(input),
    candidateId: input.candidateId,
    resourceSelector: input.resourceSelector,
    receiptId: input.receiptId,
    producerRunId: input.producerRunId,
  });
}

export function authorizeHarnessMemoryCandidateStatusV2(input: {
  principal: MemoryV2RequestAuthorizationSnapshot | null | undefined;
  candidateId: string;
  resourceSelector: ResourceSelectorV2;
  receiptId: string;
  producerRunId: string;
}): AuthorizedMemoryV2ResourceContext {
  let authorization: AuthorizedMemoryV2ResourceContext;
  try {
    authorization = authorizeHarnessMemoryV2Operation({
      principal: input.principal,
      operation: "candidate_read",
      selector: input.resourceSelector,
      projectId: input.principal?.projectId,
    });
  } catch (error) {
    if (error instanceof MemoryV2HarnessWriteError
        && error.code === "resource_binding_mismatch") {
      throw new MemoryV2HarnessWriteError(
        "Memory candidate is unavailable",
        404,
        "resource_not_found",
      );
    }
    throw error;
  }
  return authorization;
}

export function decideAuthorizedHarnessMemoryCandidateV2(input: {
  authorization: AuthorizedMemoryV2ResourceContext;
  candidateId: string;
  decision: MemoryCandidateDecisionV2;
  resourceSelector?: ResourceSelectorV2;
  now?: string;
}): MemoryCandidateDecisionResultV2 {
  const authority = authorityFromAuthorization(input.authorization, "review");
  try {
    return decideAuthorizedMemoryV2Candidate({
      principal: authority.principal,
      binding: authority.binding,
      plane: "harness",
      candidateId: input.candidateId,
      decision: input.decision,
      ...(input.now ? { now: input.now } : {}),
    });
  } catch (error) {
    return mapHarnessWriteError(error);
  }
}

export function decideHarnessMemoryCandidateV2(input: {
  principal: MemoryV2RequestAuthorizationSnapshot | null | undefined;
  candidateId: string;
  decision: MemoryCandidateDecisionV2;
  resourceSelector?: ResourceSelectorV2;
  now?: string;
}): MemoryCandidateDecisionResultV2 {
  const selector = input.resourceSelector
    ?? { resource_row_id: input.decision.resource_row_id };
  return decideAuthorizedHarnessMemoryCandidateV2({
    authorization: authorizeHarnessMemoryV2Operation({
      principal: input.principal,
      operation: "review",
      selector,
    }),
    candidateId: input.candidateId,
    decision: input.decision,
    ...(input.resourceSelector ? { resourceSelector: input.resourceSelector } : {}),
    ...(input.now ? { now: input.now } : {}),
  });
}
