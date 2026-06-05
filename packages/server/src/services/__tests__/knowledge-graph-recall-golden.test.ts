import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeGraph, KnowledgeNode, KnowledgeQueryFilters } from "@pim/shared";
import oracleJson from "../__fixtures__/kg-retrieval-oracle.json";

const storageState = vi.hoisted(() => ({
  graph: null as KnowledgeGraph | null,
}));

vi.mock("../graph-storage.js", () => ({
  loadGraph: vi.fn(() => (storageState.graph ? structuredClone(storageState.graph) : null)),
  saveGraph: vi.fn(),
}));

vi.mock("../org-settings.js", async () => {
  const { DEFAULT_ORG_TUNING } = await import("@pim/shared");
  return {
    getOrgTuning: vi.fn(() => DEFAULT_ORG_TUNING),
  };
});

import { cosineSimilarity } from "../embeddings.js";
import { extractKeywords } from "../graph-analysis.js";
import {
  _resetForTests,
  getGraph,
  initializeKnowledgeGraph,
  queryKnowledge,
} from "../knowledge-graph.js";

interface RecallOracleCase {
  taskId: string;
  podId: string;
  description?: string;
  filters: KnowledgeQueryFilters;
  queryText: string;
  queryEmbedding: number[];
  mustIncludeNodeIds: string[];
}

interface RecallOracleFixture {
  formatVersion: 1 | 2;
  orgId: string;
  sourceOrgSlug: string;
  generatedAt: string;
  embedding: {
    provider: string;
    model: string;
    dimensions: number;
    normalized: boolean;
  };
  tuning: {
    minQuerySimilarity: number;
    recencyDecayDays: number;
    samePodDedupThreshold: number;
    crossPodDedupThreshold: number;
  };
  graph: KnowledgeGraph;
  cases: RecallOracleCase[];
}

const oracle = oracleJson as RecallOracleFixture;

function nodeLabel(node: KnowledgeNode | undefined): string {
  if (!node) return "(missing from frozen graph)";
  return `${node.id} [${node.type}] ${node.summary}`;
}

function keywordHits(queryText: string, node: KnowledgeNode): number {
  const queryKeywords = extractKeywords(queryText);
  const nodeKeywords = extractKeywords(`${node.summary} ${node.details}`);
  let hits = 0;
  for (const kw of queryKeywords) {
    if (nodeKeywords.has(kw)) hits++;
  }
  return hits;
}

function formatMissing(
  testCase: RecallOracleCase,
  missingIds: string[],
  returnedIds: string[],
): string {
  const nodesById = new Map(getGraph(oracle.orgId).nodes.map((node) => [node.id, node]));
  const lines = [
    `KG recall oracle missed reviewed node(s) for ${testCase.taskId}.`,
    `Returned ${returnedIds.length} node(s): ${returnedIds.join(", ") || "(none)"}`,
    "Missing node diagnostics:",
  ];

  for (const id of missingIds) {
    const node = nodesById.get(id);
    if (!node) {
      lines.push(`- ${id}: missing from frozen graph`);
      continue;
    }
    const cosine = node.embedding
      ? cosineSimilarity(testCase.queryEmbedding, node.embedding)
      : undefined;
    lines.push(
      [
        `- ${nodeLabel(node)}`,
        `cosine=${cosine === undefined ? "n/a" : cosine.toFixed(4)}`,
        `keywordHits=${keywordHits(testCase.queryText, node)}`,
        `confidence=${node.confidence_score}`,
        `domains=${node.domains.join(",")}`,
        node.superseded_by ? `superseded_by=${node.superseded_by}` : "not_superseded",
      ].join(" | "),
    );
  }

  return lines.join("\n");
}

describe("knowledge graph retrieval recall oracle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
    storageState.graph = structuredClone(oracle.graph);
    initializeKnowledgeGraph(oracle.orgId);
  });

  it("has an internally consistent frozen graph and reviewed cases", () => {
    expect([1, 2]).toContain(oracle.formatVersion);
    expect(oracle.graph.org_id).toBe(oracle.orgId);
    expect(oracle.embedding.dimensions).toBeGreaterThan(0);
    expect(oracle.cases.length).toBeGreaterThan(0);

    const nodeIds = new Set<string>();
    for (const node of oracle.graph.nodes) {
      expect(nodeIds.has(node.id), `duplicate node id ${node.id}`).toBe(false);
      nodeIds.add(node.id);
      expect(node.embedding, `${node.id} is missing an embedding`).toBeDefined();
      expect(node.embedding?.length, `${node.id} embedding dimension mismatch`).toBe(
        oracle.embedding.dimensions,
      );
    }

    for (const testCase of oracle.cases) {
      expect(Array.isArray(testCase.mustIncludeNodeIds), `${testCase.taskId} mustIncludeNodeIds must be an array`).toBe(true);
      expect(testCase.queryEmbedding.length, `${testCase.taskId} query embedding dimension mismatch`).toBe(
        oracle.embedding.dimensions,
      );
      for (const id of testCase.mustIncludeNodeIds) {
        expect(nodeIds.has(id), `${testCase.taskId} requires unknown node ${id}`).toBe(true);
      }
    }
  });

  it.each(oracle.cases)(
    "returns every reviewed required node for $taskId",
    (testCase) => {
      const result = queryKnowledge(oracle.orgId, {
        filters: testCase.filters,
        max_tokens: 1_000_000,
        include_details: true,
        query_text: testCase.queryText,
        query_embedding: testCase.queryEmbedding,
      });
      const returnedIds = result.nodes.map((node) => node.id);
      const returned = new Set(returnedIds);
      const missing = testCase.mustIncludeNodeIds.filter((id) => !returned.has(id));

      expect(missing, formatMissing(testCase, missing, returnedIds)).toEqual([]);
      expect(
        result.truncated,
        `${testCase.taskId} should not be token-truncated in the recall oracle`,
      ).toBe(false);
    },
  );
});
