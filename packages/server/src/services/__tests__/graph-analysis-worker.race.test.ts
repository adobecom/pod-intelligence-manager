/**
 * Race-condition test: if graph.version changes between dispatch and worker result,
 * the result must be discarded and analysisStale must stay true so the next interval
 * re-runs against the newer graph.
 *
 * We mock the pool to give us deterministic control over when the worker "resolves",
 * so we can interleave a graph mutation between dispatch and result without relying
 * on real-thread timing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../graph-storage.js", () => ({
  loadGraph: vi.fn(() => null),
  saveGraph: vi.fn(),
}));

vi.mock("../org-settings.js", async () => {
  const { DEFAULT_ORG_TUNING } = await import("@pim/shared");
  return {
    getOrgTuning: vi.fn(() => DEFAULT_ORG_TUNING),
  };
});

// Replace the pool with a hand-controlled mock so analyze() can be held open.
const analyzeMock = vi.fn();
vi.mock("../graph-analysis-pool.js", () => ({
  getGraphAnalysisPool: () => ({ analyze: analyzeMock }),
  isGraphWorkerEnabled: () => true,
  _resetGraphAnalysisPoolForTests: async () => {},
}));

import {
  initializeKnowledgeGraph,
  addLearningsToGraph,
  refreshAnalysisWithWorker,
  isAnalysisStale,
  getGraph,
  _resetForTests,
} from "../knowledge-graph.js";
import type { EnhancedPodLearning } from "@pim/shared";

let orgSeq = 0;
function freshOrg() {
  return `kg-race-test-${orgSeq++}`;
}

const sample: EnhancedPodLearning = {
  type: "pattern",
  summary: "Adopted webhook signature verification",
  details: "Verifying webhook signatures prevents spoofed callbacks.",
  domains: ["backend"],
  confidence: "extracted",
  confidence_score: 0.85,
};

describe("refreshAnalysisWithWorker — race condition handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
  });

  it("discards the worker result when graph.version changes mid-flight", async () => {
    const orgId = freshOrg();
    initializeKnowledgeGraph(orgId);

    // Seed one node so the graph is non-empty (refreshAnalysisWithWorker bails out at 0 nodes).
    await addLearningsToGraph(orgId, [sample], "pod-1", "Pod One", undefined, { skipAnalysis: true });
    expect(isAnalysisStale(orgId)).toBe(true);
    const versionBeforeRefresh = getGraph(orgId).version;

    // Pool returns a result tagged with the *original* version even though we'll
    // mutate the graph before the promise resolves.
    let resolveAnalyze: () => void = () => {};
    analyzeMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAnalyze = () =>
            resolve({
              requestId: "req-1",
              type: "analyze",
              fromVersion: versionBeforeRefresh,
              communities: [
                {
                  id: "community-stale",
                  label: "stale cluster",
                  node_count: 1,
                  top_domains: ["backend"],
                  summary: "stale",
                },
              ],
              hubIds: [],
              nodeCommunityMap: {},
            });
        }),
    );

    const refreshPromise = refreshAnalysisWithWorker(orgId);

    // Mutate the graph while the worker "is running". This bumps graph.version.
    await addLearningsToGraph(
      orgId,
      [{ ...sample, summary: "Adopted webhook signature verification v2" }],
      "pod-2",
      "Pod Two",
      undefined,
      { skipAnalysis: true },
    );

    expect(getGraph(orgId).version).toBeGreaterThan(versionBeforeRefresh);

    // Now release the stale worker result.
    resolveAnalyze();
    const applied = await refreshPromise;

    expect(applied).toBe(false);
    // Result was discarded — communities should NOT contain the stale label.
    expect(getGraph(orgId).communities.find((c) => c.id === "community-stale")).toBeUndefined();
    // analysisStale should stay true so the next interval re-runs.
    expect(isAnalysisStale(orgId)).toBe(true);
  });

  it("applies the worker result when graph.version is unchanged", async () => {
    const orgId = freshOrg();
    initializeKnowledgeGraph(orgId);

    await addLearningsToGraph(orgId, [sample], "pod-1", "Pod One", undefined, { skipAnalysis: true });
    const versionBeforeRefresh = getGraph(orgId).version;

    analyzeMock.mockResolvedValue({
      requestId: "req-2",
      type: "analyze",
      fromVersion: versionBeforeRefresh,
      communities: [
        {
          id: "community-fresh",
          label: "fresh cluster",
          node_count: 1,
          top_domains: ["backend"],
          summary: "fresh",
        },
      ],
      hubIds: [],
      nodeCommunityMap: { [getGraph(orgId).nodes[0].id]: "community-fresh" },
    });

    const applied = await refreshAnalysisWithWorker(orgId);
    expect(applied).toBe(true);
    expect(isAnalysisStale(orgId)).toBe(false);
    expect(getGraph(orgId).communities.find((c) => c.id === "community-fresh")).toBeDefined();
    expect(getGraph(orgId).nodes[0].community_id).toBe("community-fresh");
  });

  it("returns false and leaves the graph untouched when the worker rejects", async () => {
    const orgId = freshOrg();
    initializeKnowledgeGraph(orgId);

    await addLearningsToGraph(orgId, [sample], "pod-1", "Pod One", undefined, { skipAnalysis: true });
    const versionBeforeRefresh = getGraph(orgId).version;
    const communitiesBeforeRefresh = getGraph(orgId).communities;

    analyzeMock.mockRejectedValueOnce(new Error("Worker exited with code 1"));

    const applied = await refreshAnalysisWithWorker(orgId);

    expect(applied).toBe(false);
    expect(getGraph(orgId).version).toBe(versionBeforeRefresh);
    expect(getGraph(orgId).communities).toBe(communitiesBeforeRefresh);
    expect(isAnalysisStale(orgId)).toBe(true);
  });
});
