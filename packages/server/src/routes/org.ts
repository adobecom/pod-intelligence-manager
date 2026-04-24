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
import { computeCurrentDay } from "../services/pod-day.js";

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
  app.get("/api/org/config", async (req) => {
    return getOrgConfig(req.org!.org_id);
  });

  app.patch<{ Body: z.infer<typeof OrgConfigBodySchema> }>(
    "/api/org/config",
    {
      preHandler: validateBody(OrgConfigBodySchema),
    },
    async (req, reply) => {
      try {
        return setOrgConfig(req.org!.org_id, req.body);
      } catch (e) {
        reply.code(400);
        return { error: e instanceof Error ? e.message : "Invalid org config" };
      }
    },
  );

  app.get("/api/org/pods", async (req) => {
    // Join against `pods` to pull sprint_start/total_days so day_number reflects real sprint
    // progress (the denormalized org_pod_summaries.day_number is not advanced over time).
    const rows = db.prepare(
      `SELECT s.*, p.sprint_start AS _sprint_start, p.total_days AS _total_days
       FROM org_pod_summaries s
       LEFT JOIN pods p ON p.pod_id = s.pod_id
       WHERE s.org_id = ?`,
    ).all(req.org!.org_id) as unknown as Array<OrgPodSummary & { _sprint_start: string | null; _total_days: number | null }>;
    return rows.map((r) => {
      const { _sprint_start, _total_days, ...summary } = r;
      const totalDays = _total_days ?? summary.total_days;
      return {
        ...summary,
        total_days: totalDays,
        day_number: _sprint_start ? computeCurrentDay(_sprint_start, totalDays) : summary.day_number,
      };
    });
  });

  app.get("/api/org/overlaps", async (req) => {
    return db.prepare("SELECT * FROM cross_pod_overlaps WHERE org_id = ?").all(req.org!.org_id) as unknown as CrossPodOverlap[];
  });

  app.get("/api/org/archived", async (req) => {
    return db.prepare("SELECT * FROM archived_pods WHERE org_id = ?").all(req.org!.org_id) as unknown as ArchivedPod[];
  });

  app.get("/api/org/archived-projects", async (req) => {
    const rows = db
      .prepare(
        "SELECT project_id, name, description, created_at, anatomy_json, archived_date FROM archived_projects WHERE org_id = ? ORDER BY archived_date DESC",
      )
      .all(req.org!.org_id) as Array<{
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
    const pod = db.prepare("SELECT pod_id, name, sprint_start, day_number, conflict_pressure, project_id FROM pods WHERE pod_id = ? AND org_id = ?").get(podId, req.org!.org_id) as PodRow | undefined;
    if (!pod) {
      reply.code(404);
      return { error: "Pod not found" };
    }

    const now = new Date();
    const start = new Date(pod.sprint_start);
    const durationDays = Math.max(1, Math.ceil((now.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)));

    // Insert into archived_pods
    db.prepare(
      `INSERT OR REPLACE INTO archived_pods (pod_id, name, completed_date, duration_days, final_pressure, org_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(podId, pod.name, now.toISOString().split("T")[0], durationDays, pod.conflict_pressure, req.org!.org_id);

    // Remove from org_pod_summaries
    db.prepare("DELETE FROM org_pod_summaries WHERE pod_id = ?").run(podId);

    const archived = db.prepare("SELECT * FROM archived_pods WHERE pod_id = ?").get(podId) as unknown as ArchivedPod;

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
