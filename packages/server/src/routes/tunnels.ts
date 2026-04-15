import type { FastifyInstance } from "fastify";
import { z } from "zod";
import db from "../db/connection.js";
import type { Tunnel } from "@council/shared";
import { broadcast } from "../ws/index.js";
import { validateBody } from "../middleware/validation.js";
import { ingestContextUpdate } from "../services/ingestion.js";

const CreateTunnelSchema = z.object({
  dev_name: z.string().min(1, "dev_name is required"),
  branch: z.string().min(1, "branch is required"),
  port: z.number().int().min(1).max(65535),
});

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
    Body: z.infer<typeof CreateTunnelSchema>;
  }>("/api/pods/:podId/tunnels", { preHandler: validateBody(CreateTunnelSchema) }, async (req, reply) => {
    const { podId } = req.params;
    const { dev_name, branch, port } = req.body;
    const tunnel_id = `tunnel-${dev_name}-${Date.now()}`;
    const serverBase = process.env.TUNNEL_BASE_URL ?? `http://localhost:${process.env.PORT ?? "4000"}`;
    const url = `${serverBase}/tunnel/${tunnel_id}`;
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

    // Log tunnel activation as a context update (fire-and-forget)
    ingestContextUpdate(podId, {
      agent_id: `tunnel:${dev_name}`,
      type: "progress",
      scope: "infra",
      summary: `Tunnel active: ${dev_name} on branch ${branch}`,
      details: `Dev tunnel registered at ${url}. Local port ${port}.`,
      status: "in_progress",
    }).catch(() => {});

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

    // Log tunnel disconnection as a context update (fire-and-forget)
    ingestContextUpdate(podId, {
      agent_id: `tunnel:${tunnel.dev_name}`,
      type: "progress",
      scope: "infra",
      summary: `Tunnel disconnected: ${tunnel.dev_name}`,
      details: `Dev tunnel ${tunnelId} disconnected.`,
      status: "completed",
    }).catch(() => {});

    return tunnel;
  });
}
