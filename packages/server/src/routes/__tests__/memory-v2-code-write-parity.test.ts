import { randomUUID } from "node:crypto";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canonicalJsonSha256,
  MEMORY_CONTRACT_FIXTURES,
  MEMORY_CONTRACT_FIXTURES_V2,
  parseMemoryContract,
  parseMemoryContractV2,
  type CodebaseMemorySearchV2,
  type CodebaseRunReceiptV2,
  type MemoryCandidateStatusV1,
  type MemoryCandidateStatusV2,
  type MemoryFeedbackResultV1,
  type MemoryFeedbackResultV2,
  type MemoryFeedbackV1,
  type MemoryFeedbackV2,
  type MemoryMcpCodeSearchInputV2,
  type MemoryMcpRunReceiptSubmitInputV2,
  type MemorySearchResultV1,
  type MemorySearchResultV2,
  type MemorySearchV1,
  type RunReceiptResultV1,
  type RunReceiptResultV2,
  type RunReceiptV1,
} from "@pim/shared";
import db from "../../db/connection.js";
import { registerJsonBodyParser } from "../../middleware/validation.js";
import { validateMemoryCandidate } from "../../services/memory-candidates.js";
import { scanMemoryV2Input } from "../../services/memory-v2-input-safety.js";
import {
  createPrivateMemoryMcpServiceToken,
  type CreatedPrivateMemoryMcpServiceToken,
} from "../../services/service-tokens.js";
import memoryMcpRoutes from "../memory-mcp.js";
import {
  createMemoryTestContext,
  type MemoryTestContext,
} from "./memory-test-app.js";

const REPOSITORY_ID = "github.com/acme/checkout";
const BASE_SHA = "7".repeat(40);

let context: MemoryTestContext;
let mcpApp: FastifyInstance;
let token: CreatedPrivateMemoryMcpServiceToken;

const clientMeta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": {
    name: "slice-3-code-write-parity",
    version: "1.0.0",
  },
  "io.modelcontextprotocol/clientCapabilities": {},
};

function auth(): Record<string, string> {
  return { authorization: `Bearer ${token.token}` };
}

function mcpHeaders(name: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "MCP-Protocol-Version": "2026-07-28",
    "Mcp-Method": "tools/call",
    "Mcp-Name": name,
    authorization: `Bearer ${token.token}`,
  };
}

async function invokeMcp(name: string, argumentsValue: Record<string, unknown>) {
  return mcpApp.inject({
    method: "POST",
    url: "/mcp/memory",
    headers: mcpHeaders(name),
    payload: {
      jsonrpc: "2.0",
      id: `slice3-parity:${name}:${randomUUID()}`,
      method: "tools/call",
      params: {
        name,
        arguments: argumentsValue,
        _meta: clientMeta,
      },
    },
  });
}

function safetyCleanManifest(
  marker: string,
  evidenceRefId: string,
): CodebaseRunReceiptV2["evidence_manifest"] {
  const refs: CodebaseRunReceiptV2["evidence_manifest"]["refs"] = [{
    id: evidenceRefId,
    type: "git_diff",
    uri: `https://github.com/acme/checkout/commit/${BASE_SHA}.diff`,
    digest: `sha256:${"f".repeat(64)}`,
    origin_id: `${REPOSITORY_ID}:${BASE_SHA}:${evidenceRefId}`,
    occurred_at: "2026-08-08T17:00:00.000Z",
    source_authority: "observed",
  }];
  for (let attempt = 0; attempt < 256; attempt++) {
    const body = {
      schema_version: "pim.memory-code-evidence.v2" as const,
      manifest_id: `slice3-parity-manifest-${marker}-${attempt}`,
      refs,
    };
    const manifest = { ...body, digest: canonicalJsonSha256(body) };
    if (scanMemoryV2Input(manifest).clean) return manifest;
  }
  throw new Error("Could not construct a deterministic safety-clean evidence manifest");
}

function v1SearchRequest(marker: string, producerRunId: string): MemorySearchV1 {
  const fixture = structuredClone(
    MEMORY_CONTRACT_FIXTURES.MemorySearchV1,
  ) as unknown as MemorySearchV1;
  return parseMemoryContract("MemorySearchV1", {
    ...fixture,
    request_id: `slice3-parity-v1-pack-${marker}`,
    consumer: { ...fixture.consumer, consumer_run_id: producerRunId },
    tenant: { project_id: context.projectA },
    applicability: {
      ...fixture.applicability,
      repository_id: REPOSITORY_ID,
      base_sha: BASE_SHA,
    },
  });
}

function v2SearchRequest(marker: string, producerRunId: string): CodebaseMemorySearchV2 {
  const fixture = structuredClone(
    MEMORY_CONTRACT_FIXTURES_V2.MemorySearchV2,
  ) as unknown as CodebaseMemorySearchV2;
  return parseMemoryContractV2("CodebaseMemorySearchV2", {
    ...fixture,
    request_id: `slice3-parity-http-pack-${marker}`,
    consumer: { ...fixture.consumer, consumer_run_id: producerRunId },
    tenant: { project_id: context.projectA },
    resource_selector: { canonical_resource_id: REPOSITORY_ID },
    applicability: {
      ...fixture.applicability,
      repository_id: REPOSITORY_ID,
      base_sha: BASE_SHA,
    },
  });
}

function mcpSearchRequest(marker: string, producerRunId: string): MemoryMcpCodeSearchInputV2 {
  const fixture = structuredClone(
    MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpCodeSearchInputV2,
  ) as unknown as MemoryMcpCodeSearchInputV2;
  return parseMemoryContractV2("MemoryMcpCodeSearchInputV2", {
    ...fixture,
    request_id: `slice3-parity-mcp-pack-${marker}`,
    consumer: { ...fixture.consumer, consumer_run_id: producerRunId },
    resource_selector: { canonical_resource_id: REPOSITORY_ID },
    applicability: {
      ...fixture.applicability,
      repository_id: REPOSITORY_ID,
      base_sha: BASE_SHA,
    },
  });
}

function v1Receipt(marker: string, producerRunId: string): RunReceiptV1 {
  const receipt = structuredClone(
    MEMORY_CONTRACT_FIXTURES.RunReceiptV1,
  ) as unknown as RunReceiptV1;
  const candidate = structuredClone(MEMORY_CONTRACT_FIXTURES.MemoryCandidateV1);
  const evidenceRefId = `slice3-parity-v1-evidence-${marker}`;
  const manifestBody = {
    schema_version: "pim.memory-code-evidence.v2" as const,
    manifest_id: `slice3-parity-v1-manifest-${marker}`,
    refs: [{
      id: evidenceRefId,
      type: "git_diff" as const,
      uri: `https://github.com/acme/checkout/commit/${BASE_SHA}.diff`,
      digest: `sha256:${"f".repeat(64)}`,
      origin_id: `${REPOSITORY_ID}:${BASE_SHA}:${evidenceRefId}`,
      occurred_at: "2026-08-08T17:00:00.000Z",
      source_authority: "observed" as const,
    }],
  };
  return parseMemoryContract("RunReceiptV1", {
    ...receipt,
    external_session_id: `slice3-parity-v1-session-${marker}`,
    producer: { ...receipt.producer, adapter_version: "slice3-parity-v1" },
    tenant: { project_id: context.projectA },
    repository: {
      ...receipt.repository,
      repository_id: REPOSITORY_ID,
      display_slug: "Acme/Checkout",
      base_sha: BASE_SHA,
    },
    retrieval_feedback: [],
    evidence_manifest: {
      ...manifestBody,
      digest: canonicalJsonSha256(manifestBody),
    },
    candidates: [{
      ...candidate,
      client_candidate_id: `slice3-parity-v1-candidate-${marker}`,
      applicability: {
        ...candidate.applicability,
        repository_id: REPOSITORY_ID,
        base_sha: BASE_SHA,
      },
      validation: { strategy: "repository_anchors" },
      source_run_ids: [producerRunId],
      evidence_refs: [evidenceRefId],
      activation_requirement_requested: "verified_merge",
    }],
  });
}

function v2Receipt(input: {
  marker: string;
  producerRunId: string;
  pack: MemorySearchResultV2;
}): CodebaseRunReceiptV2 {
  const source = structuredClone(
    MEMORY_CONTRACT_FIXTURES_V2.RunReceiptV2,
  ) as unknown as CodebaseRunReceiptV2;
  const candidate = source.candidates[0]!;
  const evidenceRefId = `slice3-parity-v2-evidence-${input.marker}`;
  return parseMemoryContractV2("CodebaseRunReceiptV2", {
    ...source,
    external_session_id: `slice3-parity-v2-session-${input.marker}`,
    producer: { ...source.producer, consumer_run_id: input.producerRunId },
    tenant: { project_id: context.projectA },
    resource_selector: { canonical_resource_id: REPOSITORY_ID },
    scope_snapshot: {
      schema_version: "pim.memory-scope-snapshot.codebase.v2",
      plane: "codebase",
      resource_binding: input.pack.resource_binding,
      repository_id: REPOSITORY_ID,
      base_sha: BASE_SHA,
      scope_snapshot_digest: input.pack.scope_snapshot_digest,
    },
    retrieval_feedback: [],
    evidence_manifest: safetyCleanManifest(input.marker, evidenceRefId),
    candidates: [{
      ...candidate,
      client_candidate_id: `slice3-parity-v2-candidate-${input.marker}`,
      resource_row_id: input.pack.resource_binding.resource_row_id,
      scope_snapshot_digest: input.pack.scope_snapshot_digest,
      applicability: {
        ...candidate.applicability,
        repository_id: REPOSITORY_ID,
        base_sha: BASE_SHA,
      },
      validation: {
        strategy: "repository_anchors",
        anchor_refs: ["src/payments/provider.ts#lookupTransaction"],
        failure_fingerprint: null,
      },
      source_run_ids: [input.producerRunId],
      evidence_refs: [evidenceRefId],
      activation_requirement_requested: "verified_merge",
    }],
  }) as CodebaseRunReceiptV2;
}

function mcpReceipt(
  marker: string,
  producerRunId: string,
  receipt: CodebaseRunReceiptV2,
): MemoryMcpRunReceiptSubmitInputV2 {
  const normalized = structuredClone(receipt) as unknown as Record<string, unknown>;
  delete normalized.tenant;
  const snapshot = normalized.scope_snapshot as Record<string, unknown>;
  delete snapshot.resource_binding;
  return parseMemoryContractV2("MemoryMcpRunReceiptSubmitInputV2", {
    idempotency_key: `slice3-parity-mcp-receipt-${marker}`,
    producer_run_id: producerRunId,
    receipt: normalized,
  });
}

function comparableReceipt(
  result: RunReceiptResultV1 | RunReceiptResultV2,
): Record<string, unknown> {
  return {
    status: result.status === "replayed" ? "accepted" : result.status,
    candidate_count: result.candidate_results.length,
  };
}

function comparableStatus(
  result: MemoryCandidateStatusV1 | MemoryCandidateStatusV2,
): Record<string, unknown> {
  return {
    plane: result.plane,
    kind: result.kind,
    status: result.status === "received"
      ? "accepted"
      : result.status === "pending_merge"
        ? "pending_evidence"
        : result.status,
    activation_requirement: result.activation_requirement,
    blockers: result.blockers,
    active_record: result.active_record ?? null,
  };
}

function comparableFeedback(
  result: MemoryFeedbackResultV1 | MemoryFeedbackResultV2,
): Record<string, unknown> {
  return {
    feedback_revision: result.feedback_revision,
    review_signal_ids: result.review_signal_ids,
  };
}

beforeAll(async () => {
  context = await createMemoryTestContext({}, { v2Reads: true, v2Writes: true });
  const owner = db.prepare(
    "SELECT created_by_user_id FROM projects WHERE project_id = ?",
  ).get(context.projectA) as { created_by_user_id: string };
  token = createPrivateMemoryMcpServiceToken({
    orgId: context.orgA.id,
    name: "Slice 3 write transport parity",
    scopes: [
      "memory:search",
      "memory:receipt:write",
      "memory:feedback:write",
      "memory:candidate:read",
    ],
    createdByUserId: owner.created_by_user_id,
    projectId: context.projectA,
    repositoryIds: [REPOSITORY_ID],
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  mcpApp = Fastify();
  registerJsonBodyParser(mcpApp);
  await mcpApp.register(rateLimit, { max: 1_000, timeWindow: "1 minute" });
  await mcpApp.register(memoryMcpRoutes);
  await mcpApp.ready();
});

afterAll(async () => {
  if (mcpApp) await mcpApp.close();
  if (context) await context.app.close();
});

describe("Slice 3 v1 / direct-HTTP-v2 / MCP code-write conformance", () => {
  it("keeps receipt, feedback, candidate status, replay, and canonical effects equivalent", async () => {
    const marker = randomUUID().replaceAll("-", "").slice(0, 16);
    const producerRuns = {
      v1: `example-harness-a:test:slice3-parity:v1:${marker}`,
      http: `example-harness-a:test:slice3-parity:http:${marker}`,
      mcp: `example-harness-a:test:slice3-parity:mcp:${marker}`,
    };
    const legacyFeedbackBefore = (db.prepare(
      "SELECT COUNT(*) AS count FROM memory_feedback",
    ).get() as { count: number }).count;

    const v1Search = await context.app.inject({
      method: "POST",
      url: "/api/v1/memory/search",
      headers: auth(),
      payload: v1SearchRequest(marker, producerRuns.v1),
    });
    expect(v1Search.statusCode, v1Search.body).toBe(200);
    const v1Pack = parseMemoryContract("MemorySearchResultV1", v1Search.json());

    const httpSearch = await context.app.inject({
      method: "POST",
      url: "/api/v2/memory/search",
      headers: auth(),
      payload: v2SearchRequest(marker, producerRuns.http),
    });
    expect(httpSearch.statusCode, httpSearch.body).toBe(200);
    const httpPack = parseMemoryContractV2("MemorySearchResultV2", httpSearch.json());

    const mcpSearch = await invokeMcp(
      "pim_code_memory_search",
      mcpSearchRequest(marker, producerRuns.mcp),
    );
    expect(mcpSearch.statusCode, mcpSearch.body).toBe(200);
    expect(mcpSearch.json().result.isError).not.toBe(true);
    const mcpPack = parseMemoryContractV2(
      "MemorySearchResultV2",
      mcpSearch.json().result.structuredContent,
    );
    expect(mcpPack.resource_binding).toEqual(httpPack.resource_binding);
    expect(mcpPack.scope_snapshot_digest).toBe(httpPack.scope_snapshot_digest);

    const v1ReceiptBody = v1Receipt(marker, producerRuns.v1);
    const v1ReceiptResponse = await context.app.inject({
      method: "PUT",
      url: `/api/v1/memory/run-receipts/${encodeURIComponent(producerRuns.v1)}`,
      headers: { ...auth(), "idempotency-key": `slice3-parity-v1-receipt-${marker}` },
      payload: v1ReceiptBody,
    });
    expect(v1ReceiptResponse.statusCode, v1ReceiptResponse.body).toBe(200);
    const v1Accepted = parseMemoryContract("RunReceiptResultV1", v1ReceiptResponse.json());

    const httpReceiptBody = v2Receipt({
      marker: `${marker}-http`,
      producerRunId: producerRuns.http,
      pack: httpPack,
    });
    const httpReceiptKey = `slice3-parity-http-receipt-${marker}`;
    const httpReceiptResponse = await context.app.inject({
      method: "PUT",
      url: `/api/v2/memory/run-receipts/${encodeURIComponent(producerRuns.http)}`,
      headers: { ...auth(), "idempotency-key": httpReceiptKey },
      payload: httpReceiptBody,
    });
    expect(httpReceiptResponse.statusCode, httpReceiptResponse.body).toBe(200);
    const httpAccepted = parseMemoryContractV2(
      "RunReceiptResultV2",
      httpReceiptResponse.json(),
    );

    const mcpReceiptBody = v2Receipt({
      marker: `${marker}-mcp`,
      producerRunId: producerRuns.mcp,
      pack: mcpPack,
    });
    const mcpReceiptInput = mcpReceipt(marker, producerRuns.mcp, mcpReceiptBody);
    const mcpReceiptResponse = await invokeMcp(
      "pim_run_receipt_submit",
      mcpReceiptInput as unknown as Record<string, unknown>,
    );
    expect(mcpReceiptResponse.statusCode, mcpReceiptResponse.body).toBe(200);
    expect(mcpReceiptResponse.json().result.isError).not.toBe(true);
    const mcpAccepted = parseMemoryContractV2(
      "RunReceiptResultV2",
      mcpReceiptResponse.json().result.structuredContent,
    );

    const expectedReceipt = comparableReceipt(v1Accepted);
    expect(comparableReceipt(httpAccepted)).toEqual(expectedReceipt);
    expect(comparableReceipt(mcpAccepted)).toEqual(expectedReceipt);
    expect(httpAccepted.resource_binding).toEqual(mcpAccepted.resource_binding);

    for (const candidateId of [
      httpAccepted.candidate_results[0]!.candidate_id,
      mcpAccepted.candidate_results[0]!.candidate_id,
    ]) {
      const row = db.prepare(
        "SELECT aggregate_version FROM memory_candidates_v1 WHERE candidate_id = ?",
      ).get(candidateId) as { aggregate_version: number };
      validateMemoryCandidate(candidateId, row.aggregate_version);
    }

    const v1StatusResponse = await context.app.inject({
      method: "GET",
      url: `/api/v1/memory/candidates/${encodeURIComponent(v1Accepted.candidate_results[0]!.candidate_id)}`,
      headers: auth(),
    });
    expect(v1StatusResponse.statusCode, v1StatusResponse.body).toBe(200);
    const v1Status = parseMemoryContract("MemoryCandidateStatusV1", v1StatusResponse.json());

    const httpStatusResponse = await context.app.inject({
      method: "GET",
      url: `/api/v2/memory/candidates/${encodeURIComponent(httpAccepted.candidate_results[0]!.candidate_id)}`,
      headers: auth(),
    });
    expect(httpStatusResponse.statusCode, httpStatusResponse.body).toBe(200);
    const httpStatus = parseMemoryContractV2(
      "MemoryCandidateStatusV2",
      httpStatusResponse.json(),
    );

    const mcpStatusResponse = await invokeMcp("pim_candidate_status", {
      plane: "codebase",
      resource_selector: { canonical_resource_id: REPOSITORY_ID },
      candidate_id: mcpAccepted.candidate_results[0]!.candidate_id,
    });
    expect(mcpStatusResponse.statusCode, mcpStatusResponse.body).toBe(200);
    expect(mcpStatusResponse.json().result.isError).not.toBe(true);
    const mcpStatus = parseMemoryContractV2(
      "MemoryCandidateStatusV2",
      mcpStatusResponse.json().result.structuredContent,
    );
    const expectedStatus = comparableStatus(v1Status);
    expect(comparableStatus(httpStatus)).toEqual(expectedStatus);
    expect(comparableStatus(mcpStatus)).toEqual(expectedStatus);

    const v1Feedback: MemoryFeedbackV1 = parseMemoryContract("MemoryFeedbackV1", {
      ...structuredClone(MEMORY_CONTRACT_FIXTURES.MemoryFeedbackV1),
      retrieval_pack_id: v1Pack.retrieval_pack_id,
      record_id: v1Pack.items[0]!.record_id,
      record_version: v1Pack.items[0]!.record_version,
      producer_run_id: producerRuns.v1,
      repository_id: REPOSITORY_ID,
      base_sha: BASE_SHA,
      reason_code: `slice3_parity_v1_helpful_${marker}`,
    });
    const v1FeedbackResponse = await context.app.inject({
      method: "POST",
      url: "/api/v1/memory/feedback",
      headers: auth(),
      payload: v1Feedback,
    });
    expect(v1FeedbackResponse.statusCode, v1FeedbackResponse.body).toBe(200);
    const v1FeedbackResult = parseMemoryContract(
      "MemoryFeedbackResultV1",
      v1FeedbackResponse.json(),
    );

    const httpFeedback: MemoryFeedbackV2 = {
      schema_version: "pim.memory-feedback.v2",
      feedback_revision: 1,
      retrieval_pack_id: httpPack.retrieval_pack_id,
      record_id: httpPack.items[0]!.record_id,
      record_version: httpPack.items[0]!.record_version,
      producer_run_id: producerRuns.http,
      plane: "codebase",
      resource_row_id: httpPack.resource_binding.resource_row_id,
      scope_snapshot_digest: httpPack.scope_snapshot_digest,
      disposition: "helpful",
      reason_code: `slice3_parity_http_helpful_${marker}`,
      outcome_evidence_refs: [],
      event_time: "2026-08-08T17:00:00.000Z",
    };
    const httpFeedbackKey = `slice3-parity-http-feedback-${marker}`;
    const httpFeedbackResponse = await context.app.inject({
      method: "POST",
      url: "/api/v2/memory/feedback",
      headers: { ...auth(), "idempotency-key": httpFeedbackKey },
      payload: httpFeedback,
    });
    expect(httpFeedbackResponse.statusCode, httpFeedbackResponse.body).toBe(200);
    const httpFeedbackResult = parseMemoryContractV2(
      "MemoryFeedbackResultV2",
      httpFeedbackResponse.json(),
    );

    const mcpFeedback: MemoryFeedbackV2 = {
      ...httpFeedback,
      retrieval_pack_id: mcpPack.retrieval_pack_id,
      record_id: mcpPack.items[0]!.record_id,
      record_version: mcpPack.items[0]!.record_version,
      producer_run_id: producerRuns.mcp,
      resource_row_id: mcpPack.resource_binding.resource_row_id,
      scope_snapshot_digest: mcpPack.scope_snapshot_digest,
      reason_code: `slice3_parity_mcp_helpful_${marker}`,
    };
    const mcpFeedbackInput = {
      idempotency_key: `slice3-parity-mcp-feedback-${marker}`,
      feedback: mcpFeedback,
    };
    const mcpFeedbackResponse = await invokeMcp("pim_feedback_submit", mcpFeedbackInput);
    expect(mcpFeedbackResponse.statusCode, mcpFeedbackResponse.body).toBe(200);
    expect(mcpFeedbackResponse.json().result.isError).not.toBe(true);
    const mcpFeedbackResult = parseMemoryContractV2(
      "MemoryFeedbackResultV2",
      mcpFeedbackResponse.json().result.structuredContent,
    );
    const expectedFeedback = comparableFeedback(v1FeedbackResult);
    expect(comparableFeedback(httpFeedbackResult)).toEqual(expectedFeedback);
    expect(comparableFeedback(mcpFeedbackResult)).toEqual(expectedFeedback);

    const [v1ReceiptReplay, httpReceiptReplay, mcpReceiptReplay] = await Promise.all([
      context.app.inject({
        method: "PUT",
        url: `/api/v1/memory/run-receipts/${encodeURIComponent(producerRuns.v1)}`,
        headers: { ...auth(), "idempotency-key": `slice3-parity-v1-receipt-${marker}` },
        payload: v1ReceiptBody,
      }),
      context.app.inject({
        method: "PUT",
        url: `/api/v2/memory/run-receipts/${encodeURIComponent(producerRuns.http)}`,
        headers: { ...auth(), "idempotency-key": httpReceiptKey },
        payload: httpReceiptBody,
      }),
      invokeMcp(
        "pim_run_receipt_submit",
        mcpReceiptInput as unknown as Record<string, unknown>,
      ),
    ]);
    expect(v1ReceiptReplay.json()).toEqual(v1ReceiptResponse.json());
    expect(parseMemoryContractV2("RunReceiptResultV2", httpReceiptReplay.json()))
      .toMatchObject({ receipt_id: httpAccepted.receipt_id, status: "replayed", duplicate: true });
    expect(parseMemoryContractV2(
      "RunReceiptResultV2",
      mcpReceiptReplay.json().result.structuredContent,
    )).toMatchObject({ receipt_id: mcpAccepted.receipt_id, status: "replayed", duplicate: true });

    const [v1FeedbackReplay, httpFeedbackReplay, mcpFeedbackReplay] = await Promise.all([
      context.app.inject({
        method: "POST",
        url: "/api/v1/memory/feedback",
        headers: auth(),
        payload: v1Feedback,
      }),
      context.app.inject({
        method: "POST",
        url: "/api/v2/memory/feedback",
        headers: { ...auth(), "idempotency-key": httpFeedbackKey },
        payload: httpFeedback,
      }),
      invokeMcp("pim_feedback_submit", mcpFeedbackInput),
    ]);
    expect(v1FeedbackReplay.json()).toEqual(v1FeedbackResponse.json());
    expect(parseMemoryContractV2("MemoryFeedbackResultV2", httpFeedbackReplay.json()))
      .toMatchObject({ feedback_id: httpFeedbackResult.feedback_id, duplicate: true });
    expect(parseMemoryContractV2(
      "MemoryFeedbackResultV2",
      mcpFeedbackReplay.json().result.structuredContent,
    )).toMatchObject({ feedback_id: mcpFeedbackResult.feedback_id, duplicate: true });

    const receiptIds = [
      v1Accepted.receipt_id,
      httpAccepted.receipt_id,
      mcpAccepted.receipt_id,
    ];
    const candidateIds = [
      v1Accepted.candidate_results[0]!.candidate_id,
      httpAccepted.candidate_results[0]!.candidate_id,
      mcpAccepted.candidate_results[0]!.candidate_id,
    ];
    for (const receiptId of receiptIds) {
      expect(db.prepare(
        "SELECT COUNT(*) AS count FROM memory_v2_receipt_facets WHERE receipt_id = ?",
      ).get(receiptId)).toEqual({ count: 1 });
    }
    for (const candidateId of candidateIds) {
      expect(db.prepare(
        "SELECT COUNT(*) AS count FROM memory_v2_candidate_facets WHERE candidate_id = ?",
      ).get(candidateId)).toEqual({ count: 1 });
    }
    expect(db.prepare(
      `SELECT COUNT(*) AS count FROM memory_v2_scope_snapshots
       WHERE producer_run_id IN (?, ?)`,
    ).get(producerRuns.http, producerRuns.mcp)).toEqual({ count: 2 });
    expect((db.prepare(
      "SELECT COUNT(*) AS count FROM memory_feedback",
    ).get() as { count: number }).count).toBe(legacyFeedbackBefore + 1);
    expect(db.prepare(
      `SELECT COUNT(*) AS count FROM memory_v2_feedback_bindings
       WHERE producer_run_id IN (?, ?) AND feedback_stage = 'later'`,
    ).get(producerRuns.http, producerRuns.mcp)).toEqual({ count: 2 });
  });
});
