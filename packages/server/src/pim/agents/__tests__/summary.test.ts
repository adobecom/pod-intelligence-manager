import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("../../../db/connection.js", () => ({
  default: {
    prepare: vi.fn(),
  },
}));

vi.mock("../../../ws/index.js", () => ({
  broadcast: vi.fn(),
}));

vi.mock("../../../services/knowledge-graph.js", () => ({
  getRelevantLearnings: vi.fn().mockReturnValue({
    nodes: [],
    truncated: false,
    total_matching: 0,
  }),
}));

import { regenerateLivingDoc } from "../summary.js";
import db from "../../../db/connection.js";
import { broadcast } from "../../../ws/index.js";
import { getRelevantLearnings } from "../../../services/knowledge-graph.js";

const MOCK_POD = {
  pod_id: "pod-1",
  name: "Alpha Pod",
  sprint_start: "2026-04-10T00:00:00.000Z",
  sprint_end: "2026-04-15T00:00:00.000Z",
  day_number: 3,
  total_days: 5,
  conflict_pressure: 0.2,
  milestone_json: JSON.stringify({ name: "MVP Launch", target_date: "2026-04-14T00:00:00.000Z", percent_complete: 60 }),
};

const MOCK_AREAS = [
  { scope: "frontend", owner: "agent-fe", status: "active", last_activity: "2026-04-12T10:00:00.000Z" },
  { scope: "backend", owner: "agent-be", status: "active", last_activity: "2026-04-12T09:00:00.000Z" },
];

const MOCK_CONFLICTS = [
  { id: "C-0001", summary: "API contract mismatch", severity: "blocking", status: "open" },
];

const MOCK_UPDATES = [
  { agent_id: "agent-fe", timestamp: "2026-04-12T10:00:00.000Z", type: "progress", summary: "Form implemented" },
];

const MOCK_DECISIONS = [
  { agent_id: "agent-fe", timestamp: "2026-04-11T14:00:00.000Z", summary: "Use Zod for validation" },
];

const MOCK_TUNNELS = [
  { dev_name: "alice", branch: "feature/checkout", url: "https://alpha-alice.pim.adobe.com", status: "active" },
];

// The summary function calls db.prepare many times in sequence.
// We match on table names in the SQL to return the right mock data.
function setupDb(opts: {
  pod?: any;
  areas?: any[];
  conflicts?: any[];
  updates?: any[];
  decisions?: any[];
  tunnels?: any[];
}) {
  const runMock = vi.fn();

  (db.prepare as Mock).mockImplementation((sql: string) => {
    if (sql.includes("FROM pods")) {
      return { get: vi.fn().mockReturnValue("pod" in opts ? opts.pod : MOCK_POD) };
    }
    if (sql.includes("FROM pod_areas")) {
      return { all: vi.fn().mockReturnValue(opts.areas ?? MOCK_AREAS) };
    }
    if (sql.includes("FROM conflicts") && sql.includes("ORDER BY")) {
      return { all: vi.fn().mockReturnValue(opts.conflicts ?? MOCK_CONFLICTS) };
    }
    if (sql.includes("FROM context_updates") && sql.includes("type = 'decision'")) {
      return { all: vi.fn().mockReturnValue(opts.decisions ?? MOCK_DECISIONS) };
    }
    if (sql.includes("FROM context_updates")) {
      return { all: vi.fn().mockReturnValue(opts.updates ?? MOCK_UPDATES) };
    }
    if (sql.includes("FROM tunnels")) {
      return { all: vi.fn().mockReturnValue(opts.tunnels ?? MOCK_TUNNELS) };
    }
    if (sql.includes("INSERT INTO living_docs") || sql.includes("ON CONFLICT")) {
      return { run: runMock };
    }
    return { get: vi.fn().mockReturnValue(undefined), all: vi.fn().mockReturnValue([]), run: runMock };
  });

  return runMock;
}

describe("regenerateLivingDoc", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns not-found message for nonexistent pod", () => {
    setupDb({ pod: undefined });
    const md = regenerateLivingDoc("pod-missing");
    expect(md).toContain("Pod not found");
  });

  it("generates markdown with pod name as heading", () => {
    setupDb({});
    const md = regenerateLivingDoc("pod-1");
    expect(md).toContain("# Pod: Alpha Pod");
  });

  it("includes conflict pressure and sprint day", () => {
    setupDb({});
    const md = regenerateLivingDoc("pod-1");
    expect(md).toContain("0.20");
    expect(md).toContain("Day 3 of 5");
  });

  it("includes active milestone section", () => {
    setupDb({});
    const md = regenerateLivingDoc("pod-1");
    expect(md).toContain("## Active Milestone");
    expect(md).toContain("MVP Launch");
    expect(md).toContain("60%");
  });

  it("renders open conflicts with severity labels", () => {
    setupDb({});
    const md = regenerateLivingDoc("pod-1");
    expect(md).toContain("## Open Conflicts");
    expect(md).toContain("C-0001");
    expect(md).toContain("BLOCKING");
  });

  it("shows 'None' for open conflicts when all resolved", () => {
    setupDb({ conflicts: [{ id: "C-0001", summary: "old", severity: "blocking", status: "resolved" }] });
    const md = regenerateLivingDoc("pod-1");
    expect(md).toContain("None");
  });

  it("includes decisions log", () => {
    setupDb({});
    const md = regenerateLivingDoc("pod-1");
    expect(md).toContain("## Decisions Log");
    expect(md).toContain("Use Zod for validation");
  });

  it("includes context stream", () => {
    setupDb({});
    const md = regenerateLivingDoc("pod-1");
    expect(md).toContain("## Context Stream");
    expect(md).toContain("Form implemented");
  });

  it("includes active tunnels", () => {
    setupDb({});
    const md = regenerateLivingDoc("pod-1");
    expect(md).toContain("## Active Tunnels");
    expect(md).toContain("alice");
    expect(md).toContain("feature/checkout");
  });

  it("writes to living_docs table via upsert", () => {
    const runMock = setupDb({});
    regenerateLivingDoc("pod-1");
    expect(runMock).toHaveBeenCalled();
  });

  it("broadcasts living_doc_updated event", () => {
    setupDb({});
    regenerateLivingDoc("pod-1");
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "living_doc_updated", podId: "pod-1" }),
    );
  });

  it("includes knowledge context when learnings exist", () => {
    setupDb({});
    vi.mocked(getRelevantLearnings).mockReturnValue({
      nodes: [
        { id: "n1", type: "pattern", summary: "Use shared schemas", source_pod_name: "Beta Pod", confidence_score: 0.8, details: "", domain_tags: [], created_at: "", source_pod_id: "" },
      ],
      truncated: false,
      total_matching: 1,
    } as any);

    const md = regenerateLivingDoc("pod-1");
    expect(md).toContain("## Knowledge Context");
    expect(md).toContain("Use shared schemas");
  });
});
