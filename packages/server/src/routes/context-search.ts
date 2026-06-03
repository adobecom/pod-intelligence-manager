import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ContextSearchRequest } from "@pim/shared";
import { searchContext } from "../services/context-search.js";
import { validateBody } from "../middleware/validation.js";

const ContextSourceSchema = z.enum([
  "kg",
  "slack",
  "fluffyjaws",
  "jira",
  "confluence",
  "github",
  "git",
]);

const ActorSchema = z
  .object({
    email: z.string().email().optional(),
    slack_user_id: z.string().optional(),
    github_login: z.string().optional(),
    display_name: z.string().optional(),
  })
  .optional();

function isValidTimestamp(value: string | undefined): boolean {
  return !!value && !Number.isNaN(new Date(value).getTime());
}

const ContextSearchRequestSchema = z.object({
  query: z.string().min(1, "query is required"),
  sources: z.array(ContextSourceSchema).optional(),
  pod_id: z.string().optional(),
  project_id: z.string().optional(),
  actor: ActorSchema,
  time_window_days: z.number().int().positive().max(3650).optional(),
  max_hits_per_source: z.number().int().positive().max(50).optional(),
  synthesize: z.boolean().optional(),
  use_cache: z.boolean().optional(),
  query_mode: z.enum(["current", "history", "as_of", "why_changed"]).optional(),
  as_of: z.string().optional(),
}).superRefine((body, ctx) => {
  if (body.query_mode === "as_of" && !isValidTimestamp(body.as_of)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["as_of"],
      message: "as_of must be a valid timestamp when query_mode is as_of",
    });
  }
});

export default async function contextSearchRoutes(app: FastifyInstance) {
  app.post<{ Body: ContextSearchRequest }>(
    "/api/context-search",
    { preHandler: validateBody(ContextSearchRequestSchema) },
    async (req) => {
      // Forward the authenticated caller's email so the orchestrator can
      // fall back to scoping Jira to the user (and their orgs' projects)
      // when the request carries no explicit project/pod/actor scope.
      // req.user is populated by the global auth hook in middleware/auth.ts.
      return searchContext(req.body, req.org!.org_id, { authenticatedUserEmail: req.user?.email });
    },
  );
}
