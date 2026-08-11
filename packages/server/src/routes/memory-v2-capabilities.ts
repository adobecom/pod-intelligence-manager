import type { FastifyInstance } from "fastify";
import { getMemoryV2Capabilities } from "../services/memory-v2-capabilities.js";

export default async function memoryV2CapabilitiesRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v2/memory/capabilities", async () => getMemoryV2Capabilities());
}
