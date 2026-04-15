import type { FastifyInstance } from "fastify";
import { z } from "zod";
import db from "../db/connection.js";
import type { Pod, PodArea, Milestone } from "@council/shared";
import { regenerateLivingDoc } from "../council/agents/summary.js";
import { runLintPass } from "../council/agents/lint.js";
import { getRelevantLearnings } from "../services/knowledge-graph.js";
import { validateBody } from "../middleware/validation.js";

const CreatePodSchema = z.object({
  name: z.string().min(1, "name is required").transform(s => s.trim()),
  sprint_days: z.number().int().min(1).max(30).default(5),
  milestone_name: z.string().min(1).default("Sprint Goal"),
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
    name: row.name,
    sprint_start: row.sprint_start,
    sprint_end: row.sprint_end,
    day_number: row.day_number,
    total_days: row.total_days,
    conflict_pressure: row.conflict_pressure,
    milestone: JSON.parse(row.milestone_json) as Milestone,
    areas: areas as PodArea[],
  };
}

const SCOPES = ["frontend", "backend", "design", "qa", "infra", "pm"] as const;

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export default async function podRoutes(app: FastifyInstance) {
  app.get<{ Params: { podId: string } }>("/api/pods/:podId", async (req, reply) => {
    const row = db.prepare("SELECT * FROM pods WHERE pod_id = ?").get(req.params.podId) as PodRow | undefined;
    if (!row) {
      reply.code(404);
      return null;
    }
    const areas = db.prepare("SELECT scope, owner, status, last_activity FROM pod_areas WHERE pod_id = ?").all(row.pod_id) as AreaRow[];
    return rowToPod(row, areas);
  });

  app.post<{
    Body: z.infer<typeof CreatePodSchema>;
  }>("/api/pods", { preHandler: validateBody(CreatePodSchema) }, async (req, reply) => {
    const { name, sprint_days, milestone_name } = req.body;

    const podId = `pod-${slugify(name)}`;

    // Check for duplicates
    const existing = db.prepare("SELECT pod_id FROM pods WHERE pod_id = ?").get(podId);
    if (existing) {
      reply.code(409);
      return { error: `Pod "${name}" already exists` };
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
      `INSERT INTO pods (pod_id, name, sprint_start, sprint_end, day_number, total_days, conflict_pressure, milestone_json)
       VALUES (?, ?, ?, ?, 1, ?, 0.0, ?)`,
    ).run(
      podId,
      name,
      now.toISOString().split("T")[0],
      sprintEnd.toISOString().split("T")[0],
      sprint_days,
      JSON.stringify(milestone),
    );

    // Create default areas
    const insertArea = db.prepare(
      "INSERT INTO pod_areas (pod_id, scope, owner, status) VALUES (?, ?, 'unassigned', 'waiting')",
    );
    for (const scope of SCOPES) {
      insertArea.run(podId, scope);
    }

    // Create org summary entry
    db.prepare(
      `INSERT INTO org_pod_summaries (pod_id, name, day_number, total_days, conflict_pressure, open_conflicts, active_tunnels, agent_count)
       VALUES (?, ?, 1, ?, 0.0, 0, 0, 0)`,
    ).run(podId, name, sprint_days);

    // Generate initial living doc
    regenerateLivingDoc(podId);

    // Seed with knowledge from past pods
    try {
      const allScopes = [...SCOPES];
      const learnings = getRelevantLearnings(allScopes, [], 3000);
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
    const areas = db.prepare("SELECT scope, owner, status, last_activity FROM pod_areas WHERE pod_id = ?").all(podId) as AreaRow[];
    const row = db.prepare("SELECT * FROM pods WHERE pod_id = ?").get(podId) as PodRow;
    reply.code(201);
    return rowToPod(row, areas);
  });

  // Lint pass routes
  app.get<{ Params: { podId: string } }>("/api/pods/:podId/lint-findings", async (req) => {
    return db.prepare("SELECT * FROM lint_findings WHERE pod_id = ? ORDER BY severity DESC, timestamp DESC").all(req.params.podId);
  });

  app.post<{ Params: { podId: string } }>("/api/pods/:podId/lint", async (req) => {
    const findings = runLintPass(req.params.podId);
    return { findings };
  });
}
