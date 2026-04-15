import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("../../db/connection.js", () => ({
  default: {
    prepare: vi.fn(),
  },
}));

import { classifyUpdate } from "../classifier.js";
import db from "../../db/connection.js";
import type { ContextUpdate } from "@council/shared";

function makeUpdate(overrides: Partial<ContextUpdate> = {}): ContextUpdate {
  return {
    id: "ctx-001",
    agent_id: "agent-fe",
    timestamp: new Date().toISOString(),
    pod_id: "pod-1",
    type: "progress",
    scope: "frontend",
    summary: "Implemented checkout form validation",
    details: "Added Zod schemas for client-side validation",
    artifacts: [],
    status: "in_progress",
    quality_score: 0.7,
    blocks: [],
    blocked_by: [],
    needs_input_from: [],
    ...overrides,
  };
}

// Three db.prepare calls in order: (1) open conflicts, (2) recent updates, (3) pod
function setupDb(opts: {
  conflicts?: any[];
  recentUpdates?: any[];
  pod?: any;
}) {
  const alls = [opts.conflicts ?? [], opts.recentUpdates ?? []];
  let allIdx = 0;

  (db.prepare as Mock).mockImplementation(() => ({
    all: vi.fn().mockImplementation(() => alls[allIdx++]),
    get: vi.fn().mockReturnValue(opts.pod ?? { conflict_pressure: 0 }),
  }));
}

describe("classifyUpdate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 'additive' when no conflicts, no overlaps, low pressure", () => {
    setupDb({ conflicts: [], recentUpdates: [], pod: { conflict_pressure: 0 } });
    expect(classifyUpdate(makeUpdate())).toBe("additive");
  });

  it("returns 'contradictory' when the agent is part of an open conflict", () => {
    setupDb({
      conflicts: [
        { sides_json: JSON.stringify([{ contributor: "agent-fe" }, { contributor: "agent-be" }]) },
      ],
      recentUpdates: [],
      pod: { conflict_pressure: 0.2 },
    });

    expect(classifyUpdate(makeUpdate({ agent_id: "agent-fe" }))).toBe("contradictory");
  });

  it("returns 'additive' when agent is NOT in any open conflict", () => {
    setupDb({
      conflicts: [
        { sides_json: JSON.stringify([{ contributor: "agent-be" }, { contributor: "agent-qa" }]) },
      ],
      recentUpdates: [],
      pod: { conflict_pressure: 0 },
    });

    expect(classifyUpdate(makeUpdate({ agent_id: "agent-fe" }))).toBe("additive");
  });

  it("returns 'overlapping' when 3+ keywords overlap with recent updates", () => {
    setupDb({
      conflicts: [],
      recentUpdates: [
        {
          id: "ctx-old",
          agent_id: "agent-be",
          scope: "frontend",
          summary: "checkout form validation schema zod",
        },
      ],
      pod: { conflict_pressure: 0 },
    });

    expect(classifyUpdate(makeUpdate({
      summary: "Updated checkout form validation with zod schema",
      details: "",
    }))).toBe("overlapping");
  });

  it("returns 'additive' when keyword overlap is below threshold (< 3)", () => {
    setupDb({
      conflicts: [],
      recentUpdates: [
        {
          id: "ctx-old",
          agent_id: "agent-be",
          scope: "frontend",
          summary: "database migration setup",
        },
      ],
      pod: { conflict_pressure: 0 },
    });

    expect(classifyUpdate(makeUpdate({
      summary: "Implemented checkout form",
      details: "form layout",
    }))).toBe("additive");
  });

  it("returns 'overlapping' when conflict pressure exceeds 0.6", () => {
    setupDb({
      conflicts: [],
      recentUpdates: [],
      pod: { conflict_pressure: 0.7 },
    });

    expect(classifyUpdate(makeUpdate())).toBe("overlapping");
  });

  it("checks multiple conflicts for agent involvement", () => {
    setupDb({
      conflicts: [
        { sides_json: JSON.stringify([{ contributor: "agent-qa" }, { contributor: "agent-be" }]) },
        { sides_json: JSON.stringify([{ contributor: "agent-fe" }, { contributor: "agent-design" }]) },
      ],
      recentUpdates: [],
      pod: { conflict_pressure: 0 },
    });

    expect(classifyUpdate(makeUpdate({ agent_id: "agent-fe" }))).toBe("contradictory");
  });

  it("returns 'additive' at pressure exactly 0.6 (threshold is >0.6)", () => {
    setupDb({
      conflicts: [],
      recentUpdates: [],
      pod: { conflict_pressure: 0.6 },
    });

    expect(classifyUpdate(makeUpdate())).toBe("additive");
  });
});
