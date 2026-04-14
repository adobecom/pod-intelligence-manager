import type { FastifyInstance } from "fastify";
import db from "../db/connection.js";

interface LivingDocRow {
  pod_id: string;
  markdown: string;
}

export default async function livingDocRoutes(app: FastifyInstance) {
  app.get<{ Params: { podId: string } }>("/api/pods/:podId/living-doc", async (req, reply) => {
    const row = db.prepare("SELECT markdown FROM living_docs WHERE pod_id = ?").get(req.params.podId) as LivingDocRow | undefined;
    if (!row) {
      return "# No living doc available for this pod.";
    }
    return row.markdown;
  });
}
