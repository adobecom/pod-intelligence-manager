import type { FastifyInstance, FastifyReply } from "fastify";
import {
  MemoryContractValidationError,
  parseMemoryContract,
  type MemoryPromptPolicyUpdateV1,
} from "@pim/shared";
import {
  requireAnyMemoryRepositoryBinding,
  requireMemoryProjectBinding,
  requireMemoryRepositoryBinding,
  requireMemoryServiceScope,
} from "../middleware/service-authz.js";
import { sendMemoryError } from "../middleware/memory-errors.js";
import {
  getMemoryPromptPolicy,
  MemoryPromptPolicyError,
  updateMemoryPromptPolicy,
} from "../services/memory-prompt-policy.js";

const MAX_POLICY_BYTES = 16 * 1024;

function schemaVersion(value: unknown): unknown {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as { schema_version?: unknown }).schema_version
    : undefined;
}

function parsePolicyUpdate(body: unknown, reply: FastifyReply): MemoryPromptPolicyUpdateV1 | null {
  if (schemaVersion(body) !== "pim.memory-prompt-policy-update.v1") {
    sendMemoryError(
      reply,
      400,
      "contract_version_unsupported",
      "Supported prompt policy schema is pim.memory-prompt-policy-update.v1",
    );
    return null;
  }
  try {
    return parseMemoryContract("MemoryPromptPolicyUpdateV1", body);
  } catch (error) {
    if (!(error instanceof MemoryContractValidationError)) throw error;
    sendMemoryError(
      reply,
      400,
      "schema_invalid",
      "Request does not match pim.memory-prompt-policy-update.v1",
      { details: error.issues },
    );
    return null;
  }
}

function sendPolicyError(reply: FastifyReply, error: unknown) {
  if (!(error instanceof MemoryPromptPolicyError)) throw error;
  return sendMemoryError(reply, error.statusCode, error.code, error.message);
}

export default async function memoryPromptPolicyRoutes(app: FastifyInstance) {
  app.get<{ Params: { project_id: string } }>(
    "/api/v1/memory/projects/:project_id/prompt-policy",
    async (req, reply) => {
      const auth = requireMemoryServiceScope(req, reply, "memory:admin");
      if (!auth) return;
      if (!requireMemoryProjectBinding(req, reply, req.params.project_id)) return;
      try {
        return getMemoryPromptPolicy(auth.orgId, req.params.project_id);
      } catch (error) {
        return sendPolicyError(reply, error);
      }
    },
  );

  app.put<{
    Params: { project_id: string };
    Body: unknown;
  }>(
    "/api/v1/memory/projects/:project_id/prompt-policy",
    { bodyLimit: MAX_POLICY_BYTES },
    async (req, reply) => {
      const auth = requireMemoryServiceScope(req, reply, "memory:admin");
      if (!auth) return;
      if (!requireMemoryProjectBinding(req, reply, req.params.project_id)) return;
      const update = parsePolicyUpdate(req.body, reply);
      if (!update) return;
      if (!requireAnyMemoryRepositoryBinding(req, reply, req.params.project_id)) return;
      for (const repositoryId of update.allowed_repository_ids) {
        if (!requireMemoryRepositoryBinding(
          req,
          reply,
          req.params.project_id,
          repositoryId,
        )) return;
      }
      try {
        return updateMemoryPromptPolicy({
          orgId: auth.orgId,
          projectId: req.params.project_id,
          principalId: auth.servicePrincipalId,
          update,
        });
      } catch (error) {
        return sendPolicyError(reply, error);
      }
    },
  );
}
