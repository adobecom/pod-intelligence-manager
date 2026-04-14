import type { FastifyInstance } from "fastify";
import db from "../db/connection.js";
import type { PendingWork } from "@council/shared";

export default async function pendingWorkRoutes(app: FastifyInstance) {
  app.get<{ Params: { conflictId: string } }>("/api/conflicts/:conflictId/pending-work", async (req) => {
    return db.prepare("SELECT context_update_id, agent_id, summary, presumes, rework_cost FROM pending_work WHERE conflict_id = ?").all(req.params.conflictId) as PendingWork[];
  });
}
