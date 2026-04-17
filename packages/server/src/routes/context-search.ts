import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ContextSearchRequest } from "@council/shared";
import { searchContext } from "../services/context-search.js";
import { validateBody } from "../middleware/validation.js";

const ContextSourceSchema = z.enum([
  "slack",
  "fluffyjaws",
  "jira",
  "confluence",
  "github",
  "git",
]);

const ContextSearchRequestSchema = z.object({
  query: z.string().min(1, "query is required"),
  sources: z.array(ContextSourceSchema).optional(),
  pod_id: z.string().optional(),
  time_window_days: z.number().int().positive().max(3650).optional(),
  max_hits_per_source: z.number().int().positive().max(50).optional(),
  synthesize: z.boolean().optional(),
  use_cache: z.boolean().optional(),
});

export default async function contextSearchRoutes(app: FastifyInstance) {
  app.post<{ Body: ContextSearchRequest }>(
    "/api/context-search",
    { preHandler: validateBody(ContextSearchRequestSchema) },
    async (req) => {
      return searchContext(req.body);
    },
  );
}
