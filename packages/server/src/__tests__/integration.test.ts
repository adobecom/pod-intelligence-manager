import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

// vi.hoisted runs before vi.mock hoisting, so testDb is available in the factory
const { testDb } = vi.hoisted(() => {
  // Dynamic require to avoid ESM import issues in hoisted context
  const Database = require("better-sqlite3");
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return { testDb: db };
});

// Mock the db connection to use in-memory database
vi.mock("../db/connection.js", () => ({ default: testDb }));

// Mock knowledge graph (depends on filesystem state)
vi.mock("../services/knowledge-graph.js", () => ({
  initializeKnowledgeGraph: vi.fn(),
  refreshAnalysis: vi.fn(),
  getRelevantLearnings: vi.fn().mockReturnValue({
    nodes: [],
    truncated: false,
    total_matching: 0,
    token_estimate: 0,
    edges: [],
  }),
  getPrecedents: vi.fn().mockReturnValue({ nodes: [] }),
  maybeAddProjectContextSignalToGraph: vi.fn().mockReturnValue({ added: false }),
}));

// Mock Slack (external service)
vi.mock("../services/slack.js", () => ({
  notifyConflictCreated: vi.fn(),
  notifyConflictResolved: vi.fn(),
  notifyPressureThreshold: vi.fn(),
}));

// Import schema creation AFTER mocking db
import { createTables } from "../db/schema.js";
import { ensureDemoOrg } from "../db/seed.js";
import { createAuthHook } from "../middleware/auth.js";
import { resolveRequestOrg } from "../middleware/org-context.js";
import podRoutes from "../routes/pods.js";
import conflictRoutes from "../routes/conflicts.js";
import contextUpdateRoutes from "../routes/context-updates.js";
import livingDocRoutes from "../routes/living-doc.js";
import projectRoutes from "../routes/projects.js";
import orgRoutes from "../routes/org.js";
import orgsRoutes from "../routes/orgs.js";

let app: FastifyInstance;

beforeAll(async () => {
  // Create tables in the in-memory database
  createTables();
  // Ensure demo user + demo org exist so routes have a default org to scope to
  ensureDemoOrg();

  // Build a Fastify instance with routes (no websocket for integration tests)
  app = Fastify();

  // Add a minimal error handler
  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    const statusCode = error.statusCode ?? 500;
    reply.code(statusCode).send({
      error: statusCode >= 500 ? "Internal server error" : error.message,
    });
  });

  // Trust-mode auth + org-context hook — mirrors production index.ts wiring
  const authenticate = createAuthHook("trust");
  app.addHook("onRequest", async (req, reply) => {
    if (req.url === "/api/health") return;
    await authenticate(req, reply);
    if (reply.sent) return;
    const path = req.url.split("?")[0];
    const orgBypass = ["/api/me", "/api/orgs"].some(p => path === p || path.startsWith(p + "/"));
    if (!orgBypass) {
      await resolveRequestOrg(req, reply);
    }
  });

  // Health check
  app.get("/api/health", async () => {
    const row = testDb.prepare("SELECT COUNT(*) as count FROM pods").get() as { count: number };
    return { status: "ok", db: { connected: true, active_pods: row.count } };
  });

  app.register(podRoutes);
  app.register(projectRoutes);
  app.register(orgRoutes);
  app.register(orgsRoutes);
  app.register(conflictRoutes);
  app.register(contextUpdateRoutes);
  app.register(livingDocRoutes);

  await app.ready();
});

afterAll(async () => {
  await app.close();
  testDb.close();
});

describe("Integration: API endpoints", () => {
  /** Set by the first pod create test; used for subsequent pod-scoped requests. */
  let integrationPodId = "";

  it("GET /api/health returns 200 with db status", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.db.connected).toBe(true);
  });

  it("POST /api/pods creates a pod", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/pods",
      payload: { name: "Integration Test Pod" },
    });
    expect(res.statusCode).toBe(201);
    const pod = res.json();
    integrationPodId = pod.pod_id as string;
    expect(integrationPodId).toMatch(/^pod-integration-test-pod-[a-f0-9]{6}$/);
    expect(pod.name).toBe("Integration Test Pod");
    expect(pod.areas).toHaveLength(6); // 6 scopes
  });

  it("GET /api/pods/:podId returns the created pod", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/pods/${integrationPodId}`,
    });
    expect(res.statusCode).toBe(200);
    const pod = res.json();
    expect(pod.name).toBe("Integration Test Pod");
  });

  it("GET /api/pods/:podId returns 404 for nonexistent pod", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/pods/pod-nonexistent",
    });
    expect(res.statusCode).toBe(404);
  });

  it("POST /api/pods allows the same display name with distinct ids", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/api/pods",
      payload: { name: "Duplicate Name Pod" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/pods",
      payload: { name: "Duplicate Name Pod" },
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect((first.json() as { pod_id: string }).pod_id).not.toBe((second.json() as { pod_id: string }).pod_id);
  });

  it("POST /api/pods/:podId/context-updates ingests an update", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/pods/${integrationPodId}/context-updates`,
      payload: {
        agent_id: "agent-fe",
        type: "progress",
        scope: "frontend",
        summary: "Implemented the checkout form with Zod validation",
        details: "Added client-side and server-side validation for all checkout fields",
        artifacts: [],
        status: "in_progress",
        blocks: [],
        blocked_by: [],
        needs_input_from: [],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toMatch(/^ctx-/);
    expect(body.pim.classification).toBe("additive");
    expect(body.pim.merged).toBe(true);
  });

  it("POST /api/pods/:podId/context-updates rejects invalid input", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/pods/${integrationPodId}/context-updates`,
      payload: { summary: "incomplete" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET /api/pods/:podId/context-updates returns updates", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/pods/${integrationPodId}/context-updates`,
    });
    expect(res.statusCode).toBe(200);
    const updates = res.json();
    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect(updates[0].agent_id).toBe("agent-fe");
  });

  it("GET /api/pods/:podId/living-doc returns markdown", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/pods/${integrationPodId}/living-doc`,
    });
    expect(res.statusCode).toBe(200);
    const text = res.body;
    expect(text).toContain("Integration Test Pod");
    expect(text).toContain("Living Doc");
  });

  it("GET /api/pods/:podId/conflicts returns empty initially", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/pods/${integrationPodId}/conflicts`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("overlapping updates from different agents are classified", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/pods/${integrationPodId}/context-updates`,
      payload: {
        agent_id: "agent-be",
        type: "progress",
        scope: "frontend",
        summary: "Implemented the checkout form validation schema",
        details: "Added server-side validation for checkout fields with Zod",
        artifacts: [],
        status: "in_progress",
        blocks: [],
        blocked_by: [],
        needs_input_from: [],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    // Should be classified as overlapping due to keyword matches
    expect(["overlapping", "additive"]).toContain(body.pim.classification);
  });

  it("GET pod reflects pod_areas and milestone derived from context stream", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/pods",
      payload: { name: "Snapshot Area Pod" },
    });
    expect(create.statusCode).toBe(201);
    const podId = create.json().pod_id as string;

    const ingest = await app.inject({
      method: "POST",
      url: `/api/pods/${podId}/context-updates`,
      payload: {
        agent_id: "cursor-agent",
        type: "progress",
        scope: "frontend",
        summary: "Shipped locale picker",
        details: "Details",
        artifacts: [],
        status: "completed",
        blocks: [],
        blocked_by: [],
        needs_input_from: [],
      },
    });
    expect(ingest.statusCode).toBe(201);

    const getPod = await app.inject({ method: "GET", url: `/api/pods/${podId}` });
    expect(getPod.statusCode).toBe(200);
    const pod = getPod.json() as { areas: { scope: string; owner: string; status: string }[]; milestone: { percent_complete: number } };
    const fe = pod.areas.find((a) => a.scope === "frontend");
    expect(fe?.owner).toBe("cursor-agent");
    expect(fe?.status).toBe("done");
    expect(pod.milestone.percent_complete).toBe(17);
  });

  it("PATCH /api/pods/:podId/milestone merges fields and refreshes living doc", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/pods",
      payload: { name: "Milestone Patch Pod" },
    });
    expect(create.statusCode).toBe(201);
    const podId = create.json().pod_id as string;

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/pods/${podId}/milestone`,
      payload: { name: "Custom Milestone Title", percent_complete: 72 },
    });
    expect(patch.statusCode).toBe(200);
    const body = patch.json() as { name: string; percent_complete: number };
    expect(body.name).toBe("Custom Milestone Title");
    expect(body.percent_complete).toBe(72);

    const doc = await app.inject({ method: "GET", url: `/api/pods/${podId}/living-doc` });
    expect(doc.statusCode).toBe(200);
    expect(doc.body).toContain("Custom Milestone Title");
    expect(doc.body).toContain("72% complete");
  });

  it("POST /api/projects creates a project", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Integration Project Alpha" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { project_id: string; name: string; anatomy: { internal: unknown[] } };
    expect(body.project_id).toMatch(/^project-integration-project-alpha-[a-f0-9]{6}$/);
    expect(body.name).toBe("Integration Project Alpha");
    expect(body.anatomy.internal).toEqual([]);
  });

  it("POST /api/pods accepts optional project_id", async () => {
    const pr = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Pod Link Project" },
    });
    expect(pr.statusCode).toBe(201);
    const projectId = (pr.json() as { project_id: string }).project_id;

    const res = await app.inject({
      method: "POST",
      url: "/api/pods",
      payload: { name: "Linked Sprint", project_id: projectId },
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { project_id?: string }).project_id).toBe(projectId);
  });

  it("PATCH /api/pods/:podId links and unlinks project_id", async () => {
    const pr = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Retro Project" },
    });
    expect(pr.statusCode).toBe(201);
    const projectId = (pr.json() as { project_id: string }).project_id;

    const created = await app.inject({
      method: "POST",
      url: "/api/pods",
      payload: { name: "Retro Link Pod" },
    });
    expect(created.statusCode).toBe(201);
    const podId = (created.json() as { pod_id: string }).pod_id;

    const link = await app.inject({
      method: "PATCH",
      url: `/api/pods/${podId}`,
      payload: { project_id: projectId },
    });
    expect(link.statusCode).toBe(200);
    expect((link.json() as { project_id?: string }).project_id).toBe(projectId);

    const unlinked = await app.inject({
      method: "PATCH",
      url: `/api/pods/${podId}`,
      payload: { project_id: null },
    });
    expect(unlinked.statusCode).toBe(200);
    expect((unlinked.json() as { project_id?: string }).project_id).toBeUndefined();
  });

  it("POST /api/projects/:id/context-updates ingests project context", async () => {
    const pr = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Ctx Project" },
    });
    expect(pr.statusCode).toBe(201);
    const projectId = (pr.json() as { project_id: string }).project_id;

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/context-updates`,
      payload: {
        agent_id: "agent-proj",
        type: "decision",
        scope: "backend",
        summary: "Chose SQLite for local dev",
        details: "Matches existing stack",
        artifacts: [],
        status: "completed",
        blocks: [],
        blocked_by: [],
        needs_input_from: [],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; pim: { note?: string } };
    expect(body.id).toMatch(/^pcu-/);
    expect(body.pim.note).toContain("Project context");

    const list = await app.inject({ method: "GET", url: `/api/projects/${projectId}/context-updates` });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { agent_id: string }[])[0].agent_id).toBe("agent-proj");
  });

  it("GET /api/org/config returns scopes", async () => {
    const res = await app.inject({ method: "GET", url: "/api/org/config" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { scopes: { id: string }[] };
    expect(body.scopes.length).toBeGreaterThan(0);
    expect("roles" in body).toBe(false);
  });

  it("PATCH /api/projects/:id updates anatomy", async () => {
    const pr = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Anatomy Integration Project" },
    });
    expect(pr.statusCode).toBe(201);
    const projectId = (pr.json() as { project_id: string }).project_id;

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}`,
      payload: {
        anatomy: {
          internal: [{ scope_id: "frontend" }],
          external: [{ name: "Legal", role: "Reviewer", notes: "Async" }],
        },
      },
    });
    expect(patch.statusCode).toBe(200);
    const body = patch.json() as {
      anatomy: { internal: { scope_id: string }[]; external: { name: string; role: string; notes?: string }[] };
    };
    expect(body.anatomy.internal).toHaveLength(1);
    expect(body.anatomy.internal[0].scope_id).toBe("frontend");
    expect(body.anatomy.external[0].name).toBe("Legal");
    expect(body.anatomy.external[0].role).toBe("Reviewer");
  });

  it("POST /api/projects/:id/archive detaches pods, clears context stream, and lists in archived-projects", async () => {
    const pr = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Archive Me Project", description: "tmp" },
    });
    expect(pr.statusCode).toBe(201);
    const projectId = (pr.json() as { project_id: string }).project_id;

    const podRes = await app.inject({
      method: "POST",
      url: "/api/pods",
      payload: { name: "Attached To Archive Proj", project_id: projectId },
    });
    expect(podRes.statusCode).toBe(201);
    const podId = (podRes.json() as { pod_id: string }).pod_id;

    const cu = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/context-updates`,
      payload: {
        agent_id: "agent-arch",
        type: "progress",
        scope: "frontend",
        summary: "Note",
        details: "Body",
        artifacts: [],
        status: "in_progress",
        blocks: [],
        blocked_by: [],
        needs_input_from: [],
      },
    });
    expect(cu.statusCode).toBe(201);

    const arch = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/archive`,
    });
    expect(arch.statusCode).toBe(200);
    const archived = arch.json() as { project_id: string; name: string; description: string; archived_date: string };
    expect(archived.project_id).toBe(projectId);
    expect(archived.name).toBe("Archive Me Project");
    expect(archived.description).toBe("tmp");
    expect(archived.archived_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const gone = await app.inject({ method: "GET", url: `/api/projects/${projectId}` });
    expect(gone.statusCode).toBe(404);

    const listActive = await app.inject({ method: "GET", url: "/api/projects" });
    expect(listActive.statusCode).toBe(200);
    expect((listActive.json() as { project_id: string }[]).some((p) => p.project_id === projectId)).toBe(false);

    const archivedList = await app.inject({ method: "GET", url: "/api/org/archived-projects" });
    expect(archivedList.statusCode).toBe(200);
    const rows = archivedList.json() as { project_id: string }[];
    expect(rows.some((r) => r.project_id === projectId)).toBe(true);

    const podAfter = await app.inject({ method: "GET", url: `/api/pods/${podId}` });
    expect(podAfter.statusCode).toBe(200);
    expect((podAfter.json() as { project_id?: string }).project_id).toBeUndefined();

    const ctxAfter = await app.inject({ method: "GET", url: `/api/projects/${projectId}/context-updates` });
    expect(ctxAfter.statusCode).toBe(404);
  });
});
