import type { FastifyInstance, FastifyReply } from "fastify";
import {
  MemoryContractValidationError,
  parseMemoryContract,
  type CodebaseApplicabilityV1,
  type MemorySearchV1,
} from "@pim/shared";
import {
  requireMemoryProjectBinding,
  requireMemoryRepositoryBinding,
  requireMemoryServiceScope,
} from "../middleware/service-authz.js";
import { sendMemoryError } from "../middleware/memory-errors.js";
import { getMemoryRecord, getMemoryRecordHistory } from "../services/memory-records.js";
import { recordMemoryMetric } from "../services/memory-metrics.js";
import {
  MemorySearchIdempotencyError,
  executeMemorySearch,
} from "../services/memory-search.js";

function requestIdFrom(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const requestId = (value as { request_id?: unknown }).request_id;
  return typeof requestId === "string" && requestId.length <= 128 ? requestId : undefined;
}

function schemaVersionFrom(value: unknown): unknown {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as { schema_version?: unknown }).schema_version
    : undefined;
}

function projectIdFrom(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const tenant = (value as { tenant?: unknown }).tenant;
  if (!tenant || typeof tenant !== "object" || Array.isArray(tenant)) return null;
  const projectId = (tenant as { project_id?: unknown }).project_id;
  return typeof projectId === "string" ? projectId : null;
}

function parseSearchRequest(body: unknown, reply: FastifyReply): MemorySearchV1 | null {
  const requestId = requestIdFrom(body);
  if (schemaVersionFrom(body) !== "pim.memory-search.v1") {
    sendMemoryError(
      reply,
      400,
      "contract_version_unsupported",
      "Supported search schema is pim.memory-search.v1",
      { requestId },
    );
    return null;
  }
  try {
    return parseMemoryContract("MemorySearchV1", body);
  } catch (error) {
    if (!(error instanceof MemoryContractValidationError)) throw error;
    sendMemoryError(
      reply,
      400,
      "schema_invalid",
      "Request does not match pim.memory-search.v1",
      { requestId, details: error.issues },
    );
    return null;
  }
}

function codebaseApplicability(request: MemorySearchV1): CodebaseApplicabilityV1 | null {
  const applicability = request.applicability as { repository_id?: unknown };
  return typeof applicability.repository_id === "string"
    ? request.applicability as CodebaseApplicabilityV1
    : null;
}

function parseVersion(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const version = Number(raw);
  return Number.isSafeInteger(version) && version >= 1 ? version : null;
}

export default async function memorySearchRoutes(app: FastifyInstance) {
  app.post<{ Body: unknown }>("/api/v1/memory/search", async (req, reply) => {
    const auth = requireMemoryServiceScope(req, reply, "memory:search");
    if (!auth) return;
    const requestedProjectId = projectIdFrom(req.body);
    if (requestedProjectId && !requireMemoryProjectBinding(req, reply, requestedProjectId)) return;
    const request = parseSearchRequest(req.body, reply);
    if (!request) return;
    if (!requestedProjectId && !requireMemoryProjectBinding(req, reply, request.tenant.project_id)) return;
    if (request.plane !== "codebase") {
      return sendMemoryError(
        reply,
        400,
        "schema_invalid",
        `Memory plane ${request.plane} is not supported by the negotiated capabilities`,
        { requestId: request.request_id, details: [{ path: "/plane", reason: "unsupported plane" }] },
      );
    }
    if (request.temporal.mode !== "current") {
      return sendMemoryError(
        reply,
        400,
        "schema_invalid",
        "Only current temporal mode is supported",
        { requestId: request.request_id, details: [{ path: "/temporal/mode", reason: "unsupported temporal mode" }] },
      );
    }
    const applicability = codebaseApplicability(request);
    if (!applicability) {
      return sendMemoryError(
        reply,
        400,
        "schema_invalid",
        "Codebase searches require canonical repository applicability",
        { requestId: request.request_id, details: [{ path: "/applicability", reason: "plane/applicability mismatch" }] },
      );
    }
    const repository = requireMemoryRepositoryBinding(
      req,
      reply,
      request.tenant.project_id,
      applicability.repository_id,
    );
    if (!repository) return;
    const startedAt = Date.now();
    try {
      const result = await executeMemorySearch({
        orgId: auth.orgId,
        principalId: auth.servicePrincipalId,
        repository,
        request,
      });
      const fields = {
        org_id: auth.orgId,
        project_id: request.tenant.project_id,
        repository_id: repository.repository_id,
        request_id: request.request_id,
        retrieval_pack_id: result.retrieval_pack_id,
      };
      recordMemoryMetric({
        name: "SearchOutcome",
        value: 1,
        unit: "Count",
        dimensions: { outcome: "success", plane: request.plane },
        fields,
      });
      recordMemoryMetric({
        name: "SearchResultCount",
        value: result.items.length,
        unit: "Count",
        dimensions: { plane: request.plane },
        fields,
      });
      recordMemoryMetric({
        name: "SearchLatency",
        value: Math.max(0, Date.now() - startedAt),
        unit: "Milliseconds",
        dimensions: { outcome: "success", plane: request.plane },
        fields,
      });
      return result;
    } catch (error) {
      if (error instanceof MemorySearchIdempotencyError) {
        const fields = {
          org_id: auth.orgId,
          project_id: request.tenant.project_id,
          repository_id: repository.repository_id,
          request_id: request.request_id,
          reason_code: "idempotency_conflict",
        };
        recordMemoryMetric({
          name: "SearchOutcome",
          value: 1,
          unit: "Count",
          dimensions: { outcome: "rejected", plane: request.plane },
          fields,
        });
        recordMemoryMetric({
          name: "SearchLatency",
          value: Math.max(0, Date.now() - startedAt),
          unit: "Milliseconds",
          dimensions: { outcome: "rejected", plane: request.plane },
          fields,
        });
        return sendMemoryError(
          reply,
          409,
          "idempotency_conflict",
          error.message,
          { requestId: request.request_id },
        );
      }
      throw error;
    }
  });

  app.get<{
    Params: { record_id: string };
  }>("/api/v1/memory/records/:record_id/history", async (req, reply) => {
    const auth = requireMemoryServiceScope(req, reply, "memory:search");
    if (!auth) return;
    if (!auth.projectId || auth.podId) {
      return sendMemoryError(
        reply,
        403,
        "resource_binding_mismatch",
        "Record history requires a project-bound service token",
      );
    }
    const history = getMemoryRecordHistory(auth.orgId, auth.projectId, req.params.record_id);
    if (!history) {
      return sendMemoryError(reply, 404, "resource_not_found", "Memory record is unavailable");
    }
    if (!requireMemoryRepositoryBinding(
      req,
      reply,
      auth.projectId,
      history.repository_id,
    )) return;
    return history;
  });

  app.get<{
    Params: { record_id: string };
    Querystring: { version?: string };
  }>("/api/v1/memory/records/:record_id", async (req, reply) => {
    const auth = requireMemoryServiceScope(req, reply, "memory:search");
    if (!auth) return;
    if (!auth.projectId || auth.podId) {
      return sendMemoryError(
        reply,
        403,
        "resource_binding_mismatch",
        "Record detail requires a project-bound service token",
      );
    }
    const version = parseVersion(req.query.version);
    if (version === null) {
      return sendMemoryError(
        reply,
        400,
        "schema_invalid",
        "version must be a positive immutable record version",
        { details: [{ path: "/version", reason: "required positive integer" }] },
      );
    }
    const detail = getMemoryRecord(auth.orgId, auth.projectId, req.params.record_id, version);
    if (!detail) {
      return sendMemoryError(reply, 404, "resource_not_found", "Memory record is unavailable");
    }
    if (!requireMemoryRepositoryBinding(
      req,
      reply,
      auth.projectId,
      detail.applicability.repository_id,
    )) return;
    return detail;
  });
}
