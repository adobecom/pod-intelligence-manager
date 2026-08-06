import type { FastifyReply } from "fastify";
import type { PimErrorV1 } from "@pim/shared";

export type PimMemoryErrorCode = PimErrorV1["code"];

export function isMemoryApiPath(url: string): boolean {
  const path = url.split("?", 1)[0];
  return path === "/api/v1/memory" || path.startsWith("/api/v1/memory/");
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

