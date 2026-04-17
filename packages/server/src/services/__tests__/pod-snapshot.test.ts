import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const { testDb } = vi.hoisted(() => {
  const Database = require("better-sqlite3");
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  return { testDb: db };
});

vi.mock("../../db/connection.js", () => ({ default: testDb }));

import { createTables } from "../../db/schema.js";
import {
  refreshPodSnapshotFromContext,
  workStatusToAreaStatus,
  resolveAreaStatus,
  POD_SCOPES,
} from "../pod-snapshot.js";

function seedPod(podId: string): void {
  const milestone = JSON.stringify({ name: "Sprint Goal", target_date: "2026-04-20", percent_complete: 0 });
  testDb
    .prepare(
      `INSERT INTO pods (pod_id, name, sprint_start, sprint_end, day_number, total_days, conflict_pressure, milestone_json)
       VALUES (?, 'Test Pod', '2026-04-15', '2026-04-20', 1, 5, 0.0, ?)`,
    )
    .run(podId, milestone);
  const ins = testDb.prepare(
    "INSERT INTO pod_areas (pod_id, scope, owner, status) VALUES (?, ?, 'unassigned', 'waiting')",
  );
  for (const s of POD_SCOPES) {
    ins.run(podId, s);
  }
  testDb
    .prepare(
      `INSERT INTO org_pod_summaries (pod_id, name, day_number, total_days, conflict_pressure, open_conflicts, active_tunnels, agent_count)
       VALUES (?, 'Test Pod', 1, 5, 0.0, 0, 0, 0)`,
    )
    .run(podId);
}

function insertUpdate(
  podId: string,
  opts: { id: string; scope: string; agent_id: string; type: string; status: string; timestamp: string },
): void {
  testDb
    .prepare(
      `INSERT INTO context_updates (id, agent_id, timestamp, pod_id, type, scope, summary, details, artifacts_json, status, quality_score, blocks_json, blocked_by_json, needs_input_from_json, source)
       VALUES (?, ?, ?, ?, ?, ?, 's', 'd', '[]', ?, 0.5, '[]', '[]', '[]', 'manual')`,
    )
    .run(opts.id, opts.agent_id, opts.timestamp, podId, opts.type, opts.scope, opts.status);
}

describe("pod-snapshot helpers", () => {
  it("maps work status to area status", () => {
    expect(workStatusToAreaStatus("completed")).toBe("done");
    expect(workStatusToAreaStatus("in_progress")).toBe("in_progress");
    expect(workStatusToAreaStatus("blocked")).toBe("blocked");
  });

  it("blocker type forces blocked", () => {
    expect(resolveAreaStatus("blocker", "completed")).toBe("blocked");
    expect(resolveAreaStatus("progress", "completed")).toBe("done");
  });
});

describe("refreshPodSnapshotFromContext", () => {
  beforeAll(() => {
    createTables();
  });

  afterAll(() => {
    testDb.close();
  });

  it("leaves areas waiting with 0% when there are no updates", () => {
    const podId = "pod-snap-empty";
    seedPod(podId);
    refreshPodSnapshotFromContext(podId);
    const areas = testDb.prepare("SELECT scope, owner, status FROM pod_areas WHERE pod_id = ?").all(podId) as {
      scope: string;
      owner: string;
      status: string;
    }[];
    expect(areas).toHaveLength(6);
    for (const a of areas) {
      expect(a.owner).toBe("unassigned");
      expect(a.status).toBe("waiting");
    }
    const m = JSON.parse(
      (testDb.prepare("SELECT milestone_json FROM pods WHERE pod_id = ?").get(podId) as { milestone_json: string })
        .milestone_json,
    );
    expect(m.percent_complete).toBe(0);
  });

  it("uses latest update per scope and computes milestone percent from done scopes", () => {
    const podId = "pod-snap-mix";
    seedPod(podId);
    const t1 = "2026-04-16T10:00:00.000Z";
    const t2 = "2026-04-16T11:00:00.000Z";
    insertUpdate(podId, { id: "ctx-a", scope: "frontend", agent_id: "alice", type: "progress", status: "in_progress", timestamp: t1 });
    insertUpdate(podId, { id: "ctx-b", scope: "frontend", agent_id: "bob", type: "progress", status: "completed", timestamp: t2 });
    insertUpdate(podId, { id: "ctx-c", scope: "backend", agent_id: "carol", type: "progress", status: "completed", timestamp: t1 });

    refreshPodSnapshotFromContext(podId);

    const fe = testDb.prepare("SELECT owner, status, last_activity FROM pod_areas WHERE pod_id = ? AND scope = ?").get(
      podId,
      "frontend",
    ) as { owner: string; status: string; last_activity: string };
    expect(fe.owner).toBe("bob");
    expect(fe.status).toBe("done");
    expect(fe.last_activity).toBe(t2);

    const be = testDb.prepare("SELECT owner, status FROM pod_areas WHERE pod_id = ? AND scope = ?").get(podId, "backend") as {
      owner: string;
      status: string;
    };
    expect(be.owner).toBe("carol");
    expect(be.status).toBe("done");

    const m = JSON.parse(
      (testDb.prepare("SELECT milestone_json FROM pods WHERE pod_id = ?").get(podId) as { milestone_json: string })
        .milestone_json,
    );
    // 2 of 6 done ≈ 33%
    expect(m.percent_complete).toBe(33);

    const org = testDb.prepare("SELECT agent_count FROM org_pod_summaries WHERE pod_id = ?").get(podId) as {
      agent_count: number;
    };
    expect(org.agent_count).toBe(3);
  });

  it("marks 100% when all six scopes are done", () => {
    const podId = "pod-snap-all-done";
    seedPod(podId);
    const ts = "2026-04-16T12:00:00.000Z";
    let i = 0;
    for (const s of POD_SCOPES) {
      insertUpdate(podId, {
        id: `ctx-${i++}`,
        scope: s,
        agent_id: "agent-x",
        type: "progress",
        status: "completed",
        timestamp: ts,
      });
    }
    refreshPodSnapshotFromContext(podId);
    const m = JSON.parse(
      (testDb.prepare("SELECT milestone_json FROM pods WHERE pod_id = ?").get(podId) as { milestone_json: string })
        .milestone_json,
    );
    expect(m.percent_complete).toBe(100);
  });
});
