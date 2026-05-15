import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("../../db/connection.js", () => ({
  default: {
    prepare: vi.fn(),
  },
}));

vi.mock("../../ws/index.js", () => ({
  broadcast: vi.fn(),
}));

vi.mock("../secret-scan.js", () => ({
  scanForSecrets: vi.fn(),
}));

vi.mock("../quality-scoring.js", () => ({
  scoreUpdate: vi.fn(),
}));

vi.mock("../../pim/master.js", () => ({
  processUpdate: vi.fn(),
}));

vi.mock("../pod-snapshot.js", () => ({
  refreshPodSnapshotFromContext: vi.fn(),
}));

vi.mock("../async-quality-score.js", () => ({
  scheduleAsyncQualityScore: vi.fn(),
}));

vi.mock("../org-settings.js", () => ({
  getOrgScopeIds: vi.fn().mockReturnValue(new Set(["frontend", "backend", "design", "qa", "infra", "pm"])),
}));

vi.mock("../orgs.js", () => ({
  getOrgIdForPod: vi.fn().mockReturnValue("org_demo"),
}));

import { ingestContextUpdate } from "../ingestion.js";
import { refreshPodSnapshotFromContext } from "../pod-snapshot.js";
import db from "../../db/connection.js";
import { broadcast } from "../../ws/index.js";
import { scanForSecrets } from "../secret-scan.js";
import { scoreUpdate } from "../quality-scoring.js";
import { processUpdate } from "../../pim/master.js";
import { getOrgIdForPod } from "../orgs.js";

function validInput() {
  return {
    agent_id: "agent-fe",
    type: "progress",
    scope: "frontend",
    summary: "Implemented checkout form",
    details: "Added validation with Zod",
    artifacts: [],
    status: "in_progress",
    blocks: [],
    blocked_by: [],
    needs_input_from: [],
  };
}

function setupDefaultMocks() {
  (db.prepare as Mock).mockImplementation((sql: string) => {
    if (sql.includes("SELECT")) {
      return { get: vi.fn().mockReturnValue({ pod_id: "pod-1" }), all: vi.fn().mockReturnValue([]) };
    }
    return { run: vi.fn() };
  });

  vi.mocked(scanForSecrets).mockReturnValue({ clean: true, findings: [] });

  vi.mocked(scoreUpdate).mockReturnValue({
    completeness: 0.2,
    specificity: 0.2,
    relationships: 0.1,
    contextual_fit: 0.15,
    total: 0.65,
  });

  vi.mocked(processUpdate).mockResolvedValue({
    classification: "additive",
    merged: true,
    conflictCreated: false,
  });

  vi.mocked(getOrgIdForPod).mockReturnValue("org_demo");
}

describe("ingestContextUpdate", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setupDefaultMocks();
  });

  it("succeeds with valid input", async () => {
    const result = await ingestContextUpdate("pod-1", validInput());
    expect(result.success).toBe(true);
    expect(result.update).toBeDefined();
    expect(result.update!.agent_id).toBe("agent-fe");
  });

  it("generates an id starting with ctx-", async () => {
    const result = await ingestContextUpdate("pod-1", validInput());
    expect(result.update!.id).toMatch(/^ctx-/);
  });

  it("attaches quality score from scoreUpdate", async () => {
    const result = await ingestContextUpdate("pod-1", validInput());
    expect(scoreUpdate).toHaveBeenCalled();
    expect(result.update!.quality_score).toBe(0.65);
  });

  it("fails validation when agent_id is missing", async () => {
    const input = { ...validInput(), agent_id: "" };
    const result = await ingestContextUpdate("pod-1", input);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Validation failed");
  });

  it("fails validation when required fields are missing", async () => {
    const result = await ingestContextUpdate("pod-1", { summary: "hello" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Validation failed");
  });

  it("fails when pod does not exist", async () => {
    (db.prepare as Mock).mockImplementation(() => ({
      get: vi.fn().mockReturnValue(undefined),
      all: vi.fn().mockReturnValue([]),
      run: vi.fn(),
    }));

    const result = await ingestContextUpdate("pod-missing", validInput());
    expect(result.success).toBe(false);
    expect(result.error).toContain("Pod not found");
  });

  it("rejects updates containing secrets", async () => {
    vi.mocked(scanForSecrets).mockReturnValue({
      clean: false,
      findings: ["AWS access key detected"],
    });

    const result = await ingestContextUpdate("pod-1", validInput());
    expect(result.success).toBe(false);
    expect(result.error).toContain("secrets detected");
    expect(result.secretFindings).toEqual(["AWS access key detected"]);
  });

  it("broadcasts context_update_added via WebSocket", async () => {
    await ingestContextUpdate("pod-1", validInput());
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "context_update_added",
        podId: "pod-1",
      }),
    );
  });

  it("calls refreshPodSnapshotFromContext after insert", async () => {
    await ingestContextUpdate("pod-1", validInput());
    expect(refreshPodSnapshotFromContext).toHaveBeenCalledWith("pod-1");
  });

  it("calls processUpdate and returns pim result", async () => {
    const result = await ingestContextUpdate("pod-1", validInput());
    expect(processUpdate).toHaveBeenCalled();
    expect(result.pim).toEqual({
      classification: "additive",
      merged: true,
      conflictCreated: false,
    });
  });

  it("writes the update to the database", async () => {
    const runMock = vi.fn();
    (db.prepare as Mock).mockImplementation((sql: string) => {
      if (sql.includes("SELECT")) {
        return { get: vi.fn().mockReturnValue({ pod_id: "pod-1" }), all: vi.fn().mockReturnValue([]) };
      }
      return { run: runMock };
    });

    await ingestContextUpdate("pod-1", validInput());
    expect(runMock).toHaveBeenCalled();
    const args = runMock.mock.calls[0];
    expect(args[0]).toMatch(/^ctx-/); // id
    expect(args[1]).toBe("agent-fe"); // agent_id
  });
});

describe("ingestContextUpdate — PIM_ASYNC_ORCHESTRATION mode", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setupDefaultMocks();
    process.env.PIM_ASYNC_ORCHESTRATION = "true";
  });

  afterEach(() => {
    delete process.env.PIM_ASYNC_ORCHESTRATION;
  });

  it("returns pim_queued=true and does not await processUpdate", async () => {
    // Hold processUpdate open: if the handler awaits it, the test will hang.
    let resolveProcess: () => void = () => {};
    vi.mocked(processUpdate).mockImplementation(
      () => new Promise((resolve) => {
        resolveProcess = () => resolve({
          classification: "additive",
          merged: true,
          conflictCreated: false,
        });
      }),
    );

    const result = await ingestContextUpdate("pod-1", validInput());
    expect(result.success).toBe(true);
    expect(result.pim_queued).toBe(true);
    expect(result.pim).toBeUndefined();
    resolveProcess();
  });

  it("broadcasts pim_processed once the async job completes", async () => {
    vi.mocked(processUpdate).mockResolvedValue({
      classification: "overlapping",
      merged: true,
      conflictCreated: false,
    });

    await ingestContextUpdate("pod-1", validInput());
    // Allow the setImmediate callback to run.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "pim_processed", podId: "pod-1" }),
    );
  });
});
