import type { FastifyInstance } from "fastify";
import db from "../db/connection.js";
import type { OrgPodSummary, CrossPodOverlap, ArchivedPod } from "@council/shared";

interface PodRow {
  pod_id: string;
  name: string;
  sprint_start: string;
  day_number: number;
  conflict_pressure: number;
}

export default async function orgRoutes(app: FastifyInstance) {
  app.get("/api/org/pods", async () => {
    return db.prepare("SELECT * FROM org_pod_summaries").all() as OrgPodSummary[];
  });

  app.get("/api/org/overlaps", async () => {
    return db.prepare("SELECT * FROM cross_pod_overlaps").all() as CrossPodOverlap[];
  });

  app.get("/api/org/archived", async () => {
    return db.prepare("SELECT * FROM archived_pods").all() as ArchivedPod[];
  });

  app.post<{ Params: { podId: string } }>("/api/pods/:podId/archive", async (req, reply) => {
    const { podId } = req.params;
    const pod = db.prepare("SELECT * FROM pods WHERE pod_id = ?").get(podId) as PodRow | undefined;
    if (!pod) {
      reply.code(404);
      return { error: "Pod not found" };
    }

    const now = new Date();
    const start = new Date(pod.sprint_start);
    const durationDays = Math.max(1, Math.ceil((now.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)));

    // Insert into archived_pods
    db.prepare(
      `INSERT OR REPLACE INTO archived_pods (pod_id, name, completed_date, duration_days, final_pressure)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(podId, pod.name, now.toISOString().split("T")[0], durationDays, pod.conflict_pressure);

    // Remove from org_pod_summaries
    db.prepare("DELETE FROM org_pod_summaries WHERE pod_id = ?").run(podId);

    const archived = db.prepare("SELECT * FROM archived_pods WHERE pod_id = ?").get(podId) as ArchivedPod;
    return archived;
  });
}
