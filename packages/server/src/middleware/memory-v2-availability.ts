import type { FastifyInstance } from "fastify";
import { isMemoryV2ApiPath, sendMemoryV2Error } from "./memory-errors.js";
import {
  getMemoryV2Availability,
  memoryV2UnavailableError,
} from "../services/memory-v2-availability.js";

export function registerMemoryV2AvailabilityGuard(app: FastifyInstance): void {
  app.addHook("onRequest", async (request, reply) => {
    if (!isMemoryV2ApiPath(request.url)) return;
    const availability = getMemoryV2Availability();
    if (availability.status === "ready") return;
    const error = memoryV2UnavailableError(availability);
    sendMemoryV2Error(reply, 503, error.code, error.message, {
      retryable: error.retryable,
      details: error.details,
    });
  });
}
