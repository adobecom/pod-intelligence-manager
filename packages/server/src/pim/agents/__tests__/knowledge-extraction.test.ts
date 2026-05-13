import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("../../../db/connection.js", () => ({
  default: { prepare: vi.fn() },
}));

vi.mock("../../llm.js", () => ({
  isLLMAvailable: () => false,
  MODELS: { fast: "claude-haiku", smart: "claude-sonnet" },
  callLLM: vi.fn(),
  callLLMJSON: vi.fn(),
}));

vi.mock("../../../services/knowledge-graph.js", () => ({
  getGraph: vi.fn(() => ({ nodes: [] })),
}));

vi.mock("../../../services/embeddings.js", () => ({
  isEmbeddingAvailable: () => false,
  generateEmbedding: vi.fn(),
  cosineSimilarity: vi.fn(),
}));

import { extractKnowledge, extractKnowledgeEnhanced } from "../knowledge-extraction.js";
import db from "../../../db/connection.js";

interface PreparedStub {
  all: Mock;
  get: Mock;
}

/**
 * The deterministic extractor issues queries in this order:
 *   1. SELECT decisions FROM context_updates
 *   2. SELECT resolved conflicts (LEFT JOIN scope)
 * Set up two `prepare(...).all(...)` returns in that order.
 */
function setupExtractQueries(decisions: unknown[], conflicts: unknown[]): void {
  const decisionStub: PreparedStub = { all: vi.fn().mockReturnValue(decisions), get: vi.fn() };
  const conflictStub: PreparedStub = { all: vi.fn().mockReturnValue(conflicts), get: vi.fn() };
  const prepareMock = (db.prepare as unknown) as Mock;
  prepareMock.mockReset();
  prepareMock.mockReturnValueOnce(decisionStub).mockReturnValueOnce(conflictStub);
}

describe("extractKnowledge — deterministic extraction quality", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not produce any anti_pattern nodes from blockers", () => {
    setupExtractQueries(
      [
        {
          agent_id: "agent-a",
          timestamp: "2026-01-01T00:00:00Z",
          summary: "Use cookies for auth",
          details: "Decided to use httpOnly cookies for session tokens to prevent XSS issues.",
          scope: "backend",
        },
      ],
      [],
    );
    const learnings = extractKnowledge("pod-x");
    expect(learnings).toHaveLength(1);
    expect(learnings[0].type).toBe("pattern");
    // Crucially: nothing of type anti_pattern, regardless of how many blockers existed.
    expect(learnings.some((l) => l.type === "anti_pattern")).toBe(false);
  });

  it("does not prefix decision details with 'Decision by …:'", () => {
    setupExtractQueries(
      [
        {
          agent_id: "agent-a",
          timestamp: "2026-01-01T00:00:00Z",
          summary: "Use cookies for auth",
          details: "Decided to use httpOnly cookies for session tokens to prevent XSS issues.",
          scope: "backend",
        },
      ],
      [],
    );
    const [decision] = extractKnowledge("pod-x");
    expect(decision.details.startsWith("Decision by")).toBe(false);
    expect(decision.details).toBe(
      "Decided to use httpOnly cookies for session tokens to prevent XSS issues.",
    );
  });

  it("attaches the authoritative scope to the learning", () => {
    setupExtractQueries(
      [
        {
          agent_id: "agent-a",
          timestamp: "2026-01-01T00:00:00Z",
          summary: "Use cookies for auth",
          details: "Decided to use httpOnly cookies for session tokens to prevent XSS issues.",
          scope: "backend",
        },
      ],
      [],
    );
    const [decision] = extractKnowledge("pod-x");
    expect(decision.scope).toBe("backend");
  });

  it("filters out trivial decisions whose detail length is below the minimum", async () => {
    // The SQL filter handles this — we verify the query argument carries the threshold.
    setupExtractQueries([], []);
    extractKnowledge("pod-x");
    const prepareMock = (db.prepare as unknown) as Mock;
    const decisionsSql = prepareMock.mock.calls[0][0] as string;
    expect(decisionsSql).toMatch(/length\(coalesce\(details, summary\)\) >= \?/);
  });

  it("uses scope directly for domains in extractKnowledgeEnhanced", async () => {
    setupExtractQueries(
      [
        {
          agent_id: "agent-a",
          timestamp: "2026-01-01T00:00:00Z",
          summary: "Migrate to OpenAPI v3",
          details: "Migration ensures consumers can generate strongly-typed clients.",
          scope: "backend",
        },
      ],
      [],
    );
    const enhanced = await extractKnowledgeEnhanced("pod-x", "org-test");
    expect(enhanced).toHaveLength(1);
    // Domain comes from scope, not from keyword inference (which would have included "general"
    // or other matches because "migrate" / "consumer" don't appear in the backend keyword list).
    expect(enhanced[0].domains).toEqual(["backend"]);
  });

  it("falls back to ['unknown'] when scope is missing rather than keyword-bagging", async () => {
    setupExtractQueries(
      [],
      [
        {
          id: "conflict-1",
          summary: "Should we cache?",
          resolution: "Yes, with TTL",
          severity: "low",
          scope: null, // no scope on the conflict's referenced updates
        },
      ],
    );
    const enhanced = await extractKnowledgeEnhanced("pod-x", "org-test");
    expect(enhanced).toHaveLength(1);
    expect(enhanced[0].domains).toEqual(["unknown"]);
  });

  it("offline classifier fallback: deterministic patterns get DEFAULT_PATTERN_SCORE (0.7), not 0.9", async () => {
    setupExtractQueries(
      [
        {
          agent_id: "agent-a",
          timestamp: "2026-01-01T00:00:00Z",
          summary: "Use cookies for auth",
          details: "Decided to use httpOnly cookies for session tokens to prevent XSS issues.",
          scope: "backend",
        },
      ],
      [],
    );
    const enhanced = await extractKnowledgeEnhanced("pod-x", "org-test");
    expect(enhanced).toHaveLength(1);
    expect(enhanced[0].confidence).toBe("extracted");
    expect(enhanced[0].confidence_score).toBe(0.7);
  });

  it("resolved conflicts always score 0.9 (classifier-independent)", async () => {
    setupExtractQueries(
      [],
      [
        {
          id: "conflict-1",
          summary: "Auth approach disputed",
          resolution: "Settled on session cookies",
          severity: "high",
          scope: "backend",
        },
      ],
    );
    const enhanced = await extractKnowledgeEnhanced("pod-x", "org-test");
    expect(enhanced).toHaveLength(1);
    expect(enhanced[0].type).toBe("resolved_conflict");
    expect(enhanced[0].confidence_score).toBe(0.9);
  });
});
