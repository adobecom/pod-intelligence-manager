import type { FastifyInstance } from "fastify";
import { z } from "zod";
import db from "../db/connection.js";
import {
  type ArchivedProject,
  type Project,
  type ProjectContextUpdate,
  EMPTY_PROJECT_ANATOMY,
} from "@pim/shared";
import { validateBody } from "../middleware/validation.js";
import { ingestProjectContextUpdate } from "../services/project-ingestion.js";
import { parseProjectAnatomy } from "../services/project-anatomy-parse.js";
import { allocateUniqueResourceId } from "../utils/resource-ids.js";
import { getOrgScopeIds } from "../services/org-settings.js";

const CreateProjectSchema = z.object({
  name: z.string().min(1).transform(s => s.trim()),
  description: z.string().optional(),
});

const ProjectAnatomyBodySchema = z.object({
  internal: z.array(z.object({ scope_id: z.string().min(1) })),
  external: z.array(
    z.object({
      name: z.string().min(1),
      role: z.string().min(1),
      notes: z.string().optional(),
    }),
  ),
});

const PatchProjectSchema = z.object({
  name: z.string().min(1).transform(s => s.trim()).optional(),
  description: z.union([z.string(), z.null()]).optional(),
  anatomy: ProjectAnatomyBodySchema.optional(),
});

function rowToProject(row: {
  project_id: string;
  name: string;
  description: string | null;
  created_at: string;
  anatomy_json?: string | null;
}): Project {
  return {
    project_id: row.project_id,
    name: row.name,
    description: row.description,
    created_at: row.created_at,
    anatomy: parseProjectAnatomy(row.anatomy_json),
  };
}

function rowToArchivedProject(row: {
  project_id: string;
  name: string;
  description: string | null;
  created_at: string;
  anatomy_json: string;
  archived_date: string;
}): ArchivedProject {
  return {
    project_id: row.project_id,
    name: row.name,
    description: row.description,
    created_at: row.created_at,
    archived_date: row.archived_date,
    anatomy: parseProjectAnatomy(row.anatomy_json),
  };
}

export default async function projectRoutes(app: FastifyInstance) {
  app.get("/api/projects", async (req) => {
    const rows = db.prepare("SELECT project_id, name, description, created_at, anatomy_json FROM projects WHERE org_id = ? ORDER BY name").all(req.org!.org_id) as Array<{
      project_id: string;
      name: string;
      description: string | null;
      created_at: string;
      anatomy_json: string | null;
    }>;
    return rows.map(rowToProject);
  });

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId", async (req, reply) => {
    const row = db
      .prepare("SELECT project_id, name, description, created_at, anatomy_json FROM projects WHERE project_id = ? AND org_id = ?")
      .get(req.params.projectId, req.org!.org_id) as
      | {
          project_id: string;
          name: string;
          description: string | null;
          created_at: string;
          anatomy_json: string | null;
        }
      | undefined;
    if (!row) {
      reply.code(404);
      return { error: "Project not found" };
    }
    return rowToProject(row);
  });

  app.post<{ Body: z.infer<typeof CreateProjectSchema> }>(
    "/api/projects",
    { preHandler: validateBody(CreateProjectSchema) },
    async (req, reply) => {
      const { name, description } = req.body;
      const orgId = req.org!.org_id;
      const projectId = allocateUniqueResourceId("project", name, (id) =>
        Boolean(db.prepare("SELECT project_id FROM projects WHERE project_id = ?").get(id)),
      );
      const created_at = new Date().toISOString();
      const anatomyJson = JSON.stringify(EMPTY_PROJECT_ANATOMY);
      db.prepare(
        "INSERT INTO projects (project_id, name, description, created_at, anatomy_json, org_id, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(projectId, name, description ?? null, created_at, anatomyJson, orgId, req.userRecord.user_id);
      reply.code(201);
      return rowToProject({
        project_id: projectId,
        name,
        description: description ?? null,
        created_at,
        anatomy_json: anatomyJson,
      });
    },
  );

  app.patch<{
    Params: { projectId: string };
    Body: z.infer<typeof PatchProjectSchema>;
  }>("/api/projects/:projectId", { preHandler: validateBody(PatchProjectSchema) }, async (req, reply) => {
    const row = db.prepare("SELECT * FROM projects WHERE project_id = ? AND org_id = ?").get(req.params.projectId, req.org!.org_id) as
      | {
          project_id: string;
          name: string;
          description: string | null;
          created_at: string;
          anatomy_json: string | null;
        }
      | undefined;
    if (!row) {
      reply.code(404);
      return { error: "Project not found" };
    }
    if (req.body.anatomy) {
      const ids = getOrgScopeIds(req.org!.org_id);
      for (const s of req.body.anatomy.internal) {
        if (!ids.has(s.scope_id)) {
          reply.code(400);
          return { error: `anatomy.internal.scope_id "${s.scope_id}" is not a valid org scope` };
        }
      }
    }
    const name = req.body.name ?? row.name;
    const description = req.body.description !== undefined ? req.body.description : row.description;
    const anatomyJson =
      req.body.anatomy !== undefined ? JSON.stringify(req.body.anatomy) : row.anatomy_json ?? JSON.stringify(EMPTY_PROJECT_ANATOMY);
    db.prepare("UPDATE projects SET name = ?, description = ?, anatomy_json = ? WHERE project_id = ? AND org_id = ?").run(
      name,
      description,
      anatomyJson,
      req.params.projectId,
      req.org!.org_id,
    );
    return rowToProject({
      ...row,
      name,
      description,
      anatomy_json: anatomyJson,
    });
  });

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/context-updates", async (req, reply) => {
    const project = db.prepare("SELECT project_id FROM projects WHERE project_id = ? AND org_id = ?").get(req.params.projectId, req.org!.org_id);
    if (!project) {
      reply.code(404);
      return { error: "Project not found" };
    }
    const rows = db
      .prepare(
        `SELECT id, agent_id, timestamp, project_id, type, scope, summary, details, artifacts_json, status, quality_score,
                blocks_json, blocked_by_json, needs_input_from_json, source, commit_sha
         FROM project_context_updates WHERE project_id = ? ORDER BY timestamp DESC`,
      )
      .all(req.params.projectId) as Array<{
        id: string;
        agent_id: string;
        timestamp: string;
        project_id: string;
        type: ProjectContextUpdate["type"];
        scope: ProjectContextUpdate["scope"];
        summary: string;
        details: string;
        artifacts_json: string;
        status: ProjectContextUpdate["status"];
        quality_score: number;
        blocks_json: string;
        blocked_by_json: string;
        needs_input_from_json: string;
        source: string;
        commit_sha: string | null;
      }>;

    return rows.map(r => ({
      id: r.id,
      agent_id: r.agent_id,
      timestamp: r.timestamp,
      project_id: r.project_id,
      type: r.type,
      scope: r.scope,
      summary: r.summary,
      details: r.details,
      artifacts: JSON.parse(r.artifacts_json) as ProjectContextUpdate["artifacts"],
      status: r.status,
      quality_score: r.quality_score,
      blocks: JSON.parse(r.blocks_json) as string[],
      blocked_by: JSON.parse(r.blocked_by_json) as string[],
      needs_input_from: JSON.parse(r.needs_input_from_json) as ProjectContextUpdate["needs_input_from"],
      source: r.source as ProjectContextUpdate["source"],
    }));
  });

  app.post<{ Params: { projectId: string }; Body: unknown }>(
    "/api/projects/:projectId/context-updates",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const project = db.prepare("SELECT project_id FROM projects WHERE project_id = ? AND org_id = ?").get(req.params.projectId, req.org!.org_id);
      if (!project) {
        reply.code(404);
        return { error: "Project not found" };
      }
      const result = await ingestProjectContextUpdate(req.params.projectId, req.body);
      if (!result.success) {
        reply.code(result.secretFindings ? 422 : 400);
        return { error: result.error, secretFindings: result.secretFindings };
      }
      if (result.deduplicated) {
        reply.code(200);
        return { deduplicated: true, message: "Commit already reported by another source" };
      }
      reply.code(201);
      return { id: result.update!.id, update: result.update, pim: result.pim };
    },
  );

  app.post<{ Params: { projectId: string } }>("/api/projects/:projectId/archive", async (req, reply) => {
    const projectId = req.params.projectId;
    const orgId = req.org!.org_id;
    const row = db.prepare("SELECT * FROM projects WHERE project_id = ? AND org_id = ?").get(projectId, orgId) as
      | {
          project_id: string;
          name: string;
          description: string | null;
          created_at: string;
          anatomy_json: string | null;
        }
      | undefined;
    if (!row) {
      reply.code(404);
      return { error: "Project not found" };
    }

    const archivedDate = new Date().toISOString().split("T")[0];
    const anatomyJson = row.anatomy_json ?? JSON.stringify(EMPTY_PROJECT_ANATOMY);

    const run = () => {
      db.prepare("DELETE FROM project_context_updates WHERE project_id = ?").run(projectId);
      db.prepare("UPDATE pods SET project_id = NULL WHERE project_id = ?").run(projectId);
      db.prepare(
        `INSERT INTO archived_projects (project_id, name, description, created_at, anatomy_json, archived_date, org_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(row.project_id, row.name, row.description, row.created_at, anatomyJson, archivedDate, orgId);
      db.prepare("DELETE FROM projects WHERE project_id = ?").run(projectId);
    };
    db.transaction(run)();

    return rowToArchivedProject({
      project_id: row.project_id,
      name: row.name,
      description: row.description,
      created_at: row.created_at,
      anatomy_json: anatomyJson,
      archived_date: archivedDate,
    });
  });
}
