import {
  parseMemoryContract,
  type MemoryCapabilitiesV1,
  type MemoryCandidateStatusV1,
  type MemoryCandidateDecisionResultV1,
  type MemoryCandidateDecisionV1,
  type MemoryFeedbackResultV1,
  type MemoryFeedbackV1,
  type MemoryHarnessSearchResultV1,
  type MemoryHarnessSearchV1,
  type MemoryRecordV1,
  type MemoryRecordHistoryV1,
  type MemorySearchResultV1,
  type MemorySearchV1,
  type PimErrorV1,
  type RunReceiptResultV1,
  type RunReceiptV1,
} from "@pim/shared";

export interface PimMemoryClientConfig {
  baseUrl: string;
  authToken: string;
  /** Optional compatibility header; memory authorization is derived from the token. */
  orgSlug?: string;
}

export class PimMemoryApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly response: PimErrorV1,
  ) {
    super(response.message);
    this.name = "PimMemoryApiError";
  }
}

function nonJsonErrorResponse(): PimErrorV1 {
  return {
    schema_version: "pim.error.v1",
    code: "temporarily_unavailable",
    message: "Memory API returned a non-JSON error response",
  };
}

export class PimMemoryClient {
  constructor(private readonly config: PimMemoryClientConfig) {}

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
      throw new PimMemoryApiError(response.status, nonJsonErrorResponse());
    }
    if (!response.ok) {
      throw new PimMemoryApiError(response.status, parseMemoryContract("PimErrorV1", body));
    }
    return body;
  }

  async capabilities(): Promise<MemoryCapabilitiesV1> {
    return parseMemoryContract(
      "MemoryCapabilitiesV1",
      await this.request("/api/v1/memory/capabilities"),
    );
  }

  async search(request: MemorySearchV1): Promise<MemorySearchResultV1> {
    const body = parseMemoryContract("MemorySearchV1", request);
    return parseMemoryContract(
      "MemorySearchResultV1",
      await this.request("/api/v1/memory/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  async harnessSearch(request: MemoryHarnessSearchV1): Promise<MemoryHarnessSearchResultV1> {
    const body = parseMemoryContract("MemoryHarnessSearchV1", request);
    return parseMemoryContract(
      "MemoryHarnessSearchResultV1",
      await this.request("/api/v1/memory/harness/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  async getRecord(recordId: string, recordVersion: number): Promise<MemoryRecordV1> {
    if (!Number.isSafeInteger(recordVersion) || recordVersion < 1) {
      throw new TypeError("recordVersion must be a positive integer");
    }
    return parseMemoryContract(
      "MemoryRecordV1",
      await this.request(
        `/api/v1/memory/records/${encodeURIComponent(recordId)}?version=${recordVersion}`,
      ),
    );
  }

  async getRecordHistory(recordId: string): Promise<MemoryRecordHistoryV1> {
    if (!recordId || recordId.length > 128) {
      throw new TypeError("recordId must contain 1 to 128 characters");
    }
    return parseMemoryContract(
      "MemoryRecordHistoryV1",
      await this.request(`/api/v1/memory/records/${encodeURIComponent(recordId)}/history`),
    );
  }

  async putRunReceipt(
    producerRunId: string,
    receipt: RunReceiptV1,
    idempotencyKey?: string,
  ): Promise<RunReceiptResultV1> {
    if (!producerRunId || producerRunId.length > 256) {
      throw new TypeError("producerRunId must contain 1 to 256 characters");
    }
    const body = parseMemoryContract("RunReceiptV1", receipt);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    return parseMemoryContract(
      "RunReceiptResultV1",
      await this.request(
        `/api/v1/memory/run-receipts/${encodeURIComponent(producerRunId)}`,
        { method: "PUT", headers, body: JSON.stringify(body) },
      ),
    );
  }

  async getCandidate(candidateId: string): Promise<MemoryCandidateStatusV1> {
    if (!candidateId || candidateId.length > 128) {
      throw new TypeError("candidateId must contain 1 to 128 characters");
    }
    return parseMemoryContract(
      "MemoryCandidateStatusV1",
      await this.request(`/api/v1/memory/candidates/${encodeURIComponent(candidateId)}`),
    );
  }

  async submitFeedback(feedback: MemoryFeedbackV1): Promise<MemoryFeedbackResultV1> {
    const body = parseMemoryContract("MemoryFeedbackV1", feedback);
    return parseMemoryContract(
      "MemoryFeedbackResultV1",
      await this.request("/api/v1/memory/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  async decideCandidate(
    candidateId: string,
    decision: MemoryCandidateDecisionV1,
  ): Promise<MemoryCandidateDecisionResultV1> {
    if (!candidateId || candidateId.length > 128) {
      throw new TypeError("candidateId must contain 1 to 128 characters");
    }
    const body = parseMemoryContract("MemoryCandidateDecisionV1", decision);
    return parseMemoryContract(
      "MemoryCandidateDecisionResultV1",
      await this.request(
        `/api/v1/memory/candidates/${encodeURIComponent(candidateId)}/decisions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      ),
    );
  }
}
