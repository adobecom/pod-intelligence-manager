import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canonicalJsonSha256,
  MEMORY_CONTRACT_FIXTURES_V2,
  parseMemoryContractV2,
  type CodebaseMemorySearchV2,
  type CodebaseRunReceiptV2,
  type HarnessMemorySearchV2,
  type HarnessRuntimeEvidenceHandleV2,
  type HarnessRunReceiptV2,
  type MemoryBindingV2,
  type MemoryCandidateDecisionV2,
  type MemoryCandidateStatusV2,
  type MemoryRecordV2,
  type MemoryRetrievalPackV2,
  type MemorySearchResultV2,
  type PimErrorV2,
  type ResourceBindingV2,
  type RunReceiptResultV2,
  type RunReceiptV2,
} from "@pim/shared";
import {
  PimMemoryV2ApiError,
  PimMemoryV2Client,
} from "../../../../sdk/src/memory-v2-client.js";
import db from "../../db/connection.js";
import { registerJsonBodyParser } from "../../middleware/validation.js";
import { validateMemoryCandidate } from "../../services/memory-candidates.js";
import {
  setMemoryRuntimeAttestationVerifier,
} from "../../services/memory-v2-runtime-attestations.js";
import {
  createPrivateMemoryMcpServiceToken,
  createServiceToken,
  revokeServiceToken,
  type CreatedPrivateMemoryMcpServiceToken,
  type CreatedServiceToken,
} from "../../services/service-tokens.js";
import memoryMcpRoutes from "../memory-mcp.js";
import {
  createMemoryTestContext,
  type MemoryTestContext,
} from "./memory-test-app.js";

type Plane = "codebase" | "harness";
type Transport = "https" | "mcp";
type IssuedToken = CreatedServiceToken | CreatedPrivateMemoryMcpServiceToken;

const FIXTURES = [
  {
    fixture: "example-harness-a",
    repositoryId: "github.com/acme/checkout",
    baseSha: "7".repeat(40),
    harnessSubkind: "workflow_strategy",
    harnessKind: "decision",
    failureDerived: false,
  },
  {
    fixture: "example-harness-b",
    repositoryId: "github.com/acme/empty",
    baseSha: "8".repeat(40),
    harnessSubkind: "failure_pattern",
    harnessKind: "anti_pattern",
    failureDerived: true,
  },
] as const;

const MATRIX = (["codebase", "harness"] as const).flatMap((plane) => (
  (["https", "mcp"] as const).flatMap((transport) => (
    FIXTURES.map((fixture) => ({ plane, transport, ...fixture }))
  ))
));

type Fixture = (typeof FIXTURES)[number];
type MatrixRow = (typeof MATRIX)[number];

const HARNESS_VERSION = "7b6e858";
const WORKFLOW_VERSION = "code-change.v3";
const CONFIGURATION_ID = "routing-default-v2";
const MODEL_ID = "conformance-model";
const TOOL_ID = "conformance-tool";
const clientMeta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": {
    name: "memory-v2-conformance-live",
    version: "1.0.0",
  },
  "io.modelcontextprotocol/clientCapabilities": {},
};

interface CandidatePointer {
  candidateId: string;
  receiptId: string;
  producerRunId: string;
  binding: ResourceBindingV2;
}

interface ConsumerAdapter {
  binding(): Promise<MemoryBindingV2>;
  search(request: CodebaseMemorySearchV2 | HarnessMemorySearchV2): Promise<MemorySearchResultV2>;
  submitReceipt(
    producerRunId: string,
    idempotencyKey: string,
    receipt: RunReceiptV2,
  ): Promise<RunReceiptResultV2>;
  candidateStatus(pointer: CandidatePointer): Promise<MemoryCandidateStatusV2>;
  record(recordId: string, recordVersion: number): Promise<MemoryRecordV2>;
  pack(packId: string): Promise<MemoryRetrievalPackV2>;
}

interface MatrixActor {
  row: MatrixRow;
  token: IssuedToken;
  adapter: ConsumerAdapter;
  reviewer: PimMemoryV2Client;
  bindingEnvelope: MemoryBindingV2;
  binding: ResourceBindingV2;
  configurationDigest: string;
  lessonTag: string;
}

class ConformanceTransportError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: PimErrorV2["code"],
    message: string,
  ) {
    super(message);
    this.name = "ConformanceTransportError";
  }
}

let context: MemoryTestContext;
let httpBaseUrl = "";
let mcpBaseUrl = "";
let mcpApp: FastifyInstance;
const actors = new Map<string, MatrixActor>();
const bindings = new Map<string, ResourceBindingV2>();
const reviewers = new Map<string, PimMemoryV2Client>();

function marker(prefix: string): string {
  return `${prefix}-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function rowKey(row: Pick<MatrixRow, "plane" | "transport" | "fixture">): string {
  return `${row.plane}:${row.transport}:${row.fixture}`;
}

function resourceKey(plane: Plane, fixture: string): string {
  return `${plane}:${fixture}`;
}

function fixtureById(fixture: string): Fixture {
  const value = FIXTURES.find((candidate) => candidate.fixture === fixture);
  if (!value) throw new Error(`Unknown conformance fixture: ${fixture}`);
  return value;
}

function configurationDigest(row: Pick<MatrixRow, "fixture" | "transport">): string {
  return canonicalJsonSha256({
    fixture: row.fixture,
    transport: row.transport,
    configuration_id: CONFIGURATION_ID,
  });
}

function harnessQuery(row: MatrixRow): string {
  return row.failureDerived
    ? "Resolve an ambiguous timeout before retrying the provider operation"
    : `Confirm ${row.fixture} ${row.transport} terminal success before completing the workflow`;
}

function harnessContent(row: MatrixRow) {
  return row.failureDerived ? {
    summary: "Resolve an ambiguous timeout before retrying the provider operation.",
    details: `Inspect the ${row.transport} terminal provider event before retrying so a completed side effect is never repeated after an ambiguous timeout.`,
    rationale: "The stable failure fingerprint and verified runtime origin show why a blind retry is unsafe.",
  } : {
    summary: `${row.fixture} ${row.transport} verifies completion before closing.`,
    details: `The ${row.fixture} ${row.transport} consumer verifies the terminal result and preserves the confirmed outcome before the workflow is closed.`,
    rationale: `A verified successful run supports the exact ${row.transport} workflow lesson under authorized review.`,
  };
}

function harnessFailureFingerprint(row: MatrixRow): string | null {
  return row.failureDerived
    ? `failure:${row.fixture}:${row.transport}:ambiguous-timeout`
    : null;
}

function runtimeEvidence(input: {
  row: MatrixRow;
  producerRunId: string;
  failureFingerprint: string;
}): HarnessRuntimeEvidenceHandleV2 {
  const evidenceRefId = `runtime-${input.producerRunId}`;
  return {
    evidence_ref_id: evidenceRefId,
    handle_type: "root_origin",
    provider: "runtime_attestation",
    provider_identity: null,
    provider_domain_key: null,
    provider_event_id: `event-${input.producerRunId}`,
    immutable_digest: canonicalJsonSha256({
      fixture: input.row.fixture,
      transport: input.row.transport,
      producer_run_id: input.producerRunId,
      evidence_ref_id: evidenceRefId,
    }),
    producer_principal_id: null,
    effective_root_origin_id: null,
    corroboration_domain_id: null,
    observation_type: "root",
    outcome: {
      status: "completed",
      reason_code: "failure_recovered",
      verification_status: "passed",
      failure_fingerprint: input.failureFingerprint,
    },
    occurred_at: new Date().toISOString(),
    verified_at: null,
    source_authority: null,
    derivation_parent_refs: [],
  };
}

function consumer(row: MatrixRow, producerRunId: string) {
  return {
    harness_id: row.fixture,
    harness_version: HARNESS_VERSION,
    workflow_version: WORKFLOW_VERSION,
    adapter_version: `${row.fixture}-${row.transport}-adapter.v2`,
    consumer_run_id: producerRunId,
  };
}

function codeSearch(row: MatrixRow, requestId: string, producerRunId: string) {
  const source = structuredClone(
    MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpCodeSearchInputV2,
  );
  return parseMemoryContractV2("CodebaseMemorySearchV2", {
    ...source,
    request_id: requestId,
    consumer: consumer(row, producerRunId),
    tenant: { project_id: context.projectA },
    resource_selector: { canonical_resource_id: row.repositoryId },
    applicability: {
      plane: "codebase",
      repository_id: row.repositoryId,
      base_sha: row.baseSha,
      components: [`consumer-${row.transport}`],
      paths: [],
      symbols: [],
      task_classes: ["recovery"],
    },
    task: { query: `Apply ${row.fixture} ${row.transport} recovery lesson`, task_class: "recovery" },
  });
}

function harnessSearch(row: MatrixRow, requestId: string, producerRunId: string) {
  const source = structuredClone(
    MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpHarnessSearchInputV2,
  );
  return parseMemoryContractV2("HarnessMemorySearchV2", {
    ...source,
    request_id: requestId,
    consumer: consumer(row, producerRunId),
    tenant: { project_id: context.projectA },
    resource_selector: { canonical_resource_id: row.fixture },
    applicability: {
      plane: "harness",
      harness_id: row.fixture,
      harness_version_range: HARNESS_VERSION,
      workflow_version_range: WORKFLOW_VERSION,
      adapter_version_range: `${row.fixture}-${row.transport}-adapter.v2`,
      configuration_ids: [CONFIGURATION_ID],
      configuration_digests: [],
      model_ids: [MODEL_ID],
      tool_ids: [TOOL_ID],
    },
    task: { query: harnessQuery(row), task_class: row.failureDerived ? "recovery" : "verification" },
  });
}

function searchRequest(row: MatrixRow, requestId: string, producerRunId: string) {
  return row.plane === "codebase"
    ? codeSearch(row, requestId, producerRunId)
    : harnessSearch(row, requestId, producerRunId);
}

function codeScope(binding: ResourceBindingV2, fixture: Fixture) {
  const body = {
    schema_version: "pim.memory-scope-snapshot.codebase.v2" as const,
    plane: "codebase" as const,
    resource_binding: binding,
    repository_id: fixture.repositoryId,
    base_sha: fixture.baseSha,
  };
  return { ...body, scope_snapshot_digest: canonicalJsonSha256(body) };
}

function harnessScope(binding: ResourceBindingV2, row: MatrixRow) {
  const body = {
    schema_version: "pim.memory-scope-snapshot.harness.v2" as const,
    plane: "harness" as const,
    resource_binding: binding,
    harness_id: row.fixture,
    harness_version: HARNESS_VERSION,
    workflow_version: WORKFLOW_VERSION,
    adapter_version: `${row.fixture}-${row.transport}-adapter.v2`,
    configuration_id: CONFIGURATION_ID,
    configuration_digest: configurationDigest(row),
  };
  return { ...body, scope_snapshot_digest: canonicalJsonSha256(body) };
}

function evidenceManifest(input: {
  id: string;
  failure?: { evidenceRefId: string; repositoryId: string; baseSha: string };
}) {
  const body = {
    schema_version: "pim.memory-code-evidence.v2" as const,
    manifest_id: `manifest-${input.id}`,
    refs: input.failure ? [{
      id: input.failure.evidenceRefId,
      type: "failure" as const,
      uri: `https://${input.failure.repositoryId}/commit/${input.failure.baseSha}`,
      digest: canonicalJsonSha256({ evidence_ref_id: input.failure.evidenceRefId }),
      origin_id: `${input.failure.repositoryId}:failure:${input.id}`,
      occurred_at: "2026-08-11T07:00:00.000Z",
      source_authority: "observed" as const,
    }] : [],
  };
  return { ...body, digest: canonicalJsonSha256(body) };
}

function codeReceipt(input: {
  row: MatrixRow;
  binding: ResourceBindingV2;
  producerRunId: string;
  mode: "zero" | "candidate" | "feedback";
  feedback?: { pack: MemorySearchResultV2; recordId: string; recordVersion: number };
}): CodebaseRunReceiptV2 {
  const scope = codeScope(input.binding, input.row);
  const fingerprint = `failure:${input.row.fixture}:${input.row.transport}:timeout`;
  const evidenceRefId = `failure-${canonicalJsonSha256({
    producer_run_id: input.producerRunId,
  }).slice("sha256:".length, "sha256:".length + 24)}`;
  const candidate = input.mode === "candidate" ? [{
    schema_version: "pim.memory-candidate.v2" as const,
    client_candidate_id: `candidate-${input.producerRunId}`,
    plane: "codebase" as const,
    resource_row_id: input.binding.resource_row_id,
    scope_snapshot_digest: scope.scope_snapshot_digest,
    kind: "anti_pattern" as const,
    subkind: null,
    content: {
      summary: `${input.row.fixture} ${input.row.transport} checks ambiguous outcomes before retrying.`,
      details: `The ${input.row.fixture} ${input.row.transport} consumer inspects the terminal provider outcome before retrying so an already completed side effect is never duplicated.`,
      rationale: `Exact provider-state inspection makes the ${input.row.transport} retry path deterministic and safe.`,
    },
    applicability: {
      plane: "codebase" as const,
      repository_id: input.row.repositoryId,
      base_sha: input.row.baseSha,
      components: [`consumer-${input.row.transport}`],
      paths: [],
      symbols: [],
      task_classes: ["recovery"],
    },
    validation: {
      strategy: "stable_failure_fingerprint" as const,
      anchor_refs: [],
      failure_fingerprint: fingerprint,
    },
    exceptions: ["Does not apply after the provider proves that no side effect occurred."],
    source_run_ids: [input.producerRunId],
    evidence_refs: [evidenceRefId],
    extraction: {
      method: "deterministic" as const,
      extractor_version: "memory-v2-conformance.v1",
      confidence: 1,
    },
    activation_requirement_requested: "authorized_review" as const,
  }] : [];
  const feedback = input.mode === "feedback" && input.feedback ? [{
    retrieval_pack_id: input.feedback.pack.retrieval_pack_id,
    scope_snapshot_digest: input.feedback.pack.scope_snapshot_digest,
    record_id: input.feedback.recordId,
    record_version: input.feedback.recordVersion,
    disposition: "helpful" as const,
    reason_code: "conformance_lesson_prevented_rework",
  }] : [];
  return parseMemoryContractV2("CodebaseRunReceiptV2", {
    schema_version: "pim.run-receipt.v2",
    external_session_id: `session-${input.producerRunId}`,
    producer: consumer(input.row, input.producerRunId),
    tenant: { project_id: context.projectA },
    plane: "codebase",
    resource_selector: { resource_row_id: input.binding.resource_row_id },
    scope_snapshot: scope,
    task: { task_class: "recovery", summary: "Resolve an ambiguous provider outcome safely." },
    outcome: {
      status: input.mode === "candidate" ? "failed" : "completed",
      terminal_stage: "verify",
      reason_code: input.mode === "candidate" ? "ambiguous_timeout" : "completed_normally",
      verification_status: input.mode === "candidate" ? "failed" : "passed",
      failure_fingerprint: input.mode === "candidate" ? fingerprint : null,
    },
    retrieval_feedback: feedback,
    evidence_manifest: evidenceManifest({
      id: input.producerRunId,
      ...(input.mode === "candidate" ? {
        failure: {
          evidenceRefId,
          repositoryId: input.row.repositoryId,
          baseSha: input.row.baseSha,
        },
      } : {}),
    }),
    candidates: candidate,
  });
}

function harnessReceipt(input: {
  row: MatrixRow;
  binding: ResourceBindingV2;
  producerRunId: string;
  mode: "zero" | "candidate" | "feedback";
  feedback?: { pack: MemorySearchResultV2; recordId: string; recordVersion: number };
}): HarnessRunReceiptV2 {
  const scope = harnessScope(input.binding, input.row);
  const failureFingerprint = harnessFailureFingerprint(input.row);
  const evidence = input.mode === "candidate" && failureFingerprint
    ? [runtimeEvidence({
        row: input.row,
        producerRunId: input.producerRunId,
        failureFingerprint,
      })]
    : [];
  const candidate = input.mode === "candidate" ? [{
    schema_version: "pim.memory-candidate.v2" as const,
    client_candidate_id: `candidate-${input.producerRunId}`,
    plane: "harness" as const,
    resource_row_id: input.binding.resource_row_id,
    scope_snapshot_digest: scope.scope_snapshot_digest,
    kind: input.row.harnessKind,
    subkind: input.row.harnessSubkind,
    content: harnessContent(input.row),
    applicability: {
      plane: "harness" as const,
      harness_id: input.row.fixture,
      harness_version_range: HARNESS_VERSION,
      workflow_version_range: WORKFLOW_VERSION,
      adapter_version_range: `${input.row.fixture}-${input.row.transport}-adapter.v2`,
      configuration_ids: [CONFIGURATION_ID],
      configuration_digests: [configurationDigest(input.row)],
      model_ids: [MODEL_ID],
      tool_ids: [TOOL_ID],
    },
    validation: {
      strategy: input.row.failureDerived
        ? "stable_failure_fingerprint" as const
        : "authorized_review" as const,
      anchor_refs: [],
      failure_fingerprint: failureFingerprint,
    },
    exceptions: [],
    source_run_ids: [input.producerRunId],
    evidence_refs: evidence.map((item) => item.evidence_ref_id),
    extraction: {
      method: input.row.failureDerived ? "deterministic" as const : "authorized_review" as const,
      extractor_version: "memory-v2-conformance.v1",
      confidence: 1,
    },
    activation_requirement_requested: "authorized_review" as const,
  }] : [];
  const feedback = input.mode === "feedback" && input.feedback ? [{
    retrieval_pack_id: input.feedback.pack.retrieval_pack_id,
    scope_snapshot_digest: input.feedback.pack.scope_snapshot_digest,
    record_id: input.feedback.recordId,
    record_version: input.feedback.recordVersion,
    disposition: "helpful" as const,
    reason_code: "conformance_lesson_prevented_rework",
  }] : [];
  return parseMemoryContractV2("HarnessRunReceiptV2", {
    schema_version: "pim.run-receipt.v2",
    external_session_id: `session-${input.producerRunId}`,
    producer: consumer(input.row, input.producerRunId),
    tenant: { project_id: context.projectA },
    plane: "harness",
    resource_selector: { resource_row_id: input.binding.resource_row_id },
    scope_snapshot: scope,
    task: {
      task_class: input.row.failureDerived ? "recovery" : "verification",
      summary: harnessQuery(input.row),
    },
    outcome: {
      status: "completed",
      terminal_stage: "close",
      reason_code: input.row.failureDerived ? "failure_recovered" : "completed_normally",
      verification_status: "passed",
      failure_fingerprint: input.mode === "candidate" ? failureFingerprint : null,
    },
    retrieval_feedback: feedback,
    evidence_handles: evidence,
    candidates: candidate,
  });
}

function runReceipt(input: {
  row: MatrixRow;
  binding: ResourceBindingV2;
  producerRunId: string;
  mode: "zero" | "candidate" | "feedback";
  feedback?: { pack: MemorySearchResultV2; recordId: string; recordVersion: number };
}): RunReceiptV2 {
  return input.row.plane === "codebase" ? codeReceipt(input) : harnessReceipt(input);
}

function approveDecision(
  actor: MatrixActor,
  evidenceRefs: string[] = [],
): MemoryCandidateDecisionV2 {
  return parseMemoryContractV2("MemoryCandidateDecisionV2", {
    schema_version: "pim.memory-candidate-decision.v2",
    decision_revision: 1,
    plane: actor.row.plane,
    resource_row_id: actor.binding.resource_row_id,
    decision: "approve",
    reason_code: actor.row.failureDerived
      ? "verified_failure_lesson_approved"
      : "conformance_lesson_approved",
    explanation: "An authorized HTTPS reviewer approved the exact conformance lesson.",
    evidence_refs: evidenceRefs,
    event_time: new Date().toISOString(),
  });
}

function validateCandidate(candidateId: string): void {
  const row = db.prepare(
    "SELECT aggregate_version FROM memory_candidates_v1 WHERE candidate_id = ?",
  ).get(candidateId) as { aggregate_version: number } | undefined;
  if (!row) throw new Error(`Candidate is unavailable for validation: ${candidateId}`);
  validateMemoryCandidate(candidateId, row.aggregate_version);
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function statusForCode(code: PimErrorV2["code"]): number {
  if (code === "authentication_required") return 401;
  if (code === "resource_not_found") return 404;
  if (code === "schema_invalid") return 400;
  if (code === "temporarily_unavailable" || code === "provider_unavailable") return 503;
  return 403;
}

class McpConsumerAdapter implements ConsumerAdapter {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async request(
    method: "tools/call" | "resources/read",
    name: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const response = await fetch(`${this.baseUrl}/mcp/memory`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": method,
        "Mcp-Name": name,
        authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `conformance:${method}:${marker("request")}`,
        method,
        params,
      }),
    });
    const body = asObject(await response.json());
    const protocolError = asObject(body?.error);
    if (!response.ok || protocolError) {
      const data = asObject(protocolError?.data);
      const rawCode = typeof data?.code === "string" ? data.code : null;
      const code = rawCode ?? (response.status === 401
        ? "authentication_required"
        : response.status === 403
          ? "resource_binding_mismatch"
          : "temporarily_unavailable");
      throw new ConformanceTransportError(
        response.status,
        code as PimErrorV2["code"],
        typeof protocolError?.message === "string" ? protocolError.message : "MCP request failed",
      );
    }
    const result = asObject(body?.result);
    if (!result) throw new Error("MCP response omitted its result envelope");
    return result;
  }

  private async tool(name: string, argumentsValue: Record<string, unknown>): Promise<unknown> {
    const result = await this.request("tools/call", name, {
      name,
      arguments: argumentsValue,
      _meta: clientMeta,
    });
    const structured = result.structuredContent;
    const error = asObject(structured);
    if (error?.schema_version === "pim.error.v2" && typeof error.code === "string") {
      throw new ConformanceTransportError(
        statusForCode(error.code as PimErrorV2["code"]),
        error.code as PimErrorV2["code"],
        typeof error.message === "string" ? error.message : "MCP memory operation failed",
      );
    }
    return structured;
  }

  private async resource(uri: string): Promise<unknown> {
    const result = await this.request("resources/read", uri, { uri, _meta: clientMeta });
    const contents = Array.isArray(result.contents) ? result.contents : [];
    const first = asObject(contents[0]);
    if (!first || typeof first.text !== "string") {
      throw new Error("MCP resource response omitted JSON content");
    }
    return JSON.parse(first.text) as unknown;
  }

  async binding(): Promise<MemoryBindingV2> {
    return parseMemoryContractV2("MemoryBindingV2", await this.tool("pim_memory_binding", {}));
  }

  async search(
    request: CodebaseMemorySearchV2 | HarnessMemorySearchV2,
  ): Promise<MemorySearchResultV2> {
    const input = structuredClone(request) as unknown as Record<string, unknown>;
    delete input.tenant;
    const name = request.plane === "codebase"
      ? "pim_code_memory_search"
      : "pim_harness_memory_search";
    const contract = request.plane === "codebase"
      ? "MemoryMcpCodeSearchInputV2"
      : "MemoryMcpHarnessSearchInputV2";
    return parseMemoryContractV2(
      "MemorySearchResultV2",
      await this.tool(name, parseMemoryContractV2(contract, input)),
    );
  }

  async submitReceipt(
    producerRunId: string,
    idempotencyKey: string,
    receipt: RunReceiptV2,
  ): Promise<RunReceiptResultV2> {
    const normalized = structuredClone(receipt) as unknown as Record<string, unknown>;
    delete normalized.tenant;
    const scope = asObject(normalized.scope_snapshot);
    if (scope) delete scope.resource_binding;
    const input = parseMemoryContractV2("MemoryMcpRunReceiptSubmitInputV2", {
      producer_run_id: producerRunId,
      idempotency_key: idempotencyKey,
      receipt: normalized,
    });
    return parseMemoryContractV2(
      "RunReceiptResultV2",
      await this.tool("pim_run_receipt_submit", input),
    );
  }

  async candidateStatus(pointer: CandidatePointer): Promise<MemoryCandidateStatusV2> {
    const input = pointer.binding.plane === "codebase" ? {
      plane: "codebase",
      resource_selector: { resource_row_id: pointer.binding.resource_row_id },
      candidate_id: pointer.candidateId,
    } : {
      plane: "harness",
      resource_selector: { resource_row_id: pointer.binding.resource_row_id },
      receipt_id: pointer.receiptId,
      producer_run_id: pointer.producerRunId,
      candidate_id: pointer.candidateId,
    };
    return parseMemoryContractV2(
      "MemoryCandidateStatusV2",
      await this.tool(
        "pim_candidate_status",
        parseMemoryContractV2("MemoryMcpCandidateStatusInputV2", input),
      ),
    );
  }

  async record(recordId: string, recordVersion: number): Promise<MemoryRecordV2> {
    const uri = `pim-memory://records/${encodeURIComponent(recordId)}/versions/${recordVersion}`;
    return parseMemoryContractV2("MemoryRecordV2", await this.resource(uri));
  }

  async pack(packId: string): Promise<MemoryRetrievalPackV2> {
    const uri = `pim-memory://packs/${encodeURIComponent(packId)}`;
    return parseMemoryContractV2("MemoryRetrievalPackV2", await this.resource(uri));
  }
}

class HttpsConsumerAdapter implements ConsumerAdapter {
  constructor(private readonly client: PimMemoryV2Client) {}

  binding(): Promise<MemoryBindingV2> {
    return this.client.binding();
  }

  search(request: CodebaseMemorySearchV2 | HarnessMemorySearchV2) {
    return request.plane === "codebase"
      ? this.client.searchCode(request)
      : this.client.searchHarness(request);
  }

  submitReceipt(producerRunId: string, idempotencyKey: string, receipt: RunReceiptV2) {
    return this.client.putRunReceipt(producerRunId, idempotencyKey, receipt);
  }

  candidateStatus(pointer: CandidatePointer) {
    return pointer.binding.plane === "codebase"
      ? this.client.getCandidate(pointer.candidateId)
      : this.client.getHarnessCandidate({
          plane: "harness",
          resource_selector: { resource_row_id: pointer.binding.resource_row_id },
          receipt_id: pointer.receiptId,
          producer_run_id: pointer.producerRunId,
          candidate_id: pointer.candidateId,
        });
  }

  record(recordId: string, recordVersion: number) {
    return this.client.getRecord(recordId, recordVersion);
  }

  pack(packId: string) {
    return this.client.getPack(packId);
  }
}

function normalizedError(error: unknown): { statusCode: number; code: string } {
  if (error instanceof ConformanceTransportError) return error;
  if (error instanceof PimMemoryV2ApiError) {
    const response = asObject(error.response);
    return {
      statusCode: error.statusCode,
      code: typeof response?.code === "string" ? response.code : "unknown",
    };
  }
  throw error;
}

async function expectDenial(
  action: Promise<unknown>,
  codes: readonly string[],
): Promise<void> {
  const caught = await action.catch((error: unknown) => error);
  const error = normalizedError(caught);
  expect(error.statusCode).toBeGreaterThanOrEqual(400);
  expect(codes).toContain(error.code);
}

function ensureCanonicalAuthority(): void {
  if (db.prepare("SELECT 1 FROM memory_authority_transitions LIMIT 1").get()) return;
  const digest = canonicalJsonSha256({ fixture: "slice5-conformance-live" });
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO memory_legacy_import_runs
       (import_run_id, inventory_digest, resolution_digest, source_bundle_digest,
        source_item_count, imported_count, pending_count, quarantined_count,
        deduplicated_count, report_json, created_at)
     VALUES ('slice5-conformance-import', ?, ?, ?, 0, 0, 0, 0, 0, '{}', ?)`,
  ).run(digest, digest, digest, now);
  db.prepare(
    `INSERT INTO memory_authority_transitions
       (transition_id, revision, from_authority, to_authority,
        legacy_writes_frozen, import_run_id, actor_id, reason_code, occurred_at)
     VALUES
       ('slice5-conformance-authority-1', 1, 'legacy', 'migration_locked', 1,
        'slice5-conformance-import', 'slice5-conformance', 'cutover_started', ?),
       ('slice5-conformance-authority-2', 2, 'migration_locked', 'canonical', 1,
        'slice5-conformance-import', 'slice5-conformance', 'cutover_complete', ?)`,
  ).run(now, now);
}

function tokenInput(row: MatrixRow, ownerUserId: string) {
  const code = row.plane === "codebase";
  return {
    orgId: context.orgA.id,
    name: `Slice 5 ${rowKey(row)} consumer`,
    scopes: code
      ? ["memory:search", "memory:receipt:write", "memory:candidate:read"]
      : ["memory:harness:search", "memory:harness:receipt:write", "memory:harness:candidate:read"],
    createdByUserId: ownerUserId,
    projectId: context.projectA,
    ...(code ? { repositoryIds: [row.repositoryId] } : { harnessIds: [row.fixture] }),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  };
}

beforeAll(async () => {
  context = await createMemoryTestContext({}, { v2Reads: true, v2Writes: true });
  ensureCanonicalAuthority();
  const owner = db.prepare(
    "SELECT created_by_user_id FROM projects WHERE project_id = ?",
  ).get(context.projectA) as { created_by_user_id: string };
  setMemoryRuntimeAttestationVerifier(async (input) => ({
    providerIdentity: `service_principal:${input.auth.producerPrincipalId}`,
    providerDomainKey: `conformance-domain:${input.auth.producerPrincipalId}`,
    providerEventId: input.handle.provider_event_id,
    immutableDigest: input.handle.immutable_digest,
    occurredAt: input.handle.occurred_at,
    verifiedAt: input.receivedAt,
    outcomeFingerprint: canonicalJsonSha256(input.handle.outcome),
    observationType: input.handle.observation_type,
    sourceAuthority: "verified",
  }));

  mcpApp = Fastify();
  registerJsonBodyParser(mcpApp);
  await mcpApp.register(memoryMcpRoutes);
  await mcpApp.ready();
  [httpBaseUrl, mcpBaseUrl] = await Promise.all([
    context.app.listen({ host: "127.0.0.1", port: 0 }),
    mcpApp.listen({ host: "127.0.0.1", port: 0 }),
  ]);

  for (const row of MATRIX) {
    const reviewerKey = resourceKey(row.plane, row.fixture);
    if (!reviewers.has(reviewerKey)) {
      const reviewerToken = createServiceToken({
        orgId: context.orgA.id,
        name: `Slice 5 ${reviewerKey} HTTPS reviewer`,
        scopes: [row.plane === "codebase" ? "memory:review" : "memory:harness:review"],
        createdByUserId: owner.created_by_user_id,
        projectId: context.projectA,
        ...(row.plane === "codebase"
          ? { repositoryIds: [row.repositoryId] }
          : { harnessIds: [row.fixture] }),
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
      reviewers.set(reviewerKey, new PimMemoryV2Client({
        baseUrl: httpBaseUrl,
        authToken: reviewerToken.token,
        orgSlug: context.orgA.slug,
      }));
    }

    const issued = row.transport === "mcp"
      ? createPrivateMemoryMcpServiceToken(tokenInput(row, owner.created_by_user_id))
      : createServiceToken(tokenInput(row, owner.created_by_user_id));
    const adapter: ConsumerAdapter = row.transport === "mcp"
      ? new McpConsumerAdapter(mcpBaseUrl, issued.token)
      : new HttpsConsumerAdapter(new PimMemoryV2Client({
          baseUrl: httpBaseUrl,
          authToken: issued.token,
          orgSlug: context.orgA.slug,
        }));
    const bindingEnvelope = await adapter.binding();
    const binding = bindingEnvelope.resources.find((resource) => (
      resource.plane === row.plane
      && resource.canonical_resource_id === (
        row.plane === "codebase" ? row.repositoryId : row.fixture
      )
    ));
    if (!binding) throw new Error(`Issued credential lacks ${rowKey(row)}`);
    bindings.set(resourceKey(row.plane, row.fixture), binding);
    actors.set(rowKey(row), {
      row,
      token: issued,
      adapter,
      reviewer: reviewers.get(reviewerKey)!,
      bindingEnvelope,
      binding,
      configurationDigest: configurationDigest(row),
      lessonTag: `${row.fixture}-${row.transport}-${row.plane}`,
    });
  }
}, 30_000);

afterAll(async () => {
  setMemoryRuntimeAttestationVerifier(null);
  if (mcpApp) await mcpApp.close();
  if (context) await context.app.close();
});

describe("Slice 5 codebase/harness HTTPS/MCP conformance table", () => {
  it.each(MATRIX)(
    "$plane/$transport/$fixture completes the shared consumer lifecycle",
    async (row) => {
      const actor = actors.get(rowKey(row))!;
      const otherFixture = FIXTURES.find((candidate) => candidate.fixture !== row.fixture)!;
      const crossRow = { ...row, ...otherFixture } as MatrixRow;
      const crossBinding = bindings.get(resourceKey(row.plane, otherFixture.fixture))!;

      expect(actor.bindingEnvelope.tenant).toEqual({
        organization_id: context.orgA.id,
        project_id: context.projectA,
      });
      expect(actor.binding).toMatchObject({
        plane: row.plane,
        canonical_resource_id: row.plane === "codebase" ? row.repositoryId : row.fixture,
        permitted_operations: expect.arrayContaining([
          "search",
          "detail",
          "pack",
          "receipt_write",
          "candidate_read",
        ]),
      });
      expect(actor.bindingEnvelope.scopes).not.toContain(
        row.plane === "codebase" ? "memory:review" : "memory:harness:review",
      );

      const initialSearch = await actor.adapter.search(searchRequest(
        row,
        marker("initial-search"),
        `${actor.lessonTag}:${marker("initial-run")}`,
      ));
      expect(initialSearch).toMatchObject({
        plane: row.plane,
        resource_binding: { resource_row_id: actor.binding.resource_row_id },
      });

      const zeroRunId = `${actor.lessonTag}:${marker("zero")}`;
      const zero = await actor.adapter.submitReceipt(
        zeroRunId,
        `receipt:${zeroRunId}`,
        runReceipt({ row, binding: actor.binding, producerRunId: zeroRunId, mode: "zero" }),
      );
      expect(zero).toMatchObject({
        status: "accepted",
        duplicate: false,
        candidate_results: [],
      });

      const candidateRunId = `${actor.lessonTag}:${marker("candidate")}`;
      const candidateReceipt = runReceipt({
        row,
        binding: actor.binding,
        producerRunId: candidateRunId,
        mode: "candidate",
      });
      const idempotencyKey = `receipt:${candidateRunId}`;
      const accepted = await actor.adapter.submitReceipt(
        candidateRunId,
        idempotencyKey,
        candidateReceipt,
      );
      expect(accepted).toMatchObject({ status: "accepted", duplicate: false });
      expect(accepted.candidate_results).toHaveLength(1);
      const replay = await actor.adapter.submitReceipt(
        candidateRunId,
        idempotencyKey,
        candidateReceipt,
      );
      expect({ ...replay, status: "accepted", duplicate: false }).toEqual(accepted);
      expect(replay).toMatchObject({ status: "replayed", duplicate: true });

      const candidateId = accepted.candidate_results[0]!.candidate_id;
      validateCandidate(candidateId);
      const pointer = {
        candidateId,
        receiptId: accepted.receipt_id,
        producerRunId: candidateRunId,
        binding: actor.binding,
      };
      await expect(actor.adapter.candidateStatus(pointer)).resolves.toMatchObject({
        candidate_id: candidateId,
        plane: row.plane,
        status: "pending_review",
        active_record: null,
      });

      // Review/admin mutation intentionally remains HTTPS-only for both consumer transports.
      const decisionEvidenceRefs = row.plane === "harness"
        ? candidateReceipt.candidates[0]!.evidence_refs
        : [];
      const approved = await actor.reviewer.decideCandidate(
        candidateId,
        approveDecision(actor, decisionEvidenceRefs),
      );
      expect(approved).toMatchObject({
        candidate_id: candidateId,
        decision: "approve",
        candidate_status: "active",
        duplicate: false,
      });
      expect(approved.active_record).not.toBeNull();
      const activeRecord = approved.active_record!;

      const retrieved = await actor.adapter.search(searchRequest(
        row,
        marker("active-search"),
        `${actor.lessonTag}:${marker("active-run")}`,
      ));
      const retrievedItem = retrieved.items.find((item) => (
        item.record_id === activeRecord.record_id
        && item.record_version === activeRecord.record_version
      ));
      expect(retrievedItem).toMatchObject({ plane: row.plane });
      const [detail, pack] = await Promise.all([
        actor.adapter.record(activeRecord.record_id, activeRecord.record_version),
        actor.adapter.pack(retrieved.retrieval_pack_id),
      ]);
      expect(detail).toMatchObject({
        ...activeRecord,
        plane: row.plane,
        resource_binding: { resource_row_id: actor.binding.resource_row_id },
      });
      expect(pack).toMatchObject({
        retrieval_pack_id: retrieved.retrieval_pack_id,
        plane: row.plane,
        resource_binding: { resource_row_id: actor.binding.resource_row_id },
      });
      expect(pack.items).toEqual(expect.arrayContaining([
        expect.objectContaining(activeRecord),
      ]));

      const feedbackRunId = `${actor.lessonTag}:${marker("feedback")}`;
      const feedback = await actor.adapter.submitReceipt(
        feedbackRunId,
        `receipt:${feedbackRunId}`,
        runReceipt({
          row,
          binding: actor.binding,
          producerRunId: feedbackRunId,
          mode: "feedback",
          feedback: {
            pack: retrieved,
            recordId: activeRecord.record_id,
            recordVersion: activeRecord.record_version,
          },
        }),
      );
      expect(feedback).toMatchObject({
        status: "accepted",
        duplicate: false,
        candidate_results: [],
      });
      expect(db.prepare(
        `SELECT COUNT(*) AS count FROM memory_v2_feedback_bindings
         WHERE receipt_id = ? AND feedback_stage = 'receipt'`,
      ).get(feedback.receipt_id)).toEqual({ count: 1 });

      if (row.plane === "harness") {
        const convergenceRunId = `${actor.lessonTag}:${marker("convergence")}`;
        const convergenceReceipt = runReceipt({
          row,
          binding: actor.binding,
          producerRunId: convergenceRunId,
          mode: "candidate",
        });
        const convergenceAccepted = await actor.adapter.submitReceipt(
          convergenceRunId,
          `receipt:${convergenceRunId}`,
          convergenceReceipt,
        );
        const convergenceCandidateId = convergenceAccepted.candidate_results[0]!.candidate_id;
        validateCandidate(convergenceCandidateId);
        const converged = await actor.reviewer.decideCandidate(
          convergenceCandidateId,
          approveDecision(actor, convergenceReceipt.candidates[0]!.evidence_refs),
        );
        expect(converged).toMatchObject({
          candidate_id: convergenceCandidateId,
          decision: "approve",
          candidate_status: "active",
          duplicate: false,
          active_record: activeRecord,
        });
      }

      await expectDenial(
        actor.adapter.search(searchRequest(
          crossRow,
          marker("cross-search"),
          `${actor.lessonTag}:${marker("cross-search-run")}`,
        )),
        ["resource_not_found"],
      );
      const crossRunId = `${actor.lessonTag}:${marker("cross-receipt")}`;
      await expectDenial(
        actor.adapter.submitReceipt(
          crossRunId,
          `receipt:${crossRunId}`,
          runReceipt({
            row: crossRow,
            binding: crossBinding,
            producerRunId: crossRunId,
            mode: "zero",
          }),
        ),
        ["resource_binding_mismatch", "resource_not_found"],
      );

      expect(revokeServiceToken(context.orgA.id, actor.token.token_id)).toBe(true);
      await expectDenial(
        actor.adapter.search(searchRequest(
          row,
          marker("revoked-search"),
          `${actor.lessonTag}:${marker("revoked-run")}`,
        )),
        ["authentication_required"],
      );
    },
    30_000,
  );
});
