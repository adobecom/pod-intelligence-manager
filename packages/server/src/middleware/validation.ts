import type { FastifyRequest, FastifyReply } from "fastify";
import type { ZodSchema, ZodError } from "zod";

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
