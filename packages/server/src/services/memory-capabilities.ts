import {
  canonicalJsonSha256,
  parseMemoryContract,
  MEMORY_CONTRACT_SCHEMA,
  type MemoryCapabilitiesV1,
} from "@pim/shared";
import { THIN_V1_MEMORY_KINDS } from "./memory-structural-validator.js";

export const MEMORY_LIMITS = {
  max_receipt_bytes: 256 * 1024,
  max_candidate_bytes: 32 * 1024,
  max_evidence_refs: 128,
  max_feedback_items: 256,
  max_search_tokens: 8000,
  max_search_items: 32,
} as const;

const contractDigest = canonicalJsonSha256(MEMORY_CONTRACT_SCHEMA);

export function getMemoryCapabilities(): MemoryCapabilitiesV1 {
  return parseMemoryContract("MemoryCapabilitiesV1", {
    schema_version: "pim.memory-capabilities.v1",
    contract_revision: `memory-v1:${contractDigest.slice("sha256:".length, "sha256:".length + 16)}`,
    server_build: process.env.PIM_BUILD_REVISION?.trim() || process.env.GIT_SHA?.trim() || "development",
    supported_schemas: {
      requests: [
        "pim.memory-search.v1",
        "pim.memory-harness-search.v1",
        "pim.run-receipt.v1",
        "pim.memory-feedback.v1",
        "pim.memory-candidate-decision.v1",
        "pim.memory-attestation.v1",
      ],
      responses: [
        "pim.memory-capabilities.v1",
        "pim.memory-search-result.v1",
        "pim.memory-harness-search-result.v1",
        "pim.memory-record.v1",
        "pim.memory-record-history.v1",
        "pim.run-receipt-result.v1",
        "pim.memory-candidate-status.v1",
        "pim.memory-feedback-result.v1",
        "pim.memory-candidate-decision-result.v1",
        "pim.memory-attestation-result.v1",
        "pim.error.v1",
      ],
    },
    planes: ["codebase", "harness"],
    kinds: [...THIN_V1_MEMORY_KINDS],
    limits: MEMORY_LIMITS,
    evidence_resolver_types: ["github", "https_immutable"],
    activation_policies: ["verified_merge", "authorized_review"],
    feedback_version: "pim.memory-feedback.v1",
    temporal_modes: ["current"],
    deprecations: [],
  });
}
