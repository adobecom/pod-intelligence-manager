import type { FastifyInstance } from "fastify";
import { getMemoryCapabilities } from "../services/memory-capabilities.js";

export default async function memoryCapabilitiesRoutes(app: FastifyInstance) {
  app.get("/api/v1/memory/capabilities", async () => getMemoryCapabilities());
}

