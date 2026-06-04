import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { ZodSchema, ZodError } from "zod";

/**
 * Fastify's built-in JSON parser rejects requests with
 * `Content-Type: application/json` and an empty body before route handlers run.
 * Several action-style POST endpoints intentionally have no body, so normalize
 * empty JSON payloads to `{}` and keep normal JSON parse errors intact.
 */
export function registerJsonBodyParser(app: FastifyInstance): void {
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const text = (typeof body === "string" ? body : body.toString("utf-8")).trim();
    if (text.length === 0) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(text) as unknown);
    } catch (err) {
      done(err as Error);
    }
  });
}

/**
 * Creates a Fastify preHandler hook that validates req.body against a Zod schema.
 * Returns 400 with structured error on validation failure.
 */
export function validateBody(schema: ZodSchema) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return reply.code(400).send({
        error: "Validation failed",
        details: formatZodError(result.error),
      });
    }
    // Replace body with parsed (coerced/defaulted) data
    (req as any).body = result.data;
  };
}

function formatZodError(error: ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    return `${path}${issue.message}`;
  });
}
