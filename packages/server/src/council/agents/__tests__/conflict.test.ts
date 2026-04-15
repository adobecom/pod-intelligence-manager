import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("../../../db/connection.js", () => ({
  default: {
    prepare: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock("../../llm.js", () => ({
  isLLMAvailable: vi.fn().mockReturnValue(false),
  callLLMJSON: vi.fn(),
  MODELS: { fast: "claude-haiku", smart: "claude-sonnet" },
}));

vi.mock("../../../ws/index.js", () => ({
  broadcast: vi.fn(),
}));

vi.mock("../../../services/pressure.js", () => ({
  recalculatePressure: vi.fn().mockReturnValue(0.3),
}));

vi.mock("../../../services/knowledge-graph.js", () => ({
  getPrecedents: vi.fn().mockReturnValue({ nodes: [] }),
}));

vi.mock("../../../services/slack.js", () => ({
  notifyConflictCreated: vi.fn(),
  notifyPressureThreshold: vi.fn(),
}));

import { createConflict } from "../conflict.js";
import db from "../../../db/connection.js";
import { broadcast } from "../../../ws/index.js";
import { recalculatePressure } from "../../../services/pressure.js";
import { notifyConflictCreated, notifyPressureThreshold } from "../../../services/slack.js";
import type { ContextUpdate } from "@council/shared";

function makeUpdate(overrides: Partial<ContextUpdate> = {}): ContextUpdate {
  return {
    id: "ctx-001",
    agent_id: "agent-fe",
    timestamp: new Date().toISOString(),
    pod_id: "pod-1",
    type: "progress",
    scope: "frontend",
    summary: "Implemented checkout form",
    details: "Added Zod validation for all fields",
    artifacts: [],
    status: "in_progress",
    quality_score: 0.7,
    blocks: [],
    blocked_by: [],
    needs_input_from: [],
    ...overrides,
  };
}

function setupDb(conflicting: any | undefined) {
  const runMock = vi.fn();

  // transaction() returns a function that executes the callback
  (db.transaction as Mock).mockImplementation((fn: Function) => {
    return (...args: any[]) => fn(...args);
  });

  (db.prepare as Mock).mockImplementation((sql: string) => {
    // Find conflicting update
    if (sql.includes("SELECT") && sql.includes("context_updates")) {
      return { get: vi.fn().mockReturnValue(conflicting) };
    }
    // Get previous pressure
    if (sql.includes("SELECT") && sql.includes("conflict_pressure")) {
      return { get: vi.fn().mockReturnValue({ conflict_pressure: 0.1 }) };
    }
    // Insert conflict
    if (sql.includes("INSERT")) {
      return { run: runMock };
    }
    return { get: vi.fn().mockReturnValue(undefined), all: vi.fn().mockReturnValue([]), run: runMock };
  });

  return runMock;
}

describe("createConflict", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when no conflicting update exists", async () => {
    setupDb(undefined);
    const result = await createConflict(makeUpdate());
    expect(result).toBeNull();
  });

  it("creates a conflict with deterministic summary when LLM unavailable", async () => {
    setupDb({
      id: "ctx-002",
      agent_id: "agent-be",
      summary: "Backend API changes",
      details: "Changed REST endpoints",
      timestamp: new Date().toISOString(),
    });

    const conflict = await createConflict(makeUpdate());
    expect(conflict).not.toBeNull();
    expect(conflict!.summary).toContain("frontend");
    expect(conflict!.summary).toContain("agent-fe");
    expect(conflict!.summary).toContain("agent-be");
  });

  it("generates conflict id starting with C-", async () => {
    setupDb({
      id: "ctx-002",
      agent_id: "agent-be",
      summary: "Backend API changes",
      details: "Changed REST endpoints",
      timestamp: new Date().toISOString(),
    });

    const conflict = await createConflict(makeUpdate());
    expect(conflict!.id).toMatch(/^C-/);
    expect(conflict!.id).toHaveLength(6); // "C-" + 4 hex chars
  });

  it("has two sides with the correct contributors", async () => {
    setupDb({
      id: "ctx-002",
      agent_id: "agent-be",
      summary: "Backend work",
      details: "details",
      timestamp: new Date().toISOString(),
    });

    const conflict = await createConflict(makeUpdate());
    expect(conflict!.sides).toHaveLength(2);
    expect(conflict!.sides[0].contributor).toBe("agent-fe");
    expect(conflict!.sides[1].contributor).toBe("agent-be");
  });

  it("broadcasts conflict_created and pressure_changed events", async () => {
    setupDb({
      id: "ctx-002",
      agent_id: "agent-be",
      summary: "Backend work",
      details: "details",
      timestamp: new Date().toISOString(),
    });

    await createConflict(makeUpdate());

    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "conflict_created", podId: "pod-1" }),
    );
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "pressure_changed", podId: "pod-1" }),
    );
  });

  it("sends Slack notifications", async () => {
    setupDb({
      id: "ctx-002",
      agent_id: "agent-be",
      summary: "Backend work",
      details: "details",
      timestamp: new Date().toISOString(),
    });

    await createConflict(makeUpdate());

    expect(notifyConflictCreated).toHaveBeenCalledWith(
      expect.objectContaining({ pod_id: "pod-1" }),
    );
    expect(notifyPressureThreshold).toHaveBeenCalledWith("pod-1", 0.3, 0.1);
  });

  it("calls recalculatePressure inside the transaction", async () => {
    setupDb({
      id: "ctx-002",
      agent_id: "agent-be",
      summary: "Backend work",
      details: "details",
      timestamp: new Date().toISOString(),
    });

    await createConflict(makeUpdate());
    expect(recalculatePressure).toHaveBeenCalledWith("pod-1");
  });
});
