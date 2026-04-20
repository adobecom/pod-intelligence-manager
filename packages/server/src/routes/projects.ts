import type { FastifyInstance } from "fastify";
import { z } from "zod";
import db from "../db/connection.js";
import type { Project, ProjectContextUpdate, ProjectResources } from "@council/shared";
import { validateBody } from "../middleware/validation.js";
import { ingestProjectContextUpdate } from "../services/project-ingestion.js";
import { allocateUniqueResourceId } from "../utils/resource-ids.js";

const ResourcesSchema = z.object({
  jira: z
    .object({
      project_keys: z.array(z.string()).optional(),
      team: z.string().optional(),
    })
    .optional(),
  github: z.object({ repos: z.array(z.string()).optional() }).optional(),
  slack: z.object({ channels: z.array(z.string()).optional() }).optional(),
  confluence: z.object({ space_keys: z.array(z.string()).optional() }).optional(),
  git: z.object({ repo_paths: z.array(z.string()).optional() }).optional(),
  aliases: z.array(z.string()).optional(),
});

const CreateProjectSchema = z.object({
  name: z.string().min(1).transform(s => s.trim()),
  description: z.string().optional(),
  resources: ResourcesSchema.optional(),
});

const PatchProjectSchema = z.object({
  name: z.string().min(1).transform(s => s.trim()).optional(),
  description: z.union([z.string(), z.null()]).optional(),
});

function parseResources(raw: string | null | undefined): ProjectResources | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as ProjectResources;
  } catch {
    return undefined;
  }
}

function rowToProject(row: {
  project_id: string;
  name: string;
  description: string | null;
  created_at: string;
  resources_json?: string | null;
}): Project {
  return {
    project_id: row.project_id,
    name: row.name,
    description: row.description,
    created_at: row.created_at,
    resources: parseResources(row.resources_json),
  };
}

export default async function projectRoutes(app: FastifyInstance) {
  type ProjectRow = {
    project_id: string;
    name: string;
    description: string | null;
    created_at: string;
    resources_json: string | null;
  };

  app.get("/api/projects", async () => {
    const rows = db
      .prepare("SELECT project_id, name, description, created_at, resources_json FROM projects ORDER BY name")
      .all() as ProjectRow[];
    return rows.map(rowToProject);
  });

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId", async (req, reply) => {
    const row = db
      .prepare("SELECT project_id, name, description, created_at, resources_json FROM projects WHERE project_id = ?")
      .get(req.params.projectId) as ProjectRow | undefined;
    if (!row) {
      reply.code(404);
      return { error: "Project not found" };
    }
    return rowToProject(row);
  });

  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/resources",
    async (req, reply) => {
      const row = db
        .prepare("SELECT resources_json FROM projects WHERE project_id = ?")
        .get(req.params.projectId) as { resources_json: string | null } | undefined;
      if (!row) {
        reply.code(404);
        return { error: "Project not found" };
      }
      return parseResources(row.resources_json) ?? {};
    },
  );

  app.put<{
    Params: { projectId: string };
    Body: z.infer<typeof ResourcesSchema>;
  }>(
    "/api/projects/:projectId/resources",
    { preHandler: validateBody(ResourcesSchema) },
    async (req, reply) => {
      const exists = db
        .prepare("SELECT project_id FROM projects WHERE project_id = ?")
        .get(req.params.projectId);
      if (!exists) {
        reply.code(404);
        return { error: "Project not found" };
      }
      const json = JSON.stringify(req.body);
      db.prepare("UPDATE projects SET resources_json = ? WHERE project_id = ?").run(
        json,
        req.params.projectId,
      );
      return req.body;
    },
  );

  app.post<{ Body: z.infer<typeof CreateProjectSchema> }>(
    "/api/projects",
    { preHandler: validateBody(CreateProjectSchema) },
    async (req, reply) => {
      const { name, description, resources } = req.body;
      const projectId = allocateUniqueResourceId("project", name, (id) =>
        Boolean(db.prepare("SELECT project_id FROM projects WHERE project_id = ?").get(id)),
      );
      const created_at = new Date().toISOString();
      const resources_json = resources ? JSON.stringify(resources) : null;
      db.prepare(
        "INSERT INTO projects (project_id, name, description, created_at, resources_json) VALUES (?, ?, ?, ?, ?)",
      ).run(projectId, name, description ?? null, created_at, resources_json);
      reply.code(201);
      return rowToProject({
        project_id: projectId,
        name,
        description: description ?? null,
        created_at,
        resources_json,
      });
    },
  );

  app.patch<{
    Params: { projectId: string };
    Body: z.infer<typeof PatchProjectSchema>;
  }>("/api/projects/:projectId", { preHandler: validateBody(PatchProjectSchema) }, async (req, reply) => {
    const row = db.prepare("SELECT * FROM projects WHERE project_id = ?").get(req.params.projectId) as
      | ProjectRow
      | undefined;
    if (!row) {
      reply.code(404);
      return { error: "Project not found" };
    }
    const name = req.body.name ?? row.name;
    const description = req.body.description !== undefined ? req.body.description : row.description;
    db.prepare("UPDATE projects SET name = ?, description = ? WHERE project_id = ?").run(
      name,
      description,
      req.params.projectId,
    );
    return rowToProject({
      ...row,
      name,
      description,
    });
  });

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/context-updates", async (req, reply) => {
    const project = db.prepare("SELECT project_id FROM projects WHERE project_id = ?").get(req.params.projectId);
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
      return { id: result.update!.id, update: result.update, council: result.council };
    },
  );
}
