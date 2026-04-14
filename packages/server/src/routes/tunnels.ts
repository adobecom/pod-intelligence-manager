import type { FastifyInstance } from "fastify";
import db from "../db/connection.js";
import type { Tunnel } from "@council/shared";

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
}
