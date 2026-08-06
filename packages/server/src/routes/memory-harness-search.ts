import type { FastifyInstance, FastifyReply } from "fastify";
import {
  MemoryContractValidationError,
  parseMemoryContract,
  type MemoryHarnessSearchV1,
} from "@pim/shared";
import {
  requireMemoryHarnessBinding,
  requireMemoryProjectBinding,
  requireMemoryServiceScope,
} from "../middleware/service-authz.js";
import { sendMemoryError } from "../middleware/memory-errors.js";
import {
  executeHarnessMemorySearch,
  MemoryHarnessSearchError,
} from "../services/memory-harness-search.js";

const MAX_HARNESS_SEARCH_BYTES = 32 * 1024;

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requestIdFrom(value: unknown): string | undefined {
  const requestId = objectValue(value)?.request_id;
  return typeof requestId === "string" && requestId.length <= 128 ? requestId : undefined;
}

function projectIdFrom(value: unknown): string | null {
  const projectId = objectValue(objectValue(value)?.tenant)?.project_id;
  return typeof projectId === "string" ? projectId : null;
}

function parseHarnessSearch(body: unknown, reply: FastifyReply): MemoryHarnessSearchV1 | null {
  const requestId = requestIdFrom(body);
  if (objectValue(body)?.schema_version !== "pim.memory-harness-search.v1") {
    sendMemoryError(
      reply,
      400,
      "contract_version_unsupported",
      "Supported harness search schema is pim.memory-harness-search.v1",
      { requestId },
    );
    return null;
  }
  try {
    return parseMemoryContract("MemoryHarnessSearchV1", body);
  } catch (error) {
    if (!(error instanceof MemoryContractValidationError)) throw error;
    sendMemoryError(
      reply,
      400,
      "schema_invalid",
      "Request does not match pim.memory-harness-search.v1",
      { requestId, details: error.issues },
    );
    return null;
  }
}

export default async function memoryHarnessSearchRoutes(app: FastifyInstance) {
  app.post<{ Body: unknown }>(
    "/api/v1/memory/harness/search",
    { bodyLimit: MAX_HARNESS_SEARCH_BYTES },
    async (req, reply) => {
    const auth = requireMemoryServiceScope(req, reply, "memory:harness:search");
    if (!auth) return;
    const requestedProjectId = projectIdFrom(req.body);
    if (requestedProjectId && !requireMemoryProjectBinding(req, reply, requestedProjectId)) return;
    const request = parseHarnessSearch(req.body, reply);
    if (!request) return;
    if (!requestedProjectId && !requireMemoryProjectBinding(req, reply, request.tenant.project_id)) return;
    const binding = requireMemoryHarnessBinding(
      req,
      reply,
      request.tenant.project_id,
      request.consumer.harness_id,
    );
    if (!binding) return;
    try {
      return executeHarnessMemorySearch({
        orgId: auth.orgId,
        projectId: request.tenant.project_id,
        principalId: auth.servicePrincipalId,
        binding,
        request,
      });
    } catch (error) {
      if (!(error instanceof MemoryHarnessSearchError)) throw error;
      return sendMemoryError(
        reply,
        error.statusCode,
        error.code,
        error.message,
        { requestId: request.request_id },
      );
    }
    },
  );
}
