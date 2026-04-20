import type { FastifyInstance } from "fastify";
import { z } from "zod";
import db from "../db/connection.js";
import type { OrgPodSummary, CrossPodOverlap, ArchivedPod, ArchivedProject } from "@pim/shared";
import { parseProjectAnatomy } from "../services/project-anatomy-parse.js";
import { validateBody } from "../middleware/validation.js";
import { getOrgConfig, setOrgConfig } from "../services/org-settings.js";
import { extractKnowledgeEnhanced } from "../pim/agents/knowledge-extraction.js";
import { addLearningsToGraph } from "../services/knowledge-graph.js";
import { broadcastToAll } from "../ws/index.js";

interface PodRow {
  pod_id: string;
  name: string;
  sprint_start: string;
  day_number: number;
  conflict_pressure: number;
  project_id?: string | null;
}

const OrgConfigBodySchema = z.object({
  scopes: z.array(
    z.object({
      id: z.string().min(1),
      label: z.string().min(1),
    }),
  ),
});

export default async function orgRoutes(app: FastifyInstance) {
  app.get("/api/org/config", async () => {
    return getOrgConfig();
  });

  app.patch<{ Body: z.infer<typeof OrgConfigBodySchema> }>(
    "/api/org/config",
    {
      preHandler: validateBody(OrgConfigBodySchema),
    },
    async (req, reply) => {
      try {
        return setOrgConfig(req.body);
      } catch (e) {
        reply.code(400);
        return { error: e instanceof Error ? e.message : "Invalid org config" };
      }
    },
  );

  app.get("/api/org/pods", async () => {
    return db.prepare("SELECT * FROM org_pod_summaries").all() as OrgPodSummary[];
  });

  app.get("/api/org/overlaps", async () => {
    return db.prepare("SELECT * FROM cross_pod_overlaps").all() as CrossPodOverlap[];
  });

  app.get("/api/org/archived", async () => {
    return db.prepare("SELECT * FROM archived_pods").all() as ArchivedPod[];
  });

  app.get("/api/org/archived-projects", async () => {
    const rows = db
      .prepare(
        "SELECT project_id, name, description, created_at, anatomy_json, archived_date FROM archived_projects ORDER BY archived_date DESC",
      )
      .all() as Array<{
      project_id: string;
      name: string;
      description: string | null;
      created_at: string;
      anatomy_json: string;
      archived_date: string;
    }>;
    return rows.map(
      (r): ArchivedProject => ({
        project_id: r.project_id,
        name: r.name,
        description: r.description,
        created_at: r.created_at,
        archived_date: r.archived_date,
        anatomy: parseProjectAnatomy(r.anatomy_json),
      }),
    );
  });

  app.post<{ Params: { podId: string } }>("/api/pods/:podId/archive", async (req, reply) => {
    const { podId } = req.params;
    const pod = db.prepare("SELECT pod_id, name, sprint_start, day_number, conflict_pressure, project_id FROM pods WHERE pod_id = ?").get(podId) as PodRow | undefined;
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

    // Extract knowledge and add to the persistent graph
    let learningsExtracted = 0;
    try {
      const learnings = await extractKnowledgeEnhanced(podId);
      if (learnings.length > 0) {
        let projectMeta: { project_id: string; project_name: string } | undefined;
        if (pod.project_id) {
          const pr = db.prepare("SELECT name FROM projects WHERE project_id = ?").get(pod.project_id) as
            | { name: string }
            | undefined;
          if (pr) projectMeta = { project_id: pod.project_id, project_name: pr.name };
        }
        const result = await addLearningsToGraph(learnings, podId, pod.name, projectMeta);
        learningsExtracted = result.nodesAdded;
        broadcastToAll({ type: "knowledge_updated", podId, payload: { learnings_extracted: learningsExtracted } });
      }
    } catch (err) {
      app.log.error(err, "Knowledge extraction failed during archival (non-blocking)");
    }

    return { ...archived, learnings_extracted: learningsExtracted };
  });
}
