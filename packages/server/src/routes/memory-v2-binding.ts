import type { FastifyInstance } from "fastify";
import { sendMemoryV2Error } from "../middleware/memory-errors.js";
import {
  getMemoryV2Binding,
  MemoryV2BindingError,
} from "../services/memory-v2-binding.js";

export default async function memoryV2BindingRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v2/memory/binding", async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    reply.header("Vary", "Authorization");
    try {
      return getMemoryV2Binding(
        req.memoryV2Authorization ?? null,
      );
    } catch (error) {
      if (error instanceof MemoryV2BindingError) {
        return sendMemoryV2Error(
          reply,
          error.statusCode,
          error.code,
          error.message,
        );
      }
      throw error;
    }
  });
}
