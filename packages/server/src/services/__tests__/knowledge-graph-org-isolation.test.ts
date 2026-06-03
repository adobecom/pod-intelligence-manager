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

import {
  initializeKnowledgeGraph,
  queryKnowledge,
  getRelevantLearnings,
  addLearningsToGraph,
  getGraph,
  curateNode,
  getStats,
  _resetForTests,
} from "../knowledge-graph.js";
import type { EnhancedPodLearning } from "@pim/shared";

// These tests are the regression net for the org-partition leak: any future change
// that re-introduces a global singleton, drops the org_id from a service call, or
// otherwise lets org A's writes surface in org B's reads should fail here.

const ORG_A = "org-a";
const ORG_B = "org-b";

const learning = (summary: string, details = "details"): EnhancedPodLearning => ({
  type: "decision",
  summary,
  details,
  domains: ["backend"],
  confidence: "extracted",
  confidence_score: 0.9,
});

async function seedOrg(orgId: string, summaries: string[]): Promise<void> {
  initializeKnowledgeGraph(orgId);
  await addLearningsToGraph(
    orgId,
    summaries.map((s) => learning(s)),
    `pod-${orgId}`,
    `Pod ${orgId}`,
  );
}

describe("knowledge graph org isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
  });

  it("queryKnowledge only returns nodes for the requested org", async () => {
    await seedOrg(ORG_A, ["alpha-1", "alpha-2", "alpha-3"]);
    await seedOrg(ORG_B, ["beta-1", "beta-2", "beta-3"]);

    const aResult = queryKnowledge(ORG_A, {
      filters: { domains: ["backend"] },
      max_tokens: 2000,
    });
    const bResult = queryKnowledge(ORG_B, {
      filters: { domains: ["backend"] },
      max_tokens: 2000,
    });

    const aSummaries = aResult.nodes.map((n) => n.summary).sort();
    const bSummaries = bResult.nodes.map((n) => n.summary).sort();

    expect(aSummaries).toEqual(["alpha-1", "alpha-2", "alpha-3"]);
    expect(bSummaries).toEqual(["beta-1", "beta-2", "beta-3"]);
    expect(aSummaries.some((s) => s.startsWith("beta"))).toBe(false);
    expect(bSummaries.some((s) => s.startsWith("alpha"))).toBe(false);
  });

  it("addLearningsToGraph writes are invisible to a sibling org", async () => {
    await seedOrg(ORG_A, ["alpha-only"]);
    await seedOrg(ORG_B, ["beta-only"]);

    await addLearningsToGraph(
      ORG_A,
      [learning("alpha-late-write", "added after both orgs were seeded")],
      "pod-a-late",
      "Pod A Late",
    );

    const bGraph = getGraph(ORG_B);
    expect(bGraph.nodes.map((n) => n.summary)).toEqual(["beta-only"]);
    expect(bGraph.nodes.some((n) => n.summary === "alpha-late-write")).toBe(false);

    const bSearch = queryKnowledge(ORG_B, {
      filters: { text_search: "alpha" },
      max_tokens: 2000,
    });
    expect(bSearch.nodes).toEqual([]);
  });

  it("getRelevantLearnings is org-scoped end-to-end", async () => {
    await seedOrg(ORG_A, ["alpha-rel-1", "alpha-rel-2"]);
    await seedOrg(ORG_B, ["beta-rel-1", "beta-rel-2"]);

    const aRelevant = await getRelevantLearnings(ORG_A, ["backend"], [], 1000);
    const bRelevant = await getRelevantLearnings(ORG_B, ["backend"], [], 1000);

    expect(aRelevant.nodes.every((n) => n.summary.startsWith("alpha"))).toBe(true);
    expect(bRelevant.nodes.every((n) => n.summary.startsWith("beta"))).toBe(true);
  });

  it("curateNode cannot reach across orgs", async () => {
    await seedOrg(ORG_A, ["alpha-curate-me"]);
    await seedOrg(ORG_B, ["beta-untouched"]);

    const aNodeId = getGraph(ORG_A).nodes[0].id;

    // Org B cannot curate org A's node — returns false (not found in B's slot).
    await expect(curateNode(ORG_B, aNodeId, "approve")).resolves.toBe(false);

    // And the node in org A was not curated.
    expect(getGraph(ORG_A).nodes[0].curated).toBe(false);

    // Same call from org A succeeds.
    await expect(curateNode(ORG_A, aNodeId, "approve")).resolves.toBe(true);
    expect(getGraph(ORG_A).nodes[0].curated).toBe(true);
  });

  it("getStats reports per-org totals, not the union", async () => {
    await seedOrg(ORG_A, ["a", "b", "c"]);
    await seedOrg(ORG_B, ["d", "e"]);

    expect(getStats(ORG_A).total_nodes).toBe(3);
    expect(getStats(ORG_B).total_nodes).toBe(2);
  });

  it("an unseen org gets an empty graph instead of inheriting neighbors", async () => {
    await seedOrg(ORG_A, ["alpha"]);
    const stats = getStats("org-fresh-never-initialized");
    expect(stats.total_nodes).toBe(0);
    expect(stats.total_edges).toBe(0);

    const q = queryKnowledge("org-fresh-never-initialized", {
      filters: {},
      max_tokens: 1000,
    });
    expect(q.nodes).toEqual([]);
    expect(q.total_matching).toBe(0);
  });
});

describe("curateNode index consistency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
  });

	  it("edit action: old domain no longer returns the node, new domain does", async () => {
    // Gap 1: _removeNodeFromIndexes + _indexNode must be called around the edit so
    // the domain index stays coherent.
    const orgId = "org-curate-edit";
    initializeKnowledgeGraph(orgId);
    await addLearningsToGraph(
      orgId,
      [learning("Domain-swap node", "pre-edit details")],
      "pod-edit",
      "Edit Pod",
    );

    const nodeId = getGraph(orgId).nodes[0].id;

    // Confirm the node is reachable via its original domain before editing.
    const beforeEdit = queryKnowledge(orgId, {
      filters: { domains: ["backend"] },
      max_tokens: 2000,
    });
    expect(beforeEdit.nodes.map((n) => n.id)).toContain(nodeId);

    // Edit: move node from "backend" to "frontend".
    const edited = await curateNode(orgId, nodeId, "edit", { domains: ["frontend"] });
    expect(edited).toBe(true);

    // Old domain must no longer return the node.
    const afterOldDomain = queryKnowledge(orgId, {
      filters: { domains: ["backend"] },
      max_tokens: 2000,
    });
    expect(afterOldDomain.nodes.map((n) => n.id)).not.toContain(nodeId);

    // New domain must return the node.
    const afterNewDomain = queryKnowledge(orgId, {
      filters: { domains: ["frontend"] },
      max_tokens: 2000,
    });
    expect(afterNewDomain.nodes.map((n) => n.id)).toContain(nodeId);
  });

  it("edit action: clears stale embeddings when regeneration is unavailable", async () => {
    const orgId = "org-curate-embedding";
    initializeKnowledgeGraph(orgId);
    await addLearningsToGraph(
      orgId,
      [learning("Embedding stale node", "pre-edit details")],
      "pod-embedding",
      "Embedding Pod",
    );

    const node = getGraph(orgId).nodes[0];
    node.embedding = [1, 0, 0];
    node.embedding_text_hash = "old-hash";

    const edited = await curateNode(orgId, node.id, "edit", { details: "post-edit details" });

    expect(edited).toBe(true);
    expect(getGraph(orgId).nodes[0].embedding).toBeUndefined();
    expect(getGraph(orgId).nodes[0].embedding_text_hash).toBeUndefined();
  });

  it("reject action: node is absent from domain, type, and keyword index queries", async () => {
    // Gap 2: _removeNodeFromIndexes is called on reject; verify all index dimensions
    // are cleaned up, not just graph.nodes.
    const orgId = "org-curate-reject";
    initializeKnowledgeGraph(orgId);
    await addLearningsToGraph(
      orgId,
      [learning("Webhook retry logic for async jobs", "details about retries")],
      "pod-reject",
      "Reject Pod",
    );

    const nodeId = getGraph(orgId).nodes[0].id;

    // Sanity: node is reachable before rejection.
    const beforeReject = queryKnowledge(orgId, {
      filters: { domains: ["backend"] },
      max_tokens: 2000,
    });
    expect(beforeReject.nodes.map((n) => n.id)).toContain(nodeId);

    const rejected = await curateNode(orgId, nodeId, "reject");
    expect(rejected).toBe(true);

    // Must be absent from graph.nodes.
    expect(getGraph(orgId).nodes.map((n) => n.id)).not.toContain(nodeId);

    // Must be absent from domain index query.
    const domainQ = queryKnowledge(orgId, {
      filters: { domains: ["backend"] },
      max_tokens: 2000,
    });
    expect(domainQ.nodes.map((n) => n.id)).not.toContain(nodeId);

    // Must be absent from type index query.
    const typeQ = queryKnowledge(orgId, {
      filters: { types: ["decision"] },
      max_tokens: 2000,
    });
    expect(typeQ.nodes.map((n) => n.id)).not.toContain(nodeId);

    // Must be absent from keyword index query (term that was in the summary).
    const kwQ = queryKnowledge(orgId, {
      filters: { text_search: "webhook" },
      max_tokens: 2000,
    });
    expect(kwQ.nodes.map((n) => n.id)).not.toContain(nodeId);
  });
});
