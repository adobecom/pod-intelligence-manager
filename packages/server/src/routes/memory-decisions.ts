import type { FastifyInstance, FastifyReply } from "fastify";
import {
  MemoryContractValidationError,
  parseMemoryContract,
  type MemoryCandidateDecisionV1,
} from "@pim/shared";
import {
  requireMemoryHarnessBinding,
  requireMemoryProjectBinding,
  requireMemoryRepositoryBinding,
  requireMemoryServicePrincipal,
  requireMemoryServiceScope,
} from "../middleware/service-authz.js";
import { sendMemoryError } from "../middleware/memory-errors.js";
import { scanForSecrets } from "../services/secret-scan.js";
import {
  decideMemoryCandidate,
  MemoryDecisionError,
} from "../services/memory-decisions.js";
import { getStoredMemoryCandidate } from "../services/memory-candidates.js";

const MAX_DECISION_BYTES = 16 * 1024;

function schemaVersion(value: unknown): unknown {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as { schema_version?: unknown }).schema_version
    : undefined;
}

function parseDecision(body: unknown, reply: FastifyReply): MemoryCandidateDecisionV1 | null {
  if (schemaVersion(body) !== "pim.memory-candidate-decision.v1") {
    sendMemoryError(
      reply,
      400,
      "contract_version_unsupported",
      "Supported decision schema is pim.memory-candidate-decision.v1",
    );
    return null;
  }
  try {
    return parseMemoryContract("MemoryCandidateDecisionV1", body);
  } catch (error) {
    if (!(error instanceof MemoryContractValidationError)) throw error;
    sendMemoryError(
      reply,
      400,
      "schema_invalid",
      "Request does not match pim.memory-candidate-decision.v1",
      { details: error.issues },
    );
    return null;
  }
}

export default async function memoryDecisionRoutes(app: FastifyInstance) {
  app.post<{
    Params: { candidate_id: string };
    Body: unknown;
  }>(
    "/api/v1/memory/candidates/:candidate_id/decisions",
    { bodyLimit: MAX_DECISION_BYTES },
    async (req, reply) => {
      const auth = requireMemoryServicePrincipal(req, reply);
      if (!auth) return;
      if (!auth.projectId || auth.podId) {
        return sendMemoryError(
          reply,
          403,
          "resource_binding_mismatch",
          "Candidate review requires a project-bound service token",
        );
      }
      const stored = getStoredMemoryCandidate(
        auth.orgId,
        auth.projectId,
        req.params.candidate_id,
      );
      if (!stored) {
        return sendMemoryError(reply, 404, "resource_not_found", "Memory candidate is unavailable");
      }
      if (!requireMemoryProjectBinding(req, reply, auth.projectId)) return;
      if (stored.candidate.plane === "harness") {
        if (!requireMemoryServiceScope(req, reply, "memory:harness:review")) return;
        const harnessId = (stored.candidate.applicability as { harness_id?: unknown }).harness_id;
        if (typeof harnessId !== "string"
            || stored.row.repository_row_id !== null
            || !requireMemoryHarnessBinding(req, reply, auth.projectId, harnessId)) return;
      } else if (stored.candidate.plane === "codebase") {
        if (!requireMemoryServiceScope(req, reply, "memory:review")) return;
      } else {
        return sendMemoryError(
          reply,
          403,
          "resource_binding_mismatch",
          "Organization-plane candidates are outside this review surface",
        );
      }
      const repositoryId = (stored.candidate.applicability as { repository_id?: unknown }).repository_id;
      if (stored.candidate.plane === "codebase" && typeof repositoryId !== "string") {
        return sendMemoryError(
          reply,
          403,
          "resource_binding_mismatch",
          "Candidate review requires an exact codebase repository binding",
        );
      }
      if (typeof repositoryId === "string") {
        const repository = requireMemoryRepositoryBinding(
          req,
          reply,
          auth.projectId,
          repositoryId,
        );
        if (!repository) return;
        if (repository.repository_row_id !== stored.row.repository_row_id) {
          return sendMemoryError(reply, 404, "resource_not_found", "Memory candidate is unavailable");
        }
      }
      const serialized = JSON.stringify(req.body);
      if (Buffer.byteLength(serialized, "utf8") > MAX_DECISION_BYTES) {
        return sendMemoryError(reply, 413, "schema_invalid", "Decision exceeds the published byte limit");
      }
      if (!scanForSecrets(serialized).clean) {
        return sendMemoryError(reply, 422, "schema_invalid", "Decision contains prohibited secret-shaped content");
      }
      const decision = parseDecision(req.body, reply);
      if (!decision) return;
      try {
        const result = decideMemoryCandidate({
          orgId: auth.orgId,
          projectId: auth.projectId,
          candidateId: req.params.candidate_id,
          reviewerId: auth.servicePrincipalId,
          decision,
        });
        return result
          ?? sendMemoryError(reply, 404, "resource_not_found", "Memory candidate is unavailable");
      } catch (error) {
        if (!(error instanceof MemoryDecisionError)) throw error;
        return sendMemoryError(reply, error.statusCode, error.code, error.message);
      }
    },
  );
}
