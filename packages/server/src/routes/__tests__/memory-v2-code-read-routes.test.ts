import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MEMORY_CONTRACT_FIXTURES_V2,
  parseMemoryContractV2,
} from "@pim/shared";

const codeReads = vi.hoisted(() => ({
  search: vi.fn(),
  record: vi.fn(),
  history: vi.fn(),
  pack: vi.fn(),
}));
const harnessReads = vi.hoisted(() => ({ search: vi.fn() }));

vi.mock("../../services/memory-v2-code-read.js", () => {
  class MemoryV2CodeReadError extends Error {
    constructor(
      message: string,
      readonly statusCode: number,
      readonly code: string,
      readonly details: Array<{ path: string; reason: string }> = [],
    ) {
      super(message);
      this.name = "MemoryV2CodeReadError";
    }
  }
  return {
    MemoryV2CodeReadError,
    authorizeCodeMemorySearchV2: ({ principal }: { principal: unknown }) => principal,
    searchAuthorizedCodeMemoryV2: ({ authorization, request }: {
      authorization: unknown; request: unknown;
    }) => codeReads.search({ principal: authorization, request }),
    authorizeCodeMemoryRecordHistoryV2: ({ principal }: { principal: unknown }) => principal,
    getAuthorizedCodeMemoryRecordHistoryV2: ({ authorization, recordId }: {
      authorization: unknown; recordId: string;
    }) => codeReads.history({ principal: authorization, recordId }),
  };
});

vi.mock("../../services/memory-v2-harness-read.js", () => {
  class MemoryV2HarnessReadError extends Error {
    constructor(
      message: string,
      readonly statusCode: number,
      readonly code: string,
      readonly details: Array<{ path: string; reason: string }> = [],
    ) {
      super(message);
      this.name = "MemoryV2HarnessReadError";
    }
  }
  return {
    MemoryV2HarnessReadError,
    authorizeHarnessMemorySearchV2: ({ principal }: { principal: unknown }) => principal,
    searchAuthorizedHarnessMemoryV2: ({ authorization, request }: {
      authorization: unknown; request: unknown;
    }) => harnessReads.search({ principal: authorization, request }),
  };
});

vi.mock("../../services/memory-v2-read-dispatch.js", () => {
  class MemoryV2ReadDispatchError extends Error {
    readonly details: Array<{ path: string; reason: string }> = [];
    constructor(
      message: string,
      readonly statusCode: number,
      readonly code: string,
      readonly plane?: "codebase" | "harness",
    ) {
      super(message);
      this.name = "MemoryV2ReadDispatchError";
    }
  }
  return {
    MemoryV2ReadDispatchError,
    getMemoryRecordV2: codeReads.record,
    getMemoryPackV2: codeReads.pack,
  };
});

import { MemoryV2CodeReadError } from "../../services/memory-v2-code-read.js";
import {
  setMemoryMetricSink,
  type MemoryMetric,
} from "../../services/memory-metrics.js";
import type { ServiceTokenAuthMetadata } from "../../services/service-tokens.js";
import memoryV2SearchRoutes, {
  MEMORY_V2_RECORD_ID_MAX_LENGTH,
} from "../memory-v2-search.js";

const principal: ServiceTokenAuthMetadata = {
  kind: "service_token",
  tokenId: "token-route-v2",
  servicePrincipalId: "principal-route-v2",
  scopes: ["memory:search"],
  orgId: "org-acme",
  projectId: "project-checkout",
  repositoryBindings: [{
    repositoryRowId: "repository-row-route-v2",
    repositoryId: "github.com/acme/checkout",
  }],
};

const metrics: MemoryMetric[] = [];
let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({
    routerOptions: { maxParamLength: MEMORY_V2_RECORD_ID_MAX_LENGTH },
  });
  app.addHook("onRequest", async (request) => {
    request.auth = principal;
    request.memoryV2Authorization = principal as never;
  });
  setMemoryMetricSink((metric) => metrics.push(metric));
  await app.register(memoryV2SearchRoutes);
  await app.ready();
});

afterAll(async () => {
  setMemoryMetricSink(null);
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  metrics.length = 0;
  codeReads.search.mockResolvedValue(structuredClone(
    MEMORY_CONTRACT_FIXTURES_V2.MemorySearchResultV2,
  ));
  codeReads.record.mockReturnValue(structuredClone(
    MEMORY_CONTRACT_FIXTURES_V2.MemoryRecordV2,
  ));
  codeReads.history.mockReturnValue(structuredClone(
    MEMORY_CONTRACT_FIXTURES_V2.MemoryRecordHistoryV2,
  ));
  codeReads.pack.mockReturnValue(structuredClone(
    MEMORY_CONTRACT_FIXTURES_V2.MemoryRetrievalPackV2,
  ));
  harnessReads.search.mockResolvedValue({
    ...structuredClone(MEMORY_CONTRACT_FIXTURES_V2.MemorySearchResultV2),
    plane: "harness",
    items: [],
    token_count: 0,
  });
});

describe("Slice-2 code memory HTTP surface", () => {
  it("delegates code search with authenticated authority and bounded direct-HTTP metrics", async () => {
    const body = structuredClone(MEMORY_CONTRACT_FIXTURES_V2.MemorySearchV2);
    const response = await app.inject({
      method: "POST",
      url: "/api/v2/memory/search",
      payload: body,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers.vary).toBe("Authorization");
    expect(parseMemoryContractV2("MemorySearchResultV2", response.json()))
      .toEqual(MEMORY_CONTRACT_FIXTURES_V2.MemorySearchResultV2);
    expect(codeReads.search).toHaveBeenCalledWith({ principal, request: body });
    expect(metrics.map((metric) => metric.name)).toEqual([
      "SearchOutcome",
      "SearchResultCount",
      "SearchLatency",
    ]);
    for (const metric of metrics) {
      expect(metric.dimensions).toMatchObject({
        transport: "direct_http",
        operation: "search",
        plane: "codebase",
        resource_type: "repository",
        contract_version: "pim.memory.v2",
        outcome: "success",
        reason: "completed",
      });
      expect(Object.keys(metric.fields ?? {}).every((field) => field.endsWith("_id")))
        .toBe(true);
      expect(JSON.stringify(metric)).not.toContain(body.task.query);
    }
    expect(metrics.find((metric) => metric.name === "SearchLatency")).toMatchObject({
      unit: "Milliseconds",
      value: expect.any(Number),
    });
  });

  it("records bounded outcome and latency measures for search contract failures", async () => {
    const body = {
      ...structuredClone(MEMORY_CONTRACT_FIXTURES_V2.MemorySearchV2),
      applicability: {
        ...MEMORY_CONTRACT_FIXTURES_V2.MemorySearchV2.applicability,
        base_sha: "not-a-sha",
      },
    };
    const response = await app.inject({
      method: "POST",
      url: "/api/v2/memory/search",
      payload: body,
    });

    expect(response.statusCode, response.body).toBe(400);
    expect(parseMemoryContractV2("PimErrorV2", response.json())).toMatchObject({
      code: "schema_invalid",
      plane: "codebase",
    });
    expect(codeReads.search).not.toHaveBeenCalled();
    expect(metrics.map((metric) => metric.name)).toEqual([
      "SearchOutcome",
      "SearchLatency",
    ]);
    for (const metric of metrics) {
      expect(metric.dimensions).toMatchObject({
        transport: "direct_http",
        operation: "search",
        plane: "codebase",
        resource_type: "repository",
        contract_version: "pim.memory.v2",
        outcome: "rejected",
        reason: "schema_invalid",
        status: "4xx",
      });
      expect(JSON.stringify(metric)).not.toContain(body.task.query);
    }
  });

  it("serves only a required positive immutable version and the canonical history", async () => {
    const missingVersion = await app.inject({
      method: "GET",
      url: "/api/v2/memory/records/memory-v2-contract-1",
    });
    expect(missingVersion.statusCode).toBe(400);
    expect(parseMemoryContractV2("PimErrorV2", missingVersion.json())).toMatchObject({
      code: "schema_invalid",
      plane: "codebase",
      retryable: false,
    });
    expect(codeReads.record).not.toHaveBeenCalled();

    const detail = await app.inject({
      method: "GET",
      url: "/api/v2/memory/records/memory-v2-contract-1?version=1",
    });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(parseMemoryContractV2("MemoryRecordV2", detail.json()))
      .toEqual(MEMORY_CONTRACT_FIXTURES_V2.MemoryRecordV2);
    expect(codeReads.record).toHaveBeenCalledWith({
      principal,
      recordId: "memory-v2-contract-1",
      recordVersion: 1,
    });

    const history = await app.inject({
      method: "GET",
      url: "/api/v2/memory/records/memory-v2-contract-1/history",
    });
    expect(history.statusCode, history.body).toBe(200);
    expect(parseMemoryContractV2("MemoryRecordHistoryV2", history.json()))
      .toEqual(MEMORY_CONTRACT_FIXTURES_V2.MemoryRecordHistoryV2);
    expect(codeReads.history).toHaveBeenCalledWith({
      principal,
      recordId: "memory-v2-contract-1",
    });
    expect(detail.headers["cache-control"]).toBe("private, no-store");
    expect(history.headers["cache-control"]).toBe("private, no-store");
  });

  it("serves the canonical immutable pack over HTTP", async () => {
    const fixture = structuredClone(MEMORY_CONTRACT_FIXTURES_V2.MemoryRetrievalPackV2);
    codeReads.pack.mockReturnValueOnce(fixture);

    const response = await app.inject({
      method: "GET",
      url: `/api/v2/memory/packs/${fixture.retrieval_pack_id}`,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers.vary).toBe("Authorization");
    expect(parseMemoryContractV2("MemoryRetrievalPackV2", response.json())).toEqual(fixture);
    expect(codeReads.pack).toHaveBeenCalledWith({
      principal,
      packId: fixture.retrieval_pack_id,
    });
    expect(metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "SearchOutcome",
        dimensions: expect.objectContaining({
          transport: "direct_http",
          operation: "pack",
          plane: fixture.plane,
          outcome: "success",
        }),
      }),
      expect.objectContaining({
        name: "SearchLatency",
        dimensions: expect.objectContaining({
          operation: "pack",
        }),
      }),
    ]));

    codeReads.pack.mockClear();
    const unknownQuery = await app.inject({
      method: "GET",
      url: `/api/v2/memory/packs/${fixture.retrieval_pack_id}?include=secret`,
    });
    expect(unknownQuery.statusCode).toBe(400);
    expect(unknownQuery.body).not.toContain("secret");
    expect(unknownQuery.json()).toMatchObject({
      code: "schema_invalid",
      details: [{ path: "/query", reason: "query parameters are not supported" }],
    });
    expect(codeReads.pack).not.toHaveBeenCalled();

    const maxPackId = "p".repeat(128);
    const acceptedBoundary = await app.inject({
      method: "GET",
      url: `/api/v2/memory/packs/${maxPackId}`,
    });
    expect(acceptedBoundary.statusCode, acceptedBoundary.body).toBe(200);
    expect(codeReads.pack).toHaveBeenLastCalledWith({ principal, packId: maxPackId });

    codeReads.pack.mockClear();
    const oversized = await app.inject({
      method: "GET",
      url: `/api/v2/memory/packs/${"p".repeat(129)}`,
    });
    expect(oversized.statusCode).toBe(404);
    expect(codeReads.pack).not.toHaveBeenCalled();
  });

  it("rejects unbounded record IDs and every unrecognized read query key", async () => {
    for (const length of [101, MEMORY_V2_RECORD_ID_MAX_LENGTH]) {
      const recordId = "x".repeat(length);
      const accepted = await app.inject({
        method: "GET",
        url: `/api/v2/memory/records/${recordId}?version=1`,
      });
      expect(accepted.statusCode, accepted.body).toBe(200);
      expect(codeReads.record).toHaveBeenLastCalledWith({
        principal,
        recordId,
        recordVersion: 1,
      });
    }
    codeReads.record.mockClear();

    const oversized = await app.inject({
      method: "GET",
      url: `/api/v2/memory/records/${"x".repeat(MEMORY_V2_RECORD_ID_MAX_LENGTH + 1)}?version=1`,
    });
    // The router and route-level guard share the frozen 128-character limit.
    expect(oversized.statusCode).toBe(404);
    expect(codeReads.record).not.toHaveBeenCalled();

    const detailQuery = await app.inject({
      method: "GET",
      url: "/api/v2/memory/records/memory-v2-contract-1?version=1&include=secret",
    });
    expect(detailQuery.statusCode).toBe(400);
    expect(detailQuery.body).not.toContain("secret");
    expect(detailQuery.json()).toMatchObject({
      code: "schema_invalid",
      details: [{ path: "/query", reason: "unknown query parameter" }],
    });

    const historyQuery = await app.inject({
      method: "GET",
      url: "/api/v2/memory/records/memory-v2-contract-1/history?version=1",
    });
    expect(historyQuery.statusCode).toBe(400);
    expect(historyQuery.json()).toMatchObject({
      code: "schema_invalid",
      details: [{ path: "/query", reason: "query parameters are not supported" }],
    });
    expect(codeReads.record).not.toHaveBeenCalled();
    expect(codeReads.history).not.toHaveBeenCalled();
  });

  it("dispatches harness without entering the code service", async () => {
    const harness = await app.inject({
      method: "POST",
      url: "/api/v2/memory/search",
      payload: {
        ...MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpHarnessSearchInputV2,
        tenant: { project_id: "project-checkout" },
      },
    });
    expect(harness.statusCode, harness.body).toBe(200);
    expect(harnessReads.search).toHaveBeenCalledOnce();
    expect(codeReads.search).not.toHaveBeenCalled();
    const harnessMetrics = metrics.filter((metric) => metric.dimensions?.plane === "harness");
    expect(harnessMetrics.map((metric) => metric.name)).toEqual([
      "SearchOutcome",
      "SearchResultCount",
      "SearchLatency",
    ]);
    for (const metric of harnessMetrics) {
      expect(metric.dimensions).toMatchObject({
        transport: "direct_http",
        plane: "harness",
        resource_type: "harness",
        contract_version: "pim.memory.v2",
        outcome: "success",
        reason: "completed",
      });
    }
    expect(harnessMetrics.find((metric) => metric.name === "SearchLatency"))
      .toMatchObject({ unit: "Milliseconds", value: expect.any(Number) });
  });

  it("maps known failures and redacts internal failures", async () => {
    codeReads.search.mockRejectedValueOnce(new MemoryV2CodeReadError(
      "The selected resource is unavailable",
      404,
      "resource_not_found",
    ));
    const known = await app.inject({
      method: "POST",
      url: "/api/v2/memory/search",
      payload: MEMORY_CONTRACT_FIXTURES_V2.MemorySearchV2,
    });
    expect(known.statusCode).toBe(404);
    expect(parseMemoryContractV2("PimErrorV2", known.json())).toMatchObject({
      code: "resource_not_found",
      request_id: MEMORY_CONTRACT_FIXTURES_V2.MemorySearchV2.request_id,
      plane: "codebase",
      retryable: false,
    });

    const secret = "sqlite-path-and-token-must-not-leak";
    codeReads.history.mockImplementationOnce(() => {
      throw new Error(secret);
    });
    const internal = await app.inject({
      method: "GET",
      url: "/api/v2/memory/records/memory-v2-contract-1/history",
    });
    expect(internal.statusCode).toBe(500);
    expect(internal.body).not.toContain(secret);
    expect(parseMemoryContractV2("PimErrorV2", internal.json())).toMatchObject({
      code: "temporarily_unavailable",
      retryable: true,
      details: [],
    });
  });
});
