import type { FastifyInstance } from "fastify";
import db from "../db/connection.js";
import type { Tunnel } from "@council/shared";
import { broadcast } from "../ws/index.js";

interface TunnelRow {
  tunnel_id: string;
  pod_id: string;
  dev_name: string;
  branch: string;
  url: string;
  status: string;
  last_activity: string;
}

function rowToTunnel(row: TunnelRow): Tunnel {
  return {
    tunnel_id: row.tunnel_id,
    pod_id: row.pod_id,
    dev_name: row.dev_name,
    branch: row.branch,
    url: row.url,
    status: row.status as Tunnel["status"],
    last_activity: row.last_activity,
  };
}

export default async function tunnelRoutes(app: FastifyInstance) {
  app.get<{ Params: { podId: string } }>("/api/pods/:podId/tunnels", async (req) => {
    const rows = db.prepare("SELECT * FROM tunnels WHERE pod_id = ?").all(req.params.podId) as TunnelRow[];
    return rows.map(rowToTunnel);
  });

  app.post<{
    Params: { podId: string };
    Body: { dev_name: string; branch: string; port: number };
  }>("/api/pods/:podId/tunnels", async (req, reply) => {
    const { podId } = req.params;
    const { dev_name, branch, port } = req.body;
    const tunnel_id = `tunnel-${dev_name}-${Date.now()}`;
    const url = `http://localhost:${port}`;
    const now = new Date().toISOString();

    db.prepare(
      "INSERT INTO tunnels (tunnel_id, pod_id, dev_name, branch, url, status, last_activity) VALUES (?, ?, ?, ?, ?, 'active', ?)"
    ).run(tunnel_id, podId, dev_name, branch, url, now);

    // Update org summary tunnel count
    db.prepare(
      "UPDATE org_pod_summaries SET active_tunnels = (SELECT COUNT(*) FROM tunnels WHERE pod_id = ? AND status = 'active') WHERE pod_id = ?"
    ).run(podId, podId);

    const row = db.prepare("SELECT * FROM tunnels WHERE tunnel_id = ?").get(tunnel_id) as TunnelRow;
    const tunnel = rowToTunnel(row);

    broadcast({ type: "tunnel_status_changed", podId, payload: tunnel });
    reply.code(201);
    return tunnel;
  });

  app.put<{
    Params: { podId: string; tunnelId: string };
  }>("/api/pods/:podId/tunnels/:tunnelId/heartbeat", async (req, reply) => {
    const { podId, tunnelId } = req.params;
    const now = new Date().toISOString();

    const result = db.prepare(
      "UPDATE tunnels SET last_activity = ?, status = 'active' WHERE tunnel_id = ? AND pod_id = ?"
    ).run(now, tunnelId, podId);

    if (result.changes === 0) {
      reply.code(404);
      return { error: "Tunnel not found" };
    }

    return { ok: true };
  });

  app.put<{
    Params: { podId: string; tunnelId: string };
  }>("/api/pods/:podId/tunnels/:tunnelId/disconnect", async (req, reply) => {
    const { podId, tunnelId } = req.params;

    const result = db.prepare(
      "UPDATE tunnels SET status = 'disconnected' WHERE tunnel_id = ? AND pod_id = ?"
    ).run(tunnelId, podId);

    if (result.changes === 0) {
      reply.code(404);
      return { error: "Tunnel not found" };
    }

    // Update org summary tunnel count
    db.prepare(
      "UPDATE org_pod_summaries SET active_tunnels = (SELECT COUNT(*) FROM tunnels WHERE pod_id = ? AND status = 'active') WHERE pod_id = ?"
    ).run(podId, podId);

    const row = db.prepare("SELECT * FROM tunnels WHERE tunnel_id = ?").get(tunnelId) as TunnelRow;
    const tunnel = rowToTunnel(row);

    broadcast({ type: "tunnel_status_changed", podId, payload: tunnel });
    return tunnel;
  });
}
