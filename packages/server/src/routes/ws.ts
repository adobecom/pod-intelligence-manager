import type { FastifyInstance } from "fastify";
import { addClient } from "../ws/index.js";
import { verifyImsToken } from "../middleware/ims-verify.js";
import { upsertUserByIms } from "../services/users.js";
import { findOrgBySlug, getMembership, listOrgsForUser } from "../services/orgs.js";

const TRUST_MODE_EMAIL = process.env.DEV_USER_EMAIL ?? "dev@local";
const TRUST_MODE_NAME = process.env.DEV_USER_NAME ?? "Local Dev";

export default async function wsRoutes(app: FastifyInstance) {
  const authMode = (process.env.AUTH_MODE ?? "ims") as "trust" | "ims";

  app.get("/ws", { websocket: true }, async (socket, req) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const podId = url.searchParams.get("podId") ?? "global";
    const tokenParam = url.searchParams.get("token");
    const orgSlug = url.searchParams.get("org") ?? undefined;

    let userRecord;
    if (authMode === "trust") {
      userRecord = upsertUserByIms({ email: TRUST_MODE_EMAIL, display_name: TRUST_MODE_NAME });
    } else {
      if (!tokenParam) {
        socket.close(1008, "Missing auth token");
        return;
      }
      try {
        const claims = await verifyImsToken(tokenParam);
        const email = typeof claims.email === "string" ? claims.email : null;
        const imsUserId = typeof claims.user_id === "string"
          ? claims.user_id
          : (typeof claims.sub === "string" ? claims.sub : null);
        if (!imsUserId || !email) {
          socket.close(1008, "IMS token missing user_id/email");
          return;
        }
        userRecord = upsertUserByIms({
          ims_user_id: imsUserId,
          email,
          display_name: typeof claims.name === "string" ? claims.name : null,
        });
      } catch (err) {
        req.log.warn({ err }, "WS IMS token verification failed");
        socket.close(1008, "Invalid IMS token");
        return;
      }
    }

    if (orgSlug) {
      const org = findOrgBySlug(orgSlug);
      if (!org) {
        socket.close(1008, `Org "${orgSlug}" not found`);
        return;
      }
      if (!getMembership(org.org_id, userRecord.user_id)) {
        socket.close(1008, "Not a member of this org");
        return;
      }
    } else if (listOrgsForUser(userRecord.user_id).length === 0) {
      socket.close(1008, "User has no orgs");
      return;
    }

    addClient(podId, socket);
  });
}
