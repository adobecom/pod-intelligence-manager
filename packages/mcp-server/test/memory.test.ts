import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AuthInfo, McpHttpHandler } from "@modelcontextprotocol/server";
import { MEMORY_CONTRACT_FIXTURES_V2 } from "@pim/shared";
import {
  PIM_MEMORY_MCP_PROTOCOL_VERSION,
  PIM_MEMORY_MCP_RESOURCE_TEMPLATES,
  PIM_MEMORY_MCP_TOOL_NAMES,
  createRestrictedMemoryMcpHandler,
} from "../src/memory.js";

const clientMeta = {
  "io.modelcontextprotocol/protocolVersion": PIM_MEMORY_MCP_PROTOCOL_VERSION,
  "io.modelcontextprotocol/clientInfo": { name: "pim-memory-test", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

function modernHeaders(method: string, name: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "MCP-Protocol-Version": PIM_MEMORY_MCP_PROTOCOL_VERSION,
    "Mcp-Method": method,
    "Mcp-Name": name,
  };
}

function rpcRequest(
  method: string,
  name: string,
  params: Record<string, unknown>,
  headers: Record<string, string> = modernHeaders(method, name),
): Request {
  return new Request("http://localhost/mcp/memory", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: `${method}:${name}`, method, params }),
  });
}

function request(
  handler: McpHttpHandler,
  method: string,
  name: string,
  params: Record<string, unknown>,
  authInfo?: AuthInfo,
): Promise<Response> {
  return handler.fetch(rpcRequest(method, name, params), authInfo ? { authInfo } : undefined);
}

async function responseBody(response: Response): Promise<any> {
  return response.json() as Promise<any>;
}

function assertPrivateListResult(result: any): void {
  assert.equal(result.ttlMs, 0);
  assert.equal(result.cacheScope, "private");
}

function codeCandidateStatusInput(): Record<string, unknown> {
  return {
    plane: "codebase",
    resource_selector: { resource_row_id: "resource-repository-contract" },
    candidate_id: MEMORY_CONTRACT_FIXTURES_V2.MemoryCandidateStatusV2.candidate_id,
  };
}

function harnessReceiptSubmitInput(): Record<string, unknown> {
  const {
    tenant: _tenant,
    scope_snapshot: sourceScopeSnapshot,
    ...sourceReceipt
  } = MEMORY_CONTRACT_FIXTURES_V2.HarnessRunReceiptV2;
  const {
    resource_binding: _resourceBinding,
    ...scopeSnapshot
  } = sourceScopeSnapshot;
  return {
    idempotency_key: "mcp-harness-receipt-v2-contract-1",
    producer_run_id: sourceReceipt.producer.consumer_run_id,
    receipt: {
      ...sourceReceipt,
      scope_snapshot: scopeSnapshot,
    },
  };
}

function harnessRecordResult(): typeof MEMORY_CONTRACT_FIXTURES_V2.MemoryRecordV2 {
  const record = structuredClone(MEMORY_CONTRACT_FIXTURES_V2.MemoryRecordV2);
  const candidate = MEMORY_CONTRACT_FIXTURES_V2.HarnessRunReceiptV2.candidates[0]!;
  return {
    ...record,
    record_id: "memory-harness-v2-contract-1",
    plane: "harness",
    resource_binding: structuredClone(
      MEMORY_CONTRACT_FIXTURES_V2.HarnessScopeSnapshotV2.resource_binding,
    ),
    kind: candidate.kind,
    subkind: candidate.subkind,
    content: structuredClone(candidate.content),
    applicability: structuredClone(candidate.applicability),
    compatibility: {
      harness_version_range: candidate.applicability.harness_version_range,
      workflow_version_range: candidate.applicability.workflow_version_range,
      adapter_version_range: candidate.applicability.adapter_version_range,
    },
    exceptions: structuredClone(candidate.exceptions),
    validation: structuredClone(candidate.validation),
  } as typeof MEMORY_CONTRACT_FIXTURES_V2.MemoryRecordV2;
}

describe("restricted PIM memory MCP profile", () => {
  it("discovers only the final safe data-plane tools and URI-only private resources", async () => {
    const handler = createRestrictedMemoryMcpHandler({
      capabilities: () => MEMORY_CONTRACT_FIXTURES_V2.MemoryCapabilitiesV2,
      binding: () => MEMORY_CONTRACT_FIXTURES_V2.MemoryBindingV2,
      codeSearch: () => MEMORY_CONTRACT_FIXTURES_V2.MemorySearchResultV2,
      runReceiptSubmit: () => MEMORY_CONTRACT_FIXTURES_V2.RunReceiptResultV2,
      feedbackSubmit: () => MEMORY_CONTRACT_FIXTURES_V2.MemoryFeedbackResultV2,
      candidateStatus: () => MEMORY_CONTRACT_FIXTURES_V2.MemoryCandidateStatusV2,
      harnessSearch: () => MEMORY_CONTRACT_FIXTURES_V2.MemorySearchResultV2,
      readiness: () => MEMORY_CONTRACT_FIXTURES_V2.MemoryReadinessV2,
      recordResource: () => MEMORY_CONTRACT_FIXTURES_V2.MemoryRecordV2,
      packResource: () => MEMORY_CONTRACT_FIXTURES_V2.MemoryRetrievalPackV2,
    });
    try {
      const discovery = await request(
        handler,
        "server/discover",
        "pim-memory",
        { _meta: clientMeta },
      );
      assert.equal(discovery.status, 200);
      assert.equal(discovery.headers.get("mcp-session-id"), null);
      const discoveryBody = await responseBody(discovery);
      assert.deepEqual(discoveryBody.result.supportedVersions, [PIM_MEMORY_MCP_PROTOCOL_VERSION]);
      assert.deepEqual(discoveryBody.result.capabilities, {
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
      });
      assertPrivateListResult(discoveryBody.result);

      const toolsBody = await responseBody(await request(
        handler,
        "tools/list",
        "pim-memory",
        { _meta: clientMeta },
      ));
      assert.deepEqual(toolsBody.result.tools.map((tool: any) => tool.name), [
        ...PIM_MEMORY_MCP_TOOL_NAMES,
      ]);
      for (const tool of toolsBody.result.tools.slice(0, 2)) {
        assert.deepEqual(tool.inputSchema, {
          type: "object",
          additionalProperties: false,
          maxProperties: 0,
        });
      }
      const searchTool = toolsBody.result.tools[2];
      assert.equal(searchTool.inputSchema.type, "object");
      assert.equal(searchTool.inputSchema.additionalProperties, false);
      assert.deepEqual(searchTool.inputSchema.required, [
        "schema_version",
        "request_id",
        "consumer",
        "plane",
        "resource_selector",
        "applicability",
        "task",
        "temporal",
        "budget",
        "options",
      ]);
      assert.equal(searchTool.inputSchema.properties.plane.const, "codebase");
      assert.equal(searchTool.outputSchema.$ref, "#/$defs/MemorySearchResultV2");

      const receiptTool = toolsBody.result.tools[3];
      assert.deepEqual(receiptTool.inputSchema.required, [
        "idempotency_key",
        "producer_run_id",
        "receipt",
      ]);
      assert.equal(
        receiptTool.inputSchema.properties.receipt.$ref,
        "#/$defs/MemoryMcpRunReceiptV2",
      );
      assert.equal(receiptTool.outputSchema.$ref, "#/$defs/RunReceiptResultV2");

      const feedbackTool = toolsBody.result.tools[4];
      assert.deepEqual(feedbackTool.inputSchema.required, ["idempotency_key", "feedback"]);
      assert.equal(
        feedbackTool.inputSchema.properties.feedback.$ref,
        "#/$defs/MemoryFeedbackV2",
      );
      assert.equal(feedbackTool.outputSchema.$ref, "#/$defs/MemoryFeedbackResultV2");

      const candidateTool = toolsBody.result.tools[5];
      assert.deepEqual(candidateTool.inputSchema.oneOf, [
        { $ref: "#/$defs/MemoryMcpCodeCandidateStatusInputV2" },
        { $ref: "#/$defs/MemoryMcpHarnessCandidateStatusInputV2" },
      ]);
      assert.equal(candidateTool.outputSchema.$ref, "#/$defs/MemoryCandidateStatusV2");

      const harnessSearchTool = toolsBody.result.tools[6];
      assert.equal(harnessSearchTool.inputSchema.type, "object");
      assert.equal(harnessSearchTool.inputSchema.additionalProperties, false);
      assert.equal(harnessSearchTool.inputSchema.properties.plane.const, "harness");
      assert.equal(harnessSearchTool.outputSchema.$ref, "#/$defs/MemorySearchResultV2");

      const readinessTool = toolsBody.result.tools[7];
      assert.deepEqual(readinessTool.inputSchema.required, ["plane", "resource_selector"]);
      assert.equal(
        readinessTool.inputSchema.properties.plane.$ref,
        "#/$defs/MemoryImplementedPlaneV2",
      );
      assert.equal(readinessTool.outputSchema.$ref, "#/$defs/MemoryReadinessV2");
      assertPrivateListResult(toolsBody.result);

      const resourcesBody = await responseBody(await request(
        handler,
        "resources/list",
        "pim-memory",
        { _meta: clientMeta },
      ));
      assert.deepEqual(resourcesBody.result.resources, []);
      assertPrivateListResult(resourcesBody.result);

      const templatesBody = await responseBody(await request(
        handler,
        "resources/templates/list",
        "pim-memory",
        { _meta: clientMeta },
      ));
      assert.deepEqual(templatesBody.result.resourceTemplates.map((template: any) => (
        template.uriTemplate
      )), [
        ...PIM_MEMORY_MCP_RESOURCE_TEMPLATES,
      ]);
      assert.deepEqual(templatesBody.result.resourceTemplates.map((template: any) => (
        template.name
      )), ["pim_memory_record_version", "pim_memory_retrieval_pack"]);
      for (const template of templatesBody.result.resourceTemplates) {
        assert.equal(template.mimeType, "application/json");
      }
      assertPrivateListResult(templatesBody.result);

      for (const broadOperation of [
        "authenticate",
        "query_knowledge",
        "pim_candidate_review",
        "pim_candidate_activate",
        "pim_memory_admin",
        "pim_runtime_attestation_submit",
      ]) {
        const broadBody = await responseBody(await request(
          handler,
          "tools/call",
          broadOperation,
          { name: broadOperation, arguments: {}, _meta: clientMeta },
        ));
        assert.equal(broadBody.error.code, -32602);
      }
    } finally {
      await handler.close();
    }
  });

  it("delegates to the canonical callback and redacts service failures", async () => {
    let calls = 0;
    let bindingCalls = 0;
    const handler = createRestrictedMemoryMcpHandler({
      capabilities: () => {
        calls += 1;
        return MEMORY_CONTRACT_FIXTURES_V2.MemoryCapabilitiesV2;
      },
      binding: () => {
        bindingCalls += 1;
        return MEMORY_CONTRACT_FIXTURES_V2.MemoryBindingV2;
      },
    });
    try {
      const body = await responseBody(await request(
        handler,
        "tools/call",
        PIM_MEMORY_MCP_TOOL_NAMES[0],
        {
          name: PIM_MEMORY_MCP_TOOL_NAMES[0],
          arguments: {},
          _meta: clientMeta,
        },
      ));
      assert.equal(calls, 1);
      assert.deepEqual(
        body.result.structuredContent,
        MEMORY_CONTRACT_FIXTURES_V2.MemoryCapabilitiesV2,
      );
      assert.deepEqual(
        JSON.parse(body.result.content[0].text),
        MEMORY_CONTRACT_FIXTURES_V2.MemoryCapabilitiesV2,
      );

      const bindingBody = await responseBody(await request(
        handler,
        "tools/call",
        PIM_MEMORY_MCP_TOOL_NAMES[1],
        {
          name: PIM_MEMORY_MCP_TOOL_NAMES[1],
          arguments: {},
          _meta: clientMeta,
        },
      ));
      assert.equal(bindingCalls, 1);
      assert.deepEqual(
        bindingBody.result.structuredContent,
        MEMORY_CONTRACT_FIXTURES_V2.MemoryBindingV2,
      );
    } finally {
      await handler.close();
    }

    const secret = "service-token=must-not-leak";
    const failing = createRestrictedMemoryMcpHandler({
      capabilities: () => {
        throw new Error(secret);
      },
      binding: () => {
        throw new Error(secret);
      },
    });
    try {
      const body = await responseBody(await request(
        failing,
        "tools/call",
        PIM_MEMORY_MCP_TOOL_NAMES[0],
        {
          name: PIM_MEMORY_MCP_TOOL_NAMES[0],
          arguments: {},
          _meta: clientMeta,
        },
      ));
      assert.equal(body.result.isError, true);
      assert.match(body.result.content[0].text, /service unavailable/i);
      assert.doesNotMatch(JSON.stringify(body), new RegExp(secret));

      const bindingBody = await responseBody(await request(
        failing,
        "tools/call",
        PIM_MEMORY_MCP_TOOL_NAMES[1],
        {
          name: PIM_MEMORY_MCP_TOOL_NAMES[1],
          arguments: {},
          _meta: clientMeta,
        },
      ));
      assert.equal(bindingBody.result.isError, true);
      assert.match(bindingBody.result.content[0].text, /service unavailable/i);
      assert.doesNotMatch(JSON.stringify(bindingBody), new RegExp(secret));
    } finally {
      await failing.close();
    }
  });

  it("validates generated code-search input and delegates with authenticated context", async () => {
    const authInfo: AuthInfo = {
      token: "search-token-must-not-leak",
      clientId: "search-client",
      scopes: ["memory:search"],
    };
    let receivedInput: unknown;
    let receivedClientId: string | undefined;
    let calls = 0;
    const handler = createRestrictedMemoryMcpHandler({
      capabilities: () => MEMORY_CONTRACT_FIXTURES_V2.MemoryCapabilitiesV2,
      codeSearch: (input, context) => {
        calls += 1;
        receivedInput = input;
        receivedClientId = context.authInfo?.clientId;
        return MEMORY_CONTRACT_FIXTURES_V2.MemorySearchResultV2;
      },
    });
    try {
      const body = await responseBody(await request(
        handler,
        "tools/call",
        PIM_MEMORY_MCP_TOOL_NAMES[2],
        {
          name: PIM_MEMORY_MCP_TOOL_NAMES[2],
          arguments: MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpCodeSearchInputV2,
          _meta: clientMeta,
        },
        authInfo,
      ));
      assert.equal(calls, 1);
      assert.deepEqual(receivedInput, MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpCodeSearchInputV2);
      assert.equal(receivedClientId, "search-client");
      assert.deepEqual(
        body.result.structuredContent,
        MEMORY_CONTRACT_FIXTURES_V2.MemorySearchResultV2,
      );
      assert.deepEqual(
        JSON.parse(body.result.content[0].text),
        MEMORY_CONTRACT_FIXTURES_V2.MemorySearchResultV2,
      );
      assert.doesNotMatch(JSON.stringify(body), /search-token-must-not-leak/);

      const invalidSecret = "invalid-search-field-must-not-leak";
      const invalid = await responseBody(await request(
        handler,
        "tools/call",
        PIM_MEMORY_MCP_TOOL_NAMES[2],
        {
          name: PIM_MEMORY_MCP_TOOL_NAMES[2],
          arguments: {
            ...MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpCodeSearchInputV2,
            unexpected: invalidSecret,
          },
          _meta: clientMeta,
        },
        authInfo,
      ));
      assert.equal(invalid.result.isError, true);
      assert.equal(invalid.result.structuredContent.code, "schema_invalid");
      assert.deepEqual(invalid.result.structuredContent.details, [{
        path: "/unexpected",
        reason: "unknown field",
      }]);
      assert.equal(
        invalid.result.structuredContent.request_id,
        MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpCodeSearchInputV2.request_id,
      );
      assert.equal(calls, 1);
      assert.doesNotMatch(JSON.stringify(invalid), new RegExp(invalidSecret));

      const wrongPlane = await responseBody(await request(
        handler,
        "tools/call",
        PIM_MEMORY_MCP_TOOL_NAMES[2],
        {
          name: PIM_MEMORY_MCP_TOOL_NAMES[2],
          arguments: {
            ...MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpCodeSearchInputV2,
            plane: "harness",
          },
          _meta: clientMeta,
        },
        authInfo,
      ));
      assert.equal(wrongPlane.result.isError, true);
      assert.equal(wrongPlane.result.structuredContent.code, "schema_invalid");
      assert.equal(calls, 1);
    } finally {
      await handler.close();
    }
  });

  it("validates generated harness-search input without crossing code selectors", async () => {
    const authInfo: AuthInfo = {
      token: "harness-search-token-must-not-leak",
      clientId: "harness-search-client",
      scopes: ["memory:harness:search"],
    };
    let calls = 0;
    let receivedInput: unknown;
    const harnessResult = {
      ...structuredClone(MEMORY_CONTRACT_FIXTURES_V2.MemorySearchResultV2),
      request_id: MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpHarnessSearchInputV2.request_id,
      plane: "harness",
      resource_binding: structuredClone(
        MEMORY_CONTRACT_FIXTURES_V2.HarnessScopeSnapshotV2.resource_binding,
      ),
      scope_snapshot_digest:
        MEMORY_CONTRACT_FIXTURES_V2.HarnessScopeSnapshotV2.scope_snapshot_digest,
      policy_version: "retrieval-harness-v2",
      items: [],
      token_count: 0,
    };
    const handler = createRestrictedMemoryMcpHandler({
      capabilities: () => MEMORY_CONTRACT_FIXTURES_V2.MemoryCapabilitiesV2,
      harnessSearch: (input, context) => {
        calls += 1;
        receivedInput = input;
        assert.equal(context.authInfo?.clientId, "harness-search-client");
        return harnessResult;
      },
    });
    try {
      const result = await responseBody(await request(
        handler,
        "tools/call",
        PIM_MEMORY_MCP_TOOL_NAMES[6],
        {
          name: PIM_MEMORY_MCP_TOOL_NAMES[6],
          arguments: MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpHarnessSearchInputV2,
          _meta: clientMeta,
        },
        authInfo,
      ));
      assert.equal(calls, 1);
      assert.deepEqual(receivedInput, MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpHarnessSearchInputV2);
      assert.deepEqual(result.result.structuredContent, harnessResult);
      assert.doesNotMatch(JSON.stringify(result), /harness-search-token-must-not-leak/);

      const codeSelector = await responseBody(await request(
        handler,
        "tools/call",
        PIM_MEMORY_MCP_TOOL_NAMES[6],
        {
          name: PIM_MEMORY_MCP_TOOL_NAMES[6],
          arguments: MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpCodeSearchInputV2,
          _meta: clientMeta,
        },
        authInfo,
      ));
      assert.equal(codeSelector.result.isError, true);
      assert.equal(codeSelector.result.structuredContent.code, "schema_invalid");
      assert.equal(codeSelector.result.structuredContent.plane, "harness");
      assert.equal(calls, 1);

      const wrongVersion = await responseBody(await request(
        handler,
        "tools/call",
        PIM_MEMORY_MCP_TOOL_NAMES[6],
        {
          name: PIM_MEMORY_MCP_TOOL_NAMES[6],
          arguments: {
            ...MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpHarnessSearchInputV2,
            schema_version: "pim.memory-search.v1",
          },
          _meta: clientMeta,
        },
        authInfo,
      ));
      assert.equal(wrongVersion.result.isError, true);
      assert.equal(
        wrongVersion.result.structuredContent.code,
        "contract_version_unsupported",
      );
      assert.equal(wrongVersion.result.structuredContent.plane, "harness");
      assert.equal(calls, 1);
    } finally {
      await handler.close();
    }
  });

  it("validates and delegates bounded readiness while redacting every failure", async () => {
    const authInfo: AuthInfo = {
      token: "readiness-token-must-not-leak",
      clientId: "readiness-client",
      scopes: ["memory:harness:search"],
    };
    let calls = 0;
    let receivedInput: unknown;
    const handler = createRestrictedMemoryMcpHandler({
      capabilities: () => MEMORY_CONTRACT_FIXTURES_V2.MemoryCapabilitiesV2,
      readiness: (input, context) => {
        calls += 1;
        receivedInput = input;
        assert.equal(context.authInfo?.clientId, "readiness-client");
        return MEMORY_CONTRACT_FIXTURES_V2.MemoryReadinessV2;
      },
    });
    try {
      const response = await responseBody(await request(
        handler,
        "tools/call",
        PIM_MEMORY_MCP_TOOL_NAMES[7],
        {
          name: PIM_MEMORY_MCP_TOOL_NAMES[7],
          arguments: MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpReadinessInputV2,
          _meta: clientMeta,
        },
        authInfo,
      ));
      assert.equal(calls, 1);
      assert.deepEqual(receivedInput, MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpReadinessInputV2);
      assert.deepEqual(
        response.result.structuredContent,
        MEMORY_CONTRACT_FIXTURES_V2.MemoryReadinessV2,
      );
      assert.doesNotMatch(JSON.stringify(response), /readiness-token-must-not-leak/);

      const invalidSecret = "readiness-selector-secret-must-not-leak";
      const invalid = await responseBody(await request(
        handler,
        "tools/call",
        PIM_MEMORY_MCP_TOOL_NAMES[7],
        {
          name: PIM_MEMORY_MCP_TOOL_NAMES[7],
          arguments: {
            ...MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpReadinessInputV2,
            unexpected: invalidSecret,
          },
          _meta: clientMeta,
        },
        authInfo,
      ));
      assert.equal(invalid.result.isError, true);
      assert.equal(invalid.result.structuredContent.code, "schema_invalid");
      assert.equal(invalid.result.structuredContent.plane, "harness");
      assert.deepEqual(invalid.result.structuredContent.details, [{
        path: "/unexpected",
        reason: "unknown field",
      }]);
      assert.equal(calls, 1);
      assert.doesNotMatch(JSON.stringify(invalid), new RegExp(invalidSecret));
    } finally {
      await handler.close();
    }

    const serviceSecret = "readiness-service-secret-must-not-leak";
    const failing = createRestrictedMemoryMcpHandler({
      capabilities: () => MEMORY_CONTRACT_FIXTURES_V2.MemoryCapabilitiesV2,
      readiness: () => {
        throw new Error(serviceSecret);
      },
    });
    try {
      const failure = await responseBody(await request(
        failing,
        "tools/call",
        PIM_MEMORY_MCP_TOOL_NAMES[7],
        {
          name: PIM_MEMORY_MCP_TOOL_NAMES[7],
          arguments: MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpReadinessInputV2,
          _meta: clientMeta,
        },
        authInfo,
      ));
      assert.equal(failure.result.isError, true);
      assert.equal(failure.result.structuredContent.code, "temporarily_unavailable");
      assert.equal(failure.result.structuredContent.retryable, true);
      assert.deepEqual(failure.result.structuredContent.details, []);
      assert.doesNotMatch(JSON.stringify(failure), new RegExp(serviceSecret));
    } finally {
      await failing.close();
    }
  });

  it("validates and delegates code and harness receipt/status while keeping harness feedback closed", async () => {
    const authInfo: AuthInfo = {
      token: "slice-3-token-must-not-leak",
      clientId: "slice-3-client",
      scopes: ["memory:receipt:write", "memory:feedback:write", "memory:candidate:read"],
    };
    const received: Array<{ tool: string; input: unknown; clientId: string | undefined }> = [];
    let receiptCalls = 0;
    let feedbackCalls = 0;
    let candidateCalls = 0;
    const handler = createRestrictedMemoryMcpHandler({
      capabilities: () => MEMORY_CONTRACT_FIXTURES_V2.MemoryCapabilitiesV2,
      runReceiptSubmit: (input, context) => {
        receiptCalls += 1;
        received.push({ tool: "receipt", input, clientId: context.authInfo?.clientId });
        return MEMORY_CONTRACT_FIXTURES_V2.RunReceiptResultV2;
      },
      feedbackSubmit: (input, context) => {
        feedbackCalls += 1;
        received.push({ tool: "feedback", input, clientId: context.authInfo?.clientId });
        return MEMORY_CONTRACT_FIXTURES_V2.MemoryFeedbackResultV2;
      },
      candidateStatus: (input, context) => {
        candidateCalls += 1;
        received.push({ tool: "candidate", input, clientId: context.authInfo?.clientId });
        if (input.candidate_id === "missing-candidate") {
          throw Object.assign(new Error("candidate-store-secret-must-not-leak"), {
            code: "resource_not_found",
          });
        }
        return MEMORY_CONTRACT_FIXTURES_V2.MemoryCandidateStatusV2;
      },
    });
    try {
      const receiptInput = MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpRunReceiptSubmitInputV2;
      const receipt = await responseBody(await request(
        handler,
        "tools/call",
        PIM_MEMORY_MCP_TOOL_NAMES[3],
        {
          name: PIM_MEMORY_MCP_TOOL_NAMES[3],
          arguments: receiptInput,
          _meta: clientMeta,
        },
        authInfo,
      ));
      assert.deepEqual(receipt.result.structuredContent, MEMORY_CONTRACT_FIXTURES_V2.RunReceiptResultV2);

      const feedbackInput = MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpFeedbackSubmitInputV2;
      const feedback = await responseBody(await request(
        handler,
        "tools/call",
        PIM_MEMORY_MCP_TOOL_NAMES[4],
        {
          name: PIM_MEMORY_MCP_TOOL_NAMES[4],
          arguments: feedbackInput,
          _meta: clientMeta,
        },
        authInfo,
      ));
      assert.deepEqual(feedback.result.structuredContent, MEMORY_CONTRACT_FIXTURES_V2.MemoryFeedbackResultV2);

      const candidateInput = codeCandidateStatusInput();
      const candidate = await responseBody(await request(
        handler,
        "tools/call",
        PIM_MEMORY_MCP_TOOL_NAMES[5],
        {
          name: PIM_MEMORY_MCP_TOOL_NAMES[5],
          arguments: candidateInput,
          _meta: clientMeta,
        },
        authInfo,
      ));
      assert.deepEqual(candidate.result.structuredContent, MEMORY_CONTRACT_FIXTURES_V2.MemoryCandidateStatusV2);
      assert.deepEqual(received, [
        { tool: "receipt", input: receiptInput, clientId: "slice-3-client" },
        { tool: "feedback", input: feedbackInput, clientId: "slice-3-client" },
        { tool: "candidate", input: candidateInput, clientId: "slice-3-client" },
      ]);
      assert.doesNotMatch(JSON.stringify({ receipt, feedback, candidate }), /slice-3-token-must-not-leak/);

      const missingCandidate = await responseBody(await request(
        handler,
        "tools/call",
        PIM_MEMORY_MCP_TOOL_NAMES[5],
        {
          name: PIM_MEMORY_MCP_TOOL_NAMES[5],
          arguments: { ...candidateInput, candidate_id: "missing-candidate" },
          _meta: clientMeta,
        },
        authInfo,
      ));
      assert.deepEqual(missingCandidate.result.structuredContent, {
        schema_version: "pim.error.v2",
        code: "resource_not_found",
        message: "The memory resource was not found",
        request_id: null,
        plane: "codebase",
        retryable: false,
        details: [],
      });
      assert.equal(missingCandidate.result.isError, true);
      assert.doesNotMatch(JSON.stringify(missingCandidate), /candidate-store-secret-must-not-leak/);

      const unknownSecret = "slice-3-unknown-field-must-not-leak";
      for (const invalidCall of [
        {
          name: PIM_MEMORY_MCP_TOOL_NAMES[3],
          arguments: { ...receiptInput, unexpected: unknownSecret },
        },
        {
          name: PIM_MEMORY_MCP_TOOL_NAMES[4],
          arguments: { ...feedbackInput, unexpected: unknownSecret },
        },
        {
          name: PIM_MEMORY_MCP_TOOL_NAMES[5],
          arguments: { ...candidateInput, unexpected: unknownSecret },
        },
      ]) {
        const invalid = await responseBody(await request(
          handler,
          "tools/call",
          invalidCall.name,
          { ...invalidCall, _meta: clientMeta },
          authInfo,
        ));
        assert.equal(invalid.result.isError, true);
        assert.equal(invalid.result.structuredContent.code, "schema_invalid");
        assert.ok(invalid.result.structuredContent.details.length <= 64);
        assert.doesNotMatch(JSON.stringify(invalid), new RegExp(unknownSecret));
      }
      assert.deepEqual([receiptCalls, feedbackCalls, candidateCalls], [1, 1, 2]);

      for (const wrongVersionCall of [
        {
          name: PIM_MEMORY_MCP_TOOL_NAMES[3],
          arguments: {
            ...receiptInput,
            receipt: { ...receiptInput.receipt, schema_version: "pim.run-receipt.v1" },
          },
        },
        {
          name: PIM_MEMORY_MCP_TOOL_NAMES[4],
          arguments: {
            ...feedbackInput,
            feedback: { ...feedbackInput.feedback, schema_version: "pim.memory-feedback.v1" },
          },
        },
      ]) {
        const wrongVersion = await responseBody(await request(
          handler,
          "tools/call",
          wrongVersionCall.name,
          { ...wrongVersionCall, _meta: clientMeta },
          authInfo,
        ));
        assert.equal(wrongVersion.result.isError, true);
        assert.equal(
          wrongVersion.result.structuredContent.code,
          "contract_version_unsupported",
        );
        assert.equal(wrongVersion.result.structuredContent.plane, "codebase");
      }
      assert.deepEqual([receiptCalls, feedbackCalls, candidateCalls], [1, 1, 2]);

      const harnessReceiptInput = harnessReceiptSubmitInput();
      const harnessReceipt = await responseBody(await request(
        handler,
        "tools/call",
        PIM_MEMORY_MCP_TOOL_NAMES[3],
        {
          name: PIM_MEMORY_MCP_TOOL_NAMES[3],
          arguments: harnessReceiptInput,
          _meta: clientMeta,
        },
        authInfo,
      ));
      assert.deepEqual(
        harnessReceipt.result.structuredContent,
        MEMORY_CONTRACT_FIXTURES_V2.RunReceiptResultV2,
      );

      const harnessStatusInput = MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpCandidateStatusInputV2;
      const harnessStatus = await responseBody(await request(
        handler,
        "tools/call",
        PIM_MEMORY_MCP_TOOL_NAMES[5],
        {
          name: PIM_MEMORY_MCP_TOOL_NAMES[5],
          arguments: harnessStatusInput,
          _meta: clientMeta,
        },
        authInfo,
      ));
      assert.deepEqual(
        harnessStatus.result.structuredContent,
        MEMORY_CONTRACT_FIXTURES_V2.MemoryCandidateStatusV2,
      );
      assert.deepEqual(received.slice(-2), [
        { tool: "receipt", input: harnessReceiptInput, clientId: "slice-3-client" },
        { tool: "candidate", input: harnessStatusInput, clientId: "slice-3-client" },
      ]);
      assert.deepEqual([receiptCalls, candidateCalls], [2, 3]);

      const oversizedHarnessIdInput = structuredClone(harnessReceiptInput) as any;
      oversizedHarnessIdInput.receipt.scope_snapshot.harness_id = "h".repeat(65);
      const oversizedHarnessId = await responseBody(await request(
        handler,
        "tools/call",
        PIM_MEMORY_MCP_TOOL_NAMES[3],
        {
          name: PIM_MEMORY_MCP_TOOL_NAMES[3],
          arguments: oversizedHarnessIdInput,
          _meta: clientMeta,
        },
        authInfo,
      ));
      assert.equal(oversizedHarnessId.result.isError, true);
      assert.equal(oversizedHarnessId.result.structuredContent.code, "schema_invalid");
      assert.equal(oversizedHarnessId.result.structuredContent.plane, "harness");
      assert.deepEqual(oversizedHarnessId.result.structuredContent.details, [{
        path: "/receipt/scope_snapshot/harness_id",
        reason: "canonical harness identifier limit is 64 characters",
      }]);
      assert.equal(receiptCalls, 2);

      const wrongHarnessVersionInput = structuredClone(harnessReceiptInput) as any;
      wrongHarnessVersionInput.receipt.schema_version = "pim.run-receipt.v1";
      const wrongHarnessVersion = await responseBody(await request(
        handler,
        "tools/call",
        PIM_MEMORY_MCP_TOOL_NAMES[3],
        {
          name: PIM_MEMORY_MCP_TOOL_NAMES[3],
          arguments: wrongHarnessVersionInput,
          _meta: clientMeta,
        },
        authInfo,
      ));
      assert.equal(wrongHarnessVersion.result.isError, true);
      assert.equal(
        wrongHarnessVersion.result.structuredContent.code,
        "contract_version_unsupported",
      );
      assert.equal(wrongHarnessVersion.result.structuredContent.plane, "harness");
      assert.equal(receiptCalls, 2);

      const authoritySecret = "caller-authority-field-must-not-leak";
      const harnessReceiptWithAuthority = structuredClone(harnessReceiptInput) as any;
      harnessReceiptWithAuthority.receipt.tenant = { project_id: authoritySecret };
      harnessReceiptWithAuthority.receipt.scope_snapshot.resource_binding = {
        resource_row_id: authoritySecret,
      };
      const invalidAuthorityReceipt = await responseBody(await request(
        handler,
        "tools/call",
        PIM_MEMORY_MCP_TOOL_NAMES[3],
        {
          name: PIM_MEMORY_MCP_TOOL_NAMES[3],
          arguments: harnessReceiptWithAuthority,
          _meta: clientMeta,
        },
        authInfo,
      ));
      assert.equal(invalidAuthorityReceipt.result.isError, true);
      assert.equal(invalidAuthorityReceipt.result.structuredContent.code, "schema_invalid");
      assert.equal(invalidAuthorityReceipt.result.structuredContent.plane, "harness");
      assert.doesNotMatch(JSON.stringify(invalidAuthorityReceipt), new RegExp(authoritySecret));

      const malformedStatusSecret = "malformed-harness-status-must-not-leak";
      const malformedHarnessStatus = await responseBody(await request(
        handler,
        "tools/call",
        PIM_MEMORY_MCP_TOOL_NAMES[5],
        {
          name: PIM_MEMORY_MCP_TOOL_NAMES[5],
          arguments: {
            ...harnessStatusInput,
            receipt_id: "",
            unexpected: malformedStatusSecret,
          },
          _meta: clientMeta,
        },
        authInfo,
      ));
      assert.equal(malformedHarnessStatus.result.isError, true);
      assert.equal(malformedHarnessStatus.result.structuredContent.code, "schema_invalid");
      assert.equal(malformedHarnessStatus.result.structuredContent.plane, "harness");
      assert.ok(malformedHarnessStatus.result.structuredContent.details.length <= 64);
      assert.doesNotMatch(
        JSON.stringify(malformedHarnessStatus),
        new RegExp(malformedStatusSecret),
      );

      const harnessFeedbackInput = structuredClone(feedbackInput) as any;
      harnessFeedbackInput.feedback.plane = "harness";
      const closedHarnessFeedback = await responseBody(await request(
        handler,
        "tools/call",
        PIM_MEMORY_MCP_TOOL_NAMES[4],
        {
          name: PIM_MEMORY_MCP_TOOL_NAMES[4],
          arguments: harnessFeedbackInput,
          _meta: clientMeta,
        },
        authInfo,
      ));
      assert.equal(closedHarnessFeedback.result.isError, true);
      assert.equal(closedHarnessFeedback.result.structuredContent.code, "schema_invalid");
      assert.equal(closedHarnessFeedback.result.structuredContent.plane, "harness");
      assert.equal(feedbackCalls, 1);
    } finally {
      await handler.close();
    }
  });

  it("maps application and generic search failures to bounded redacted PimErrorV2", async () => {
    const knownSecret = "known-search-failure-must-not-leak";
    const genericSecret = "generic-search-failure-must-not-leak";
    const handler = createRestrictedMemoryMcpHandler({
      capabilities: () => MEMORY_CONTRACT_FIXTURES_V2.MemoryCapabilitiesV2,
      codeSearch: (input) => {
        if (input.request_id === "generic-failure") throw new Error(genericSecret);
        throw Object.assign(new Error(knownSecret), {
          code: "resource_binding_mismatch",
          details: [{ path: "/resource_selector", reason: "exact binding required" }],
        });
      },
    });
    try {
      const known = await responseBody(await request(
        handler,
        "tools/call",
        PIM_MEMORY_MCP_TOOL_NAMES[2],
        {
          name: PIM_MEMORY_MCP_TOOL_NAMES[2],
          arguments: MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpCodeSearchInputV2,
          _meta: clientMeta,
        },
      ));
      assert.equal(known.result.isError, true);
      assert.deepEqual(known.result.structuredContent, {
        schema_version: "pim.error.v2",
        code: "resource_binding_mismatch",
        message: "The memory resource binding does not match",
        request_id: MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpCodeSearchInputV2.request_id,
        plane: "codebase",
        retryable: false,
        details: [{ path: "/resource_selector", reason: "exact binding required" }],
      });
      assert.deepEqual(
        JSON.parse(known.result.content[0].text),
        known.result.structuredContent,
      );

      const generic = await responseBody(await request(
        handler,
        "tools/call",
        PIM_MEMORY_MCP_TOOL_NAMES[2],
        {
          name: PIM_MEMORY_MCP_TOOL_NAMES[2],
          arguments: {
            ...MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpCodeSearchInputV2,
            request_id: "generic-failure",
          },
          _meta: clientMeta,
        },
      ));
      assert.equal(generic.result.isError, true);
      assert.deepEqual(generic.result.structuredContent, {
        schema_version: "pim.error.v2",
        code: "temporarily_unavailable",
        message: "Memory service is temporarily unavailable",
        request_id: "generic-failure",
        plane: "codebase",
        retryable: true,
        details: [],
      });
      assert.doesNotMatch(
        JSON.stringify({ known, generic }),
        /known-search-failure-must-not-leak|generic-search-failure-must-not-leak/,
      );
    } finally {
      await handler.close();
    }
  });

  it("reads exact URI-only record and pack resources without enumeration", async () => {
    const authInfo: AuthInfo = {
      token: "resource-token-must-not-leak",
      clientId: "resource-client",
      scopes: ["memory:search"],
    };
    const recordCalls: unknown[] = [];
    const packCalls: unknown[] = [];
    const handler = createRestrictedMemoryMcpHandler({
      capabilities: () => MEMORY_CONTRACT_FIXTURES_V2.MemoryCapabilitiesV2,
      recordResource: (ids, context) => {
        recordCalls.push({ ids, clientId: context.authInfo?.clientId });
        if (ids.recordId === "code-error") {
          throw Object.assign(new Error("code-resource-secret-must-not-leak"), {
            code: "resource_binding_mismatch",
            plane: "codebase",
          });
        }
        if (ids.recordId === "harness-error") {
          throw Object.assign(new Error("harness-resource-secret-must-not-leak"), {
            code: "resource_binding_mismatch",
            plane: "harness",
          });
        }
        if (ids.recordId === "opaque-error") {
          throw new Error("opaque-resource-secret-must-not-leak");
        }
        return ids.recordId === "record:harness"
          ? harnessRecordResult()
          : MEMORY_CONTRACT_FIXTURES_V2.MemoryRecordV2;
      },
      packResource: (ids, context) => {
        packCalls.push({ ids, clientId: context.authInfo?.clientId });
        if (ids.packId === "missing-pack") {
          throw Object.assign(new Error("resource-db-secret-must-not-leak"), {
            code: "resource_not_found",
          });
        }
        return MEMORY_CONTRACT_FIXTURES_V2.MemoryRetrievalPackV2;
      },
    });
    try {
      const listed = await responseBody(await request(
        handler,
        "resources/list",
        "pim-memory",
        { _meta: clientMeta },
        authInfo,
      ));
      assert.deepEqual(listed.result.resources, []);

      const recordUri = "pim-memory://records/record%3Aone/versions/7";
      const recordBody = await responseBody(await request(
        handler,
        "resources/read",
        recordUri,
        { uri: recordUri, _meta: clientMeta },
        authInfo,
      ));
      assert.deepEqual(recordCalls, [{
        ids: { recordId: "record:one", recordVersion: 7 },
        clientId: "resource-client",
      }]);
      assert.deepEqual(
        JSON.parse(recordBody.result.contents[0].text),
        MEMORY_CONTRACT_FIXTURES_V2.MemoryRecordV2,
      );
      assertPrivateListResult(recordBody.result);

      const harnessRecordUri = "pim-memory://records/record%3Aharness/versions/1";
      const harnessRecordBody = await responseBody(await request(
        handler,
        "resources/read",
        harnessRecordUri,
        { uri: harnessRecordUri, _meta: clientMeta },
        { ...authInfo, scopes: ["memory:harness:search"] },
      ));
      assert.deepEqual(recordCalls[1], {
        ids: { recordId: "record:harness", recordVersion: 1 },
        clientId: "resource-client",
      });
      assert.deepEqual(
        JSON.parse(harnessRecordBody.result.contents[0].text),
        harnessRecordResult(),
      );
      assertPrivateListResult(harnessRecordBody.result);

      for (const [recordId, expectedPlane] of [
        ["code-error", "codebase"],
        ["harness-error", "harness"],
      ] as const) {
        const errorUri = `pim-memory://records/${recordId}/versions/1`;
        const knownPlaneError = await responseBody(await request(
          handler,
          "resources/read",
          errorUri,
          { uri: errorUri, _meta: clientMeta },
          authInfo,
        ));
        assert.equal(knownPlaneError.error.code, -32602);
        assert.deepEqual(knownPlaneError.error.data, {
          schema_version: "pim.error.v2",
          code: "resource_binding_mismatch",
          message: "The memory resource binding does not match",
          request_id: null,
          plane: expectedPlane,
          retryable: false,
          details: [],
        });
      }

      const opaqueUri = "pim-memory://records/opaque-error/versions/1";
      const opaque = await responseBody(await request(
        handler,
        "resources/read",
        opaqueUri,
        { uri: opaqueUri, _meta: clientMeta },
        authInfo,
      ));
      assert.equal(opaque.error.code, -32603);
      assert.deepEqual(opaque.error.data, {
        schema_version: "pim.error.v2",
        code: "temporarily_unavailable",
        message: "Memory service is temporarily unavailable",
        request_id: null,
        plane: null,
        retryable: true,
        details: [],
      });
      assert.doesNotMatch(
        JSON.stringify(opaque),
        /opaque-resource-secret-must-not-leak|codebase|harness/,
      );

      const packUri = "pim-memory://packs/pack-v2-contract-1";
      const packBody = await responseBody(await request(
        handler,
        "resources/read",
        packUri,
        { uri: packUri, _meta: clientMeta },
        authInfo,
      ));
      assert.deepEqual(packCalls[0], {
        ids: { packId: "pack-v2-contract-1" },
        clientId: "resource-client",
      });
      assert.deepEqual(
        JSON.parse(packBody.result.contents[0].text),
        MEMORY_CONTRACT_FIXTURES_V2.MemoryRetrievalPackV2,
      );
      assertPrivateListResult(packBody.result);
      assert.doesNotMatch(
        JSON.stringify({ recordBody, packBody }),
        /resource-token-must-not-leak/,
      );

      const missingUri = "pim-memory://packs/missing-pack";
      const missing = await responseBody(await request(
        handler,
        "resources/read",
        missingUri,
        { uri: missingUri, _meta: clientMeta },
        authInfo,
      ));
      assert.equal(missing.error.code, -32602);
      assert.deepEqual(missing.error.data, {
        schema_version: "pim.error.v2",
        code: "resource_not_found",
        message: "The memory resource was not found",
        request_id: null,
        plane: null,
        retryable: false,
        details: [],
      });
      assert.doesNotMatch(JSON.stringify(missing), /resource-db-secret-must-not-leak/);

      const invalidUri = "pim-memory://records/record-one/versions/0";
      const invalid = await responseBody(await request(
        handler,
        "resources/read",
        invalidUri,
        { uri: invalidUri, _meta: clientMeta },
        authInfo,
      ));
      assert.equal(invalid.error.code, -32602);
      assert.equal(invalid.error.data.code, "schema_invalid");
      assert.equal(invalid.error.data.plane, null);
      assert.equal(recordCalls.length, 5);

      const queryUri = "pim-memory://packs/pack-v2-contract-1?unexpected=1";
      const withQuery = await responseBody(await request(
        handler,
        "resources/read",
        queryUri,
        { uri: queryUri, _meta: clientMeta },
        authInfo,
      ));
      assert.equal(withQuery.error.code, -32602);
      assert.equal(withQuery.error.data.code, "schema_invalid");
      assert.equal(packCalls.length, 2);
    } finally {
      await handler.close();
    }
  });

  it("rejects missing headers, invalid client metadata, unknown input, and legacy traffic", async () => {
    let calls = 0;
    const handler = createRestrictedMemoryMcpHandler({
      capabilities: () => {
        calls += 1;
        return MEMORY_CONTRACT_FIXTURES_V2.MemoryCapabilitiesV2;
      },
      binding: () => MEMORY_CONTRACT_FIXTURES_V2.MemoryBindingV2,
    });
    try {
      for (const requiredHeader of [
        "MCP-Protocol-Version",
        "Mcp-Method",
        "Mcp-Name",
      ]) {
        const headers = modernHeaders("tools/list", "pim-memory");
        delete headers[requiredHeader];
        const response = await handler.fetch(rpcRequest(
          "tools/list",
          "pim-memory",
          { _meta: clientMeta },
          headers,
        ));
        assert.equal(response.status, 400, requiredHeader);
      }

      const methodMismatch = await handler.fetch(rpcRequest(
        "tools/list",
        "pim-memory",
        { _meta: clientMeta },
        modernHeaders("server/discover", "pim-memory"),
      ));
      assert.equal(methodMismatch.status, 400);

      const nameMismatch = await handler.fetch(rpcRequest(
        "tools/call",
        PIM_MEMORY_MCP_TOOL_NAMES[0],
        {
          name: PIM_MEMORY_MCP_TOOL_NAMES[0],
          arguments: {},
          _meta: clientMeta,
        },
        modernHeaders("tools/call", "query_knowledge"),
      ));
      assert.equal(nameMismatch.status, 400);

      const invalidMetadata: Record<string, unknown>[] = [
        {},
        {
          ...clientMeta,
          "io.modelcontextprotocol/protocolVersion": undefined,
        },
        {
          ...clientMeta,
          "io.modelcontextprotocol/clientCapabilities": undefined,
        },
        {
          ...clientMeta,
          "io.modelcontextprotocol/clientInfo": "invalid-client-info",
        },
      ];
      for (const _meta of invalidMetadata) {
        const response = await request(
          handler,
          "tools/list",
          "pim-memory",
          { _meta },
        );
        assert.equal(response.status, 400);
      }

      const unknownSecret = "unknown-field-secret";
      const unknownBody = await responseBody(await request(
        handler,
        "tools/call",
        PIM_MEMORY_MCP_TOOL_NAMES[0],
        {
          name: PIM_MEMORY_MCP_TOOL_NAMES[0],
          arguments: { unexpected: unknownSecret },
          _meta: clientMeta,
        },
      ));
      assert.equal(unknownBody.result.isError, true);
      assert.equal(calls, 0);
      assert.doesNotMatch(JSON.stringify(unknownBody), new RegExp(unknownSecret));

      const legacy = await handler.fetch(new Request("http://localhost/mcp/memory", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "MCP-Protocol-Version": "2025-11-25",
          "Mcp-Method": "initialize",
          "Mcp-Name": "pim-memory",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "legacy",
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            clientInfo: { name: "legacy-client", version: "1.0.0" },
            capabilities: {},
          },
        }),
      }));
      assert.equal(legacy.status, 400);
      const legacyBody = await responseBody(legacy);
      assert.equal(legacyBody.error.code, -32022);
      assert.deepEqual(legacyBody.error.data.supported, [PIM_MEMORY_MCP_PROTOCOL_VERSION]);
    } finally {
      await handler.close();
    }
  });

  it("filters every catalog request against the authenticated principal", async () => {
    let capabilityCalls = 0;
    const checkedPrincipals: Array<string | undefined> = [];
    const handler = createRestrictedMemoryMcpHandler(
      {
        capabilities: () => {
          capabilityCalls += 1;
          return MEMORY_CONTRACT_FIXTURES_V2.MemoryCapabilitiesV2;
        },
        binding: () => MEMORY_CONTRACT_FIXTURES_V2.MemoryBindingV2,
        codeSearch: () => MEMORY_CONTRACT_FIXTURES_V2.MemorySearchResultV2,
        runReceiptSubmit: () => MEMORY_CONTRACT_FIXTURES_V2.RunReceiptResultV2,
        feedbackSubmit: () => MEMORY_CONTRACT_FIXTURES_V2.MemoryFeedbackResultV2,
        candidateStatus: () => MEMORY_CONTRACT_FIXTURES_V2.MemoryCandidateStatusV2,
        harnessSearch: () => MEMORY_CONTRACT_FIXTURES_V2.MemorySearchResultV2,
        readiness: () => MEMORY_CONTRACT_FIXTURES_V2.MemoryReadinessV2,
        recordResource: () => MEMORY_CONTRACT_FIXTURES_V2.MemoryRecordV2,
        packResource: () => MEMORY_CONTRACT_FIXTURES_V2.MemoryRetrievalPackV2,
      },
      {
        authorization: {
          canDiscoverCapabilities: (authInfo) => {
            checkedPrincipals.push(authInfo?.clientId);
            return authInfo?.clientId === "allowed-client";
          },
          canDiscoverBinding: (authInfo) => {
            checkedPrincipals.push(authInfo?.clientId);
            return authInfo?.clientId === "allowed-client";
          },
          canDiscoverCodeSearch: (authInfo) => {
            checkedPrincipals.push(authInfo?.clientId);
            return authInfo?.clientId === "allowed-client";
          },
          canDiscoverRunReceiptSubmit: (authInfo) => {
            checkedPrincipals.push(authInfo?.clientId);
            return authInfo?.clientId === "allowed-client";
          },
          canDiscoverFeedbackSubmit: (authInfo) => {
            checkedPrincipals.push(authInfo?.clientId);
            return authInfo?.clientId === "allowed-client";
          },
          canDiscoverCandidateStatus: (authInfo) => {
            checkedPrincipals.push(authInfo?.clientId);
            return authInfo?.clientId === "allowed-client";
          },
          canDiscoverHarnessSearch: (authInfo) => {
            checkedPrincipals.push(authInfo?.clientId);
            return authInfo?.clientId === "allowed-client";
          },
          canDiscoverReadiness: (authInfo) => {
            checkedPrincipals.push(authInfo?.clientId);
            return authInfo?.clientId === "allowed-client";
          },
          canDiscoverRecordResource: (authInfo) => {
            checkedPrincipals.push(authInfo?.clientId);
            return authInfo?.clientId === "allowed-client";
          },
          canDiscoverPackResource: (authInfo) => {
            checkedPrincipals.push(authInfo?.clientId);
            return authInfo?.clientId === "allowed-client";
          },
        },
      },
    );
    const allowed: AuthInfo = {
      token: "allowed-token-must-not-leak",
      clientId: "allowed-client",
      scopes: [],
    };
    const denied: AuthInfo = {
      token: "denied-token-must-not-leak",
      clientId: "denied-client",
      scopes: [],
    };
    try {
      const allowedTools = await responseBody(await request(
        handler,
        "tools/list",
        "pim-memory",
        { _meta: clientMeta },
        allowed,
      ));
      assert.deepEqual(allowedTools.result.tools.map((tool: any) => tool.name), [
        ...PIM_MEMORY_MCP_TOOL_NAMES,
      ]);

      const allowedTemplates = await responseBody(await request(
        handler,
        "resources/templates/list",
        "pim-memory",
        { _meta: clientMeta },
        allowed,
      ));
      assert.deepEqual(
        allowedTemplates.result.resourceTemplates.map((template: any) => template.uriTemplate),
        [...PIM_MEMORY_MCP_RESOURCE_TEMPLATES],
      );

      const deniedDiscovery = await responseBody(await request(
        handler,
        "server/discover",
        "pim-memory",
        { _meta: clientMeta },
        denied,
      ));
      assertPrivateListResult(deniedDiscovery.result);

      const deniedTools = await responseBody(await request(
        handler,
        "tools/list",
        "pim-memory",
        { _meta: clientMeta },
        denied,
      ));
      assert.deepEqual(deniedTools.result.tools, []);
      assertPrivateListResult(deniedTools.result);

      const deniedResources = await responseBody(await request(
        handler,
        "resources/list",
        "pim-memory",
        { _meta: clientMeta },
        denied,
      ));
      assert.deepEqual(deniedResources.result.resources, []);
      assertPrivateListResult(deniedResources.result);

      const deniedTemplates = await responseBody(await request(
        handler,
        "resources/templates/list",
        "pim-memory",
        { _meta: clientMeta },
        denied,
      ));
      assert.deepEqual(deniedTemplates.result.resourceTemplates, []);
      assertPrivateListResult(deniedTemplates.result);

      const deniedCall = await responseBody(await request(
        handler,
        "tools/call",
        PIM_MEMORY_MCP_TOOL_NAMES[0],
        {
          name: PIM_MEMORY_MCP_TOOL_NAMES[0],
          arguments: {},
          _meta: clientMeta,
        },
        denied,
      ));
      assert.equal(deniedCall.error.code, -32602);
      assert.equal(capabilityCalls, 0);

      const deniedSearch = await responseBody(await request(
        handler,
        "tools/call",
        PIM_MEMORY_MCP_TOOL_NAMES[2],
        {
          name: PIM_MEMORY_MCP_TOOL_NAMES[2],
          arguments: MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpCodeSearchInputV2,
          _meta: clientMeta,
        },
        denied,
      ));
      assert.equal(deniedSearch.error.code, -32602);

      for (const deniedTool of [
        {
          name: PIM_MEMORY_MCP_TOOL_NAMES[3],
          arguments: MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpRunReceiptSubmitInputV2,
        },
        {
          name: PIM_MEMORY_MCP_TOOL_NAMES[4],
          arguments: MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpFeedbackSubmitInputV2,
        },
        {
          name: PIM_MEMORY_MCP_TOOL_NAMES[5],
          arguments: codeCandidateStatusInput(),
        },
        {
          name: PIM_MEMORY_MCP_TOOL_NAMES[6],
          arguments: MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpHarnessSearchInputV2,
        },
        {
          name: PIM_MEMORY_MCP_TOOL_NAMES[7],
          arguments: MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpReadinessInputV2,
        },
      ]) {
        const deniedToolCall = await responseBody(await request(
          handler,
          "tools/call",
          deniedTool.name,
          { ...deniedTool, _meta: clientMeta },
          denied,
        ));
        assert.equal(deniedToolCall.error.code, -32602);
      }

      const deniedRecordUri = "pim-memory://records/memory-v2-contract-1/versions/1";
      const deniedRecord = await responseBody(await request(
        handler,
        "resources/read",
        deniedRecordUri,
        { uri: deniedRecordUri, _meta: clientMeta },
        denied,
      ));
      assert.equal(deniedRecord.error.code, -32602);

      const serialized = JSON.stringify({
        allowedTemplates,
        deniedDiscovery,
        deniedTools,
        deniedResources,
        deniedTemplates,
        deniedCall,
        deniedSearch,
        deniedRecord,
      });
      assert.doesNotMatch(serialized, /allowed-token-must-not-leak|denied-token-must-not-leak/);
      assert.ok(checkedPrincipals.includes("allowed-client"));
      assert.ok(checkedPrincipals.filter((clientId) => clientId === "denied-client").length >= 8);
    } finally {
      await handler.close();
    }
  });
});
