import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../graph-storage.js", () => ({
  loadGraph: vi.fn(() => null),
  saveGraph: vi.fn(),
}));

vi.mock("../embeddings.js", async (importOriginal) => {
  const act = await importOriginal<typeof import("../embeddings.js")>();
  let seq = 0;
  return {
    ...act,
    isEmbeddingAvailable: () => true,
    generateEmbedding: vi.fn(async () => {
      seq += 1;
      const v = new Array(48).fill(0);
      v[seq % 48] = 1;
      return v;
    }),
  };
});

import {
  rawProposalsToLearnings,
  MAX_SYNTHESIS_PROPOSALS_PER_RUN,
  SYNTHESIS_CONFIDENCE_SCORE,
} from "../knowledge-synthesis.js";
import { initializeKnowledgeGraph, addLearningsToGraph, getGraph } from "../knowledge-graph.js";
import type { EnhancedPodLearning } from "@pim/shared";

let orgSeq = 0;
function freshOrg() {
  return `kg-synth-test-${orgSeq++}`;
}

const baseCtx = (graphNodeIds: string[], lintIds: string[], maxOutputs = MAX_SYNTHESIS_PROPOSALS_PER_RUN) => ({
  graphNodeIds: new Set(graphNodeIds),
  lintIds: new Set(lintIds),
  runId: "run-test-1",
  model: "us.anthropic.claude-test",
  maxOutputs,
});

describe("rawProposalsToLearnings", () => {
  it("drops proposals with fewer than two graph evidences and no lint", () => {
    const out = rawProposalsToLearnings(
      [
        {
          type: "pattern",
          summary: "Cross-cutting reliability theme",
          details:
            "When multiple services share retry semantics, timeouts should align to avoid thundering herds and cascading failures.",
          domains: ["backend"],
          evidence_node_ids: ["kn-onlyone"],
        },
      ],
      baseCtx(["kn-onlyone"], []),
    );
    expect(out).toEqual([]);
  });

  it("accepts two valid graph node ids", () => {
    const out = rawProposalsToLearnings(
      [
        {
          type: "scope_insight",
          summary: "Operational alignment across components",
          details:
            "Evidence from two nodes suggests coordinating rollout order reduces regression risk when schema and API ship together.",
          domains: ["backend", "infra"],
          evidence_node_ids: ["kn-a", "kn-b"],
        },
      ],
      baseCtx(["kn-a", "kn-b"], []),
    );
    expect(out).toHaveLength(1);
    expect(out[0].confidence).toBe("inferred");
    expect(out[0].confidence_score).toBeLessThanOrEqual(0.45);
    expect(out[0].confidence_score).toBe(SYNTHESIS_CONFIDENCE_SCORE);
    expect(out[0].ingestion_provenance?.kind).toBe("scheduled_synthesis");
    expect(out[0].ingestion_provenance?.evidence_node_ids).toEqual(["kn-a", "kn-b"]);
    expect(out[0].ingestion_provenance?.lint_finding_ids).toBeUndefined();
  });

  it("accepts one graph id plus one lint id", () => {
    const out = rawProposalsToLearnings(
      [
        {
          type: "anti_pattern",
          summary: "Avoid silent spec drift across agents",
          details:
            "The graph node describes a decision while lint flags spec drift; together they imply documenting implicit assumptions before merge.",
          domains: ["process"],
          evidence_node_ids: ["kn-x"],
          lint_finding_ids: ["lint-1"],
        },
      ],
      baseCtx(["kn-x"], ["lint-1"]),
    );
    expect(out).toHaveLength(1);
    expect(out[0].ingestion_provenance?.evidence_node_ids).toEqual(["kn-x"]);
    expect(out[0].ingestion_provenance?.lint_finding_ids).toEqual(["lint-1"]);
  });

  it("filters unknown ids and drops if evidence rule fails after filter", () => {
    const out = rawProposalsToLearnings(
      [
        {
          type: "pattern",
          summary: "Valid summary text here",
          details: "Valid details with enough characters to pass the minimum length bar.",
          domains: ["x"],
          evidence_node_ids: ["kn-real", "kn-fake"],
        },
      ],
      baseCtx(["kn-real"], []),
    );
    expect(out).toEqual([]);
  });

  it("drops invalid type and short text", () => {
    expect(
      rawProposalsToLearnings(
        [{ type: "not_a_type", summary: "short", details: "x", domains: ["a"], evidence_node_ids: ["a", "b"] }],
        baseCtx(["a", "b"], []),
      ),
    ).toEqual([]);
  });

  it("respects maxOutputs cap", () => {
    const proposals = [1, 2, 3, 4].map((i) => ({
      type: "pattern" as const,
      summary: `Summary number ${i} with padding`,
      details: `Details number ${i} with enough characters to satisfy the minimum length requirement easily.`,
      domains: ["backend"],
      evidence_node_ids: [`n${i}a`, `n${i}b`],
    }));
    const ids = ["n1a", "n1b", "n2a", "n2b", "n3a", "n3b", "n4a", "n4b"];
    const out = rawProposalsToLearnings(proposals, baseCtx(ids, [], 2));
    expect(out).toHaveLength(2);
  });
});

describe("addLearningsToGraph preserves ingestion_provenance", () => {
  beforeEach(() => vi.clearAllMocks());

  it("stores provenance on the created node", async () => {
    initializeKnowledgeGraph(freshOrg());
    const learning: EnhancedPodLearning = {
      type: "pattern",
      summary: "Synthetic provenance check summary",
      details: "Synthetic provenance check details with sufficient length for validation rules.",
      domains: ["test"],
      confidence: "inferred",
      confidence_score: 0.4,
      ingestion_provenance: {
        kind: "scheduled_synthesis",
        run_id: "run-xyz",
        model: "test-model",
        evidence_node_ids: ["kn-ev1", "kn-ev2"],
        lint_finding_ids: ["lf-1"],
      },
    };
    await addLearningsToGraph([learning], "synthesis", "Scheduled synthesis", undefined, { skipAnalysis: true });
    const nodes = getGraph().nodes;
    const created = nodes.find((n) => n.summary === learning.summary);
    expect(created).toBeDefined();
    expect(created!.ingestion_provenance).toEqual(learning.ingestion_provenance);
  });
});
