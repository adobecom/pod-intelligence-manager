import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MEMORY_CONTRACT_FIXTURES_V2,
  MEMORY_CONTRACT_SCHEMA,
  MEMORY_CONTRACT_SCHEMA_V2,
  MemoryContractValidationError,
  parseMemoryContractV2,
  type MemoryCapabilitiesV2,
} from "@pim/shared";
import { createRestrictedMemoryMcpHandler } from "@pim/mcp-server/memory";
import { createTables } from "../../db/schema.js";
import { SERVICE_TOKEN_SCOPES } from "../../services/service-tokens.js";
import {
  MEMORY_V2_HARNESS_SCOPES,
  MEMORY_V2_OPERATIONS,
  memoryV2OperationsForScopes,
  requireMemoryV2KindForSubtype,
} from "../../services/memory-v2-constants.js";
import { getMemoryV2Capabilities } from "../../services/memory-v2-capabilities.js";
import memoryV2CapabilitiesRoutes from "../memory-v2-capabilities.js";
import memoryV2SearchRoutes from "../memory-v2-search.js";

const app = Fastify();

const mcp = createRestrictedMemoryMcpHandler({ capabilities: getMemoryV2Capabilities });
const clientMeta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "pim-server-test", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

beforeAll(async () => {
  createTables();
  await app.register(memoryV2CapabilitiesRoutes);
  await app.register(memoryV2SearchRoutes);
  await app.ready();
});

afterAll(async () => {
  await Promise.all([app.close(), mcp.close()]);
});

async function mcpCapabilities(): Promise<unknown> {
  const response = await mcp.fetch(new Request("http://localhost/mcp/memory", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/call",
      "Mcp-Name": "pim_memory_capabilities",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "pim_memory_capabilities",
        arguments: {},
        _meta: clientMeta,
      },
    }),
  }));
  const body = await response.json() as any;
  return body.result.structuredContent;
}

async function generatedHttpCapabilities(): Promise<MemoryCapabilitiesV2> {
  const response = await app.inject({ method: "GET", url: "/api/v2/memory/capabilities" });
  if (response.statusCode !== 200) {
    throw new Error(`Capability request failed with HTTP ${response.statusCode}`);
  }
  return parseMemoryContractV2("MemoryCapabilitiesV2", response.json());
}

describe("memory v2 Slice 0", () => {
  it("validates every generated v2 fixture and rejects unknown fields", () => {
    for (const [name, value] of Object.entries(MEMORY_CONTRACT_FIXTURES_V2)) {
      expect(parseMemoryContractV2(name as keyof typeof MEMORY_CONTRACT_SCHEMA_V2.$defs, value))
        .toEqual(value);
    }
    expect(() => parseMemoryContractV2("MemoryCapabilitiesV2", {
      ...MEMORY_CONTRACT_FIXTURES_V2.MemoryCapabilitiesV2,
      unexpected: true,
    })).toThrow(MemoryContractValidationError);
  });

  it("freezes resolvable evidence and the complete safe MCP boundary", () => {
    expect(MEMORY_CONTRACT_SCHEMA_V2.$defs.EvidenceRefV2)
      .toEqual(MEMORY_CONTRACT_SCHEMA.$defs.EvidenceRefV2);
    expect(MEMORY_CONTRACT_SCHEMA_V2.$defs.CodeEvidenceManifestV2.properties.schema_version)
      .toEqual({ const: "pim.memory-code-evidence.v2" });

    const codeReceipt = MEMORY_CONTRACT_FIXTURES_V2.RunReceiptV2;
    const codeRefs = new Set(codeReceipt.evidence_manifest.refs.map((ref) => ref.id));
    expect(codeReceipt.candidates.every((candidate) => (
      candidate.evidence_refs.every((ref) => codeRefs.has(ref))
    ))).toBe(true);

    const harnessReceipt = MEMORY_CONTRACT_FIXTURES_V2.HarnessRunReceiptV2;
    const harnessRefs = new Set(harnessReceipt.evidence_handles.map((handle) => (
      handle.evidence_ref_id
    )));
    expect(harnessReceipt.candidates.every((candidate) => (
      candidate.evidence_refs.every((ref) => harnessRefs.has(ref))
    ))).toBe(true);

    expect(() => parseMemoryContractV2("HarnessRootOriginEvidenceHandleV2", {
      ...MEMORY_CONTRACT_FIXTURES_V2.HarnessRootOriginEvidenceHandleV2,
      producer_principal_id: "caller-declared-principal",
    })).toThrow(MemoryContractValidationError);
    expect(() => parseMemoryContractV2("HarnessDerivationEvidenceHandleV2", {
      ...MEMORY_CONTRACT_FIXTURES_V2.HarnessDerivationEvidenceHandleV2,
      derivation_parent_refs: [],
    })).toThrow(MemoryContractValidationError);

    for (const name of [
      "MemoryMcpCodeSearchInputV2",
      "MemoryMcpHarnessSearchInputV2",
      "MemoryMcpRunReceiptSubmitInputV2",
      "MemoryMcpFeedbackSubmitInputV2",
      "MemoryMcpCandidateStatusInputV2",
      "MemoryMcpReadinessInputV2",
      "MemoryMcpRecordResourceSelectorV2",
      "MemoryMcpPackResourceSelectorV2",
    ] as const) {
      expect(MEMORY_CONTRACT_FIXTURES_V2[name]).toBeDefined();
      expect(parseMemoryContractV2(name, MEMORY_CONTRACT_FIXTURES_V2[name]))
        .toEqual(MEMORY_CONTRACT_FIXTURES_V2[name]);
    }
    expect(() => parseMemoryContractV2("MemoryMcpCodeSearchInputV2", {
      ...MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpCodeSearchInputV2,
      resource_selector: null,
    })).toThrow(MemoryContractValidationError);
  });

  it("keeps the exact harness scopes and never substitutes review for candidate read", () => {
    expect(MEMORY_V2_HARNESS_SCOPES).toEqual([
      "memory:harness:search",
      "memory:harness:receipt:write",
      "memory:harness:candidate:read",
      "memory:harness:review",
    ]);
    expect(SERVICE_TOKEN_SCOPES).toContain("memory:harness:candidate:read");
    expect(SERVICE_TOKEN_SCOPES).not.toContain(["memory", "harness", "*"].join(":"));
    expect(MEMORY_V2_OPERATIONS)
      .toEqual(MEMORY_CONTRACT_SCHEMA_V2.$defs.MemoryOperationV2.enum);
    expect(MEMORY_V2_OPERATIONS).not.toEqual(expect.arrayContaining(["attest", "admin"]));
    expect(memoryV2OperationsForScopes("harness", ["memory:harness:candidate:read"]))
      .toEqual(["candidate_read"]);
    expect(requireMemoryV2KindForSubtype("workflow_strategy")).toBe("decision");
    expect(() => requireMemoryV2KindForSubtype("invented_subtype")).toThrow(/not mapped/);
  });

  it("returns the same domain result through generated-contract HTTP and MCP callers", async () => {
    const http = await generatedHttpCapabilities();
    const viaMcp = parseMemoryContractV2("MemoryCapabilitiesV2", await mcpCapabilities());
    expect(viaMcp).toEqual(http);
    expect(http.known_planes).toEqual(["codebase", "harness"]);
    expect(http.mcp_surface.exposed_tools).toEqual([
      "pim_memory_capabilities",
      "pim_memory_binding",
      "pim_code_memory_search",
      "pim_run_receipt_submit",
      "pim_feedback_submit",
      "pim_candidate_status",
      "pim_harness_memory_search",
      "pim_memory_readiness",
    ]);
    expect(http.mcp_surface.resource_templates).toEqual([
      "pim-memory://records/{record_id}/versions/{version}",
      "pim-memory://packs/{pack_id}",
    ]);
    expect(http.mcp_surface.production_enabled).toBe(true);
    expect(http.mcp_surface).toEqual(
      MEMORY_CONTRACT_FIXTURES_V2.MemoryCapabilitiesV2.mcp_surface,
    );
    expect(http.mcp_surface.excluded_control_plane_operations)
      .toContain("activation");
    expect(http.planes.find((plane) => plane.plane === "codebase")?.operation_surfaces)
      .toEqual(expect.arrayContaining([
        { operation: "search", canonical_http: "available", restricted_mcp: "exposed" },
        {
          operation: "history",
          canonical_http: "available",
          restricted_mcp: "not_exposed",
        },
        {
          operation: "candidate_write",
          canonical_http: "available",
          restricted_mcp: "receipt_embedded",
        },
        {
          operation: "feedback_write",
          canonical_http: "available",
          restricted_mcp: "exposed",
        },
        {
          operation: "activation",
          canonical_http: "available",
          restricted_mcp: "excluded_control_plane",
        },
      ]));
    expect(http.planes.find((plane) => plane.plane === "harness")?.operation_surfaces)
      .toEqual(expect.arrayContaining([
        {
          operation: "history",
          canonical_http: "available",
          restricted_mcp: "not_exposed",
        },
      ]));
    expect(http.supported_schemas)
      .toEqual(MEMORY_CONTRACT_FIXTURES_V2.MemoryCapabilitiesV2.supported_schemas);
  });

  it("rejects unknown planes, fields, and versions before dispatch", async () => {
    const base = MEMORY_CONTRACT_FIXTURES_V2.MemorySearchV2;
    for (const [patch, expectedCode] of [
      [{ plane: "unknown" }, "schema_invalid"],
      [{ schema_version: "pim.memory-search.v99" }, "contract_version_unsupported"],
      [{ unexpected: true }, "schema_invalid"],
    ] as const) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v2/memory/search",
        payload: { ...base, ...patch },
      });
      expect(response.statusCode).toBe(400);
      expect(parseMemoryContractV2("PimErrorV2", response.json()).code)
        .toBe(expectedCode);
    }
  });

  it("keeps the frozen v1 capability route and service byte-identical", async () => {
    const files = [
      ["src/routes/memory-capabilities.ts", "b4ade1303b77b9af797070532102e08be2c19cd1c4e993b67b8bc88fcd665dfd"],
      ["src/services/memory-capabilities.ts", "d6b182dba80d05461a41dd35b619c6068d04774cf616a9fed220a886614d2dfc"],
    ] as const;
    for (const [path, expected] of files) {
      const bytes = await readFile(new URL(`../../../${path}`, import.meta.url));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(expected);
    }
  });
});
