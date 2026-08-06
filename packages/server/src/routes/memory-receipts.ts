import type { FastifyInstance, FastifyReply } from "fastify";
import {
  MemoryContractValidationError,
  parseMemoryContract,
  type RunReceiptV1,
} from "@pim/shared";
import {
  requireMemoryHarnessBinding,
  requireMemoryProjectBinding,
  requireMemoryRepositoryBinding,
  requireMemoryServiceScope,
} from "../middleware/service-authz.js";
import { sendMemoryError } from "../middleware/memory-errors.js";
import { scanForSecrets } from "../services/secret-scan.js";
import { MEMORY_LIMITS } from "../services/memory-capabilities.js";
import { runMemoryOutboxPass } from "../services/memory-outbox.js";
import { reconcileUnmatchedGithubAttestations } from "../services/memory-attestations.js";
import {
  acceptMemoryRunReceipt,
  MemoryReceiptError,
  refreshMemoryReceiptResult,
} from "../services/memory-receipts.js";

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function rawProjectId(body: unknown): string | null {
  const tenant = objectValue(objectValue(body)?.tenant);
  return typeof tenant?.project_id === "string" ? tenant.project_id : null;
}

function rawRepositoryId(body: unknown): string | null {
  const repository = objectValue(objectValue(body)?.repository);
  return typeof repository?.repository_id === "string" ? repository.repository_id : null;
}

function rawCandidates(body: unknown): unknown[] {
  const candidates = objectValue(body)?.candidates;
  return Array.isArray(candidates) ? candidates : [];
}

function isRawHarnessOnlyReceipt(body: unknown): boolean {
  const candidates = rawCandidates(body);
  return rawRepositoryId(body) === null
    && rawFeedbackCount(body) === 0
    && candidates.length > 0
    && candidates.every((candidate) => objectValue(candidate)?.plane === "harness");
}

function rawFeedbackCount(body: unknown): number {
  const groups = objectValue(body)?.retrieval_feedback;
  if (!Array.isArray(groups)) return 0;
  return groups.reduce((total, group) => {
    const items = objectValue(group)?.items;
    return total + (Array.isArray(items) ? items.length : 0);
  }, 0);
}

function rawEvidenceRefCount(body: unknown): number {
  const manifest = objectValue(objectValue(body)?.evidence_manifest);
  return Array.isArray(manifest?.refs) ? manifest.refs.length : 0;
}

function parseReceipt(body: unknown, reply: FastifyReply): RunReceiptV1 | null {
  const version = objectValue(body)?.schema_version;
  if (version !== "pim.run-receipt.v1") {
    sendMemoryError(
      reply,
      400,
      "contract_version_unsupported",
      "Supported receipt schema is pim.run-receipt.v1",
    );
    return null;
  }
  try {
    return parseMemoryContract("RunReceiptV1", body);
  } catch (error) {
    if (!(error instanceof MemoryContractValidationError)) throw error;
    sendMemoryError(
      reply,
      400,
      "schema_invalid",
      "Request does not match pim.run-receipt.v1",
      { details: error.issues },
    );
    return null;
  }
}

export default async function memoryReceiptRoutes(app: FastifyInstance) {
  app.put<{
    Params: { producer_run_id: string };
    Body: unknown;
    Headers: { "idempotency-key"?: string };
  }>(
    "/api/v1/memory/run-receipts/:producer_run_id",
    { bodyLimit: MEMORY_LIMITS.max_receipt_bytes },
    async (req, reply) => {
      const harnessOnly = isRawHarnessOnlyReceipt(req.body);
      const auth = requireMemoryServiceScope(
        req,
        reply,
        harnessOnly ? "memory:harness:receipt:write" : "memory:receipt:write",
      );
      if (!auth) return;
      const producerRunId = req.params.producer_run_id;
      if (!producerRunId || producerRunId.length > 256) {
        return sendMemoryError(
          reply,
          400,
          "schema_invalid",
          "producer_run_id must contain 1 to 256 characters",
          { details: [{ path: "/producer_run_id", reason: "invalid path identity" }] },
        );
      }

      const requestedProjectId = rawProjectId(req.body);
      if (requestedProjectId && !requireMemoryProjectBinding(req, reply, requestedProjectId)) return;
      const requestedRepositoryId = rawRepositoryId(req.body);
      let repository = null;
      if (requestedProjectId && requestedRepositoryId) {
        repository = requireMemoryRepositoryBinding(
          req,
          reply,
          requestedProjectId,
          requestedRepositoryId,
        );
        if (!repository) return;
      }

      const serialized = JSON.stringify(req.body);
      if (Buffer.byteLength(serialized, "utf8") > MEMORY_LIMITS.max_receipt_bytes) {
        return sendMemoryError(reply, 413, "schema_invalid", "Receipt exceeds the published byte limit");
      }
      if (rawCandidates(req.body).some((candidate) => (
        Buffer.byteLength(JSON.stringify(candidate), "utf8") > MEMORY_LIMITS.max_candidate_bytes
      ))) {
        return sendMemoryError(reply, 413, "schema_invalid", "Candidate exceeds the published byte limit");
      }
      if (rawFeedbackCount(req.body) > MEMORY_LIMITS.max_feedback_items) {
        return sendMemoryError(reply, 413, "schema_invalid", "Receipt exceeds the published feedback-item limit");
      }
      if (rawEvidenceRefCount(req.body) > MEMORY_LIMITS.max_evidence_refs) {
        return sendMemoryError(reply, 413, "schema_invalid", "Evidence manifest exceeds the published reference limit");
      }
      if (!scanForSecrets(serialized).clean) {
        return sendMemoryError(reply, 422, "schema_invalid", "Receipt contains prohibited secret-shaped content");
      }

      const receipt = parseReceipt(req.body, reply);
      if (!receipt) return;
      if (!requestedProjectId && !requireMemoryProjectBinding(req, reply, receipt.tenant.project_id)) return;
      if (!harnessOnly && receipt.candidates.some((candidate) => candidate.plane === "harness")) {
        return sendMemoryError(
          reply,
          403,
          "resource_binding_mismatch",
          "Harness candidates require the dedicated harness receipt scope and binding",
        );
      }
      if (harnessOnly) {
        const binding = requireMemoryHarnessBinding(
          req,
          reply,
          receipt.tenant.project_id,
          receipt.producer.harness_id,
        );
        if (!binding) return;
        if (receipt.repository || receipt.retrieval_feedback?.length
            || receipt.candidates.some((candidate) => (
              candidate.plane !== "harness"
              || (candidate.applicability as { harness_id?: unknown }).harness_id !== binding.harnessId
            ))) {
          return sendMemoryError(
            reply,
            403,
            "resource_binding_mismatch",
            "Harness receipt content does not match the authenticated harness binding",
          );
        }
      }
      if (receipt.repository && !repository) {
        repository = requireMemoryRepositoryBinding(
          req,
          reply,
          receipt.tenant.project_id,
          receipt.repository.repository_id,
        );
        if (!repository) return;
      }
      try {
        const accepted = acceptMemoryRunReceipt({
          orgId: auth.orgId,
          projectId: receipt.tenant.project_id,
          principalId: auth.servicePrincipalId,
          producerRunId,
          idempotencyKey: req.headers["idempotency-key"],
          repository,
          receipt,
        });
        if (!accepted.created || accepted.result.candidate_results.length === 0) return accepted.result;
        runMemoryOutboxPass({
          workerId: `receipt:${accepted.result.receipt_id}`,
          maxJobs: accepted.result.candidate_results.length,
          aggregateIds: accepted.result.candidate_results.map((item) => item.candidate_id),
        });
        const result = refreshMemoryReceiptResult(accepted.result.receipt_id) ?? accepted.result;
        if (repository) {
          await reconcileUnmatchedGithubAttestations({
            repositoryRowId: repository.repository_row_id,
          });
        }
        return result;
      } catch (error) {
        if (!(error instanceof MemoryReceiptError)) throw error;
        return sendMemoryError(
          reply,
          error.statusCode,
          error.code,
          error.message,
          { details: error.details },
        );
      }
    },
  );
}
