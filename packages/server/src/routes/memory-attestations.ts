import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  MemoryContractValidationError,
  parseMemoryContract,
  type MemoryAttestationV1,
} from "@pim/shared";
import {
  requireMemoryRepositoryBinding,
  requireMemoryServiceScope,
} from "../middleware/service-authz.js";
import { sendMemoryError } from "../middleware/memory-errors.js";
import {
  MemoryAttestationIngressError,
  submitGithubMemoryAttestation,
} from "../services/memory-attestations.js";

const MAX_ATTESTATION_AGE_MS = 10 * 60 * 1000;
const MAX_ATTESTATION_BYTES = 64 * 1024;
const DELIVERY_ID_RE = /^[A-Za-z0-9-]{1,200}$/;

function stringHeader(value: string | string[] | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function verifyGitHubSignature(
  rawBody: Buffer,
  signatureHeader: string | null,
  secret: string,
): boolean {
  const match = signatureHeader?.match(/^sha256=([0-9a-f]{64})$/i);
  if (!match) return false;
  const presented = Buffer.from(match[1], "hex");
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

function parseAttestation(rawBody: Buffer, reply: FastifyReply): MemoryAttestationV1 | null {
  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString("utf8")) as unknown;
  } catch {
    sendMemoryError(reply, 400, "schema_invalid", "GitHub attestation body must be valid JSON");
    return null;
  }
  const version = body && typeof body === "object" && !Array.isArray(body)
    ? (body as { schema_version?: unknown }).schema_version
    : undefined;
  if (version !== "pim.memory-attestation.v1") {
    sendMemoryError(
      reply,
      400,
      "contract_version_unsupported",
      "Supported attestation schema is pim.memory-attestation.v1",
    );
    return null;
  }
  try {
    return parseMemoryContract("MemoryAttestationV1", body);
  } catch (error) {
    if (!(error instanceof MemoryContractValidationError)) throw error;
    sendMemoryError(
      reply,
      400,
      "schema_invalid",
      "Request does not match pim.memory-attestation.v1",
      { details: error.issues },
    );
    return null;
  }
}

export default async function memoryAttestationRoutes(app: FastifyInstance) {
  // GitHub signs the exact bytes. Override the root parser only inside this
  // encapsulated plugin; the route configuration also keeps the body out of logs.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { bodyLimit: MAX_ATTESTATION_BYTES, parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );

  app.post<{ Body: Buffer }>(
    "/api/v1/memory/attestations/github",
    {
      bodyLimit: MAX_ATTESTATION_BYTES,
      config: { suppressRequestBodyLogging: true },
    },
    async (req, reply) => {
      const auth = requireMemoryServiceScope(req, reply, "memory:attest");
      if (!auth) return;
      if (!auth.projectId || auth.podId) {
        return sendMemoryError(
          reply,
          403,
          "resource_binding_mismatch",
          "GitHub attestation ingress requires a project-bound service token",
        );
      }

      const secret = process.env.MEMORY_GITHUB_WEBHOOK_SECRET;
      if (!secret) {
        return sendMemoryError(
          reply,
          503,
          "temporarily_unavailable",
          "GitHub attestation ingress is not configured",
        );
      }
      const signature = stringHeader(req.headers["x-hub-signature-256"]);
      if (!verifyGitHubSignature(req.body, signature, secret)) {
        return sendMemoryError(
          reply,
          401,
          "authentication_required",
          "GitHub webhook signature is missing or invalid",
        );
      }

      const deliveryId = stringHeader(req.headers["x-github-delivery"]);
      if (!deliveryId || !DELIVERY_ID_RE.test(deliveryId)) {
        return sendMemoryError(
          reply,
          400,
          "schema_invalid",
          "X-GitHub-Delivery must be a bounded provider delivery ID",
        );
      }
      if (stringHeader(req.headers["x-github-event"]) !== "pull_request") {
        return sendMemoryError(
          reply,
          400,
          "schema_invalid",
          "GitHub attestation ingress accepts only pull_request events",
        );
      }

      const attestation = parseAttestation(req.body, reply);
      if (!attestation) return;
      if (attestation.type !== "github_merge" && attestation.type !== "github_revert") {
        return sendMemoryError(
          reply,
          400,
          "schema_invalid",
          "GitHub ingress accepts only merge and revert attestations",
          { details: [{ path: "/type", reason: "unsupported GitHub attestation type" }] },
        );
      }
      if (attestation.provider_event_id !== deliveryId) {
        return sendMemoryError(
          reply,
          422,
          "evidence_mismatch",
          "GitHub delivery ID does not match the signed attestation",
        );
      }
      const occurredAt = Date.parse(attestation.occurred_at);
      if (!Number.isFinite(occurredAt) || Math.abs(Date.now() - occurredAt) > MAX_ATTESTATION_AGE_MS) {
        return sendMemoryError(
          reply,
          422,
          "evidence_mismatch",
          "GitHub attestation timestamp is outside the accepted replay window",
        );
      }

      const repository = requireMemoryRepositoryBinding(
        req,
        reply,
        auth.projectId,
        attestation.repository_id,
      );
      if (!repository) return;

      try {
        return await submitGithubMemoryAttestation({
          auth,
          repository,
          deliveryId,
          rawBody: req.body,
          attestation,
        });
      } catch (error) {
        if (!(error instanceof MemoryAttestationIngressError)) throw error;
        return sendMemoryError(reply, error.statusCode, error.code, error.message);
      }
    },
  );
}
