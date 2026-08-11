import type { FastifyRequest, FastifyReply } from "fastify";
import { verifyImsToken } from "./ims-verify.js";
import { upsertUserByIms, type UserRecord } from "../services/users.js";
import {
  isServiceTokenValue,
  verifyMemoryV2ServiceToken,
  verifyServiceToken,
  type ServiceTokenAuthMetadata,
} from "../services/service-tokens.js";
import {
  MemoryV2RequestAuthorizationError,
  type MemoryV2RequestAuthorizationSnapshot,
} from "../services/memory-v2-request-authorization.js";
import { recordMemoryMetric } from "../services/memory-metrics.js";
import {
  isMemoryApiPath,
  isMemoryV2ApiPath,
  sendMemoryPathError,
  sendMemoryV2Error,
} from "./memory-errors.js";

export type AuthMode = "trust" | "ims";

export interface UserInfo {
  id: string;
  email: string;
  display_name: string | null;
  ims_user_id: string | null;
  roles: string[];
}

export type RequestAuth = { kind: "ims_user" } | ServiceTokenAuthMetadata;

declare module "fastify" {
  interface FastifyRequest {
    user: UserInfo;
    userRecord: UserRecord;
    auth: RequestAuth;
    memoryV2Authorization?: MemoryV2RequestAuthorizationSnapshot;
  }
}

const TRUST_MODE_EMAIL = process.env.DEV_USER_EMAIL ?? "dev@local";
const TRUST_MODE_NAME = process.env.DEV_USER_NAME ?? "Local Dev";

function recordMemoryV2AuthenticationDenial(url: string): void {
  if (!isMemoryV2ApiPath(url)) return;
  const path = url.split("?", 1)[0];
  const operation = path === "/api/v2/memory/search"
    ? "search"
    : path.startsWith("/api/v2/memory/run-receipts/")
      ? "receipt_write"
      : path === "/api/v2/memory/readiness"
        ? "readiness"
        : path === "/api/v2/memory/feedback"
          ? "feedback_write"
          : path.startsWith("/api/v2/memory/candidates/") && path.endsWith("/decisions")
            ? "review"
            : path.startsWith("/api/v2/memory/candidates/")
              ? "candidate_read"
              : path.startsWith("/api/v2/memory/packs/")
                ? "pack"
              : path.endsWith("/history")
                ? "history"
                : path.startsWith("/api/v2/memory/records/")
                  ? "detail"
                  : path === "/api/v2/memory/binding"
                    ? "binding"
                    : path === "/api/v2/memory/capabilities"
                      ? "capabilities"
                      : "protocol";
  const codeRead = operation === "search" || operation === "history"
    || operation === "detail" || operation === "pack";
  const codeWrite = operation === "receipt_write"
    || operation === "feedback_write"
    || operation === "candidate_read"
    || operation === "review";
  const readinessPlane = operation === "readiness"
    ? new URL(url, "http://memory.local").searchParams.get("plane")
    : null;
  const readinessResource = readinessPlane === "codebase"
    ? { plane: "codebase", resource_type: "repository" }
    : readinessPlane === "harness"
      ? { plane: "harness", resource_type: "harness" }
      : operation === "readiness"
        ? { plane: "unresolved", resource_type: "unresolved" }
        : null;
  recordMemoryMetric({
    name: codeWrite || operation === "readiness"
      ? "MemoryOperationOutcome"
      : "SearchOutcome",
    value: 1,
    unit: "Count",
    dimensions: {
      transport: "direct_http",
      operation,
      ...(readinessResource ?? (codeRead || codeWrite ? {
        plane: operation === "detail" || operation === "pack" ? "unresolved" : "codebase",
        resource_type: operation === "detail" || operation === "pack" ? "unresolved" : "repository",
      } : {})),
      contract_version: "pim.memory.v2",
      outcome: "deny",
      reason: "authentication_required",
      status: "4xx",
    },
  });
}

function sendAuthenticationError(
  req: FastifyRequest,
  reply: FastifyReply,
  message: string,
): false {
  recordMemoryV2AuthenticationDenial(req.url);
  return sendMemoryPathError(
    req.url,
    reply,
    401,
    "authentication_required",
    message,
  );
}

function attach(req: FastifyRequest, record: UserRecord, auth: RequestAuth = { kind: "ims_user" }) {
  req.userRecord = record;
  req.user = {
    id: record.user_id,
    email: record.email,
    display_name: record.display_name,
    ims_user_id: record.ims_user_id,
    roles: ["user"],
  };
  req.auth = auth;
}

export function createAuthHook(mode: AuthMode) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const authHeader = req.headers.authorization;
    const bearerToken = authHeader?.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : null;

    if (isServiceTokenValue(bearerToken)) {
      let verified;
      try {
        verified = bearerToken
          ? isMemoryV2ApiPath(req.url)
            ? verifyMemoryV2ServiceToken(bearerToken)
            : verifyServiceToken(bearerToken)
          : null;
      } catch (error) {
        if (error instanceof MemoryV2RequestAuthorizationError) {
          return sendMemoryV2Error(
            reply,
            error.statusCode,
            error.code,
            error.statusCode >= 500
              ? "Memory service is temporarily unavailable"
              : error.message,
            { retryable: error.statusCode >= 500 },
          );
        }
        throw error;
      }
      if (!verified) {
        if (isMemoryApiPath(req.url)) {
          return sendAuthenticationError(req, reply, "Invalid or expired PIM service token");
        }
        return reply.code(401).send({ error: "Invalid or expired PIM service token" });
      }
      attach(req, verified.user, verified.auth);
      if ("authorization" in verified) {
        req.memoryV2Authorization = verified.authorization as MemoryV2RequestAuthorizationSnapshot;
      }
      return;
    }

    if (mode === "trust") {
      const record = upsertUserByIms({
        email: TRUST_MODE_EMAIL,
        display_name: TRUST_MODE_NAME,
      });
      attach(req, record);
      return;
    }

    if (!authHeader?.startsWith("Bearer ")) {
      if (isMemoryApiPath(req.url)) {
        return sendAuthenticationError(req, reply, "Missing or invalid Authorization header");
      }
      return reply.code(401).send({ error: "Missing or invalid Authorization header" });
    }
    const token = bearerToken ?? "";
    if (!token) {
      if (isMemoryApiPath(req.url)) {
        return sendAuthenticationError(req, reply, "Empty Bearer token");
      }
      return reply.code(401).send({ error: "Empty Bearer token" });
    }

    try {
      const claims = await verifyImsToken(token);
      const email = typeof claims.email === "string" ? claims.email : null;
      const imsUserId = typeof claims.user_id === "string" ? claims.user_id : (typeof claims.sub === "string" ? claims.sub : null);
      if (!imsUserId || !email) {
        return reply.code(401).send({ error: "IMS token missing user_id or email claim" });
      }
      const record = upsertUserByIms({
        ims_user_id: imsUserId,
        email,
        display_name: typeof claims.name === "string" ? claims.name : null,
      });
      attach(req, record);
    } catch (err) {
      req.log.warn({ err }, "IMS token verification failed");
      if (isMemoryApiPath(req.url)) {
        return sendAuthenticationError(req, reply, "Invalid or expired IMS token");
      }
      return reply.code(401).send({ error: "Invalid or expired IMS token" });
    }
  };
}
