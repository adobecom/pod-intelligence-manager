import { randomUUID } from "node:crypto";
import {
  canonicalJsonSha256,
  parseMemoryContract,
  parseMemoryContractV2,
  type MemoryCandidateDecisionResultV2,
  type MemoryCandidateDecisionV1,
  type MemoryCandidateDecisionV2,
  type MemoryCandidateStatusV1,
  type MemoryCandidateStatusV2,
  type MemoryReceiptFeedbackItemV2,
  type PimErrorV2,
  type ResourceBindingV2,
  type RunReceiptResultV2,
} from "@pim/shared";
import db, { withImmediateTransaction } from "../db/connection.js";
import {
  getMemoryCandidateStatus,
  getStoredMemoryCandidate,
} from "./memory-candidates.js";
import { decideMemoryCandidate } from "./memory-decisions.js";
import {
  acceptMemoryRunReceipt,
  type AcceptMemoryRunReceiptInput,
} from "./memory-receipts.js";
import {
  assertMemoryV2StoredCandidateFacet,
  assertMemoryV2StoredReceiptAggregateFacets,
} from "./memory-v2-canonical-writes.js";
import type { MemoryV2RequestAuthorizationSnapshot } from "./memory-v2-request-authorization.js";

export const MEMORY_V2_RECEIPT_IDEMPOTENCY_OPERATION = "memory_run_receipt_v2";
export const MEMORY_V2_FEEDBACK_IDEMPOTENCY_OPERATION = "memory_feedback_v2";
const MEMORY_V2_IDEMPOTENCY_TTL_MS = 365 * 86_400_000;

export type MemoryV2WritePlane = "codebase" | "harness";
type MemoryV2WriteErrorCode = PimErrorV2["code"];
type ProjectPrincipal = MemoryV2RequestAuthorizationSnapshot & { readonly projectId: string };

export class MemoryV2WriteCoreError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: MemoryV2WriteErrorCode,
    readonly details: Array<{ path: string; reason: string }> = [],
  ) {
    super(message);
    this.name = "MemoryV2WriteCoreError";
  }
}

export interface MemoryV2IdempotencyClaimRow {
  request_digest: string;
  response_resource_type: string;
  response_resource_id: string;
  response_json: string;
}

export interface MemoryV2ScopeSnapshotRow {
  receipt_id: string;
  org_id: string;
  project_id: string;
  plane: MemoryV2WritePlane;
  resource_row_id: string;
  producer_principal_id: string;
  producer_run_id: string;
  request_digest: string;
  core_request_digest: string;
  scope_snapshot_json: string;
  scope_snapshot_digest: string;
  response_json: string;
  created_at: string;
}

export interface MemoryV2ReceiptCandidateBinding {
  clientCandidateId: string;
  candidateId: string;
}

interface MemoryV2CandidateFacetRow {
  resource_row_id: string;
  broad_kind: string;
  subtype: string | null;
  projection_status: string;
}

export function memoryV2CanonicalValuesEqual(left: unknown, right: unknown): boolean {
  return canonicalJsonSha256(left) === canonicalJsonSha256(right);
}

export function memoryV2RequestDigest(value: unknown): string {
  return canonicalJsonSha256(value);
}

export function memoryV2ScopeSnapshotDigest(
  scopeSnapshot: { readonly scope_snapshot_digest: string } & Readonly<Record<string, unknown>>,
): string {
  const { scope_snapshot_digest: _embedded, ...body } = scopeSnapshot;
  return canonicalJsonSha256(body);
}

export function memoryV2CandidateStatusValue(
  status: MemoryCandidateStatusV1["status"],
): MemoryCandidateStatusV2["status"] {
  if (status === "received") return "accepted";
  if (status === "validating") return "validating";
  if (status === "pending_merge") return "pending_evidence";
  if (status === "pending_review") return "pending_review";
  if (status === "active") return "active";
  if (status === "rejected" || status === "quarantined") return "rejected";
  return "failed";
}

function memoryV2CandidateTransitionStatusValue(status: string | null): string | null {
  if (status === null) return null;
  if (status === "received") return "accepted";
  if (status === "validating") return "validating";
  if (status === "pending_merge") return "pending_evidence";
  if (status === "pending_review") return "pending_review";
  if (status === "active") return "active";
  if (status === "rejected" || status === "quarantined") return "rejected";
  if (status === "validation_failed" || status === "activation_failed") return "failed";
  return status;
}

export function memoryV2CandidateTransitionValue(
  transition: MemoryCandidateStatusV1["latest_transition"],
): MemoryCandidateStatusV1["latest_transition"] {
  return {
    ...transition,
    from_status: memoryV2CandidateTransitionStatusValue(transition.from_status),
    to_status: memoryV2CandidateTransitionStatusValue(transition.to_status)!,
  };
}

export function getMemoryV2AuthorizedCandidate(input: {
  orgId: string;
  projectId: string;
  plane: MemoryV2WritePlane;
  resourceRowId: string;
  candidateId: string;
  assertClosure?: boolean;
}): {
  stored: NonNullable<ReturnType<typeof getStoredMemoryCandidate>>;
  status: NonNullable<ReturnType<typeof getMemoryCandidateStatus>>;
  facet: MemoryV2CandidateFacetRow;
} {
  const stored = getStoredMemoryCandidate(input.orgId, input.projectId, input.candidateId);
  const status = getMemoryCandidateStatus(input.orgId, input.projectId, input.candidateId);
  const facet = db.prepare(
    `SELECT resource_row_id, broad_kind, subtype, projection_status
     FROM memory_v2_candidate_facets
     WHERE candidate_id = ? AND org_id = ? AND project_id = ? AND plane = ?`,
  ).get(input.candidateId, input.orgId, input.projectId, input.plane) as
    | MemoryV2CandidateFacetRow
    | undefined;
  const wrongSubtype = input.plane === "codebase" ? facet?.subtype !== null : !facet?.subtype;
  if (!stored || !status || stored.candidate.plane !== input.plane || !facet
      || facet.resource_row_id !== input.resourceRowId
      || facet.broad_kind !== stored.candidate.kind
      || facet.projection_status !== "mapped"
      || wrongSubtype) {
    throw new MemoryV2WriteCoreError(
      "Memory candidate is unavailable",
      404,
      "resource_not_found",
    );
  }
  if (input.assertClosure !== false) assertMemoryV2StoredCandidateFacet(input.candidateId);
  return { stored, status, facet };
}

export function findMemoryV2IdempotencyClaim(input: {
  orgId: string;
  projectId: string;
  operation: string;
  idempotencyKey: string;
}): MemoryV2IdempotencyClaimRow | null {
  return (db.prepare(
    `SELECT request_digest, response_resource_type, response_resource_id, response_json
     FROM memory_idempotency_keys
     WHERE org_id = ? AND project_id = ? AND operation = ? AND idempotency_key = ?`,
  ).get(input.orgId, input.projectId, input.operation, input.idempotencyKey) as
    | MemoryV2IdempotencyClaimRow
    | undefined) ?? null;
}

export function insertMemoryV2IdempotencyClaim(input: {
  orgId: string;
  projectId: string;
  operation: string;
  idempotencyKey: string;
  requestDigest: string;
  responseResourceType: string;
  responseResourceId: string;
  responseJson: string;
  now: string;
}): void {
  db.prepare(
    `INSERT INTO memory_idempotency_keys
       (org_id, project_id, operation, idempotency_key, request_digest,
        response_resource_type, response_resource_id, response_json, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.orgId,
    input.projectId,
    input.operation,
    input.idempotencyKey,
    input.requestDigest,
    input.responseResourceType,
    input.responseResourceId,
    input.responseJson,
    input.now,
    new Date(Date.parse(input.now) + MEMORY_V2_IDEMPOTENCY_TTL_MS).toISOString(),
  );
}

export function getMemoryV2ScopeSnapshotByReceipt(
  receiptId: string,
): MemoryV2ScopeSnapshotRow | null {
  return (db.prepare(
    "SELECT * FROM memory_v2_scope_snapshots WHERE receipt_id = ?",
  ).get(receiptId) as MemoryV2ScopeSnapshotRow | undefined) ?? null;
}

export function getMemoryV2ReceiptCandidateBindings(
  receiptId: string,
): MemoryV2ReceiptCandidateBinding[] {
  return (db.prepare(
    `SELECT client_candidate_id, candidate_id FROM memory_receipt_candidates
     WHERE receipt_id = ? ORDER BY client_candidate_id, candidate_id`,
  ).all(receiptId) as unknown as Array<{
    client_candidate_id: string;
    candidate_id: string;
  }>).map((row) => ({
    clientCandidateId: row.client_candidate_id,
    candidateId: row.candidate_id,
  }));
}

function assertMemoryV2ProducerRunAvailable(input: {
  orgId: string;
  projectId: string;
  producerRunId: string;
}): void {
  const existing = db.prepare(
    `SELECT 1 FROM memory_v2_scope_snapshots
     WHERE org_id = ? AND project_id = ? AND producer_run_id = ?`,
  ).get(input.orgId, input.projectId, input.producerRunId);
  if (existing) {
    throw new MemoryV2WriteCoreError(
      "Producer run is already bound to another receipt",
      409,
      "idempotency_conflict",
    );
  }
}

function assertMemoryV2ReceiptFeedbackReplay(input: {
  receiptId: string;
  responseJson: string;
  feedback: readonly MemoryReceiptFeedbackItemV2[];
}): void {
  const stored = db.prepare(
    `SELECT retrieval_pack_id, record_id, record_version, feedback_json,
            feedback_digest, response_json
     FROM memory_v2_feedback_bindings
     WHERE receipt_id = ? AND feedback_stage = 'receipt'
     ORDER BY retrieval_pack_id, record_id, record_version`,
  ).all(input.receiptId) as unknown as Array<{
    retrieval_pack_id: string;
    record_id: string;
    record_version: number;
    feedback_json: string;
    feedback_digest: string;
    response_json: string;
  }>;
  const expected = input.feedback.map((feedback) => ({
    retrieval_pack_id: feedback.retrieval_pack_id,
    record_id: feedback.record_id,
    record_version: feedback.record_version,
    feedback_json: JSON.stringify(feedback),
    feedback_digest: canonicalJsonSha256(feedback),
    response_json: input.responseJson,
  })).sort((left, right) => (
    `${left.retrieval_pack_id}\0${left.record_id}\0${left.record_version}`
      .localeCompare(`${right.retrieval_pack_id}\0${right.record_id}\0${right.record_version}`)
  ));
  if (!memoryV2CanonicalValuesEqual(stored, expected)) {
    throw new MemoryV2WriteCoreError(
      "Stored receipt feedback is unavailable",
      503,
      "temporarily_unavailable",
    );
  }
}

export function assertMemoryV2ReceiptFeedbackTargets(input: {
  principal: ProjectPrincipal;
  binding: Readonly<ResourceBindingV2>;
  plane: MemoryV2WritePlane;
  feedback: readonly MemoryReceiptFeedbackItemV2[];
}): void {
  const seen = new Set<string>();
  for (const feedback of input.feedback) {
    const identity = `${feedback.retrieval_pack_id}\0${feedback.record_id}\0${feedback.record_version}`;
    if (seen.has(identity)) {
      throw new MemoryV2WriteCoreError(
        "Receipt feedback contains a duplicate pack and record version",
        400,
        "schema_invalid",
      );
    }
    seen.add(identity);
    const target = db.prepare(
      `SELECT 1
       FROM memory_v2_retrieval_packs AS pack
       INNER JOIN memory_v2_retrieval_pack_items AS item
         ON item.retrieval_pack_id = pack.retrieval_pack_id
       WHERE pack.retrieval_pack_id = ?
         AND pack.org_id = ? AND pack.project_id = ? AND pack.principal_id = ?
         AND pack.plane = ? AND pack.resource_row_id = ?
         AND pack.scope_snapshot_digest = ?
         AND item.record_id = ? AND item.record_version = ?`,
    ).get(
      feedback.retrieval_pack_id,
      input.principal.orgId,
      input.principal.projectId,
      input.principal.servicePrincipalId,
      input.plane,
      input.binding.resource_row_id,
      feedback.scope_snapshot_digest,
      feedback.record_id,
      feedback.record_version,
    );
    if (!target) {
      throw new MemoryV2WriteCoreError(
        "Receipt feedback is outside the authenticated retrieval pack",
        422,
        "evidence_mismatch",
      );
    }
  }
}

function insertMemoryV2ReceiptFeedback(input: {
  principal: ProjectPrincipal;
  binding: Readonly<ResourceBindingV2>;
  plane: MemoryV2WritePlane;
  receiptId: string;
  producerRunId: string;
  responseJson: string;
  feedback: readonly MemoryReceiptFeedbackItemV2[];
  now: string;
}): void {
  const statement = db.prepare(
    `INSERT INTO memory_v2_feedback_bindings
       (feedback_id, org_id, project_id, receipt_id, producer_principal_id,
        producer_run_id, feedback_stage, feedback_revision, retrieval_pack_id,
        record_id, record_version, plane, resource_row_id, scope_snapshot_digest,
        feedback_json, feedback_digest, response_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'receipt', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const feedback of input.feedback) {
    statement.run(
      `feedback_v2_${randomUUID()}`,
      input.principal.orgId,
      input.principal.projectId,
      input.receiptId,
      input.principal.servicePrincipalId,
      input.producerRunId,
      feedback.retrieval_pack_id,
      feedback.record_id,
      feedback.record_version,
      input.plane,
      input.binding.resource_row_id,
      feedback.scope_snapshot_digest,
      JSON.stringify(feedback),
      canonicalJsonSha256(feedback),
      input.responseJson,
      input.now,
    );
  }
}

interface MemoryV2ReceiptWriteContext {
  principal: ProjectPrincipal;
  binding: Readonly<ResourceBindingV2>;
  plane: MemoryV2WritePlane;
  producerRunId: string;
  idempotencyKey: string;
  requestDigest: string;
  scopeSnapshot: { readonly scope_snapshot_digest: string };
  feedback: readonly MemoryReceiptFeedbackItemV2[];
  now: string;
}

export interface MemoryV2ReplayVerificationInput {
  row: MemoryV2ScopeSnapshotRow;
  result: RunReceiptResultV2;
  candidateBindings: readonly MemoryV2ReceiptCandidateBinding[];
}

function replayMemoryV2Receipt(input: MemoryV2ReceiptWriteContext & {
  verifyReplay?: (input: MemoryV2ReplayVerificationInput) => void;
}): RunReceiptResultV2 | null {
  const claim = findMemoryV2IdempotencyClaim({
    orgId: input.principal.orgId,
    projectId: input.principal.projectId,
    operation: MEMORY_V2_RECEIPT_IDEMPOTENCY_OPERATION,
    idempotencyKey: input.idempotencyKey,
  });
  if (!claim) return null;
  if (claim.request_digest !== input.requestDigest
      || claim.response_resource_type !== "memory_v2_scope_snapshot") {
    throw new MemoryV2WriteCoreError(
      "Idempotency key was reused with different receipt content",
      409,
      "idempotency_conflict",
    );
  }
  const row = getMemoryV2ScopeSnapshotByReceipt(claim.response_resource_id);
  if (!row || row.plane !== input.plane
      || row.org_id !== input.principal.orgId
      || row.project_id !== input.principal.projectId
      || row.producer_principal_id !== input.principal.servicePrincipalId
      || row.producer_run_id !== input.producerRunId
      || row.resource_row_id !== input.binding.resource_row_id
      || row.scope_snapshot_digest !== input.scopeSnapshot.scope_snapshot_digest
      || row.request_digest !== input.requestDigest
      || row.response_json !== claim.response_json) {
    throw new MemoryV2WriteCoreError(
      "Stored receipt replay no longer matches its immutable scope",
      409,
      "idempotency_conflict",
    );
  }
  let original: RunReceiptResultV2;
  let candidateBindings: MemoryV2ReceiptCandidateBinding[];
  try {
    assertMemoryV2StoredReceiptAggregateFacets(row.receipt_id);
    original = parseMemoryContractV2(
      "RunReceiptResultV2",
      JSON.parse(row.response_json) as unknown,
    );
    candidateBindings = getMemoryV2ReceiptCandidateBindings(row.receipt_id);
    for (const candidate of original.candidate_results) {
      assertMemoryV2StoredCandidateFacet(candidate.candidate_id);
    }
    assertMemoryV2ReceiptFeedbackReplay({
      receiptId: row.receipt_id,
      responseJson: row.response_json,
      feedback: input.feedback,
    });
  } catch (error) {
    if (error instanceof MemoryV2WriteCoreError) throw error;
    throw new MemoryV2WriteCoreError(
      "Stored receipt replay is unavailable",
      503,
      "temporarily_unavailable",
    );
  }
  input.verifyReplay?.({ row, result: original, candidateBindings });
  return parseMemoryContractV2("RunReceiptResultV2", {
    ...original,
    status: "replayed",
    duplicate: true,
  });
}

export function beginMemoryV2ReceiptWrite(input: Omit<
  MemoryV2ReceiptWriteContext,
  "requestDigest" | "now"
> & {
  receipt: unknown;
  now?: string;
  verifyReplay?: (input: MemoryV2ReplayVerificationInput) => void;
}): {
  context: MemoryV2ReceiptWriteContext;
  replayed: RunReceiptResultV2 | null;
} {
  const context: MemoryV2ReceiptWriteContext = {
    principal: input.principal,
    binding: input.binding,
    plane: input.plane,
    producerRunId: input.producerRunId,
    idempotencyKey: input.idempotencyKey,
    requestDigest: memoryV2RequestDigest(input.receipt),
    scopeSnapshot: input.scopeSnapshot,
    feedback: input.feedback,
    now: input.now ?? new Date().toISOString(),
  };
  const replayed = replayMemoryV2Receipt({ ...context, verifyReplay: input.verifyReplay });
  if (!replayed) {
    assertMemoryV2ReceiptFeedbackTargets(input);
    assertMemoryV2ProducerRunAvailable({
      orgId: context.principal.orgId,
      projectId: context.principal.projectId,
      producerRunId: context.producerRunId,
    });
  }
  return { context, replayed };
}

export function commitMemoryV2ReceiptWrite<Effect>(input: {
  context: MemoryV2ReceiptWriteContext;
  canonicalReceipt: AcceptMemoryRunReceiptInput;
  expectedReceiptId?: string;
  projectCandidate: (candidateId: string) => MemoryCandidateStatusV2;
  verifyReplay?: (input: MemoryV2ReplayVerificationInput) => void;
  beforeScopeSnapshotInsert?: () => void;
  beforeFeedbackBindingInsert?: () => void;
  beforePlaneSpecificInsert?: () => void;
  persistPlaneSpecific: (input: {
    receiptId: string;
    responseJson: string;
    candidateBindings: readonly MemoryV2ReceiptCandidateBinding[];
  }) => Effect;
  replayEffect: () => Effect;
}): { result: RunReceiptResultV2; effect: Effect } {
  return withImmediateTransaction(() => {
    const replayed = replayMemoryV2Receipt({
      ...input.context,
      verifyReplay: input.verifyReplay,
    });
    if (replayed) return { result: replayed, effect: input.replayEffect() };
    assertMemoryV2ProducerRunAvailable({
      orgId: input.context.principal.orgId,
      projectId: input.context.principal.projectId,
      producerRunId: input.context.producerRunId,
    });
    assertMemoryV2ReceiptFeedbackTargets(input.context);
    const accepted = acceptMemoryRunReceipt(input.canonicalReceipt);
    if (!accepted.created
        || (input.expectedReceiptId !== undefined
          && accepted.result.receipt_id !== input.expectedReceiptId)) {
      throw new MemoryV2WriteCoreError(
        "An existing canonical receipt lacks its v2 scope claim",
        409,
        "idempotency_conflict",
      );
    }
    const receiptId = accepted.result.receipt_id;
    const candidateBindings = getMemoryV2ReceiptCandidateBindings(receiptId);
    const result = parseMemoryContractV2("RunReceiptResultV2", {
      schema_version: "pim.run-receipt-result.v2",
      receipt_id: receiptId,
      producer_run_id: input.context.producerRunId,
      request_digest: input.context.requestDigest,
      tenant: {
        organization_id: input.context.principal.orgId,
        project_id: input.context.principal.projectId,
      },
      plane: input.context.plane,
      resource_binding: structuredClone(input.context.binding),
      scope_snapshot_digest: input.context.scopeSnapshot.scope_snapshot_digest,
      status: "accepted",
      duplicate: false,
      candidate_results: candidateBindings.map((binding) => (
        input.projectCandidate(binding.candidateId)
      )),
    });
    const responseJson = JSON.stringify(result);
    input.beforeScopeSnapshotInsert?.();
    db.prepare(
      `INSERT INTO memory_v2_scope_snapshots
         (receipt_id, org_id, project_id, plane, resource_row_id,
          producer_principal_id, producer_run_id, request_digest, core_request_digest,
          scope_snapshot_json, scope_snapshot_digest, response_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      receiptId,
      input.context.principal.orgId,
      input.context.principal.projectId,
      input.context.plane,
      input.context.binding.resource_row_id,
      input.context.principal.servicePrincipalId,
      input.context.producerRunId,
      input.context.requestDigest,
      accepted.result.request_digest,
      JSON.stringify(input.context.scopeSnapshot),
      input.context.scopeSnapshot.scope_snapshot_digest,
      responseJson,
      input.context.now,
    );
    input.beforeFeedbackBindingInsert?.();
    insertMemoryV2ReceiptFeedback({
      ...input.context,
      receiptId,
      responseJson,
    });
    input.beforePlaneSpecificInsert?.();
    const effect = input.persistPlaneSpecific({ receiptId, responseJson, candidateBindings });
    for (const binding of candidateBindings) {
      assertMemoryV2StoredCandidateFacet(binding.candidateId);
    }
    insertMemoryV2IdempotencyClaim({
      orgId: input.context.principal.orgId,
      projectId: input.context.principal.projectId,
      operation: MEMORY_V2_RECEIPT_IDEMPOTENCY_OPERATION,
      idempotencyKey: input.context.idempotencyKey,
      requestDigest: input.context.requestDigest,
      responseResourceType: "memory_v2_scope_snapshot",
      responseResourceId: receiptId,
      responseJson,
      now: input.context.now,
    });
    return { result, effect };
  });
}

export function decideAuthorizedMemoryV2Candidate(input: {
  principal: ProjectPrincipal;
  binding: Readonly<ResourceBindingV2>;
  plane: MemoryV2WritePlane;
  candidateId: string;
  decision: MemoryCandidateDecisionV2;
  now?: string;
}): MemoryCandidateDecisionResultV2 {
  if (input.decision.plane !== input.plane) {
    throw new MemoryV2WriteCoreError(
      "Review is outside the authorized memory plane",
      403,
      "resource_binding_mismatch",
    );
  }
  if (input.decision.explanation.length > 1_000) {
    throw new MemoryV2WriteCoreError(
      "Decision explanation cannot be represented by the canonical candidate ledger",
      409,
      "transition_invalid",
      [{ path: "/explanation", reason: "canonical decision limit is 1000 characters" }],
    );
  }
  if (input.decision.evidence_refs.length > 64) {
    throw new MemoryV2WriteCoreError(
      "Decision evidence cannot be represented by the canonical candidate ledger",
      409,
      "transition_invalid",
      [{ path: "/evidence_refs", reason: "canonical decision limit is 64 references" }],
    );
  }
  if (input.binding.resource_row_id !== input.decision.resource_row_id) {
    throw new MemoryV2WriteCoreError("Memory candidate is unavailable", 404, "resource_not_found");
  }
  getMemoryV2AuthorizedCandidate({
    orgId: input.principal.orgId,
    projectId: input.principal.projectId,
    plane: input.plane,
    resourceRowId: input.binding.resource_row_id,
    candidateId: input.candidateId,
  });
  const existing = db.prepare(
    `SELECT 1 FROM memory_candidate_decisions
     WHERE org_id = ? AND project_id = ? AND candidate_id = ?
       AND reviewer_principal_id = ? AND decision_revision = ?`,
  ).get(
    input.principal.orgId,
    input.principal.projectId,
    input.candidateId,
    input.principal.servicePrincipalId,
    input.decision.decision_revision,
  );
  const v1Decision = parseMemoryContract("MemoryCandidateDecisionV1", {
    schema_version: "pim.memory-candidate-decision.v1",
    decision_revision: input.decision.decision_revision,
    decision: input.decision.decision,
    reason_code: input.decision.reason_code,
    explanation: input.decision.explanation,
    evidence_refs: input.decision.evidence_refs,
    event_time: input.decision.event_time,
  }) as MemoryCandidateDecisionV1;
  const decided = decideMemoryCandidate({
    orgId: input.principal.orgId,
    projectId: input.principal.projectId,
    candidateId: input.candidateId,
    reviewerId: input.principal.servicePrincipalId,
    decision: v1Decision,
    now: input.now,
  });
  if (!decided) {
    throw new MemoryV2WriteCoreError("Memory candidate is unavailable", 404, "resource_not_found");
  }
  return parseMemoryContractV2("MemoryCandidateDecisionResultV2", {
    schema_version: "pim.memory-candidate-decision-result.v2",
    decision_id: decided.decision_id,
    candidate_id: decided.candidate_id,
    decision_revision: decided.decision_revision,
    tenant: {
      organization_id: input.principal.orgId,
      project_id: input.principal.projectId,
    },
    plane: input.plane,
    resource_binding: structuredClone(input.binding),
    decision: decided.decision,
    candidate_status: decided.candidate_status,
    active_record: decided.active_record ?? null,
    duplicate: Boolean(existing) || decided.duplicate,
  });
}
