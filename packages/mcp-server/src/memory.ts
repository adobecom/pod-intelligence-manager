import {
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  ResourceTemplate,
  createMcpHandler,
  fromJsonSchema,
  type AuthInfo,
  type JsonSchemaType,
  type JsonSchemaValidator,
  type JsonSchemaValidatorResult,
  type McpHttpHandler,
  type McpRequestContext,
  type jsonSchemaValidator,
} from "@modelcontextprotocol/server";
import {
  MEMORY_CONTRACT_SCHEMA_V2,
  parseMemoryContractV2,
  type MemoryBindingV2,
  type MemoryCapabilitiesV2,
  type MemoryContractNameV2,
  type MemoryMcpCandidateStatusInputV2,
  type MemoryMcpCandidateStatusOutputV2,
  type MemoryMcpCodeSearchInputV2,
  type MemoryMcpCodeSearchOutputV2,
  type MemoryMcpFeedbackSubmitInputV2,
  type MemoryMcpFeedbackSubmitOutputV2,
  type MemoryMcpHarnessSearchInputV2,
  type MemoryMcpHarnessSearchOutputV2,
  type MemoryMcpPackResourceResultV2,
  type MemoryMcpReadinessInputV2,
  type MemoryMcpReadinessOutputV2,
  type MemoryMcpRecordResourceResultV2,
  type MemoryMcpRunReceiptSubmitInputV2,
  type MemoryMcpRunReceiptSubmitOutputV2,
  type MemoryPlaneV2,
  type PimErrorV2,
} from "@pim/shared";

export type { AuthInfo, McpRequestContext } from "@modelcontextprotocol/server";

export const PIM_MEMORY_MCP_PROTOCOL_VERSION = "2026-07-28" as const;
export const PIM_MEMORY_MCP_TOOL_NAMES = [
  "pim_memory_capabilities",
  "pim_memory_binding",
  "pim_code_memory_search",
  "pim_run_receipt_submit",
  "pim_feedback_submit",
  "pim_candidate_status",
  "pim_harness_memory_search",
  "pim_memory_readiness",
] as const;
export const PIM_MEMORY_MCP_RESOURCE_TEMPLATES = [
  "pim-memory://records/{record_id}/versions/{version}",
  "pim-memory://packs/{pack_id}",
] as const;

const CAPABILITY_SERVICE_ERROR = "Memory capability service unavailable";
const BINDING_SERVICE_ERROR = "Memory binding service unavailable";
const GENERIC_MEMORY_SERVICE_ERROR = "Memory service is temporarily unavailable";
const REQUIRED_MODERN_HEADERS = [
  "MCP-Protocol-Version",
  "Mcp-Method",
  "Mcp-Name",
] as const;

const EmptyToolInput = fromJsonSchema<Record<string, never>>({
  type: "object",
  additionalProperties: false,
  maxProperties: 0,
});

function generatedContractSchema(name: MemoryContractNameV2): JsonSchemaType {
  const definition = MEMORY_CONTRACT_SCHEMA_V2.$defs[name];
  return {
    $schema: MEMORY_CONTRACT_SCHEMA_V2.$schema,
    ...definition,
    $defs: MEMORY_CONTRACT_SCHEMA_V2.$defs,
  } as JsonSchemaType;
}

const StructuredToolInputValidator: jsonSchemaValidator = {
  getValidator<T>(_schema: JsonSchemaType): JsonSchemaValidator<T> {
    return (input: unknown): JsonSchemaValidatorResult<T> => {
      const data: T = input as T;
      return {
        valid: true,
        data,
        errorMessage: undefined,
      };
    };
  },
};

// The exact frozen JSON Schema is still advertised. Input validation is
// deliberately completed inside the callback so contract failures can use the
// same bounded PimErrorV2 result shape as application failures.
const CodeSearchToolInput = fromJsonSchema<MemoryMcpCodeSearchInputV2>(
  generatedContractSchema("MemoryMcpCodeSearchInputV2"),
  StructuredToolInputValidator,
);
const CodeSearchToolOutput = fromJsonSchema<MemoryMcpCodeSearchOutputV2>(
  generatedContractSchema("MemoryMcpCodeSearchOutputV2"),
);
const RunReceiptSubmitToolInput = fromJsonSchema<MemoryMcpRunReceiptSubmitInputV2>(
  generatedContractSchema("MemoryMcpRunReceiptSubmitInputV2"),
  StructuredToolInputValidator,
);
const RunReceiptSubmitToolOutput = fromJsonSchema<MemoryMcpRunReceiptSubmitOutputV2>(
  generatedContractSchema("MemoryMcpRunReceiptSubmitOutputV2"),
);
const FeedbackSubmitToolInput = fromJsonSchema<MemoryMcpFeedbackSubmitInputV2>(
  generatedContractSchema("MemoryMcpFeedbackSubmitInputV2"),
  StructuredToolInputValidator,
);
const FeedbackSubmitToolOutput = fromJsonSchema<MemoryMcpFeedbackSubmitOutputV2>(
  generatedContractSchema("MemoryMcpFeedbackSubmitOutputV2"),
);
const CandidateStatusToolInput = fromJsonSchema<MemoryMcpCandidateStatusInputV2>(
  generatedContractSchema("MemoryMcpCandidateStatusInputV2"),
  StructuredToolInputValidator,
);
const CandidateStatusToolOutput = fromJsonSchema<MemoryMcpCandidateStatusOutputV2>(
  generatedContractSchema("MemoryMcpCandidateStatusOutputV2"),
);
const HarnessSearchToolInput = fromJsonSchema<MemoryMcpHarnessSearchInputV2>(
  generatedContractSchema("MemoryMcpHarnessSearchInputV2"),
  StructuredToolInputValidator,
);
const HarnessSearchToolOutput = fromJsonSchema<MemoryMcpHarnessSearchOutputV2>(
  generatedContractSchema("MemoryMcpHarnessSearchOutputV2"),
);
const ReadinessToolInput = fromJsonSchema<MemoryMcpReadinessInputV2>(
  generatedContractSchema("MemoryMcpReadinessInputV2"),
  StructuredToolInputValidator,
);
const ReadinessToolOutput = fromJsonSchema<MemoryMcpReadinessOutputV2>(
  generatedContractSchema("MemoryMcpReadinessOutputV2"),
);

export type RestrictedMemoryMcpRequestContext = Readonly<
  Pick<McpRequestContext, "authInfo">
>;

export interface RestrictedMemoryMcpRecordResourceIds {
  recordId: string;
  recordVersion: number;
}

export interface RestrictedMemoryMcpPackResourceIds {
  packId: string;
}

export interface RestrictedMemoryMcpServices {
  capabilities(): MemoryCapabilitiesV2 | Promise<MemoryCapabilitiesV2>;
  binding?(
    context: RestrictedMemoryMcpRequestContext,
  ): MemoryBindingV2 | Promise<MemoryBindingV2>;
  codeSearch?(
    input: MemoryMcpCodeSearchInputV2,
    context: RestrictedMemoryMcpRequestContext,
  ): MemoryMcpCodeSearchOutputV2 | Promise<MemoryMcpCodeSearchOutputV2>;
  runReceiptSubmit?(
    input: MemoryMcpRunReceiptSubmitInputV2,
    context: RestrictedMemoryMcpRequestContext,
  ): MemoryMcpRunReceiptSubmitOutputV2 | Promise<MemoryMcpRunReceiptSubmitOutputV2>;
  feedbackSubmit?(
    input: MemoryMcpFeedbackSubmitInputV2,
    context: RestrictedMemoryMcpRequestContext,
  ): MemoryMcpFeedbackSubmitOutputV2 | Promise<MemoryMcpFeedbackSubmitOutputV2>;
  candidateStatus?(
    input: MemoryMcpCandidateStatusInputV2,
    context: RestrictedMemoryMcpRequestContext,
  ): MemoryMcpCandidateStatusOutputV2 | Promise<MemoryMcpCandidateStatusOutputV2>;
  harnessSearch?(
    input: MemoryMcpHarnessSearchInputV2,
    context: RestrictedMemoryMcpRequestContext,
  ): MemoryMcpHarnessSearchOutputV2 | Promise<MemoryMcpHarnessSearchOutputV2>;
  readiness?(
    input: MemoryMcpReadinessInputV2,
    context: RestrictedMemoryMcpRequestContext,
  ): MemoryMcpReadinessOutputV2 | Promise<MemoryMcpReadinessOutputV2>;
  /** Resolve the opaque URI IDs and reauthorize them against `context`; IDs confer no authority. */
  recordResource?(
    ids: RestrictedMemoryMcpRecordResourceIds,
    context: RestrictedMemoryMcpRequestContext,
  ): MemoryMcpRecordResourceResultV2 | Promise<MemoryMcpRecordResourceResultV2>;
  /** Resolve the opaque URI ID and reauthorize it against `context`; the ID confers no authority. */
  packResource?(
    ids: RestrictedMemoryMcpPackResourceIds,
    context: RestrictedMemoryMcpRequestContext,
  ): MemoryMcpPackResourceResultV2 | Promise<MemoryMcpPackResourceResultV2>;
}

export interface RestrictedMemoryMcpAuthorization {
  /** Return true only when this authenticated principal may discover capabilities. */
  canDiscoverCapabilities(authInfo: AuthInfo | undefined): boolean;
  /** Return true only when this principal may introspect its own binding. */
  canDiscoverBinding?(authInfo: AuthInfo | undefined): boolean;
  /** Return true only when this principal may discover codebase search. */
  canDiscoverCodeSearch?(authInfo: AuthInfo | undefined): boolean;
  /** Return true only when this principal may discover codebase receipt intake. */
  canDiscoverRunReceiptSubmit?(authInfo: AuthInfo | undefined): boolean;
  /** Return true only when this principal may discover bound feedback intake. */
  canDiscoverFeedbackSubmit?(authInfo: AuthInfo | undefined): boolean;
  /** Return true only when this principal may discover codebase candidate status. */
  canDiscoverCandidateStatus?(authInfo: AuthInfo | undefined): boolean;
  /** Return true only when this principal may discover exact-harness v2 search. */
  canDiscoverHarnessSearch?(authInfo: AuthInfo | undefined): boolean;
  /** Return true only when this principal may discover bounded readiness for an authorized plane. */
  canDiscoverReadiness?(authInfo: AuthInfo | undefined): boolean;
  /** Return true only when this principal may discover immutable records. */
  canDiscoverRecordResource?(authInfo: AuthInfo | undefined): boolean;
  /** Return true only when this principal may discover immutable packs. */
  canDiscoverPackResource?(authInfo: AuthInfo | undefined): boolean;
}

export interface RestrictedMemoryMcpOptions {
  authorization?: RestrictedMemoryMcpAuthorization;
}

type MemoryMcpJsonResult =
  | MemoryCapabilitiesV2
  | MemoryBindingV2
  | MemoryMcpCodeSearchOutputV2
  | MemoryMcpRunReceiptSubmitOutputV2
  | MemoryMcpFeedbackSubmitOutputV2
  | MemoryMcpCandidateStatusOutputV2
  | MemoryMcpHarnessSearchOutputV2
  | MemoryMcpReadinessOutputV2
  | PimErrorV2;

function jsonResult(value: MemoryMcpJsonResult) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

const PIM_ERROR_MESSAGES: Readonly<Record<PimErrorV2["code"], string>> = {
  schema_invalid: "The memory request is invalid",
  contract_version_unsupported: "The memory contract version is unsupported",
  authentication_required: "Memory authentication is required",
  scope_required: "The required memory scope is missing",
  resource_binding_mismatch: "The memory resource binding does not match",
  resource_not_found: "The memory resource was not found",
  idempotency_conflict: "The memory request conflicts with an earlier request",
  evidence_unresolvable: "Memory evidence could not be resolved",
  evidence_mismatch: "Memory evidence does not match",
  transition_invalid: "The requested memory transition is invalid",
  activation_requirement_unsatisfied: "Memory activation requirements are not satisfied",
  provider_unavailable: "A required memory provider is unavailable",
  rate_limited: "The memory request was rate limited",
  temporarily_unavailable: GENERIC_MEMORY_SERVICE_ERROR,
  reverification_required: "Memory reverification is required",
};

const RETRYABLE_PIM_ERROR_CODES = new Set<PimErrorV2["code"]>([
  "provider_unavailable",
  "rate_limited",
  "temporarily_unavailable",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function applicationErrorCode(error: unknown): PimErrorV2["code"] | null {
  if (!isRecord(error) || typeof error.code !== "string") return null;
  return Object.hasOwn(PIM_ERROR_MESSAGES, error.code)
    ? error.code as PimErrorV2["code"]
    : null;
}

function applicationErrorPlane(error: unknown): MemoryPlaneV2 | null {
  if (!isRecord(error)) return null;
  return error.plane === "codebase"
    || error.plane === "harness"
    ? error.plane
    : null;
}

function applicationErrorDetails(
  error: unknown,
): PimErrorV2["details"] {
  if (!isRecord(error)) return [];
  const raw = Array.isArray(error.details)
    ? error.details
    : Array.isArray(error.issues)
      ? error.issues
      : [];
  return raw.slice(0, 64).flatMap((detail) => {
    if (!isRecord(detail)
        || typeof detail.path !== "string"
        || detail.path.length < 1
        || detail.path.length > 512
        || typeof detail.reason !== "string"
        || detail.reason.length < 1
        || detail.reason.length > 512) return [];
    return [{ path: detail.path, reason: detail.reason }];
  });
}

function pimErrorResult(
  error: unknown,
  context: { requestId: string | null; plane: MemoryPlaneV2 | null },
): PimErrorV2 {
  const code = applicationErrorCode(error) ?? "temporarily_unavailable";
  return parseMemoryContractV2("PimErrorV2", {
    schema_version: "pim.error.v2",
    code,
    message: PIM_ERROR_MESSAGES[code],
    request_id: context.requestId,
    plane: context.plane ?? applicationErrorPlane(error),
    retryable: RETRYABLE_PIM_ERROR_CODES.has(code),
    details: applicationErrorCode(error) ? applicationErrorDetails(error) : [],
  });
}

function toolErrorResult(
  error: unknown,
  context: { requestId: string | null; plane: MemoryPlaneV2 | null },
) {
  return {
    ...jsonResult(pimErrorResult(error, context)),
    isError: true,
  };
}

function boundedRequestId(input: unknown): string | null {
  if (!isRecord(input) || typeof input.request_id !== "string") return null;
  return input.request_id.length >= 1 && input.request_id.length <= 128
    ? input.request_id
    : null;
}

function rawMemoryPlane(value: unknown): MemoryPlaneV2 | null {
  if (!isRecord(value)) return null;
  return value.plane === "codebase"
    || value.plane === "harness"
    ? value.plane
    : null;
}

function resourceProtocolError(
  error: unknown,
  context: { requestId: string | null; plane: MemoryPlaneV2 | null },
): ProtocolError {
  const result = pimErrorResult(error, {
    ...context,
    plane: applicationErrorPlane(error) ?? context.plane,
  });
  return new ProtocolError(
    result.retryable ? ProtocolErrorCode.InternalError : ProtocolErrorCode.InvalidParams,
    result.message,
    result,
  );
}

function invalidResourceInput(): Error & { code: PimErrorV2["code"] } {
  return Object.assign(new Error("Invalid memory resource URI"), {
    code: "schema_invalid" as const,
  });
}

function decodedResourceId(value: string | string[] | undefined): string {
  if (typeof value !== "string") throw invalidResourceInput();
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw invalidResourceInput();
  }
  if (decoded.length < 1 || decoded.length > 128) throw invalidResourceInput();
  return decoded;
}

function recordResourceIds(
  uri: URL,
  variables: Record<string, string | string[]>,
): RestrictedMemoryMcpRecordResourceIds {
  if (uri.search || uri.hash) throw invalidResourceInput();
  const version = typeof variables.version === "string" && /^[1-9]\d*$/.test(variables.version)
    ? Number(variables.version)
    : Number.NaN;
  if (!Number.isSafeInteger(version) || version < 1) throw invalidResourceInput();
  return {
    recordId: decodedResourceId(variables.record_id),
    recordVersion: version,
  };
}

function packResourceIds(
  uri: URL,
  variables: Record<string, string | string[]>,
): RestrictedMemoryMcpPackResourceIds {
  if (uri.search || uri.hash) throw invalidResourceInput();
  return { packId: decodedResourceId(variables.pack_id) };
}

function resourceResult(
  uri: URL,
  value: MemoryMcpRecordResourceResultV2 | MemoryMcpPackResourceResultV2,
) {
  return {
    contents: [{
      uri: uri.href,
      mimeType: "application/json",
      text: JSON.stringify(value),
    }],
  };
}

/**
 * Builds the memory-only catalog for one stateless request. It intentionally
 * has no dependency on the broad interactive PIM server and no storage access.
 */
export function createRestrictedMemoryMcpServer(
  services: RestrictedMemoryMcpServices,
  context: RestrictedMemoryMcpRequestContext = {},
  options: RestrictedMemoryMcpOptions = {},
): McpServer {
  const server = new McpServer(
    { name: "pim-memory", version: "0.1.0" },
    {
      capabilities: {
        tools: { listChanged: false },
        resources: { listChanged: false, subscribe: false },
      },
      cacheHints: {
        "server/discover": { ttlMs: 0, cacheScope: "private" },
        "tools/list": { ttlMs: 0, cacheScope: "private" },
        "resources/list": { ttlMs: 0, cacheScope: "private" },
        "resources/templates/list": { ttlMs: 0, cacheScope: "private" },
      },
      instructions: "Restricted PIM memory data plane. HTTP v2 remains canonical.",
    },
  );

  const allowed = options.authorization?.canDiscoverCapabilities(context.authInfo) ?? true;
  if (allowed) {
    server.registerTool(
      PIM_MEMORY_MCP_TOOL_NAMES[0],
      {
        title: "PIM memory capabilities",
        description: "Return the canonical PIM v2 memory capability model.",
        inputSchema: EmptyToolInput,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => {
        try {
          return jsonResult(await services.capabilities());
        } catch {
          // The protocol result must not expose service errors, which can carry
          // repository identifiers, token material, or infrastructure details.
          throw new Error(CAPABILITY_SERVICE_ERROR);
        }
      },
    );
  }

  const bindingAllowed = Boolean(services.binding)
    && (options.authorization?.canDiscoverBinding?.(context.authInfo) ?? true);
  if (bindingAllowed) {
    server.registerTool(
      PIM_MEMORY_MCP_TOOL_NAMES[1],
      {
        title: "PIM memory binding",
        description: "Return this service principal's non-secret effective memory binding.",
        inputSchema: EmptyToolInput,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => {
        try {
          return jsonResult(await services.binding!({ authInfo: context.authInfo }));
        } catch {
          throw new Error(BINDING_SERVICE_ERROR);
        }
      },
    );
  }

  const codeSearchAllowed = Boolean(services.codeSearch)
    && (options.authorization?.canDiscoverCodeSearch?.(context.authInfo) ?? true);
  if (codeSearchAllowed) {
    server.registerTool(
      PIM_MEMORY_MCP_TOOL_NAMES[2],
      {
        title: "PIM code memory search",
        description: "Search the one exact authenticated repository through canonical PIM v2.",
        inputSchema: CodeSearchToolInput,
        outputSchema: CodeSearchToolOutput,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (input) => {
        let parsed: MemoryMcpCodeSearchInputV2;
        try {
          parsed = parseMemoryContractV2("MemoryMcpCodeSearchInputV2", input);
        } catch (error) {
          return toolErrorResult(
            { code: "schema_invalid", issues: applicationErrorDetails(error) },
            { requestId: boundedRequestId(input), plane: "codebase" },
          );
        }
        try {
          const result = await services.codeSearch!(parsed, context);
          return jsonResult(parseMemoryContractV2("MemoryMcpCodeSearchOutputV2", result));
        } catch (error) {
          return toolErrorResult(error, { requestId: parsed.request_id, plane: "codebase" });
        }
      },
    );
  }

  const runReceiptSubmitAllowed = Boolean(services.runReceiptSubmit)
    && (options.authorization?.canDiscoverRunReceiptSubmit?.(context.authInfo) ?? true);
  if (runReceiptSubmitAllowed) {
    server.registerTool(
      PIM_MEMORY_MCP_TOOL_NAMES[3],
      {
        title: "PIM run receipt submit",
        description: "Submit one idempotent codebase or harness run receipt with bounded candidate proposals.",
        inputSchema: RunReceiptSubmitToolInput,
        outputSchema: RunReceiptSubmitToolOutput,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (input) => {
        const rawReceipt = isRecord(input) ? input.receipt : null;
        if (!isRecord(rawReceipt) || rawReceipt.schema_version !== "pim.run-receipt.v2") {
          return toolErrorResult(
            { code: "contract_version_unsupported" },
            { requestId: boundedRequestId(input), plane: rawMemoryPlane(rawReceipt) },
          );
        }
        let parsed: MemoryMcpRunReceiptSubmitInputV2;
        try {
          parsed = parseMemoryContractV2("MemoryMcpRunReceiptSubmitInputV2", input);
        } catch (error) {
          return toolErrorResult(
            { code: "schema_invalid", issues: applicationErrorDetails(error) },
            { requestId: boundedRequestId(input), plane: rawMemoryPlane(rawReceipt) },
          );
        }
        if (parsed.receipt.plane === "harness"
            && parsed.receipt.scope_snapshot.harness_id.length > 64) {
          return toolErrorResult(
            {
              code: "schema_invalid",
              issues: [{
                path: "/receipt/scope_snapshot/harness_id",
                reason: "canonical harness identifier limit is 64 characters",
              }],
            },
            { requestId: null, plane: "harness" },
          );
        }
        try {
          const result = await services.runReceiptSubmit!(parsed, context);
          return jsonResult(parseMemoryContractV2("MemoryMcpRunReceiptSubmitOutputV2", result));
        } catch (error) {
          return toolErrorResult(error, { requestId: null, plane: parsed.receipt.plane });
        }
      },
    );
  }

  const feedbackSubmitAllowed = Boolean(services.feedbackSubmit)
    && (options.authorization?.canDiscoverFeedbackSubmit?.(context.authInfo) ?? true);
  if (feedbackSubmitAllowed) {
    server.registerTool(
      PIM_MEMORY_MCP_TOOL_NAMES[4],
      {
        title: "PIM memory feedback submit",
        description: "Submit one idempotent, pack-bound memory feedback event.",
        inputSchema: FeedbackSubmitToolInput,
        outputSchema: FeedbackSubmitToolOutput,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (input) => {
        const rawFeedback = isRecord(input) ? input.feedback : null;
        if (!isRecord(rawFeedback) || rawFeedback.schema_version !== "pim.memory-feedback.v2") {
          return toolErrorResult(
            { code: "contract_version_unsupported" },
            { requestId: boundedRequestId(input), plane: rawMemoryPlane(rawFeedback) },
          );
        }
        let parsed: MemoryMcpFeedbackSubmitInputV2;
        try {
          parsed = parseMemoryContractV2("MemoryMcpFeedbackSubmitInputV2", input);
        } catch (error) {
          return toolErrorResult(
            { code: "schema_invalid", issues: applicationErrorDetails(error) },
            { requestId: boundedRequestId(input), plane: rawMemoryPlane(rawFeedback) },
          );
        }
        try {
          const result = await services.feedbackSubmit!(parsed, context);
          return jsonResult(parseMemoryContractV2("MemoryMcpFeedbackSubmitOutputV2", result));
        } catch (error) {
          return toolErrorResult(error, { requestId: null, plane: parsed.feedback.plane });
        }
      },
    );
  }

  const candidateStatusAllowed = Boolean(services.candidateStatus)
    && (options.authorization?.canDiscoverCandidateStatus?.(context.authInfo) ?? true);
  if (candidateStatusAllowed) {
    server.registerTool(
      PIM_MEMORY_MCP_TOOL_NAMES[5],
      {
        title: "PIM memory candidate status",
        description: "Read one exact codebase or producer-bound harness candidate status without enumeration.",
        inputSchema: CandidateStatusToolInput,
        outputSchema: CandidateStatusToolOutput,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (input) => {
        let parsed: MemoryMcpCandidateStatusInputV2;
        try {
          parsed = parseMemoryContractV2("MemoryMcpCandidateStatusInputV2", input);
        } catch (error) {
          return toolErrorResult(
            { code: "schema_invalid", issues: applicationErrorDetails(error) },
            { requestId: boundedRequestId(input), plane: rawMemoryPlane(input) },
          );
        }
        try {
          const result = await services.candidateStatus!(parsed, context);
          return jsonResult(parseMemoryContractV2("MemoryMcpCandidateStatusOutputV2", result));
        } catch (error) {
          return toolErrorResult(error, { requestId: null, plane: parsed.plane });
        }
      },
    );
  }

  const harnessSearchAllowed = Boolean(services.harnessSearch)
    && (options.authorization?.canDiscoverHarnessSearch?.(context.authInfo) ?? true);
  if (harnessSearchAllowed) {
    server.registerTool(
      PIM_MEMORY_MCP_TOOL_NAMES[6],
      {
        title: "PIM harness memory search",
        description: "Search the one exact authenticated harness through canonical PIM v2.",
        inputSchema: HarnessSearchToolInput,
        outputSchema: HarnessSearchToolOutput,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (input) => {
        if (!isRecord(input) || input.schema_version !== "pim.memory-search.v2") {
          return toolErrorResult(
            { code: "contract_version_unsupported" },
            { requestId: boundedRequestId(input), plane: "harness" },
          );
        }
        let parsed: MemoryMcpHarnessSearchInputV2;
        try {
          parsed = parseMemoryContractV2("MemoryMcpHarnessSearchInputV2", input);
        } catch (error) {
          return toolErrorResult(
            { code: "schema_invalid", issues: applicationErrorDetails(error) },
            { requestId: boundedRequestId(input), plane: "harness" },
          );
        }
        try {
          const result = await services.harnessSearch!(parsed, context);
          return jsonResult(parseMemoryContractV2("MemoryMcpHarnessSearchOutputV2", result));
        } catch (error) {
          return toolErrorResult(error, { requestId: parsed.request_id, plane: "harness" });
        }
      },
    );
  }

  const readinessAllowed = Boolean(services.readiness)
    && (options.authorization?.canDiscoverReadiness?.(context.authInfo) ?? true);
  if (readinessAllowed) {
    server.registerTool(
      PIM_MEMORY_MCP_TOOL_NAMES[7],
      {
        title: "PIM memory readiness",
        description: "Return bounded reverification and worker health for one exact authorized resource.",
        inputSchema: ReadinessToolInput,
        outputSchema: ReadinessToolOutput,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (input) => {
        let parsed: MemoryMcpReadinessInputV2;
        try {
          parsed = parseMemoryContractV2("MemoryMcpReadinessInputV2", input);
        } catch (error) {
          return toolErrorResult(
            { code: "schema_invalid", issues: applicationErrorDetails(error) },
            { requestId: null, plane: rawMemoryPlane(input) },
          );
        }
        try {
          const result = await services.readiness!(parsed, context);
          return jsonResult(parseMemoryContractV2("MemoryMcpReadinessOutputV2", result));
        } catch (error) {
          return toolErrorResult(error, { requestId: null, plane: parsed.plane });
        }
      },
    );
  }

  const recordResourceAllowed = Boolean(services.recordResource)
    && (options.authorization?.canDiscoverRecordResource?.(context.authInfo) ?? true);
  if (recordResourceAllowed) {
    server.registerResource(
      "pim_memory_record_version",
      new ResourceTemplate(PIM_MEMORY_MCP_RESOURCE_TEMPLATES[0], { list: undefined }),
      {
        title: "PIM immutable memory record version",
        description: "Read one immutable record version after fresh authorization.",
        mimeType: "application/json",
        cacheHint: { ttlMs: 0, cacheScope: "private" },
      },
      async (uri, variables) => {
        try {
          const ids = recordResourceIds(uri, variables);
          const result = await services.recordResource!(ids, context);
          return resourceResult(
            uri,
            parseMemoryContractV2("MemoryMcpRecordResourceResultV2", result),
          );
        } catch (error) {
          throw resourceProtocolError(error, { requestId: null, plane: null });
        }
      },
    );
  }

  const packResourceAllowed = Boolean(services.packResource)
    && (options.authorization?.canDiscoverPackResource?.(context.authInfo) ?? true);
  if (packResourceAllowed) {
    server.registerResource(
      "pim_memory_retrieval_pack",
      new ResourceTemplate(PIM_MEMORY_MCP_RESOURCE_TEMPLATES[1], { list: undefined }),
      {
        title: "PIM immutable retrieval pack",
        description: "Read one immutable retrieval pack after fresh authorization.",
        mimeType: "application/json",
        cacheHint: { ttlMs: 0, cacheScope: "private" },
      },
      async (uri, variables) => {
        try {
          const ids = packResourceIds(uri, variables);
          const result = await services.packResource!(ids, context);
          return resourceResult(
            uri,
            parseMemoryContractV2("MemoryMcpPackResourceResultV2", result),
          );
        } catch (error) {
          throw resourceProtocolError(error, { requestId: null, plane: null });
        }
      },
    );
  }

  return server;
}

/** Strict modern-only, stateless request handler used by development and /mcp/memory. */
export function createRestrictedMemoryMcpHandler(
  services: RestrictedMemoryMcpServices,
  options: RestrictedMemoryMcpOptions = {},
): McpHttpHandler {
  const handler = createMcpHandler(
    (context) => createRestrictedMemoryMcpServer(services, context, options),
    { legacy: "reject" },
  );
  const sdkFetch = handler.fetch;
  handler.fetch = async (request, requestOptions) => {
    if (request.method.toUpperCase() === "POST") {
      const missingHeader = REQUIRED_MODERN_HEADERS.find(
        (header) => !request.headers.get(header)?.trim(),
      );
      if (missingHeader) {
        return Response.json(
          {
            jsonrpc: "2.0",
            error: {
              code: -32020,
              message: `Bad Request: ${missingHeader} header is required`,
            },
            id: null,
          },
          { status: 400 },
        );
      }
    }
    return sdkFetch(request, requestOptions);
  };
  return handler;
}
