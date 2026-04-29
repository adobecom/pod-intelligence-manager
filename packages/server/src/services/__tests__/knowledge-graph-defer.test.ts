import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../graph-storage.js", () => ({
  loadGraph: vi.fn(() => null),
  saveGraph: vi.fn(),
}));

import {
  initializeKnowledgeGraph,
  addLearningsToGraph,
  refreshAnalysisIfStale,
  isAnalysisStale,
  getGraph,
} from "../knowledge-graph.js";
import type { EnhancedPodLearning } from "@pim/shared";

let orgSeq = 0;
function freshOrg() {
  return `kg-defer-test-${orgSeq++}`;
}

const sample: EnhancedPodLearning = {
  type: "pattern",
  summary: "Adopted webhook signature verification",
  details: "Verifying webhook signatures prevents spoofed callbacks.",
  domains: ["backend"],
  confidence: "extracted",
  confidence_score: 0.85,
};

describe("addLearningsToGraph skipAnalysis option", () => {
  beforeEach(() => vi.clearAllMocks());

  it("skipAnalysis=true marks the graph stale and does not recompute communities", async () => {
    initializeKnowledgeGraph(freshOrg());
    const result = await addLearningsToGraph(
      [sample],
      "pod-1",
      "Pod One",
      undefined,
      { skipAnalysis: true },
    );
    expect(result.nodesAdded).toBe(1);
    expect(isAnalysisStale()).toBe(true);
    expect(getGraph().communities).toEqual([]);
  });

  it("default (no options) recomputes communities and clears the stale flag", async () => {
    initializeKnowledgeGraph(freshOrg());
    await addLearningsToGraph([sample], "pod-1", "Pod One");
    expect(isAnalysisStale()).toBe(false);
    // Single node → at least one community gets assigned
    expect(getGraph().communities.length).toBeGreaterThan(0);
  });

  it("refreshAnalysisIfStale is a no-op when not stale", async () => {
    initializeKnowledgeGraph(freshOrg());
    await addLearningsToGraph([sample], "pod-1", "Pod One"); // not skipped → not stale
    expect(refreshAnalysisIfStale()).toBe(false);
  });

  it("refreshAnalysisIfStale runs when stale and clears the flag", async () => {
    initializeKnowledgeGraph(freshOrg());
    await addLearningsToGraph(
      [sample],
      "pod-1",
      "Pod One",
      undefined,
      { skipAnalysis: true },
    );
    expect(isAnalysisStale()).toBe(true);
    expect(refreshAnalysisIfStale()).toBe(true);
    expect(isAnalysisStale()).toBe(false);
  });
});
