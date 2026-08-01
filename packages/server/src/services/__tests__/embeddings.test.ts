import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  cosineSimilarity,
  embedText,
  embeddingTextHash,
  generateEmbedding,
  generateEmbeddingStrict,
  isEmbeddingAvailable,
} from "../embeddings.js";
import type { KnowledgeNode } from "@pim/shared";

beforeEach(() => {
  // Prevent real network calls even when a developer has Bedrock configured.
  vi.unstubAllEnvs();
  vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "");
  vi.stubEnv("AWS_REGION", "");
  vi.stubEnv("EMBEDDING_DIMENSIONS", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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

describe("generateEmbeddingStrict", () => {
  beforeEach(() => {
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "bedrock-token");
    vi.stubEnv("AWS_REGION", "us-west-2");
    vi.stubEnv("EMBEDDING_DIMENSIONS", "256");
  });

  it("returns a validated Titan vector", async () => {
    const embedding = Array.from({ length: 256 }, (_, index) =>
      index === 0 ? 1 : 0,
    );
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ embedding }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(generateEmbeddingStrict("review pull requests")).resolves.toEqual(
      embedding,
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(
      "bedrock-runtime.us-west-2.amazonaws.com/model/amazon.titan-embed-text-v2:0/invoke",
    );
    expect(init.headers).toMatchObject({
      Authorization: "Bearer bedrock-token",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      inputText: "review pull requests",
      dimensions: 256,
      normalize: true,
    });
  });

  it("throws when Bedrock is not configured", async () => {
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(generateEmbeddingStrict("query")).rejects.toThrow(
      "AWS_BEARER_TOKEN_BEDROCK and AWS_REGION are required",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws on a non-successful Bedrock response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("throttled", {
          status: 429,
          statusText: "Too Many Requests",
        }),
      ),
    );

    await expect(generateEmbeddingStrict("query")).rejects.toThrow(
      "Bedrock request failed: 429 Too Many Requests",
    );
  });

  it.each([
    ["a missing vector", {}],
    ["the wrong dimensions", { embedding: [1, 0] }],
    [
      "non-finite values",
      {
        embedding: [
          Number.POSITIVE_INFINITY,
          ...Array.from({ length: 255 }, () => 0),
        ],
      },
    ],
  ])("throws for %s", async (_label, payload) => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => payload,
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(generateEmbeddingStrict("query")).rejects.toThrow(
      "expected 256 finite dimensions",
    );
  });
});

describe("generateEmbedding legacy fallback", () => {
  it("still returns null without making a request when unconfigured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(generateEmbedding("query")).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still converts strict validation failures to null", async () => {
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "bedrock-token");
    vi.stubEnv("AWS_REGION", "us-west-2");
    vi.stubEnv("EMBEDDING_DIMENSIONS", "256");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ embedding: [1, 2] }),
      }),
    );
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(generateEmbedding("query")).resolves.toBeNull();
  });
});

describe("isEmbeddingAvailable", () => {
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
