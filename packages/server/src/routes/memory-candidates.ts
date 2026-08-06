import type { FastifyInstance } from "fastify";
import { sendMemoryError } from "../middleware/memory-errors.js";
import {
  requireAnyMemoryRepositoryBinding,
  requireMemoryRepositoryBinding,
  requireMemoryServiceScope,
} from "../middleware/service-authz.js";
import {
  getMemoryCandidateStatus,
  getStoredMemoryCandidate,
} from "../services/memory-candidates.js";

export default async function memoryCandidateRoutes(app: FastifyInstance) {
  app.get<{ Params: { candidate_id: string } }>(
    "/api/v1/memory/candidates/:candidate_id",
    async (req, reply) => {
      const auth = requireMemoryServiceScope(req, reply, "memory:candidate:read");
      if (!auth) return;
      if (!auth.projectId || auth.podId) {
        return sendMemoryError(
          reply,
          403,
          "resource_binding_mismatch",
          "Candidate detail requires a project-bound service token",
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
      const repositoryId = (stored.candidate.applicability as { repository_id?: unknown }).repository_id;
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
      } else if (!requireAnyMemoryRepositoryBinding(req, reply, auth.projectId)) return;
      const status = getMemoryCandidateStatus(
        auth.orgId,
        auth.projectId,
        req.params.candidate_id,
      );
      if (!status) {
        return sendMemoryError(reply, 404, "resource_not_found", "Memory candidate is unavailable");
      }
      return status;
    },
  );
}
