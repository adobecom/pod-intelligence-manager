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
  maybeAddPodContextSignalToGraph,
  addResolvedConflictToGraph,
  getGraph,
} from "../knowledge-graph.js";
import type { EnhancedPodLearning } from "@pim/shared";

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

  it("maybeAddPodContextSignalToGraph adds decision nodes from active pods", () => {
    const orgId = `kg-test-${orgSeq++}`;
    initializeKnowledgeGraph(orgId);

    const decisionResult = maybeAddPodContextSignalToGraph(
      "pod-live",
      "Live Pod",
      "decision",
      "Switched auth flow to PKCE",
      "Needed for SPA support.",
      "frontend",
      { project_id: "proj-x", project_name: "Project X" },
    );
    const specResult = maybeAddPodContextSignalToGraph(
      "pod-live",
      "Live Pod",
      "spec_change",
      "API contract moved /users to /v2/users",
      "",
      "backend",
    );
    const progressResult = maybeAddPodContextSignalToGraph(
      "pod-live",
      "Live Pod",
      "progress",
      "Shipped button tweak",
      "",
      "frontend",
    );

    expect(decisionResult.added).toBe(true);
    expect(specResult.added).toBe(true);
    expect(progressResult.added).toBe(false);

    const nodes = getGraph().nodes;
    const decisionNode = nodes.find(n => n.summary.includes("PKCE"));
    expect(decisionNode?.type).toBe("decision");
    expect(decisionNode?.source_pod_id).toBe("pod-live");
    expect(decisionNode?.source_project_id).toBe("proj-x");
    const specNode = nodes.find(n => n.summary.includes("API contract"));
    expect(specNode?.type).toBe("scope_insight");
    expect(specNode?.source_project_id).toBeUndefined();
  });

  it("addResolvedConflictToGraph adds a resolved_conflict node on resolution", () => {
    const orgId = `kg-test-${orgSeq++}`;
    initializeKnowledgeGraph(orgId);

    const result = addResolvedConflictToGraph(
      "pod-live",
      "Live Pod",
      "Two agents disagreed on token storage",
      "Resolution: use httpOnly cookies.",
      "security",
      null,
    );
    expect(result.added).toBe(true);

    const node = getGraph().nodes.find(n => n.summary.includes("token storage"));
    expect(node?.type).toBe("resolved_conflict");
    expect(node?.source_pod_id).toBe("pod-live");
    expect(node?.confidence_score).toBe(0.9);
    expect(node?.domains).toContain("security");
  });
});
