import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MemoryContractValidationError,
  MEMORY_CONTRACT_FIXTURES,
  type MemoryCandidateDecisionResultV1,
  type MemoryCandidateDecisionV1,
  type MemoryFeedbackResultV1,
  type MemoryFeedbackV1,
  type MemoryHarnessSearchResultV1,
  type MemoryHarnessSearchV1,
  type MemoryPromptPolicyUpdateV1,
  type MemoryPromptPolicyV1,
  type MemoryReleaseGateDecisionV1,
  type MemoryReleaseGateEvaluationV1,
  type PimErrorV1,
} from "@pim/shared";
import { PimMemoryApiError, PimMemoryClient } from "../memory-client.js";

const mockFetch = vi.fn();

const feedback = {
  schema_version: "pim.memory-feedback.v1",
  feedback_revision: 2,
  retrieval_pack_id: "pack_1",
  record_id: "mem_1",
  record_version: 3,
  producer_run_id: "fiesta:thread-1:run-2",
  repository_id: "github.com/acme/checkout",
  base_sha: "0123456789abcdef0123456789abcdef01234567",
  disposition: "helpful",
  reason_code: "prevented_duplicate_retry",
  outcome_evidence_refs: ["test_run_1"],
  event_time: "2026-08-03T18:00:00Z",
} satisfies MemoryFeedbackV1;

const feedbackResult = {
  schema_version: "pim.memory-feedback-result.v1",
  feedback_id: "feedback_1",
  feedback_revision: 2,
  duplicate: false,
  review_signal_ids: [],
} satisfies MemoryFeedbackResultV1;

const decision = {
  schema_version: "pim.memory-candidate-decision.v1",
  decision_revision: 4,
  decision: "approve",
  reason_code: "failure_evidence_reviewed",
  explanation: "The failure evidence and bounded exceptions are supported.",
  evidence_refs: ["failure_1"],
  event_time: "2026-08-03T18:05:00Z",
} satisfies MemoryCandidateDecisionV1;

const decisionResult = {
  schema_version: "pim.memory-candidate-decision-result.v1",
  decision_id: "decision_1",
  candidate_id: "candidate/1",
  decision_revision: 4,
  decision: "approve",
  candidate_status: "active",
  active_record: { record_id: "mem_2", record_version: 1 },
  duplicate: false,
} satisfies MemoryCandidateDecisionResultV1;

function client(): PimMemoryClient {
  return new PimMemoryClient({
    baseUrl: "http://localhost:4000/",
    authToken: "memory-token",
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

function request(): [string, RequestInit] {
  return mockFetch.mock.calls[0] as [string, RequestInit];
}

describe("PimMemoryClient feedback and review", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  describe("submitFeedback", () => {
    it("posts the validated body with memory authentication", async () => {
      mockResponse(feedbackResult);

      await expect(client().submitFeedback(feedback)).resolves.toEqual(feedbackResult);

      const [url, init] = request();
      const headers = new Headers(init.headers);
      expect(url).toBe("http://localhost:4000/api/v1/memory/feedback");
      expect(init.method).toBe("POST");
      expect(headers.get("Authorization")).toBe("Bearer memory-token");
      expect(headers.get("X-Pim-Org")).toBe("acme");
      expect(headers.get("Content-Type")).toBe("application/json");
      expect(JSON.parse(String(init.body))).toEqual(feedback);
    });

    it("strictly validates a successful response", async () => {
      mockResponse({ ...feedbackResult, unexpected: true });

      await expect(client().submitFeedback(feedback)).rejects.toBeInstanceOf(
        MemoryContractValidationError,
      );
    });

    it("parses a non-success response as PimMemoryApiError", async () => {
      const error = {
        schema_version: "pim.error.v1",
        code: "resource_binding_mismatch",
        message: "Feedback does not match the authenticated project binding",
        request_id: "feedback-request-1",
      } satisfies PimErrorV1;
      mockResponse(error, 403);

      await expect(client().submitFeedback(feedback)).rejects.toMatchObject({
        name: "PimMemoryApiError",
        statusCode: 403,
        response: error,
      } satisfies Partial<PimMemoryApiError>);
    });
  });

  describe("decideCandidate", () => {
    it("posts the validated body to the encoded candidate URL with memory authentication", async () => {
      mockResponse(decisionResult);

      await expect(client().decideCandidate("candidate/1", decision)).resolves.toEqual(
        decisionResult,
      );

      const [url, init] = request();
      const headers = new Headers(init.headers);
      expect(url).toBe(
        "http://localhost:4000/api/v1/memory/candidates/candidate%2F1/decisions",
      );
      expect(init.method).toBe("POST");
      expect(headers.get("Authorization")).toBe("Bearer memory-token");
      expect(headers.get("X-Pim-Org")).toBe("acme");
      expect(headers.get("Content-Type")).toBe("application/json");
      expect(JSON.parse(String(init.body))).toEqual(decision);
    });

    it("strictly validates a successful response", async () => {
      const { duplicate: _duplicate, ...invalidResult } = decisionResult;
      mockResponse(invalidResult);

      await expect(
        client().decideCandidate("candidate/1", decision),
      ).rejects.toBeInstanceOf(MemoryContractValidationError);
    });

    it("parses a non-success response as PimMemoryApiError", async () => {
      const error = {
        schema_version: "pim.error.v1",
        code: "transition_invalid",
        message: "Candidate can no longer accept this decision",
        request_id: "decision-request-1",
        details: [{ path: "/decision_revision", reason: "stale decision revision" }],
      } satisfies PimErrorV1;
      mockResponse(error, 409);

      await expect(
        client().decideCandidate("candidate/1", decision),
      ).rejects.toMatchObject({
        name: "PimMemoryApiError",
        statusCode: 409,
        response: error,
      } satisfies Partial<PimMemoryApiError>);
    });
  });

  describe("getRecordHistory", () => {
    it("gets and strictly validates the encoded record history URL", async () => {
      const history = structuredClone(MEMORY_CONTRACT_FIXTURES.MemoryRecordHistoryV1);
      mockResponse(history);

      await expect(client().getRecordHistory("memory/1")).resolves.toEqual(history);
      const [url, init] = request();
      expect(url).toBe("http://localhost:4000/api/v1/memory/records/memory%2F1/history");
      expect(init.method).toBeUndefined();

      mockFetch.mockReset();
      mockResponse({ ...history, replaced_by: { ...history.replaced_by, unexpected: true } });
      await expect(client().getRecordHistory("memory/1")).rejects.toBeInstanceOf(
        MemoryContractValidationError,
      );
      await expect(client().getRecordHistory("")).rejects.toThrow(
        "recordId must contain 1 to 128 characters",
      );
    });
  });

  describe("harnessSearch", () => {
    it("posts and strictly parses the dedicated permanent-shadow contract", async () => {
      const requestBody = structuredClone(
        MEMORY_CONTRACT_FIXTURES.MemoryHarnessSearchV1,
      ) as unknown as MemoryHarnessSearchV1;
      const resultBody = structuredClone(
        MEMORY_CONTRACT_FIXTURES.MemoryHarnessSearchResultV1,
      ) as unknown as MemoryHarnessSearchResultV1;
      mockResponse(resultBody);

      await expect(client().harnessSearch(requestBody)).resolves.toEqual(resultBody);

      const [url, init] = request();
      expect(url).toBe("http://localhost:4000/api/v1/memory/harness/search");
      expect(init.method).toBe("POST");
      expect(JSON.parse(String(init.body))).toEqual(requestBody);
    });

    it("rejects a response that widens permanent-shadow fields", async () => {
      const requestBody = structuredClone(
        MEMORY_CONTRACT_FIXTURES.MemoryHarnessSearchV1,
      ) as unknown as MemoryHarnessSearchV1;
      const resultBody = structuredClone(
        MEMORY_CONTRACT_FIXTURES.MemoryHarnessSearchResultV1,
      ) as unknown as MemoryHarnessSearchResultV1;
      mockResponse({ ...resultBody, routing_influence: true });

      await expect(client().harnessSearch(requestBody)).rejects.toBeInstanceOf(
        MemoryContractValidationError,
      );
    });
  });

  describe("prompt policy and release gates", () => {
    it("gets and updates a strictly validated project prompt policy", async () => {
      const policy = structuredClone(
        MEMORY_CONTRACT_FIXTURES.MemoryPromptPolicyV1,
      ) as unknown as MemoryPromptPolicyV1;
      const update = structuredClone(
        MEMORY_CONTRACT_FIXTURES.MemoryPromptPolicyUpdateV1,
      ) as unknown as MemoryPromptPolicyUpdateV1;
      mockResponse(policy);

      await expect(client().getPromptPolicy("project/checkout")).resolves.toEqual(policy);
      expect(request()[0]).toBe(
        "http://localhost:4000/api/v1/memory/projects/project%2Fcheckout/prompt-policy",
      );
      expect(request()[1].method).toBeUndefined();

      mockFetch.mockReset();
      mockResponse(policy);
      await expect(
        client().updatePromptPolicy("project/checkout", update),
      ).resolves.toEqual(policy);
      const [url, init] = request();
      expect(url).toBe(
        "http://localhost:4000/api/v1/memory/projects/project%2Fcheckout/prompt-policy",
      );
      expect(init.method).toBe("PUT");
      expect(JSON.parse(String(init.body))).toEqual(update);
    });

    it("evaluates release gates through the strict admin contract", async () => {
      const evaluation = structuredClone(
        MEMORY_CONTRACT_FIXTURES.MemoryReleaseGateEvaluationV1,
      ) as unknown as MemoryReleaseGateEvaluationV1;
      const decision = structuredClone(
        MEMORY_CONTRACT_FIXTURES.MemoryReleaseGateDecisionV1,
      ) as unknown as MemoryReleaseGateDecisionV1;
      mockResponse(decision);

      await expect(
        client().evaluateReleaseGates("project-checkout", evaluation),
      ).resolves.toEqual(decision);
      const [url, init] = request();
      expect(url).toBe(
        "http://localhost:4000/api/v1/memory/projects/project-checkout/release-gates/evaluate",
      );
      expect(init.method).toBe("POST");
      expect(JSON.parse(String(init.body))).toEqual(evaluation);
    });

    it("rejects malformed control-plane responses and invalid project ids", async () => {
      const policy = structuredClone(
        MEMORY_CONTRACT_FIXTURES.MemoryPromptPolicyV1,
      ) as unknown as MemoryPromptPolicyV1;
      mockResponse({ ...policy, effective_enabled: "yes" });

      await expect(client().getPromptPolicy("project-checkout")).rejects.toBeInstanceOf(
        MemoryContractValidationError,
      );
      await expect(client().getPromptPolicy("")).rejects.toThrow(
        "projectId must contain 1 to 128 characters",
      );
    });
  });
});
