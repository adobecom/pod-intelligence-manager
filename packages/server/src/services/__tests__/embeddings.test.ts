import { describe, it, expect, vi, beforeEach } from "vitest";

// Prevent real network calls in all tests
vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "");
vi.stubEnv("AWS_REGION", "");

import { cosineSimilarity, embedText, embeddingTextHash, isEmbeddingAvailable } from "../embeddings.js";
import type { KnowledgeNode } from "@pim/shared";

describe("cosineSimilarity", () => {
  it("returns 1.0 for identical vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1.0);
  });

  it("returns 0.0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0);
  });

  it("returns -1.0 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0);
  });

  it("returns 0 for zero vector", () => {
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
  });

  it("returns 0 for mismatched lengths", () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it("returns 0 for empty vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("handles non-unit vectors correctly", () => {
    // [3, 4] and [6, 8] are parallel — should be ~1.0
    expect(cosineSimilarity([3, 4], [6, 8])).toBeCloseTo(1.0);
  });
});

describe("embedText", () => {
  const base: Pick<KnowledgeNode, "summary" | "details"> = {
    summary: "Use JWT for auth",
    details: "Prefer short-lived tokens with refresh.",
  };

  it("concatenates summary and non-empty details", () => {
    expect(embedText(base)).toBe("Use JWT for auth. Prefer short-lived tokens with refresh.");
  });

  it("returns only summary when details is empty", () => {
    expect(embedText({ summary: "Use JWT for auth", details: "" })).toBe("Use JWT for auth");
  });

  it("returns only summary when details is whitespace", () => {
    expect(embedText({ summary: "Use JWT for auth", details: "   " })).toBe("Use JWT for auth");
  });
});

describe("embeddingTextHash", () => {
  it("changes when the embedded text changes", () => {
    expect(embeddingTextHash("alpha")).toBe(embeddingTextHash("alpha"));
    expect(embeddingTextHash("alpha")).not.toBe(embeddingTextHash("beta"));
  });
});

describe("isEmbeddingAvailable", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns false when token is missing", () => {
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "");
    vi.stubEnv("AWS_REGION", "us-west-2");
    expect(isEmbeddingAvailable()).toBe(false);
  });

  it("returns false when region is missing", () => {
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "tok");
    vi.stubEnv("AWS_REGION", "");
    expect(isEmbeddingAvailable()).toBe(false);
  });

  it("returns true when both are set", () => {
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "tok");
    vi.stubEnv("AWS_REGION", "us-west-2");
    expect(isEmbeddingAvailable()).toBe(true);
  });
});
