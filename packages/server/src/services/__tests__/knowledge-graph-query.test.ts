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
  pruneStaleNodes,
} from "../knowledge-graph.js";
import type { EnhancedPodLearning, KnowledgeNode } from "@pim/shared";

let orgSeq = 0;

async function seedGraph(learnings: EnhancedPodLearning[]) {
  const orgId = `kg-test-${orgSeq++}`;
  initializeKnowledgeGraph(orgId);
  await addLearningsToGraph(learnings, "pod-seed", "Seed Pod");
}

describe("queryKnowledge / getRelevantLearnings keyword wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ranks nodes matching conflict-derived keywords ahead of same-domain peers", async () => {
    await seedGraph([
      {
        type: "scope_insight",
        summary: "Use webhook authentication for payment callbacks",
        details: "Prefer signature verification for payment systems.",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
      {
        type: "scope_insight",
        summary: "Cache static assets at the CDN edge",
        details: "Long TTL for immutable versioned URLs.",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
    ]);

    const withConflict = await getRelevantLearnings(
      ["backend"],
      ["webhook payment authentication issue"],
      500,
    );
    const withoutConflict = await getRelevantLearnings(["backend"], [], 500);

    expect(withConflict.nodes[0]?.summary).toContain("webhook");
    expect(withoutConflict.nodes[0]?.summary).toBeDefined();
    // Without keywords both tie on domain; order may be stable by sort — webhook should not be forced last when conflicts match it
    const webhookFirstWhenRelevant = withConflict.nodes.findIndex((n) =>
      n.summary.includes("webhook"),
    );
    const cdnFirstWhenRelevant = withConflict.nodes.findIndex((n) => n.summary.includes("CDN"));
    expect(webhookFirstWhenRelevant).toBeLessThan(cdnFirstWhenRelevant);
  });

  it("queryKnowledge omits node embeddings by default; include_embeddings restores them", async () => {
    await seedGraph([
      {
        type: "pattern",
        summary: "Embedding strip test node",
        details: "",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
    ]);

    const g = getGraph();
    const n = g.nodes.find((x) => x.summary === "Embedding strip test node");
    expect(n).toBeDefined();
    n!.embedding = [1, 2, 3];

    const without = queryKnowledge({
      filters: { domains: ["backend"] },
      max_tokens: 500,
    });
    expect(without.nodes[0]?.embedding).toBeUndefined();

    const withEmb = queryKnowledge({
      filters: { domains: ["backend"] },
      max_tokens: 500,
      include_embeddings: true,
    });
    expect(withEmb.nodes[0]?.embedding).toEqual([1, 2, 3]);
  });

  it("merges filters.keywords with text_search tokens for scoring", async () => {
    await seedGraph([
      {
        type: "pattern",
        summary: "Zebra migration checklist for infra",
        details: "",
        domains: ["infra"],
        confidence: "extracted",
        confidence_score: 0.85,
      },
      {
        type: "pattern",
        summary: "Yak migration checklist for infra",
        details: "",
        domains: ["infra"],
        confidence: "extracted",
        confidence_score: 0.85,
      },
    ]);

    const q = queryKnowledge({
      filters: {
        domains: ["infra"],
        text_search: "migration",
        keywords: ["zebra"],
      },
      max_tokens: 500,
    });

    expect(q.nodes[0]?.summary.toLowerCase()).toContain("zebra");
  });

  it("getRelevantLearnings with projectId filters out nodes tagged to other projects", async () => {
    const orgId = `kg-test-${orgSeq++}`;
    initializeKnowledgeGraph(orgId);
    const base: EnhancedPodLearning = {
      type: "decision",
      details: "",
      domains: ["backend"],
      confidence: "extracted",
      confidence_score: 0.9,
      summary: "",
    };
    await addLearningsToGraph([{ ...base, summary: "Shared org learning" }], "pod-a", "Pod A");
    await addLearningsToGraph(
      [{ ...base, summary: "Project Alpha decision" }],
      "pod-b",
      "Pod B",
      { project_id: "proj-alpha", project_name: "Alpha" },
    );
    await addLearningsToGraph(
      [{ ...base, summary: "Project Beta decision" }],
      "pod-c",
      "Pod C",
      { project_id: "proj-beta", project_name: "Beta" },
    );

    const forAlpha = await getRelevantLearnings(["backend"], [], 2000, "proj-alpha");
    const summaries = forAlpha.nodes.map(n => n.summary);
    expect(summaries.some(s => s.includes("Shared org"))).toBe(true);
    expect(summaries.some(s => s.includes("Project Alpha"))).toBe(true);
    expect(summaries.some(s => s.includes("Project Beta"))).toBe(false);
  });

});

describe("pruneStaleNodes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("removes only stale, low-confidence, uncurated, non-superseded nodes", async () => {
    const orgId = `kg-prune-${orgSeq++}`;
    initializeKnowledgeGraph(orgId);

    const old = new Date("2024-01-01T00:00:00Z").toISOString();
    const recent = new Date().toISOString();
    const ages: { id: string; created_at: string; confidence_score: number; curated: boolean; superseded?: boolean }[] = [
      { id: "kn-stale-junk", created_at: old, confidence_score: 0.3, curated: false }, // SHOULD prune
      { id: "kn-curated-old", created_at: old, confidence_score: 0.3, curated: true }, // protected (curated)
      { id: "kn-recent-junk", created_at: recent, confidence_score: 0.3, curated: false }, // protected (recent)
      { id: "kn-old-confident", created_at: old, confidence_score: 0.8, curated: false }, // protected (high confidence)
      { id: "kn-old-superseded", created_at: old, confidence_score: 0.3, curated: false, superseded: true }, // protected (superseded)
    ];

    const graph = getGraph();
    for (const a of ages) {
      const node: KnowledgeNode = {
        id: a.id,
        type: "pattern",
        summary: a.id,
        details: a.id,
        source_pod_id: "pod-x",
        source_pod_name: "Pod X",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: a.confidence_score,
        created_at: a.created_at,
        curated: a.curated,
        ...(a.superseded ? { superseded_by: "kn-curated-old" } : {}),
      };
      graph.nodes.push(node);
    }

    const result = pruneStaleNodes();
    expect(result.removed).toBe(1);
    const ids = getGraph().nodes.map((n) => n.id);
    expect(ids).not.toContain("kn-stale-junk");
    expect(ids).toContain("kn-curated-old");
    expect(ids).toContain("kn-recent-junk");
    expect(ids).toContain("kn-old-confident");
    expect(ids).toContain("kn-old-superseded");
  });

  it("returns 0 removed on an empty graph", () => {
    const orgId = `kg-prune-empty-${orgSeq++}`;
    initializeKnowledgeGraph(orgId);
    expect(pruneStaleNodes().removed).toBe(0);
  });
});
