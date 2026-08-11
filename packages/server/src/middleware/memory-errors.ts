import type { FastifyReply } from "fastify";
import type { MemoryPlaneV2, PimErrorV1, PimErrorV2 } from "@pim/shared";

export type PimMemoryErrorCode = PimErrorV1["code"];

export type PimMemoryV2ErrorCode = PimErrorV2["code"];

export function isMemoryApiPath(url: string): boolean {
  const path = url.split("?", 1)[0];
  return path === "/api/v1/memory"
    || path.startsWith("/api/v1/memory/")
    || path === "/api/v2/memory"
    || path.startsWith("/api/v2/memory/");
}

export function isMemoryV2ApiPath(url: string): boolean {
  const path = url.split("?", 1)[0];
  return path === "/api/v2/memory" || path.startsWith("/api/v2/memory/");
}

export function setMemoryV2PrivateResponseHeaders(reply: FastifyReply): void {
  reply.header("Cache-Control", "private, no-store");
  const currentVary = reply.getHeader("Vary");
  const varyValues = (Array.isArray(currentVary)
    ? currentVary.join(",")
    : typeof currentVary === "string"
      ? currentVary
      : "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!varyValues.some((value) => value.toLowerCase() === "authorization")) {
    varyValues.push("Authorization");
  }
  reply.header("Vary", varyValues.join(", "));
}

export function sendMemoryError(
  reply: FastifyReply,
  statusCode: number,
  code: PimMemoryErrorCode,
  message: string,
  options: { requestId?: string; details?: PimErrorV1["details"] } = {},
): false {
  const body: PimErrorV1 = {
    schema_version: "pim.error.v1",
    code,
    message,
    ...(options.requestId ? { request_id: options.requestId } : {}),
    ...(options.details?.length ? { details: options.details } : {}),
  };
  reply.code(statusCode).send(body);
  return false;
}


/** V2 errors intentionally have their own envelope so extending the v2 error
 * vocabulary never widens or changes the frozen v1 contract. */
export function sendMemoryV2Error(
  reply: FastifyReply,
  statusCode: number,
  code: PimMemoryV2ErrorCode,
  message: string,
  options: {
    requestId?: string | null;
    plane?: MemoryPlaneV2 | null;
    retryable?: boolean;
    details?: PimErrorV2["details"];
  } = {},
): false {
  setMemoryV2PrivateResponseHeaders(reply);
  reply.code(statusCode).send({
    schema_version: "pim.error.v2",
    code,
    message,
    request_id: options.requestId ?? null,
    plane: options.plane ?? null,
    retryable: options.retryable ?? statusCode >= 500,
    details: options.details ?? [],
  });
  return false;
}

export function sendMemoryPathError(
  url: string,
  reply: FastifyReply,
  statusCode: number,
  code: PimMemoryErrorCode,
  message: string,
  options: {
    requestId?: string;
    details?: PimErrorV1["details"] | PimErrorV2["details"];
  } = {},
): false {
  return isMemoryV2ApiPath(url)
    ? sendMemoryV2Error(reply, statusCode, code, message, {
        requestId: options.requestId,
        details: options.details as PimErrorV2["details"] | undefined,
      })
    : sendMemoryError(reply, statusCode, code, message, {
        requestId: options.requestId,
        details: options.details as PimErrorV1["details"] | undefined,
      });
}
