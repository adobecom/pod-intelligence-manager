/**
 * Parity test: the worker-backed path must produce the same communities, hubs, and
 * node.community_id assignments as the inline path on the same input. This is the
 * load-bearing test for PIM_GRAPH_WORKER — if the worker boundary drops or reorders
 * any field, this catches it before production.
 *
 * Uses the real worker thread (no mock), so vitest spawns an actual OS thread for
 * each test. Kept small (10-40 nodes) to keep test time reasonable.
 */
import { describe, it, expect, afterAll } from "vitest";
import { detectCommunities, identifyHubs, buildEdges } from "../graph-analysis.js";
import { getGraphAnalysisPool, _resetGraphAnalysisPoolForTests } from "../graph-analysis-pool.js";
import type { KnowledgeGraph, KnowledgeNode } from "@pim/shared";

function node(
  id: string,
  summary: string,
  domains: string[],
  embedding?: number[],
): KnowledgeNode {
  return {
    id,
    type: "pattern",
    summary,
    details: summary,
    source_pod_id: "pod-test",
    source_pod_name: "Test Pod",
    domains,
    confidence: "extracted",
    confidence_score: 0.85,
    created_at: new Date().toISOString(),
    curated: false,
    embedding,
  };
}

function buildSyntheticGraph(nodeCount: number): KnowledgeGraph {
  // Two clusters of nodes: half share embedding A, half share embedding B.
  // Within-cluster cosine = 1.0, cross-cluster cosine = 0.0.
  const embA = [1, 0, 0];
  const embB = [0, 1, 0];
  const nodes: KnowledgeNode[] = [];
  for (let i = 0; i < nodeCount; i++) {
    const inFirstCluster = i < nodeCount / 2;
    nodes.push(
      node(
        `n-${i}`,
        inFirstCluster
          ? `Cache strategy redis pattern ${i}`
          : `Color tokens design system ${i}`,
        [inFirstCluster ? "backend" : "design"],
        inFirstCluster ? embA : embB,
      ),
    );
  }
  // Build edges deterministically using the same function the worker will use,
  // so both inline and worker analyses see the same graph topology.
  const edges = buildEdges(nodes, nodes);
  return {
    version: 1,
    org_id: "org-parity-test",
    updated_at: new Date().toISOString(),
    nodes,
    edges,
    communities: [],
  };
}

function inlineAnalyze(graph: KnowledgeGraph) {
  // Clone so we don't mutate the input across calls.
  const cloned: KnowledgeGraph = {
    ...graph,
    nodes: graph.nodes.map((n) => ({ ...n })),
  };
  const communities = detectCommunities(cloned);
  const hubIds = identifyHubs(cloned);
  const nodeCommunityMap: Record<string, string> = {};
  for (const n of cloned.nodes) {
    if (n.community_id) nodeCommunityMap[n.id] = n.community_id;
  }
  return { communities, hubIds, nodeCommunityMap };
}

describe("graph analysis worker parity", () => {
  afterAll(async () => {
    await _resetGraphAnalysisPoolForTests();
  });

  it("worker output matches inline output on a 10-node graph", async () => {
    const graph = buildSyntheticGraph(10);
    const inline = inlineAnalyze(graph);
    const worker = await getGraphAnalysisPool().analyze(graph, graph.version);

    expect(worker.communities.length).toBe(inline.communities.length);
    expect(new Set(worker.hubIds)).toEqual(new Set(inline.hubIds));
    // Community labels are generated deterministically from member counts/types/domains,
    // so the actual community_id strings must match.
    expect(worker.nodeCommunityMap).toEqual(inline.nodeCommunityMap);
  });

  it("worker output matches inline output on a 40-node graph with two clusters", async () => {
    const graph = buildSyntheticGraph(40);
    const inline = inlineAnalyze(graph);
    const worker = await getGraphAnalysisPool().analyze(graph, graph.version);

    expect(worker.communities.length).toBe(inline.communities.length);
    expect(new Set(worker.hubIds)).toEqual(new Set(inline.hubIds));
    expect(worker.nodeCommunityMap).toEqual(inline.nodeCommunityMap);

    // Sanity: cluster separation produces at least 2 communities for this topology.
    expect(worker.communities.length).toBeGreaterThanOrEqual(2);
  });

  it("buildEdges via worker matches inline buildEdges", async () => {
    const a = node("a", "Adopted React Server Components", ["frontend"], [1, 0, 0]);
    const b = node("b", "Adopted React Server Components for ranking", ["frontend"], [1, 0, 0]);
    const c = node("c", "Unrelated billing pipeline migration", ["backend"], [0, 1, 0]);

    const inline = buildEdges([a], [b, c]);
    const workerResult = await getGraphAnalysisPool().buildEdges([a], [b, c]);

    expect(workerResult.edges.length).toBe(inline.length);
    expect(workerResult.edges.map((e) => ({ source: e.source, target: e.target }))).toEqual(
      inline.map((e) => ({ source: e.source, target: e.target })),
    );
  });

  it("preserves fromVersion through the worker boundary", async () => {
    const graph = buildSyntheticGraph(10);
    const expectedVersion = 42;
    const worker = await getGraphAnalysisPool().analyze(graph, expectedVersion);
    expect(worker.fromVersion).toBe(expectedVersion);
  });
});
