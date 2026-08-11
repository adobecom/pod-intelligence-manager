import {
  canonicalJsonSha256,
  MEMORY_CONTRACT_SCHEMA_V2,
  parseMemoryContractV2,
  type MemoryCapabilitiesV2,
} from "@pim/shared";
import {
  MEMORY_V2_PLANES,
  MEMORY_V2_SUBTYPE_KIND,
  MEMORY_V2_HARNESS_SCOPES,
} from "./memory-v2-constants.js";

export const MEMORY_V2_MCP_PROTOCOL_VERSION = "2026-07-28" as const;
export const MEMORY_V2_MCP_AUTHENTICATION_PROFILE = "private_pim_service_token" as const;

export const MEMORY_V2_MCP_COMMITTED_TOOLS = [
  "pim_memory_capabilities",
  "pim_memory_binding",
  "pim_code_memory_search",
  "pim_run_receipt_submit",
  "pim_feedback_submit",
  "pim_candidate_status",
  "pim_harness_memory_search",
  "pim_memory_readiness",
] as const;

export const MEMORY_V2_MCP_EXCLUDED_CONTROL_OPERATIONS = [
  "review",
  "activation",
  "runtime_attestation_write",
] as const;

const CODEBASE_OPERATION_SURFACES = [
  ["search", "exposed"],
  ["detail", "exposed"],
  ["history", "not_exposed"],
  ["pack", "exposed"],
  ["receipt_write", "exposed"],
  ["candidate_read", "exposed"],
  ["candidate_write", "receipt_embedded"],
  ["feedback_write", "exposed"],
  ["readiness", "exposed"],
  ["review", "excluded_control_plane"],
  ["activation", "excluded_control_plane"],
] as const;

const HARNESS_OPERATION_SURFACES = [
  ["search", "exposed"],
  ["detail", "exposed"],
  ["history", "not_exposed"],
  ["pack", "exposed"],
  ["receipt_write", "exposed"],
  ["candidate_read", "exposed"],
  ["candidate_write", "receipt_embedded"],
  ["readiness", "exposed"],
  ["review", "excluded_control_plane"],
  ["activation", "excluded_control_plane"],
  ["runtime_attestation_write", "excluded_control_plane"],
] as const;

function operationSurfaces(
  entries: readonly (readonly [string, string])[],
): Array<{ operation: string; canonical_http: "available"; restricted_mcp: string }> {
  return entries.map(([operation, restricted_mcp]) => ({
    operation,
    canonical_http: "available" as const,
    restricted_mcp,
  }));
}

const contractDigest = canonicalJsonSha256(MEMORY_CONTRACT_SCHEMA_V2);

/**
 * Server-owned v2 capability model. Both HTTP and restricted MCP call this
 * function so transport discovery cannot drift from the canonical contract.
 */
export function getMemoryV2Capabilities(): MemoryCapabilitiesV2 {
  const codebaseSurfaces = operationSurfaces(CODEBASE_OPERATION_SURFACES);
  const harnessSurfaces = operationSurfaces(HARNESS_OPERATION_SURFACES);
  return parseMemoryContractV2("MemoryCapabilitiesV2", {
    schema_version: "pim.memory-capabilities.v2",
    contract_revision: `memory-v2:${contractDigest.slice("sha256:".length, "sha256:".length + 16)}`,
    server_build:
      process.env.PIM_BUILD_REVISION?.trim()
      || process.env.GIT_SHA?.trim()
      || "development",
    known_planes: [...MEMORY_V2_PLANES],
    planes: [
      {
        plane: "codebase",
        status: "available",
        operations: codebaseSurfaces.map(({ operation }) => operation),
        operation_surfaces: codebaseSurfaces,
        applicability_schema: "pim.memory-codebase-applicability.v2",
      },
      {
        plane: "harness",
        status: "available",
        operations: harnessSurfaces.map(({ operation }) => operation),
        operation_surfaces: harnessSurfaces,
        applicability_schema: "pim.memory-harness-applicability.v2",
      },
    ],
    supported_schemas: {
      requests: [
        "pim.memory-search.v2",
        "pim.run-receipt.v2",
        "pim.memory-feedback.v2",
        "pim.memory-candidate-decision.v2",
      ],
      responses: [
        "pim.memory-capabilities.v2",
        "pim.memory-binding.v2",
        "pim.memory-search-result.v2",
        "pim.memory-record.v2",
        "pim.memory-record-history.v2",
        "pim.memory-retrieval-pack.v2",
        "pim.memory-readiness.v2",
        "pim.run-receipt-result.v2",
        "pim.memory-candidate-status.v2",
        "pim.memory-feedback-result.v2",
        "pim.memory-candidate-decision-result.v2",
        "pim.error.v2",
      ],
    },
    exact_harness_scopes: [...MEMORY_V2_HARNESS_SCOPES],
    harness_subkind_mapping: { ...MEMORY_V2_SUBTYPE_KIND },
    mcp_surface: {
      protocol_version: MEMORY_V2_MCP_PROTOCOL_VERSION,
      authentication_profile: MEMORY_V2_MCP_AUTHENTICATION_PROFILE,
      production_enabled: true,
      committed_tools: [...MEMORY_V2_MCP_COMMITTED_TOOLS],
      exposed_tools: [
        "pim_memory_capabilities",
        "pim_memory_binding",
        "pim_code_memory_search",
        "pim_run_receipt_submit",
        "pim_feedback_submit",
        "pim_candidate_status",
        "pim_harness_memory_search",
        "pim_memory_readiness",
      ],
      resource_templates: [
        "pim-memory://records/{record_id}/versions/{version}",
        "pim-memory://packs/{pack_id}",
      ],
      excluded_control_plane_operations: [...MEMORY_V2_MCP_EXCLUDED_CONTROL_OPERATIONS],
    },
    limits: {
      max_receipt_bytes: 256 * 1024,
      max_candidate_bytes: 32 * 1024,
      max_evidence_refs: 128,
      max_feedback_items: 256,
      max_search_tokens: 8000,
      max_search_items: 32,
    },
    temporal_modes: ["current"],
  });
}
