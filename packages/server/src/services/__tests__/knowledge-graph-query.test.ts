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
  _resetForTests,
} from "../knowledge-graph.js";
import type { EnhancedPodLearning, KnowledgeNode } from "@pim/shared";

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

describe("pruneStaleNodes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
  });

  it("removes only stale, low-confidence, uncurated, non-superseded nodes", async () => {
    const orgId = nextOrgId("kg-prune");
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
    expect(result.removed).toBe(1);
    const ids = getGraph(orgId).nodes.map((n) => n.id);
    expect(ids).not.toContain("kn-stale-junk");
    expect(ids).toContain("kn-curated-old");
    expect(ids).toContain("kn-recent-junk");
    expect(ids).toContain("kn-old-confident");
    expect(ids).toContain("kn-old-superseded");
  });

  it("returns 0 removed on an empty graph", () => {
    const orgId = nextOrgId("kg-prune-empty");
    initializeKnowledgeGraph(orgId);
    expect(pruneStaleNodes(orgId).removed).toBe(0);
  });

  it("pruned node is absent from domain-index queries, not just from graph.nodes", async () => {
    // Gap 3: verify the index is rebuilt after pruning so queries reflect the removal.
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

    // After pruning the stale node should be gone from graph.nodes...
    const remainingIds = getGraph(orgId).nodes.map((n) => n.id);
    expect(remainingIds).not.toContain("kn-prune-idx-stale");

    // ...and a domain query must not surface it either (index consistency).
    const q = queryKnowledge(orgId, {
      filters: { domains: ["backend"] },
      max_tokens: 2000,
    });
    const queriedIds = q.nodes.map((n) => n.id);
    expect(queriedIds).not.toContain("kn-prune-idx-stale");
    expect(queriedIds.some((id) => id !== "kn-prune-idx-stale")).toBe(true);
  });
});

describe("text_search index behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
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
});

describe("empty filter set intersection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
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
