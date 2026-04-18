import type { FastifyRequest, FastifyReply } from "fastify";
import { verifyImsToken } from "./ims-verify.js";
import { upsertUserByIms, type UserRecord } from "../services/users.js";

export type AuthMode = "trust" | "ims";

export interface UserInfo {
  id: string;
  email: string;
  display_name: string | null;
  ims_user_id: string | null;
  roles: string[];
}

declare module "fastify" {
  interface FastifyRequest {
    user: UserInfo;
    userRecord: UserRecord;
  }
}

const TRUST_MODE_EMAIL = process.env.DEV_USER_EMAIL ?? "dev@local";
const TRUST_MODE_NAME = process.env.DEV_USER_NAME ?? "Local Dev";

function attach(req: FastifyRequest, record: UserRecord) {
  req.userRecord = record;
  req.user = {
    id: record.user_id,
    email: record.email,
    display_name: record.display_name,
    ims_user_id: record.ims_user_id,
    roles: ["user"],
  };
}

export function createAuthHook(mode: AuthMode) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (mode === "trust") {
      const record = upsertUserByIms({
        email: TRUST_MODE_EMAIL,
        display_name: TRUST_MODE_NAME,
      });
      attach(req, record);
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return reply.code(401).send({ error: "Missing or invalid Authorization header" });
    }
    const token = authHeader.slice("Bearer ".length).trim();
    if (!token) {
      return reply.code(401).send({ error: "Empty Bearer token" });
    }

    try {
      const claims = await verifyImsToken(token);
      const email = typeof claims.email === "string" ? claims.email : null;
      const imsUserId = typeof claims.user_id === "string" ? claims.user_id : (typeof claims.sub === "string" ? claims.sub : null);
      if (!imsUserId || !email) {
        return reply.code(401).send({ error: "IMS token missing user_id or email claim" });
      }
      const record = upsertUserByIms({
        ims_user_id: imsUserId,
        email,
        display_name: typeof claims.name === "string" ? claims.name : null,
      });
      attach(req, record);
    } catch (err) {
      req.log.warn({ err }, "IMS token verification failed");
      return reply.code(401).send({ error: "Invalid or expired IMS token" });
    }
  };
}
