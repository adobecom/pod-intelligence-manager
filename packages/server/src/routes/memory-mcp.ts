import {
  createRestrictedMemoryMcpHandler,
  PIM_MEMORY_MCP_PROTOCOL_VERSION,
  type AuthInfo,
  type McpRequestContext,
} from "@pim/mcp-server/memory";
import {
  parseMemoryContractV2,
  type CodebaseRunReceiptV2,
  type HarnessRunReceiptV2,
  type HarnessMemorySearchV2,
  type MemoryMcpCandidateStatusInputV2,
  type MemoryMcpCodeSearchInputV2,
  type MemoryMcpFeedbackSubmitInputV2,
  type MemoryMcpHarnessSearchInputV2,
  type MemoryMcpReadinessInputV2,
  type MemoryMcpRunReceiptSubmitInputV2,
  type MemoryOperationV2,
  type PimErrorV2,
  type ResourceBindingV2,
} from "@pim/shared";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { getMemoryV2Binding } from "../services/memory-v2-binding.js";
import { getMemoryV2Capabilities } from "../services/memory-v2-capabilities.js";
import {
  authorizeCodeMemorySearchV2,
  MemoryV2CodeReadError,
  searchAuthorizedCodeMemoryV2,
} from "../services/memory-v2-code-read.js";
import {
  authorizeHarnessMemorySearchV2,
  searchAuthorizedHarnessMemoryV2,
} from "../services/memory-v2-harness-read.js";
import {
  getMemoryPackV2,
  getMemoryRecordV2,
} from "../services/memory-v2-read-dispatch.js";
import {
  appendAuthorizedCodeMemoryFeedbackV2,
  authorizeCodeMemoryCandidateStatusV2,
  authorizeCodeMemoryV2Operation,
  getAuthorizedCodeMemoryCandidateStatusV2,
  submitAuthorizedCodeMemoryRunReceiptV2,
} from "../services/memory-v2-code-write.js";
import {
  authorizeHarnessMemoryCandidateStatusV2,
  authorizeHarnessMemoryV2Operation,
  getAuthorizedHarnessMemoryCandidateStatusV2,
  submitAuthorizedHarnessMemoryRunReceiptV2,
} from "../services/memory-v2-harness-write.js";
import { scanMemoryV2Input } from "../services/memory-v2-input-safety.js";
import {
  authorizeMemoryV2Readiness,
  readAuthorizedMemoryV2Readiness,
} from "../services/memory-v2-readiness.js";
import {
  getMemoryV2Availability,
  memoryV2UnavailableError,
} from "../services/memory-v2-availability.js";
import { recordMemoryMetric } from "../services/memory-metrics.js";
import {
  MemoryV2RequestAuthorizationError,
  type MemoryV2RequestAuthorizationSnapshot,
} from "../services/memory-v2-request-authorization.js";
import {
  PRIVATE_MEMORY_MCP_AUDIENCE,
  PRIVATE_MEMORY_MCP_ENDPOINT_PATH,
  PRIVATE_MEMORY_MCP_RESOURCE_INDICATOR,
  ServiceTokenError,
  verifyPrivateMemoryMcpServiceToken,
  type VerifiedPrivateMemoryMcpServiceToken,
} from "../services/service-tokens.js";

export const MEMORY_MCP_BODY_LIMIT = 512 * 1024;
const MEMORY_MCP_RECEIPT_LIMIT = 256 * 1024;
const MEMORY_MCP_CANDIDATE_LIMIT = 32 * 1024;
const MEMORY_MCP_FEEDBACK_LIMIT = 32 * 1024;
export const MEMORY_MCP_RATE_LIMIT = {
  max: 60,
  timeWindow: "1 minute",
} as const;

declare module "fastify" {
  interface FastifyContextConfig {
    suppressAuthorizationHeaderLogging?: boolean;
    suppressRequestBodyLogging?: boolean;
  }
}

type MemoryMcpOperation =
  | "capabilities"
  | "binding"
  | "code_search"
  | "harness_search"
  | "receipt_write"
  | "feedback_write"
  | "candidate_read"
  | "readiness"
  | "record_read"
  | "pack_read"
  | "protocol";
type MemoryMcpOutcome = "success" | "replay" | "deny" | "error";
type MemoryMcpImplementedPlane = "codebase" | "harness";
type MemoryMcpReason =
  | PimErrorV2["code"]
  | "completed"
  | "replayed"
  | "invalid_token"
  | "profile_required"
  | "profile_mismatch"
  | "unsafe_scope"
  | "project_binding_required"
  | "resource_binding_required"
  | "membership_required"
  | "protocol_rejected"
  | "service_error"
  | "body_too_large"
  | "rate_limited"
  | "internal_error";

const APPLICATION_ERROR_REASONS = new Set<PimErrorV2["code"]>([
  "schema_invalid",
  "contract_version_unsupported",
  "authentication_required",
  "scope_required",
  "resource_binding_mismatch",
  "resource_not_found",
  "idempotency_conflict",
  "evidence_unresolvable",
  "evidence_mismatch",
  "transition_invalid",
  "activation_requirement_unsatisfied",
  "provider_unavailable",
  "rate_limited",
  "temporarily_unavailable",
  "reverification_required",
]);

interface MemoryMcpAuthExtra extends Record<string, unknown> {
  authorization: MemoryV2RequestAuthorizationSnapshot;
}

function privateResponseHeaders(reply: FastifyReply): void {
  reply.header("Cache-Control", "private, no-store");
  reply.header("Vary", "Authorization");
  reply.removeHeader("Mcp-Session-Id");
}

function bearerToken(req: FastifyRequest): string | null {
  const value = req.headers.authorization;
  if (!value) return null;
  return /^Bearer\s+(\S+)\s*$/i.exec(value)?.[1] ?? null;
}

function operationForRequest(req: FastifyRequest): MemoryMcpOperation {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) return "protocol";
  const request = body as { method?: unknown; params?: unknown };
  const params = request.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) return "protocol";
  if (request.method === "resources/read") {
    const uri = (params as { uri?: unknown }).uri;
    if (typeof uri !== "string") return "protocol";
    if (uri.startsWith("pim-memory://records/")) return "record_read";
    if (uri.startsWith("pim-memory://packs/")) return "pack_read";
    return "protocol";
  }
  if (request.method !== "tools/call") return "protocol";
  const name = (params as { name?: unknown }).name;
  return name === "pim_memory_capabilities"
    ? "capabilities"
    : name === "pim_memory_binding"
      ? "binding"
      : name === "pim_code_memory_search"
        ? "code_search"
        : name === "pim_harness_memory_search"
          ? "harness_search"
          : name === "pim_run_receipt_submit"
            ? "receipt_write"
            : name === "pim_feedback_submit"
              ? "feedback_write"
              : name === "pim_candidate_status"
                ? "candidate_read"
                : name === "pim_memory_readiness"
                  ? "readiness"
                  : "protocol";
}

function statusClass(statusCode: number): string {
  return statusCode >= 500
    ? "5xx"
    : statusCode >= 400
      ? "4xx"
      : statusCode >= 300
        ? "3xx"
        : "2xx";
}

function recordRequestOutcome(input: {
  req: FastifyRequest;
  startedAt: number;
  operation: MemoryMcpOperation;
  outcome: MemoryMcpOutcome;
  reason: MemoryMcpReason;
  statusCode: number;
  principalId?: string;
  resultCount?: number;
  plane?: MemoryMcpImplementedPlane;
}): void {
  let plane = input.plane;
  if (!plane && input.operation === "harness_search") plane = "harness";
  if (!plane && (
    input.operation === "code_search"
    || input.operation === "receipt_write"
    || input.operation === "feedback_write"
    || input.operation === "candidate_read"
  )) plane = "codebase";
  const isMemoryOperation = input.operation === "receipt_write"
    || input.operation === "feedback_write"
    || input.operation === "candidate_read"
    || input.operation === "readiness";
  const dimensions = {
    transport: "mcp",
    operation: input.operation,
    ...(plane
      ? {
          plane,
          resource_type: plane === "codebase" ? "repository" : "harness",
        }
      : {}),
    contract_version: "pim.memory.v2",
    outcome: input.outcome,
    reason: input.reason,
    status: statusClass(input.statusCode),
  };
  const fields = input.principalId
    ? { service_principal_id: input.principalId }
    : undefined;
  recordMemoryMetric({
    name: isMemoryOperation ? "MemoryOperationOutcome" : "SearchOutcome",
    value: 1,
    unit: "Count",
    dimensions,
    fields,
  });
  if ((input.operation === "code_search" || input.operation === "harness_search")
      && input.resultCount !== undefined) {
    recordMemoryMetric({
      name: "SearchResultCount",
      value: input.resultCount,
      unit: "Count",
      dimensions,
      fields,
    });
  }
  recordMemoryMetric({
    name: isMemoryOperation ? "MemoryOperationLatency" : "SearchLatency",
    value: Math.max(0, Date.now() - input.startedAt),
    unit: "Milliseconds",
    dimensions,
    fields,
  });
  input.req.log.info(
    {
      event: "memory_mcp_access",
      transport: "mcp",
      protocol_version: PIM_MEMORY_MCP_PROTOCOL_VERSION,
      operation: input.operation,
      outcome: input.outcome,
      reason: input.reason,
      status_code: input.statusCode,
      ...(plane ? { plane } : {}),
      ...(input.principalId ? { service_principal_id: input.principalId } : {}),
    },
    "Memory MCP audit",
  );
}

function authorizationFromAuthInfo(
  authInfo: AuthInfo | undefined,
): MemoryV2RequestAuthorizationSnapshot | null {
  const extra = authInfo?.extra as MemoryMcpAuthExtra | undefined;
  return extra?.authorization ?? null;
}

function requireMcpPrincipal(
  context: Pick<McpRequestContext, "authInfo">,
): MemoryV2RequestAuthorizationSnapshot {
  const principal = authorizationFromAuthInfo(context.authInfo);
  if (!principal) {
    throw new MemoryV2CodeReadError(
      "A PIM service-token principal is required",
      401,
      "authentication_required",
    );
  }
  if (!principal.projectId || principal.podId) {
    throw new MemoryV2CodeReadError(
      "A project-bound PIM service-token principal is required",
      403,
      "resource_binding_mismatch",
    );
  }
  return principal;
}

function hasEffectiveCodeOperationBinding(
  authInfo: AuthInfo | undefined,
  operation: MemoryOperationV2,
): boolean {
  const principal = authorizationFromAuthInfo(authInfo);
  if (!principal) return false;
  try {
    return getMemoryV2Binding(principal).resources.some((resource) => (
      resource.plane === "codebase"
      && resource.resource_type === "repository"
      && resource.permitted_operations.includes(operation)
    ));
  } catch {
    return false;
  }
}

function hasEffectiveCodeSearchBinding(authInfo: AuthInfo | undefined): boolean {
  return hasEffectiveCodeOperationBinding(authInfo, "search");
}

function hasEffectiveHarnessOperationBinding(
  authInfo: AuthInfo | undefined,
  operation: MemoryOperationV2,
): boolean {
  const principal = authorizationFromAuthInfo(authInfo);
  if (!principal) return false;
  try {
    return getMemoryV2Binding(principal).resources.some((resource) => (
      resource.plane === "harness"
      && resource.resource_type === "harness"
      && resource.permitted_operations.includes(operation)
    ));
  } catch {
    return false;
  }
}

function hasEffectiveHarnessSearchBinding(authInfo: AuthInfo | undefined): boolean {
  return hasEffectiveHarnessOperationBinding(authInfo, "search");
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

function schemaInvalid(
  message: string,
  path: string,
  reason: string,
): Error & {
  code: "schema_invalid";
  statusCode: 400;
  details: Array<{ path: string; reason: string }>;
} {
  return Object.assign(new Error(message), {
    code: "schema_invalid" as const,
    statusCode: 400 as const,
    details: [{ path, reason }],
  });
}

function assertSafeMcpInput(value: unknown): void {
  const safety = scanMemoryV2Input(value);
  if (!safety.clean) {
    throw schemaInvalid(
      "Memory input contains prohibited content",
      safety.path ?? "/",
      safety.reason ?? "prohibited content",
    );
  }
}

async function mcpCodeSearch(
  input: MemoryMcpCodeSearchInputV2,
  context: Pick<McpRequestContext, "authInfo">,
) {
  const principal = requireMcpPrincipal(context);
  const request = parseMemoryContractV2("CodebaseMemorySearchV2", {
    ...input,
    tenant: {
      project_id: principal.projectId,
    },
  });
  return searchAuthorizedCodeMemoryV2({
    authorization: authorizeCodeMemorySearchV2({ principal, request }),
    request,
  });
}

async function mcpHarnessSearch(
  input: MemoryMcpHarnessSearchInputV2,
  context: Pick<McpRequestContext, "authInfo">,
) {
  const principal = requireMcpPrincipal(context);
  const request = parseMemoryContractV2("HarnessMemorySearchV2", {
    ...input,
    tenant: {
      project_id: principal.projectId,
    },
  }) as HarnessMemorySearchV2;
  return searchAuthorizedHarnessMemoryV2({
    authorization: authorizeHarnessMemorySearchV2({ principal, request }),
    request,
  });
}

async function mcpRunReceiptSubmit(
  input: MemoryMcpRunReceiptSubmitInputV2,
  context: Pick<McpRequestContext, "authInfo">,
) {
  const principal = requireMcpPrincipal(context);
  if (serializedBytes(input.receipt) > MEMORY_MCP_RECEIPT_LIMIT) {
    throw schemaInvalid(
      "Receipt exceeds the published byte limit",
      "/receipt",
      "maximum serialized receipt size is 262144 bytes",
    );
  }
  if (input.receipt.candidates.some((candidate) => (
    serializedBytes(candidate) > MEMORY_MCP_CANDIDATE_LIMIT
  ))) {
    throw schemaInvalid(
      "Candidate exceeds the published byte limit",
      "/receipt/candidates",
      "maximum serialized candidate size is 32768 bytes",
    );
  }
  assertSafeMcpInput(input);
  if (input.receipt.plane === "harness") {
    const authorization = authorizeHarnessMemoryV2Operation({
      principal,
      selector: input.receipt.resource_selector,
      operation: "receipt_write",
      projectId: principal.projectId,
    });
    const resourceBinding: ResourceBindingV2 = {
      ...authorization.binding,
      permitted_operations: [...authorization.binding.permitted_operations],
    };
    const receipt = parseMemoryContractV2("HarnessRunReceiptV2", {
      ...input.receipt,
      tenant: { project_id: principal.projectId },
      scope_snapshot: {
        ...input.receipt.scope_snapshot,
        resource_binding: resourceBinding,
      },
    }) as HarnessRunReceiptV2;
    return submitAuthorizedHarnessMemoryRunReceiptV2({
      authorization,
      producerRunId: input.producer_run_id,
      idempotencyKey: input.idempotency_key,
      receipt,
    });
  }
  const authorization = authorizeCodeMemoryV2Operation({
    principal,
    selector: input.receipt.resource_selector,
    operation: "receipt_write",
    projectId: principal.projectId,
  });
  const resourceBinding: ResourceBindingV2 = {
    ...authorization.binding,
    permitted_operations: [...authorization.binding.permitted_operations],
  };
  const receipt = parseMemoryContractV2("CodebaseRunReceiptV2", {
    ...input.receipt,
    tenant: { project_id: principal.projectId },
    scope_snapshot: {
      ...input.receipt.scope_snapshot,
      resource_binding: resourceBinding,
    },
  }) as CodebaseRunReceiptV2;
  return submitAuthorizedCodeMemoryRunReceiptV2({
    authorization,
    producerRunId: input.producer_run_id,
    idempotencyKey: input.idempotency_key,
    receipt,
  });
}

async function mcpFeedbackSubmit(
  input: MemoryMcpFeedbackSubmitInputV2,
  context: Pick<McpRequestContext, "authInfo">,
) {
  const principal = requireMcpPrincipal(context);
  if (serializedBytes(input.feedback) > MEMORY_MCP_FEEDBACK_LIMIT) {
    throw schemaInvalid(
      "Feedback exceeds the published byte limit",
      "/feedback",
      "maximum serialized feedback size is 32768 bytes",
    );
  }
  assertSafeMcpInput(input);
  if (input.feedback.plane !== "codebase") {
    throw Object.assign(new Error("Harness feedback remains closed"), {
      code: "scope_required" as const,
      statusCode: 403,
      plane: "harness" as const,
    });
  }
  return appendAuthorizedCodeMemoryFeedbackV2({
    authorization: authorizeCodeMemoryV2Operation({
      principal,
      operation: "feedback_write",
      selector: { resource_row_id: input.feedback.resource_row_id },
    }),
    idempotencyKey: input.idempotency_key,
    feedback: input.feedback,
  });
}

async function mcpCandidateStatus(
  input: MemoryMcpCandidateStatusInputV2,
  context: Pick<McpRequestContext, "authInfo">,
) {
  const principal = requireMcpPrincipal(context);
  if (input.plane === "harness") {
    return getAuthorizedHarnessMemoryCandidateStatusV2({
      authorization: authorizeHarnessMemoryCandidateStatusV2({
        principal,
        candidateId: input.candidate_id,
        resourceSelector: input.resource_selector,
        receiptId: input.receipt_id,
        producerRunId: input.producer_run_id,
      }),
      candidateId: input.candidate_id,
      resourceSelector: input.resource_selector,
      receiptId: input.receipt_id,
      producerRunId: input.producer_run_id,
    });
  }
  return getAuthorizedCodeMemoryCandidateStatusV2({
    authorization: authorizeCodeMemoryCandidateStatusV2({
      principal,
      candidateId: input.candidate_id,
      resourceSelector: input.resource_selector,
    }),
    candidateId: input.candidate_id,
  });
}

async function mcpReadiness(
  input: MemoryMcpReadinessInputV2,
  context: Pick<McpRequestContext, "authInfo">,
) {
  const principal = requireMcpPrincipal(context);
  return readAuthorizedMemoryV2Readiness({
    authorization: authorizeMemoryV2Readiness({ principal, request: input }),
    request: input,
  });
}

function toAuthInfo(
  rawToken: string,
  verified: VerifiedPrivateMemoryMcpServiceToken,
): AuthInfo {
  return {
    token: rawToken,
    clientId: verified.auth.servicePrincipalId,
    scopes: [...verified.auth.scopes],
    expiresAt: Math.floor(Date.parse(verified.auth.expiresAt) / 1_000),
    resource: new URL(PRIVATE_MEMORY_MCP_RESOURCE_INDICATOR),
    extra: {
      authorization: verified.authorization,
    } satisfies MemoryMcpAuthExtra,
  };
}

function jsonRpcError(
  reply: FastifyReply,
  statusCode: number,
  code: number,
  message: string,
): FastifyReply {
  privateResponseHeaders(reply);
  return reply.code(statusCode).send({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

function methodNotAllowed(_req: FastifyRequest, reply: FastifyReply): FastifyReply {
  reply.header("Allow", "POST");
  return jsonRpcError(reply, 405, -32000, "Method not allowed.");
}

function protocolHeaders(req: FastifyRequest): Headers {
  const result = new Headers();
  for (const name of [
    "accept",
    "content-type",
    "mcp-protocol-version",
    "mcp-method",
    "mcp-name",
  ]) {
    const value = req.headers[name];
    if (typeof value === "string") result.set(name, value);
    else if (Array.isArray(value)) result.set(name, value.join(", "));
  }
  return result;
}

function classifyMcpResponse(
  statusCode: number,
  bytes: Uint8Array,
): {
  outcome: MemoryMcpOutcome;
  reason: MemoryMcpReason;
  resultCount?: number;
  plane?: MemoryMcpImplementedPlane;
} {
  if (statusCode >= 500) return { outcome: "error", reason: "service_error" };
  if (statusCode >= 400) return { outcome: "deny", reason: "protocol_rejected" };
  try {
    const body = JSON.parse(Buffer.from(bytes).toString("utf8")) as {
      error?: { data?: { code?: unknown; plane?: unknown } } | unknown;
      result?: {
        isError?: unknown;
        structuredContent?: {
          code?: unknown;
          duplicate?: unknown;
          items?: unknown;
          plane?: unknown;
        };
        contents?: Array<{ text?: unknown }>;
      };
    };
    const directPlane = body.result?.structuredContent?.plane;
    let plane: MemoryMcpImplementedPlane | undefined = directPlane === "codebase"
      || directPlane === "harness"
      ? directPlane
      : undefined;
    if (!plane && typeof body.result?.contents?.[0]?.text === "string") {
      try {
        const resource = JSON.parse(body.result.contents[0].text) as { plane?: unknown };
        if (resource.plane === "codebase" || resource.plane === "harness") {
          plane = resource.plane;
        }
      } catch {
        // A malformed successful resource is classified as a transport success;
        // the generated MCP resource parser remains the contract boundary.
      }
    }
    if (body.error) {
      const code = typeof body.error === "object" && body.error !== null
        ? (body.error as { data?: { code?: unknown } }).data?.code
        : undefined;
      const errorPlane = typeof body.error === "object" && body.error !== null
        ? (body.error as { data?: { plane?: unknown } }).data?.plane
        : undefined;
      if (errorPlane === "codebase" || errorPlane === "harness") plane = errorPlane;
      if (typeof code === "string" && APPLICATION_ERROR_REASONS.has(code as PimErrorV2["code"])) {
        const reason = code as PimErrorV2["code"];
        const retryable = reason === "provider_unavailable"
          || reason === "rate_limited"
          || reason === "temporarily_unavailable";
        return { outcome: retryable ? "error" : "deny", reason, ...(plane ? { plane } : {}) };
      }
      return { outcome: "deny", reason: "protocol_rejected", ...(plane ? { plane } : {}) };
    }
    if (body.result?.isError === true) {
      const code = body.result.structuredContent?.code;
      if (typeof code === "string" && APPLICATION_ERROR_REASONS.has(code as PimErrorV2["code"])) {
        const reason = code as PimErrorV2["code"];
        const retryable = reason === "provider_unavailable"
          || reason === "rate_limited"
          || reason === "temporarily_unavailable";
        return { outcome: retryable ? "error" : "deny", reason, ...(plane ? { plane } : {}) };
      }
      return { outcome: "error", reason: "service_error", ...(plane ? { plane } : {}) };
    }
    if (body.result?.structuredContent?.duplicate === true) {
      return { outcome: "replay", reason: "replayed", ...(plane ? { plane } : {}) };
    }
    const items = body.result?.structuredContent?.items;
    if (Array.isArray(items)) {
      return {
        outcome: "success",
        reason: "completed",
        resultCount: items.length,
        ...(plane ? { plane } : {}),
      };
    }
    return {
      outcome: "success",
      reason: "completed",
      ...(plane ? { plane } : {}),
    };
  } catch {
    // Non-JSON successful protocol responses are still transport successes.
  }
  return { outcome: "success", reason: "completed" };
}

export default async function memoryMcpRoutes(app: FastifyInstance): Promise<void> {
  const handler = createRestrictedMemoryMcpHandler(
    {
      capabilities: getMemoryV2Capabilities,
      binding: (context: Pick<McpRequestContext, "authInfo">) => (
        getMemoryV2Binding(authorizationFromAuthInfo(context.authInfo))
      ),
      codeSearch: mcpCodeSearch,
      harnessSearch: mcpHarnessSearch,
      runReceiptSubmit: mcpRunReceiptSubmit,
      feedbackSubmit: mcpFeedbackSubmit,
      candidateStatus: mcpCandidateStatus,
      readiness: mcpReadiness,
      recordResource: (ids, context) => getMemoryRecordV2({
        principal: requireMcpPrincipal(context),
        recordId: ids.recordId,
        recordVersion: ids.recordVersion,
      }),
      packResource: (ids, context) => getMemoryPackV2({
        principal: requireMcpPrincipal(context),
        packId: ids.packId,
      }),
    },
    {
      authorization: {
        canDiscoverCapabilities: (authInfo) => Boolean(authorizationFromAuthInfo(authInfo)),
        canDiscoverBinding: (authInfo) => Boolean(authorizationFromAuthInfo(authInfo)),
        canDiscoverCodeSearch: hasEffectiveCodeSearchBinding,
        canDiscoverHarnessSearch: hasEffectiveHarnessSearchBinding,
        canDiscoverRunReceiptSubmit: (authInfo) => (
          hasEffectiveCodeOperationBinding(authInfo, "receipt_write")
          || hasEffectiveHarnessOperationBinding(authInfo, "receipt_write")
        ),
        canDiscoverFeedbackSubmit: (authInfo) => (
          hasEffectiveCodeOperationBinding(authInfo, "feedback_write")
        ),
        canDiscoverCandidateStatus: (authInfo) => (
          hasEffectiveCodeOperationBinding(authInfo, "candidate_read")
          || hasEffectiveHarnessOperationBinding(authInfo, "candidate_read")
        ),
        canDiscoverReadiness: (authInfo) => (
          hasEffectiveCodeOperationBinding(authInfo, "readiness")
          || hasEffectiveHarnessOperationBinding(authInfo, "readiness")
        ),
        canDiscoverRecordResource: (authInfo) => (
          hasEffectiveCodeSearchBinding(authInfo) || hasEffectiveHarnessSearchBinding(authInfo)
        ),
        canDiscoverPackResource: (authInfo) => (
          hasEffectiveCodeSearchBinding(authInfo) || hasEffectiveHarnessSearchBinding(authInfo)
        ),
      },
    },
  );
  app.addHook("onClose", async () => handler.close());

  app.get(PRIVATE_MEMORY_MCP_ENDPOINT_PATH, methodNotAllowed);
  app.delete(PRIVATE_MEMORY_MCP_ENDPOINT_PATH, methodNotAllowed);

  app.post(
    PRIVATE_MEMORY_MCP_ENDPOINT_PATH,
    {
      bodyLimit: MEMORY_MCP_BODY_LIMIT,
      config: {
        rateLimit: MEMORY_MCP_RATE_LIMIT,
        suppressAuthorizationHeaderLogging: true,
        suppressRequestBodyLogging: true,
      },
      errorHandler: (error, req, reply) => {
        const startedAt = Date.now();
        const statusCode = error.statusCode === 413
          ? 413
          : error.statusCode === 429
            ? 429
            : 500;
        const reason: MemoryMcpReason = statusCode === 413
          ? "body_too_large"
          : statusCode === 429
            ? "rate_limited"
            : "internal_error";
        recordRequestOutcome({
          req,
          startedAt,
          operation: operationForRequest(req),
          outcome: statusCode >= 500 ? "error" : "deny",
          reason,
          statusCode,
        });
        return jsonRpcError(
          reply,
          statusCode,
          statusCode === 413 ? -32003 : statusCode === 429 ? -32004 : -32603,
          statusCode === 413
            ? "Request body is too large"
            : statusCode === 429
              ? "Rate limit exceeded"
              : "Internal server error",
        );
      },
    },
    async (req, reply) => {
      const startedAt = Date.now();
      const operation = operationForRequest(req);
      const availability = getMemoryV2Availability();
      if (availability.status === "unavailable") {
        recordRequestOutcome({
          req,
          startedAt,
          operation,
          outcome: "error",
          reason: "temporarily_unavailable",
          statusCode: 503,
        });
        const error = memoryV2UnavailableError(availability);
        privateResponseHeaders(reply);
        return reply.code(503).send({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: error.message,
            data: error,
          },
          id: null,
        });
      }
      const rawToken = bearerToken(req);
      if (!rawToken) {
        recordRequestOutcome({
          req,
          startedAt,
          operation,
          outcome: "deny",
          reason: "invalid_token",
          statusCode: 401,
        });
        reply.header("WWW-Authenticate", "Bearer");
        return jsonRpcError(reply, 401, -32001, "A private PIM service-token Bearer credential is required");
      }

      let verification;
      try {
        verification = verifyPrivateMemoryMcpServiceToken(rawToken, {
          audience: PRIVATE_MEMORY_MCP_AUDIENCE,
          resourceIndicator: PRIVATE_MEMORY_MCP_RESOURCE_INDICATOR,
          endpointPath: PRIVATE_MEMORY_MCP_ENDPOINT_PATH,
        });
      } catch (error) {
        const authorityDenied = error instanceof MemoryV2RequestAuthorizationError
          && error.statusCode < 500;
        const unavailable = error instanceof ServiceTokenError && error.statusCode === 503;
        const statusCode = authorityDenied ? 403 : unavailable ? 503 : 500;
        recordRequestOutcome({
          req,
          startedAt,
          operation,
          outcome: authorityDenied ? "deny" : "error",
          reason: authorityDenied ? "membership_required" : "internal_error",
          statusCode,
        });
        return jsonRpcError(
          reply,
          statusCode,
          authorityDenied ? -32002 : -32603,
          authorityDenied
            ? "PIM service token is not eligible for the private memory MCP profile"
            : "Memory MCP authentication is temporarily unavailable",
        );
      }
      if (!verification.ok) {
        const statusCode = verification.reason === "invalid_token" ? 401 : 403;
        recordRequestOutcome({
          req,
          startedAt,
          operation,
          outcome: "deny",
          reason: verification.reason,
          statusCode,
        });
        if (statusCode === 401) reply.header("WWW-Authenticate", "Bearer");
        return jsonRpcError(
          reply,
          statusCode,
          statusCode === 401 ? -32001 : -32002,
          statusCode === 401
            ? "Invalid or expired PIM service token"
            : "PIM service token is not eligible for the private memory MCP profile",
        );
      }

      const verified = verification.verified;
      const authInfo = toAuthInfo(rawToken, verified);
      const request = new Request("http://memory-mcp.internal/mcp/memory", {
        method: "POST",
        headers: protocolHeaders(req),
      });
      try {
        const response = await handler.fetch(request, {
          authInfo,
          parsedBody: req.body,
        });
        const bytes = new Uint8Array(await response.arrayBuffer());
        const classified = classifyMcpResponse(response.status, bytes);
        recordRequestOutcome({
          req,
          startedAt,
          operation,
          ...classified,
          statusCode: response.status,
          principalId: verified.auth.servicePrincipalId,
        });
        privateResponseHeaders(reply);
        const contentType = response.headers.get("content-type");
        if (contentType) reply.header("Content-Type", contentType);
        return reply.code(response.status).send(Buffer.from(bytes));
      } catch {
        recordRequestOutcome({
          req,
          startedAt,
          operation,
          outcome: "error",
          reason: "internal_error",
          statusCode: 500,
          principalId: verified.auth.servicePrincipalId,
        });
        return jsonRpcError(reply, 500, -32603, "Internal server error");
      }
    },
  );
}
