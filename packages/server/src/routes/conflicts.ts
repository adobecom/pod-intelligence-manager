import type { FastifyInstance } from "fastify";
import { z } from "zod";
import db from "../db/connection.js";
import type { Conflict, ConflictSide } from "@pim/shared";
import { broadcast } from "../ws/index.js";
import { recalculatePressure } from "../services/pressure.js";
import { notifyConflictResolved } from "../services/slack.js";
import { validateBody } from "../middleware/validation.js";
import { drainQueue } from "../services/ingestion-queue.js";
import { addResolvedConflictToGraph } from "../services/knowledge-graph.js";

const ResolveConflictSchema = z.object({
  resolution: z.string().min(1, "resolution is required"),
  resolved_by: z.string().min(1, "resolved_by is required"),
});

interface ConflictRow {
  id: string;
  pod_id: string;
  created_at: string;
  status: string;
  severity: string;
  summary: string;
  sides_json: string;
  master_analysis: string;
  impact_json: string;
  resolved_by: string | null;
  resolution: string | null;
  resolution_date: string | null;
  escalation_level: number | null;
}

function rowToConflict(row: ConflictRow): Conflict {
  return {
    id: row.id,
    pod_id: row.pod_id,
    created_at: row.created_at,
    status: row.status as Conflict["status"],
    severity: row.severity as Conflict["severity"],
    summary: row.summary,
    sides: JSON.parse(row.sides_json) as ConflictSide[],
    master_analysis: row.master_analysis,
    impact: JSON.parse(row.impact_json) as string[],
    resolved_by: row.resolved_by,
    resolution: row.resolution,
    resolution_date: row.resolution_date,
    escalation_level: row.escalation_level ?? 0,
  };
}

export default async function conflictRoutes(app: FastifyInstance) {
  app.get<{ Params: { podId: string } }>("/api/pods/:podId/conflicts", async (req, reply) => {
    const pod = db.prepare("SELECT pod_id FROM pods WHERE pod_id = ? AND org_id = ?").get(req.params.podId, req.org!.org_id);
    if (!pod) {
      reply.code(404);
      return [];
    }
    const rows = db.prepare("SELECT * FROM conflicts WHERE pod_id = ? AND org_id = ? ORDER BY created_at DESC").all(req.params.podId, req.org!.org_id) as ConflictRow[];
    return rows.map(rowToConflict);
  });

  app.get<{ Params: { podId: string; conflictId: string } }>("/api/pods/:podId/conflicts/:conflictId", async (req, reply) => {
    const row = db.prepare("SELECT * FROM conflicts WHERE pod_id = ? AND id = ? AND org_id = ?").get(req.params.podId, req.params.conflictId, req.org!.org_id) as ConflictRow | undefined;
    if (!row) {
      reply.code(404);
      return null;
    }
    return rowToConflict(row);
  });

  app.post<{
    Params: { podId: string; conflictId: string };
    Body: z.infer<typeof ResolveConflictSchema>;
  }>("/api/pods/:podId/conflicts/:conflictId/resolve", { preHandler: validateBody(ResolveConflictSchema) }, async (req, reply) => {
    const { podId, conflictId } = req.params;
    const { resolution, resolved_by } = req.body;
    const now = new Date().toISOString();

    const result = db.prepare(
      "UPDATE conflicts SET status = 'resolved', resolution = ?, resolved_by = ?, resolution_date = ? WHERE pod_id = ? AND id = ? AND org_id = ?"
    ).run(resolution, resolved_by, now, podId, conflictId, req.org!.org_id);

    if (result.changes === 0) {
      reply.code(404);
      return null;
    }

    const row = db.prepare("SELECT * FROM conflicts WHERE pod_id = ? AND id = ?").get(podId, conflictId) as ConflictRow;
    const resolved = rowToConflict(row);

    // Recalculate pressure and broadcast
    const newPressure = recalculatePressure(podId);
    broadcast({ type: "conflict_resolved", podId, payload: resolved });
    broadcast({ type: "pressure_changed", podId, payload: { pressure: newPressure } });

    // If pressure dropped below critical, replay queued context updates
    if (newPressure < 0.8) {
      drainQueue(podId).catch((err) => {
        console.error(`[ingestion-queue] drain failed for pod ${podId}:`, err);
      });
    }

    // Slack notification
    notifyConflictResolved(resolved);

    // Incremental knowledge extraction: emit a resolved_conflict node immediately
    // so concurrent pods can learn from this resolution without waiting for archival.
    try {
      const podRow = db.prepare(
        `SELECT p.name AS pod_name, p.project_id, pr.name AS project_name
         FROM pods p LEFT JOIN projects pr ON pr.project_id = p.project_id
         WHERE p.pod_id = ?`,
      ).get(podId) as { pod_name: string; project_id: string | null; project_name: string | null } | undefined;

      // Pull scope from one of the referenced context updates (conflict itself has no scope column).
      const firstUpdateId = resolved.sides[0]?.context_update_id;
      const scopeRow = firstUpdateId
        ? db.prepare("SELECT scope FROM context_updates WHERE id = ?").get(firstUpdateId) as { scope: string } | undefined
        : undefined;

      if (podRow) {
        const project = podRow.project_id && podRow.project_name
          ? { project_id: podRow.project_id, project_name: podRow.project_name }
          : null;
        const details = `Conflict: ${resolved.summary}\n\nResolution: ${resolution}\n\nAnalysis: ${resolved.master_analysis}`;
        addResolvedConflictToGraph(
          podId,
          podRow.pod_name,
          resolved.summary,
          details,
          scopeRow?.scope ?? "",
          project,
        );
      }
    } catch (err) {
      console.warn(`[conflicts] incremental knowledge extraction failed for conflict ${conflictId}:`, err);
    }

    return resolved;
  });
}
