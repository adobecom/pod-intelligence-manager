import {
  MemoryContractValidationError,
  parseMemoryContractV2,
  type CodebaseRunReceiptV2,
  type HarnessRunReceiptV2,
  type MemoryCandidateDecisionV2,
  type MemoryFeedbackV2,
  type MemoryPlaneV2,
  type ResourceSelectorV2,
  type RunReceiptV2,
} from "@pim/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { sendMemoryV2Error } from "../middleware/memory-errors.js";
import {
  appendAuthorizedCodeMemoryFeedbackV2,
  authorizeCodeMemoryCandidateStatusV2,
  authorizeCodeMemoryV2Operation,
  decideAuthorizedCodeMemoryCandidateV2,
  getAuthorizedCodeMemoryCandidateStatusV2,
  MemoryV2CodeWriteError,
  submitAuthorizedCodeMemoryRunReceiptV2,
} from "../services/memory-v2-code-write.js";
import {
  authorizeHarnessMemoryCandidateStatusV2,
  authorizeHarnessMemoryV2Operation,
  decideAuthorizedHarnessMemoryCandidateV2,
  getAuthorizedHarnessMemoryCandidateStatusV2,
  MemoryV2HarnessWriteError,
  submitAuthorizedHarnessMemoryRunReceiptV2,
} from "../services/memory-v2-harness-write.js";
import { scanMemoryV2Input } from "../services/memory-v2-input-safety.js";
import { recordMemoryMetric } from "../services/memory-metrics.js";
import type { MemoryV2RequestAuthorizationSnapshot } from "../services/memory-v2-request-authorization.js";

const MAX_RECEIPT_BYTES = 256 * 1024;
const MAX_CANDIDATE_BYTES = 32 * 1024;
const MAX_FEEDBACK_BYTES = 32 * 1024;
const MAX_DECISION_BYTES = 16 * 1024;
export const MEMORY_V2_PATH_PARAM_MAX_LENGTH = 256;
const MAX_PRODUCER_RUN_ID_LENGTH = MEMORY_V2_PATH_PARAM_MAX_LENGTH;
const MAX_CANDIDATE_ID_LENGTH = 128;
const MAX_RECEIPT_ID_LENGTH = 128;
const MAX_RESOURCE_ROW_ID_LENGTH = 128;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

type CodeWriteOperation = "receipt_write" | "feedback_write" | "candidate_read" | "review";
type CodeWriteOutcome = "success" | "replay" | "rejected" | "error";

function servicePrincipal(request: FastifyRequest): MemoryV2RequestAuthorizationSnapshot | null {
  return request.memoryV2Authorization ?? null;
}

function privateResponseHeaders(reply: FastifyReply): void {
  reply.header("Cache-Control", "private, no-store");
  reply.header("Vary", "Authorization");
}

function statusClass(statusCode: number): string {
  return statusCode >= 500 ? "5xx" : statusCode >= 400 ? "4xx" : "2xx";
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function rawPlane(value: unknown): MemoryPlaneV2 | undefined {
  const plane = objectValue(value)?.plane;
  return plane === "codebase" || plane === "harness"
    ? plane
    : undefined;
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

function harnessCandidateSelector(query: Record<string, unknown>): {
  receiptId: string;
  producerRunId: string;
  resourceSelector: Exclude<ResourceSelectorV2, null>;
} | null {
  const allowed = new Set([
    "plane",
    "receipt_id",
    "producer_run_id",
    "resource_row_id",
    "canonical_resource_id",
  ]);
  if (Object.keys(query).some((key) => !allowed.has(key)) || query.plane !== "harness") {
    return null;
  }
  const receiptId = query.receipt_id;
  const producerRunId = query.producer_run_id;
  const resourceRowId = query.resource_row_id;
  const canonicalResourceId = query.canonical_resource_id;
  if (typeof receiptId !== "string" || receiptId.length < 1
      || receiptId.length > MAX_RECEIPT_ID_LENGTH
      || typeof producerRunId !== "string" || producerRunId.length < 1
      || producerRunId.length > MAX_PRODUCER_RUN_ID_LENGTH
      || Number(typeof resourceRowId === "string")
        + Number(typeof canonicalResourceId === "string") !== 1) {
    return null;
  }
  if (typeof resourceRowId === "string") {
    return resourceRowId.length >= 1 && resourceRowId.length <= MAX_RESOURCE_ROW_ID_LENGTH
      ? { receiptId, producerRunId, resourceSelector: { resource_row_id: resourceRowId } }
      : null;
  }
  return typeof canonicalResourceId === "string"
      && canonicalResourceId.length >= 1
      && canonicalResourceId.length <= MEMORY_V2_PATH_PARAM_MAX_LENGTH
    ? { receiptId, producerRunId, resourceSelector: { canonical_resource_id: canonicalResourceId } }
    : null;
}

function recordCodeWriteOutcome(input: {
  startedAt: number;
  operation: CodeWriteOperation;
  outcome: CodeWriteOutcome;
  reason: string;
  statusCode: number;
  principal: MemoryV2RequestAuthorizationSnapshot | null;
  plane?: MemoryPlaneV2 | "unresolved";
  producerRunId?: string;
  candidateId?: string;
  receiptId?: string;
  feedbackId?: string;
  resourceRowId?: string;
}): void {
  const plane = input.plane ?? "codebase";
  const dimensions = {
    transport: "direct_http",
    operation: input.operation,
    plane,
    resource_type: plane === "codebase"
      ? "repository"
      : plane === "harness"
        ? "harness"
        : "unresolved",
    contract_version: "pim.memory.v2",
    outcome: input.outcome,
    reason: input.reason,
    status: statusClass(input.statusCode),
  };
  const fields = {
    ...(input.principal ? {
      service_principal_id: input.principal.servicePrincipalId,
      organization_id: input.principal.orgId,
      ...(input.principal.projectId ? { project_id: input.principal.projectId } : {}),
    } : {}),
    ...(input.producerRunId ? { producer_run_id: input.producerRunId } : {}),
    ...(input.candidateId ? { candidate_id: input.candidateId } : {}),
    ...(input.receiptId ? { receipt_id: input.receiptId } : {}),
    ...(input.feedbackId ? { feedback_id: input.feedbackId } : {}),
    ...(input.resourceRowId ? { resource_row_id: input.resourceRowId } : {}),
  };
  recordMemoryMetric({
    name: "MemoryOperationOutcome",
    value: 1,
    unit: "Count",
    dimensions,
    fields,
  });
  recordMemoryMetric({
    name: "MemoryOperationLatency",
    value: Math.max(0, Date.now() - input.startedAt),
    unit: "Milliseconds",
    dimensions,
    fields,
  });
}

function sendWriteFailure(input: {
  error: unknown;
  reply: FastifyReply;
  startedAt: number;
  operation: CodeWriteOperation;
  principal: MemoryV2RequestAuthorizationSnapshot | null;
  plane?: MemoryPlaneV2;
  producerRunId?: string;
  candidateId?: string;
}): false {
  const known = input.error instanceof MemoryV2CodeWriteError
    || input.error instanceof MemoryV2HarnessWriteError
    ? input.error
    : null;
  const statusCode = known?.statusCode ?? 500;
  const code = known?.code ?? "temporarily_unavailable";
  recordCodeWriteOutcome({
    startedAt: input.startedAt,
    operation: input.operation,
    outcome: statusCode >= 500 ? "error" : "rejected",
    reason: code,
    statusCode,
    principal: input.principal,
    plane: input.plane,
    producerRunId: input.producerRunId,
    candidateId: input.candidateId,
  });
  return sendMemoryV2Error(
    input.reply,
    statusCode,
    code,
    statusCode >= 500
      ? "Memory service is temporarily unavailable"
      : known?.message ?? "Memory request was rejected",
    {
      plane: input.plane ?? "codebase",
      retryable: statusCode >= 500,
      details: known && statusCode < 500 ? known.details : [],
    },
  );
}

function rejectRequest(input: {
  reply: FastifyReply;
  startedAt: number;
  operation: CodeWriteOperation;
  principal: MemoryV2RequestAuthorizationSnapshot | null;
  statusCode: number;
  code: "contract_version_unsupported" | "schema_invalid";
  message: string;
  plane?: MemoryPlaneV2 | "unresolved";
  producerRunId?: string;
  candidateId?: string;
  details?: Array<{ path: string; reason: string }>;
}): false {
  recordCodeWriteOutcome({
    startedAt: input.startedAt,
    operation: input.operation,
    outcome: "rejected",
    reason: input.code,
    statusCode: input.statusCode,
    principal: input.principal,
    plane: input.plane,
    producerRunId: input.producerRunId,
    candidateId: input.candidateId,
  });
  return sendMemoryV2Error(
    input.reply,
    input.statusCode,
    input.code,
    input.message,
    {
      plane: input.plane === "unresolved" ? null : input.plane ?? "codebase",
      retryable: false,
      details: input.details ?? [],
    },
  );
}

function validateIdempotencyKey(input: {
  value: unknown;
  reply: FastifyReply;
  startedAt: number;
  operation: "receipt_write" | "feedback_write";
  principal: MemoryV2RequestAuthorizationSnapshot | null;
  plane?: MemoryPlaneV2 | "unresolved";
  producerRunId?: string;
}): string | null {
  if (typeof input.value === "string" && IDEMPOTENCY_KEY_PATTERN.test(input.value)) {
    return input.value;
  }
  rejectRequest({
    reply: input.reply,
    startedAt: input.startedAt,
    operation: input.operation,
    principal: input.principal,
    statusCode: 400,
    code: "schema_invalid",
    message: "A valid Idempotency-Key header is required",
    plane: input.plane,
    producerRunId: input.producerRunId,
    details: [{
      path: "/headers/idempotency-key",
      reason: "required 1 to 128 character idempotency key",
    }],
  });
  return null;
}

function validateSafety(input: {
  body: unknown;
  reply: FastifyReply;
  startedAt: number;
  operation: "receipt_write" | "feedback_write" | "review";
  principal: MemoryV2RequestAuthorizationSnapshot | null;
  plane?: MemoryPlaneV2 | "unresolved";
  producerRunId?: string;
  candidateId?: string;
}): boolean {
  const safety = scanMemoryV2Input(input.body);
  if (safety.clean) return true;
  rejectRequest({
    reply: input.reply,
    startedAt: input.startedAt,
    operation: input.operation,
    principal: input.principal,
    statusCode: 422,
    code: "schema_invalid",
    message: "Request contains prohibited content",
    plane: input.plane,
    producerRunId: input.producerRunId,
    candidateId: input.candidateId,
    details: [{
      path: safety.path ?? "/",
      reason: safety.reason ?? "prohibited content",
    }],
  });
  return false;
}

function parseContract<T>(input: {
  name: "RunReceiptV2" | "MemoryFeedbackV2" | "MemoryCandidateDecisionV2";
  expectedVersion: string;
  body: unknown;
  reply: FastifyReply;
  startedAt: number;
  operation: "receipt_write" | "feedback_write" | "review";
  principal: MemoryV2RequestAuthorizationSnapshot | null;
  plane?: MemoryPlaneV2 | "unresolved";
  producerRunId?: string;
  candidateId?: string;
}): T | null {
  if (objectValue(input.body)?.schema_version !== input.expectedVersion) {
    rejectRequest({
      ...input,
      statusCode: 400,
      code: "contract_version_unsupported",
      message: `Supported schema is ${input.expectedVersion}`,
    });
    return null;
  }
  try {
    return parseMemoryContractV2(input.name, input.body) as T;
  } catch (error) {
    if (!(error instanceof MemoryContractValidationError)) throw error;
    rejectRequest({
      ...input,
      statusCode: 400,
      code: "schema_invalid",
      message: `Request does not match ${input.expectedVersion}`,
      details: error.issues,
    });
    return null;
  }
}

export default async function memoryV2WriteRoutes(app: FastifyInstance): Promise<void> {
  app.put<{
    Params: { producer_run_id: string };
    Body: unknown;
    Querystring: Record<string, unknown>;
    Headers: { "idempotency-key"?: string };
  }>(
    "/api/v2/memory/run-receipts/:producer_run_id",
    { bodyLimit: MAX_RECEIPT_BYTES },
    async (request, reply) => {
      privateResponseHeaders(reply);
      const startedAt = Date.now();
      const principal = servicePrincipal(request);
      const producerRunId = request.params.producer_run_id;
      const plane = rawPlane(request.body) ?? "unresolved";
      if (!producerRunId || producerRunId.length > MAX_PRODUCER_RUN_ID_LENGTH) {
        return rejectRequest({
          reply,
          startedAt,
          operation: "receipt_write",
          principal,
          statusCode: 400,
          code: "schema_invalid",
          message: "producer_run_id must contain 1 to 256 characters",
          plane,
          details: [{ path: "/producer_run_id", reason: "bounded path identity required" }],
        });
      }
      if (Object.keys(request.query).length > 0) {
        return rejectRequest({
          reply,
          startedAt,
          operation: "receipt_write",
          principal,
          statusCode: 400,
          code: "schema_invalid",
          message: "Receipt selector is invalid",
          plane,
          producerRunId,
          details: [{ path: "/query", reason: "unknown query parameter" }],
        });
      }
      const idempotencyKey = validateIdempotencyKey({
        value: request.headers["idempotency-key"],
        reply,
        startedAt,
        operation: "receipt_write",
        principal,
        plane,
        producerRunId,
      });
      if (!idempotencyKey) return;
      if (serializedBytes(request.body) > MAX_RECEIPT_BYTES) {
        return rejectRequest({
          reply,
          startedAt,
          operation: "receipt_write",
          principal,
          statusCode: 413,
          code: "schema_invalid",
          message: "Receipt exceeds the published byte limit",
          plane,
          producerRunId,
        });
      }
      const candidates = objectValue(request.body)?.candidates;
      if (Array.isArray(candidates)
          && candidates.some((candidate) => serializedBytes(candidate) > MAX_CANDIDATE_BYTES)) {
        return rejectRequest({
          reply,
          startedAt,
          operation: "receipt_write",
          principal,
          statusCode: 413,
          code: "schema_invalid",
          message: "Candidate exceeds the published byte limit",
          plane,
          producerRunId,
        });
      }
      if (!validateSafety({
        body: request.body,
        reply,
        startedAt,
        operation: "receipt_write",
        principal,
        plane,
        producerRunId,
      })) return;
      const receipt = parseContract<RunReceiptV2>({
        name: "RunReceiptV2",
        expectedVersion: "pim.run-receipt.v2",
        body: request.body,
        reply,
        startedAt,
        operation: "receipt_write",
        principal,
        plane,
        producerRunId,
      });
      if (!receipt) return;
      try {
        const result = receipt.plane === "harness"
          ? await submitAuthorizedHarnessMemoryRunReceiptV2({
            authorization: authorizeHarnessMemoryV2Operation({
              principal,
              operation: "receipt_write",
              selector: receipt.resource_selector,
              projectId: receipt.tenant.project_id,
            }),
            producerRunId,
            idempotencyKey,
            receipt: receipt as HarnessRunReceiptV2,
          })
          : submitAuthorizedCodeMemoryRunReceiptV2({
            authorization: authorizeCodeMemoryV2Operation({
              principal,
              operation: "receipt_write",
              selector: receipt.resource_selector,
              projectId: receipt.tenant.project_id,
            }),
            producerRunId,
            idempotencyKey,
            receipt: receipt as CodebaseRunReceiptV2,
          });
        recordCodeWriteOutcome({
          startedAt,
          operation: "receipt_write",
          outcome: result.duplicate ? "replay" : "success",
          reason: result.duplicate ? "replayed" : "accepted",
          statusCode: 200,
          principal,
          plane: result.plane,
          producerRunId,
          receiptId: result.receipt_id,
          resourceRowId: result.resource_binding.resource_row_id,
        });
        return result;
      } catch (error) {
        return sendWriteFailure({
          error,
          reply,
          startedAt,
          operation: "receipt_write",
          principal,
          plane: receipt.plane,
          producerRunId,
        });
      }
    },
  );

  app.post<{
    Body: unknown;
    Querystring: Record<string, unknown>;
    Headers: { "idempotency-key"?: string };
  }>(
    "/api/v2/memory/feedback",
    { bodyLimit: MAX_FEEDBACK_BYTES },
    async (request, reply) => {
      privateResponseHeaders(reply);
      const startedAt = Date.now();
      const principal = servicePrincipal(request);
      const plane = rawPlane(request.body) ?? "unresolved";
      if (Object.keys(request.query).length > 0) {
        return rejectRequest({
          reply,
          startedAt,
          operation: "feedback_write",
          principal,
          statusCode: 400,
          code: "schema_invalid",
          message: "Feedback selector is invalid",
          plane,
          details: [{ path: "/query", reason: "unknown query parameter" }],
        });
      }
      const idempotencyKey = validateIdempotencyKey({
        value: request.headers["idempotency-key"],
        reply,
        startedAt,
        operation: "feedback_write",
        principal,
        plane,
      });
      if (!idempotencyKey) return;
      if (!validateSafety({
        body: request.body,
        reply,
        startedAt,
        operation: "feedback_write",
        principal,
        plane,
      })) return;
      const feedback = parseContract<MemoryFeedbackV2>({
        name: "MemoryFeedbackV2",
        expectedVersion: "pim.memory-feedback.v2",
        body: request.body,
        reply,
        startedAt,
        operation: "feedback_write",
        principal,
        plane,
      });
      if (!feedback) return;
      try {
        const result = appendAuthorizedCodeMemoryFeedbackV2({
          authorization: authorizeCodeMemoryV2Operation({
            principal,
            operation: "feedback_write",
            selector: { resource_row_id: feedback.resource_row_id },
          }),
          idempotencyKey,
          feedback,
        });
        recordCodeWriteOutcome({
          startedAt,
          operation: "feedback_write",
          outcome: result.duplicate ? "replay" : "success",
          reason: result.duplicate ? "replayed" : "accepted",
          statusCode: 200,
          principal,
          plane: result.plane,
          feedbackId: result.feedback_id,
          resourceRowId: result.resource_binding.resource_row_id,
        });
        return result;
      } catch (error) {
        return sendWriteFailure({
          error,
          reply,
          startedAt,
          operation: "feedback_write",
          principal,
          plane: feedback.plane,
        });
      }
    },
  );

  app.get<{
    Params: { candidate_id: string };
    Querystring: Record<string, unknown>;
  }>("/api/v2/memory/candidates/:candidate_id", async (request, reply) => {
    privateResponseHeaders(reply);
    const startedAt = Date.now();
    const principal = servicePrincipal(request);
    const candidateId = request.params.candidate_id;
    const queryKeys = Object.keys(request.query);
    const harnessSelector = queryKeys.length > 0
      ? harnessCandidateSelector(request.query)
      : null;
    if (!candidateId || candidateId.length > MAX_CANDIDATE_ID_LENGTH
        || (queryKeys.length > 0 && !harnessSelector)) {
      return rejectRequest({
        reply,
        startedAt,
        operation: "candidate_read",
        principal,
        statusCode: 400,
        code: "schema_invalid",
        message: "Candidate selector is invalid",
        plane: rawPlane(request.query) ?? "codebase",
        candidateId: candidateId.length <= MAX_CANDIDATE_ID_LENGTH ? candidateId : undefined,
        details: [{
          path: candidateId && candidateId.length <= MAX_CANDIDATE_ID_LENGTH
            ? "/query"
            : "/candidate_id",
          reason: candidateId && candidateId.length <= MAX_CANDIDATE_ID_LENGTH
            ? "unknown query parameter"
            : "bounded candidate id required",
        }],
      });
    }
    try {
      const result = harnessSelector
        ? getAuthorizedHarnessMemoryCandidateStatusV2({
          authorization: authorizeHarnessMemoryCandidateStatusV2({
            principal,
            candidateId,
            resourceSelector: harnessSelector.resourceSelector,
            receiptId: harnessSelector.receiptId,
            producerRunId: harnessSelector.producerRunId,
          }),
          candidateId,
          resourceSelector: harnessSelector.resourceSelector,
          receiptId: harnessSelector.receiptId,
          producerRunId: harnessSelector.producerRunId,
        })
        : getAuthorizedCodeMemoryCandidateStatusV2({
          authorization: authorizeCodeMemoryCandidateStatusV2({ principal, candidateId }),
          candidateId,
        });
      recordCodeWriteOutcome({
        startedAt,
        operation: "candidate_read",
        outcome: "success",
        reason: "completed",
        statusCode: 200,
        principal,
        candidateId: result.candidate_id,
        plane: result.plane,
        resourceRowId: result.resource_binding.resource_row_id,
      });
      return result;
    } catch (error) {
      return sendWriteFailure({
        error,
        reply,
        startedAt,
        operation: "candidate_read",
        principal,
        plane: harnessSelector ? "harness" : "codebase",
        producerRunId: harnessSelector?.producerRunId,
        candidateId,
      });
    }
  });

  app.post<{
    Params: { candidate_id: string };
    Body: unknown;
    Querystring: Record<string, unknown>;
  }>(
    "/api/v2/memory/candidates/:candidate_id/decisions",
    { bodyLimit: MAX_DECISION_BYTES },
    async (request, reply) => {
      privateResponseHeaders(reply);
      const startedAt = Date.now();
      const principal = servicePrincipal(request);
      const candidateId = request.params.candidate_id;
      const plane = rawPlane(request.body) ?? "unresolved";
      if (!candidateId || candidateId.length > MAX_CANDIDATE_ID_LENGTH) {
        return rejectRequest({
          reply,
          startedAt,
          operation: "review",
          principal,
          statusCode: 400,
          code: "schema_invalid",
          message: "candidate_id must contain 1 to 128 characters",
          plane,
          details: [{ path: "/candidate_id", reason: "bounded path identity required" }],
        });
      }
      if (Object.keys(request.query).length > 0) {
        return rejectRequest({
          reply,
          startedAt,
          operation: "review",
          principal,
          statusCode: 400,
          code: "schema_invalid",
          message: "Candidate decision selector is invalid",
          plane,
          candidateId,
          details: [{ path: "/query", reason: "unknown query parameter" }],
        });
      }
      if (!validateSafety({
        body: request.body,
        reply,
        startedAt,
        operation: "review",
        principal,
        plane,
        candidateId,
      })) return;
      const decision = parseContract<MemoryCandidateDecisionV2>({
        name: "MemoryCandidateDecisionV2",
        expectedVersion: "pim.memory-candidate-decision.v2",
        body: request.body,
        reply,
        startedAt,
        operation: "review",
        principal,
        plane,
        candidateId,
      });
      if (!decision) return;
      try {
        const result = decision.plane === "harness"
          ? decideAuthorizedHarnessMemoryCandidateV2({
            authorization: authorizeHarnessMemoryV2Operation({
              principal,
              operation: "review",
              selector: { resource_row_id: decision.resource_row_id },
            }),
            candidateId,
            decision,
          })
          : decideAuthorizedCodeMemoryCandidateV2({
            authorization: authorizeCodeMemoryV2Operation({
              principal,
              operation: "review",
              selector: { resource_row_id: decision.resource_row_id },
            }),
            candidateId,
            decision,
          });
        recordCodeWriteOutcome({
          startedAt,
          operation: "review",
          outcome: result.duplicate ? "replay" : "success",
          reason: result.duplicate ? "replayed" : "accepted",
          statusCode: 200,
          principal,
          candidateId: result.candidate_id,
          plane: result.plane,
          resourceRowId: result.resource_binding.resource_row_id,
        });
        return result;
      } catch (error) {
        return sendWriteFailure({
          error,
          reply,
          startedAt,
          operation: "review",
          principal,
          plane: decision.plane,
          candidateId,
        });
      }
    },
  );
}
