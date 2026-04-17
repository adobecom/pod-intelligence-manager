import type { FastifyInstance } from "fastify";
import db from "../db/connection.js";
import type { ContextUpdate, ContextUpdateSource, Artifact, InputRequest } from "@pim/shared";
import { ingestContextUpdate } from "../services/ingestion.js";

interface ContextUpdateRow {
  id: string;
  agent_id: string;
  timestamp: string;
  pod_id: string;
  type: string;
  scope: string;
  summary: string;
  details: string;
  artifacts_json: string;
  status: string;
  quality_score: number;
  quality_rationale?: string | null;
  blocks_json: string;
  blocked_by_json: string;
  needs_input_from_json: string;
  source: string;
}

function rowToContextUpdate(row: ContextUpdateRow): ContextUpdate {
  return {
    id: row.id,
    agent_id: row.agent_id,
    timestamp: row.timestamp,
    pod_id: row.pod_id,
    type: row.type as ContextUpdate["type"],
    scope: row.scope as ContextUpdate["scope"],
    summary: row.summary,
    details: row.details,
    artifacts: JSON.parse(row.artifacts_json) as Artifact[],
    status: row.status as ContextUpdate["status"],
    quality_score: row.quality_score ?? 0,
    quality_rationale: row.quality_rationale ?? null,
    blocks: JSON.parse(row.blocks_json) as string[],
    blocked_by: JSON.parse(row.blocked_by_json) as string[],
    needs_input_from: JSON.parse(row.needs_input_from_json) as InputRequest[],
    source: (row.source ?? "manual") as ContextUpdateSource,
  };
}

export default async function contextUpdateRoutes(app: FastifyInstance) {
  app.get<{ Params: { podId: string } }>("/api/pods/:podId/context-updates", async (req) => {
    const rows = db.prepare("SELECT * FROM context_updates WHERE pod_id = ? ORDER BY timestamp DESC").all(req.params.podId) as ContextUpdateRow[];
    return rows.map(rowToContextUpdate);
  });

  app.get<{ Params: { podId: string } }>("/api/pods/:podId/quality-stats", async (req) => {
    const rows = db.prepare(`
      SELECT agent_id,
             COUNT(*) as update_count,
             AVG(quality_score) as avg_quality,
             MIN(quality_score) as min_quality,
             MAX(quality_score) as max_quality
      FROM context_updates
      WHERE pod_id = ?
      GROUP BY agent_id
      ORDER BY avg_quality DESC
    `).all(req.params.podId);
    return rows;
  });

  app.post<{ Params: { podId: string }; Body: unknown }>("/api/pods/:podId/context-updates", {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    // Gate: reject ingestion when pod is in critical conflict state (pressure >= 0.8)
    const pod = db.prepare("SELECT conflict_pressure FROM pods WHERE pod_id = ?").get(req.params.podId) as { conflict_pressure: number } | undefined;
    if (pod && pod.conflict_pressure >= 0.8) {
      reply.code(423);
      return {
        error: "Pod is in critical conflict state — ingestion paused. Resolve blocking conflicts first.",
        conflict_pressure: pod.conflict_pressure,
      };
    }

    const result = await ingestContextUpdate(req.params.podId, req.body);
    if (!result.success) {
      reply.code(result.secretFindings ? 422 : 400);
      return { error: result.error, secretFindings: result.secretFindings };
    }
    if (result.deduplicated) {
      reply.code(200);
      return { deduplicated: true, message: "Commit already reported by another source" };
    }
    reply.code(201);
    return { id: result.update!.id, update: result.update, pim: result.pim };
  });
}
