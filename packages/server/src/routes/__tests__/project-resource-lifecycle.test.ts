import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

const { testDb, scheduleProjectSearchRefresh } = vi.hoisted(() => {
  const { DatabaseSync } = require("node:sqlite");
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
  return {
    testDb: database,
    scheduleProjectSearchRefresh: vi.fn(),
  };
});

vi.mock("../../db/connection.js", () => ({
  default: testDb,
  withTransaction: (fn: () => unknown) => fn(),
  withImmediateTransaction: (fn: () => unknown) => fn(),
}));

vi.mock("../../services/project-search-refresh.js", () => ({
  scheduleProjectSearchRefresh,
}));

vi.mock("../../services/project-memory.js", () => ({
  recordProjectEvidence: vi.fn(),
  getProjectSourceHealthLive: vi.fn(),
  listProjectEvidence: vi.fn(),
  listProjectMemoryCandidates: vi.fn(),
  pollProjectSources: vi.fn(),
  promoteProjectMemoryCandidate: vi.fn(),
  rejectProjectMemoryCandidate: vi.fn(),
}));

vi.mock("../../services/project-search-index.js", () => ({
  isProjectSearchFtsAvailable: vi.fn(() => false),
  purgeProjectSearch: vi.fn(),
  reindexProjectSearch: vi.fn(),
}));

vi.mock("../../services/project-ingestion.js", () => ({
  ingestProjectContextUpdate: vi.fn(),
}));

vi.mock("../../services/project-answers.js", () => ({
  answerProjectQuestion: vi.fn(),
}));

vi.mock("../../services/project-search.js", () => ({
  searchProject: vi.fn(),
}));

vi.mock("../../services/knowledge-graph.js", () => ({
  retractProjectEvidenceKnowledgeNodes: vi.fn(() => []),
}));

vi.mock("../../ws/index.js", () => ({
  broadcastToAll: vi.fn(),
}));

import { createTables } from "../../db/schema.js";
import { registerJsonBodyParser } from "../../middleware/validation.js";
import projectRoutes from "../projects.js";

const ORG_ID = "org-project-resource-routes";
const USER_ID = "user-project-resource-routes";
const NOW = "2026-07-19T12:00:00.000Z";

let app: FastifyInstance;

function seedProject(projectId: string, resources: Record<string, unknown>): void {
  testDb.prepare(
    `INSERT INTO projects
       (project_id, name, description, created_at, anatomy_json, resources_json, org_id, created_by_user_id)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`,
  ).run(
    projectId,
    "Resource Lifecycle Project",
    NOW,
    JSON.stringify({ internal: [], external: [] }),
    JSON.stringify(resources),
    ORG_ID,
    USER_ID,
  );
}

function seedSourceState(projectId: string, source: "github" | "jira"): void {
  testDb.prepare(
    `INSERT INTO project_evidence_items
       (id, org_id, project_id, source, source_type, source_id, source_title,
        summary, body, occurred_at, ingested_at, metadata_json, confidence_score)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', 0.8)`,
  ).run(
    `evidence-${projectId}-${source}`,
    ORG_ID,
    projectId,
    source,
    source === "github" ? "pull_request" : "active_issue",
    `${source}-native-id`,
    `${source} evidence`,
    `${source} summary`,
    `${source} body`,
    NOW,
    NOW,
  );
  testDb.prepare(
    `INSERT INTO project_search_documents
       (id, org_id, project_id, source, source_type, source_id, title,
        ingested_at, updated_at, content_hash, metadata_json, permissions_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', '{}')`,
  ).run(
    `document-${projectId}-${source}`,
    ORG_ID,
    projectId,
    source,
    source === "github" ? "pull_request" : "active_issue",
    `${source}-native-id`,
    `${source} document`,
    NOW,
    NOW,
    `hash-${source}`,
  );
  testDb.prepare(
    `INSERT INTO project_ingestion_cursors
       (org_id, project_id, source, cursor_key, cursor_value, updated_at)
     VALUES (?, ?, ?, 'delta', 'cursor', ?)`,
  ).run(ORG_ID, projectId, source, NOW);
  testDb.prepare(
    `INSERT INTO project_source_sync_state
       (org_id, project_id, source, source_instance, indexed_count, updated_at)
     VALUES (?, ?, ?, 'fixture', 1, ?)`,
  ).run(ORG_ID, projectId, source, NOW);
}

function sourceStateCounts(projectId: string, source: string) {
  const count = (table: string) => Number((testDb.prepare(
    `SELECT COUNT(*) AS count FROM ${table} WHERE org_id = ? AND project_id = ? AND source = ?`,
  ).get(ORG_ID, projectId, source) as { count: number }).count);
  return {
    evidence: count("project_evidence_items"),
    documents: count("project_search_documents"),
    cursors: count("project_ingestion_cursors"),
    syncState: count("project_source_sync_state"),
  };
}

beforeAll(async () => {
  createTables();
  testDb.prepare(
    `INSERT INTO users
       (user_id, ims_user_id, email, display_name, is_service, created_at, last_login_at)
     VALUES (?, NULL, 'resource-routes@example.test', 'Resource Routes', 0, ?, ?)`,
  ).run(USER_ID, NOW, NOW);
  testDb.prepare(
    `INSERT INTO orgs (org_id, slug, name, created_by_user_id, created_at)
     VALUES (?, 'project-resource-routes', 'Project Resource Routes', ?, ?)`,
  ).run(ORG_ID, USER_ID, NOW);

  app = Fastify();
  registerJsonBodyParser(app);
  app.addHook("onRequest", async (req: FastifyRequest) => {
    req.org = {
      org_id: ORG_ID,
      slug: "project-resource-routes",
      name: "Project Resource Routes",
      created_by_user_id: USER_ID,
      created_at: NOW,
    };
    req.userRecord = {
      user_id: USER_ID,
      ims_user_id: null,
      email: "resource-routes@example.test",
      display_name: "Resource Routes",
      is_service: 0,
      created_at: NOW,
      last_login_at: NOW,
    };
  });
  app.register(projectRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  testDb.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  testDb.prepare("DELETE FROM project_context_updates WHERE org_id = ?").run(ORG_ID);
  testDb.prepare("DELETE FROM projects WHERE org_id = ?").run(ORG_ID);
});

describe("project resource lifecycle routes", () => {
  it("purges only the changed connector before scheduling its replacement refresh", async () => {
    const projectId = "project-change-resource";
    seedProject(projectId, {
      github: { repos: ["adobe/old"] },
      jira: { project_keys: ["KEEP"] },
    });
    seedSourceState(projectId, "github");
    seedSourceState(projectId, "jira");

    const response = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/profile`,
      payload: { github: { repos: ["adobe/new"] } },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      github: { repos: ["adobe/new"] },
      jira: { project_keys: ["KEEP"] },
    });
    expect(sourceStateCounts(projectId, "github")).toEqual({
      evidence: 0,
      documents: 0,
      cursors: 0,
      syncState: 0,
    });
    expect(sourceStateCounts(projectId, "jira")).toEqual({
      evidence: 1,
      documents: 1,
      cursors: 1,
      syncState: 1,
    });
    expect(scheduleProjectSearchRefresh).toHaveBeenCalledOnce();
    expect(scheduleProjectSearchRefresh).toHaveBeenCalledWith(ORG_ID, projectId);
  });

  it("purges a source when its final binding is removed", async () => {
    const projectId = "project-remove-resource";
    seedProject(projectId, {
      github: { repos: ["adobe/remove-me"] },
      jira: { project_keys: ["KEEP"] },
    });
    seedSourceState(projectId, "github");
    seedSourceState(projectId, "jira");

    const response = await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}/resources/bindings`,
      payload: { source: "github", field: "repos", value: "adobe/remove-me" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      github: { repos: [] },
      jira: { project_keys: ["KEEP"] },
    });
    expect(sourceStateCounts(projectId, "github")).toEqual({
      evidence: 0,
      documents: 0,
      cursors: 0,
      syncState: 0,
    });
    expect(sourceStateCounts(projectId, "jira").evidence).toBe(1);
    expect(scheduleProjectSearchRefresh).toHaveBeenCalledWith(ORG_ID, projectId);
  });

  it("schedules immediate refresh when a project is created with a binding", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        name: "Immediate Refresh Project",
        resources: { confluence: { page_ids: ["page-42"] } },
      },
    });

    expect(response.statusCode).toBe(201);
    const projectId = (response.json() as { project_id: string }).project_id;
    expect(scheduleProjectSearchRefresh).toHaveBeenCalledOnce();
    expect(scheduleProjectSearchRefresh).toHaveBeenCalledWith(ORG_ID, projectId);
  });

  it("schedules immediate refresh when a binding is added", async () => {
    const projectId = "project-add-resource";
    seedProject(projectId, {});

    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/resources/bindings`,
      payload: { source: "confluence", field: "page_ids", value: "page-42" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ confluence: { page_ids: ["page-42"] } });
    expect(scheduleProjectSearchRefresh).toHaveBeenCalledOnce();
    expect(scheduleProjectSearchRefresh).toHaveBeenCalledWith(ORG_ID, projectId);
  });

  it("redacts credentials from resource persistence and route responses", async () => {
    const rawSecret = "resource-secret-value";
    const response = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        name: "Sanitized Resources Project",
        resources: {
          confluence: {
            page_urls: [`https://wiki.example.test/pages/42?access_token=${rawSecret}`],
          },
        },
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.body).not.toContain(rawSecret);
    expect(response.body).toContain("REDACTED");
    const projectId = (response.json() as { project_id: string }).project_id;
    const stored = testDb.prepare(
      "SELECT resources_json FROM projects WHERE project_id = ? AND org_id = ?",
    ).get(projectId, ORG_ID) as { resources_json: string };
    expect(stored.resources_json).not.toContain(rawSecret);
    expect(stored.resources_json).toContain("REDACTED");
  });

  it("retracts a context update and purges its evidence and indexed document in the same request", async () => {
    const projectId = "project-retract-context";
    const updateId = "pcu-route-retract";
    seedProject(projectId, {});
    testDb.prepare(
      `INSERT INTO project_context_updates
         (id, agent_id, timestamp, project_id, type, scope, summary, details, artifacts_json,
          status, blocks_json, blocked_by_json, needs_input_from_json, org_id)
       VALUES (?, 'agent-route', ?, ?, 'decision', 'backend', 'Retire route fixture',
               'This material must disappear', '[]', 'completed', '[]', '[]', '[]', ?)`,
    ).run(updateId, NOW, projectId, ORG_ID);
    testDb.prepare(
      `INSERT INTO project_evidence_items
         (id, org_id, project_id, source, source_type, source_id, source_title, summary, body,
          occurred_at, ingested_at, metadata_json, confidence_score, source_instance, native_id,
          visibility, visibility_version, redaction_version)
       VALUES ('evidence-route-retract', ?, ?, 'project_update', 'decision', ?, 'Retire route fixture',
               'Retire route fixture', 'This material must disappear', ?, ?, '{}', 0.7,
               'pim', ?, 'project_visible', '1', 'project-evidence-v1')`,
    ).run(ORG_ID, projectId, updateId, NOW, NOW, updateId);
    testDb.prepare(
      `INSERT INTO project_search_documents
         (id, org_id, project_id, source, source_type, source_id, title, ingested_at,
          updated_at, content_hash, metadata_json, permissions_json, source_instance, native_id,
          visibility, visibility_version, redaction_version)
       VALUES ('document-route-retract', ?, ?, 'project_update', 'decision', ?, 'Retire route fixture',
               ?, ?, 'route-retract-hash', '{}', '{}', 'pim', ?,
               'project_visible', '1', 'project-evidence-v1')`,
    ).run(ORG_ID, projectId, updateId, NOW, NOW, updateId);

    const response = await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}/context-updates/${updateId}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect((testDb.prepare(
      "SELECT retracted_at FROM project_context_updates WHERE id = ?",
    ).get(updateId) as { retracted_at: string | null }).retracted_at).toBeTruthy();
    expect((testDb.prepare(
      "SELECT COUNT(*) AS count FROM project_evidence_items WHERE project_id = ? AND source_id = ?",
    ).get(projectId, updateId) as { count: number }).count).toBe(0);
    expect((testDb.prepare(
      "SELECT COUNT(*) AS count FROM project_search_documents WHERE project_id = ? AND source_id = ?",
    ).get(projectId, updateId) as { count: number }).count).toBe(0);
  });
});
