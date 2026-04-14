import type { FastifyInstance } from "fastify";
import db from "../db/connection.js";
import type { Pod, PodArea, Milestone } from "@council/shared";

interface PodRow {
  pod_id: string;
  name: string;
  sprint_start: string;
  sprint_end: string;
  day_number: number;
  total_days: number;
  conflict_pressure: number;
  milestone_json: string;
}

interface AreaRow {
  scope: string;
  owner: string;
  status: string;
  last_activity: string | null;
}

function rowToPod(row: PodRow, areas: AreaRow[]): Pod {
  return {
    pod_id: row.pod_id,
    name: row.name,
    sprint_start: row.sprint_start,
    sprint_end: row.sprint_end,
    day_number: row.day_number,
    total_days: row.total_days,
    conflict_pressure: row.conflict_pressure,
    milestone: JSON.parse(row.milestone_json) as Milestone,
    areas: areas as PodArea[],
  };
}

export default async function podRoutes(app: FastifyInstance) {
  app.get<{ Params: { podId: string } }>("/api/pods/:podId", async (req, reply) => {
    const row = db.prepare("SELECT * FROM pods WHERE pod_id = ?").get(req.params.podId) as PodRow | undefined;
    if (!row) {
      reply.code(404);
      return null;
    }
    const areas = db.prepare("SELECT scope, owner, status, last_activity FROM pod_areas WHERE pod_id = ?").all(row.pod_id) as AreaRow[];
    return rowToPod(row, areas);
  });
}
