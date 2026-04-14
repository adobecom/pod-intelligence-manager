import type { FastifyInstance } from "fastify";
import db from "../db/connection.js";
import type { Pod, PodArea, Milestone } from "@council/shared";
import { regenerateLivingDoc } from "../council/agents/summary.js";
import { runLintPass } from "../council/agents/lint.js";

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

const SCOPES = ["frontend", "backend", "design", "qa", "infra", "pm"] as const;

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
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

  app.post<{
    Body: { name: string; sprint_days?: number; milestone_name?: string };
  }>("/api/pods", async (req, reply) => {
    const { name, sprint_days = 5, milestone_name = "Sprint Goal" } = req.body;
    if (!name || typeof name !== "string" || !name.trim()) {
      reply.code(400);
      return { error: "name is required" };
    }

    const podId = `pod-${slugify(name)}`;

    // Check for duplicates
    const existing = db.prepare("SELECT pod_id FROM pods WHERE pod_id = ?").get(podId);
    if (existing) {
      reply.code(409);
      return { error: `Pod "${name}" already exists` };
    }

    const now = new Date();
    const sprintEnd = new Date(now);
    sprintEnd.setDate(sprintEnd.getDate() + sprint_days);

    const milestone: Milestone = {
      name: milestone_name,
      target_date: sprintEnd.toISOString().split("T")[0],
      percent_complete: 0,
    };

    db.prepare(
      `INSERT INTO pods (pod_id, name, sprint_start, sprint_end, day_number, total_days, conflict_pressure, milestone_json)
       VALUES (?, ?, ?, ?, 1, ?, 0.0, ?)`,
    ).run(
      podId,
      name.trim(),
      now.toISOString().split("T")[0],
      sprintEnd.toISOString().split("T")[0],
      sprint_days,
      JSON.stringify(milestone),
    );

    // Create default areas
    const insertArea = db.prepare(
      "INSERT INTO pod_areas (pod_id, scope, owner, status) VALUES (?, ?, 'unassigned', 'waiting')",
    );
    for (const scope of SCOPES) {
      insertArea.run(podId, scope);
    }

    // Create org summary entry
    db.prepare(
      `INSERT INTO org_pod_summaries (pod_id, name, day_number, total_days, conflict_pressure, open_conflicts, active_tunnels, agent_count)
       VALUES (?, ?, 1, ?, 0.0, 0, 0, 0)`,
    ).run(podId, name.trim(), sprint_days);

    // Generate initial living doc
    regenerateLivingDoc(podId);

    // Return the created pod
    const areas = db.prepare("SELECT scope, owner, status, last_activity FROM pod_areas WHERE pod_id = ?").all(podId) as AreaRow[];
    const row = db.prepare("SELECT * FROM pods WHERE pod_id = ?").get(podId) as PodRow;
    reply.code(201);
    return rowToPod(row, areas);
  });

  // Lint pass routes
  app.get<{ Params: { podId: string } }>("/api/pods/:podId/lint-findings", async (req) => {
    return db.prepare("SELECT * FROM lint_findings WHERE pod_id = ? ORDER BY severity DESC, timestamp DESC").all(req.params.podId);
  });

  app.post<{ Params: { podId: string } }>("/api/pods/:podId/lint", async (req) => {
    const findings = runLintPass(req.params.podId);
    return { findings };
  });
}
