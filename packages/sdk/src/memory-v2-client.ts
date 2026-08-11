import {
  parseMemoryContractV2,
  type CodebaseMemorySearchV2,
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
  type RunReceiptV2,
} from "@pim/shared";

export interface PimMemoryV2ClientConfig {
  baseUrl: string;
  authToken: string;
  /** Optional compatibility header; memory authorization is derived from the token. */
  orgSlug?: string;
}

export class PimMemoryV2ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly response: PimErrorV2,
  ) {
    super(response.message);
    this.name = "PimMemoryV2ApiError";
  }
}

function nonJsonErrorResponse(statusCode: number): PimErrorV2 {
  return {
    schema_version: "pim.error.v2",
    code: "temporarily_unavailable",
    message: "Memory API returned a non-JSON error response",
    request_id: null,
    plane: null,
    retryable: statusCode === 429 || statusCode >= 500,
    details: [],
  };
}

/** Strict client for the implemented memory v2 HTTP surface. */
export class PimMemoryV2Client {
  constructor(private readonly config: PimMemoryV2ClientConfig) {}

  private url(path: string): string {
    return `${this.config.baseUrl.replace(/\/+$/, "")}${path}`;
  }

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${this.config.authToken}`);
    if (this.config.orgSlug) headers.set("X-Pim-Org", this.config.orgSlug);

    const response = await fetch(this.url(path), { ...init, headers });
    let body: unknown;
    try {
      body = await response.json() as unknown;
    } catch (error) {
      if (response.ok) throw error;
      throw new PimMemoryV2ApiError(
        response.status,
        nonJsonErrorResponse(response.status),
      );
    }
    if (!response.ok) {
      throw new PimMemoryV2ApiError(
        response.status,
        parseMemoryContractV2("PimErrorV2", body),
      );
    }
    return body;
  }

  async capabilities(): Promise<MemoryCapabilitiesV2> {
    return parseMemoryContractV2(
      "MemoryCapabilitiesV2",
      await this.request("/api/v2/memory/capabilities"),
    );
  }

  async binding(): Promise<MemoryBindingV2> {
    return parseMemoryContractV2(
      "MemoryBindingV2",
      await this.request("/api/v2/memory/binding"),
    );
  }

  async readiness(selector: MemoryMcpReadinessInputV2): Promise<MemoryReadinessV2> {
    const input = parseMemoryContractV2("MemoryMcpReadinessInputV2", selector);
    const query = new URLSearchParams({
      plane: input.plane,
      ...(input.resource_selector && "resource_row_id" in input.resource_selector
        ? { resource_row_id: input.resource_selector.resource_row_id }
        : { canonical_resource_id: input.resource_selector.canonical_resource_id }),
    });
    return parseMemoryContractV2(
      "MemoryReadinessV2",
      await this.request(`/api/v2/memory/readiness?${query.toString()}`),
    );
  }

  async searchCode(request: CodebaseMemorySearchV2): Promise<MemorySearchResultV2> {
    const body = parseMemoryContractV2("CodebaseMemorySearchV2", request);
    return parseMemoryContractV2(
      "MemorySearchResultV2",
      await this.request("/api/v2/memory/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  async searchHarness(request: HarnessMemorySearchV2): Promise<MemorySearchResultV2> {
    const body = parseMemoryContractV2("HarnessMemorySearchV2", request);
    return parseMemoryContractV2(
      "MemorySearchResultV2",
      await this.request("/api/v2/memory/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  async getRecord(recordId: string, recordVersion: number): Promise<MemoryRecordV2> {
    this.assertRecordId(recordId);
    if (!Number.isSafeInteger(recordVersion) || recordVersion < 1) {
      throw new TypeError("recordVersion must be a positive integer");
    }
    return parseMemoryContractV2(
      "MemoryRecordV2",
      await this.request(
        `/api/v2/memory/records/${encodeURIComponent(recordId)}?version=${recordVersion}`,
      ),
    );
  }

  async getRecordHistory(recordId: string): Promise<MemoryRecordHistoryV2> {
    this.assertRecordId(recordId);
    return parseMemoryContractV2(
      "MemoryRecordHistoryV2",
      await this.request(`/api/v2/memory/records/${encodeURIComponent(recordId)}/history`),
    );
  }

  async getPack(packId: string): Promise<MemoryRetrievalPackV2> {
    this.assertPathId("packId", packId, 128);
    return parseMemoryContractV2(
      "MemoryRetrievalPackV2",
      await this.request(`/api/v2/memory/packs/${encodeURIComponent(packId)}`),
    );
  }

  async putRunReceipt(
    producerRunId: string,
    idempotencyKey: string,
    receipt: RunReceiptV2,
  ): Promise<RunReceiptResultV2> {
    this.assertPathId("producerRunId", producerRunId, 256);
    this.assertIdempotencyKey(idempotencyKey);
    const body = parseMemoryContractV2("RunReceiptV2", receipt);
    return parseMemoryContractV2(
      "RunReceiptResultV2",
      await this.request(
        `/api/v2/memory/run-receipts/${encodeURIComponent(producerRunId)}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify(body),
        },
      ),
    );
  }

  async submitFeedback(
    idempotencyKey: string,
    feedback: MemoryFeedbackV2,
  ): Promise<MemoryFeedbackResultV2> {
    this.assertIdempotencyKey(idempotencyKey);
    const body = parseMemoryContractV2("MemoryFeedbackV2", feedback);
    return parseMemoryContractV2(
      "MemoryFeedbackResultV2",
      await this.request("/api/v2/memory/feedback", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(body),
      }),
    );
  }

  async getCandidate(candidateId: string): Promise<MemoryCandidateStatusV2> {
    this.assertPathId("candidateId", candidateId, 128);
    return parseMemoryContractV2(
      "MemoryCandidateStatusV2",
      await this.request(`/api/v2/memory/candidates/${encodeURIComponent(candidateId)}`),
    );
  }

  async getHarnessCandidate(
    selector: MemoryMcpHarnessCandidateStatusInputV2,
  ): Promise<MemoryCandidateStatusV2> {
    const input = parseMemoryContractV2(
      "MemoryMcpHarnessCandidateStatusInputV2",
      selector,
    );
    const query = new URLSearchParams({
      plane: "harness",
      receipt_id: input.receipt_id,
      producer_run_id: input.producer_run_id,
      ...(input.resource_selector && "resource_row_id" in input.resource_selector
        ? { resource_row_id: input.resource_selector.resource_row_id }
        : { canonical_resource_id: input.resource_selector.canonical_resource_id }),
    });
    return parseMemoryContractV2(
      "MemoryCandidateStatusV2",
      await this.request(
        `/api/v2/memory/candidates/${encodeURIComponent(input.candidate_id)}?${query.toString()}`,
      ),
    );
  }

  async decideCandidate(
    candidateId: string,
    decision: MemoryCandidateDecisionV2,
  ): Promise<MemoryCandidateDecisionResultV2> {
    this.assertPathId("candidateId", candidateId, 128);
    const body = parseMemoryContractV2("MemoryCandidateDecisionV2", decision);
    return parseMemoryContractV2(
      "MemoryCandidateDecisionResultV2",
      await this.request(
        `/api/v2/memory/candidates/${encodeURIComponent(candidateId)}/decisions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      ),
    );
  }

  private assertRecordId(recordId: string): void {
    this.assertPathId("recordId", recordId, 128);
  }

  private assertPathId(name: string, value: string, maxLength: number): void {
    if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
      throw new TypeError(`${name} must contain 1 to ${maxLength} characters`);
    }
  }

  private assertIdempotencyKey(idempotencyKey: string): void {
    parseMemoryContractV2("MemoryMcpIdempotencyKeyV2", idempotencyKey);
  }
}
