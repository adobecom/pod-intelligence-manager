import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

// vi.hoisted runs before vi.mock hoisting, so testDb is available in the factory
const { testDb } = vi.hoisted(() => {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  return { testDb: db };
});

// Mock the db connection to use in-memory database
vi.mock("../db/connection.js", () => ({
  default: testDb,
  withTransaction: (fn: () => unknown) => fn(),
  withImmediateTransaction: (fn: () => unknown) => fn(),
}));

// Mock knowledge graph (depends on filesystem state)
vi.mock("../services/knowledge-graph.js", () => ({
  initializeKnowledgeGraph: vi.fn(),
  refreshAnalysis: vi.fn(),
  getGraph: vi.fn().mockReturnValue({ nodes: [], edges: [] }),
  getStats: vi.fn().mockReturnValue({ total_nodes: 0, by_type: {}, by_confidence: {}, by_domain: {} }),
  stripEmbeddingsFromGraph: vi.fn((graph) => graph),
  curateNode: vi.fn().mockResolvedValue(true),
  addLearningsToGraph: vi.fn().mockResolvedValue({
    nodesAdded: 1,
    edgesAdded: 0,
    nodeIds: ["kn-integration"],
  }),
  queryKnowledge: vi.fn().mockReturnValue({
    nodes: [],
    edges: [],
    total_matching: 0,
    token_estimate: 0,
    truncated: false,
  }),
  getRelevantLearnings: vi.fn().mockResolvedValue({
    nodes: [],
    truncated: false,
    total_matching: 0,
    token_estimate: 0,
    edges: [],
  }),
  getPrecedents: vi.fn().mockResolvedValue({ nodes: [] }),
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
import agentMemoryRoutes from "../routes/agent-memory.js";
import graphRoutes from "../routes/graph.js";
import { registerJsonBodyParser } from "../middleware/validation.js";
import { addLearningsToGraph } from "../services/knowledge-graph.js";

let app: FastifyInstance;

beforeAll(async () => {
  // Create tables in the in-memory database
  createTables();
  // Ensure demo user + demo org exist so routes have a default org to scope to
  ensureDemoOrg();

  // Build a Fastify instance with routes (no websocket for integration tests)
  app = Fastify();
  registerJsonBodyParser(app);

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
  app.register(agentMemoryRoutes);
  app.register(graphRoutes);

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

  it("creates an open conflict for a later update overlapping a prior decision", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/pods",
      payload: { name: "Decision Conflict Pod" },
    });
    expect(create.statusCode).toBe(201);
    const podId = (create.json() as { pod_id: string }).pod_id;

    const first = await app.inject({
      method: "POST",
      url: `/api/pods/${podId}/context-updates`,
      payload: {
        agent_id: "agent-a",
        type: "decision",
        scope: "backend",
        summary: "Use SQLite storage for agent sessions",
        details: "The local persistence layer should use SQLite because the server already depends on node:sqlite for test and development workflows.",
        artifacts: [],
        status: "completed",
        blocks: [],
        blocked_by: [],
        needs_input_from: [],
      },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: `/api/pods/${podId}/context-updates`,
      payload: {
        agent_id: "agent-b",
        type: "decision",
        scope: "backend",
        summary: "Use Postgres storage for agent sessions",
        details: "The session storage implementation should move to Postgres so multiple workers can coordinate writes without local database coupling.",
        artifacts: [],
        status: "completed",
        blocks: [],
        blocked_by: [],
        needs_input_from: [],
      },
    });
    expect(second.statusCode).toBe(201);
    expect((second.json() as { pim: { conflictCreated: boolean } }).pim.conflictCreated).toBe(true);

    const conflicts = await app.inject({ method: "GET", url: `/api/pods/${podId}/conflicts` });
    expect(conflicts.statusCode).toBe(200);
    const body = conflicts.json() as Array<{ status: string; sides: Array<{ contributor: string }> }>;
    expect(body.some((c) => c.status === "open" && c.sides.some((s) => s.contributor === "agent-b"))).toBe(true);
  });

  it("POST /api/agent-sessions creates a session and appends run events", async () => {
    const sessionRes = await app.inject({
      method: "POST",
      url: "/api/agent-sessions",
      payload: {
        pod_id: integrationPodId,
        scope: "frontend",
        agent_id: "agent-fe",
        goal: "Continue frontend integration work",
      },
    });
    expect(sessionRes.statusCode).toBe(201);
    const session = sessionRes.json() as { session_id: string };

    const runRes = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${session.session_id}/runs`,
      payload: { model: "test-model", input_prompt: "resume" },
    });
    expect(runRes.statusCode).toBe(201);
    const run = runRes.json() as { run_id: string };

    const eventRes = await app.inject({
      method: "POST",
      url: `/api/agent-runs/${run.run_id}/events`,
      payload: { event_type: "tool_call", summary: "Read frontend files", expected_seq: 1, created_at: "1900-01-01T00:00:00.000Z" },
    });
    expect(eventRes.statusCode).toBe(201);
    const event = eventRes.json() as { seq: number; created_at: string };
    expect(event.seq).toBe(1);
    expect(event.created_at).not.toBe("1900-01-01T00:00:00.000Z");

    const invalidEventRes = await app.inject({
      method: "POST",
      url: `/api/agent-runs/${run.run_id}/events`,
      payload: { event_type: "freeform_event", summary: "Invalid" },
    });
    expect(invalidEventRes.statusCode).toBe(400);

    const invalidLimitRes = await app.inject({
      method: "GET",
      url: `/api/agent-sessions/${session.session_id}/resume-context?event_limit=garbage`,
    });
    expect(invalidLimitRes.statusCode).toBe(400);

    const endRes = await app.inject({
      method: "PATCH",
      url: `/api/agent-runs/${run.run_id}/end`,
      payload: { status: "completed", final_output: "Finished integration run." },
    });
    expect(endRes.statusCode).toBe(200);

    const lateEventRes = await app.inject({
      method: "POST",
      url: `/api/agent-runs/${run.run_id}/events`,
      payload: { event_type: "model_output", summary: "Too late" },
    });
    expect(lateEventRes.statusCode).toBe(409);
  });

  it("accepts empty application/json bodies on no-body POST actions", async () => {
    const sessionRes = await app.inject({
      method: "POST",
      url: "/api/agent-sessions",
      payload: {
        pod_id: integrationPodId,
        scope: "frontend",
        agent_id: "agent-empty-json",
        goal: "Exercise no-body actions",
      },
    });
    expect(sessionRes.statusCode).toBe(201);
    const session = sessionRes.json() as { session_id: string };

    const runRes = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${session.session_id}/runs`,
      payload: { input_prompt: "finish" },
    });
    expect(runRes.statusCode).toBe(201);
    const run = runRes.json() as { run_id: string };
    const endRun = await app.inject({
      method: "PATCH",
      url: `/api/agent-runs/${run.run_id}/end`,
      payload: { status: "completed", final_output: "Completed no-body action coverage for memory candidates." },
    });
    expect(endRun.statusCode).toBe(200);

    const rollup = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${session.session_id}/rollup`,
      headers: { "content-type": "application/json" },
    });
    expect(rollup.statusCode).toBe(200);
    const candidates = rollup.json() as Array<{ id: string }>;
    expect(candidates.length).toBeGreaterThan(0);

    const promote = await app.inject({
      method: "POST",
      url: `/api/memory-candidates/${candidates[0].id}/promote`,
      headers: { "content-type": "application/json" },
    });
    expect(promote.statusCode).toBe(200);

    const reject = await app.inject({
      method: "POST",
      url: `/api/memory-candidates/${candidates[0].id}/reject`,
      headers: { "content-type": "application/json" },
    });
    expect(reject.statusCode).toBe(200);

    const endSession = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${session.session_id}/end`,
      headers: { "content-type": "application/json" },
    });
    expect(endSession.statusCode).toBe(200);
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

  it("POST /api/pods/:podId/archive returns an async job and completes through status polling", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/pods",
      payload: { name: "Async Archive Pod" },
    });
    expect(create.statusCode).toBe(201);
    const podId = (create.json() as { pod_id: string }).pod_id;

    const decision = await app.inject({
      method: "POST",
      url: `/api/pods/${podId}/context-updates`,
      payload: {
        agent_id: "agent-archive",
        type: "decision",
        scope: "backend",
        summary: "Keep archive extraction asynchronous",
        details: "Archive requests should persist the archived pod immediately and move knowledge extraction into a status-polled background job.",
        artifacts: [],
        status: "completed",
        blocks: [],
        blocked_by: [],
        needs_input_from: [],
      },
    });
    expect(decision.statusCode).toBe(201);

    const archive = await app.inject({
      method: "POST",
      url: `/api/pods/${podId}/archive`,
      headers: { "content-type": "application/json" },
    });
    expect(archive.statusCode).toBe(202);
    const job = archive.json() as { job_id: string; status: string; status_url: string };
    expect(job.job_id).toMatch(/^archive-/);
    expect(job.status).toBe("running");

    const statusPost = await app.inject({
      method: "POST",
      url: job.status_url,
      headers: { "content-type": "application/json" },
    });
    expect([200, 202]).toContain(statusPost.statusCode);

    let completed: { status: string; archived?: { pod_id: string; learnings_extracted?: number } } | null = null;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setImmediate(r));
      const status = await app.inject({ method: "GET", url: job.status_url });
      expect([200, 202]).toContain(status.statusCode);
      const body = status.json() as { status: string; archived?: { pod_id: string; learnings_extracted?: number }; error?: string };
      if (body.status === "failed") throw new Error(body.error ?? "archive failed");
      if (body.status === "completed") {
        completed = body;
        break;
      }
    }
    expect(completed?.archived?.pod_id).toBe(podId);
    expect(completed?.archived?.learnings_extracted).toBe(1);

    const active = await app.inject({ method: "GET", url: "/api/org/pods" });
    expect((active.json() as { pod_id: string }[]).some((p) => p.pod_id === podId)).toBe(false);
  });

  it("POST /api/pods/:podId/archive retries extraction for incomplete archived pods after restart", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/pods",
      payload: { name: "Restart Retry Archive Pod" },
    });
    expect(create.statusCode).toBe(201);
    const podId = (create.json() as { pod_id: string }).pod_id;

    const decision = await app.inject({
      method: "POST",
      url: `/api/pods/${podId}/context-updates`,
      payload: {
        agent_id: "agent-archive-retry",
        type: "decision",
        scope: "backend",
        summary: "Retry archive extraction after restart",
        details: "If the process restarts after archiving but before extraction completes, posting archive again should retry extraction.",
        artifacts: [],
        status: "completed",
        blocks: [],
        blocked_by: [],
        needs_input_from: [],
      },
    });
    expect(decision.statusCode).toBe(201);

    testDb
      .prepare(
        `INSERT OR REPLACE INTO archived_pods (pod_id, name, completed_date, duration_days, final_pressure, org_id, extraction_completed)
         VALUES (?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(podId, "Restart Retry Archive Pod", "2026-01-01", 1, 0.1, "org_demo");
    testDb.prepare("DELETE FROM org_pod_summaries WHERE pod_id = ? AND org_id = ?").run(podId, "org_demo");

    const archive = await app.inject({
      method: "POST",
      url: `/api/pods/${podId}/archive`,
      headers: { "content-type": "application/json" },
    });
    expect(archive.statusCode).toBe(202);
    const job = archive.json() as { status: string; status_url: string; archived?: { extraction_completed?: boolean } };
    expect(job.status).toBe("running");
    expect(job.archived?.extraction_completed).toBe(false);

    let completed: { status: string; archived?: { extraction_completed?: boolean } } | null = null;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setImmediate(r));
      const status = await app.inject({ method: "GET", url: job.status_url });
      expect([200, 202]).toContain(status.statusCode);
      const body = status.json() as { status: string; archived?: { extraction_completed?: boolean }; error?: string };
      if (body.status === "failed") throw new Error(body.error ?? "archive failed");
      if (body.status === "completed") {
        completed = body;
        break;
      }
    }
    expect(completed?.archived?.extraction_completed).toBe(true);
  });

  it("POST /api/pods/:podId/archive preserves archived duration when retrying incomplete extraction", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/pods",
      payload: { name: "Preserve Retry Duration Pod" },
    });
    expect(create.statusCode).toBe(201);
    const podId = (create.json() as { pod_id: string }).pod_id;

    testDb
      .prepare(
        `INSERT OR REPLACE INTO archived_pods (pod_id, name, completed_date, duration_days, final_pressure, org_id, extraction_completed)
         VALUES (?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(podId, "Preserve Retry Duration Pod", "2026-01-01", 2, 0.1, "org_demo");

    const archive = await app.inject({
      method: "POST",
      url: `/api/pods/${podId}/archive`,
      headers: { "content-type": "application/json" },
    });
    expect(archive.statusCode).toBe(202);
    const job = archive.json() as { status: string; archived?: { completed_date?: string; duration_days?: number } };
    expect(job.status).toBe("running");
    expect(job.archived?.completed_date).toBe("2026-01-01");
    expect(job.archived?.duration_days).toBe(2);
  });

  it("POST /api/pods/:podId/archive marks timed-out extraction jobs failed so they can be retried", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/pods",
      payload: { name: "Timed Out Archive Pod" },
    });
    expect(create.statusCode).toBe(201);
    const podId = (create.json() as { pod_id: string }).pod_id;

    const decision = await app.inject({
      method: "POST",
      url: `/api/pods/${podId}/context-updates`,
      payload: {
        agent_id: "agent-archive-timeout",
        type: "decision",
        scope: "backend",
        summary: "Force archive extraction timeout path",
        details: "This decision gives deterministic extraction a learning to ingest while the graph write hangs.",
        artifacts: [],
        status: "completed",
        blocks: [],
        blocked_by: [],
        needs_input_from: [],
      },
    });
    expect(decision.statusCode).toBe(201);

    const priorTimeout = process.env.ARCHIVE_EXTRACTION_TIMEOUT_MS;
    process.env.ARCHIVE_EXTRACTION_TIMEOUT_MS = "1";
    vi.mocked(addLearningsToGraph).mockReturnValueOnce(new Promise(() => {}));

    try {
      const archive = await app.inject({
        method: "POST",
        url: `/api/pods/${podId}/archive`,
        headers: { "content-type": "application/json" },
      });
      expect(archive.statusCode).toBe(202);
      const job = archive.json() as { status: string; status_url: string };
      expect(job.status).toBe("running");

      let failed: { status: string; error?: string; archived?: { extraction_completed?: boolean } } | null = null;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 5));
        const status = await app.inject({ method: "GET", url: job.status_url });
        expect([200, 202]).toContain(status.statusCode);
        const body = status.json() as { status: string; error?: string; archived?: { extraction_completed?: boolean } };
        if (body.status === "failed") {
          failed = body;
          break;
        }
      }

      expect(failed?.status).toBe("failed");
      expect(failed?.error).toContain("timed out");
      expect(failed?.archived?.extraction_completed).toBe(false);

      const retry = await app.inject({
        method: "POST",
        url: `/api/pods/${podId}/archive`,
        headers: { "content-type": "application/json" },
      });
      expect(retry.statusCode).toBe(202);
      expect((retry.json() as { status: string }).status).toBe("running");
    } finally {
      if (priorTimeout === undefined) delete process.env.ARCHIVE_EXTRACTION_TIMEOUT_MS;
      else process.env.ARCHIVE_EXTRACTION_TIMEOUT_MS = priorTimeout;
      vi.mocked(addLearningsToGraph).mockResolvedValue({
        nodesAdded: 1,
        edgesAdded: 0,
        nodeIds: ["kn-integration"],
      });
    }
  });

  it("GET /api/pods/:podId/archive/status reconstructs stable completed timestamps", async () => {
    const podId = "pod-stable-archive-status";
    testDb
      .prepare(
        `INSERT OR REPLACE INTO archived_pods (pod_id, name, completed_date, duration_days, final_pressure, org_id, extraction_completed)
         VALUES (?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(podId, "Stable Archive Status Pod", "2026-01-02", 3, 0.2, "org_demo");

    const status = await app.inject({ method: "GET", url: `/api/pods/${podId}/archive/status` });
    expect(status.statusCode).toBe(200);
    const body = status.json() as { status: string; started_at: string; completed_at?: string };
    expect(body.status).toBe("completed");
    expect(body.started_at).toBe("2026-01-02T00:00:00.000Z");
    expect(body.completed_at).toBe("2026-01-02T00:00:00.000Z");
  });

  it("POST /api/projects creates a project", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        name: "Integration Project Alpha",
        resources: {
          jira: { project_keys: ["MWPW"], epics: ["MWPW-1"], fix_versions: ["T3-26.16"] },
          github: { repos: ["adobe/app"] },
          slack: { thread_urls: ["https://slack.example/archives/C/p1"] },
          aliases: ["IPA"],
        },
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { project_id: string; name: string; anatomy: { internal: unknown[] }; resources: { jira?: { epics?: string[] } } };
    expect(body.project_id).toMatch(/^project-integration-project-alpha-[a-f0-9]{6}$/);
    expect(body.name).toBe("Integration Project Alpha");
    expect(body.anatomy.internal).toEqual([]);
    expect(body.resources.jira?.epics).toEqual(["MWPW-1"]);
  });

  it("project profile endpoints patch and bind resources without whole-object replacement", async () => {
    const pr = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Profile Patch Project", resources: { github: { repos: ["adobe/old"] } } },
    });
    expect(pr.statusCode).toBe(201);
    const projectId = (pr.json() as { project_id: string }).project_id;

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/profile`,
      payload: { jira: { issue_keys: ["MWPW-77"] }, glossary: [{ term: "PAF", definition: "Project answers" }] },
    });
    expect(patch.statusCode).toBe(200);
    expect((patch.json() as { github?: { repos?: string[] }; jira?: { issue_keys?: string[] } }).github?.repos).toEqual(["adobe/old"]);
    expect((patch.json() as { jira?: { issue_keys?: string[] } }).jira?.issue_keys).toEqual(["MWPW-77"]);

    const add = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/resources/bindings`,
      payload: { source: "github", field: "repos", value: "adobe/new" },
    });
    expect(add.statusCode).toBe(200);
    expect((add.json() as { github: { repos: string[] } }).github.repos).toEqual(["adobe/old", "adobe/new"]);

    const remove = await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}/resources/bindings`,
      payload: { source: "github", field: "repos", value: "adobe/old" },
    });
    expect(remove.statusCode).toBe(200);
    expect((remove.json() as { github: { repos: string[] } }).github.repos).toEqual(["adobe/new"]);
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

    const evidence = await app.inject({ method: "GET", url: `/api/projects/${projectId}/evidence` });
    expect(evidence.statusCode).toBe(200);
    expect((evidence.json() as { source: string; summary: string }[])[0].source).toBe("project_update");

    const candidates = await app.inject({ method: "GET", url: `/api/projects/${projectId}/memory-candidates?status=pending` });
    expect(candidates.statusCode).toBe(200);
    const projectCandidates = candidates.json() as { id: string; summary: string }[];
    expect(projectCandidates[0].summary).toBe("Chose SQLite for local dev");

    const promote = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/memory-candidates/${projectCandidates[0].id}/promote`,
      headers: { "content-type": "application/json" },
    });
    expect(promote.statusCode).toBe(200);
    const reject = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/memory-candidates/${projectCandidates[0].id}/reject`,
      headers: { "content-type": "application/json" },
    });
    expect(reject.statusCode).toBe(200);

    const answer = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/answers`,
      payload: { query: "What decision was made about SQLite?" },
    });
    expect(answer.statusCode).toBe(200);
    expect((answer.json() as { sources_used: string[]; citations: unknown[] }).sources_used).toContain("project_evidence");
    expect((answer.json() as { citations: unknown[] }).citations.length).toBeGreaterThan(0);
  });

  it("GET /api/org/config returns scopes", async () => {
    const res = await app.inject({ method: "GET", url: "/api/org/config" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { scopes: { id: string }[] };
    expect(body.scopes.length).toBeGreaterThan(0);
    expect("roles" in body).toBe(false);
  });

  it("POST /api/knowledge/nodes rejects repeated-character garbage", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/knowledge/nodes",
      payload: {
        type: "pattern",
        summary: "aaaaaaaaaa",
        details: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        domains: ["backend"],
      },
    });
    expect(res.statusCode).toBe(422);
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
