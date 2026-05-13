import type { FastifyInstance } from "fastify";
import { z } from "zod";
import db from "../db/connection.js";
import type { Pod, PodArea, Milestone } from "@pim/shared";
import { regenerateLivingDoc } from "../pim/agents/summary.js";
import { runLintPass } from "../pim/agents/lint.js";
import { getRelevantLearnings } from "../services/knowledge-graph.js";
import { validateBody } from "../middleware/validation.js";
import { getOrgScopeIdsOrdered } from "../services/org-settings.js";
import { allocateUniqueResourceId } from "../utils/resource-ids.js";
import { computeCurrentDay } from "../services/pod-day.js";

const CreatePodSchema = z.object({
  name: z.string().min(1, "name is required").transform(s => s.trim()),
  sprint_days: z.number().int().min(1).max(30).default(5),
  milestone_name: z.string().min(1).default("Sprint Goal"),
  project_id: z.string().min(1).optional(),
});

const PatchMilestoneSchema = z
  .object({
    name: z.string().min(1).optional(),
    target_date: z.string().min(1).optional(),
    percent_complete: z.number().int().min(0).max(100).optional(),
  })
  .refine(
    (d) => d.name !== undefined || d.target_date !== undefined || d.percent_complete !== undefined,
    { message: "Provide at least one of name, target_date, percent_complete" },
  );

const PatchPodSchema = z.object({
  /** Set to a project id to link, or `null` to clear. */
  project_id: z.union([z.string().min(1), z.null()]),
});

interface PodRow {
  pod_id: string;
  name: string;
  sprint_start: string;
  sprint_end: string;
  day_number: number;
  total_days: number;
  conflict_pressure: number;
  milestone_json: string;
  project_id: string | null;
}

interface AreaRow {
  scope: string;
  owner: string;
  status: string;
  last_activity: string | null;
}

function rowToPod(row: PodRow, areas: AreaRow[]): Pod {
  return {
    pod_id: row.pod_id,
    project_id: row.project_id ?? undefined,
    name: row.name,
    sprint_start: row.sprint_start,
    sprint_end: row.sprint_end,
    // Auto-advanced from sprint_start so the value reflects real sprint progress.
    day_number: computeCurrentDay(row.sprint_start, row.total_days),
    total_days: row.total_days,
    conflict_pressure: row.conflict_pressure,
    milestone: JSON.parse(row.milestone_json) as Milestone,
    areas: areas as PodArea[],
  };
}

export default async function podRoutes(app: FastifyInstance) {
  app.get<{ Params: { podId: string } }>("/api/pods/:podId", async (req, reply) => {
    const row = db.prepare("SELECT * FROM pods WHERE pod_id = ? AND org_id = ?").get(req.params.podId, req.org!.org_id) as PodRow | undefined;
    if (!row) {
      reply.code(404);
      return null;
    }
    const areas = db.prepare("SELECT scope, owner, status, last_activity FROM pod_areas WHERE pod_id = ?").all(row.pod_id) as unknown as AreaRow[];
    return rowToPod(row, areas);
  });

  app.patch<{
    Params: { podId: string };
    Body: z.infer<typeof PatchPodSchema>;
  }>("/api/pods/:podId", { preHandler: validateBody(PatchPodSchema) }, async (req, reply) => {
    const { podId } = req.params;
    const { project_id } = req.body;

    const row = db.prepare("SELECT * FROM pods WHERE pod_id = ? AND org_id = ?").get(podId, req.org!.org_id) as PodRow | undefined;
    if (!row) {
      reply.code(404);
      return { error: `Pod not found: ${podId}` };
    }

    if (project_id !== null) {
      const proj = db.prepare("SELECT project_id FROM projects WHERE project_id = ? AND org_id = ?").get(project_id, req.org!.org_id);
      if (!proj) {
        reply.code(400);
        return { error: `Project not found: ${project_id}` };
      }
    }

    db.prepare("UPDATE pods SET project_id = ? WHERE pod_id = ? AND org_id = ?").run(project_id, podId, req.org!.org_id);

    const areas = db.prepare("SELECT scope, owner, status, last_activity FROM pod_areas WHERE pod_id = ?").all(podId) as unknown as AreaRow[];
    const updated = db.prepare("SELECT * FROM pods WHERE pod_id = ?").get(podId) as unknown as PodRow;
    return rowToPod(updated, areas);
  });

  app.patch<{
    Params: { podId: string };
    Body: z.infer<typeof PatchMilestoneSchema>;
  }>("/api/pods/:podId/milestone", { preHandler: validateBody(PatchMilestoneSchema) }, async (req, reply) => {
    const { podId } = req.params;
    const row = db.prepare("SELECT milestone_json FROM pods WHERE pod_id = ? AND org_id = ?").get(podId, req.org!.org_id) as { milestone_json: string } | undefined;
    if (!row) {
      reply.code(404);
      return { error: `Pod not found: ${podId}` };
    }
    const current = JSON.parse(row.milestone_json) as Milestone;
    const next: Milestone = {
      name: req.body.name ?? current.name,
      target_date: req.body.target_date ?? current.target_date,
      percent_complete: req.body.percent_complete ?? current.percent_complete,
    };
    db.prepare("UPDATE pods SET milestone_json = ? WHERE pod_id = ?").run(JSON.stringify(next), podId);
    regenerateLivingDoc(podId);
    return next;
  });

  app.post<{
    Body: z.infer<typeof CreatePodSchema>;
  }>("/api/pods", { preHandler: validateBody(CreatePodSchema) }, async (req, reply) => {
    const { name, sprint_days, milestone_name, project_id } = req.body;

    const podId = allocateUniqueResourceId("pod", name, (id) =>
      Boolean(db.prepare("SELECT pod_id FROM pods WHERE pod_id = ?").get(id)),
    );

    const orgId = req.org!.org_id;

    if (project_id) {
      const proj = db.prepare("SELECT project_id FROM projects WHERE project_id = ? AND org_id = ?").get(project_id, orgId);
      if (!proj) {
        reply.code(400);
        return { error: `Project not found: ${project_id}` };
      }
    }

    const now = new Date();
    const sprintEnd = new Date(now);
    sprintEnd.setDate(sprintEnd.getDate() + sprint_days);

    const milestone: Milestone = {
      name: milestone_name,
      target_date: sprintEnd.toISOString().split("T")[0],
      percent_complete: 0,
    };

    db.prepare(
      `INSERT INTO pods (pod_id, name, sprint_start, sprint_end, day_number, total_days, conflict_pressure, milestone_json, project_id, org_id, created_by_user_id)
       VALUES (?, ?, ?, ?, 1, ?, 0.0, ?, ?, ?, ?)`,
    ).run(
      podId,
      name,
      now.toISOString().split("T")[0],
      sprintEnd.toISOString().split("T")[0],
      sprint_days,
      JSON.stringify(milestone),
      project_id ?? null,
      orgId,
      req.userRecord.user_id,
    );

    // Create default areas
    const insertArea = db.prepare(
      "INSERT INTO pod_areas (pod_id, scope, owner, status) VALUES (?, ?, 'unassigned', 'waiting')",
    );
    for (const scope of getOrgScopeIdsOrdered(orgId)) {
      insertArea.run(podId, scope);
    }

    // Create org summary entry
    db.prepare(
      `INSERT INTO org_pod_summaries (pod_id, name, day_number, total_days, conflict_pressure, open_conflicts, active_tunnels, agent_count, org_id)
       VALUES (?, ?, 1, ?, 0.0, 0, 0, 0, ?)`,
    ).run(podId, name, sprint_days, orgId);

    // Generate initial living doc
    regenerateLivingDoc(podId);

    // Seed with knowledge from past pods
    try {
      const allScopes = getOrgScopeIdsOrdered(orgId);
      const learnings = await getRelevantLearnings(orgId, allScopes, [], 3000, project_id ?? null);
      if (learnings.nodes.length > 0) {
        let knowledgeSection = "\n## Historical Knowledge Context\n\n";
        knowledgeSection += "The following learnings from past pods may be relevant:\n\n";

        const byType = new Map<string, typeof learnings.nodes>();
        for (const node of learnings.nodes) {
          const existing = byType.get(node.type) ?? [];
          existing.push(node);
          byType.set(node.type, existing);
        }

        const typeLabels: Record<string, string> = {
          pattern: "Patterns", anti_pattern: "Anti-Patterns to Avoid",
          resolved_conflict: "Relevant Precedents", decision: "Past Decisions",
          scope_insight: "Scope Insights",
        };

        for (const [type, nodes] of byType) {
          knowledgeSection += `### ${typeLabels[type] ?? type}\n`;
          for (const n of nodes) {
            const conf = n.confidence_score >= 0.8 ? "high" : n.confidence_score >= 0.5 ? "medium" : "low";
            knowledgeSection += `- [${conf}] ${n.summary} *(from: ${n.source_pod_name})*\n`;
          }
          knowledgeSection += "\n";
        }

        // Append to living doc
        const existing = db.prepare("SELECT markdown FROM living_docs WHERE pod_id = ?").get(podId) as { markdown: string } | undefined;
        if (existing) {
          db.prepare("UPDATE living_docs SET markdown = ? WHERE pod_id = ?").run(
            existing.markdown + knowledgeSection, podId,
          );
        }
      }
    } catch (err) {
      app.log.error(err, "Knowledge seeding for new pod failed (non-blocking)");
    }

    // Return the created pod
    const areas = db.prepare("SELECT scope, owner, status, last_activity FROM pod_areas WHERE pod_id = ?").all(podId) as unknown as AreaRow[];
    const row = db.prepare("SELECT * FROM pods WHERE pod_id = ?").get(podId) as unknown as PodRow;
    reply.code(201);
    return rowToPod(row, areas);
  });

  // Lint pass routes
  app.get<{ Params: { podId: string } }>("/api/pods/:podId/lint-findings", async (req, reply) => {
    const pod = db.prepare("SELECT pod_id FROM pods WHERE pod_id = ? AND org_id = ?").get(req.params.podId, req.org!.org_id);
    if (!pod) {
      reply.code(404);
      return { error: "Pod not found" };
    }
    return db.prepare("SELECT * FROM lint_findings WHERE pod_id = ? ORDER BY severity DESC, timestamp DESC").all(req.params.podId);
  });

  app.post<{ Params: { podId: string } }>("/api/pods/:podId/lint", async (req, reply) => {
    const pod = db.prepare("SELECT pod_id FROM pods WHERE pod_id = ? AND org_id = ?").get(req.params.podId, req.org!.org_id);
    if (!pod) {
      reply.code(404);
      return { error: "Pod not found" };
    }
    const { findings, meta } = await runLintPass(req.params.podId);
    return { findings, meta };
  });
}
