import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

// Mock db — vi.mock is hoisted so we can't reference external variables in the factory.
// Instead, we import db after mocking and cast at test time.
vi.mock("../../../db/connection.js", () => ({
  default: {
    prepare: vi.fn(),
  },
}));

vi.mock("../../../ws/index.js", () => ({
  broadcast: vi.fn(),
}));

import { runLintPass } from "../lint.js";
import db from "../../../db/connection.js";

const NOW = Date.now();
const HOUR_MS = 1000 * 60 * 60;

function hoursAgo(h: number): string {
  return new Date(NOW - h * HOUR_MS).toISOString();
}

// Helper: set up sequential db.prepare().xxx() returns.
// Lint queries the db in a fixed order:
//   1. get() — pod lookup
//   2. all() — areas
//   3. all() — recent updates
//   4. all() — open conflicts
//   5. get() — living doc
//   6..N. get() — living_doc_views per conflict side
//   finally: run() — delete + insert findings
function setupDb(opts: {
  pod?: { pod_id: string; day_number: number } | undefined;
  areas?: any[];
  updates?: any[];
  conflicts?: any[];
  livingDoc?: any;
  viewRows?: (any | undefined)[];
}) {
  const gets = [
    opts.pod, // 1
  ];
  // Living doc comes after conflicts
  gets.push(opts.livingDoc ?? null);
  // View lookups per conflict side
  for (const v of opts.viewRows ?? []) {
    gets.push(v);
  }

  let getIdx = 0;
  const alls = [
    opts.areas ?? [],    // 2
    opts.updates ?? [],  // 3
    opts.conflicts ?? [],// 4
  ];
  let allIdx = 0;

  (db.prepare as Mock).mockImplementation(() => ({
    get: vi.fn().mockImplementation(() => gets[getIdx++]),
    all: vi.fn().mockImplementation(() => alls[allIdx++]),
    run: vi.fn(),
  }));
}

describe("runLintPass", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ now: NOW });
  });

  it("returns empty for non-existent pod", () => {
    setupDb({ pod: undefined });
    const findings = runLintPass("pod-nonexistent");
    expect(findings).toEqual([]);
  });

  it("detects staleness when an area has old updates", () => {
    setupDb({
      pod: { pod_id: "pod-test", day_number: 3 },
      areas: [{ scope: "frontend", owner: "agent-fe", status: "active", last_activity: null }],
      updates: [
        { agent_id: "agent-fe", scope: "frontend", timestamp: hoursAgo(12), summary: "old update" },
      ],
      conflicts: [],
    });

    const findings = runLintPass("pod-test");
    const stale = findings.filter(f => f.type === "staleness");
    expect(stale.length).toBe(1);
    expect(stale[0].summary).toContain("frontend");
    expect(stale[0].summary).toContain("12h");
  });

  it("detects coverage gaps for areas still waiting past day 2", () => {
    setupDb({
      pod: { pod_id: "pod-test", day_number: 3 },
      areas: [{ scope: "design", owner: "unassigned", status: "waiting", last_activity: null }],
      updates: [],
      conflicts: [],
    });

    const findings = runLintPass("pod-test");
    const gaps = findings.filter(f => f.type === "coverage_gap");
    expect(gaps.length).toBe(1);
    expect(gaps[0].summary).toContain("design");
  });

  it("detects dependency risk when multiple agents share a scope without coordination", () => {
    setupDb({
      pod: { pod_id: "pod-test", day_number: 2 },
      areas: [{ scope: "frontend", owner: "agent-fe", status: "active", last_activity: hoursAgo(1) }],
      updates: [
        { agent_id: "agent-fe", scope: "frontend", timestamp: hoursAgo(1), summary: "form work" },
        { agent_id: "agent-be", scope: "frontend", timestamp: hoursAgo(2), summary: "api layer" },
      ],
      conflicts: [],
    });

    const findings = runLintPass("pod-test");
    const deps = findings.filter(f => f.type === "dependency_risk");
    expect(deps.length).toBe(1);
    expect(deps[0].summary).toContain("2 agents");
  });

  it("detects aging unresolved conflicts", () => {
    setupDb({
      pod: { pod_id: "pod-test", day_number: 3 },
      areas: [],
      updates: [],
      conflicts: [
        {
          id: "conflict-1",
          created_at: hoursAgo(10),
          severity: "blocking",
          summary: "API contract mismatch",
          sides_json: JSON.stringify([{ contributor: "agent-fe" }, { contributor: "agent-be" }]),
        },
      ],
      livingDoc: { last_regenerated_at: hoursAgo(1), regen_count: 3 },
      viewRows: [undefined, undefined], // Neither agent viewed
    });

    const findings = runLintPass("pod-test");
    const unresolved = findings.filter(f => f.type === "unresolved_conflict");
    expect(unresolved.length).toBe(1);
    expect(unresolved[0].severity).toBe("critical");
  });

  it("detects doc_not_read for conflict agents who haven't viewed the living doc", () => {
    setupDb({
      pod: { pod_id: "pod-test", day_number: 3 },
      areas: [],
      updates: [],
      conflicts: [
        {
          id: "conflict-1",
          created_at: hoursAgo(1), // Recent — won't trigger unresolved_conflict
          severity: "normal",
          summary: "test",
          sides_json: JSON.stringify([{ contributor: "agent-fe" }, { contributor: "agent-be" }]),
        },
      ],
      livingDoc: { last_regenerated_at: hoursAgo(1), regen_count: 5 },
      viewRows: [
        { last_viewed_regen_count: 3 }, // agent-fe stale view
        undefined,                       // agent-be never viewed
      ],
    });

    const findings = runLintPass("pod-test");
    const docNotRead = findings.filter(f => f.type === "doc_not_read");
    expect(docNotRead.length).toBe(2);
    expect(docNotRead[0].summary).toContain("hasn't viewed the living doc");
  });

  it("skips doc_not_read when no living doc exists", () => {
    setupDb({
      pod: { pod_id: "pod-test", day_number: 2 },
      areas: [],
      updates: [],
      conflicts: [
        {
          id: "conflict-1",
          created_at: hoursAgo(1),
          severity: "normal",
          summary: "test",
          sides_json: JSON.stringify([{ contributor: "agent-fe" }]),
        },
      ],
      livingDoc: null,
    });

    const findings = runLintPass("pod-test");
    const docNotRead = findings.filter(f => f.type === "doc_not_read");
    expect(docNotRead.length).toBe(0);
  });
});
