import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../graph-storage.js", () => ({
  loadGraph: vi.fn(() => null),
  saveGraph: vi.fn(),
}));

import {
  initializeKnowledgeGraph,
  queryKnowledge,
  getRelevantLearnings,
  addLearningsToGraph,
} from "../knowledge-graph.js";
import type { EnhancedPodLearning } from "@pim/shared";

let orgSeq = 0;

function seedGraph(learnings: EnhancedPodLearning[]) {
  const orgId = `kg-test-${orgSeq++}`;
  initializeKnowledgeGraph(orgId);
  addLearningsToGraph(learnings, "pod-seed", "Seed Pod");
}

describe("queryKnowledge / getRelevantLearnings keyword wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ranks nodes matching conflict-derived keywords ahead of same-domain peers", () => {
    seedGraph([
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

    const withConflict = getRelevantLearnings(
      ["backend"],
      ["webhook payment authentication issue"],
      500,
    );
    const withoutConflict = getRelevantLearnings(["backend"], [], 500);

    expect(withConflict.nodes[0]?.summary).toContain("webhook");
    expect(withoutConflict.nodes[0]?.summary).toBeDefined();
    // Without keywords both tie on domain; order may be stable by sort — webhook should not be forced last when conflicts match it
    const webhookFirstWhenRelevant = withConflict.nodes.findIndex((n) =>
      n.summary.includes("webhook"),
    );
    const cdnFirstWhenRelevant = withConflict.nodes.findIndex((n) => n.summary.includes("CDN"));
    expect(webhookFirstWhenRelevant).toBeLessThan(cdnFirstWhenRelevant);
  });

  it("merges filters.keywords with text_search tokens for scoring", () => {
    seedGraph([
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

  it("getRelevantLearnings with projectId filters out nodes tagged to other projects", () => {
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
    addLearningsToGraph([{ ...base, summary: "Shared org learning" }], "pod-a", "Pod A");
    addLearningsToGraph(
      [{ ...base, summary: "Project Alpha decision" }],
      "pod-b",
      "Pod B",
      { project_id: "proj-alpha", project_name: "Alpha" },
    );
    addLearningsToGraph(
      [{ ...base, summary: "Project Beta decision" }],
      "pod-c",
      "Pod C",
      { project_id: "proj-beta", project_name: "Beta" },
    );

    const forAlpha = getRelevantLearnings(["backend"], [], 2000, "proj-alpha");
    const summaries = forAlpha.nodes.map(n => n.summary);
    expect(summaries.some(s => s.includes("Shared org"))).toBe(true);
    expect(summaries.some(s => s.includes("Project Alpha"))).toBe(true);
    expect(summaries.some(s => s.includes("Project Beta"))).toBe(false);
  });
});
