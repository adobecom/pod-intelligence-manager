import {
  MemoryContractValidationError,
  parseMemoryContractV2,
  type CodebaseMemorySearchV2,
  type MemoryPlaneV2,
} from "@pim/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { sendMemoryV2Error } from "../middleware/memory-errors.js";
import {
  authorizeCodeMemoryRecordHistoryV2,
  authorizeCodeMemorySearchV2,
  getAuthorizedCodeMemoryRecordHistoryV2,
  MemoryV2CodeReadError,
  searchAuthorizedCodeMemoryV2,
} from "../services/memory-v2-code-read.js";
import {
  authorizeHarnessMemorySearchV2,
  MemoryV2HarnessReadError,
  searchAuthorizedHarnessMemoryV2,
} from "../services/memory-v2-harness-read.js";
import {
  getMemoryPackV2,
  getMemoryRecordV2,
  MemoryV2ReadDispatchError,
} from "../services/memory-v2-read-dispatch.js";
import { recordMemoryMetric } from "../services/memory-metrics.js";
import type { MemoryV2RequestAuthorizationSnapshot } from "../services/memory-v2-request-authorization.js";

type CodeReadOperation = "search" | "detail" | "history" | "pack";
type CodeReadOutcome = "success" | "rejected" | "error";

export const MEMORY_V2_RECORD_ID_MAX_LENGTH = 128;
export const MEMORY_V2_PACK_ID_MAX_LENGTH = 128;

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requestIdFrom(value: unknown): string | undefined {
  const requestId = objectValue(value)?.request_id;
  return typeof requestId === "string" && requestId.length <= 128 ? requestId : undefined;
}

function planeFrom(value: unknown): MemoryPlaneV2 | undefined {
  const plane = objectValue(value)?.plane;
  return plane === "codebase" || plane === "harness"
    ? plane
    : undefined;
}

function privateResponseHeaders(reply: FastifyReply): void {
  reply.header("Cache-Control", "private, no-store");
  reply.header("Vary", "Authorization");
}

function servicePrincipal(req: FastifyRequest): MemoryV2RequestAuthorizationSnapshot | null {
  return req.memoryV2Authorization ?? null;
}

function statusClass(statusCode: number): string {
  return statusCode >= 500 ? "5xx" : statusCode >= 400 ? "4xx" : "2xx";
}

function boundedRecordId(value: string): string | null {
  return value.length >= 1 && value.length <= MEMORY_V2_RECORD_ID_MAX_LENGTH ? value : null;
}

function boundedPackId(value: string): string | null {
  return value.length >= 1 && value.length <= MEMORY_V2_PACK_ID_MAX_LENGTH ? value : null;
}

function recordCodeReadOutcome(input: {
  startedAt: number;
  operation: CodeReadOperation;
  outcome: CodeReadOutcome;
  reason: string;
  statusCode: number;
  principal: MemoryV2RequestAuthorizationSnapshot | null;
  plane?: MemoryPlaneV2 | "unresolved";
  requestId?: string;
  recordId?: string;
  retrievalPackId?: string;
  resourceRowId?: string;
  resultCount?: number;
}): void {
  const plane = input.plane ?? "codebase";
  const resourceType = plane === "codebase"
    ? "repository"
    : plane === "harness"
      ? "harness"
      : "unresolved";
  const dimensions = {
    transport: "direct_http",
    operation: input.operation,
    plane,
    resource_type: resourceType,
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
    ...(input.requestId ? { request_id: input.requestId } : {}),
    ...(input.recordId ? { record_id: input.recordId } : {}),
    ...(input.retrievalPackId ? { retrieval_pack_id: input.retrievalPackId } : {}),
    ...(input.resourceRowId ? { resource_row_id: input.resourceRowId } : {}),
  };
  recordMemoryMetric({
    name: "SearchOutcome",
    value: 1,
    unit: "Count",
    dimensions,
    fields,
  });
  if (input.resultCount !== undefined) {
    recordMemoryMetric({
      name: "SearchResultCount",
      value: input.resultCount,
      unit: "Count",
      dimensions,
      fields,
    });
  }
  recordMemoryMetric({
    name: "SearchLatency",
    value: Math.max(0, Date.now() - input.startedAt),
    unit: "Milliseconds",
    dimensions,
    fields,
  });
}

function sendCodeReadFailure(input: {
  error: unknown;
  reply: FastifyReply;
  startedAt: number;
  operation: CodeReadOperation;
  principal: MemoryV2RequestAuthorizationSnapshot | null;
  requestId?: string;
  recordId?: string;
  retrievalPackId?: string;
  plane?: MemoryPlaneV2;
}): false {
  const knownError = input.error instanceof MemoryV2CodeReadError
    || input.error instanceof MemoryV2HarnessReadError
    || input.error instanceof MemoryV2ReadDispatchError
    ? input.error
    : null;
  const statusCode = knownError?.statusCode ?? 500;
  const code = knownError?.code ?? "temporarily_unavailable";
  const errorPlane = input.error instanceof MemoryV2ReadDispatchError
    ? input.error.plane
    : input.error instanceof MemoryV2HarnessReadError
      ? "harness"
      : input.error instanceof MemoryV2CodeReadError
        ? "codebase"
        : undefined;
  const plane = input.plane ?? errorPlane;
  recordCodeReadOutcome({
    startedAt: input.startedAt,
    operation: input.operation,
    outcome: statusCode >= 500 ? "error" : "rejected",
    reason: code,
    statusCode,
    principal: input.principal,
    plane: plane ?? "unresolved",
    requestId: input.requestId,
    recordId: input.recordId,
    retrievalPackId: input.retrievalPackId,
  });
  return sendMemoryV2Error(
    input.reply,
    statusCode,
    code,
    statusCode >= 500
      ? "Memory service is temporarily unavailable"
      : input.error instanceof Error
        ? input.error.message
        : "Memory request was rejected",
    {
      requestId: input.requestId,
      plane,
      retryable: statusCode >= 500,
      details: knownError && statusCode < 500 ? knownError.details : [],
    },
  );
}

function parseSearchRequest(input: {
  body: unknown;
  reply: FastifyReply;
  startedAt: number;
  principal: MemoryV2RequestAuthorizationSnapshot | null;
}) {
  const { body, reply } = input;
  const requestId = requestIdFrom(body);
  const plane = planeFrom(body);
  if (objectValue(body)?.schema_version !== "pim.memory-search.v2") {
    recordCodeReadOutcome({
      startedAt: input.startedAt,
      operation: "search",
      outcome: "rejected",
      reason: "contract_version_unsupported",
      statusCode: 400,
      principal: input.principal,
      plane: plane ?? "unresolved",
      requestId,
    });
    sendMemoryV2Error(
      reply,
      400,
      "contract_version_unsupported",
      "Supported search schema is pim.memory-search.v2",
      { requestId, plane, retryable: false },
    );
    return null;
  }
  try {
    return parseMemoryContractV2("MemorySearchV2", body);
  } catch (error) {
    if (!(error instanceof MemoryContractValidationError)) throw error;
    recordCodeReadOutcome({
      startedAt: input.startedAt,
      operation: "search",
      outcome: "rejected",
      reason: "schema_invalid",
      statusCode: 400,
      principal: input.principal,
      plane: plane ?? "unresolved",
      requestId,
    });
    sendMemoryV2Error(
      reply,
      400,
      "schema_invalid",
      "Request does not match pim.memory-search.v2",
      { requestId, plane, retryable: false, details: error.issues },
    );
    return null;
  }
}

export default async function memoryV2SearchRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/v2/memory/search", async (request, reply) => {
    privateResponseHeaders(reply);
    const startedAt = Date.now();
    const principal = servicePrincipal(request);
    const body = parseSearchRequest({
      body: request.body,
      reply,
      startedAt,
      principal,
    });
    if (!body) return;

    if (body.plane === "codebase") {
      try {
        const codeRequest = body as CodebaseMemorySearchV2;
        const result = await searchAuthorizedCodeMemoryV2({
          authorization: authorizeCodeMemorySearchV2({ principal, request: codeRequest }),
          request: codeRequest,
        });
        recordCodeReadOutcome({
          startedAt,
          operation: "search",
          outcome: "success",
          reason: "completed",
          statusCode: 200,
          principal,
          requestId: body.request_id,
          retrievalPackId: result.retrieval_pack_id,
          resourceRowId: result.resource_binding.resource_row_id,
          resultCount: result.items.length,
        });
        return result;
      } catch (error) {
        return sendCodeReadFailure({
          error,
          reply,
          startedAt,
          operation: "search",
          principal,
          plane: "codebase",
          requestId: body.request_id,
        });
      }
    }

    try {
      const result = await searchAuthorizedHarnessMemoryV2({
        authorization: authorizeHarnessMemorySearchV2({ principal, request: body }),
        request: body,
      });
      recordCodeReadOutcome({
        startedAt,
        operation: "search",
        outcome: "success",
        reason: "completed",
        statusCode: 200,
        principal,
        plane: "harness",
        requestId: body.request_id,
        retrievalPackId: result.retrieval_pack_id,
        resourceRowId: result.resource_binding.resource_row_id,
        resultCount: result.items.length,
      });
      return result;
    } catch (error) {
      return sendCodeReadFailure({
        error,
        reply,
        startedAt,
        operation: "search",
        principal,
        plane: "harness",
        requestId: body.request_id,
      });
    }
  });

  app.get<{
    Params: { record_id: string };
    Querystring: { version?: string };
  }>("/api/v2/memory/records/:record_id", async (request, reply) => {
    privateResponseHeaders(reply);
    const startedAt = Date.now();
    const principal = servicePrincipal(request);
    const recordId = boundedRecordId(request.params.record_id);
    const queryKeys = Object.keys(request.query);
    if (!recordId || queryKeys.some((key) => key !== "version")) {
      recordCodeReadOutcome({
        startedAt,
        operation: "detail",
        outcome: "rejected",
        reason: "schema_invalid",
        statusCode: 400,
        principal,
        ...(recordId ? { recordId } : {}),
      });
      return sendMemoryV2Error(
        reply,
        400,
        "schema_invalid",
        "Record detail selector is invalid",
        {
          plane: "codebase",
          retryable: false,
          details: [{
            path: recordId ? "/query" : "/record_id",
            reason: recordId ? "unknown query parameter" : "bounded record id required",
          }],
        },
      );
    }
    const rawVersion = request.query.version;
    const recordVersion = typeof rawVersion === "string" && /^[1-9]\d*$/.test(rawVersion)
      ? Number(rawVersion)
      : Number.NaN;
    if (!Number.isSafeInteger(recordVersion) || recordVersion < 1) {
      recordCodeReadOutcome({
        startedAt,
        operation: "detail",
        outcome: "rejected",
        reason: "schema_invalid",
        statusCode: 400,
        principal,
        recordId,
      });
      return sendMemoryV2Error(
        reply,
        400,
        "schema_invalid",
        "version must be a positive immutable record version",
        {
          plane: "codebase",
          retryable: false,
          details: [{ path: "/version", reason: "required positive integer" }],
        },
      );
    }
    try {
      const result = getMemoryRecordV2({
        principal,
        recordId,
        recordVersion,
      });
      recordCodeReadOutcome({
        startedAt,
        operation: "detail",
        outcome: "success",
        reason: "completed",
        statusCode: 200,
        principal,
        plane: result.plane,
        recordId: result.record_id,
        resourceRowId: result.resource_binding.resource_row_id,
      });
      return result;
    } catch (error) {
      return sendCodeReadFailure({
        error,
        reply,
        startedAt,
        operation: "detail",
        principal,
        recordId,
      });
    }
  });

  app.get<{
    Params: { record_id: string };
    Querystring: Record<string, unknown>;
  }>("/api/v2/memory/records/:record_id/history", async (request, reply) => {
    privateResponseHeaders(reply);
    const startedAt = Date.now();
    const principal = servicePrincipal(request);
    const recordId = boundedRecordId(request.params.record_id);
    if (!recordId || Object.keys(request.query).length > 0) {
      recordCodeReadOutcome({
        startedAt,
        operation: "history",
        outcome: "rejected",
        reason: "schema_invalid",
        statusCode: 400,
        principal,
        ...(recordId ? { recordId } : {}),
      });
      return sendMemoryV2Error(
        reply,
        400,
        "schema_invalid",
        "Record history selector is invalid",
        {
          plane: "codebase",
          retryable: false,
          details: [{
            path: recordId ? "/query" : "/record_id",
            reason: recordId ? "query parameters are not supported" : "bounded record id required",
          }],
        },
      );
    }
    try {
      const result = getAuthorizedCodeMemoryRecordHistoryV2({
        authorization: authorizeCodeMemoryRecordHistoryV2({ principal, recordId }),
        recordId,
      });
      recordCodeReadOutcome({
        startedAt,
        operation: "history",
        outcome: "success",
        reason: "completed",
        statusCode: 200,
        principal,
        recordId: result.record_id,
        resourceRowId: result.resource_binding.resource_row_id,
      });
      return result;
    } catch (error) {
      return sendCodeReadFailure({
        error,
        reply,
        startedAt,
        operation: "history",
        principal,
        recordId,
      });
    }
  });

  app.get<{
    Params: { pack_id: string };
    Querystring: Record<string, unknown>;
  }>("/api/v2/memory/packs/:pack_id", async (request, reply) => {
    privateResponseHeaders(reply);
    const startedAt = Date.now();
    const principal = servicePrincipal(request);
    const packId = boundedPackId(request.params.pack_id);
    if (!packId || Object.keys(request.query).length > 0) {
      recordCodeReadOutcome({
        startedAt,
        operation: "pack",
        outcome: "rejected",
        reason: "schema_invalid",
        statusCode: 400,
        principal,
        ...(packId ? { retrievalPackId: packId } : {}),
      });
      return sendMemoryV2Error(
        reply,
        400,
        "schema_invalid",
        "Retrieval-pack selector is invalid",
        {
          retryable: false,
          details: [{
            path: packId ? "/query" : "/pack_id",
            reason: packId
              ? "query parameters are not supported"
              : "bounded retrieval-pack id required",
          }],
        },
      );
    }
    try {
      const result = getMemoryPackV2({ principal, packId });
      recordCodeReadOutcome({
        startedAt,
        operation: "pack",
        outcome: "success",
        reason: "completed",
        statusCode: 200,
        principal,
        plane: result.plane,
        retrievalPackId: result.retrieval_pack_id,
        resourceRowId: result.resource_binding.resource_row_id,
        resultCount: result.items.length,
      });
      return result;
    } catch (error) {
      return sendCodeReadFailure({
        error,
        reply,
        startedAt,
        operation: "pack",
        principal,
        retrievalPackId: packId,
      });
    }
  });
}
