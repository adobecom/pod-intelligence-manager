import {
  MemoryContractValidationError,
  parseMemoryContractV2,
  type MemoryMcpReadinessInputV2,
  type MemoryPlaneV2,
} from "@pim/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  sendMemoryV2Error,
  setMemoryV2PrivateResponseHeaders,
} from "../middleware/memory-errors.js";
import {
  authorizeMemoryV2Readiness,
  MemoryV2ReadinessError,
  readAuthorizedMemoryV2Readiness,
} from "../services/memory-v2-readiness.js";
import { recordMemoryMetric } from "../services/memory-metrics.js";
import type { MemoryV2RequestAuthorizationSnapshot } from "../services/memory-v2-request-authorization.js";

type ReadinessOutcome = "success" | "rejected" | "error";

function privateResponseHeaders(reply: FastifyReply): void {
  setMemoryV2PrivateResponseHeaders(reply);
}

function servicePrincipal(request: FastifyRequest): MemoryV2RequestAuthorizationSnapshot | null {
  return request.memoryV2Authorization ?? null;
}

function rawPlane(value: unknown): MemoryPlaneV2 | "unresolved" {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "unresolved";
  const plane = (value as Record<string, unknown>).plane;
  return plane === "codebase" || plane === "harness"
    ? plane
    : "unresolved";
}

function statusClass(statusCode: number): string {
  return statusCode >= 500 ? "5xx" : statusCode >= 400 ? "4xx" : "2xx";
}

function recordReadinessOutcome(input: {
  startedAt: number;
  outcome: ReadinessOutcome;
  reason: string;
  statusCode: number;
  principal: MemoryV2RequestAuthorizationSnapshot | null;
  plane: MemoryPlaneV2 | "unresolved";
  resourceRowId?: string;
}): void {
  const dimensions = {
    transport: "direct_http",
    operation: "readiness",
    plane: input.plane,
    resource_type: input.plane === "codebase"
      ? "repository"
      : input.plane === "harness"
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

function parseReadinessQuery(
  query: Record<string, unknown>,
): MemoryMcpReadinessInputV2 {
  const allowed = new Set(["plane", "resource_row_id", "canonical_resource_id"]);
  if (Object.keys(query).some((key) => !allowed.has(key))) {
    return parseMemoryContractV2("MemoryMcpReadinessInputV2", query);
  }
  const selector = typeof query.resource_row_id === "string"
    ? { resource_row_id: query.resource_row_id }
    : typeof query.canonical_resource_id === "string"
      ? { canonical_resource_id: query.canonical_resource_id }
      : null;
  const input = {
    plane: query.plane,
    resource_selector: selector,
    ...(typeof query.resource_row_id === "string"
        && typeof query.canonical_resource_id === "string"
      ? { conflicting_selector: true }
      : {}),
  };
  return parseMemoryContractV2("MemoryMcpReadinessInputV2", input);
}

export default async function memoryV2ReadinessRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: Record<string, unknown>;
  }>("/api/v2/memory/readiness", {
    // Selectors arrive in the query string. Fastify's default request logger
    // includes the raw URL, so keep this private endpoint out of automatic
    // request/response logs and emit only the bounded readiness metrics below.
    logLevel: "silent",
  }, async (request, reply) => {
    privateResponseHeaders(reply);
    const startedAt = Date.now();
    const principal = servicePrincipal(request);
    let input: MemoryMcpReadinessInputV2;
    try {
      input = parseReadinessQuery(request.query);
    } catch (error) {
      if (!(error instanceof MemoryContractValidationError)) throw error;
      const plane = rawPlane(request.query);
      recordReadinessOutcome({
        startedAt,
        outcome: "rejected",
        reason: "schema_invalid",
        statusCode: 400,
        principal,
        plane,
      });
      sendMemoryV2Error(
        reply,
        400,
        "schema_invalid",
        "Readiness selector is invalid",
        {
          plane: plane === "unresolved" ? undefined : plane,
          retryable: false,
          details: error.issues,
        },
      );
      return;
    }

    try {
      const result = readAuthorizedMemoryV2Readiness({
        authorization: authorizeMemoryV2Readiness({ principal, request: input }),
        request: input,
      });
      recordReadinessOutcome({
        startedAt,
        outcome: "success",
        reason: "completed",
        statusCode: 200,
        principal,
        plane: result.plane,
        resourceRowId: result.resource_binding.resource_row_id,
      });
      return result;
    } catch (error) {
      const known = error instanceof MemoryV2ReadinessError ? error : null;
      const statusCode = known?.statusCode ?? 500;
      const code = known?.code ?? "temporarily_unavailable";
      recordReadinessOutcome({
        startedAt,
        outcome: statusCode >= 500 ? "error" : "rejected",
        reason: code,
        statusCode,
        principal,
        plane: known?.plane ?? input.plane,
      });
      sendMemoryV2Error(
        reply,
        statusCode,
        code,
        statusCode >= 500
          ? "Memory service is temporarily unavailable"
          : known?.message ?? "Memory readiness was rejected",
        {
          plane: known?.plane ?? input.plane,
          retryable: statusCode >= 500,
          details: known?.details ?? [],
        },
      );
      return;
    }
  });
}
