import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MEMORY_CONTRACT_FIXTURES_V2,
  MemoryContractValidationError,
  parseMemoryContractV2,
  type CodebaseMemorySearchV2,
  type CodebaseRunReceiptV2,
  type HarnessRunReceiptV2,
  type HarnessMemorySearchV2,
  type MemoryBindingV2,
  type MemoryCapabilitiesV2,
  type MemoryCandidateDecisionResultV2,
  type MemoryCandidateDecisionV2,
  type MemoryCandidateStatusV2,
  type MemoryFeedbackResultV2,
  type MemoryFeedbackV2,
  type MemoryMcpHarnessCandidateStatusInputV2,
  type MemoryMcpReadinessInputV2,
  type MemoryReadinessV2,
  type MemoryRecordHistoryV2,
  type MemoryRecordV2,
  type MemoryRetrievalPackV2,
  type MemorySearchResultV2,
  type PimErrorV2,
  type RunReceiptResultV2,
} from "@pim/shared";
import { PimMemoryV2ApiError, PimMemoryV2Client } from "../index.js";

const mockFetch = vi.fn();

function fixture<T>(name: keyof typeof MEMORY_CONTRACT_FIXTURES_V2): T {
  return structuredClone(MEMORY_CONTRACT_FIXTURES_V2[name]) as unknown as T;
}

function client(): PimMemoryV2Client {
  return new PimMemoryV2Client({
    baseUrl: "http://localhost:4000///",
    authToken: "memory-v2-token",
    orgSlug: "acme",
  });
}

function mockResponse(body: unknown, status = 200): void {
  mockFetch.mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

function request(index = 0): [string, RequestInit] {
  return mockFetch.mock.calls[index] as [string, RequestInit];
}

describe("PimMemoryV2Client strict v2 surface", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("gets capabilities and binding from their exact authenticated URLs", async () => {
    const capabilities = fixture<MemoryCapabilitiesV2>("MemoryCapabilitiesV2");
    const binding = fixture<MemoryBindingV2>("MemoryBindingV2");
    mockResponse(capabilities);

    await expect(client().capabilities()).resolves.toEqual(capabilities);
    let [url, init] = request();
    let headers = new Headers(init.headers);
    expect(url).toBe("http://localhost:4000/api/v2/memory/capabilities");
    expect(init.method).toBeUndefined();
    expect(headers.get("Authorization")).toBe("Bearer memory-v2-token");
    expect(headers.get("X-Pim-Org")).toBe("acme");

    mockFetch.mockReset();
    mockResponse(binding);
    await expect(client().binding()).resolves.toEqual(binding);
    [url, init] = request();
    headers = new Headers(init.headers);
    expect(url).toBe("http://localhost:4000/api/v2/memory/binding");
    expect(init.method).toBeUndefined();
    expect(headers.get("Authorization")).toBe("Bearer memory-v2-token");
  });

  it("gets strictly selected readiness and strictly parses the bounded response", async () => {
    const selector = fixture<MemoryMcpReadinessInputV2>("MemoryMcpReadinessInputV2");
    const readiness = fixture<MemoryReadinessV2>("MemoryReadinessV2");
    mockResponse(readiness);

    await expect(client().readiness(selector)).resolves.toEqual(readiness);
    let [url, init] = request();
    let headers = new Headers(init.headers);
    expect(url).toBe(
      "http://localhost:4000/api/v2/memory/readiness"
      + "?plane=harness&resource_row_id=resource-harness-contract",
    );
    expect(init.method).toBeUndefined();
    expect(headers.get("Authorization")).toBe("Bearer memory-v2-token");

    mockFetch.mockReset();
    await expect(client().readiness({
      ...selector,
      unexpected: "caller-cannot-expand-readiness",
    } as unknown as MemoryMcpReadinessInputV2)).rejects.toBeInstanceOf(
      MemoryContractValidationError,
    );
    expect(mockFetch).not.toHaveBeenCalled();

    mockResponse({ ...readiness, raw_jobs: ["must-not-exist"] });
    await expect(client().readiness({
      ...selector,
      resource_selector: { canonical_resource_id: "example-harness-a" },
    })).rejects.toBeInstanceOf(MemoryContractValidationError);
    [url, init] = request();
    headers = new Headers(init.headers);
    expect(url).toContain("plane=harness&canonical_resource_id=example-harness-a");
    expect(headers.get("Authorization")).toBe("Bearer memory-v2-token");
  });

  it("posts a strictly validated code search and strictly parses its result", async () => {
    const search = fixture<CodebaseMemorySearchV2>("MemorySearchV2");
    const result = fixture<MemorySearchResultV2>("MemorySearchResultV2");
    mockResponse(result);

    await expect(client().searchCode(search)).resolves.toEqual(result);

    const [url, init] = request();
    const headers = new Headers(init.headers);
    expect(url).toBe("http://localhost:4000/api/v2/memory/search");
    expect(init.method).toBe("POST");
    expect(headers.get("Authorization")).toBe("Bearer memory-v2-token");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual(search);

    mockFetch.mockReset();
    mockResponse({ ...result, unexpected: true });
    await expect(client().searchCode(search)).rejects.toBeInstanceOf(
      MemoryContractValidationError,
    );
  });

  it("reads an exact immutable pack and rejects invalid selectors before fetch", async () => {
    const pack = fixture<MemoryRetrievalPackV2>("MemoryRetrievalPackV2");
    mockResponse(pack);

    await expect(client().getPack(pack.retrieval_pack_id)).resolves.toEqual(pack);
    const [url, init] = request();
    expect(url).toBe(
      `http://localhost:4000/api/v2/memory/packs/${encodeURIComponent(pack.retrieval_pack_id)}`,
    );
    expect(init.method).toBeUndefined();

    mockFetch.mockReset();
    await expect(client().getPack("")).rejects.toThrow(
      "packId must contain 1 to 128 characters",
    );
    await expect(client().getPack("x".repeat(129))).rejects.toThrow(
      "packId must contain 1 to 128 characters",
    );
    expect(mockFetch).not.toHaveBeenCalled();

    mockResponse({ ...pack, unexpected: true });
    await expect(client().getPack(pack.retrieval_pack_id)).rejects.toBeInstanceOf(
      MemoryContractValidationError,
    );
  });

  it("rejects an invalid or non-code search before making an HTTP request", async () => {
    const search = fixture<CodebaseMemorySearchV2>("MemorySearchV2");
    const invalid = { ...search, unexpected: true } as unknown as CodebaseMemorySearchV2;

    await expect(client().searchCode(invalid)).rejects.toBeInstanceOf(
      MemoryContractValidationError,
    );
    expect(mockFetch).not.toHaveBeenCalled();

    const wrongPlane = {
      ...search,
      plane: "harness",
      applicability: { plane: "harness" },
    } as unknown as CodebaseMemorySearchV2;
    await expect(client().searchCode(wrongPlane)).rejects.toBeInstanceOf(
      MemoryContractValidationError,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("posts a strictly validated harness search without crossing code selectors", async () => {
    const mcpHarness = fixture<Record<string, unknown>>("MemoryMcpHarnessSearchInputV2");
    const search = {
      ...mcpHarness,
      tenant: { project_id: "project-checkout" },
    } as HarnessMemorySearchV2;
    const harnessScope = fixture<{
      resource_binding: MemorySearchResultV2["resource_binding"];
      scope_snapshot_digest: string;
    }>("HarnessScopeSnapshotV2");
    const result = {
      ...fixture<MemorySearchResultV2>("MemorySearchResultV2"),
      request_id: search.request_id,
      plane: "harness",
      resource_binding: harnessScope.resource_binding,
      scope_snapshot_digest: harnessScope.scope_snapshot_digest,
      policy_version: "retrieval-harness-v2",
      items: [],
      token_count: 0,
    } as MemorySearchResultV2;
    mockResponse(result);

    await expect(client().searchHarness(search)).resolves.toEqual(result);
    const [url, init] = request();
    const headers = new Headers(init.headers);
    expect(url).toBe("http://localhost:4000/api/v2/memory/search");
    expect(init.method).toBe("POST");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual(search);

    mockFetch.mockReset();
    const codeSearch = fixture<CodebaseMemorySearchV2>("MemorySearchV2");
    await expect(
      client().searchHarness(codeSearch as unknown as HarnessMemorySearchV2),
    ).rejects.toBeInstanceOf(MemoryContractValidationError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("gets immutable record detail and history from encoded URLs", async () => {
    const record = fixture<MemoryRecordV2>("MemoryRecordV2");
    const history = fixture<MemoryRecordHistoryV2>("MemoryRecordHistoryV2");
    mockResponse(record);

    await expect(client().getRecord("memory/v2", 3)).resolves.toEqual(record);
    expect(request()[0]).toBe(
      "http://localhost:4000/api/v2/memory/records/memory%2Fv2?version=3",
    );
    expect(request()[1].method).toBeUndefined();

    mockFetch.mockReset();
    mockResponse(history);
    await expect(client().getRecordHistory("memory/v2")).resolves.toEqual(history);
    expect(request()[0]).toBe(
      "http://localhost:4000/api/v2/memory/records/memory%2Fv2/history",
    );
  });

  it("bounds immutable record selectors before making an HTTP request", async () => {
    await expect(client().getRecord("", 1)).rejects.toThrow(
      "recordId must contain 1 to 128 characters",
    );
    await expect(client().getRecord("record-1", 0)).rejects.toThrow(
      "recordVersion must be a positive integer",
    );
    await expect(client().getRecord("record-1", 1.5)).rejects.toThrow(
      "recordVersion must be a positive integer",
    );
    await expect(client().getRecordHistory("x".repeat(129))).rejects.toThrow(
      "recordId must contain 1 to 128 characters",
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("strictly parses successful record responses", async () => {
    const record = fixture<MemoryRecordV2>("MemoryRecordV2");
    const history = fixture<MemoryRecordHistoryV2>("MemoryRecordHistoryV2");
    mockResponse({ ...record, unexpected: true });
    await expect(client().getRecord("record-1", 1)).rejects.toBeInstanceOf(
      MemoryContractValidationError,
    );

    mockFetch.mockReset();
    mockResponse({ ...history, unexpected: true });
    await expect(client().getRecordHistory("record-1")).rejects.toBeInstanceOf(
      MemoryContractValidationError,
    );
  });

  it("puts a strictly validated codebase receipt with a stable idempotency key", async () => {
    const receipt = fixture<CodebaseRunReceiptV2>("RunReceiptV2");
    const result = fixture<RunReceiptResultV2>("RunReceiptResultV2");
    mockResponse(result);

    await expect(
      client().putRunReceipt("producer/run-v2", "receipt:producer/run-v2", receipt),
    ).resolves.toEqual(result);

    const [url, init] = request();
    const headers = new Headers(init.headers);
    expect(url).toBe(
      "http://localhost:4000/api/v2/memory/run-receipts/producer%2Frun-v2",
    );
    expect(init.method).toBe("PUT");
    expect(headers.get("Authorization")).toBe("Bearer memory-v2-token");
    expect(headers.get("X-Pim-Org")).toBe("acme");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("Idempotency-Key")).toBe("receipt:producer/run-v2");
    expect(JSON.parse(String(init.body))).toEqual(receipt);
  });

  it("puts the frozen typed harness receipt without changing its payload", async () => {
    const receipt = fixture<HarnessRunReceiptV2>("HarnessRunReceiptV2");
    const result = {
      ...fixture<RunReceiptResultV2>("RunReceiptResultV2"),
      plane: "harness",
      resource_binding: receipt.scope_snapshot.resource_binding,
      scope_snapshot_digest: receipt.scope_snapshot.scope_snapshot_digest,
      candidate_results: [],
    } as RunReceiptResultV2;
    mockResponse(result);

    await expect(
      client().putRunReceipt("harness/run-v2", "harness-receipt:run-v2", receipt),
    ).resolves.toEqual(result);

    const [url, init] = request();
    const headers = new Headers(init.headers);
    expect(url).toBe(
      "http://localhost:4000/api/v2/memory/run-receipts/harness%2Frun-v2",
    );
    expect(init.method).toBe("PUT");
    expect(headers.get("Idempotency-Key")).toBe("harness-receipt:run-v2");
    expect(JSON.parse(String(init.body))).toEqual(receipt);
  });

  it("accepts zero harness candidates and enforces the universal maximum of one", async () => {
    const receipt = fixture<HarnessRunReceiptV2>("HarnessRunReceiptV2");
    const zeroCandidateReceipt = { ...receipt, candidates: [] } satisfies HarnessRunReceiptV2;
    const result = {
      ...fixture<RunReceiptResultV2>("RunReceiptResultV2"),
      plane: "harness",
      resource_binding: receipt.scope_snapshot.resource_binding,
      scope_snapshot_digest: receipt.scope_snapshot.scope_snapshot_digest,
      candidate_results: [],
    } as RunReceiptResultV2;
    mockResponse(result);

    await expect(client().putRunReceipt(
      "harness/run-v2",
      "harness-receipt:zero-candidates",
      zeroCandidateReceipt,
    )).resolves.toEqual(result);
    expect(JSON.parse(String(request()[1].body)).candidates).toEqual([]);

    mockFetch.mockReset();
    const twoCandidateReceipt = {
      ...receipt,
      candidates: [receipt.candidates[0]!, structuredClone(receipt.candidates[0]!)],
    } as HarnessRunReceiptV2;
    await expect(client().putRunReceipt(
      "harness/run-v2",
      "harness-receipt:two-candidates",
      twoCandidateReceipt,
    )).rejects.toBeInstanceOf(MemoryContractValidationError);
    expect(mockFetch).not.toHaveBeenCalled();

    const mcpReceipt = structuredClone(receipt) as unknown as Record<string, unknown>;
    delete mcpReceipt.tenant;
    delete (mcpReceipt.scope_snapshot as Record<string, unknown>).resource_binding;
    expect(() => parseMemoryContractV2("MemoryMcpHarnessRunReceiptV2", mcpReceipt))
      .not.toThrow();
    expect(() => parseMemoryContractV2("MemoryMcpHarnessRunReceiptV2", {
      ...mcpReceipt,
      candidates: [],
    })).not.toThrow();
    expect(() => parseMemoryContractV2("MemoryMcpHarnessRunReceiptV2", {
      ...mcpReceipt,
      candidates: twoCandidateReceipt.candidates,
    })).toThrow(MemoryContractValidationError);
  });

  it("rejects invalid receipt selectors, keys, and bodies before fetching", async () => {
    const receipt = fixture<CodebaseRunReceiptV2>("RunReceiptV2");
    const invalidReceipt = {
      ...receipt,
      unexpected: true,
    } as unknown as CodebaseRunReceiptV2;

    await expect(
      client().putRunReceipt("", "receipt-key", receipt),
    ).rejects.toThrow("producerRunId must contain 1 to 256 characters");
    await expect(
      client().putRunReceipt("x".repeat(257), "receipt-key", receipt),
    ).rejects.toThrow("producerRunId must contain 1 to 256 characters");
    await expect(
      client().putRunReceipt("run-v2", "has spaces", receipt),
    ).rejects.toBeInstanceOf(MemoryContractValidationError);
    await expect(
      client().putRunReceipt("run-v2", "x".repeat(129), receipt),
    ).rejects.toBeInstanceOf(MemoryContractValidationError);
    await expect(
      client().putRunReceipt("run-v2", "receipt-key", invalidReceipt),
    ).rejects.toBeInstanceOf(MemoryContractValidationError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("strictly parses receipt success responses", async () => {
    const receipt = fixture<CodebaseRunReceiptV2>("RunReceiptV2");
    const result = fixture<RunReceiptResultV2>("RunReceiptResultV2");
    mockResponse({ ...result, unexpected: true });

    await expect(
      client().putRunReceipt("run-v2", "receipt-key", receipt),
    ).rejects.toBeInstanceOf(MemoryContractValidationError);
  });

  it("posts strictly validated feedback with a stable idempotency key", async () => {
    const feedback = fixture<MemoryFeedbackV2>("MemoryFeedbackV2");
    const result = fixture<MemoryFeedbackResultV2>("MemoryFeedbackResultV2");
    mockResponse(result);

    await expect(
      client().submitFeedback("feedback:pack-v2:1", feedback),
    ).resolves.toEqual(result);

    const [url, init] = request();
    const headers = new Headers(init.headers);
    expect(url).toBe("http://localhost:4000/api/v2/memory/feedback");
    expect(init.method).toBe("POST");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("Idempotency-Key")).toBe("feedback:pack-v2:1");
    expect(JSON.parse(String(init.body))).toEqual(feedback);
  });

  it("strictly validates feedback requests and success responses", async () => {
    const feedback = fixture<MemoryFeedbackV2>("MemoryFeedbackV2");
    const result = fixture<MemoryFeedbackResultV2>("MemoryFeedbackResultV2");
    const invalidFeedback = {
      ...feedback,
      unexpected: true,
    } as unknown as MemoryFeedbackV2;

    await expect(
      client().submitFeedback("", feedback),
    ).rejects.toBeInstanceOf(MemoryContractValidationError);
    await expect(
      client().submitFeedback("feedback-key", invalidFeedback),
    ).rejects.toBeInstanceOf(MemoryContractValidationError);
    expect(mockFetch).not.toHaveBeenCalled();

    mockResponse({ ...result, unexpected: true });
    await expect(
      client().submitFeedback("feedback-key", feedback),
    ).rejects.toBeInstanceOf(MemoryContractValidationError);
  });

  it("gets candidate status and posts decisions to bounded encoded URLs", async () => {
    const status = fixture<MemoryCandidateStatusV2>("MemoryCandidateStatusV2");
    const decision = fixture<MemoryCandidateDecisionV2>("MemoryCandidateDecisionV2");
    const result = fixture<MemoryCandidateDecisionResultV2>(
      "MemoryCandidateDecisionResultV2",
    );
    mockResponse(status);

    await expect(client().getCandidate("candidate/v2")).resolves.toEqual(status);
    expect(request()[0]).toBe(
      "http://localhost:4000/api/v2/memory/candidates/candidate%2Fv2",
    );
    expect(request()[1].method).toBeUndefined();

    mockFetch.mockReset();
    mockResponse(result);
    await expect(
      client().decideCandidate("candidate/v2", decision),
    ).resolves.toEqual(result);
    const [url, init] = request();
    const headers = new Headers(init.headers);
    expect(url).toBe(
      "http://localhost:4000/api/v2/memory/candidates/candidate%2Fv2/decisions",
    );
    expect(init.method).toBe("POST");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual(decision);
  });

  it("gets producer-bound harness candidate status from the exact narrowed selector", async () => {
    const selector = fixture<MemoryMcpHarnessCandidateStatusInputV2>(
      "MemoryMcpCandidateStatusInputV2",
    );
    const status = {
      ...fixture<MemoryCandidateStatusV2>("MemoryCandidateStatusV2"),
      plane: "harness",
    } as MemoryCandidateStatusV2;
    mockResponse(status);

    await expect(client().getHarnessCandidate(selector)).resolves.toEqual(status);
    expect(request()[0]).toBe(
      "http://localhost:4000/api/v2/memory/candidates/"
      + "harness-candidate-row-v2-contract-1?plane=harness"
      + "&receipt_id=receipt-harness-v2-contract-1"
      + "&producer_run_id=example-harness-a%3Atest%3Aharness-thread-1%3Arun-1"
      + "&resource_row_id=resource-harness-contract",
    );
    expect(request()[1].method).toBeUndefined();

    mockFetch.mockReset();
    const canonicalSelector = {
      ...selector,
      resource_selector: { canonical_resource_id: "example-harness-a" },
    } satisfies MemoryMcpHarnessCandidateStatusInputV2;
    mockResponse(status);
    await expect(client().getHarnessCandidate(canonicalSelector)).resolves.toEqual(status);
    expect(request()[0]).toContain("&canonical_resource_id=example-harness-a");
  });

  it("rejects malformed harness candidate authority before fetching", async () => {
    const selector = fixture<MemoryMcpHarnessCandidateStatusInputV2>(
      "MemoryMcpCandidateStatusInputV2",
    );
    for (const invalid of [
      { ...selector, plane: "codebase" },
      { ...selector, receipt_id: "" },
      { ...selector, producer_run_id: "" },
      { ...selector, resource_selector: null },
      { ...selector, tenant: { project_id: "caller-must-not-declare-authority" } },
    ]) {
      await expect(
        client().getHarnessCandidate(
          invalid as unknown as MemoryMcpHarnessCandidateStatusInputV2,
        ),
      ).rejects.toBeInstanceOf(MemoryContractValidationError);
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("bounds candidate IDs and strictly parses decision requests and both responses", async () => {
    const status = fixture<MemoryCandidateStatusV2>("MemoryCandidateStatusV2");
    const decision = fixture<MemoryCandidateDecisionV2>("MemoryCandidateDecisionV2");
    const result = fixture<MemoryCandidateDecisionResultV2>(
      "MemoryCandidateDecisionResultV2",
    );
    const invalidDecision = {
      ...decision,
      unexpected: true,
    } as unknown as MemoryCandidateDecisionV2;
    const removedDecision = {
      ...decision,
      decision: "request_changes",
    } as unknown as MemoryCandidateDecisionV2;

    await expect(client().getCandidate("")).rejects.toThrow(
      "candidateId must contain 1 to 128 characters",
    );
    await expect(
      client().decideCandidate("x".repeat(129), decision),
    ).rejects.toThrow("candidateId must contain 1 to 128 characters");
    await expect(
      client().decideCandidate("candidate-v2", invalidDecision),
    ).rejects.toBeInstanceOf(MemoryContractValidationError);
    await expect(
      client().decideCandidate("candidate-v2", removedDecision),
    ).rejects.toBeInstanceOf(MemoryContractValidationError);
    expect(mockFetch).not.toHaveBeenCalled();

    mockResponse({ ...status, unexpected: true });
    await expect(client().getCandidate("candidate-v2")).rejects.toBeInstanceOf(
      MemoryContractValidationError,
    );

    mockFetch.mockReset();
    mockResponse({ ...result, unexpected: true });
    await expect(
      client().decideCandidate("candidate-v2", decision),
    ).rejects.toBeInstanceOf(MemoryContractValidationError);

    mockFetch.mockReset();
    mockResponse({ ...result, decision: "request_changes" });
    await expect(
      client().decideCandidate("candidate-v2", decision),
    ).rejects.toBeInstanceOf(MemoryContractValidationError);
  });

  it("wraps only strictly valid v2 error envelopes", async () => {
    const error = fixture<PimErrorV2>("PimErrorV2");
    const receipt = fixture<CodebaseRunReceiptV2>("RunReceiptV2");
    const feedback = fixture<MemoryFeedbackV2>("MemoryFeedbackV2");
    mockResponse(error, 422);

    await expect(
      client().putRunReceipt("run-v2", "receipt-key", receipt),
    ).rejects.toMatchObject({
      name: "PimMemoryV2ApiError",
      message: error.message,
      statusCode: 422,
      response: error,
    } satisfies Partial<PimMemoryV2ApiError>);

    mockFetch.mockReset();
    mockResponse({ ...error, unexpected: true }, 422);
    await expect(
      client().submitFeedback("feedback-key", feedback),
    ).rejects.toBeInstanceOf(MemoryContractValidationError);
  });

  it("wraps non-JSON and empty non-success responses without reflecting their bodies", async () => {
    for (const [body, status] of [
      ["<html>upstream-secret</html>", 502],
      [null, 503],
    ] as const) {
      mockFetch.mockReset();
      mockFetch.mockResolvedValue(new Response(body, {
        status,
        headers: { "Content-Type": "text/html" },
      }));

      const thrown = await client().capabilities().catch((error: unknown) => error);
      expect(thrown).toMatchObject({
        name: "PimMemoryV2ApiError",
        message: "Memory API returned a non-JSON error response",
        statusCode: status,
        response: {
          schema_version: "pim.error.v2",
          code: "temporarily_unavailable",
          message: "Memory API returned a non-JSON error response",
          request_id: null,
          plane: null,
          retryable: true,
          details: [],
        },
      } satisfies Partial<PimMemoryV2ApiError>);
      expect((thrown as PimMemoryV2ApiError).message).not.toContain("upstream-secret");
    }
  });
});
