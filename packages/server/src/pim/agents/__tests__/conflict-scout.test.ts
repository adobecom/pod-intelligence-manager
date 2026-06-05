import type { Mock } from "vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ContextUpdate } from "@pim/shared";

vi.mock("../../../db/connection.js", () => ({
  default: {
    prepare: vi.fn(),
  },
}));

vi.mock("../../llm.js", () => ({
  isLLMAvailable: vi.fn(),
  callLLMJSON: vi.fn(),
  MODELS: { fast: "haiku-model" },
}));

import db from "../../../db/connection.js";
import { isLLMAvailable, callLLMJSON } from "../../llm.js";
import {
  hasCrossAgentPeerInScoutWindow,
  shouldRunConflictScout,
  runConflictScout,
  scoutSaysOpenConflict,
  scoutSuppressesMergeEscalate,
  ADDITIVE_SCOUT_CONFLICT_MIN_CONF,
} from "../conflict-scout.js";

function makeUpdate(over: Partial<ContextUpdate> = {}): ContextUpdate {
  return {
    id: "ctx-new",
    agent_id: "agent-a",
    timestamp: "2026-01-01T00:00:00Z",
    pod_id: "pod-1",
    type: "progress",
    scope: "frontend",
    summary: "Working on checkout",
    details: "Details here",
    artifacts: [],
    status: "in_progress",
    blocks: [],
    blocked_by: [],
    needs_input_from: [],
    ...over,
  };
}

describe("conflict-scout gates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isLLMAvailable).mockReturnValue(true);
  });

  it("shouldRunConflictScout is false for contradictory", () => {
    expect(shouldRunConflictScout("contradictory", makeUpdate())).toBe(false);
  });

  it("shouldRunConflictScout is true for overlapping when Bedrock on", () => {
    expect(shouldRunConflictScout("overlapping", makeUpdate())).toBe(true);
  });

  it("shouldRunConflictScout is false for additive when Bedrock off", () => {
    vi.mocked(isLLMAvailable).mockReturnValue(false);
    expect(shouldRunConflictScout("additive", makeUpdate())).toBe(false);
  });

  it("hasCrossAgentPeerInScoutWindow detects other agent in window", () => {
    const rows = [{ agent_id: "agent-a" }, { agent_id: "agent-b" }];
    (db.prepare as Mock).mockReturnValue({
      all: vi.fn().mockReturnValue(rows),
    });
    expect(hasCrossAgentPeerInScoutWindow(makeUpdate())).toBe(true);
  });

  it("hasCrossAgentPeerInScoutWindow is false when only self in window", () => {
    const rows = [{ agent_id: "agent-a" }, { agent_id: "agent-a" }];
    (db.prepare as Mock).mockReturnValue({
      all: vi.fn().mockReturnValue(rows),
    });
    expect(hasCrossAgentPeerInScoutWindow(makeUpdate())).toBe(false);
  });
});

describe("runConflictScout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isLLMAvailable).mockReturnValue(true);
  });

  it("returns normalized LLM response", async () => {
    const peers = [
      {
        id: "ctx-old",
        agent_id: "agent-b",
        type: "progress",
        summary: "Other work",
        details: "Peer details",
        timestamp: "2025-12-31T00:00:00Z",
      },
    ];
    (db.prepare as Mock).mockImplementation((sql: string) => {
      if (sql.includes("SELECT id, agent_id")) {
        return { all: vi.fn().mockReturnValue(peers) };
      }
      if (sql.includes("SELECT name, conflict_pressure")) {
        return { get: vi.fn().mockReturnValue({ name: "Pod", conflict_pressure: 0.1 }) };
      }
      return { all: vi.fn().mockReturnValue([]), get: vi.fn() };
    });
    vi.mocked(callLLMJSON).mockResolvedValue({
      recommendation: "coordination",
      confidence: 0.8,
      rationale: "Overlapping area.",
    });

    const out = await runConflictScout(makeUpdate(), "additive");
    expect(out?.recommendation).toBe("coordination");
    expect(out?.confidence).toBe(0.8);
  });

  it("returns null on LLM failure", async () => {
    (db.prepare as Mock).mockImplementation(() => ({
      all: vi.fn().mockReturnValue([]),
      get: vi.fn().mockReturnValue({ name: "P", conflict_pressure: 0 }),
    }));
    vi.mocked(callLLMJSON).mockRejectedValue(new Error("timeout"));
    const out = await runConflictScout(makeUpdate(), "overlapping");
    expect(out).toBeNull();
  });
});

describe("scoutSaysOpenConflict / scoutSuppressesMergeEscalate", () => {
  it("scoutSaysOpenConflict respects threshold", () => {
    expect(
      scoutSaysOpenConflict(
        { recommendation: "open_conflict", confidence: 0.64, rationale: "" },
        ADDITIVE_SCOUT_CONFLICT_MIN_CONF,
      ),
    ).toBe(false);
    expect(
      scoutSaysOpenConflict(
        { recommendation: "open_conflict", confidence: 0.66, rationale: "" },
        ADDITIVE_SCOUT_CONFLICT_MIN_CONF,
      ),
    ).toBe(true);
  });

  it("scoutSuppressesMergeEscalate when none + high confidence", () => {
    expect(
      scoutSuppressesMergeEscalate({
        recommendation: "none",
        confidence: 0.7,
        rationale: "",
      }),
    ).toBe(true);
  });
});
