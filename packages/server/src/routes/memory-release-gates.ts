import type { FastifyInstance, FastifyReply } from "fastify";
import {
  MemoryContractValidationError,
  parseMemoryContract,
  type MemoryReleaseGateEvaluationV1,
} from "@pim/shared";
import {
  requireMemoryProjectBinding,
  requireMemoryServiceScope,
} from "../middleware/service-authz.js";
import { sendMemoryError } from "../middleware/memory-errors.js";
import { getMemoryOperationalSnapshot } from "../services/memory-metrics.js";
import { evaluateMemoryReleaseGates } from "../services/memory-release-gates.js";

const MAX_GATE_EVALUATION_BYTES = 32 * 1024;

function schemaVersion(value: unknown): unknown {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as { schema_version?: unknown }).schema_version
    : undefined;
}

function parseEvaluation(
  body: unknown,
  reply: FastifyReply,
): MemoryReleaseGateEvaluationV1 | null {
  if (schemaVersion(body) !== "pim.memory-release-gate-evaluation.v1") {
    sendMemoryError(
      reply,
      400,
      "contract_version_unsupported",
      "Supported release-gate schema is pim.memory-release-gate-evaluation.v1",
    );
    return null;
  }
  try {
    return parseMemoryContract("MemoryReleaseGateEvaluationV1", body);
  } catch (error) {
    if (!(error instanceof MemoryContractValidationError)) throw error;
    sendMemoryError(
      reply,
      400,
      "schema_invalid",
      "Request does not match pim.memory-release-gate-evaluation.v1",
      { details: error.issues },
    );
    return null;
  }
}

export default async function memoryReleaseGateRoutes(app: FastifyInstance) {
  app.post<{
    Params: { project_id: string };
    Body: unknown;
  }>(
    "/api/v1/memory/projects/:project_id/release-gates/evaluate",
    { bodyLimit: MAX_GATE_EVALUATION_BYTES },
    async (req, reply) => {
      const auth = requireMemoryServiceScope(req, reply, "memory:admin");
      if (!auth) return;
      if (!requireMemoryProjectBinding(req, reply, req.params.project_id)) return;
      const evaluation = parseEvaluation(req.body, reply);
      if (!evaluation) return;

      // Caller-supplied representative-evaluation measurements are anchored by
      // dataset_digest. Persisted integrity failures are server authority and
      // can only strengthen (never weaken) the submitted safety snapshot.
      const operational = getMemoryOperationalSnapshot(auth.orgId, req.params.project_id);
      const snapshot = {
        ...evaluation.metric_snapshot,
        known_boundary_leakage_count: Math.max(
          evaluation.metric_snapshot.known_boundary_leakage_count,
          operational.crossBoundaryLeakageCount,
        ),
        unresolved_active_pointer_count: Math.max(
          evaluation.metric_snapshot.unresolved_active_pointer_count,
          operational.activeCandidatesWithoutCanonicalRecords,
        ),
      };
      return evaluateMemoryReleaseGates({
        orgId: auth.orgId,
        projectId: req.params.project_id,
        stage: evaluation.stage,
        datasetDigest: evaluation.dataset_digest,
        snapshot,
      });
    },
  );
}
