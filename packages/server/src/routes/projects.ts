import type { FastifyInstance } from "fastify";
import { z } from "zod";
import db, { withTransaction } from "../db/connection.js";
import {
  type ArchivedProject,
  type Project,
  type ProjectContextUpdate,
  type ProjectResources,
  EMPTY_PROJECT_ANATOMY,
} from "@pim/shared";
import { validateBody } from "../middleware/validation.js";
import {
  rejectServiceToken,
  requireProjectBinding,
  requireServiceScope,
} from "../middleware/service-authz.js";
import { ingestProjectContextUpdate } from "../services/project-ingestion.js";
import { broadcastToAll } from "../ws/index.js";
import { parseProjectAnatomy } from "../services/project-anatomy-parse.js";
import { allocateUniqueResourceId } from "../utils/resource-ids.js";
import { getOrgScopeIds } from "../services/org-settings.js";
import {
  getProjectSourceHealthLive,
  listProjectEvidence,
  listProjectMemoryCandidates,
  pollProjectSources,
  promoteProjectMemoryCandidate,
  rejectProjectMemoryCandidate,
} from "../services/project-memory.js";
import { answerProjectQuestion } from "../services/project-answers.js";
import { searchProject } from "../services/project-search.js";
import { purgeProjectSearch, reindexProjectSearch } from "../services/project-search-index.js";

const ResourcesSchema = z.object({
  jira: z
    .object({
      project_keys: z.array(z.string()).optional(),
      team: z.string().optional(),
      components: z.array(z.string()).optional(),
      epics: z.array(z.string()).optional(),
      issue_keys: z.array(z.string()).optional(),
      fix_versions: z.array(z.string()).optional(),
      version_prefixes: z.array(z.string()).optional(),
      lookback_days: z.number().int().positive().max(3650).optional(),
    })
    .optional(),
  github: z.object({
    repos: z.array(z.string()).optional(),
    default_branches: z.record(z.string()).optional(),
  }).optional(),
  slack: z.object({
    channels: z.array(z.string()).optional(),
    thread_urls: z.array(z.string()).optional(),
  }).optional(),
  confluence: z.object({
    space_keys: z.array(z.string()).optional(),
    page_ids: z.array(z.string()).optional(),
    page_urls: z.array(z.string()).optional(),
  }).optional(),
  git: z.object({
    repo_paths: z.array(z.string()).optional(),
    lookback_days: z.number().int().positive().max(3650).optional(),
  }).optional(),
  aliases: z.array(z.string()).optional(),
  glossary: z.array(z.object({
    term: z.string().min(1),
    definition: z.string().optional(),
    aliases: z.array(z.string()).optional(),
  })).optional(),
});

const ResourcesPatchSchema = ResourcesSchema.deepPartial();

const CreateProjectSchema = z.object({
  name: z.string().min(1).transform(s => s.trim()),
  description: z.string().optional(),
  resources: ResourcesSchema.optional(),
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

const ResourceBindingSchema = z.object({
  source: z.enum(["project", "jira", "github", "slack", "confluence", "git"]),
  field: z.string().min(1),
  value: z.string().min(1).transform(s => s.trim()),
});

const AnswerProjectSchema = z.object({
  query: z.string().min(1).transform(s => s.trim()),
  include_raw_hits: z.boolean().optional(),
});

const SearchProjectSchema = z.object({
  query: z.string().min(1).transform((s) => s.trim()),
  sources: z
    .array(z.enum(["jira", "github", "confluence", "slack", "git", "project_update", "pod_update"]))
    .optional(),
  entity_types: z
    .array(
      z.enum([
        "ticket", "pr", "commit", "file", "symbol", "person",
        "doc", "feature", "decision", "risk", "blocker",
      ]),
    )
    .optional(),
  time_window_days: z.number().int().positive().max(3650).optional(),
  include_kg: z.boolean().optional(),
  include_mind_map: z.boolean().optional(),
  graph_expansion: z.boolean().optional(),
  max_hits: z.number().int().positive().max(50).optional(),
  synthesize: z.boolean().optional(),
});

const ReindexProjectSchema = z.object({
  embed: z.boolean().optional(),
});

function parseResources(raw: string | null | undefined): ProjectResources | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as ProjectResources;
  } catch {
    return undefined;
  }
}

type ProjectRow = {
  project_id: string;
  name: string;
  description: string | null;
  created_at: string;
  anatomy_json?: string | null;
  resources_json?: string | null;
};

function rowToProject(row: ProjectRow): Project {
  return {
    project_id: row.project_id,
    name: row.name,
    description: row.description,
    created_at: row.created_at,
    anatomy: parseProjectAnatomy(row.anatomy_json),
    resources: parseResources(row.resources_json),
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

function mergeProfile(current: ProjectResources, patch: Partial<ProjectResources>): ProjectResources {
  return {
    ...current,
    ...patch,
    jira: patch.jira ? { ...current.jira, ...patch.jira } : current.jira,
    github: patch.github ? { ...current.github, ...patch.github } : current.github,
    slack: patch.slack ? { ...current.slack, ...patch.slack } : current.slack,
    confluence: patch.confluence ? { ...current.confluence, ...patch.confluence } : current.confluence,
    git: patch.git ? { ...current.git, ...patch.git } : current.git,
  };
}

function projectResourceRow(projectId: string, orgId: string): { resources_json: string | null } | undefined {
  return db
    .prepare("SELECT resources_json FROM projects WHERE project_id = ? AND org_id = ?")
    .get(projectId, orgId) as { resources_json: string | null } | undefined;
}

function saveProjectResources(projectId: string, orgId: string, resources: ProjectResources): void {
  db.prepare("UPDATE projects SET resources_json = ? WHERE project_id = ? AND org_id = ?").run(
    JSON.stringify(resources),
    projectId,
    orgId,
  );
}

function bindingArray(resources: ProjectResources, source: string, field: string): string[] | null {
  if (source === "project" && field === "aliases") {
    resources.aliases ??= [];
    return resources.aliases;
  }
  if (source === "jira") {
    resources.jira ??= {};
    if (["project_keys", "epics", "issue_keys", "fix_versions"].includes(field)) {
      const key = field as "project_keys" | "epics" | "issue_keys" | "fix_versions";
      resources.jira[key] ??= [];
      return resources.jira[key]!;
    }
  }
  if (source === "github" && field === "repos") {
    resources.github ??= {};
    resources.github.repos ??= [];
    return resources.github.repos;
  }
  if (source === "slack" && ["channels", "thread_urls"].includes(field)) {
    resources.slack ??= {};
    const key = field as "channels" | "thread_urls";
    resources.slack[key] ??= [];
    return resources.slack[key]!;
  }
  if (source === "confluence" && ["space_keys", "page_ids", "page_urls"].includes(field)) {
    resources.confluence ??= {};
    const key = field as "space_keys" | "page_ids" | "page_urls";
    resources.confluence[key] ??= [];
    return resources.confluence[key]!;
  }
  if (source === "git" && field === "repo_paths") {
    resources.git ??= {};
    resources.git.repo_paths ??= [];
    return resources.git.repo_paths;
  }
  return null;
}

function addBinding(resources: ProjectResources, source: string, field: string, value: string): ProjectResources | null {
  if (source === "jira" && field === "team") {
    return { ...resources, jira: { ...resources.jira, team: value } };
  }
  const arr = bindingArray(resources, source, field);
  if (!arr) return null;
  if (!arr.includes(value)) arr.push(value);
  return resources;
}

function removeBinding(resources: ProjectResources, source: string, field: string, value: string): ProjectResources | null {
  if (source === "jira" && field === "team") {
    if (resources.jira?.team === value) {
      const { team: _team, ...jira } = resources.jira;
      return { ...resources, jira };
    }
    return resources;
  }
  const arr = bindingArray(resources, source, field);
  if (!arr) return null;
  const idx = arr.indexOf(value);
  if (idx >= 0) arr.splice(idx, 1);
  return resources;
}

export default async function projectRoutes(app: FastifyInstance) {
  app.get("/api/projects", async (req, reply) => {
    if (!requireServiceScope(req, reply, "project:read")) return;
    const projectFilter = req.auth?.kind === "service_token" ? req.auth.projectId : undefined;
    if (req.auth?.kind === "service_token" && req.auth.podId) {
      reply.code(403);
      return { error: "PIM pod-bound service token cannot list projects" };
    }
    const rows = db
      .prepare(
        `SELECT project_id, name, description, created_at, anatomy_json, resources_json
         FROM projects
         WHERE org_id = ?${projectFilter ? " AND project_id = ?" : ""}
         ORDER BY name`,
      )
      .all(...(projectFilter ? [req.org!.org_id, projectFilter] : [req.org!.org_id])) as unknown as ProjectRow[];
    return rows.map(rowToProject);
  });

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId", async (req, reply) => {
    if (!requireServiceScope(req, reply, "project:read")) return;
    if (!requireProjectBinding(req, reply, req.params.projectId)) return;
    const row = db
      .prepare(
        "SELECT project_id, name, description, created_at, anatomy_json, resources_json FROM projects WHERE project_id = ? AND org_id = ?",
      )
      .get(req.params.projectId, req.org!.org_id) as ProjectRow | undefined;
    if (!row) {
      reply.code(404);
      return { error: "Project not found" };
    }
    return rowToProject(row);
  });

  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/resources",
    async (req, reply) => {
      if (!rejectServiceToken(req, reply)) return;
      const row = db
        .prepare("SELECT resources_json FROM projects WHERE project_id = ? AND org_id = ?")
        .get(req.params.projectId, req.org!.org_id) as { resources_json: string | null } | undefined;
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
      if (!rejectServiceToken(req, reply)) return;
      const exists = db
        .prepare("SELECT project_id FROM projects WHERE project_id = ? AND org_id = ?")
        .get(req.params.projectId, req.org!.org_id);
      if (!exists) {
        reply.code(404);
        return { error: "Project not found" };
      }
      const json = JSON.stringify(req.body);
      db.prepare("UPDATE projects SET resources_json = ? WHERE project_id = ? AND org_id = ?").run(
        json,
        req.params.projectId,
        req.org!.org_id,
      );
      return req.body;
    },
  );

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/profile", async (req, reply) => {
    if (!rejectServiceToken(req, reply)) return;
    const row = projectResourceRow(req.params.projectId, req.org!.org_id);
    if (!row) {
      reply.code(404);
      return { error: "Project not found" };
    }
    return parseResources(row.resources_json) ?? {};
  });

  app.patch<{ Params: { projectId: string }; Body: Partial<ProjectResources> }>(
    "/api/projects/:projectId/profile",
    { preHandler: validateBody(ResourcesPatchSchema) },
    async (req, reply) => {
      if (!rejectServiceToken(req, reply)) return;
      const row = projectResourceRow(req.params.projectId, req.org!.org_id);
      if (!row) {
        reply.code(404);
        return { error: "Project not found" };
      }
      const merged = mergeProfile(parseResources(row.resources_json) ?? {}, req.body);
      saveProjectResources(req.params.projectId, req.org!.org_id, merged);
      return merged;
    },
  );

  app.post<{ Params: { projectId: string }; Body: z.infer<typeof ResourceBindingSchema> }>(
    "/api/projects/:projectId/resources/bindings",
    { preHandler: validateBody(ResourceBindingSchema) },
    async (req, reply) => {
      if (!rejectServiceToken(req, reply)) return;
      const row = projectResourceRow(req.params.projectId, req.org!.org_id);
      if (!row) {
        reply.code(404);
        return { error: "Project not found" };
      }
      const current = parseResources(row.resources_json) ?? {};
      const next = addBinding(current, req.body.source, req.body.field, req.body.value);
      if (!next) {
        reply.code(400);
        return { error: `Unsupported resource binding ${req.body.source}.${req.body.field}` };
      }
      saveProjectResources(req.params.projectId, req.org!.org_id, next);
      return next;
    },
  );

  app.delete<{ Params: { projectId: string }; Body: z.infer<typeof ResourceBindingSchema> }>(
    "/api/projects/:projectId/resources/bindings",
    { preHandler: validateBody(ResourceBindingSchema) },
    async (req, reply) => {
      if (!rejectServiceToken(req, reply)) return;
      const row = projectResourceRow(req.params.projectId, req.org!.org_id);
      if (!row) {
        reply.code(404);
        return { error: "Project not found" };
      }
      const current = parseResources(row.resources_json) ?? {};
      const next = removeBinding(current, req.body.source, req.body.field, req.body.value);
      if (!next) {
        reply.code(400);
        return { error: `Unsupported resource binding ${req.body.source}.${req.body.field}` };
      }
      saveProjectResources(req.params.projectId, req.org!.org_id, next);
      return next;
    },
  );

  app.post<{ Body: z.infer<typeof CreateProjectSchema> }>(
    "/api/projects",
    { preHandler: validateBody(CreateProjectSchema) },
    async (req, reply) => {
      if (!rejectServiceToken(req, reply)) return;
      const { name, description, resources } = req.body;
      const orgId = req.org!.org_id;
      const projectId = allocateUniqueResourceId("project", name, (id) =>
        Boolean(db.prepare("SELECT project_id FROM projects WHERE project_id = ?").get(id)),
      );
      const created_at = new Date().toISOString();
      const anatomyJson = JSON.stringify(EMPTY_PROJECT_ANATOMY);
      const resourcesJson = resources ? JSON.stringify(resources) : null;
      db.prepare(
        "INSERT INTO projects (project_id, name, description, created_at, anatomy_json, resources_json, org_id, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(projectId, name, description ?? null, created_at, anatomyJson, resourcesJson, orgId, req.userRecord.user_id);
      reply.code(201);
      return rowToProject({
        project_id: projectId,
        name,
        description: description ?? null,
        created_at,
        anatomy_json: anatomyJson,
        resources_json: resourcesJson,
      });
    },
  );

  app.patch<{
    Params: { projectId: string };
    Body: z.infer<typeof PatchProjectSchema>;
  }>("/api/projects/:projectId", { preHandler: validateBody(PatchProjectSchema) }, async (req, reply) => {
    if (!rejectServiceToken(req, reply)) return;
    const row = db.prepare("SELECT * FROM projects WHERE project_id = ? AND org_id = ?").get(req.params.projectId, req.org!.org_id) as
      | ProjectRow
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
      req.body.anatomy !== undefined
        ? JSON.stringify(req.body.anatomy)
        : row.anatomy_json ?? JSON.stringify(EMPTY_PROJECT_ANATOMY);
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

  app.get<{ Params: { projectId: string }; Querystring: { include_retracted?: string } }>("/api/projects/:projectId/context-updates", async (req, reply) => {
    if (!requireServiceScope(req, reply, "project-context:read")) return;
    if (!requireProjectBinding(req, reply, req.params.projectId)) return;
    const project = db.prepare("SELECT project_id FROM projects WHERE project_id = ? AND org_id = ?").get(req.params.projectId, req.org!.org_id);
    if (!project) {
      reply.code(404);
      return { error: "Project not found" };
    }
    const includeRetracted = req.query.include_retracted === "true";
    const rows = db
      .prepare(
        `SELECT id, agent_id, timestamp, project_id, type, scope, summary, details, artifacts_json, status, quality_score,
                retrieval_text, entity_refs_json, blocks_json, blocked_by_json, needs_input_from_json, source, commit_sha
         FROM project_context_updates WHERE project_id = ? AND org_id = ?${includeRetracted ? "" : " AND retracted_at IS NULL"} ORDER BY timestamp DESC`,
      )
      .all(req.params.projectId, req.org!.org_id) as Array<{
        id: string;
        agent_id: string;
        timestamp: string;
        project_id: string;
        type: ProjectContextUpdate["type"];
        scope: ProjectContextUpdate["scope"];
        summary: string;
        details: string;
        retrieval_text: string | null;
        entity_refs_json: string | null;
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
      retrieval_text: r.retrieval_text ?? undefined,
      entity_refs: JSON.parse(r.entity_refs_json ?? "[]") as ProjectContextUpdate["entity_refs"],
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
      if (!requireServiceScope(req, reply, "context-update:write")) return;
      if (!requireProjectBinding(req, reply, req.params.projectId)) return;
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

  app.delete<{ Params: { projectId: string; updateId: string } }>("/api/projects/:projectId/context-updates/:updateId", async (req, reply) => {
    if (!rejectServiceToken(req, reply)) return;
    const { projectId, updateId } = req.params;

    const row = db.prepare(
      "SELECT id FROM project_context_updates WHERE id = ? AND project_id = ? AND org_id = ? AND retracted_at IS NULL",
    ).get(updateId, projectId, req.org!.org_id) as { id: string } | undefined;

    if (!row) {
      reply.code(404);
      return { error: "Update not found or already retracted" };
    }

    const now = new Date().toISOString();
    db.prepare("UPDATE project_context_updates SET retracted_at = ? WHERE id = ?").run(now, updateId);

    broadcastToAll({ type: "update_retracted", podId: projectId, payload: { updateId, retracted_at: now } });

    return { ok: true };
  });

  app.get<{ Params: { projectId: string }; Querystring: { limit?: string } }>(
    "/api/projects/:projectId/evidence",
    async (req, reply) => {
      if (!requireServiceScope(req, reply, "project-context:read")) return;
      if (!requireProjectBinding(req, reply, req.params.projectId)) return;
      const limit = Math.max(1, Math.min(500, parseInt(req.query.limit ?? "100", 10)));
      const rows = listProjectEvidence(req.org!.org_id, req.params.projectId, limit);
      if (!rows) {
        reply.code(404);
        return { error: "Project not found" };
      }
      return rows;
    },
  );

  app.get<{ Params: { projectId: string }; Querystring: { status?: string } }>(
    "/api/projects/:projectId/memory-candidates",
    async (req, reply) => {
      if (!requireServiceScope(req, reply, "agent-session:read")) return;
      if (!requireProjectBinding(req, reply, req.params.projectId)) return;
      const status = req.query.status as "pending" | "promoted" | "rejected" | undefined;
      if (status && !["pending", "promoted", "rejected"].includes(status)) {
        reply.code(400);
        return { error: "Invalid status" };
      }
      const rows = listProjectMemoryCandidates(req.org!.org_id, req.params.projectId, status);
      if (!rows) {
        reply.code(404);
        return { error: "Project not found" };
      }
      return rows;
    },
  );

  app.post<{ Params: { projectId: string; candidateId: string } }>(
    "/api/projects/:projectId/memory-candidates/:candidateId/promote",
    async (req, reply) => {
      if (!requireServiceScope(req, reply, "agent-memory:curate")) return;
      if (!requireProjectBinding(req, reply, req.params.projectId)) return;
      const candidate = await promoteProjectMemoryCandidate(req.org!.org_id, req.params.projectId, req.params.candidateId);
      if (!candidate) {
        reply.code(404);
        return { error: "Candidate not found" };
      }
      return candidate;
    },
  );

  app.post<{ Params: { projectId: string; candidateId: string } }>(
    "/api/projects/:projectId/memory-candidates/:candidateId/reject",
    async (req, reply) => {
      if (!requireServiceScope(req, reply, "agent-memory:curate")) return;
      if (!requireProjectBinding(req, reply, req.params.projectId)) return;
      const candidate = rejectProjectMemoryCandidate(req.org!.org_id, req.params.projectId, req.params.candidateId);
      if (!candidate) {
        reply.code(404);
        return { error: "Candidate not found" };
      }
      return candidate;
    },
  );

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/source-health", async (req, reply) => {
    if (!requireServiceScope(req, reply, "project:read")) return;
    if (!requireProjectBinding(req, reply, req.params.projectId)) return;
    const health = await getProjectSourceHealthLive(req.org!.org_id, req.params.projectId);
    if (!health) {
      reply.code(404);
      return { error: "Project not found" };
    }
    return health;
  });

  app.post<{ Params: { projectId: string } }>("/api/projects/:projectId/ingest/poll", async (req, reply) => {
    if (!rejectServiceToken(req, reply)) return;
    const result = await pollProjectSources(req.org!.org_id, req.params.projectId);
    if (!result) {
      reply.code(404);
      return { error: "Project not found" };
    }
    return result;
  });

  app.post<{ Params: { projectId: string }; Body: z.infer<typeof AnswerProjectSchema> }>(
    "/api/projects/:projectId/answers",
    { preHandler: validateBody(AnswerProjectSchema) },
    async (req, reply) => {
      if (!rejectServiceToken(req, reply)) return;
      const answer = answerProjectQuestion(req.org!.org_id, req.params.projectId, req.body.query);
      if (!answer) {
        reply.code(404);
        return { error: "Project not found" };
      }
      return answer;
    },
  );

  app.post<{ Params: { projectId: string }; Body: z.infer<typeof SearchProjectSchema> }>(
    "/api/projects/:projectId/search",
    { preHandler: validateBody(SearchProjectSchema) },
    async (req, reply) => {
      if (!rejectServiceToken(req, reply)) return;
      const result = await searchProject(req.org!.org_id, req.params.projectId, req.body);
      if (!result) {
        reply.code(404);
        return { error: "Project not found" };
      }
      return result;
    },
  );

  app.post<{ Params: { projectId: string }; Body: z.infer<typeof ReindexProjectSchema> }>(
    "/api/projects/:projectId/search/reindex",
    { preHandler: validateBody(ReindexProjectSchema) },
    async (req, reply) => {
      if (!rejectServiceToken(req, reply)) return;
      const orgId = req.org!.org_id;
      const exists = db.prepare("SELECT 1 FROM projects WHERE project_id = ? AND org_id = ?").get(req.params.projectId, orgId);
      if (!exists) {
        reply.code(404);
        return { error: "Project not found" };
      }
      return reindexProjectSearch(orgId, req.params.projectId, { embed: req.body.embed ?? false });
    },
  );

  app.post<{ Params: { projectId: string } }>("/api/projects/:projectId/archive", async (req, reply) => {
    if (!rejectServiceToken(req, reply)) return;
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
      db.prepare("DELETE FROM project_context_updates WHERE project_id = ? AND org_id = ?").run(projectId, orgId);
      db.prepare("DELETE FROM project_memory_candidates WHERE project_id = ? AND org_id = ?").run(projectId, orgId);
      db.prepare("DELETE FROM project_evidence_items WHERE project_id = ? AND org_id = ?").run(projectId, orgId);
      db.prepare("DELETE FROM project_ingestion_cursors WHERE project_id = ? AND org_id = ?").run(projectId, orgId);
      db.prepare("UPDATE pods SET project_id = NULL WHERE project_id = ? AND org_id = ?").run(projectId, orgId);
      db.prepare(
        `INSERT INTO archived_projects (project_id, name, description, created_at, anatomy_json, archived_date, org_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(row.project_id, row.name, row.description, row.created_at, anatomyJson, archivedDate, orgId);
      purgeProjectSearch(orgId, projectId);
      db.prepare("DELETE FROM projects WHERE project_id = ? AND org_id = ?").run(projectId, orgId);
    };
    withTransaction(run);

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
