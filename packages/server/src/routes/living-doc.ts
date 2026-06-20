import type { FastifyInstance } from "fastify";
import { z } from "zod";
import db from "../db/connection.js";
import { broadcast } from "../ws/index.js";
import { validateBody } from "../middleware/validation.js";
import { rejectServiceToken, requirePodBinding, requireServiceScope } from "../middleware/service-authz.js";

const RecordViewSchema = z.object({
  viewer_id: z.string().min(1, "viewer_id is required"),
});

interface LivingDocRow {
  pod_id: string;
  markdown: string;
}

interface LivingDocMetaRow {
  last_regenerated_at: string | null;
  regen_count: number;
}

interface ViewRow {
  viewer_id: string;
  last_viewed_at: string;
  view_count: number;
  last_viewed_regen_count: number;
}

export default async function livingDocRoutes(app: FastifyInstance) {
  app.get<{ Params: { podId: string } }>("/api/pods/:podId/living-doc", async (req, reply) => {
    if (!requireServiceScope(req, reply, "project-context:read")) return;
    if (!requirePodBinding(req, reply, req.params.podId)) return;
    const pod = db.prepare("SELECT pod_id FROM pods WHERE pod_id = ? AND org_id = ?").get(req.params.podId, req.org!.org_id);
    if (!pod) {
      reply.code(404);
      return "# Pod not found.";
    }
    const row = db.prepare("SELECT markdown FROM living_docs WHERE pod_id = ?").get(req.params.podId) as LivingDocRow | undefined;
    if (!row) {
      return "# No living doc available for this pod.";
    }
    return row.markdown;
  });

  // Record a living doc view
  app.post<{ Params: { podId: string }; Body: z.infer<typeof RecordViewSchema> }>(
    "/api/pods/:podId/living-doc/views",
    { preHandler: validateBody(RecordViewSchema) },
    async (req, reply) => {
      if (!rejectServiceToken(req, reply)) return;
      const { podId } = req.params;
      const { viewer_id: viewerId } = req.body;

      const pod = db.prepare("SELECT pod_id FROM pods WHERE pod_id = ? AND org_id = ?").get(podId, req.org!.org_id);
      if (!pod) {
        reply.code(404);
        return { error: "Pod not found" };
      }

      const now = new Date().toISOString();

      // Atomic upsert: snapshot current regen_count via subquery to avoid race with regenerateLivingDoc
      db.prepare(`
        INSERT INTO living_doc_views (pod_id, viewer_id, last_viewed_at, view_count, last_viewed_regen_count)
        VALUES (?, ?, ?, 1, COALESCE((SELECT regen_count FROM living_docs WHERE pod_id = ?), 0))
        ON CONFLICT(pod_id, viewer_id) DO UPDATE SET
          last_viewed_at = excluded.last_viewed_at,
          view_count = living_doc_views.view_count + 1,
          last_viewed_regen_count = excluded.last_viewed_regen_count
      `).run(podId, viewerId, now, podId);

      broadcast({ type: "living_doc_viewed", podId, payload: { viewer_id: viewerId, viewed_at: now } });

      return { ok: true, viewer_id: viewerId, viewed_at: now };
    },
  );

  // Get living doc consumption stats
  app.get<{ Params: { podId: string } }>("/api/pods/:podId/living-doc/stats", async (req, reply) => {
    if (!rejectServiceToken(req, reply)) return;
    const { podId } = req.params;
    const pod = db.prepare("SELECT pod_id FROM pods WHERE pod_id = ? AND org_id = ?").get(podId, req.org!.org_id);
    if (!pod) {
      reply.code(404);
      return { error: "Pod not found" };
    }

    const doc = db.prepare(
      "SELECT last_regenerated_at, regen_count FROM living_docs WHERE pod_id = ?"
    ).get(podId) as LivingDocMetaRow | undefined;

    const viewers = db.prepare(
      "SELECT viewer_id, last_viewed_at, view_count, last_viewed_regen_count FROM living_doc_views WHERE pod_id = ?"
    ).all(podId) as unknown as ViewRow[];

    const regenCount = doc?.regen_count ?? 0;

    return {
      pod_id: podId,
      last_regenerated_at: doc?.last_regenerated_at ?? null,
      regen_count: regenCount,
      viewers: viewers.map(v => ({
        viewer_id: v.viewer_id,
        last_viewed_at: v.last_viewed_at,
        view_count: v.view_count,
        regens_since_last_view: regenCount - v.last_viewed_regen_count,
      })),
    };
  });
}
