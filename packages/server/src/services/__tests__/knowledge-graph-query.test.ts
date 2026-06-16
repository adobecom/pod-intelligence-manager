import { describe, it, expect, vi, beforeEach } from "vitest";

const orgSettingsState = vi.hoisted(() => ({
  kgContextContract: "legacy" as "legacy" | "shadow" | "task_relevant",
}));

vi.mock("../graph-storage.js", () => ({
  loadGraph: vi.fn(() => null),
  saveGraph: vi.fn(),
}));

vi.mock("../org-settings.js", async () => {
  const { DEFAULT_ORG_TUNING } = await import("@pim/shared");
  return {
    getOrgTuning: vi.fn(() => DEFAULT_ORG_TUNING),
    getKgContextContract: vi.fn(() => orgSettingsState.kgContextContract),
  };
});

import {
  initializeKnowledgeGraph,
  queryKnowledge,
  getContractedRelevantLearnings,
  getRelevantLearnings,
  addLearningsToGraph,
  getGraph,
  KnowledgeQueryValidationError,
  pruneStaleNodes,
  refreshAnalysisIfStale,
  loadGraphForOfflineEvaluation,
  _resetForTests,
} from "../knowledge-graph.js";
import { saveGraph } from "../graph-storage.js";
import { getOrgTuning } from "../org-settings.js";
import { extractIdentifiers, extractRetrievalIdentifiers } from "../graph-analysis.js";
import { DEFAULT_ORG_TUNING, type EnhancedPodLearning, type KnowledgeGraph, type KnowledgeNode } from "@pim/shared";

// Push a node directly into the graph (bypasses embedding/dedup so tests stay fast).
// The index is NOT updated here — caller must use addLearningsToGraph for index-aware
// insertion, or manually trigger by re-initializing. Direct push is intentional for
// prune tests that need full control over node metadata.
function rawPushNode(
  orgId: string,
  overrides: Partial<KnowledgeNode> & Pick<KnowledgeNode, "id" | "summary" | "domains">,
): KnowledgeNode {
  const node: KnowledgeNode = {
    type: "pattern",
    details: overrides.summary,
    source_pod_id: "pod-test",
    source_pod_name: "Test Pod",
    confidence: "extracted",
    confidence_score: 0.8,
    created_at: new Date().toISOString(),
    curated: false,
    ...overrides,
  };
  getGraph(orgId).nodes.push(node);
  return node;
}

function testNode(overrides: Partial<KnowledgeNode> & Pick<KnowledgeNode, "id" | "summary">): KnowledgeNode {
  return {
    type: "pattern",
    details: overrides.summary,
    source_pod_id: "pod-test",
    source_pod_name: "Test Pod",
    domains: ["backend"],
    confidence: "extracted",
    confidence_score: 0.9,
    created_at: "2026-01-01T00:00:00.000Z",
    curated: false,
    ...overrides,
  };
}

let orgSeq = 0;

function nextOrgId(prefix: string): string {
  return `${prefix}-${orgSeq++}`;
}

async function seedGraph(learnings: EnhancedPodLearning[]): Promise<string> {
  const orgId = nextOrgId("kg-test");
  initializeKnowledgeGraph(orgId);
  await addLearningsToGraph(orgId, learnings, "pod-seed", "Seed Pod");
  return orgId;
}

describe("queryKnowledge / getRelevantLearnings keyword wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
    orgSettingsState.kgContextContract = "legacy";
    delete process.env.PIM_KG_COMPACT_CONTEXT_TOP_N;
    delete process.env.PIM_KG_COMPACT_CONTEXT_MAX_CHARS;
  });

  it("ranks nodes matching conflict-derived keywords ahead of same-domain peers", async () => {
    const orgId = await seedGraph([
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
      orgId,
      ["backend"],
      ["webhook payment authentication issue"],
      500,
    );
    const withoutConflict = await getRelevantLearnings(orgId, ["backend"], [], 500);

    expect(withConflict.nodes[0]?.summary).toContain("webhook");
    expect(withoutConflict.nodes[0]?.summary).toBeDefined();
    // Without keywords both tie on domain; order may be stable by sort — webhook should not be forced last when conflicts match it
    const webhookFirstWhenRelevant = withConflict.nodes.findIndex((n) =>
      n.summary.includes("webhook"),
    );
    const cdnFirstWhenRelevant = withConflict.nodes.findIndex((n) => n.summary.includes("CDN"));
    expect(webhookFirstWhenRelevant).toBeLessThan(cdnFirstWhenRelevant);
  });

  it("uses high-signal keywords for semantic-gate fallback thresholds", async () => {
    const orgId = await seedGraph([
      {
        type: "scope_insight",
        summary: "Webhook authentication is implemented with signed callbacks",
        details: "The current webhook path authenticates requests with signatures.",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
      {
        type: "scope_insight",
        summary: "Status pages render from cached project metadata",
        details: "Unrelated status implementation notes.",
        domains: ["frontend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
    ]);

    const result = queryKnowledge(orgId, {
      filters: {},
      query_text: "how current status implemented webhook authentication",
      query_embedding: [1, 0],
      max_tokens: 500,
      expand_graph: false,
    });

    expect(result.nodes.map((n) => n.summary)).toContain("Webhook authentication is implemented with signed callbacks");
  });

  it("queryKnowledge omits node embeddings by default; include_embeddings restores them", async () => {
    const orgId = await seedGraph([
      {
        type: "pattern",
        summary: "Embedding strip test node",
        details: "",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
    ]);

    const g = getGraph(orgId);
    const n = g.nodes.find((x) => x.summary === "Embedding strip test node");
    expect(n).toBeDefined();
    n!.embedding = [1, 2, 3];

    const without = queryKnowledge(orgId, {
      filters: { domains: ["backend"] },
      max_tokens: 500,
    });
    expect(without.nodes[0]?.embedding).toBeUndefined();

    const withEmb = queryKnowledge(orgId, {
      filters: { domains: ["backend"] },
      max_tokens: 500,
      include_embeddings: true,
    });
    expect(withEmb.nodes[0]?.embedding).toEqual([1, 2, 3]);
  });

  it("treats missing query filters as an empty filter object", async () => {
    const orgId = await seedGraph([
      {
        type: "pattern",
        summary: "Missing filters defensive query",
        details: "Runtime callers that omit filters should not crash query normalization.",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
    ]);

    const result = queryKnowledge(orgId, {
      filters: undefined,
      max_tokens: 500,
    } as any);

    expect(result.nodes.map((n) => n.summary)).toEqual(["Missing filters defensive query"]);
  });

  it("text_search composed entirely of stop words is treated as no filter (returns all candidates)", async () => {
    const orgId = await seedGraph([
      {
        type: "pattern",
        summary: "Use Redis for session caching",
        details: "",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
      {
        type: "pattern",
        summary: "Prefer CDN for static assets",
        details: "",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
    ]);

    // "the a an is" are all stop words — extractKeywords returns empty set.
    // The text_search filter must be skipped entirely, not collapse results to zero.
    const q = queryKnowledge(orgId, {
      filters: { domains: ["backend"], text_search: "the a an is" },
      max_tokens: 500,
    });

    expect(q.nodes.length).toBe(2);
  });

  it("filters low-confidence nodes by default but allows explicit opt-in", async () => {
    const orgId = await seedGraph([
      {
        type: "pattern",
        summary: "High confidence retrieval pattern",
        details: "",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.8,
      },
      {
        type: "pattern",
        summary: "Low confidence retrieval guess",
        details: "",
        domains: ["backend"],
        confidence: "inferred",
        confidence_score: 0.69,
      },
    ]);

    const defaultQuery = queryKnowledge(orgId, {
      filters: { domains: ["backend"] },
      max_tokens: 500,
    });
    expect(defaultQuery.nodes.map((n) => n.summary)).toEqual(["High confidence retrieval pattern"]);

    const explicitLowConfidence = queryKnowledge(orgId, {
      filters: { domains: ["backend"], confidence_min: 0 },
      max_tokens: 500,
    });
    expect(explicitLowConfidence.nodes.map((n) => n.summary).sort()).toEqual([
      "High confidence retrieval pattern",
      "Low confidence retrieval guess",
    ]);
  });

  it("merges filters.keywords with text_search tokens for scoring", async () => {
    const orgId = await seedGraph([
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

    const q = queryKnowledge(orgId, {
      filters: {
        domains: ["infra"],
        text_search: "migration",
        keywords: ["zebra"],
      },
      max_tokens: 500,
    });

    expect(q.nodes[0]?.summary.toLowerCase()).toContain("zebra");
  });

  it("returns no nodes when a semantic query has no useful cosine match", async () => {
    const orgId = await seedGraph([
      {
        type: "pattern",
        summary: "Session mtime cache invalidation pattern",
        details: "Use file modification timestamps to detect cache invalidation.",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
      {
        type: "pattern",
        summary: "Webhook payload structure convention",
        details: "Normalize inbound webhook payloads before persistence.",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
    ]);
    for (const node of getGraph(orgId).nodes) {
      node.embedding = [1, 0, 0];
    }

    const q = queryKnowledge(orgId, {
      filters: { domains: ["backend"] },
      max_tokens: 20_000,
      query_embedding: [0, 1, 0],
    });

    expect(q.nodes).toHaveLength(0);
    expect(q.total_matching).toBe(0);
    expect(q.token_estimate).toBe(0);
    expect(q.truncated).toBe(false);
  });

  it("returns type-filtered candidates when query_text semantic scoring is weak", async () => {
    const orgId = await seedGraph([
      {
        type: "decision",
        summary: "Use PKCE for standalone MCP authentication",
        details: "Desktop clients use loopback OAuth with PKCE.",
        domains: ["auth"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
      {
        type: "pattern",
        summary: "Cache static UI assets at the edge",
        details: "Use immutable URLs for bundled assets.",
        domains: ["frontend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
    ]);
    for (const node of getGraph(orgId).nodes) {
      node.embedding = [1, 0, 0];
    }

    const q = queryKnowledge(orgId, {
      filters: { types: ["decision"] },
      max_tokens: 20_000,
      query_text: "unrelated deployment checklist",
      query_embedding: [0, 1, 0],
    });

    expect(q.nodes.map((n) => n.summary)).toEqual(["Use PKCE for standalone MCP authentication"]);
    expect(q.total_matching).toBe(1);
  });

  it("maps legacy domains to canonical scopes during ingestion and query filtering", async () => {
    const orgId = await seedGraph([
      {
        type: "pattern",
        summary: "Backend webhook scope compatibility pattern",
        details: "Legacy domains should be queryable through canonical scopes.",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
    ]);

    const byScope = queryKnowledge(orgId, {
      filters: { scopes: ["backend"] },
      max_tokens: 2000,
    });
    const byDomain = queryKnowledge(orgId, {
      filters: { domains: ["backend"] },
      max_tokens: 2000,
    });

    expect(byScope.nodes.map((n) => n.summary)).toEqual(["Backend webhook scope compatibility pattern"]);
    expect(byDomain.nodes.map((n) => n.summary)).toEqual(["Backend webhook scope compatibility pattern"]);
    expect(byScope.nodes[0].domains).toEqual(["backend"]);
    expect(byScope.nodes[0].scopes).toEqual(["backend"]);
  });

  it("drops learnings with neither scopes nor domains in core graph ingestion", async () => {
    const orgId = nextOrgId("kg-test");
    initializeKnowledgeGraph(orgId);
    const learning = {
      type: "pattern" as const,
      summary: "Untagged learning should be dropped",
      details: "Direct callers can bypass the gateway, so the core graph must reject unscoped nodes too.",
      confidence: "extracted" as const,
      confidence_score: 0.9,
    } as EnhancedPodLearning;

    const result = await addLearningsToGraph(orgId, [learning], "pod-untagged", "Untagged Pod");

    expect(result).toEqual({ nodesAdded: 0, edgesAdded: 0, nodeIds: [] });
    expect(getGraph(orgId).nodes).toHaveLength(0);
  });

  it("returns legacy broad context in legacy contract mode even when taskQuery is supplied", async () => {
    const orgId = await seedGraph([
      {
        type: "pattern",
        summary: "CDN cache pattern",
        details: "Cache immutable assets at the edge.",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
      {
        type: "pattern",
        summary: "Webhook authentication pattern",
        details: "Prefer signature verification for payment webhooks.",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
    ]);
    orgSettingsState.kgContextContract = "legacy";

    const result = await getContractedRelevantLearnings(orgId, {
      scopes: ["backend"],
      taskQuery: "webhook authentication",
      maxTokens: 2000,
    });

    expect(result.context_contract).toEqual({
      mode: "legacy",
      returned_mode: "legacy",
      task_query_used: true,
      possible_constraints: true,
      note: expect.stringContaining("Legacy keyword KG context"),
    });
    expect(result.compact_context).toContain("PIM KG Compact Context");
    expect(result.compact_context).toContain("Possible KG constraints");
    expect(result.compact_context).toContain("webhook authentication");
    expect(result.nodes).toHaveLength(2);
    expect(result.nodes[0]?.summary).toBe("Webhook authentication pattern");
    expect(result.explanations).toBeUndefined();
  });

  it("returns compact task-relevant constraints with explanations in task_relevant mode", async () => {
    const orgId = await seedGraph([
      {
        type: "decision",
        summary: "Use webhook signatures for payment callbacks",
        details: "Payment callbacks must validate webhook signatures before processing.",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.92,
      },
      {
        type: "anti_pattern",
        summary: "Avoid unsigned payment callback handling",
        details: "Unsigned callbacks can be spoofed and should be rejected.",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
      {
        type: "pattern",
        summary: "Cache static assets at the CDN edge",
        details: "This frontend pattern is unrelated to payment callback handling.",
        domains: ["frontend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
    ]);
    orgSettingsState.kgContextContract = "task_relevant";

    const result = await getContractedRelevantLearnings(orgId, {
      scopes: ["backend"],
      taskQuery: "payment webhook callback signature verification",
      maxTokens: 2000,
    });

    expect(result.context_contract?.returned_mode).toBe("task_relevant");
    expect(result.context_contract?.task_query_used).toBe(true);
    expect(result.nodes.length).toBeGreaterThan(0);
    expect(result.nodes.length).toBeLessThanOrEqual(5);
    expect(result.nodes.map((n) => n.summary)).not.toContain("Cache static assets at the CDN edge");
    expect(result.compact_context).toContain("PIM KG Compact Context");
    expect(result.compact_context).toContain("task prompt API/input/output shape is authoritative");
    expect(result.compact_context).toContain("payment webhook callback signature verification");
    expect(result.compact_context).toContain("Use webhook signatures for payment callbacks");
    expect(result.compact_context).not.toContain("Cache static assets at the CDN edge");
    expect(result.compact_context).not.toContain("Seed Pod");
    expect(result.compact_context!.length).toBeLessThanOrEqual(1000);
    expect(result.explanations?.length).toBe(result.nodes.length);
    expect(result.explanations?.[0].node_id).toBe(result.nodes[0].id);
    expect(result.explanations?.some((e) => e.strength === "avoid")).toBe(true);
  });

  it("clips an overlong first compact signal instead of dropping the signals line", async () => {
    const longScope = `backend-${"x".repeat(360)}`;
    const orgId = await seedGraph([
      {
        type: "decision",
        summary: "Use scoped webhook validation",
        details: "Webhook validation constraints should retain retrieval signals.",
        domains: [longScope],
        confidence: "extracted",
        confidence_score: 0.92,
      },
    ]);
    orgSettingsState.kgContextContract = "task_relevant";

    const result = await getContractedRelevantLearnings(orgId, {
      scopes: [longScope],
      taskQuery: "webhook validation",
      maxTokens: 2000,
    });

    expect(result.compact_context).toContain("  - Signals: scope:");
    expect(result.compact_context).toContain("...");
  });

  it("keeps compact context within tiny configured max char budgets", async () => {
    process.env.PIM_KG_COMPACT_CONTEXT_MAX_CHARS = "10";
    const orgId = await seedGraph([
      {
        type: "decision",
        summary: "Keep context budget bounded",
        details: "Compact context must not exceed its configured character limit.",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.92,
      },
    ]);
    orgSettingsState.kgContextContract = "task_relevant";

    const result = await getContractedRelevantLearnings(orgId, {
      scopes: ["backend"],
      taskQuery: "context budget",
      maxTokens: 2000,
    });

    expect(result.compact_context?.length).toBeLessThanOrEqual(10);
  });

  it("reports compact-context unseen matches from the number of nodes actually shown", async () => {
    process.env.PIM_KG_COMPACT_CONTEXT_TOP_N = "3";
    const orgId = await seedGraph(Array.from({ length: 10 }, (_, i) => ({
      type: "pattern" as const,
      summary: `Backend webhook pattern ${i}`,
      details: "Backend webhook validation guidance.",
      domains: ["backend"],
      confidence: "extracted" as const,
      confidence_score: 0.9,
    })));
    orgSettingsState.kgContextContract = "task_relevant";

    const result = await getContractedRelevantLearnings(orgId, {
      scopes: ["backend"],
      taskQuery: "backend webhook validation",
      maxTokens: 2000,
    });

    expect(result.nodes).toHaveLength(5);
    expect(result.total_matching).toBe(10);
    expect(result.compact_context).toContain("Retrieval had 5 additional match(es) not shown");
  });

  it("returns a tiny possible_constraints block without taskQuery in task_relevant mode", async () => {
    const orgId = await seedGraph(Array.from({ length: 5 }, (_, i) => ({
      type: "pattern" as const,
      summary: `Backend broad constraint ${i}`,
      details: "Broad scope context should be compact when no task query is present.",
      domains: ["backend"],
      confidence: "extracted" as const,
      confidence_score: 0.9,
    })));
    orgSettingsState.kgContextContract = "task_relevant";

    const result = await getContractedRelevantLearnings(orgId, {
      scopes: ["backend"],
      maxTokens: 2000,
    });

    expect(result.context_contract?.possible_constraints).toBe(true);
    expect(result.context_contract?.note).toContain("query_knowledge");
    expect(result.compact_context).toContain("Possible KG constraints");
    expect(result.nodes).toHaveLength(3);
    expect(result.explanations).toHaveLength(3);
  });

  it("pins required nodes into compact task-relevant results", async () => {
    const orgId = await seedGraph(Array.from({ length: 5 }, (_, i) => ({
      type: "pattern" as const,
      summary: `Backend compact constraint ${i}`,
      details: "Compact context should still honor explicit oracle-required nodes.",
      domains: ["backend"],
      confidence: "extracted" as const,
      confidence_score: 0.9,
    })));
    const requiredId = getGraph(orgId).nodes[4].id;
    orgSettingsState.kgContextContract = "task_relevant";

    const result = await getContractedRelevantLearnings(orgId, {
      scopes: ["backend"],
      maxTokens: 2000,
      requiredNodeIds: [requiredId],
    });

    expect(result.nodes.map((n) => n.id)).toContain(requiredId);
    expect(result.nodes).toHaveLength(3);
  });

  it("returns legacy context in shadow mode while logging comparison metrics", async () => {
    const orgId = await seedGraph([
      {
        type: "pattern",
        summary: "Webhook authentication pattern",
        details: "Prefer signature verification for payment webhooks.",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
      {
        type: "pattern",
        summary: "CDN cache pattern",
        details: "Cache immutable assets at the edge.",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
    ]);
    const requiredId = getGraph(orgId).nodes[0].id;
    orgSettingsState.kgContextContract = "shadow";
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const result = await getContractedRelevantLearnings(orgId, {
      scopes: ["backend"],
      taskQuery: "webhook authentication",
      maxTokens: 2000,
      requiredNodeIds: [requiredId],
    });

    expect(result.context_contract?.mode).toBe("shadow");
    expect(result.context_contract?.returned_mode).toBe("legacy");
    expect(result.nodes).toHaveLength(2);
    expect(infoSpy).toHaveBeenCalledWith(
      "[knowledge-graph] kg_context_contract shadow",
      expect.objectContaining({
        mode: "shadow",
        legacy_required_hits: expect.any(Number),
        task_relevant_required_hits: expect.any(Number),
      }),
    );
    infoSpy.mockRestore();
  });

  it("logs structured shadow failure fields when task-relevant comparison throws", async () => {
    const orgId = await seedGraph([
      {
        type: "pattern",
        summary: "Webhook authentication pattern",
        details: "Prefer signature verification for payment webhooks.",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
    ]);
    orgSettingsState.kgContextContract = "shadow";
    vi.mocked(getOrgTuning)
      .mockReturnValueOnce(DEFAULT_ORG_TUNING)
      .mockImplementationOnce(() => {
        throw new Error("tuning unavailable");
      });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await getContractedRelevantLearnings(orgId, {
      scopes: ["backend"],
      taskQuery: "webhook authentication",
      maxTokens: 2000,
      requiredNodeIds: [getGraph(orgId).nodes[0].id],
    });

    expect(result.context_contract?.returned_mode).toBe("legacy");
    expect(warnSpy).toHaveBeenCalledWith(
      "[knowledge-graph] kg_context_contract shadow comparison failed",
      expect.objectContaining({
        org_id: orgId,
        mode: "shadow",
        scopes: ["backend"],
        task_query_present: true,
        required_node_ids: [getGraph(orgId).nodes[0].id],
        error: "tuning unavailable",
      }),
    );
    warnSpy.mockRestore();
    vi.mocked(getOrgTuning).mockReturnValue(DEFAULT_ORG_TUNING);
  });

  it("respects confidence_min when filtered query_text semantic scoring is weak", async () => {
    const orgId = await seedGraph([
      {
        type: "pattern",
        summary: "High confidence auth retry pattern",
        details: "Retry access-token refresh once before surfacing auth failure.",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
      {
        type: "pattern",
        summary: "Low confidence auth retry guess",
        details: "Tentative note that should stay filtered out.",
        domains: ["backend"],
        confidence: "inferred",
        confidence_score: 0.6,
      },
    ]);
    for (const node of getGraph(orgId).nodes) {
      node.embedding = [1, 0, 0];
    }

    const q = queryKnowledge(orgId, {
      filters: { confidence_min: 0.85 },
      max_tokens: 20_000,
      query_text: "unrelated release note",
      query_embedding: [0, 1, 0],
    });

    expect(q.nodes.map((n) => n.summary)).toEqual(["High confidence auth retry pattern"]);
    expect(q.total_matching).toBe(1);
  });

  it("broad query_text with weak semantic and no keyword match still returns zero", async () => {
    const orgId = await seedGraph([
      {
        type: "pattern",
        summary: "Session mtime cache invalidation pattern",
        details: "Use file modification timestamps to detect cache invalidation.",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
    ]);
    getGraph(orgId).nodes[0].embedding = [1, 0, 0];

    const q = queryKnowledge(orgId, {
      filters: {},
      max_tokens: 20_000,
      query_text: "mobile checkout animation storyboard",
      query_embedding: [0, 1, 0],
    });

    expect(q.nodes).toHaveLength(0);
    expect(q.total_matching).toBe(0);
  });

  it("does not let a bare HTTP verb identifier rescue unrelated semantic results", async () => {
    const orgId = await seedGraph([
      {
        type: "pattern",
        summary: "Token refresh API contract",
        details: "Use POST /auth/token when refreshing session credentials.",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
    ]);
    getGraph(orgId).nodes[0].embedding = [1, 0, 0];

    const q = queryKnowledge(orgId, {
      filters: { domains: ["backend"] },
      max_tokens: 20_000,
      query_text: "POST deployment update dashboard animation storyboard",
      query_embedding: [0, 1, 0],
    });

    expect(q.nodes).toHaveLength(0);
    expect(q.total_matching).toBe(0);
  });

  it("does not use a domain-only fallback when semantic query_text has no useful match", async () => {
    const orgId = await seedGraph([
      {
        type: "pattern",
        summary: "Backend webhook payload retry policy",
        details: "Retry webhook delivery with exponential backoff.",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
    ]);
    getGraph(orgId).nodes[0].embedding = [1, 0, 0];

    const q = queryKnowledge(orgId, {
      filters: { domains: ["backend"] },
      max_tokens: 20_000,
      query_text: "mobile checkout animation storyboard",
      query_embedding: [0, 1, 0],
    });

    expect(q.nodes).toHaveLength(0);
    expect(q.total_matching).toBe(0);
  });

  it("uses scope-only filtered candidates as semantic recall fallback", async () => {
    const orgId = await seedGraph([
      {
        type: "pattern",
        summary: "Backend queue retry policy",
        details: "Retry queue delivery with exponential backoff.",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
    ]);
    getGraph(orgId).nodes[0].embedding = [1, 0, 0];

    const q = queryKnowledge(orgId, {
      filters: { scopes: ["backend"] },
      max_tokens: 20_000,
      query_text: "mobile checkout animation storyboard",
      query_embedding: [0, 1, 0],
    });

    expect(q.nodes.map((n) => n.summary)).toEqual(["Backend queue retry policy"]);
    expect(q.total_matching).toBe(1);
  });

  it("keeps exact short keyword matches even when semantic similarity is weak", async () => {
    const orgId = await seedGraph([
      {
        type: "pattern",
        summary: "EMC frontend route shell layout pattern",
        details: "EMC pages share global shell navigation and layout conventions.",
        domains: ["frontend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
      {
        type: "pattern",
        summary: "Timing framework schedule positioning",
        details: "Schedule position is computed from toggle time traversal.",
        domains: ["frontend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
    ]);
    for (const node of getGraph(orgId).nodes) {
      node.embedding = [1, 0, 0];
    }

    const q = queryKnowledge(orgId, {
      filters: {},
      max_tokens: 20_000,
      query_text: "EMC",
      query_embedding: [0, 1, 0],
    });

    expect(q.nodes.map((n) => n.summary)).toEqual(["EMC frontend route shell layout pattern"]);
    expect(q.total_matching).toBe(1);
  });

  it("recalls RBAC context for short natural questions through rare exact-term lookup", async () => {
    const orgId = await seedGraph([
      {
        type: "pattern",
        summary: "RBAC permission gating uses useHasPermission",
        details: "Permissions use event:write and event:delete checks before rendering write actions.",
        domains: ["frontend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
      {
        type: "pattern",
        summary: "Checkout animation storyboard timing",
        details: "Motion timing for the mobile checkout storyboard.",
        domains: ["frontend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
    ]);
    const rbacNode = getGraph(orgId).nodes.find((n) => n.summary.includes("RBAC"))!;
    const animationNode = getGraph(orgId).nodes.find((n) => n.summary.includes("animation"))!;
    rbacNode.embedding = [1, 0, 0];
    animationNode.embedding = [0, 1, 0];

    const q = queryKnowledge(orgId, {
      filters: { domains: ["frontend"] },
      max_tokens: 20_000,
      query_text: "how is rbac implemented",
      query_embedding: [0, 1, 0],
    });

    expect(q.nodes[0]?.summary).toBe("RBAC permission gating uses useHasPermission");
    expect(q.nodes.map((n) => n.summary)).toContain("Checkout animation storyboard timing");
  });

  it.each(["x-adobe-esp-group-id", "event:write", "useHasPermission"])(
    "force-recalls exact query signal %s despite weak cosine similarity",
    async (signal) => {
      const orgId = await seedGraph([
        {
          type: "pattern",
          summary: "ESP RBAC UI permission contract",
          details: "API requests inject x-adobe-esp-group-id, and UI actions gate writes with useHasPermission and event:write.",
          domains: ["frontend"],
          confidence: "extracted",
          confidence_score: 0.9,
        },
        {
          type: "pattern",
          summary: "Semantically strong unrelated checkout result",
          details: "This node is intentionally closest to the supplied embedding.",
          domains: ["frontend"],
          confidence: "extracted",
          confidence_score: 0.9,
        },
      ]);
      const target = getGraph(orgId).nodes.find((n) => n.summary.includes("ESP RBAC"))!;
      const distractor = getGraph(orgId).nodes.find((n) => n.summary.includes("checkout"))!;
      target.embedding = [1, 0, 0];
      distractor.embedding = [0, 1, 0];

      const q = queryKnowledge(orgId, {
        filters: { domains: ["frontend"] },
        max_tokens: 20_000,
        query_text: signal,
        query_embedding: [0, 1, 0],
      });

      expect(q.nodes[0]?.summary).toBe("ESP RBAC UI permission contract");
    },
  );

  it("does not rescue low-signal short generic questions when semantic similarity is weak", async () => {
    const orgId = await seedGraph([
      {
        type: "pattern",
        summary: "Current status implementation note",
        details: "A generic status note should not be recalled by low-signal query words alone.",
        domains: ["frontend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
    ]);
    getGraph(orgId).nodes[0].embedding = [1, 0, 0];

    const q = queryKnowledge(orgId, {
      filters: {},
      max_tokens: 20_000,
      query_text: "current status",
      query_embedding: [0, 1, 0],
    });

    expect(q.nodes).toHaveLength(0);
    expect(q.total_matching).toBe(0);
  });

  it("keeps project filters authoritative for lexical recall matches", async () => {
    const orgId = nextOrgId("kg-project-lexical");
    initializeKnowledgeGraph(orgId);
    await addLearningsToGraph(
      orgId,
      [
        {
          type: "pattern",
          summary: "Beta project useHasPermission gating",
          details: "Project Beta gates event:write actions with useHasPermission.",
          domains: ["frontend"],
          confidence: "extracted",
          confidence_score: 0.9,
        },
      ],
      "pod-beta",
      "Beta Pod",
      { project_id: "proj-beta", project_name: "Beta" },
    );
    getGraph(orgId).nodes[0].embedding = [1, 0, 0];

    const q = queryKnowledge(orgId, {
      filters: { include_project_id: "proj-alpha" },
      max_tokens: 20_000,
      query_text: "useHasPermission",
      query_embedding: [0, 1, 0],
    });

    expect(q.nodes).toHaveLength(0);
    expect(q.total_matching).toBe(0);
  });

  it("does not let partial keyword overlap from a long semantic query bypass the gate", async () => {
    const orgId = await seedGraph([
      {
        type: "pattern",
        summary: "Session mtime cache invalidation pattern",
        details: "Use file modification timestamps during session updates.",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
    ]);
    getGraph(orgId).nodes[0].embedding = [1, 0, 0];

    const q = queryKnowledge(orgId, {
      filters: {},
      max_tokens: 20_000,
      query_text: "PIM pod agent protocol requires pulling session context before substantive work",
      query_embedding: [0, 1, 0],
    });

    expect(q.nodes).toHaveLength(0);
    expect(q.total_matching).toBe(0);
  });

  it("returns strong semantic matches after applying the cosine relevance gate", async () => {
    const orgId = await seedGraph([
      {
        type: "pattern",
        summary: "OAuth token refresh retry strategy",
        details: "Refresh expired access tokens once before surfacing auth failures.",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
      {
        type: "pattern",
        summary: "Static asset CDN cache policy",
        details: "Use immutable URLs for long-lived static asset caching.",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
    ]);
    const authNode = getGraph(orgId).nodes.find((n) => n.summary.includes("OAuth"));
    const cdnNode = getGraph(orgId).nodes.find((n) => n.summary.includes("CDN"));
    expect(authNode).toBeDefined();
    expect(cdnNode).toBeDefined();
    authNode!.embedding = [0, 1, 0];
    cdnNode!.embedding = [1, 0, 0];

    const q = queryKnowledge(orgId, {
      filters: { domains: ["backend"] },
      max_tokens: 20_000,
      query_embedding: [0, 1, 0],
    });

    expect(q.nodes.map((n) => n.summary)).toEqual(["OAuth token refresh retry strategy"]);
    expect(q.total_matching).toBe(1);
  });

  it("keeps domain fallback behavior for non-semantic queries", async () => {
    const orgId = await seedGraph([
      {
        type: "pattern",
        summary: "Backend queue retry policy",
        details: "",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
      {
        type: "pattern",
        summary: "Backend worker concurrency limit",
        details: "",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
    ]);
    for (const node of getGraph(orgId).nodes) {
      node.embedding = [1, 0, 0];
    }

    const q = queryKnowledge(orgId, {
      filters: { domains: ["backend"] },
      max_tokens: 20_000,
    });

    expect(q.nodes.map((n) => n.summary).sort()).toEqual([
      "Backend queue retry policy",
      "Backend worker concurrency limit",
    ]);
    expect(q.total_matching).toBe(2);
  });

  it("does not return unembedded nodes for embedding-only queries with no keyword overlap", async () => {
    const orgId = await seedGraph([
      {
        type: "pattern",
        summary: "Legacy unembedded backend learning",
        details: "Created before embedding backfill completed.",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
    ]);
    getGraph(orgId).nodes[0].embedding = undefined;

    const q = queryKnowledge(orgId, {
      filters: { domains: ["backend"] },
      max_tokens: 20_000,
      query_embedding: [0, 1, 0],
    });

    expect(q.nodes).toHaveLength(0);
    expect(q.total_matching).toBe(0);
  });

  it("returns unembedded nodes when query_text keyword overlap is strong", async () => {
    const orgId = await seedGraph([
      {
        type: "pattern",
        summary: "Legacy unembedded backend learning",
        details: "Created before embedding backfill completed.",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
    ]);
    getGraph(orgId).nodes[0].embedding = undefined;

    const q = queryKnowledge(orgId, {
      filters: { domains: ["backend"] },
      max_tokens: 20_000,
      query_text: "legacy unembedded backend learning",
      query_embedding: [0, 1, 0],
    });

    expect(q.nodes).toHaveLength(1);
    expect(q.nodes[0]?.summary).toContain("unembedded");
  });

  it("falls back to keyword ranking when semantic gate matches nothing", async () => {
    const orgId = await seedGraph([
      {
        type: "pattern",
        summary: "Redis session cache invalidation pattern",
        details: "Use Redis TTL for session expiry.",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
      {
        type: "pattern",
        summary: "Webhook payload structure convention",
        details: "Normalize inbound webhook payloads before persistence.",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
    ]);
    for (const node of getGraph(orgId).nodes) {
      node.embedding = [1, 0, 0];
    }

    const q = queryKnowledge(orgId, {
      filters: { domains: ["backend"] },
      max_tokens: 20_000,
      query_text: "redis session cache",
      query_embedding: [0, 1, 0],
    });

    expect(q.nodes.map((n) => n.summary)).toEqual(["Redis session cache invalidation pattern"]);
  });

  it("getRelevantLearnings with projectId filters out nodes tagged to other projects", async () => {
    const orgId = nextOrgId("kg-test");
    initializeKnowledgeGraph(orgId);
    const base: EnhancedPodLearning = {
      type: "decision",
      details: "",
      domains: ["backend"],
      confidence: "extracted",
      confidence_score: 0.9,
      summary: "",
    };
    await addLearningsToGraph(orgId, [{ ...base, summary: "Shared org learning" }], "pod-a", "Pod A");
    await addLearningsToGraph(
      orgId,
      [{ ...base, summary: "Project Alpha decision" }],
      "pod-b",
      "Pod B",
      { project_id: "proj-alpha", project_name: "Alpha" },
    );
    await addLearningsToGraph(
      orgId,
      [{ ...base, summary: "Project Beta decision" }],
      "pod-c",
      "Pod C",
      { project_id: "proj-beta", project_name: "Beta" },
    );

    const forAlpha = await getRelevantLearnings(orgId, ["backend"], [], 2000, "proj-alpha");
    const summaries = forAlpha.nodes.map(n => n.summary);
    expect(summaries.some(s => s.includes("Shared org"))).toBe(true);
    expect(summaries.some(s => s.includes("Project Alpha"))).toBe(true);
    expect(summaries.some(s => s.includes("Project Beta"))).toBe(false);
  });

});

describe("retention scoring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
    orgSettingsState.kgContextContract = "legacy";
  });

  it("moves stale, low-retention nodes to cold without deleting historical memory", async () => {
    const orgId = nextOrgId("kg-prune");
    initializeKnowledgeGraph(orgId);

    const old = new Date("2024-01-01T00:00:00Z").toISOString();
    const recent = new Date().toISOString();
    const ages: { id: string; created_at: string; confidence_score: number; curated: boolean; superseded?: boolean }[] = [
      { id: "kn-stale-junk", created_at: old, confidence_score: 0.3, curated: false }, // SHOULD prune
      { id: "kn-curated-old", created_at: old, confidence_score: 0.3, curated: true }, // protected (curated)
      { id: "kn-recent-junk", created_at: recent, confidence_score: 0.1, curated: false }, // protected (recent)
      { id: "kn-old-confident", created_at: old, confidence_score: 0.8, curated: false }, // protected (high confidence)
      { id: "kn-old-superseded", created_at: old, confidence_score: 0.3, curated: false, superseded: true }, // protected (superseded)
    ];

    const graph = getGraph(orgId);
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

    const result = pruneStaleNodes(orgId);
    expect(result.removed).toBe(0);
    expect(result.moved_to_cold).toBe(1);
    const ids = getGraph(orgId).nodes.map((n) => n.id);
    expect(ids).toContain("kn-stale-junk");
    expect(ids).toContain("kn-curated-old");
    expect(ids).toContain("kn-recent-junk");
    expect(ids).toContain("kn-old-confident");
    expect(ids).toContain("kn-old-superseded");
    expect(getGraph(orgId).nodes.find((n) => n.id === "kn-stale-junk")?.retrieval_tier).toBe("cold");
    expect(getGraph(orgId).nodes.find((n) => n.id === "kn-recent-junk")?.retrieval_tier).not.toBe("cold");

    const current = queryKnowledge(orgId, {
      filters: { domains: ["backend"], confidence_min: 0 },
      max_tokens: 2000,
    });
    const currentIds = current.nodes.map((n) => n.id);
    expect(currentIds).not.toContain("kn-stale-junk");
    expect(currentIds).toContain("kn-recent-junk");
  });

  it("returns 0 removed on an empty graph", () => {
    const orgId = nextOrgId("kg-prune-empty");
    initializeKnowledgeGraph(orgId);
    expect(pruneStaleNodes(orgId).removed).toBe(0);
  });

  it("cold nodes are absent from current queries but available to history queries", async () => {
    // Verify the index is rebuilt after retention scoring so current queries reflect tiering.
    const orgId = nextOrgId("kg-prune-index");
    initializeKnowledgeGraph(orgId);

    // Seed a kept node so the domain index has at least one entry.
    await addLearningsToGraph(
      orgId,
      [
        {
          type: "pattern",
          summary: "Kept survivor node for backend",
          details: "",
          domains: ["backend"],
          confidence: "extracted",
          confidence_score: 0.9,
        },
      ],
      "pod-prune-idx",
      "Prune Index Pod",
    );

    // Directly push the stale node into graph.nodes (index will be built by pruneStaleNodes rebuild).
    rawPushNode(orgId, {
      id: "kn-prune-idx-stale",
      summary: "Stale backend pattern to prune",
      domains: ["backend"],
      confidence_score: 0.3,
      curated: false,
      created_at: new Date("2024-01-01T00:00:00Z").toISOString(),
    });

    // Confirm both nodes exist before pruning.
    expect(getGraph(orgId).nodes.length).toBe(2);

    pruneStaleNodes(orgId);

    // After scoring the stale node remains in graph.nodes...
    const remainingIds = getGraph(orgId).nodes.map((n) => n.id);
    expect(remainingIds).toContain("kn-prune-idx-stale");

    // ...but a current domain query must not surface the cold node.
    const current = queryKnowledge(orgId, {
      filters: { domains: ["backend"] },
      max_tokens: 2000,
    });
    const currentIds = current.nodes.map((n) => n.id);
    expect(currentIds).not.toContain("kn-prune-idx-stale");
    expect(currentIds.some((id) => id !== "kn-prune-idx-stale")).toBe(true);

    const history = queryKnowledge(orgId, {
      filters: { domains: ["backend"], retrieval_tiers: ["hot", "warm", "cold"], confidence_min: 0 },
      query_mode: "history",
      max_tokens: 2000,
    });
    expect(history.nodes.map((n) => n.id)).toContain("kn-prune-idx-stale");
  });
});

describe("text_search index behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
    orgSettingsState.kgContextContract = "legacy";
  });

  it("text_search returns matching nodes and excludes non-matching ones", async () => {
    // Gap 4: exercise filters.text_search through the keyword index path specifically.
    const orgId = await seedGraph([
      {
        type: "pattern",
        summary: "Redis caching strategy for session management",
        details: "",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.85,
      },
      {
        type: "pattern",
        summary: "Webpack bundle splitting for faster load",
        details: "",
        domains: ["frontend"],
        confidence: "extracted",
        confidence_score: 0.85,
      },
    ]);

    // Search on a term that appears only in the first node.
    const q = queryKnowledge(orgId, {
      filters: { text_search: "redis" },
      max_tokens: 2000,
    });

    expect(q.nodes.length).toBe(1);
    expect(q.nodes[0].summary.toLowerCase()).toContain("redis");
    expect(q.nodes.some((n) => n.summary.toLowerCase().includes("webpack"))).toBe(false);
  });

  it("text_search with no matching term returns an empty result set", async () => {
    // Gap 4 (exclusion path): non-matching text_search must yield empty results,
    // not fall through to a full-scan default.
    const orgId = await seedGraph([
      {
        type: "pattern",
        summary: "GraphQL schema stitching pattern",
        details: "",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.85,
      },
    ]);

    const q = queryKnowledge(orgId, {
      filters: { text_search: "kubernetes" },
      max_tokens: 2000,
    });

    expect(q.nodes).toHaveLength(0);
    expect(q.total_matching).toBe(0);
  });

  it("extracts technical identifiers without treating bare HTTP verbs as identifiers", () => {
    const text = "prepareEslEventPutPayload strips detailPagePath from PUT /events/{eventId} for ESP API CURRENT calls in dataFilters.ts and readOnly.openapi.validation failures.";
    const ids = [...extractIdentifiers(text)];

    expect(ids).toEqual(
      expect.arrayContaining([
        "prepareesleventputpayload",
        "detailpagepath",
        "put /events/{eventid}",
        "esp",
        "api",
        "current",
        "datafilters.ts",
        "readonly.openapi.validation",
      ]),
    );
    expect(ids).not.toContain("put");
    const retrievalIds = [...extractRetrievalIdentifiers(text)];
    expect(retrievalIds).toEqual(expect.arrayContaining(["prepareesleventputpayload", "put /events/{eventid}"]));
    expect(retrievalIds).not.toContain("api");
    expect(retrievalIds).not.toContain("current");
    expect(retrievalIds).not.toContain("put");
  });

  it("extracts strong retrieval signals and excludes low-signal query terms", () => {
    const text = [
      "RBAC calls useHasPermission before event:write and scope-team:* actions.",
      "Requests include x-adobe-esp-group-id for GET /v1/events/{eventId}.",
      "Do not index short root paths like /v1 or /api as useful identifiers.",
      "Fallback handlers live in dataFilters.ts, while CURRENT STATUS IMPLEMENTED HOW are generic.",
    ].join(" ");

    const retrievalIds = [...extractRetrievalIdentifiers(text)];

    expect(retrievalIds).toEqual(
      expect.arrayContaining([
        "rbac",
        "usehaspermission",
        "event:write",
        "scope-team:*",
        "x-adobe-esp-group-id",
        "get /v1/events/{eventid}",
        "/v1/events/{eventid}",
        "datafilters.ts",
      ]),
    );
    expect(retrievalIds).not.toEqual(
      expect.arrayContaining(["/v1", "/api", "current", "status", "implemented", "how"]),
    );
  });

  it("filters low-signal query keywords before scoring longer task queries", async () => {
    const orgId = await seedGraph([
      {
        type: "pattern",
        summary: "Webhook authentication contract",
        details: "Webhook authentication should use signed callbacks.",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
      {
        type: "pattern",
        summary: "Generic implementation status update",
        details: "How current status is implemented using existing work.",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
    ]);

    const result = queryKnowledge(orgId, {
      filters: { scopes: ["backend"] },
      query_text: "how current status implemented using existing work webhook authentication",
      max_tokens: 2000,
    });

    expect(result.nodes[0]?.summary).toBe("Webhook authentication contract");
  });
});

describe("retrieval text, temporal modes, and graph expansion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
    orgSettingsState.kgContextContract = "legacy";
  });

  it("indexes retrieval_text and uses identifiers to bypass weak semantic similarity", async () => {
    const orgId = await seedGraph([
      {
        type: "pattern",
        summary: "Token refresh retry behavior",
        details: "Retry token refresh once before showing auth failure.",
        retrieval_text: "Applies to SessionTokenService and POST /internal/session/refresh in the auth API contract.",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
    ]);
    getGraph(orgId).nodes[0].embedding = [1, 0, 0];

    const q = queryKnowledge(orgId, {
      filters: {},
      query_text: "SessionTokenService",
      query_embedding: [0, 1, 0],
      max_tokens: 2000,
    });

    expect(q.nodes).toHaveLength(1);
    expect(q.nodes[0].retrieval_text).toContain("SessionTokenService");
  });

	  it("supports current, history, and as_of modes for superseded decisions", async () => {
    const orgId = await seedGraph([
      {
        type: "decision",
        summary: "Use full replace for config inheritance",
        details: "Older config inheritance decision.",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
      {
        type: "decision",
        summary: "Use deep merge for config inheritance",
        details: "Newer config inheritance decision.",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
    ]);
    const graph = getGraph(orgId);
    const oldDecision = graph.nodes.find((n) => n.summary.includes("full replace"))!;
    const newDecision = graph.nodes.find((n) => n.summary.includes("deep merge"))!;
    oldDecision.created_at = "2026-01-01T00:00:00.000Z";
    newDecision.created_at = "2026-02-01T00:00:00.000Z";
    oldDecision.superseded_by = newDecision.id;
    newDecision.superseded_by = undefined;
    graph.edges.push({
      source: newDecision.id,
      target: oldDecision.id,
      type: "supersedes",
      weight: 0.95,
      reason: "Curated config inheritance decision replaced the older decision.",
      confidence_score: 0.95,
      source_update_refs: ["ctx-config-inheritance-decision"],
    });

    const current = queryKnowledge(orgId, {
      filters: { domains: ["backend"], types: ["decision"] },
      max_tokens: 2000,
    });
    expect(current.nodes.map((n) => n.summary)).toEqual(["Use deep merge for config inheritance"]);

    const asOf = queryKnowledge(orgId, {
      filters: { domains: ["backend"], types: ["decision"] },
      query_mode: "as_of",
      as_of: "2026-01-15T00:00:00.000Z",
      max_tokens: 2000,
    });
    expect(asOf.nodes.map((n) => n.summary)).toEqual(["Use full replace for config inheritance"]);

    const history = queryKnowledge(orgId, {
      filters: { domains: ["backend"], types: ["decision"] },
      query_mode: "history",
      max_tokens: 2000,
    });
	    expect(history.nodes.map((n) => n.summary).sort()).toEqual([
	      "Use deep merge for config inheritance",
	      "Use full replace for config inheritance",
	    ]);
	  });

  it("keeps legacy superseded nodes hidden when supersedes edges lack new evidence metadata", async () => {
    const orgId = await seedGraph([
      {
        type: "decision",
        summary: "Use full replace for feature config",
        details: "Older feature config decision.",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
      {
        type: "decision",
        summary: "Use deep merge for feature config",
        details: "Newer feature config decision.",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
    ]);
    const graph = getGraph(orgId);
    const oldDecision = graph.nodes.find((n) => n.summary.includes("full replace"))!;
    const newDecision = graph.nodes.find((n) => n.summary.includes("deep merge"))!;
    oldDecision.superseded_by = newDecision.id;
    graph.edges.push({ source: newDecision.id, target: oldDecision.id, type: "supersedes", weight: 0.95 });

    const current = queryKnowledge(orgId, {
      filters: { domains: ["backend"], types: ["decision"] },
      max_tokens: 2000,
    });

    expect(current.nodes.map((n) => n.summary)).toEqual(["Use deep merge for feature config"]);
  });

  it("marks legacy supersedes edges on graph load even when superseded_by was not persisted", () => {
    const orgId = nextOrgId("kg-legacy-eval");
    const oldDecision = testNode({
      id: "kn-old-decision",
      type: "decision",
      summary: "Use full replace for loaded config",
      details: "Older loaded config decision.",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    const newDecision = testNode({
      id: "kn-new-decision",
      type: "decision",
      summary: "Use deep merge for loaded config",
      details: "Newer loaded config decision.",
      created_at: "2026-02-01T00:00:00.000Z",
    });

    loadGraphForOfflineEvaluation({
      version: 1,
      org_id: orgId,
      updated_at: "2026-02-01T00:00:00.000Z",
      nodes: [oldDecision, newDecision],
      edges: [{ source: newDecision.id, target: oldDecision.id, type: "supersedes", weight: 0.95 }],
      communities: [],
    });

    expect(getGraph(orgId).nodes.find((n) => n.id === oldDecision.id)?.superseded_by).toBe(newDecision.id);
    const current = queryKnowledge(orgId, {
      filters: { domains: ["backend"], types: ["decision"] },
      max_tokens: 2000,
    });
    expect(current.nodes.map((n) => n.id)).toEqual([newDecision.id]);
  });

  it("clears persisted superseded_by when no supersedes edge backs it", () => {
    const orgId = nextOrgId("kg-stale-superseded-eval");
    const oldDecision = testNode({
      id: "kn-stale-old-decision",
      type: "decision",
      summary: "Use stale flag for loaded config",
      details: "Older loaded config decision with a stale superseded marker.",
      superseded_by: "kn-stale-new-decision",
    });
    const newDecision = testNode({
      id: "kn-stale-new-decision",
      type: "decision",
      summary: "Use active flag for loaded config",
      details: "Newer loaded config decision that no edge currently supports.",
    });

    loadGraphForOfflineEvaluation({
      version: 1,
      org_id: orgId,
      updated_at: "2026-02-01T00:00:00.000Z",
      nodes: [oldDecision, newDecision],
      edges: [],
      communities: [],
    });

    expect(getGraph(orgId).nodes.find((n) => n.id === oldDecision.id)?.superseded_by).toBeUndefined();
    const current = queryKnowledge(orgId, {
      filters: { domains: ["backend"], types: ["decision"] },
      max_tokens: 2000,
    });
    expect(current.nodes.map((n) => n.id).sort()).toEqual([newDecision.id, oldDecision.id].sort());
  });

  it("does not auto-supersede unrelated same-project decisions", async () => {
    const orgId = nextOrgId("kg-decision-supersedes");
    initializeKnowledgeGraph(orgId);
    await addLearningsToGraph(
      orgId,
      [
        {
          type: "decision",
          summary: "Use config cache TTL for feature flags",
          details: "Cache feature flag config with a short TTL.",
          domains: ["backend"],
          confidence: "extracted",
          confidence_score: 0.9,
        },
        {
          type: "decision",
          summary: "Use config validation schema for feature flags",
          details: "Validate feature flag config before rollout.",
          domains: ["backend"],
          confidence: "extracted",
          confidence_score: 0.9,
        },
      ],
      "pod-decisions",
      "Decision Pod",
      { project_id: "proj-alpha", project_name: "Alpha" },
    );

    const graph = getGraph(orgId);
    expect(graph.edges.some((edge) => edge.type === "supersedes")).toBe(false);
    expect(graph.nodes.some((node) => node.superseded_by)).toBe(false);

    const current = queryKnowledge(orgId, {
      filters: { domains: ["backend"], types: ["decision"], include_project_id: "proj-alpha" },
      max_tokens: 2000,
    });
    expect(current.nodes.map((node) => node.summary).sort()).toEqual([
      "Use config cache TTL for feature flags",
      "Use config validation schema for feature flags",
    ]);
  });

  it("rejects as_of mode without a valid as_of timestamp", async () => {
    const orgId = await seedGraph([
      {
        type: "decision",
        summary: "Use temporal validation for KG",
        details: "Invalid temporal queries should fail loudly.",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
    ]);

    expect(() =>
      queryKnowledge(orgId, {
        filters: { domains: ["backend"] },
        query_mode: "as_of",
        max_tokens: 2000,
      }),
    ).toThrow(KnowledgeQueryValidationError);
  });

  it("adds capped one-hop graph neighbors from strong KG hits", async () => {
    const orgId = await seedGraph([
      {
        type: "pattern",
        summary: "OAuth token refresh retry strategy",
        details: "Refresh expired access tokens once before surfacing auth failures.",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
      {
        type: "resolved_conflict",
        summary: "Auth fallback conflict resolved by retry limit",
        details: "The prior conflict was resolved by limiting refresh retries.",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
    ]);
    const graph = getGraph(orgId);
    const pattern = graph.nodes.find((n) => n.summary.includes("OAuth"))!;
    const conflict = graph.nodes.find((n) => n.summary.includes("fallback conflict"))!;
    pattern.embedding = [0, 1, 0];
    conflict.embedding = [1, 0, 0];
    graph.edges.push({
      source: pattern.id,
      target: conflict.id,
      type: "resolved_by",
      weight: 0.9,
      reason: "Conflict resolution explicitly cites the retry limit pattern.",
      confidence_score: 0.9,
      source_update_refs: ["ctx-auth-retry-resolution"],
    });

    const q = queryKnowledge(orgId, {
      filters: { domains: ["backend"] },
      query_text: "OAuth token refresh retry",
      query_embedding: [0, 1, 0],
      expand_graph: true,
      max_tokens: 2000,
    });

    expect(q.nodes.map((n) => n.summary)).toContain("OAuth token refresh retry strategy");
    expect(q.nodes.map((n) => n.summary)).toContain("Auth fallback conflict resolved by retry limit");
  });

  it("does not graph-expand neighbors excluded by project or curation filters", async () => {
    const orgId = nextOrgId("kg-expansion-scalar-filters");
    initializeKnowledgeGraph(orgId);
    const base: EnhancedPodLearning = {
      type: "pattern",
      details: "Graph expansion scalar filter regression fixture.",
      domains: ["backend"],
      confidence: "extracted",
      confidence_score: 0.9,
      summary: "",
    };
    await addLearningsToGraph(
      orgId,
      [{ ...base, summary: "SeedAPI direct project hit" }],
      "pod-alpha",
      "Alpha Pod",
      { project_id: "proj-alpha", project_name: "Alpha" },
    );
    await addLearningsToGraph(
      orgId,
      [{ ...base, summary: "Other project graph neighbor" }],
      "pod-beta",
      "Beta Pod",
      { project_id: "proj-beta", project_name: "Beta" },
    );

    const graph = getGraph(orgId);
    const seed = graph.nodes.find((n) => n.summary === "SeedAPI direct project hit")!;
    const neighbor = graph.nodes.find((n) => n.summary === "Other project graph neighbor")!;
    seed.embedding = [1, 0, 0];
    seed.curated = true;
    neighbor.embedding = [0, 1, 0];
    neighbor.curated = false;
    graph.edges = [{ source: seed.id, target: neighbor.id, type: "relates_to", weight: 1 }];

    const projectScoped = queryKnowledge(orgId, {
      filters: { domains: ["backend"], include_project_id: "proj-alpha" },
      query_text: "SeedAPI",
      query_embedding: [1, 0, 0],
      expand_graph: true,
      max_tokens: 2000,
    });
    expect(projectScoped.nodes.map((n) => n.id)).toContain(seed.id);
    expect(projectScoped.nodes.map((n) => n.id)).not.toContain(neighbor.id);

    const curatedOnly = queryKnowledge(orgId, {
      filters: { domains: ["backend"], curated_only: true },
      query_text: "SeedAPI",
      query_embedding: [1, 0, 0],
      expand_graph: true,
      max_tokens: 2000,
    });
    expect(curatedOnly.nodes.map((n) => n.id)).toContain(seed.id);
    expect(curatedOnly.nodes.map((n) => n.id)).not.toContain(neighbor.id);
  });

  it("expands legacy resolved_by graph neighbors that predate edge evidence metadata", async () => {
    const orgId = await seedGraph([
      {
        type: "pattern",
        summary: "SeedAPI primary recall source",
        details: "Direct semantic hit for the query.",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
      {
        type: "resolved_conflict",
        summary: "Conflict resolution precedent",
        details: "The previous disagreement was settled and remains relevant as a precedent.",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
    ]);
    const graph = getGraph(orgId);
    const seed = graph.nodes.find((n) => n.summary === "SeedAPI primary recall source")!;
    const precedent = graph.nodes.find((n) => n.summary === "Conflict resolution precedent")!;
    seed.embedding = [1, 0, 0];
    precedent.embedding = [0, 1, 0];
    graph.edges = [{ source: seed.id, target: precedent.id, type: "resolved_by", weight: 0.9 }];

    const q = queryKnowledge(orgId, {
      filters: { domains: ["backend"] },
      query_text: "SeedAPI",
      query_embedding: [1, 0, 0],
      expand_graph: true,
      max_tokens: 2000,
    });

    expect(q.nodes.map((n) => n.id)).toEqual(expect.arrayContaining([seed.id, precedent.id]));
  });

  it("does not expand freshly inferred resolved_by edges without evidence", async () => {
    const orgId = await seedGraph([
      {
        type: "pattern",
        summary: "SeedAPI primary inferred source",
        details: "Direct semantic hit for the query.",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
      {
        type: "resolved_conflict",
        summary: "Inferred conflict resolution precedent",
        details: "This inferred neighbor has no supporting evidence metadata.",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
    ]);
    const graph = getGraph(orgId);
    const seed = graph.nodes.find((n) => n.summary === "SeedAPI primary inferred source")!;
    const precedent = graph.nodes.find((n) => n.summary === "Inferred conflict resolution precedent")!;
    seed.embedding = [1, 0, 0];
    precedent.embedding = [0, 1, 0];
    graph.edges = [{ source: seed.id, target: precedent.id, type: "resolved_by", weight: 0.9, inferred: true }];

    const q = queryKnowledge(orgId, {
      filters: { domains: ["backend"] },
      query_text: "SeedAPI",
      query_embedding: [1, 0, 0],
      expand_graph: true,
      max_tokens: 2000,
    });

    expect(q.nodes.map((n) => n.id)).toEqual([seed.id]);
  });

  it("does not expand contradicting nodes as current supporting context but preserves them in why_changed mode", async () => {
    const orgId = await seedGraph([
      {
        type: "pattern",
        summary: "PrimaryAuthTokenFlow retry strategy",
        details: "Retry auth token refresh once before surfacing an auth failure.",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
      {
        type: "anti_pattern",
        summary: "Legacy logout redirect loop",
        details: "Redirect loops on logout should not support token refresh retry guidance.",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
    ]);
    const graph = getGraph(orgId);
    const seed = graph.nodes.find((n) => n.summary.includes("PrimaryAuthTokenFlow"))!;
    const contradiction = graph.nodes.find((n) => n.summary.includes("Legacy logout"))!;
    seed.embedding = [1, 0, 0];
    contradiction.embedding = [0, 1, 0];
    graph.edges.push({ source: seed.id, target: contradiction.id, type: "contradicts", weight: 1 });

    const current = queryKnowledge(orgId, {
      filters: { domains: ["backend"] },
      query_text: "PrimaryAuthTokenFlow",
      query_embedding: [1, 0, 0],
      expand_graph: true,
      max_tokens: 2000,
    });
    expect(current.nodes.map((n) => n.id)).toEqual([seed.id]);

    const whyChanged = queryKnowledge(orgId, {
      filters: { domains: ["backend"] },
      query_text: "PrimaryAuthTokenFlow",
      query_embedding: [1, 0, 0],
      query_mode: "why_changed",
      max_tokens: 2000,
    });
    expect(whyChanged.nodes.map((n) => n.id)).toEqual(expect.arrayContaining([seed.id, contradiction.id]));
    expect(whyChanged.edges.map((edge) => edge.type)).toContain("contradicts");
  });

  it("expands graph neighbors by strongest edge before applying the expansion cap", async () => {
    const neighborLearnings: EnhancedPodLearning[] = Array.from({ length: 21 }, (_, i) => ({
      type: "pattern",
      summary: `Weak graph neighbor ${i}`,
      details: "Connected to the seed by a weak edge.",
      domains: ["backend"],
      confidence: "extracted",
      confidence_score: 0.9,
    }));
    const orgId = await seedGraph([
      {
        type: "pattern",
        summary: "SeedAPI primary recall node",
        details: "This is the direct semantic hit.",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
      ...neighborLearnings,
      {
        type: "pattern",
        summary: "Strong graph neighbor",
        details: "This should survive the expansion cap even though its edge is last.",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
    ]);
    const graph = getGraph(orgId);
    const seed = graph.nodes.find((n) => n.summary === "SeedAPI primary recall node")!;
    const strong = graph.nodes.find((n) => n.summary === "Strong graph neighbor")!;
    for (const node of graph.nodes) node.embedding = node.id === seed.id ? [1, 0, 0] : [0, 1, 0];
    graph.edges = [];
    for (const weak of graph.nodes.filter((n) => n.summary.startsWith("Weak graph neighbor"))) {
      graph.edges.push({ source: seed.id, target: weak.id, type: "relates_to", weight: 0.1 });
    }
    graph.edges.push({ source: seed.id, target: strong.id, type: "relates_to", weight: 1 });

    const q = queryKnowledge(orgId, {
      filters: { domains: ["backend"] },
      query_text: "SeedAPI",
      query_embedding: [1, 0, 0],
      expand_graph: true,
      limit: 25,
      max_tokens: 2000,
    });

    expect(q.nodes.map((n) => n.summary)).toContain("Strong graph neighbor");
  });

  it("treats missing edge weights as zero during graph expansion ranking", async () => {
    const orgId = await seedGraph([
      {
        type: "pattern",
        summary: "SeedAPI primary recall node",
        details: "This is the direct semantic hit.",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
      {
        type: "pattern",
        summary: "Missing weight graph neighbor",
        details: "Connected to the seed by a legacy edge without a weight.",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
      {
        type: "pattern",
        summary: "Weighted graph neighbor",
        details: "Connected to the seed by a weighted edge.",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
    ]);
    const graph = getGraph(orgId);
    const seed = graph.nodes.find((n) => n.summary === "SeedAPI primary recall node")!;
    const missing = graph.nodes.find((n) => n.summary === "Missing weight graph neighbor")!;
    const weighted = graph.nodes.find((n) => n.summary === "Weighted graph neighbor")!;
    for (const node of graph.nodes) node.embedding = node.id === seed.id ? [1, 0, 0] : [0, 1, 0];
    graph.edges = [
      { source: seed.id, target: missing.id, type: "relates_to" } as KnowledgeGraph["edges"][number],
      { source: seed.id, target: weighted.id, type: "relates_to", weight: 1 },
    ];

    const q = queryKnowledge(orgId, {
      filters: { domains: ["backend"] },
      query_text: "SeedAPI",
      query_embedding: [1, 0, 0],
      expand_graph: true,
      limit: 2,
      max_tokens: 2000,
    });

    expect(q.nodes.map((n) => n.summary)).toEqual([
      "SeedAPI primary recall node",
      "Weighted graph neighbor",
    ]);
  });

  it("refuses unsafe offline evaluation org ids without an explicit override", () => {
    const graph: KnowledgeGraph = {
      version: 1,
      org_id: "production-org",
      updated_at: new Date().toISOString(),
      nodes: [],
      edges: [],
      communities: [],
    };

    expect(() => loadGraphForOfflineEvaluation(graph)).toThrow(/non-eval org/);
    expect(() => loadGraphForOfflineEvaluation({ ...graph, org_id: "kg-recall-golden" })).not.toThrow();
  });

  it("tracks retrieval counts in memory and defers persistence to the refresh interval", async () => {
    const orgId = await seedGraph([
      {
        type: "pattern",
        summary: "Retrieval telemetry pattern",
        details: "Track when nodes are retrieved.",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
    ]);

    vi.mocked(saveGraph).mockClear();
    queryKnowledge(orgId, { filters: { domains: ["backend"] }, max_tokens: 2000 });

    const node = getGraph(orgId).nodes[0];
    expect(node.retrieval_count).toBe(1);
    expect(node.last_retrieved_at).toBeTruthy();
    expect(saveGraph).not.toHaveBeenCalled();

    expect(refreshAnalysisIfStale(orgId)).toBe(true);
    expect(saveGraph).toHaveBeenCalledTimes(1);
  });
});

describe("empty filter set intersection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
    orgSettingsState.kgContextContract = "legacy";
  });

  it("filters.domains pointing to an unknown domain returns empty, not a full-scan fallback", async () => {
    // Gap 5: when every domain in filters.domains has zero indexed nodes the result
    // must be empty — it must not silently degrade to returning all nodes.
    const orgId = await seedGraph([
      {
        type: "pattern",
        summary: "Backend only node that must not appear",
        details: "",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
    ]);

    const q = queryKnowledge(orgId, {
      filters: { domains: ["domain-that-does-not-exist"] },
      max_tokens: 2000,
    });

    expect(q.nodes).toHaveLength(0);
    expect(q.total_matching).toBe(0);
  });

  it("filters.types pointing to an unknown type returns empty", async () => {
    // Gap 5 (type dimension): same empty-intersection guarantee for the type index.
    const orgId = await seedGraph([
      {
        type: "pattern",
        summary: "Pattern node that must not appear",
        details: "",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
      },
    ]);

    const q = queryKnowledge(orgId, {
      filters: { types: ["resolved_conflict"] },
      max_tokens: 2000,
    });

    expect(q.nodes).toHaveLength(0);
    expect(q.total_matching).toBe(0);
  });
});
