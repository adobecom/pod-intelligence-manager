import type { FastifyInstance } from "fastify";
import db from "../db/connection.js";
import type { ContextUpdate, ContextUpdateSource, Artifact, InputRequest } from "@pim/shared";
import { ingestContextUpdate, preValidateAndScan } from "../services/ingestion.js";
import { enqueueUpdate, getQueueSize, QUEUE_BACKLOG_THRESHOLD, notifiedBacklogPods } from "../services/ingestion-queue.js";
import { notifyQueueBacklog } from "../services/slack.js";
import { broadcast } from "../ws/index.js";
import { regenerateLivingDoc } from "../pim/agents/summary.js";
import { getOrgTuning } from "../services/org-settings.js";

interface ContextUpdateRow {
  id: string;
  agent_id: string;
  timestamp: string;
  pod_id: string;
  type: string;
  scope: string;
  summary: string;
  details: string;
  retrieval_text?: string | null;
  entity_refs_json?: string | null;
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
    retrieval_text: row.retrieval_text ?? undefined,
    entity_refs: JSON.parse(row.entity_refs_json ?? "[]") as ContextUpdate["entity_refs"],
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
  app.get<{ Params: { podId: string }; Querystring: { include_retracted?: string } }>("/api/pods/:podId/context-updates", async (req, reply) => {
    const pod = db.prepare("SELECT pod_id FROM pods WHERE pod_id = ? AND org_id = ?").get(req.params.podId, req.org!.org_id);
    if (!pod) {
      reply.code(404);
      return [];
    }
    const includeRetracted = req.query.include_retracted === "true";
    const sql = includeRetracted
      ? "SELECT * FROM context_updates WHERE pod_id = ? AND org_id = ? ORDER BY timestamp DESC"
      : "SELECT * FROM context_updates WHERE pod_id = ? AND org_id = ? AND retracted_at IS NULL ORDER BY timestamp DESC";
    const rows = db.prepare(sql).all(req.params.podId, req.org!.org_id) as unknown as ContextUpdateRow[];
    return rows.map(rowToContextUpdate);
  });

  app.get<{ Params: { podId: string } }>("/api/pods/:podId/quality-stats", async (req, reply) => {
    const pod = db.prepare("SELECT pod_id FROM pods WHERE pod_id = ? AND org_id = ?").get(req.params.podId, req.org!.org_id);
    if (!pod) {
      reply.code(404);
      return [];
    }
    const rows = db.prepare(`
      SELECT agent_id,
             COUNT(*) as update_count,
             AVG(quality_score) as avg_quality,
             MIN(quality_score) as min_quality,
             MAX(quality_score) as max_quality
      FROM context_updates
      WHERE pod_id = ? AND org_id = ?
      GROUP BY agent_id
      ORDER BY avg_quality DESC
    `).all(req.params.podId, req.org!.org_id);
    return rows;
  });

  app.post<{ Params: { podId: string }; Body: unknown }>("/api/pods/:podId/context-updates", {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const pod = db.prepare("SELECT conflict_pressure FROM pods WHERE pod_id = ? AND org_id = ?").get(req.params.podId, req.org!.org_id) as { conflict_pressure: number } | undefined;
    if (!pod) {
      reply.code(404);
      return { error: "Pod not found" };
    }

    // When pressure is critical, intake is still accepted but processing is queued
    const orgTuning = getOrgTuning(req.org!.org_id);
    if (pod.conflict_pressure >= orgTuning.pressure.degradedMax) {
      const check = preValidateAndScan(req.body);
      if (!check.success) {
        reply.code(check.secretFindings ? 422 : 400);
        return { error: check.error, secretFindings: check.secretFindings };
      }
      const queueId = enqueueUpdate(req.params.podId, req.org!.org_id, req.body);
      const queueSize = getQueueSize(req.params.podId);
      if (queueSize >= QUEUE_BACKLOG_THRESHOLD && !notifiedBacklogPods.has(req.params.podId)) {
        notifiedBacklogPods.add(req.params.podId);
        notifyQueueBacklog(req.params.podId, queueSize);
      }
      reply.code(202);
      return {
        queued: true,
        queue_id: queueId,
        queue_size: queueSize,
        conflict_pressure: pod.conflict_pressure,
        message: "Pod is in critical conflict state — context queued for processing once conflicts are resolved.",
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
    return {
      id: result.update!.id,
      update: result.update,
      pim: result.pim,
      ...(result.pim_queued ? { pim_queued: true } : {}),
    };
  });

  app.get<{ Params: { podId: string } }>("/api/pods/:podId/ingestion-queue", async (req, reply) => {
    const pod = db.prepare("SELECT pod_id FROM pods WHERE pod_id = ? AND org_id = ?").get(
      req.params.podId,
      req.org!.org_id,
    );
    if (!pod) {
      reply.code(404);
      return { error: "Pod not found" };
    }
    return { queue_size: getQueueSize(req.params.podId) };
  });

  app.delete<{ Params: { podId: string; updateId: string } }>("/api/pods/:podId/context-updates/:updateId", async (req, reply) => {
    const { podId, updateId } = req.params;

    const row = db.prepare(
      "SELECT id FROM context_updates WHERE id = ? AND pod_id = ? AND org_id = ? AND retracted_at IS NULL",
    ).get(updateId, podId, req.org!.org_id) as { id: string } | undefined;

    if (!row) {
      reply.code(404);
      return { error: "Update not found or already retracted" };
    }

    const now = new Date().toISOString();
    db.prepare("UPDATE context_updates SET retracted_at = ? WHERE id = ?").run(now, updateId);

    // Auto-dismiss unresolved conflicts sourced from this update
    const openConflicts = db.prepare(
      "SELECT id, sides_json FROM conflicts WHERE pod_id = ? AND status != 'resolved' AND status != 'dismissed'",
    ).all(podId) as { id: string; sides_json: string }[];

    for (const conflict of openConflicts) {
      const sides = JSON.parse(conflict.sides_json) as { context_update_id: string }[];
      if (sides.some((s) => s.context_update_id === updateId)) {
        db.prepare(
          "UPDATE conflicts SET status = 'dismissed', resolution = 'Source update retracted', resolution_date = ? WHERE id = ?",
        ).run(now, conflict.id);
      }
    }

    // Regenerate living doc in the background — same fire-and-forget pattern as master.ts
    regenerateLivingDoc(podId).catch((err) =>
      console.error("[context-updates] Living doc regen after retraction failed:", err),
    );

    broadcast({ type: "update_retracted", podId, payload: { updateId, retracted_at: now } });

    return { ok: true };
  });
}
