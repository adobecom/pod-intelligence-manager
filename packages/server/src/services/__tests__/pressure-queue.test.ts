import { describe, it, expect, vi, beforeEach } from "vitest";

const { testDb } = vi.hoisted(() => {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  return { testDb: db };
});

vi.mock("../../db/connection.js", () => ({
  default: testDb,
}));

vi.mock("../ingestion.js", () => ({
  ingestContextUpdate: vi.fn().mockResolvedValue({
    success: true,
    update: { id: "cu-1" },
    pim: { classification: "additive", merged: true, conflictCreated: false },
  }),
}));

import { createTables } from "../../db/schema.js";
import { enqueueUpdate, drainQueue, getQueueSize } from "../ingestion-queue.js";
import { setPodPressure } from "../pressure.js";
import { ingestContextUpdate } from "../ingestion.js";

describe("ingestion queue at critical pressure", () => {
  const orgId = "org_demo";
  const podId = "pod-queue-test";

  beforeEach(() => {
    createTables();
    testDb.prepare("DELETE FROM ingestion_queue").run();
    testDb.prepare("DELETE FROM pods WHERE pod_id = ?").run(podId);
    testDb.prepare(
      `INSERT OR IGNORE INTO users (user_id, ims_user_id, email, created_at) VALUES ('u1', 'ims-u1', 't@test.com', '2026-01-01')`,
    ).run();
    testDb.prepare(
      `INSERT OR IGNORE INTO orgs (org_id, slug, name, created_by_user_id, created_at) VALUES (?, 'demo', 'Demo', 'u1', '2026-01-01')`,
    ).run(orgId);
    testDb.prepare(
      `INSERT OR REPLACE INTO pods (pod_id, name, sprint_start, sprint_end, day_number, total_days, conflict_pressure, milestone_json, org_id, created_by_user_id)
       VALUES (?, 'Q', '2026-01-01', '2026-01-05', 1, 5, 0.9, '{}', ?, 'u1')`,
    ).run(podId, orgId);
    testDb.prepare(
      `INSERT OR REPLACE INTO org_pod_summaries (pod_id, name, day_number, total_days, conflict_pressure, open_conflicts, active_tunnels, agent_count, org_id)
       VALUES (?, 'Q', 1, 5, 0.9, 0, 0, 0, ?)`,
    ).run(podId, orgId);
    vi.clearAllMocks();
  });

  it("enqueues and reports queue size", () => {
    enqueueUpdate(podId, orgId, {
      agent_id: "a1",
      type: "progress",
      scope: "backend",
      summary: "s",
      details: "d",
      status: "completed",
    });
    expect(getQueueSize(podId)).toBe(1);
  });

  it("drainQueue processes pending items when pressure is low", async () => {
    enqueueUpdate(podId, orgId, {
      agent_id: "a1",
      type: "progress",
      scope: "backend",
      summary: "Queued work",
      details: "",
      status: "completed",
    });
    setPodPressure(podId, 0.4);
    const result = await drainQueue(podId);
    expect(result.processed).toBe(1);
    expect(getQueueSize(podId)).toBe(0);
    expect(ingestContextUpdate).toHaveBeenCalledWith(podId, expect.objectContaining({ summary: "Queued work" }));
  });
});
