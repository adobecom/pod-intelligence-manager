/**
 * Unit test for stripEmbeddingsFromGraph — the helper used by the UI-facing
 * /api/knowledge/graph response. Catches a future refactor that accidentally
 * drops more than just the embedding field, or mutates the input graph.
 */
import { describe, it, expect, vi } from "vitest";

// knowledge-graph.ts transitively imports node:sqlite via graph-storage.
// Mock the storage + settings layers so this test does not require Node 24.
vi.mock("../graph-storage.js", () => ({
  loadGraph: vi.fn(() => null),
  saveGraph: vi.fn(),
}));

vi.mock("../org-settings.js", async () => {
  const { DEFAULT_ORG_TUNING } = await import("@pim/shared");
  return { getOrgTuning: vi.fn(() => DEFAULT_ORG_TUNING) };
});

import { stripEmbeddingsFromGraph } from "../knowledge-graph.js";
import type { KnowledgeGraph } from "@pim/shared";

function makeGraph(): KnowledgeGraph {
  return {
    version: 7,
    org_id: "org-strip-test",
    updated_at: "2026-05-14T12:00:00Z",
    nodes: [
      {
        id: "kn-a",
        type: "pattern",
        summary: "Use Redis for session cache",
        details: "Redis offers sub-ms latency and pub/sub for invalidation.",
        source_pod_id: "pod-1",
        source_pod_name: "Session Pod",
        domains: ["backend"],
        confidence: "extracted",
        confidence_score: 0.9,
        created_at: "2026-05-01T00:00:00Z",
        curated: true,
        community_id: "community-0",
        embedding: [0.12, 0.34, 0.56],
      },
      {
        id: "kn-b",
        type: "anti_pattern",
        summary: "Avoid storing JWTs in localStorage",
        details: "XSS exposure. Use httpOnly cookies.",
        source_pod_id: "pod-1",
        source_pod_name: "Session Pod",
        domains: ["frontend", "security"],
        confidence: "extracted",
        confidence_score: 0.85,
        created_at: "2026-05-02T00:00:00Z",
        curated: false,
        embedding: [0.78, 0.91, 0.23],
      },
    ],
    edges: [
      {
        source: "kn-a",
        target: "kn-b",
        type: "relates_to",
        weight: 0.42,
      },
    ],
    communities: [
      {
        id: "community-0",
        label: "session security",
        node_count: 2,
        top_domains: ["backend", "frontend"],
        summary: "Session and auth-related learnings",
      },
    ],
  };
}

describe("stripEmbeddingsFromGraph", () => {
  it("removes embedding from every node", () => {
    const stripped = stripEmbeddingsFromGraph(makeGraph());
    for (const node of stripped.nodes) {
      expect(node.embedding).toBeUndefined();
    }
  });

  it("preserves all other node fields", () => {
    const original = makeGraph();
    const stripped = stripEmbeddingsFromGraph(original);

    for (let i = 0; i < original.nodes.length; i++) {
      const o = original.nodes[i];
      const s = stripped.nodes[i];
      expect(s.id).toBe(o.id);
      expect(s.type).toBe(o.type);
      expect(s.summary).toBe(o.summary);
      expect(s.details).toBe(o.details);
      expect(s.domains).toEqual(o.domains);
      expect(s.confidence).toBe(o.confidence);
      expect(s.confidence_score).toBe(o.confidence_score);
      expect(s.curated).toBe(o.curated);
      expect(s.created_at).toBe(o.created_at);
      expect(s.source_pod_id).toBe(o.source_pod_id);
      expect(s.source_pod_name).toBe(o.source_pod_name);
      expect(s.community_id).toBe(o.community_id);
    }
  });

  it("preserves edges, communities, and graph metadata", () => {
    const original = makeGraph();
    const stripped = stripEmbeddingsFromGraph(original);

    expect(stripped.version).toBe(original.version);
    expect(stripped.org_id).toBe(original.org_id);
    expect(stripped.updated_at).toBe(original.updated_at);
    expect(stripped.edges).toEqual(original.edges);
    expect(stripped.communities).toEqual(original.communities);
  });

  it("does not mutate the input graph", () => {
    const original = makeGraph();
    const beforeFirstEmbedding = original.nodes[0].embedding;
    stripEmbeddingsFromGraph(original);
    // The in-memory graph state must still carry embeddings for server-side
    // dedup, semantic query, and edge inference to keep working.
    expect(original.nodes[0].embedding).toBe(beforeFirstEmbedding);
    expect(original.nodes[0].embedding).toEqual([0.12, 0.34, 0.56]);
    expect(original.nodes[1].embedding).toEqual([0.78, 0.91, 0.23]);
  });
});
