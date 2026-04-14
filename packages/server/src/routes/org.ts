import type { FastifyInstance } from "fastify";
import db from "../db/connection.js";
import type { OrgPodSummary, CrossPodOverlap, ArchivedPod } from "@council/shared";

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
}
