import type { FastifyRequest, FastifyReply } from "fastify";

export interface UserInfo {
  id: string;
  roles: string[];
}

declare module "fastify" {
  interface FastifyRequest {
    user: UserInfo;
  }
}

export function createAuthHook(mode: "trust" | "ims") {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (mode === "trust") {
      req.user = { id: "anonymous", roles: ["admin"] };
      return;
    }

    // IMS mode: verify Adobe IMS JWT from Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return reply.code(401).send({ error: "Missing or invalid Authorization header" });
    }

    // TODO: implement Adobe IMS JWT verification
    // For now, set a placeholder user
    req.user = { id: "ims-unverified", roles: ["admin"] };
  };
}
