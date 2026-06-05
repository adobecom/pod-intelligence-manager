import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import type { ContextUpdate } from "@pim/shared";

const { testDb } = vi.hoisted(() => {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  return { testDb: db };
});

vi.mock("../../db/connection.js", () => ({
  default: testDb,
}));

vi.mock("../classifier.js", () => ({
  classifyUpdate: vi.fn(),
}));

vi.mock("../agents/conflict-scout.js", () => ({
  shouldRunConflictScout: vi.fn(),
  runConflictScout: vi.fn(),
  scoutSaysOpenConflict: vi.fn(),
  scoutSuppressesMergeEscalate: vi.fn(),
  ADDITIVE_SCOUT_CONFLICT_MIN_CONF: 0.65,
  OVERLAP_SCOUT_FORCE_CONFLICT_MIN_CONF: 0.65,
}));

vi.mock("../agents/merge.js", () => ({
  deterministicMerge: vi.fn(),
  llmMerge: vi.fn(),
}));

vi.mock("../agents/conflict.js", () => ({
  createConflict: vi.fn(),
}));

vi.mock("../agents/summary.js", () => ({
  regenerateLivingDoc: vi.fn(),
}));

vi.mock("../agents/cross-pod.js", () => ({
  detectOverlaps: vi.fn(),
}));

vi.mock("../llm.js", () => ({
  isLLMAvailable: vi.fn(() => true),
}));

import { classifyUpdate } from "../classifier.js";
import {
  shouldRunConflictScout,
  runConflictScout,
  scoutSaysOpenConflict,
  scoutSuppressesMergeEscalate,
} from "../agents/conflict-scout.js";
import { deterministicMerge, llmMerge } from "../agents/merge.js";
import { createConflict } from "../agents/conflict.js";
import { regenerateLivingDoc } from "../agents/summary.js";
import { detectOverlaps } from "../agents/cross-pod.js";
import { isLLMAvailable } from "../llm.js";
import { createTables } from "../../db/schema.js";
import { processUpdate } from "../master.js";

const baseUpdate = (): ContextUpdate => ({
  id: "ctx-1",
  agent_id: "a1",
  timestamp: "2026-01-01T00:00:00Z",
  pod_id: "p1",
  type: "progress",
  scope: "frontend",
  summary: "S",
  details: "D",
  artifacts: [],
  status: "in_progress",
  blocks: [],
  blocked_by: [],
  needs_input_from: [],
});

describe("processUpdate + conflict scout", () => {
  beforeAll(() => {
    createTables();
  });

  afterAll(() => {
    testDb.close();
  });

  beforeEach(() => {
    testDb.prepare("DELETE FROM conflicts").run();
    testDb.prepare("DELETE FROM pods WHERE pod_id = ?").run("p1");
    testDb
      .prepare(
        `INSERT INTO pods (pod_id, name, sprint_start, sprint_end, day_number, total_days, conflict_pressure, milestone_json)
         VALUES (?, 'Test Pod', '2026-01-01', '2026-01-05', 1, 5, 0.0, ?)`,
      )
      .run("p1", JSON.stringify({ name: "Test Milestone" }));
    vi.clearAllMocks();
    vi.mocked(shouldRunConflictScout).mockReturnValue(false);
    vi.mocked(runConflictScout).mockResolvedValue(null);
    vi.mocked(scoutSaysOpenConflict).mockReturnValue(false);
    vi.mocked(scoutSuppressesMergeEscalate).mockReturnValue(false);
    vi.mocked(deterministicMerge).mockReturnValue({ merged: true });
    vi.mocked(llmMerge).mockResolvedValue({ merged: true });
    vi.mocked(createConflict).mockResolvedValue(null);
    vi.mocked(regenerateLivingDoc).mockResolvedValue("");
    vi.mocked(detectOverlaps).mockResolvedValue(undefined);
    vi.mocked(isLLMAvailable).mockReturnValue(true);
  });

  it("overlapping + scout forces conflict skips llmMerge", async () => {
    vi.mocked(classifyUpdate).mockReturnValue("overlapping");
    vi.mocked(shouldRunConflictScout).mockReturnValue(true);
    vi.mocked(runConflictScout).mockResolvedValue({
      recommendation: "open_conflict",
      confidence: 0.9,
      rationale: "scout says conflict",
    });
    vi.mocked(scoutSaysOpenConflict).mockImplementation((_scout, _min) => true);
    vi.mocked(createConflict).mockResolvedValue({
      id: "C-ABC1",
      pod_id: "p1",
      created_at: "2026-01-01T00:00:00Z",
      status: "open",
      severity: "non_blocking",
      summary: "x",
      sides: [],
      master_analysis: "",
      impact: [],
      resolved_by: null,
      resolution: null,
      resolution_date: null,
    });

    const r = await processUpdate(baseUpdate());
    expect(r.conflictCreated).toBe(true);
    expect(r.conflictId).toBe("C-ABC1");
    expect(r.scout_used).toBe(true);
    expect(r.scout_recommendation).toBe("open_conflict");
    expect(llmMerge).not.toHaveBeenCalled();
  });

  it("overlapping merge escalate suppressed when scout says none", async () => {
    vi.mocked(classifyUpdate).mockReturnValue("overlapping");
    vi.mocked(shouldRunConflictScout).mockReturnValue(true);
    vi.mocked(runConflictScout).mockResolvedValue({
      recommendation: "none",
      confidence: 0.9,
      rationale: "Fine",
    });
    vi.mocked(scoutSaysOpenConflict).mockReturnValue(false);
    vi.mocked(scoutSuppressesMergeEscalate).mockReturnValue(true);
    vi.mocked(llmMerge).mockResolvedValue({
      merged: true,
      escalate: true,
    });

    const r = await processUpdate(baseUpdate());
    expect(r.conflictCreated).toBe(false);
    expect(llmMerge).toHaveBeenCalled();
  });

  it("overlapping fallback escalates and reports degraded when LLM is unavailable", async () => {
    vi.mocked(classifyUpdate).mockReturnValue("overlapping");
    vi.mocked(isLLMAvailable).mockReturnValue(false);
    vi.mocked(deterministicMerge).mockReturnValue({
      merged: true,
      note: "Fallback overlap merge",
    });
    vi.mocked(createConflict).mockResolvedValue({
      id: "C-FALLBACK",
      pod_id: "p1",
      created_at: "2026-01-01T00:00:00Z",
      status: "open",
      severity: "non_blocking",
      summary: "fallback conflict",
      sides: [],
      master_analysis: "",
      impact: [],
      resolved_by: null,
      resolution: null,
      resolution_date: null,
    });

    const r = await processUpdate(baseUpdate());

    expect(llmMerge).not.toHaveBeenCalled();
    expect(r.conflictCreated).toBe(true);
    expect(r.conflictId).toBe("C-FALLBACK");
    expect(r.degraded).toBe(true);
    expect(r.error).toContain("LLM merge unavailable");
  });

  it("runs cross-pod overlap detection fire-and-forget", async () => {
    vi.mocked(classifyUpdate).mockReturnValue("additive");
    vi.mocked(detectOverlaps).mockReturnValue(new Promise<void>(() => {}));

    const outcome = await Promise.race([
      processUpdate(baseUpdate()).then(() => "resolved"),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 20)),
    ]);

    expect(outcome).toBe("resolved");
    expect(detectOverlaps).toHaveBeenCalled();
  });

  it("runs living doc regeneration fire-and-forget", async () => {
    vi.mocked(classifyUpdate).mockReturnValue("additive");
    vi.mocked(regenerateLivingDoc).mockReturnValue(new Promise<string>(() => {}));

    const outcome = await Promise.race([
      processUpdate(baseUpdate()).then(() => "resolved"),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 20)),
    ]);

    expect(outcome).toBe("resolved");
    expect(regenerateLivingDoc).toHaveBeenCalledWith("p1");
  });

  it("additive + scout open_conflict creates conflict", async () => {
    vi.mocked(classifyUpdate).mockReturnValue("additive");
    vi.mocked(shouldRunConflictScout).mockReturnValue(true);
    vi.mocked(runConflictScout).mockResolvedValue({
      recommendation: "open_conflict",
      confidence: 0.7,
      rationale: "Contradiction",
    });
    vi.mocked(scoutSaysOpenConflict).mockImplementation((scout) => {
      return scout?.recommendation === "open_conflict" && (scout.confidence ?? 0) >= 0.65;
    });
    vi.mocked(createConflict).mockResolvedValue({
      id: "C-XYZ",
      pod_id: "p1",
      created_at: "2026-01-01T00:00:00Z",
      status: "open",
      severity: "non_blocking",
      summary: "y",
      sides: [],
      master_analysis: "",
      impact: [],
      resolved_by: null,
      resolution: null,
      resolution_date: null,
    });

    const r = await processUpdate(baseUpdate());
    expect(r.conflictCreated).toBe(true);
    expect(r.conflictId).toBe("C-XYZ");
  });
});
