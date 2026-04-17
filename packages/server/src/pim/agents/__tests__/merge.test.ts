import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../db/connection.js", () => ({
  default: {
    prepare: vi.fn().mockReturnValue({
      all: vi.fn().mockReturnValue([]),
      get: vi.fn().mockReturnValue({ conflict_pressure: 0 }),
    }),
  },
}));

vi.mock("../../llm.js", () => ({
  isLLMAvailable: vi.fn().mockReturnValue(false),
  callLLMJSON: vi.fn(),
  MODELS: { fast: "claude-haiku", smart: "claude-sonnet" },
}));

vi.mock("fs", () => ({
  readFileSync: vi.fn().mockReturnValue("You are a merge agent."),
  default: { readFileSync: vi.fn().mockReturnValue("You are a merge agent.") },
}));

import { deterministicMerge, llmMerge } from "../merge.js";
import { isLLMAvailable, callLLMJSON } from "../../llm.js";
import type { ContextUpdate } from "@pim/shared";

function makeUpdate(overrides: Partial<ContextUpdate> = {}): ContextUpdate {
  return {
    id: "ctx-001",
    agent_id: "agent-fe",
    timestamp: new Date().toISOString(),
    pod_id: "pod-1",
    type: "progress",
    scope: "frontend",
    summary: "Implemented form",
    details: "Added validation",
    artifacts: [],
    status: "in_progress",
    quality_score: 0.7,
    blocks: [],
    blocked_by: [],
    needs_input_from: [],
    ...overrides,
  };
}

describe("deterministicMerge", () => {
  it("returns merged:true with no note for additive", () => {
    const result = deterministicMerge(makeUpdate(), "additive");
    expect(result.merged).toBe(true);
    expect(result.note).toBeUndefined();
  });

  it("returns merged:true with a note for overlapping", () => {
    const result = deterministicMerge(makeUpdate(), "overlapping");
    expect(result.merged).toBe(true);
    expect(result.note).toBeDefined();
    expect(result.note).toContain("overlaps");
  });
});

describe("llmMerge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("falls back to deterministic when LLM is unavailable", async () => {
    vi.mocked(isLLMAvailable).mockReturnValue(false);
    const result = await llmMerge(makeUpdate());
    expect(result.merged).toBe(true);
    expect(result.note).toContain("overlaps");
    expect(callLLMJSON).not.toHaveBeenCalled();
  });

  it("returns merged:true for LLM auto_merge decision", async () => {
    vi.mocked(isLLMAvailable).mockReturnValue(true);
    vi.mocked(callLLMJSON).mockResolvedValue({
      decision: "auto_merge",
      reasoning: "No conflicts",
      note: null,
      conflict_indicators: [],
    });

    const result = await llmMerge(makeUpdate());
    expect(result.merged).toBe(true);
    expect(result.escalate).toBeUndefined();
  });

  it("returns note for LLM merge_with_note decision", async () => {
    vi.mocked(isLLMAvailable).mockReturnValue(true);
    vi.mocked(callLLMJSON).mockResolvedValue({
      decision: "merge_with_note",
      reasoning: "Minor overlap detected",
      note: "Check with backend team",
      conflict_indicators: [],
    });

    const result = await llmMerge(makeUpdate());
    expect(result.merged).toBe(true);
    expect(result.note).toBe("Check with backend team");
  });

  it("sets escalate flag for LLM escalate_conflict decision", async () => {
    vi.mocked(isLLMAvailable).mockReturnValue(true);
    vi.mocked(callLLMJSON).mockResolvedValue({
      decision: "escalate_conflict",
      reasoning: "Contradictory API contracts",
      note: null,
      conflict_indicators: ["API endpoint mismatch"],
    });

    const result = await llmMerge(makeUpdate());
    expect(result.merged).toBe(true);
    expect(result.escalate).toBe(true);
    expect(result.conflictIndicators).toEqual(["API endpoint mismatch"]);
  });

  it("falls back to deterministic when LLM call throws", async () => {
    vi.mocked(isLLMAvailable).mockReturnValue(true);
    vi.mocked(callLLMJSON).mockRejectedValue(new Error("API timeout"));

    const result = await llmMerge(makeUpdate());
    expect(result.merged).toBe(true);
    expect(result.note).toContain("overlaps");
  });

  it("falls back to deterministic when LLM returns null", async () => {
    vi.mocked(isLLMAvailable).mockReturnValue(true);
    vi.mocked(callLLMJSON).mockResolvedValue(null);

    const result = await llmMerge(makeUpdate());
    expect(result.merged).toBe(true);
    expect(result.note).toContain("overlaps");
  });
});
