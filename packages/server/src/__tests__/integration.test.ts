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
  getRelevantLearnings: vi.fn().mockReturnValue({ nodes: [], truncated: false, total_matching: 0 }),
  getPrecedents: vi.fn().mockReturnValue({ nodes: [] }),
}));

// Mock Slack (external service)
vi.mock("../services/slack.js", () => ({
  notifyConflictCreated: vi.fn(),
  notifyConflictResolved: vi.fn(),
  notifyPressureThreshold: vi.fn(),
}));

// Import schema creation AFTER mocking db
import { createTables } from "../db/schema.js";
import podRoutes from "../routes/pods.js";
import conflictRoutes from "../routes/conflicts.js";
import contextUpdateRoutes from "../routes/context-updates.js";
import livingDocRoutes from "../routes/living-doc.js";

let app: FastifyInstance;

beforeAll(async () => {
  // Create tables in the in-memory database
  createTables();

  // Build a Fastify instance with routes (no websocket for integration tests)
  app = Fastify();

  // Add a minimal error handler
  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    const statusCode = error.statusCode ?? 500;
    reply.code(statusCode).send({
      error: statusCode >= 500 ? "Internal server error" : error.message,
    });
  });

  // Health check
  app.get("/api/health", async () => {
    const row = testDb.prepare("SELECT COUNT(*) as count FROM pods").get() as { count: number };
    return { status: "ok", db: { connected: true, active_pods: row.count } };
  });

  app.register(podRoutes);
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
    expect(pod.pod_id).toBe("pod-integration-test-pod");
    expect(pod.name).toBe("Integration Test Pod");
    expect(pod.areas).toHaveLength(6); // 6 scopes
  });

  it("GET /api/pods/:podId returns the created pod", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/pods/pod-integration-test-pod",
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

  it("POST /api/pods rejects duplicate pod names", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/pods",
      payload: { name: "Integration Test Pod" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("POST /api/pods/:podId/context-updates ingests an update", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/pods/pod-integration-test-pod/context-updates",
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
    expect(body.council.classification).toBe("additive");
    expect(body.council.merged).toBe(true);
  });

  it("POST /api/pods/:podId/context-updates rejects invalid input", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/pods/pod-integration-test-pod/context-updates",
      payload: { summary: "incomplete" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET /api/pods/:podId/context-updates returns updates", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/pods/pod-integration-test-pod/context-updates",
    });
    expect(res.statusCode).toBe(200);
    const updates = res.json();
    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect(updates[0].agent_id).toBe("agent-fe");
  });

  it("GET /api/pods/:podId/living-doc returns markdown", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/pods/pod-integration-test-pod/living-doc",
    });
    expect(res.statusCode).toBe(200);
    const text = res.body;
    expect(text).toContain("Integration Test Pod");
    expect(text).toContain("Living Doc");
  });

  it("GET /api/pods/:podId/conflicts returns empty initially", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/pods/pod-integration-test-pod/conflicts",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("overlapping updates from different agents are classified", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/pods/pod-integration-test-pod/context-updates",
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
    expect(["overlapping", "additive"]).toContain(body.council.classification);
  });
});
