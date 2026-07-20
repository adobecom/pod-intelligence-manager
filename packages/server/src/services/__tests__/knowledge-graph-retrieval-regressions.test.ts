import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeEdge, KnowledgeGraph, KnowledgeNode } from "@pim/shared";

vi.mock("../graph-storage.js", () => ({
  loadGraph: vi.fn(() => null),
  saveGraph: vi.fn(),
}));

vi.mock("../org-settings.js", async () => {
  const { DEFAULT_ORG_TUNING } = await import("@pim/shared");
  return {
    getOrgTuning: vi.fn(() => DEFAULT_ORG_TUNING),
    getKgContextContract: vi.fn(() => "legacy"),
  };
});

import oracleJson from "../__fixtures__/kg-retrieval-oracle.json";
import {
  evaluateContractRetrievalOracle,
  type RetrievalOracleFixture,
} from "../kg-retrieval-eval.js";
import {
  _resetForTests,
  getRelevantLearningsForContractMode,
  loadGraphForOfflineEvaluation,
  queryKnowledge,
} from "../knowledge-graph.js";

const oracle = oracleJson as RetrievalOracleFixture;

function node(overrides: Partial<KnowledgeNode> & Pick<KnowledgeNode, "id" | "summary">): KnowledgeNode {
  return {
    type: "pattern",
    details: overrides.summary,
    source_pod_id: "pod-allowed",
    source_pod_name: "Allowed Pod",
    domains: ["backend"],
    confidence: "extracted",
    confidence_score: 0.9,
    created_at: "2026-07-01T00:00:00.000Z",
    curated: false,
    ...overrides,
  };
}

function loadTestGraph(orgId: string, nodes: KnowledgeNode[], edges: KnowledgeEdge[] = []): void {
  const graph: KnowledgeGraph = {
    version: 1,
    org_id: orgId,
    updated_at: "2026-07-01T00:00:00.000Z",
    nodes,
    edges,
    communities: [],
  };
  loadGraphForOfflineEvaluation(graph);
}

describe("knowledge graph retrieval regressions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
  });

  it("does not graph-expand neighbors outside requested scope, type, or source filters", () => {
    const orgId = "kg-regression-test-expansion-filters";
    const seed = node({
      id: "seed",
      type: "decision",
      summary: "ExactPreflight task constraint",
      domains: ["frontend"],
      embedding: [1, 0],
    });
    const wrongScope = node({
      id: "wrong-scope",
      type: "decision",
      summary: "Backend-only graph neighbor",
      domains: ["backend"],
      embedding: [0, 1],
    });
    const wrongType = node({
      id: "wrong-type",
      type: "pattern",
      summary: "Frontend pattern graph neighbor",
      domains: ["frontend"],
      embedding: [0, 1],
    });
    const wrongSource = node({
      id: "wrong-source",
      type: "decision",
      summary: "Other pod graph neighbor",
      source_pod_id: "pod-other",
      source_pod_name: "Other Pod",
      domains: ["frontend"],
      embedding: [0, 1],
    });
    loadTestGraph(
      orgId,
      [seed, wrongScope, wrongType, wrongSource],
      [wrongScope, wrongType, wrongSource].map((neighbor) => ({
        source: seed.id,
        target: neighbor.id,
        type: "relates_to",
        weight: 1,
      })),
    );

    const result = queryKnowledge(orgId, {
      filters: {
        scopes: ["frontend"],
        types: ["decision"],
        source_pod_ids: ["pod-allowed"],
      },
      query_text: "ExactPreflight task constraint",
      query_embedding: [1, 0],
      expand_graph: true,
      max_tokens: 2000,
    });

    expect(result.nodes.map((candidate) => candidate.id)).toEqual([seed.id]);
  });

  it("retains the reviewed rank-six learning in the task-relevant candidate list", async () => {
    const testCase = oracle.cases.find((candidate) => candidate.taskId === "synth-session-time-response-state");
    expect(testCase).toBeDefined();
    loadGraphForOfflineEvaluation(oracle.graph, { allowReplacingLoadedOrg: true });

    const result = await getRelevantLearningsForContractMode(oracle.orgId, "task_relevant", {
      scopes: testCase!.filters.scopes ?? testCase!.filters.domains ?? [],
      projectId: testCase!.filters.include_project_id,
      taskQuery: testCase!.queryText,
      taskQueryEmbedding: testCase!.queryEmbedding,
      maxTokens: 4000,
    });

    expect(testCase!.mustIncludeNodeIds).toContain("kn-6c413520");
    expect(result.nodes.map((candidate) => candidate.id)).toEqual(
      expect.arrayContaining(testCase!.mustIncludeNodeIds),
    );
  });

  it("keeps task-relevant reviewed recall at parity while returning fewer candidates", async () => {
    const report = await evaluateContractRetrievalOracle(oracle, [4_000]);
    const legacy = report.modes.legacy.aggregateByBudget["4000"];
    const taskRelevant = report.modes.task_relevant.aggregateByBudget["4000"];
    const failedCase = report.modes.task_relevant.cases.find((testCase) =>
      report.modes.task_relevant.failures.some((failure) => failure.taskId === testCase.taskId),
    );

    expect(
      report.modes.task_relevant.failures,
      failedCase ? JSON.stringify(failedCase, null, 2) : undefined,
    ).toEqual([]);
    expect(taskRelevant.recallAtBudget).toBeGreaterThanOrEqual(legacy.recallAtBudget ?? 0);
    expect(taskRelevant.mrr ?? 0).toBeGreaterThanOrEqual((legacy.mrr ?? 0) - 0.01);
    expect(taskRelevant.precisionAt5 ?? 0).toBeGreaterThanOrEqual((legacy.precisionAt5 ?? 0) - 0.01);
    expect(taskRelevant.meanReturnedCount).toBeLessThan(legacy.meanReturnedCount);
    expect(taskRelevant.meanTokenEstimate).toBeLessThan(legacy.meanTokenEstimate);
  }, 30_000);

  it("skips an oversized early result so a later fitting result can use the token budget", () => {
    const orgId = "kg-regression-test-token-budget";
    const oversized = node({
      id: "oversized",
      summary: `anchor ${"oversized ".repeat(40)}`,
      curated: true,
    });
    const fitting = node({
      id: "fitting",
      summary: "anchor fallback",
    });
    loadTestGraph(orgId, [oversized, fitting]);

    const result = queryKnowledge(orgId, {
      filters: { scopes: ["backend"], keywords: ["anchor"] },
      max_tokens: 8,
    });

    expect(result.nodes.map((candidate) => candidate.id)).toEqual([fitting.id]);
    expect(result.token_estimate).toBeLessThanOrEqual(8);
    expect(result.total_matching).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it("uses lexical fallback weights for dimension-incompatible stored embeddings", () => {
    const orgId = "kg-regression-test-embedding-dimensions";
    const withMismatchedEmbedding = node({
      id: "mismatched-embedding",
      summary: "Queue retry policy",
      details: "Queue retry policy with bounded backoff.",
      created_at: "2020-01-01T00:00:00.000Z",
      embedding: [1, 0, 0],
    });
    const withoutEmbedding = node({
      id: "missing-embedding",
      summary: "Queue retry policy",
      details: "Queue retry policy with bounded backoff.",
      created_at: "2020-01-01T00:00:00.000Z",
    });
    loadTestGraph(orgId, [withMismatchedEmbedding, withoutEmbedding]);

    const result = queryKnowledge(orgId, {
      filters: { scopes: ["backend"] },
      query_text: "queue retry",
      query_embedding: [1, 0],
      expand_graph: false,
      include_explanations: true,
      max_tokens: 2000,
    });

    const explanationById = new Map(result.explanations?.map((entry) => [entry.node_id, entry]));
    const mismatched = explanationById.get(withMismatchedEmbedding.id);
    const missing = explanationById.get(withoutEmbedding.id);
    expect(result.retrieval_diagnostics).toMatchObject({
      mode: "lexical",
      degraded: true,
      embedding_coverage: 0,
      degradation_reasons: ["candidate_embeddings_unavailable"],
    });
    expect(mismatched?.semantic_score).toBeUndefined();
    expect(mismatched?.score_components?.semantic_match).toBe(0);
    expect(mismatched?.score_components?.base_relevance).toBeCloseTo(
      missing!.score_components!.base_relevance,
      12,
    );
    expect(mismatched?.score).toBeCloseTo(missing!.score!, 12);
  });

  it.each([
    ["P1", "preflight"],
    ["UI", "validation"],
  ])(
    "ranks an exact ordered %s/common-term match above generic high-semantic guidance",
    (identifier, commonTerm) => {
      const orgId = `kg-regression-test-ordered-${identifier.toLowerCase()}`;
      const generic = node({
        id: "generic-guidance",
        type: "decision",
        summary: `${identifier} general release guidance`,
        details: "Broad release guidance applies to routine work.",
        confidence_score: 0.99,
        curated: true,
        embedding: [0.85, 0.5267826876],
      });
      const specific = node({
        id: "specific-guidance",
        type: "decision",
        summary: `${identifier} ${commonTerm} task guidance`,
        details: `Apply ${identifier} ${commonTerm} checks before promotion.`,
        confidence_score: 0.78,
        embedding: [0.3, 0.9539392014],
      });
      const commonTermFillers = Array.from({ length: 3 }, (_, index) => node({
        id: `common-${index}`,
        summary: `Routine ${commonTerm} note ${index}`,
        details: `Broad ${commonTerm} guidance without the guarded identifier.`,
        confidence_score: 0.8,
        embedding: [0, 1],
      }));
      loadTestGraph(orgId, [generic, specific, ...commonTermFillers]);

      const result = queryKnowledge(orgId, {
        filters: { scopes: ["backend"] },
        query_text: `${identifier}/${commonTerm}`,
        query_embedding: [1, 0],
        expand_graph: false,
        include_explanations: true,
        strict_task_relevance: true,
        max_tokens: 2000,
      });

      const explanationById = new Map(result.explanations?.map((entry) => [entry.node_id, entry]));
      const exactExplanation = explanationById.get(specific.id);
      const genericExplanation = explanationById.get(generic.id);
      expect(result.nodes[0]?.id).toBe(specific.id);
      expect(exactExplanation?.evidence).toMatchObject({
        rare_keyword_hits: 0,
        ordered_generic_identifier_match: true,
      });
      expect(exactExplanation?.evidence?.phrase_match).toBeGreaterThan(0);
      expect(exactExplanation?.score_components?.identifier_match).toBeGreaterThan(0);
      expect(exactExplanation!.score).toBeGreaterThan(genericExplanation!.score!);
    },
  );

  it("ranks specific task language above broader guidance with a stronger embedding", () => {
    const orgId = "kg-regression-test-specificity";
    const generic = node({
      id: "generic-release-guidance",
      summary: "General release validation checklist",
      details: "Broad release guidance applies to routine deployments.",
      confidence_score: 0.99,
      curated: true,
      embedding: [1, 0],
    });
    const specific = node({
      id: "specific-preflight-guidance",
      summary: "Release manifest preflight validation",
      details: "Validate the release manifest during preflight before promotion.",
      confidence_score: 0.78,
      embedding: [0.8, 0.6],
    });
    loadTestGraph(orgId, [generic, specific]);

    const result = queryKnowledge(orgId, {
      filters: { scopes: ["backend"] },
      query_text: "release manifest preflight validation",
      query_embedding: [1, 0],
      expand_graph: false,
      include_explanations: true,
      max_tokens: 2000,
    });

    expect(result.nodes[0]?.id).toBe(specific.id);
    expect(result.explanations?.[0].score_components?.lexical_specificity).toBeGreaterThan(0);
    expect(result.explanations?.[0].evidence?.phrase_match).toBeGreaterThan(0);
  });
});
