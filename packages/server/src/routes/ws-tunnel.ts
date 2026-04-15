import type { FastifyInstance } from "fastify";
import type { TunnelMessage } from "@council/shared";
import db from "../db/connection.js";
import {
  registerTunnelConnection,
  unregisterTunnelConnection,
  resolvePendingRequest,
  handleResponseChunk,
  rejectPendingRequest,
} from "../ws/tunnel-connections.js";

export default async function wsTunnelRoutes(app: FastifyInstance) {
  app.get("/ws/tunnel", { websocket: true }, (socket, req) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const tunnelId = url.searchParams.get("tunnelId");

    if (!tunnelId) {
      socket.close(4000, "Missing tunnelId query parameter");
      return;
    }

    // Validate tunnel exists and is active
    const row = db
      .prepare("SELECT pod_id, status FROM tunnels WHERE tunnel_id = ?")
      .get(tunnelId) as { pod_id: string; status: string } | undefined;

    if (!row) {
      socket.close(4001, "Tunnel not found");
      return;
    }

    if (row.status === "disconnected") {
      socket.close(4002, "Tunnel is disconnected");
      return;
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
