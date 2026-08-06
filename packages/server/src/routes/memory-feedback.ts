import type { FastifyInstance, FastifyReply } from "fastify";
import {
  MemoryContractValidationError,
  parseMemoryContract,
  type MemoryFeedbackV1,
} from "@pim/shared";
import {
  requireMemoryRepositoryBinding,
  requireMemoryServiceScope,
} from "../middleware/service-authz.js";
import { sendMemoryError } from "../middleware/memory-errors.js";
import { scanForSecrets } from "../services/secret-scan.js";
import { recordMemoryMetric } from "../services/memory-metrics.js";
import {
  appendMemoryFeedback,
  MemoryFeedbackError,
} from "../services/memory-feedback.js";

const MAX_FEEDBACK_BYTES = 32 * 1024;

function schemaVersion(value: unknown): unknown {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as { schema_version?: unknown }).schema_version
    : undefined;
}

function parseFeedback(body: unknown, reply: FastifyReply): MemoryFeedbackV1 | null {
  if (schemaVersion(body) !== "pim.memory-feedback.v1") {
    sendMemoryError(
      reply,
      400,
      "contract_version_unsupported",
      "Supported feedback schema is pim.memory-feedback.v1",
    );
    return null;
  }
  try {
    return parseMemoryContract("MemoryFeedbackV1", body);
  } catch (error) {
    if (!(error instanceof MemoryContractValidationError)) throw error;
    sendMemoryError(
      reply,
      400,
      "schema_invalid",
      "Request does not match pim.memory-feedback.v1",
      { details: error.issues },
    );
    return null;
  }
}

export default async function memoryFeedbackRoutes(app: FastifyInstance) {
  app.post<{ Body: unknown }>(
    "/api/v1/memory/feedback",
    { bodyLimit: MAX_FEEDBACK_BYTES },
    async (req, reply) => {
      const auth = requireMemoryServiceScope(req, reply, "memory:feedback:write");
      if (!auth) return;
      if (!auth.projectId || auth.podId) {
        return sendMemoryError(
          reply,
          403,
          "resource_binding_mismatch",
          "Later memory feedback requires a project-bound service token",
        );
      }
      const serialized = JSON.stringify(req.body);
      if (Buffer.byteLength(serialized, "utf8") > MAX_FEEDBACK_BYTES) {
        return sendMemoryError(reply, 413, "schema_invalid", "Feedback exceeds the published byte limit");
      }
      if (!scanForSecrets(serialized).clean) {
        return sendMemoryError(reply, 422, "schema_invalid", "Feedback contains prohibited secret-shaped content");
      }
      const feedback = parseFeedback(req.body, reply);
      if (!feedback) return;
      const repository = requireMemoryRepositoryBinding(
        req,
        reply,
        auth.projectId,
        feedback.repository_id,
      );
      if (!repository) return;
      try {
        const result = appendMemoryFeedback({
          orgId: auth.orgId,
          projectId: auth.projectId,
          repository,
          feedback,
        });
        const fields = {
          org_id: auth.orgId,
          project_id: auth.projectId,
          repository_id: repository.repository_id,
          producer_run_id: feedback.producer_run_id,
          retrieval_pack_id: feedback.retrieval_pack_id,
          record_id: feedback.record_id,
          record_version: feedback.record_version,
          feedback_id: result.feedback_id,
          reason_code: feedback.reason_code,
        };
        recordMemoryMetric({
          name: "FeedbackOutcome",
          value: 1,
          unit: "Count",
          dimensions: {
            outcome: result.duplicate ? "replay" : "accepted",
            disposition: feedback.disposition,
          },
          fields,
        });
        if (result.review_signal_ids.length > 0) {
          recordMemoryMetric({
            name: "ReviewSignalCount",
            value: result.review_signal_ids.length,
            unit: "Count",
            dimensions: { disposition: feedback.disposition },
            fields,
          });
        }
        return result;
      } catch (error) {
        if (!(error instanceof MemoryFeedbackError)) throw error;
        recordMemoryMetric({
          name: "FeedbackOutcome",
          value: 1,
          unit: "Count",
          dimensions: {
            outcome: "rejected",
            disposition: feedback.disposition,
          },
          fields: {
            org_id: auth.orgId,
            project_id: auth.projectId,
            repository_id: repository.repository_id,
            producer_run_id: feedback.producer_run_id,
            retrieval_pack_id: feedback.retrieval_pack_id,
            record_id: feedback.record_id,
            record_version: feedback.record_version,
            reason_code: error.code,
          },
        });
        return sendMemoryError(reply, error.statusCode, error.code, error.message);
      }
    },
  );
}
