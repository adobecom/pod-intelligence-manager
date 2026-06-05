import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../services/knowledge-graph.js", () => ({
  getOrgPatternCandidates: vi.fn(),
}));

vi.mock("../conflict.js", () => ({
  createOrgPatternConflict: vi.fn(),
}));

vi.mock("../lint.js", () => ({
  appendLintFinding: vi.fn(),
}));

vi.mock("../../llm.js", () => ({
  isLLMAvailable: vi.fn().mockReturnValue(true),
  callLLMJSON: vi.fn(),
  MODELS: { fast: "fast" },
}));

import { getOrgPatternCandidates } from "../../../services/knowledge-graph.js";
import { createOrgPatternConflict } from "../conflict.js";
import { appendLintFinding } from "../lint.js";
import { callLLMJSON } from "../../llm.js";
import { runKgPatternScout } from "../kg-pattern-scout.js";
import type { ContextUpdate } from "@pim/shared";

const update: ContextUpdate = {
  id: "u1",
  agent_id: "agent-a",
  timestamp: new Date().toISOString(),
  pod_id: "pod-1",
  type: "decision",
  scope: "backend",
  summary: "Use Memcached for cache",
  details: "Reject Redis",
  artifacts: [],
  status: "completed",
  blocks: [],
  blocked_by: [],
  needs_input_from: [],
};

const kgNode = {
  id: "kn-redis",
  type: "decision" as const,
  summary: "Use Redis for session cache",
  details: "Org standard",
  source_pod_id: "pod-old",
  source_pod_name: "Cache Pod",
  domains: ["backend"],
  confidence: "extracted" as const,
  confidence_score: 0.9,
  created_at: new Date().toISOString(),
  curated: true,
};

describe("runKgPatternScout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns none when disabled", async () => {
    const result = await runKgPatternScout(update, "org-1", {
      enabled: false,
      maxTokens: 1500,
      minQuerySimilarity: 0.75,
      advisoryMinConf: 0.55,
      openConflictMinConf: 0.72,
      types: ["decision"],
    });
    expect(result.kg_recommendation).toBe("none");
    expect(getOrgPatternCandidates).not.toHaveBeenCalled();
  });

  it("creates lint finding on advisory recommendation", async () => {
    vi.mocked(getOrgPatternCandidates).mockResolvedValue({
      nodes: [kgNode],
      edges: [],
      truncated: false,
      total_matching: 1,
      token_estimate: 100,
    });
    vi.mocked(callLLMJSON).mockResolvedValue({
      recommendation: "advisory",
      confidence: 0.6,
      rationale: "Contradicts org decision",
      primary_node_id: "kn-redis",
      contradiction_summary: "Memcached vs Redis org decision",
    });

    const result = await runKgPatternScout(update, "org-1");
    expect(result.kg_recommendation).toBe("advisory");
    expect(appendLintFinding).toHaveBeenCalled();
    expect(createOrgPatternConflict).not.toHaveBeenCalled();
  });

  it("opens org-pattern conflict when confidence is high", async () => {
    vi.mocked(getOrgPatternCandidates).mockResolvedValue({
      nodes: [kgNode],
      edges: [],
      truncated: false,
      total_matching: 1,
      token_estimate: 100,
    });
    vi.mocked(callLLMJSON).mockResolvedValue({
      recommendation: "open_conflict",
      confidence: 0.8,
      rationale: "Clear violation",
      primary_node_id: "kn-redis",
      contradiction_summary: "Violates Redis decision",
    });
    vi.mocked(createOrgPatternConflict).mockResolvedValue({
      id: "C-ABCD",
      pod_id: "pod-1",
      created_at: new Date().toISOString(),
      status: "open",
      severity: "blocking",
      summary: "Violates Redis decision",
      sides: [],
      master_analysis: "",
      impact: [],
      resolved_by: null,
      resolution: null,
      resolution_date: null,
    });

    const result = await runKgPatternScout(update, "org-1");
    expect(result.kg_conflict_created).toBe(true);
    expect(result.kg_conflict_id).toBe("C-ABCD");
    expect(createOrgPatternConflict).toHaveBeenCalled();
  });
});
