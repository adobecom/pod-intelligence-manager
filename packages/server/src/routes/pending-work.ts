import type { FastifyInstance } from "fastify";
import db from "../db/connection.js";
import type { PendingWork } from "@pim/shared";
import { rejectServiceToken } from "../middleware/service-authz.js";

export default async function pendingWorkRoutes(app: FastifyInstance) {
  app.addHook("preHandler", async (req, reply) => {
    if (!rejectServiceToken(req, reply)) return;
  });

  app.get<{ Params: { conflictId: string } }>("/api/conflicts/:conflictId/pending-work", async (req, reply) => {
    // Verify the conflict belongs to the requesting user's org
    const conflict = db.prepare("SELECT id FROM conflicts WHERE id = ? AND org_id = ?").get(req.params.conflictId, req.org!.org_id);
    if (!conflict) {
      reply.code(404);
      return [];
    }
    return db.prepare("SELECT context_update_id, agent_id, summary, presumes, rework_cost FROM pending_work WHERE conflict_id = ?").all(req.params.conflictId) as unknown as PendingWork[];
  });
}
