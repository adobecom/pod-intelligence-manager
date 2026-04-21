import type { FastifyInstance } from "fastify";
import type { TunnelMessage } from "@pim/shared";
import db from "../db/connection.js";
import { verifyImsToken } from "../middleware/ims-verify.js";
import { upsertUserByIms } from "../services/users.js";
import { getMembership } from "../services/orgs.js";
import {
  registerTunnelConnection,
  unregisterTunnelConnection,
  resolvePendingRequest,
  handleResponseChunk,
  rejectPendingRequest,
} from "../ws/tunnel-connections.js";

const TRUST_MODE_EMAIL = process.env.DEV_USER_EMAIL ?? "dev@local";
const TRUST_MODE_NAME = process.env.DEV_USER_NAME ?? "Local Dev";

export default async function wsTunnelRoutes(app: FastifyInstance) {
  app.get("/ws/tunnel", { websocket: true }, async (socket, req) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const tunnelId = url.searchParams.get("tunnelId");
    const tokenParam = url.searchParams.get("token");
    const authMode = (process.env.AUTH_MODE ?? "ims") as "trust" | "ims";

    if (!tunnelId) {
      socket.close(4000, "Missing tunnelId query parameter");
      return;
    }

    // Validate tunnel exists and is active
    const row = db
      .prepare("SELECT pod_id, org_id, status FROM tunnels WHERE tunnel_id = ?")
      .get(tunnelId) as { pod_id: string; org_id: string | null; status: string } | undefined;

    if (!row) {
      socket.close(4001, "Tunnel not found");
      return;
    }

    if (row.status === "disconnected") {
      socket.close(4002, "Tunnel is disconnected");
      return;
    }

    // Authenticate the CLI connection and verify the user belongs to the tunnel's org.
    if (authMode === "ims") {
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
        const userRecord = upsertUserByIms({ ims_user_id: imsUserId, email,
          display_name: typeof claims.name === "string" ? claims.name : null });
        if (row.org_id && !getMembership(row.org_id, userRecord.user_id)) {
          socket.close(1008, "Not a member of this tunnel's org");
          return;
        }
      } catch (err) {
        req.log.warn({ err }, "Tunnel WS IMS token verification failed");
        socket.close(1008, "Invalid IMS token");
        return;
      }
    } else {
      upsertUserByIms({ email: TRUST_MODE_EMAIL, display_name: TRUST_MODE_NAME });
    }

    const podId = row.pod_id;

    // We don't know the local port from the WS handshake — it's stored in the DB
    // but we don't need it server-side; the CLI forwards locally
    registerTunnelConnection(tunnelId, podId, 0, socket);
    app.log.info({ tunnelId, podId }, "Tunnel CLI connected via WebSocket");

    socket.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as TunnelMessage;

        switch (msg.type) {
          case "tunnel_response":
            resolvePendingRequest(tunnelId, msg);
            break;

          case "tunnel_response_chunk":
            handleResponseChunk(tunnelId, msg);
            break;

          case "tunnel_heartbeat":
            socket.send(JSON.stringify({ type: "tunnel_heartbeat_ack" }));
            // Update DB last_activity
            db.prepare(
              "UPDATE tunnels SET last_activity = ?, status = 'active' WHERE tunnel_id = ?",
            ).run(new Date().toISOString(), tunnelId);
            break;

          case "tunnel_error": {
            app.log.warn({ tunnelId, msg }, "Tunnel error from CLI");
            if (msg.requestId) {
              rejectPendingRequest(tunnelId, msg.requestId, msg.error);
            }
            break;
          }

          default:
            break;
        }
      } catch (err) {
        app.log.error({ err, tunnelId }, "Failed to parse tunnel WS message");
      }
    });

    socket.on("close", () => {
      unregisterTunnelConnection(tunnelId);
      app.log.info({ tunnelId }, "Tunnel CLI disconnected");
    });

    socket.on("error", (err) => {
      app.log.error({ err, tunnelId }, "Tunnel WebSocket error");
      unregisterTunnelConnection(tunnelId);
    });
  });
}
