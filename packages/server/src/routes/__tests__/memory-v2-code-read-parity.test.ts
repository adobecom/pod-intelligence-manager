import { isDeepStrictEqual } from "node:util";
import { Writable } from "node:stream";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MEMORY_CONTRACT_FIXTURES_V2,
  parseMemoryContract,
  parseMemoryContractV2,
  type CodebaseMemorySearchV2,
  type MemoryMcpCodeSearchInputV2,
  type MemorySearchResultV1,
  type MemorySearchResultV2,
  type MemorySearchV1,
} from "@pim/shared";

const embeddingProvider = vi.hoisted(() => ({
  generate: vi.fn(async (_text: string): Promise<number[] | null> => [1, 0]),
}));

vi.mock("../../services/embeddings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/embeddings.js")>();
  return { ...actual, generateEmbedding: embeddingProvider.generate };
});

import db from "../../db/connection.js";
import { registerJsonBodyParser } from "../../middleware/validation.js";
import {
  recordCodeMemoryTransportMeasure,
  setMemoryMetricSink,
  type MemoryMetric,
} from "../../services/memory-metrics.js";
import {
  importActiveMemoryRecord,
  transitionMemoryRecordStatus,
} from "../../services/memory-records.js";
import {
  registerMemoryRepository,
  renameMemoryRepository,
  resolveMemoryRepository,
  transferMemoryRepository,
} from "../../services/memory-repository-registry.js";
import { resolveMemoryV2Resource } from "../../services/memory-v2-resources.js";
import { ensureMemoryV2EvidenceVerifiedTrust } from "../../services/memory-v2-trust.js";
import {
  createPrivateMemoryMcpServiceToken,
  type CreatedPrivateMemoryMcpServiceToken,
} from "../../services/service-tokens.js";
import memoryMcpRoutes, {
  MEMORY_MCP_RATE_LIMIT,
} from "../memory-mcp.js";
import {
  MEMORY_V2_RECORD_ID_MAX_LENGTH,
} from "../memory-v2-search.js";
import {
  createMemoryTestContext,
  type MemoryTestContext,
} from "./memory-test-app.js";

const CONFORMANCE_TIMEOUT_MS = 5_000;
const BASE_REPOSITORY_ID = "github.com/acme/checkout";
const EMPTY_REPOSITORY_ID = "github.com/acme/empty";

type V2MetricTarget = {
  transport: "direct_http" | "mcp";
  operation: "search" | "code_search";
};

interface LogicalSearch {
  id: string;
  projectId?: string;
  repositoryId?: string;
  resourceSelector?: MemoryMcpCodeSearchInputV2["resource_selector"];
  query?: string;
  taskClass?: string;
  baseSha?: string;
  components?: string[];
  paths?: string[];
  symbols?: string[];
  maxItems?: number;
  maxTokens?: number;
}

interface ScenarioRequests {
  v1: MemorySearchV1;
  http: CodebaseMemorySearchV2;
  mcp: MemoryMcpCodeSearchInputV2;
}

interface Timed<T> {
  value: T;
  latencyMs: number;
}

interface RawMcpError {
  statusCode: number;
  code: string | null;
  body: unknown;
}

const metrics: MemoryMetric[] = [];
const mcpAuditChunks: string[] = [];
let context: MemoryTestContext;
let mcpApp: FastifyInstance;
let privateToken: CreatedPrivateMemoryMcpServiceToken;
let qualityRecordIds: string[] = [];

const clientMeta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": {
    name: "slice-2-code-read-parity",
    version: "1.0.0",
  },
  "io.modelcontextprotocol/clientCapabilities": {},
};

function mcpHeaders(token: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "MCP-Protocol-Version": "2026-07-28",
    "Mcp-Method": "tools/call",
    "Mcp-Name": "pim_code_memory_search",
    authorization: `Bearer ${token}`,
  };
}

function mcpPayload(input: MemoryMcpCodeSearchInputV2): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: `tools/call:${input.request_id}`,
    method: "tools/call",
    params: {
      name: "pim_code_memory_search",
      arguments: input,
      _meta: clientMeta,
    },
  };
}

async function withinDeadline<T>(
  label: string,
  metricTarget: V2MetricTarget | null,
  run: () => Promise<T>,
): Promise<Timed<T>> {
  const startedAt = performance.now();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutResult = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      if (metricTarget) {
        recordCodeMemoryTransportMeasure({
          measure: "timeout",
          ...metricTarget,
        });
      }
      reject(new Error(`${label} exceeded the ${CONFORMANCE_TIMEOUT_MS}ms conformance envelope`));
    }, CONFORMANCE_TIMEOUT_MS);
  });
  try {
    const value = await Promise.race([run(), timeoutResult]);
    return { value, latencyMs: performance.now() - startedAt };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function recordMismatch(target: V2MetricTarget): void {
  recordCodeMemoryTransportMeasure({
    measure: "parity_mismatch",
    ...target,
  });
}

function expectParity<T>(
  expected: T,
  actual: T,
  target: V2MetricTarget,
): void {
  if (!isDeepStrictEqual(actual, expected)) recordMismatch(target);
  expect(actual).toEqual(expected);
}

function buildRequests(input: LogicalSearch): ScenarioRequests {
  const fixture = structuredClone(
    MEMORY_CONTRACT_FIXTURES_V2.MemorySearchV2,
  ) as unknown as CodebaseMemorySearchV2;
  const projectId = input.projectId ?? context.projectA;
  const repositoryId = input.repositoryId ?? BASE_REPOSITORY_ID;
  const consumer = {
    ...fixture.consumer,
    consumer_run_id: `${input.id}:consumer-run`,
  };
  const applicability = {
    ...fixture.applicability,
    repository_id: repositoryId,
    base_sha: input.baseSha ?? "a".repeat(40),
    components: input.components ?? [],
    paths: input.paths ?? [],
    symbols: input.symbols ?? [],
    task_classes: [input.taskClass ?? "bug_fix"],
  };
  const task = {
    query: input.query ?? "Prevent duplicate payment retries",
    task_class: input.taskClass ?? "bug_fix",
  };
  const budget = {
    max_tokens: input.maxTokens ?? 8_000,
    max_items: input.maxItems ?? 32,
  };
  const resourceSelector: MemoryMcpCodeSearchInputV2["resource_selector"] =
    input.resourceSelector ?? { canonical_resource_id: repositoryId };
  const http: CodebaseMemorySearchV2 = {
    ...fixture,
    request_id: `${input.id}:http-v2`,
    consumer,
    tenant: { project_id: projectId },
    resource_selector: resourceSelector,
    applicability,
    task,
    budget,
  };
  const v1: MemorySearchV1 = {
    schema_version: "pim.memory-search.v1",
    request_id: `${input.id}:http-v1`,
    consumer,
    tenant: { project_id: projectId },
    plane: "codebase",
    applicability: {
      repository_id: repositoryId,
      base_sha: applicability.base_sha!,
      components: applicability.components,
      paths: applicability.paths,
      symbols: applicability.symbols,
      task_classes: applicability.task_classes,
    },
    task,
    temporal: fixture.temporal,
    budget,
    options: fixture.options,
  };
  const mcp: MemoryMcpCodeSearchInputV2 = {
    schema_version: http.schema_version,
    request_id: `${input.id}:mcp-v2`,
    consumer: http.consumer,
    plane: http.plane,
    resource_selector: resourceSelector,
    applicability: http.applicability,
    task: http.task,
    temporal: http.temporal,
    budget: http.budget,
    options: http.options,
  };
  return { v1, http, mcp };
}

function comparable(result: MemorySearchResultV1 | MemorySearchResultV2) {
  return {
    items: result.items.map((item) => ({
      record_id: item.record_id,
      record_version: item.record_version,
      kind: item.kind,
      summary: item.summary,
      lifecycle: item.lifecycle,
      match_reasons: item.match_reasons,
    })),
    token_count: result.token_count,
    omitted_count: result.omitted_count,
  };
}

async function rawV1(request: MemorySearchV1, token: string) {
  return withinDeadline(
    "v1 direct HTTP search",
    { transport: "direct_http", operation: "search" },
    () => context.app.inject({
      method: "POST",
      url: "/api/v1/memory/search",
      headers: { authorization: `Bearer ${token}` },
      payload: request,
    }),
  );
}

async function rawHttpV2(request: CodebaseMemorySearchV2, token: string) {
  return withinDeadline(
    "v2 direct HTTP search",
    { transport: "direct_http", operation: "search" },
    () => context.app.inject({
      method: "POST",
      url: "/api/v2/memory/search",
      headers: { authorization: `Bearer ${token}` },
      payload: request,
    }),
  );
}

async function rawMcp(request: MemoryMcpCodeSearchInputV2, token: string) {
  return withinDeadline(
    "v2 MCP code search",
    { transport: "mcp", operation: "code_search" },
    () => mcpApp.inject({
      method: "POST",
      url: "/mcp/memory",
      headers: mcpHeaders(token),
      payload: mcpPayload(request),
    }),
  );
}

function mcpApplicationError(response: Awaited<ReturnType<typeof mcpApp.inject>>): RawMcpError {
  const body = response.json() as {
    error?: { data?: { code?: unknown } };
    result?: {
      isError?: unknown;
      structuredContent?: { code?: unknown };
    };
  };
  const rawCode = body.result?.isError === true
    ? body.result.structuredContent?.code
    : body.error?.data?.code;
  return {
    statusCode: response.statusCode,
    code: typeof rawCode === "string" ? rawCode : null,
    body,
  };
}

async function runSuccessfulScenario(
  input: LogicalSearch,
  token = privateToken.token,
): Promise<{
  requests: ScenarioRequests;
  v1: MemorySearchResultV1;
  http: MemorySearchResultV2;
  mcp: MemorySearchResultV2;
  latencyMs: { v1: number; http: number; mcp: number };
}> {
  const requests = buildRequests(input);
  const v1Call = await rawV1(requests.v1, token);
  expect(v1Call.value.statusCode, v1Call.value.body).toBe(200);
  const v1 = parseMemoryContract("MemorySearchResultV1", v1Call.value.json());

  const httpCall = await rawHttpV2(requests.http, token);
  if (httpCall.value.statusCode !== 200) {
    recordMismatch({ transport: "direct_http", operation: "search" });
  }
  expect(httpCall.value.statusCode, httpCall.value.body).toBe(200);
  const http = parseMemoryContractV2("MemorySearchResultV2", httpCall.value.json());

  const mcpCall = await rawMcp(requests.mcp, token);
  const mcpEnvelope = mcpCall.value.json() as {
    result?: { isError?: unknown; structuredContent?: unknown };
  };
  if (mcpCall.value.statusCode !== 200 || mcpEnvelope.result?.isError === true) {
    recordMismatch({ transport: "mcp", operation: "code_search" });
  }
  expect(mcpCall.value.statusCode, mcpCall.value.body).toBe(200);
  expect(mcpEnvelope.result?.isError).not.toBe(true);
  const mcp = parseMemoryContractV2(
    "MemorySearchResultV2",
    mcpEnvelope.result?.structuredContent,
  );

  const expected = comparable(v1);
  expectParity(expected, comparable(http), {
    transport: "direct_http",
    operation: "search",
  });
  expectParity(expected, comparable(mcp), {
    transport: "mcp",
    operation: "code_search",
  });
  return {
    requests,
    v1,
    http,
    mcp,
    latencyMs: {
      v1: v1Call.latencyMs,
      http: httpCall.latencyMs,
      mcp: mcpCall.latencyMs,
    },
  };
}

async function expectDeniedScenario(
  input: LogicalSearch,
  expectedHttp: { statusCode: 403 | 404; code: string } = {
    statusCode: 403,
    code: "resource_binding_mismatch",
  },
  token = privateToken.token,
): Promise<void> {
  const requests = buildRequests(input);
  const v1 = await rawV1(requests.v1, token);
  expect(v1.value.statusCode).toBe(403);
  const v1Code = (v1.value.json() as { code?: unknown }).code;
  expect(v1Code).toBe("resource_binding_mismatch");

  const http = await rawHttpV2(requests.http, token);
  const httpCode = (http.value.json() as { code?: unknown }).code;
  if (http.value.statusCode !== expectedHttp.statusCode || httpCode !== expectedHttp.code) {
    recordMismatch({ transport: "direct_http", operation: "search" });
  }
  expect(http.value.statusCode).toBe(expectedHttp.statusCode);
  expect(httpCode).toBe(expectedHttp.code);

  const mcp = await rawMcp(requests.mcp, token);
  const mcpError = mcpApplicationError(mcp.value);
  if (mcpError.statusCode !== 200 || mcpError.code !== "resource_not_found") {
    recordMismatch({ transport: "mcp", operation: "code_search" });
  }
  expect(mcpError.statusCode).toBe(200);
  expect(mcpError.code).toBe("resource_not_found");
}

function importQualityRecord(input: {
  recordId: string;
  summary: string;
  details: string;
  path: string;
  symbol: string;
  embedding?: number[];
}): string {
  const repository = resolveMemoryRepository(
    context.orgA.id,
    context.projectA,
    BASE_REPOSITORY_ID,
  );
  if (!repository) throw new Error("Expected the parity repository binding");
  const record = importActiveMemoryRecord({
    orgId: context.orgA.id,
    projectId: context.projectA,
    repositoryRowId: repository.repository_row_id,
    recordId: input.recordId,
    kind: "constraint",
    content: {
      summary: input.summary,
      details: input.details,
      rationale: "This deterministic fixture exercises the unchanged shared ranker.",
    },
    applicability: {
      repository_id: repository.repository_id,
      paths: [input.path],
      symbols: [input.symbol],
      task_classes: ["bug_fix"],
    },
    exceptions: [],
    compatibility: {
      harness_version_range: "*",
      workflow_version_range: "*",
      adapter_version_range: "*",
    },
    validation: { strategy: "repository_anchors" },
    evidence: [{
      evidence_ref_id: `evidence-${input.recordId}`,
      type: "git_diff",
      digest: `sha256:${"7".repeat(64)}`,
      origin_id: `${BASE_REPOSITORY_ID}:${input.recordId}`,
      source_authority: "verified",
    }],
    evidenceSummary: { strength: "verified_merge", ref_count: 1 },
    freshness: { last_confirmed_at: new Date().toISOString(), expires_at: null },
    provenance: { producer: "slice-2-parity", extractor_version: "fixture-v1" },
    embedding: input.embedding,
  });
  ensureMemoryV2EvidenceVerifiedTrust({
    recordId: record.record_id,
    recordVersion: record.record_version,
    orgId: context.orgA.id,
    projectId: context.projectA,
    evidenceVerifiedAt: record.freshness.last_confirmed_at,
  });
  return record.record_id;
}

beforeAll(async () => {
  context = await createMemoryTestContext({
    routerOptions: { maxParamLength: MEMORY_V2_RECORD_ID_MAX_LENGTH },
  }, { v2Reads: true });
  const owner = db.prepare(
    "SELECT created_by_user_id FROM projects WHERE project_id = ?",
  ).get(context.projectA) as { created_by_user_id: string };
  privateToken = createPrivateMemoryMcpServiceToken({
    orgId: context.orgA.id,
    name: "Slice 2 transport parity",
    scopes: ["memory:search"],
    createdByUserId: owner.created_by_user_id,
    projectId: context.projectA,
    repositoryIds: [BASE_REPOSITORY_ID],
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });

  const stream = new Writable({
    write(chunk, _encoding, callback) {
      mcpAuditChunks.push(chunk.toString());
      callback();
    },
  });
  mcpApp = Fastify({ logger: { level: "info", stream } });
  registerJsonBodyParser(mcpApp);
  await mcpApp.register(rateLimit, { max: 1_000, timeWindow: "1 minute" });
  await mcpApp.register(memoryMcpRoutes);
  await mcpApp.ready();

  const suffix = context.projectA.slice(-12);
  qualityRecordIds = [
    importQualityRecord({
      recordId: `parity-exact-${suffix}`,
      summary: "Exact parity guard coordinates bounded payment retries.",
      details: "The parityGuard symbol must retain one provider key during retry coordination.",
      path: "src/parity/exact.ts",
      symbol: "parityGuard",
      embedding: [1, 0],
    }),
    importQualityRecord({
      recordId: `parity-semantic-${suffix}`,
      summary: "Semantic recovery guidance covers retry coordination broadly.",
      details: "A related recovery note discusses bounded retries without the exact requested identifier.",
      path: "src/parity/related.ts",
      symbol: "relatedRecovery",
      embedding: [1, 0],
    }),
    importQualityRecord({
      recordId: `parity-lexical-${suffix}`,
      summary: "Payment retry coordination requires bounded recovery checks.",
      details: "Lexical overlap supplies a third deterministic budget candidate.",
      path: "src/parity/lexical.ts",
      symbol: "lexicalRecovery",
      embedding: [0, 1],
    }),
  ];
  setMemoryMetricSink((metric) => metrics.push(metric));
});

afterAll(async () => {
  setMemoryMetricSink(null);
  if (mcpApp) await mcpApp.close();
  if (context) await context.app.close();
});

beforeEach(() => {
  embeddingProvider.generate.mockReset();
  embeddingProvider.generate.mockResolvedValue([1, 0]);
});

describe("Slice 2 v1 / direct-HTTP-v2 / MCP code-read conformance", () => {
  it("preserves quality, result order, reasons, and the shared budget outcome", async () => {
    const result = await runSuccessfulScenario({
      id: "slice-2-quality-order",
      query: "parityGuard payment retry coordination bounded recovery",
      paths: ["src/parity/exact.ts"],
      symbols: ["parityGuard"],
    });
    expect(result.v1.items.length).toBeGreaterThanOrEqual(qualityRecordIds.length);
    expect(result.v1.items[0]?.record_id).toBe(qualityRecordIds[0]);
    expect(result.http.items.map((item) => item.record_id))
      .toEqual(result.v1.items.map((item) => item.record_id));
    expect(result.mcp.items.map((item) => item.record_id))
      .toEqual(result.v1.items.map((item) => item.record_id));
  });

  it("keeps max-item and max-token omission accounting identical", async () => {
    const itemLimited = await runSuccessfulScenario({
      id: "slice-2-budget-items",
      query: "parityGuard payment retry coordination bounded recovery",
      paths: ["src/parity/exact.ts"],
      symbols: ["parityGuard"],
      maxItems: 1,
    });
    expect(itemLimited.v1.items).toHaveLength(1);
    expect(itemLimited.v1.omitted_count).toBeGreaterThan(0);

    const tokenLimited = await runSuccessfulScenario({
      id: "slice-2-budget-tokens",
      query: "parityGuard payment retry coordination bounded recovery",
      paths: ["src/parity/exact.ts"],
      symbols: ["parityGuard"],
      maxTokens: 1,
    });
    expect(tokenLimited.v1).toMatchObject({
      items: [],
      token_count: 0,
      omitted_count: expect.any(Number),
    });
    expect(tokenLimited.v1.omitted_count).toBeGreaterThan(0);
  });

  it("replays one immutable pack and conflicts on a changed payload per transport", async () => {
    const requests = buildRequests({
      id: "slice-2-idempotency",
      query: "parityGuard payment retry coordination",
      paths: ["src/parity/exact.ts"],
      symbols: ["parityGuard"],
    });

    const v1First = await rawV1(requests.v1, privateToken.token);
    const v1Replay = await rawV1(requests.v1, privateToken.token);
    expect(v1First.value.statusCode).toBe(200);
    expect(v1Replay.value.json()).toEqual(v1First.value.json());

    const httpFirst = await rawHttpV2(requests.http, privateToken.token);
    const httpReplay = await rawHttpV2(requests.http, privateToken.token);
    expect(httpFirst.value.statusCode).toBe(200);
    if (!isDeepStrictEqual(httpReplay.value.json(), httpFirst.value.json())) {
      recordMismatch({ transport: "direct_http", operation: "search" });
    }
    expect(httpReplay.value.json()).toEqual(httpFirst.value.json());

    const mcpFirst = await rawMcp(requests.mcp, privateToken.token);
    const mcpReplay = await rawMcp(requests.mcp, privateToken.token);
    expect(mcpFirst.value.statusCode).toBe(200);
    if (!isDeepStrictEqual(mcpReplay.value.json(), mcpFirst.value.json())) {
      recordMismatch({ transport: "mcp", operation: "code_search" });
    }
    expect(mcpReplay.value.json()).toEqual(mcpFirst.value.json());

    const changedQuery = "changed payload must conflict";
    const v1Conflict = await rawV1({
      ...requests.v1,
      task: { ...requests.v1.task, query: changedQuery },
    }, privateToken.token);
    expect(v1Conflict.value.statusCode).toBe(409);
    expect(v1Conflict.value.json()).toMatchObject({ code: "idempotency_conflict" });

    const httpConflict = await rawHttpV2({
      ...requests.http,
      task: { ...requests.http.task, query: changedQuery },
    }, privateToken.token);
    const httpConflictCode = (httpConflict.value.json() as { code?: unknown }).code;
    if (httpConflict.value.statusCode !== v1Conflict.value.statusCode
        || httpConflictCode !== "idempotency_conflict") {
      recordMismatch({ transport: "direct_http", operation: "search" });
    }
    expect(httpConflict.value.statusCode).toBe(409);
    expect(httpConflictCode).toBe("idempotency_conflict");

    const mcpConflict = await rawMcp({
      ...requests.mcp,
      task: { ...requests.mcp.task, query: changedQuery },
    }, privateToken.token);
    const mcpConflictCode = mcpApplicationError(mcpConflict.value).code;
    if (mcpConflictCode !== "idempotency_conflict") {
      recordMismatch({ transport: "mcp", operation: "code_search" });
    }
    expect(mcpConflictCode).toBe("idempotency_conflict");

    expect(db.prepare(
      `SELECT operation, idempotency_key, COUNT(*) AS count
       FROM memory_idempotency_keys
       WHERE idempotency_key IN (?, ?, ?)
       GROUP BY operation, idempotency_key
       ORDER BY operation, idempotency_key`,
    ).all(
      requests.v1.request_id,
      requests.http.request_id,
      requests.mcp.request_id,
    )).toEqual([
      {
        operation: "memory_search",
        idempotency_key: requests.v1.request_id,
        count: 1,
      },
      {
        operation: "memory_search_v2",
        idempotency_key: requests.http.request_id,
        count: 1,
      },
      {
        operation: "memory_search_v2",
        idempotency_key: requests.mcp.request_id,
        count: 1,
      },
    ]);
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM memory_retrieval_packs WHERE request_id = ?",
    ).get(requests.v1.request_id)).toEqual({ count: 1 });
    expect(db.prepare(
      `SELECT request_id, COUNT(*) AS count
       FROM memory_v2_retrieval_packs
       WHERE request_id IN (?, ?)
       GROUP BY request_id ORDER BY request_id`,
    ).all(requests.http.request_id, requests.mcp.request_id)).toEqual([
      { request_id: requests.http.request_id, count: 1 },
      { request_id: requests.mcp.request_id, count: 1 },
    ].sort((left, right) => left.request_id.localeCompare(right.request_id)));
  });

  it("keeps v2 cross-resource denials non-enumerating while preserving legacy v1 errors", async () => {
    const foreignResource = resolveMemoryV2Resource({
      orgId: context.orgB.id,
      projectId: context.projectB,
      plane: "codebase",
      canonicalResourceId: BASE_REPOSITORY_ID,
    });
    const emptyResource = resolveMemoryV2Resource({
      orgId: context.orgA.id,
      projectId: context.projectA,
      plane: "codebase",
      canonicalResourceId: EMPTY_REPOSITORY_ID,
    });
    expect(foreignResource).not.toBeNull();
    expect(emptyResource).not.toBeNull();

    await expectDeniedScenario({
      id: "slice-2-deny-cross-tenant",
      projectId: context.projectB,
      repositoryId: BASE_REPOSITORY_ID,
      resourceSelector: { resource_row_id: foreignResource!.resourceRowId },
    });
    await expectDeniedScenario({
      id: "slice-2-deny-cross-resource",
      repositoryId: EMPTY_REPOSITORY_ID,
      resourceSelector: { resource_row_id: emptyResource!.resourceRowId },
    }, { statusCode: 404, code: "resource_not_found" });
  });

  it("excludes every inactive lifecycle status before ranking on all transports", async () => {
    const statuses = ["stale", "superseded", "revoked", "expired"] as const;
    const excludedIds: string[] = [];
    for (const status of statuses) {
      const marker = `slice2Lifecycle${status}`;
      const recordId = importQualityRecord({
        recordId: `${marker}-${context.projectA.slice(-8)}`,
        summary: `Lifecycle ${status} parity memory remains excluded.`,
        details: `The ${marker} fixture must never enter a current retrieval pack.`,
        path: `src/parity/${status}.ts`,
        symbol: marker,
      });
      transitionMemoryRecordStatus({
        orgId: context.orgA.id,
        projectId: context.projectA,
        recordId,
        toStatus: status,
        actorId: "slice-2-parity",
        reasonCode: `parity_mark_${status}`,
        explanation: `Exercise ${status} hard-filter parity.`,
      });
      excludedIds.push(recordId);
    }

    const result = await runSuccessfulScenario({
      id: "slice-2-lifecycle-exclusion",
      query: statuses.map((status) => `slice2Lifecycle${status}`).join(" "),
      paths: statuses.map((status) => `src/parity/${status}.ts`),
      symbols: statuses.map((status) => `slice2Lifecycle${status}`),
    });
    for (const response of [result.v1, result.http, result.mcp]) {
      expect(response.items.some((item) => excludedIds.includes(item.record_id))).toBe(false);
    }
  });

  it("degrades identically during an embedding-provider outage without cross-tenant leakage", async () => {
    embeddingProvider.generate.mockReset();
    embeddingProvider.generate.mockResolvedValue(null);
    const callsBefore = embeddingProvider.generate.mock.calls.length;
    const result = await runSuccessfulScenario({
      id: "slice-2-embedding-outage",
      query: "parityGuard payment retry coordination bounded recovery",
      paths: ["src/parity/exact.ts"],
      symbols: ["parityGuard"],
    });
    expect(embeddingProvider.generate.mock.calls.length - callsBefore).toBe(3);
    for (const response of [result.v1, result.http, result.mcp]) {
      expect(response.items.map((item) => item.record_id))
        .not.toContain(context.otherTenantRecordId);
    }
  });

  it("preserves rename aliases and denies the old principal after repository transfer", async () => {
    const providerRepositoryId = `slice-2-parity-rename-${context.projectA.slice(-10)}`;
    const original = registerMemoryRepository({
      orgId: context.orgA.id,
      projectId: context.projectA,
      providerRepositoryId,
      repositoryId: "github.com/acme/legacy-name",
      displaySlug: "Acme/Legacy-Name",
    });
    const owner = db.prepare(
      "SELECT created_by_user_id FROM projects WHERE project_id = ?",
    ).get(context.projectA) as { created_by_user_id: string };
    const renameToken = createPrivateMemoryMcpServiceToken({
      orgId: context.orgA.id,
      name: "Slice 2 rename parity",
      scopes: ["memory:search"],
      createdByUserId: owner.created_by_user_id,
      projectId: context.projectA,
      repositoryIds: [original.repository_id],
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const resource = resolveMemoryV2Resource({
      orgId: context.orgA.id,
      projectId: context.projectA,
      plane: "codebase",
      canonicalResourceId: original.repository_id,
    });
    expect(resource).not.toBeNull();

    renameMemoryRepository({
      orgId: context.orgA.id,
      providerRepositoryId,
      repositoryId: "github.com/acme/new-name",
      displaySlug: "Acme/New-Name",
    });
    const renamed = await runSuccessfulScenario({
      id: "slice-2-rename-alias",
      repositoryId: "github.com/acme/legacy-name",
      resourceSelector: { canonical_resource_id: "github.com/acme/legacy-name" },
      query: "empty renamed repository",
    }, renameToken.token);
    expect(renamed.v1.repository_id).toBe("github.com/acme/new-name");
    expect(renamed.http.resource_binding.canonical_resource_id)
      .toBe("github.com/acme/new-name");
    expect(renamed.mcp.resource_binding.canonical_resource_id)
      .toBe("github.com/acme/new-name");

    transferMemoryRepository({
      orgId: context.orgA.id,
      providerRepositoryId,
      projectId: context.projectA2,
    });
    const requests = buildRequests({
      id: "slice-2-transfer-denial",
      repositoryId: "github.com/acme/legacy-name",
      resourceSelector: { resource_row_id: resource!.resourceRowId },
    });
    const v1 = await rawV1(requests.v1, renameToken.token);
    const http = await rawHttpV2(requests.http, renameToken.token);
    const mcp = await rawMcp(requests.mcp, renameToken.token);
    expect(v1.value.statusCode).toBe(403);
    if (http.value.statusCode !== 404) {
      recordMismatch({ transport: "direct_http", operation: "search" });
    }
    const mcpError = mcpApplicationError(mcp.value);
    if (mcpError.statusCode !== 403 || mcpError.code !== null) {
      recordMismatch({ transport: "mcp", operation: "code_search" });
    }
    expect(http.value.statusCode).toBe(404);
    expect(http.value.json()).toMatchObject({ code: "resource_not_found" });
    expect(mcpError).toMatchObject({ statusCode: 403, code: null });
  });

  it("writes equivalent immutable audit effects and stays inside the latency envelope", async () => {
    const metricStart = metrics.length;
    const auditStart = mcpAuditChunks.length;
    const recordsBefore = (db.prepare(
      "SELECT COUNT(*) AS count FROM memory_records",
    ).get() as { count: number }).count;
    const transitionsBefore = (db.prepare(
      "SELECT COUNT(*) AS count FROM memory_transitions",
    ).get() as { count: number }).count;
    const result = await runSuccessfulScenario({
      id: "slice-2-audit-latency",
      query: "parityGuard payment retry coordination",
      paths: ["src/parity/exact.ts"],
      symbols: ["parityGuard"],
    });

    for (const latency of Object.values(result.latencyMs)) {
      expect(latency).toBeGreaterThanOrEqual(0);
      expect(latency).toBeLessThan(CONFORMANCE_TIMEOUT_MS);
    }
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM memory_retrieval_packs WHERE request_id = ?",
    ).get(result.requests.v1.request_id)).toEqual({ count: 1 });
    expect(db.prepare(
      `SELECT request_id, COUNT(*) AS count
       FROM memory_v2_retrieval_packs
       WHERE request_id IN (?, ?)
       GROUP BY request_id ORDER BY request_id`,
    ).all(result.requests.http.request_id, result.requests.mcp.request_id)).toEqual([
      { request_id: result.requests.http.request_id, count: 1 },
      { request_id: result.requests.mcp.request_id, count: 1 },
    ].sort((left, right) => left.request_id.localeCompare(right.request_id)));
    expect((db.prepare(
      "SELECT COUNT(*) AS count FROM memory_records",
    ).get() as { count: number }).count).toBe(recordsBefore);
    expect((db.prepare(
      "SELECT COUNT(*) AS count FROM memory_transitions",
    ).get() as { count: number }).count).toBe(transitionsBefore);

    const transportMetrics = metrics.slice(metricStart).filter((metric) => (
      metric.name === "SearchOutcome" || metric.name === "SearchLatency"
    ));
    expect(transportMetrics.some((metric) => (
      metric.dimensions?.transport === "direct_http"
    ))).toBe(true);
    expect(transportMetrics.some((metric) => (
      metric.dimensions?.transport === "mcp"
    ))).toBe(true);
    expect(metrics.slice(metricStart).some((metric) => (
      metric.name === "SearchTimeout" || metric.name === "SearchParityMismatch"
    ))).toBe(false);
    expect(mcpAuditChunks.slice(auditStart).join("")).toContain("memory_mcp_access");
  });
});
