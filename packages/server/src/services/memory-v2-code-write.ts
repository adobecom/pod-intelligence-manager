import { randomUUID } from "node:crypto";
import {
  canonicalJsonSha256,
  parseMemoryContract,
  parseMemoryContractV2,
  type AnchorRefV1,
  type CodebaseRunReceiptCandidateV2,
  type CodebaseRunReceiptV2,
  type MemoryCandidateDecisionResultV2,
  type MemoryCandidateDecisionV2,
  type MemoryCandidateStatusV1,
  type MemoryCandidateStatusV2,
  type MemoryCandidateV1,
  type MemoryFeedbackResultV2,
  type MemoryFeedbackV2,
  type PimErrorV2,
  type ResourceBindingV2,
  type ResourceSelectorV2,
  type RunReceiptResultV2,
  type RunReceiptV1,
} from "@pim/shared";
import db, { withImmediateTransaction } from "../db/connection.js";
import { authorizeMemoryV2Resource } from "../middleware/service-authz.js";
import {
  getStoredMemoryCandidate,
} from "./memory-candidates.js";
import {
  MemoryDecisionError,
} from "./memory-decisions.js";
import {
  MemoryReceiptError,
} from "./memory-receipts.js";
import type { MemoryRepositoryBinding } from "./memory-repository-registry.js";
import {
  MemoryV2CanonicalWriteError,
} from "./memory-v2-canonical-writes.js";
import {
  beginMemoryV2ReceiptWrite,
  commitMemoryV2ReceiptWrite,
  decideAuthorizedMemoryV2Candidate,
  findMemoryV2IdempotencyClaim,
  getMemoryV2AuthorizedCandidate,
  insertMemoryV2IdempotencyClaim,
  memoryV2CandidateStatusValue,
  memoryV2CandidateTransitionValue,
  memoryV2CanonicalValuesEqual,
  memoryV2ScopeSnapshotDigest,
  MEMORY_V2_FEEDBACK_IDEMPOTENCY_OPERATION,
  MemoryV2WriteCoreError,
  type MemoryV2IdempotencyClaimRow,
  type MemoryV2ScopeSnapshotRow,
} from "./memory-v2-write-core.js";
import type {
  AuthorizedMemoryV2ResourceContext,
  MemoryV2RequestAuthorizationSnapshot,
} from "./memory-v2-request-authorization.js";

type CodeWriteErrorCode = PimErrorV2["code"];

export interface MemoryV2CodeWriteDependencies {
  /** Test-only failure seam; production adapters never supply it. */
  beforeScopeSnapshotInsert?: () => void;
  /** Test-only failure seam; production adapters never supply it. */
  beforeFeedbackBindingInsert?: () => void;
}

export class MemoryV2CodeWriteError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: CodeWriteErrorCode,
    readonly details: Array<{ path: string; reason: string }> = [],
  ) {
    super(message);
    this.name = "MemoryV2CodeWriteError";
  }
}

interface FeedbackBindingRow {
  feedback_id: string;
  org_id: string;
  project_id: string;
  receipt_id: string;
  producer_principal_id: string;
  producer_run_id: string;
  feedback_stage: "receipt" | "later";
  feedback_revision: number;
  retrieval_pack_id: string;
  record_id: string;
  record_version: number;
  plane: "codebase" | "harness";
  resource_row_id: string;
  scope_snapshot_digest: string;
  feedback_json: string;
  feedback_digest: string;
  response_json: string;
  created_at: string;
}

function parseJson(raw: string): unknown {
  return JSON.parse(raw) as unknown;
}

function requirePrincipal(
  principal: MemoryV2RequestAuthorizationSnapshot | null | undefined,
): MemoryV2RequestAuthorizationSnapshot & { projectId: string } {
  if (!principal) {
    throw new MemoryV2CodeWriteError(
      "A PIM service-token principal is required",
      401,
      "authentication_required",
    );
  }
  if (!principal.projectId || principal.podId) {
    throw new MemoryV2CodeWriteError(
      "A project-bound PIM service-token principal is required",
      403,
      "resource_binding_mismatch",
    );
  }
  return principal as MemoryV2RequestAuthorizationSnapshot & { projectId: string };
}

function mapBindingError(error: unknown): never {
  if (error instanceof MemoryV2CodeWriteError) throw error;
  if (error instanceof MemoryV2WriteCoreError) {
    throw new MemoryV2CodeWriteError(
      error.message,
      error.statusCode,
      error.code,
      error.details,
    );
  }
  if (error instanceof MemoryReceiptError || error instanceof MemoryDecisionError) {
    throw new MemoryV2CodeWriteError(
      error.message,
      error.statusCode,
      error.code,
      "details" in error && Array.isArray(error.details) ? error.details : [],
    );
  }
  if (error instanceof MemoryV2CanonicalWriteError) {
    throw new MemoryV2CodeWriteError(error.message, 409, "idempotency_conflict");
  }
  throw error;
}

function operationBinding(input: {
  principal: MemoryV2RequestAuthorizationSnapshot | null | undefined;
  operation: "receipt_write" | "feedback_write" | "candidate_read" | "review";
  selector: ResourceSelectorV2;
  projectId?: string;
}): {
  authorization: AuthorizedMemoryV2ResourceContext;
  principal: MemoryV2RequestAuthorizationSnapshot & { projectId: string };
  binding: ResourceBindingV2;
  repository: Readonly<MemoryRepositoryBinding>;
} {
  const principal = requirePrincipal(input.principal);
  if (input.projectId !== undefined && principal.projectId !== input.projectId) {
    throw new MemoryV2CodeWriteError(
      "Request project is outside the authenticated service-token binding",
      403,
      "resource_binding_mismatch",
    );
  }
  const matches = principal.resources.filter((binding) => {
    if (binding.resource.plane !== "codebase"
        || binding.resource.resourceType !== "repository") return false;
    if (input.selector === null) return true;
    return "resource_row_id" in input.selector
      ? binding.resourceRowId === input.selector.resource_row_id
      : binding.resource.canonicalResourceId === input.selector.canonical_resource_id;
  });
  if (matches.length !== 1) {
    throw new MemoryV2CodeWriteError(
      input.selector === null
        ? "Exactly one authenticated codebase resource is required"
        : "The selected codebase resource is outside the authenticated binding",
      403,
      input.selector === null ? "scope_required" : "resource_binding_mismatch",
    );
  }
  const selected = matches[0]!;
  const authorization = authorizeMemoryV2Resource({
    principal,
    operation: input.operation,
    plane: "codebase",
    projectId: principal.projectId,
    resourceRowId: selected.resourceRowId,
  });
  if (authorization.decision === "deny") {
    const scopeFailure = authorization.reason === "scope_missing"
      || authorization.reason === "operation_unavailable";
    throw new MemoryV2CodeWriteError(
      "The authenticated principal cannot perform this memory operation",
      authorization.reason === "principal_unavailable" ? 401 : 403,
      scopeFailure ? "scope_required" : "resource_binding_mismatch",
    );
  }
  if (authorization.context.source.kind !== "repository") {
    throw new MemoryV2CodeWriteError(
      "Authenticated repository source is unavailable",
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
    repository: authorization.context.source.repository,
  };
}

function authorityFromAuthorization(
  authorization: AuthorizedMemoryV2ResourceContext,
  operation: "receipt_write" | "feedback_write" | "candidate_read" | "review",
): ReturnType<typeof operationBinding> {
  if (authorization.operation !== operation
      || authorization.resource.plane !== "codebase"
      || authorization.resource.resourceType !== "repository"
      || authorization.source.kind !== "repository"
      || !authorization.principal.projectId
      || authorization.principal.podId
      || authorization.binding.resource_row_id !== authorization.resource.resourceRowId) {
    throw new MemoryV2CodeWriteError(
      "Authorized codebase resource context is inconsistent",
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
    repository: authorization.source.repository,
  };
}

export function authorizeCodeMemoryV2Operation(input: {
  principal: MemoryV2RequestAuthorizationSnapshot | null | undefined;
  operation: "receipt_write" | "feedback_write" | "candidate_read" | "review";
  selector: ResourceSelectorV2;
  projectId?: string;
}): AuthorizedMemoryV2ResourceContext {
  return operationBinding(input).authorization;
}

function exactResourceSelector(resourceRowId: string): ResourceSelectorV2 {
  return { resource_row_id: resourceRowId };
}

function v1Anchor(reference: string): AnchorRefV1 {
  const symbol = /^([^#]{1,256})#([^#]{1,256})$/.exec(reference);
  return symbol
    ? {
        type: "symbol",
        path: symbol[1]!,
        value: symbol[2]!,
        digest: canonicalJsonSha256({ anchor_ref: reference }),
      }
    : {
        type: "path",
        value: reference,
        digest: canonicalJsonSha256({ anchor_ref: reference }),
      };
}

function v1Candidate(input: {
  candidate: CodebaseRunReceiptCandidateV2;
  producerRunId: string;
  repositoryId: string;
  baseSha: string;
  scopeSnapshotDigest: string;
  manifestRefs: Set<string>;
}): MemoryCandidateV1 {
  const candidate = input.candidate;
  if (candidate.resource_row_id.length === 0
      || candidate.scope_snapshot_digest !== input.scopeSnapshotDigest
      || candidate.applicability.repository_id !== input.repositoryId
      || candidate.applicability.base_sha !== input.baseSha
      || !candidate.source_run_ids.includes(input.producerRunId)) {
    throw new MemoryV2CodeWriteError(
      "Candidate does not match its authenticated receipt scope",
      403,
      "resource_binding_mismatch",
    );
  }
  const missingEvidence = candidate.evidence_refs.find((ref) => !input.manifestRefs.has(ref));
  if (missingEvidence) {
    throw new MemoryV2CodeWriteError(
      "Candidate evidence does not resolve within the receipt manifest",
      422,
      "evidence_unresolvable",
      [{ path: "/candidates/evidence_refs", reason: "unresolvable evidence reference" }],
    );
  }
  if (candidate.validation.anchor_refs.length > 64) {
    throw new MemoryV2CodeWriteError(
      "Candidate anchor set cannot be represented by the canonical validator",
      422,
      "activation_requirement_unsatisfied",
      [{ path: "/candidates/validation/anchor_refs", reason: "canonical validator limit is 64" }],
    );
  }
  if (candidate.validation.failure_fingerprint !== null
      && candidate.validation.failure_fingerprint.length < 8) {
    throw new MemoryV2CodeWriteError(
      "Candidate failure fingerprint cannot be represented by the canonical validator",
      409,
      "activation_requirement_unsatisfied",
      [{
        path: "/candidates/validation/failure_fingerprint",
        reason: "canonical validator minimum is 8 characters",
      }],
    );
  }
  if (candidate.activation_requirement_requested === "verified_merge_and_test") {
    throw new MemoryV2CodeWriteError(
      "Verified merge-and-test activation is not available in this slice",
      409,
      "activation_requirement_unsatisfied",
    );
  }
  const antiPattern = candidate.kind === "anti_pattern";
  if ((antiPattern && candidate.activation_requirement_requested !== "authorized_review")
      || (!antiPattern && candidate.activation_requirement_requested !== "verified_merge")) {
    throw new MemoryV2CodeWriteError(
      "Requested activation policy does not match the canonical codebase lifecycle",
      409,
      "activation_requirement_unsatisfied",
    );
  }
  if ((antiPattern && candidate.validation.strategy !== "stable_failure_fingerprint")
      || (!antiPattern && candidate.validation.strategy !== "repository_anchors")) {
    throw new MemoryV2CodeWriteError(
      "Candidate validation strategy does not match its governed lifecycle",
      422,
      "activation_requirement_unsatisfied",
    );
  }
  const applicability = {
    repository_id: candidate.applicability.repository_id,
    base_sha: candidate.applicability.base_sha,
    ...(candidate.applicability.components.length
      ? { components: candidate.applicability.components }
      : {}),
    ...(candidate.applicability.paths.length ? { paths: candidate.applicability.paths } : {}),
    ...(candidate.applicability.symbols.length ? { symbols: candidate.applicability.symbols } : {}),
    ...(candidate.applicability.task_classes.length
      ? { task_classes: candidate.applicability.task_classes }
      : {}),
  };
  return parseMemoryContract("MemoryCandidateV1", {
    schema_version: "pim.memory-candidate.v1",
    client_candidate_id: candidate.client_candidate_id,
    plane: "codebase",
    kind: candidate.kind,
    content: candidate.content,
    applicability,
    validation: {
      strategy: candidate.validation.strategy,
      ...(candidate.validation.anchor_refs.length
        ? { anchor_refs: candidate.validation.anchor_refs.map(v1Anchor) }
        : {}),
      ...(candidate.validation.failure_fingerprint
        ? { failure_fingerprint: candidate.validation.failure_fingerprint }
        : {}),
    },
    exceptions: candidate.exceptions,
    source_run_ids: candidate.source_run_ids,
    evidence_refs: candidate.evidence_refs,
    extraction: candidate.extraction,
    activation_requirement_requested: candidate.activation_requirement_requested,
  });
}

function normalizeReceipt(input: {
  receipt: CodebaseRunReceiptV2;
  producerRunId: string;
  binding: ResourceBindingV2;
  repository: MemoryRepositoryBinding;
}): RunReceiptV1 {
  const { receipt, producerRunId, binding, repository } = input;
  if (receipt.producer.consumer_run_id !== producerRunId) {
    throw new MemoryV2CodeWriteError(
      "Receipt producer identity does not match the path producer run",
      409,
      "idempotency_conflict",
    );
  }
  if (receipt.outcome.terminal_stage.length > 64) {
    throw new MemoryV2CodeWriteError(
      "Receipt terminal stage cannot be represented by the canonical receipt ledger",
      409,
      "transition_invalid",
      [{ path: "/outcome/terminal_stage", reason: "canonical receipt limit is 64 characters" }],
    );
  }
  if (receipt.outcome.failure_fingerprint !== null
      && receipt.outcome.failure_fingerprint.length < 8) {
    throw new MemoryV2CodeWriteError(
      "Receipt failure fingerprint cannot be represented by the canonical receipt ledger",
      409,
      "transition_invalid",
      [{
        path: "/outcome/failure_fingerprint",
        reason: "canonical receipt minimum is 8 characters",
      }],
    );
  }
  if (!memoryV2CanonicalValuesEqual(receipt.scope_snapshot.resource_binding, binding)
      || receipt.scope_snapshot.repository_id !== binding.canonical_resource_id
      || receipt.scope_snapshot.repository_id !== repository.repository_id
      || memoryV2ScopeSnapshotDigest(receipt.scope_snapshot)
        !== receipt.scope_snapshot.scope_snapshot_digest) {
    throw new MemoryV2CodeWriteError(
      "Receipt scope snapshot does not match current authenticated authority",
      403,
      "resource_binding_mismatch",
    );
  }
  const manifestRefs = new Set(receipt.evidence_manifest.refs.map((ref) => ref.id));
  const candidates = receipt.candidates.map((candidate) => {
    if (candidate.resource_row_id !== binding.resource_row_id) {
      throw new MemoryV2CodeWriteError(
        "Candidate resource does not match the receipt resource",
        403,
        "resource_binding_mismatch",
      );
    }
    return v1Candidate({
      candidate,
      producerRunId,
      repositoryId: repository.repository_id,
      baseSha: receipt.scope_snapshot.base_sha,
      scopeSnapshotDigest: receipt.scope_snapshot.scope_snapshot_digest,
      manifestRefs,
    });
  });
  return parseMemoryContract("RunReceiptV1", {
    schema_version: "pim.run-receipt.v1",
    external_session_id: receipt.external_session_id,
    producer: {
      harness_id: receipt.producer.harness_id,
      harness_version: receipt.producer.harness_version,
      workflow_version: receipt.producer.workflow_version,
      adapter_version: receipt.producer.adapter_version,
    },
    tenant: {
      project_id: binding.project_id,
    },
    repository: {
      repository_id: repository.repository_id,
      display_slug: repository.display_slug,
      base_sha: receipt.scope_snapshot.base_sha,
    },
    task: receipt.task,
    outcome: {
      ...receipt.outcome,
      verification_status: receipt.outcome.verification_status === "inconclusive"
        ? "unknown"
        : receipt.outcome.verification_status,
      publication_status: "none",
      gate_attestation_ids: [],
    },
    retrieval_feedback: [],
    evidence_manifest: receipt.evidence_manifest,
    candidates,
  });
}

interface CodeCandidateStatusV2ProjectionInput {
  status: MemoryCandidateStatusV1;
  organizationId: string;
  projectId: string;
  resourceBinding: ResourceBindingV2;
}

function unrepresentableCodeCandidateStatus(): MemoryV2CodeWriteError {
  return new MemoryV2CodeWriteError(
    "Candidate lifecycle cannot be represented by codebase v2",
    503,
    "temporarily_unavailable",
  );
}

/**
 * Pure, exact v1-to-v2 code candidate-status projection shared by the live
 * status path and startup reconciliation. Any legacy state outside the frozen
 * v2 contract keeps the v2 service closed instead of being weakened or guessed.
 */
export function projectMemoryV1CodeCandidateStatusV2(
  input: CodeCandidateStatusV2ProjectionInput,
): MemoryCandidateStatusV2 {
  const binding = input.resourceBinding;
  if (input.status.plane !== "codebase"
      || input.status.activation_requirement === "manual_policy_owner"
      || binding.organization_id !== input.organizationId
      || binding.project_id !== input.projectId
      || binding.plane !== "codebase"
      || binding.resource_type !== "repository") {
    throw unrepresentableCodeCandidateStatus();
  }
  try {
    return parseMemoryContractV2("MemoryCandidateStatusV2", {
      schema_version: "pim.memory-candidate-status.v2",
      candidate_id: input.status.candidate_id,
      client_candidate_id: input.status.client_candidate_id,
      tenant: {
        organization_id: input.organizationId,
        project_id: input.projectId,
      },
      plane: "codebase",
      // Each candidate result must own its JSON subtree. The strict contract
      // parser rejects shared object identities in an otherwise acyclic tree.
      resource_binding: structuredClone(binding),
      kind: input.status.kind,
      subkind: null,
      status: memoryV2CandidateStatusValue(input.status.status),
      activation_requirement: input.status.activation_requirement,
      blockers: input.status.blockers,
      latest_transition: memoryV2CandidateTransitionValue(input.status.latest_transition),
      active_record: input.status.active_record ?? null,
      created_at: input.status.created_at,
      updated_at: input.status.updated_at,
    });
  } catch (error) {
    if (error instanceof MemoryV2CodeWriteError) throw error;
    throw unrepresentableCodeCandidateStatus();
  }
}

function candidateStatusResult(input: {
  orgId: string;
  projectId: string;
  candidateId: string;
  binding: ResourceBindingV2;
}): MemoryCandidateStatusV2 {
  let status: MemoryCandidateStatusV1;
  try {
    ({ status } = getMemoryV2AuthorizedCandidate({
      orgId: input.orgId,
      projectId: input.projectId,
      candidateId: input.candidateId,
      plane: "codebase",
      resourceRowId: input.binding.resource_row_id,
    }));
  } catch (error) {
    return mapBindingError(error);
  }
  return projectMemoryV1CodeCandidateStatusV2({
    status,
    organizationId: input.orgId,
    projectId: input.projectId,
    resourceBinding: input.binding,
  });
}

export function submitAuthorizedCodeMemoryRunReceiptV2(input: {
  authorization: AuthorizedMemoryV2ResourceContext;
  producerRunId: string;
  idempotencyKey: string;
  receipt: CodebaseRunReceiptV2;
  now?: string;
  dependencies?: MemoryV2CodeWriteDependencies;
}): RunReceiptResultV2 {
  const authority = authorityFromAuthorization(input.authorization, "receipt_write");
  const selector = input.receipt.resource_selector;
  if (authority.principal.projectId !== input.receipt.tenant.project_id
      || (selector !== null
        && ("resource_row_id" in selector
          ? authority.binding.resource_row_id !== selector.resource_row_id
          : authority.binding.canonical_resource_id !== selector.canonical_resource_id))) {
    throw new MemoryV2CodeWriteError(
      "Receipt does not match the authorized repository",
      403,
      "resource_binding_mismatch",
    );
  }
  const normalized = normalizeReceipt({
    receipt: input.receipt,
    producerRunId: input.producerRunId,
    binding: authority.binding,
    repository: authority.repository as MemoryRepositoryBinding,
  });
  try {
    const begun = beginMemoryV2ReceiptWrite({
      principal: authority.principal,
      binding: authority.binding,
      plane: "codebase",
      producerRunId: input.producerRunId,
      idempotencyKey: input.idempotencyKey,
      receipt: input.receipt,
      scopeSnapshot: input.receipt.scope_snapshot,
      feedback: input.receipt.retrieval_feedback,
      now: input.now,
    });
    if (begun.replayed) return begun.replayed;
    return commitMemoryV2ReceiptWrite({
      context: begun.context,
      canonicalReceipt: {
        orgId: authority.principal.orgId,
        projectId: authority.principal.projectId,
        principalId: authority.principal.servicePrincipalId,
        producerRunId: input.producerRunId,
        idempotencyKey: input.idempotencyKey,
        repository: authority.repository as MemoryRepositoryBinding,
        receipt: normalized,
        now: begun.context.now,
      },
      projectCandidate: (candidateId) => candidateStatusResult({
        orgId: authority.principal.orgId,
        projectId: authority.principal.projectId,
        candidateId,
        binding: authority.binding,
      }),
      beforeScopeSnapshotInsert: input.dependencies?.beforeScopeSnapshotInsert,
      beforeFeedbackBindingInsert: input.dependencies?.beforeFeedbackBindingInsert,
      persistPlaneSpecific: () => undefined,
      replayEffect: () => undefined,
    }).result;
  } catch (error) {
    return mapBindingError(error);
  }
}

export function submitCodeMemoryRunReceiptV2(input: {
  principal: MemoryV2RequestAuthorizationSnapshot | null | undefined;
  producerRunId: string;
  idempotencyKey: string;
  receipt: CodebaseRunReceiptV2;
  now?: string;
  dependencies?: MemoryV2CodeWriteDependencies;
}): RunReceiptResultV2 {
  return submitAuthorizedCodeMemoryRunReceiptV2({
    authorization: authorizeCodeMemoryV2Operation({
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

export function authorizeCodeMemoryCandidateStatusV2(input: {
  principal: MemoryV2RequestAuthorizationSnapshot | null | undefined;
  candidateId: string;
  resourceSelector?: ResourceSelectorV2;
}): AuthorizedMemoryV2ResourceContext {
  const principal = requirePrincipal(input.principal);
  const stored = getStoredMemoryCandidate(principal.orgId, principal.projectId, input.candidateId);
  if (!stored || stored.candidate.plane !== "codebase") {
    throw new MemoryV2CodeWriteError(
      "Memory candidate is unavailable",
      404,
      "resource_not_found",
    );
  }
  const facet = db.prepare(
    `SELECT resource_row_id FROM memory_v2_candidate_facets
     WHERE candidate_id = ? AND org_id = ? AND project_id = ? AND plane = 'codebase'`,
  ).get(input.candidateId, principal.orgId, principal.projectId) as {
    resource_row_id: string;
  } | undefined;
  if (!facet) {
    throw new MemoryV2CodeWriteError(
      "Memory candidate is unavailable",
      404,
      "resource_not_found",
    );
  }
  let authority: ReturnType<typeof operationBinding>;
  try {
    authority = operationBinding({
      principal,
      operation: "candidate_read",
      selector: exactResourceSelector(facet.resource_row_id),
      projectId: principal.projectId,
    });
  } catch (error) {
    if (error instanceof MemoryV2CodeWriteError
        && error.code === "resource_binding_mismatch") {
      throw new MemoryV2CodeWriteError(
        "Memory candidate is unavailable",
        404,
        "resource_not_found",
      );
    }
    throw error;
  }
  if (input.resourceSelector && (
    "resource_row_id" in input.resourceSelector
      ? input.resourceSelector.resource_row_id !== authority.binding.resource_row_id
      : input.resourceSelector.canonical_resource_id
        !== authority.binding.canonical_resource_id
  )) {
    throw new MemoryV2CodeWriteError(
      "Memory candidate is unavailable",
      404,
      "resource_not_found",
    );
  }
  return authority.authorization;
}

export function getAuthorizedCodeMemoryCandidateStatusV2(input: {
  authorization: AuthorizedMemoryV2ResourceContext;
  candidateId: string;
}): MemoryCandidateStatusV2 {
  const authority = authorityFromAuthorization(input.authorization, "candidate_read");
  const stored = getStoredMemoryCandidate(
    authority.principal.orgId,
    authority.principal.projectId,
    input.candidateId,
  );
  const facet = db.prepare(
    `SELECT resource_row_id FROM memory_v2_candidate_facets
     WHERE candidate_id = ? AND org_id = ? AND project_id = ? AND plane = 'codebase'`,
  ).get(input.candidateId, authority.principal.orgId, authority.principal.projectId) as {
    resource_row_id: string;
  } | undefined;
  if (!stored || stored.candidate.plane !== "codebase"
      || !facet || facet.resource_row_id !== authority.binding.resource_row_id) {
    throw new MemoryV2CodeWriteError(
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

export function getCodeMemoryCandidateStatusV2(input: {
  principal: MemoryV2RequestAuthorizationSnapshot | null | undefined;
  candidateId: string;
  resourceSelector?: ResourceSelectorV2;
}): MemoryCandidateStatusV2 {
  return getAuthorizedCodeMemoryCandidateStatusV2({
    authorization: authorizeCodeMemoryCandidateStatusV2(input),
    candidateId: input.candidateId,
  });
}

function feedbackBindingById(feedbackId: string): FeedbackBindingRow | null {
  return (db.prepare(
    "SELECT * FROM memory_v2_feedback_bindings WHERE feedback_id = ?",
  ).get(feedbackId) as FeedbackBindingRow | undefined) ?? null;
}

function existingFeedbackBinding(input: {
  orgId: string;
  projectId: string;
  feedback: MemoryFeedbackV2;
}): FeedbackBindingRow | null {
  return (db.prepare(
    `SELECT * FROM memory_v2_feedback_bindings
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
  ) as FeedbackBindingRow | undefined) ?? null;
}

function assertFeedbackReplay(input: {
  claim: MemoryV2IdempotencyClaimRow;
  requestDigest: string;
  principal: MemoryV2RequestAuthorizationSnapshot & { projectId: string };
  feedback: MemoryFeedbackV2;
  binding: ResourceBindingV2;
}): MemoryFeedbackResultV2 {
  if (input.claim.request_digest !== input.requestDigest
      || input.claim.response_resource_type !== "memory_v2_feedback_binding") {
    throw new MemoryV2CodeWriteError(
      "Idempotency key was reused with different feedback content",
      409,
      "idempotency_conflict",
    );
  }
  const row = feedbackBindingById(input.claim.response_resource_id);
  if (!row
      || row.feedback_stage !== "later"
      || row.org_id !== input.principal.orgId
      || row.project_id !== input.principal.projectId
      || row.producer_principal_id !== input.principal.servicePrincipalId
      || row.producer_run_id !== input.feedback.producer_run_id
      || row.retrieval_pack_id !== input.feedback.retrieval_pack_id
      || row.record_id !== input.feedback.record_id
      || row.record_version !== input.feedback.record_version
      || row.feedback_revision !== input.feedback.feedback_revision
      || row.resource_row_id !== input.binding.resource_row_id
      || row.scope_snapshot_digest !== input.feedback.scope_snapshot_digest
      || row.feedback_digest !== input.requestDigest
      || row.response_json !== input.claim.response_json) {
    throw new MemoryV2CodeWriteError(
      "Stored feedback replay no longer matches its immutable binding",
      409,
      "idempotency_conflict",
    );
  }
  try {
    const original = parseMemoryContractV2("MemoryFeedbackResultV2", parseJson(row.response_json));
    const signals = db.prepare(
      `SELECT signal_id, outbox_job_id FROM memory_v2_feedback_review_signals
       WHERE feedback_id = ? ORDER BY signal_type`,
    ).all(row.feedback_id) as unknown as Array<{ signal_id: string; outbox_job_id: string }>;
    if (signals.length !== original.review_signal_ids.length
        || signals.some((signal) => !original.review_signal_ids.includes(signal.signal_id))
        || signals.some((signal) => !db.prepare(
          "SELECT 1 FROM memory_outbox WHERE job_id = ?",
        ).get(signal.outbox_job_id))) {
      throw new Error("feedback signal closure is unavailable");
    }
    return parseMemoryContractV2("MemoryFeedbackResultV2", {
      ...original,
      duplicate: true,
    });
  } catch (error) {
    if (error instanceof MemoryV2CodeWriteError) throw error;
    throw new MemoryV2CodeWriteError(
      "Stored feedback replay is unavailable",
      503,
      "temporarily_unavailable",
    );
  }
}

function feedbackScopeSnapshot(input: {
  principal: MemoryV2RequestAuthorizationSnapshot & { projectId: string };
  feedback: MemoryFeedbackV2;
  binding: ResourceBindingV2;
}): MemoryV2ScopeSnapshotRow {
  const row = db.prepare(
    `SELECT * FROM memory_v2_scope_snapshots
     WHERE org_id = ? AND project_id = ? AND producer_principal_id = ?
       AND producer_run_id = ? AND plane = 'codebase'
       AND resource_row_id = ? AND scope_snapshot_digest = ?`,
  ).get(
    input.principal.orgId,
    input.principal.projectId,
    input.principal.servicePrincipalId,
    input.feedback.producer_run_id,
    input.binding.resource_row_id,
    input.feedback.scope_snapshot_digest,
  ) as MemoryV2ScopeSnapshotRow | undefined;
  if (!row) {
    throw new MemoryV2CodeWriteError(
      "Feedback producer run does not have the required immutable scope snapshot",
      403,
      "resource_binding_mismatch",
    );
  }
  return row;
}

function assertLaterFeedbackTarget(input: {
  principal: MemoryV2RequestAuthorizationSnapshot & { projectId: string };
  feedback: MemoryFeedbackV2;
  binding: ResourceBindingV2;
  receiptId: string;
}): void {
  const target = db.prepare(
    `SELECT 1
     FROM memory_v2_retrieval_packs AS pack
     INNER JOIN memory_v2_retrieval_pack_items AS item
       ON item.retrieval_pack_id = pack.retrieval_pack_id
     WHERE pack.retrieval_pack_id = ?
       AND pack.org_id = ? AND pack.project_id = ? AND pack.principal_id = ?
       AND pack.plane = 'codebase' AND pack.resource_row_id = ?
       AND pack.scope_snapshot_digest = ?
       AND item.record_id = ? AND item.record_version = ?`,
  ).get(
    input.feedback.retrieval_pack_id,
    input.principal.orgId,
    input.principal.projectId,
    input.principal.servicePrincipalId,
    input.binding.resource_row_id,
    input.feedback.scope_snapshot_digest,
    input.feedback.record_id,
    input.feedback.record_version,
  );
  if (!target) {
    throw new MemoryV2CodeWriteError(
      "Feedback is outside the authenticated retrieval pack",
      422,
      "evidence_mismatch",
    );
  }
  for (const evidenceRef of input.feedback.outcome_evidence_refs) {
    const evidence = db.prepare(
      `SELECT 1
       FROM memory_evidence_manifests AS manifest
       INNER JOIN memory_evidence_refs AS ref
         ON ref.evidence_manifest_row_id = manifest.evidence_manifest_row_id
       WHERE manifest.receipt_id = ? AND ref.producer_ref_id = ?`,
    ).get(input.receiptId, evidenceRef);
    if (!evidence) {
      throw new MemoryV2CodeWriteError(
        "Feedback outcome evidence is unavailable in the named producer run",
        422,
        "evidence_unresolvable",
      );
    }
  }
}

function feedbackSignalTypes(
  disposition: MemoryFeedbackV2["disposition"],
): Array<"harmful_review" | "stale_review" | "checkout_anchor_revalidation"> {
  if (disposition === "harmful") return ["harmful_review"];
  if (disposition === "stale") return ["stale_review", "checkout_anchor_revalidation"];
  return [];
}

function insertFeedbackSignals(input: {
  principal: MemoryV2RequestAuthorizationSnapshot & { projectId: string };
  feedback: MemoryFeedbackV2;
  feedbackId: string;
  signals: Array<{
    signalId: string;
    signalType: "harmful_review" | "stale_review" | "checkout_anchor_revalidation";
  }>;
  now: string;
}): void {
  const record = db.prepare(
    `SELECT aggregate_version FROM memory_records
     WHERE org_id = ? AND project_id = ? AND record_id = ?`,
  ).get(
    input.principal.orgId,
    input.principal.projectId,
    input.feedback.record_id,
  ) as { aggregate_version: number } | undefined;
  if (!record) {
    throw new MemoryV2CodeWriteError(
      "Feedback record is unavailable",
      404,
      "resource_not_found",
    );
  }
  for (const signal of input.signals) {
    const jobType = signal.signalType === "checkout_anchor_revalidation"
      ? "record_revalidation"
      : "review_notification";
    const jobId = `job_${jobType}_${canonicalJsonSha256({
      signal_id: signal.signalId,
    }).slice(7, 39)}`;
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
      input.principal.orgId,
      input.principal.projectId,
      jobType,
      input.feedback.record_id,
      record.aggregate_version,
      JSON.stringify({
        feedback_source: "memory_v2_feedback_bindings",
        feedback_id: input.feedbackId,
        signal_id: signal.signalId,
      }),
      input.now,
      input.now,
      input.now,
    );
    db.prepare(
      `INSERT INTO memory_v2_feedback_review_signals
         (signal_id, org_id, project_id, feedback_id, record_id, record_version,
          signal_type, reason_code, status, outbox_job_id, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, NULL)`,
    ).run(
      signal.signalId,
      input.principal.orgId,
      input.principal.projectId,
      input.feedbackId,
      input.feedback.record_id,
      input.feedback.record_version,
      signal.signalType,
      input.feedback.reason_code,
      jobId,
      input.now,
    );
  }
}

export function appendAuthorizedCodeMemoryFeedbackV2(input: {
  authorization: AuthorizedMemoryV2ResourceContext;
  idempotencyKey: string;
  feedback: MemoryFeedbackV2;
  now?: string;
  dependencies?: MemoryV2CodeWriteDependencies;
}): MemoryFeedbackResultV2 {
  if (input.feedback.plane !== "codebase") {
    throw new MemoryV2CodeWriteError(
      "Harness feedback is outside the codebase write surface",
      403,
      "resource_binding_mismatch",
    );
  }
  const authority = authorityFromAuthorization(input.authorization, "feedback_write");
  if (authority.binding.resource_row_id !== input.feedback.resource_row_id) {
    throw new MemoryV2CodeWriteError(
      "Feedback target is unavailable",
      404,
      "resource_not_found",
    );
  }
  const requestDigest = canonicalJsonSha256(input.feedback);
  const existingClaim = findMemoryV2IdempotencyClaim({
    orgId: authority.principal.orgId,
    projectId: authority.principal.projectId,
    operation: MEMORY_V2_FEEDBACK_IDEMPOTENCY_OPERATION,
    idempotencyKey: input.idempotencyKey,
  });
  if (existingClaim) {
    return assertFeedbackReplay({
      claim: existingClaim,
      requestDigest,
      principal: authority.principal,
      feedback: input.feedback,
      binding: authority.binding,
    });
  }
  if (existingFeedbackBinding({
    orgId: authority.principal.orgId,
    projectId: authority.principal.projectId,
    feedback: input.feedback,
  })) {
    throw new MemoryV2CodeWriteError(
      "Feedback revision is already bound to another idempotency key",
      409,
      "idempotency_conflict",
    );
  }
  const snapshot = feedbackScopeSnapshot({
    principal: authority.principal,
    feedback: input.feedback,
    binding: authority.binding,
  });
  assertLaterFeedbackTarget({
    principal: authority.principal,
    feedback: input.feedback,
    binding: authority.binding,
    receiptId: snapshot.receipt_id,
  });
  const now = input.now ?? new Date().toISOString();
  try {
    return withImmediateTransaction(() => {
      const concurrentClaim = findMemoryV2IdempotencyClaim({
        orgId: authority.principal.orgId,
        projectId: authority.principal.projectId,
        operation: MEMORY_V2_FEEDBACK_IDEMPOTENCY_OPERATION,
        idempotencyKey: input.idempotencyKey,
      });
      if (concurrentClaim) {
        return assertFeedbackReplay({
          claim: concurrentClaim,
          requestDigest,
          principal: authority.principal,
          feedback: input.feedback,
          binding: authority.binding,
        });
      }
      const feedbackId = `feedback_v2_${randomUUID()}`;
      const signals = feedbackSignalTypes(input.feedback.disposition).map((signalType) => ({
        signalId: `review_v2_${randomUUID()}`,
        signalType,
      }));
      const result = parseMemoryContractV2("MemoryFeedbackResultV2", {
        schema_version: "pim.memory-feedback-result.v2",
        feedback_id: feedbackId,
        feedback_revision: input.feedback.feedback_revision,
        tenant: {
          organization_id: authority.principal.orgId,
          project_id: authority.principal.projectId,
        },
        plane: "codebase",
        resource_binding: authority.binding,
        duplicate: false,
        review_signal_ids: signals.map((signal) => signal.signalId),
      });
      const responseJson = JSON.stringify(result);
      input.dependencies?.beforeFeedbackBindingInsert?.();
      db.prepare(
        `INSERT INTO memory_v2_feedback_bindings
           (feedback_id, org_id, project_id, receipt_id, producer_principal_id,
            producer_run_id, feedback_stage, feedback_revision, retrieval_pack_id,
            record_id, record_version, plane, resource_row_id, scope_snapshot_digest,
            feedback_json, feedback_digest, response_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'later', ?, ?, ?, ?, 'codebase', ?, ?, ?, ?, ?, ?)`,
      ).run(
        feedbackId,
        authority.principal.orgId,
        authority.principal.projectId,
        snapshot.receipt_id,
        authority.principal.servicePrincipalId,
        input.feedback.producer_run_id,
        input.feedback.feedback_revision,
        input.feedback.retrieval_pack_id,
        input.feedback.record_id,
        input.feedback.record_version,
        authority.binding.resource_row_id,
        input.feedback.scope_snapshot_digest,
        JSON.stringify(input.feedback),
        requestDigest,
        responseJson,
        now,
      );
      insertFeedbackSignals({
        principal: authority.principal,
        feedback: input.feedback,
        feedbackId,
        signals,
        now,
      });
      insertMemoryV2IdempotencyClaim({
        orgId: authority.principal.orgId,
        projectId: authority.principal.projectId,
        operation: MEMORY_V2_FEEDBACK_IDEMPOTENCY_OPERATION,
        idempotencyKey: input.idempotencyKey,
        requestDigest,
        responseResourceType: "memory_v2_feedback_binding",
        responseResourceId: feedbackId,
        responseJson,
        now,
      });
      return result;
    });
  } catch (error) {
    return mapBindingError(error);
  }
}

export function appendCodeMemoryFeedbackV2(input: {
  principal: MemoryV2RequestAuthorizationSnapshot | null | undefined;
  idempotencyKey: string;
  feedback: MemoryFeedbackV2;
  now?: string;
  dependencies?: MemoryV2CodeWriteDependencies;
}): MemoryFeedbackResultV2 {
  return appendAuthorizedCodeMemoryFeedbackV2({
    authorization: authorizeCodeMemoryV2Operation({
      principal: input.principal,
      operation: "feedback_write",
      selector: exactResourceSelector(input.feedback.resource_row_id),
    }),
    idempotencyKey: input.idempotencyKey,
    feedback: input.feedback,
    ...(input.now ? { now: input.now } : {}),
    ...(input.dependencies ? { dependencies: input.dependencies } : {}),
  });
}

export function decideAuthorizedCodeMemoryCandidateV2(input: {
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
      plane: "codebase",
      candidateId: input.candidateId,
      decision: input.decision,
      ...(input.now ? { now: input.now } : {}),
    });
  } catch (error) {
    return mapBindingError(error);
  }
}

export function decideCodeMemoryCandidateV2(input: {
  principal: MemoryV2RequestAuthorizationSnapshot | null | undefined;
  candidateId: string;
  decision: MemoryCandidateDecisionV2;
  resourceSelector?: ResourceSelectorV2;
  now?: string;
}): MemoryCandidateDecisionResultV2 {
  const selector = input.resourceSelector
    ?? exactResourceSelector(input.decision.resource_row_id);
  return decideAuthorizedCodeMemoryCandidateV2({
    authorization: authorizeCodeMemoryV2Operation({
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
