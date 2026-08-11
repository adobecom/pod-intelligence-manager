import {
  parseMemoryContractV2,
  type MemoryBindingV2,
  type MemoryScopeV2,
} from "@pim/shared";
import {
  memoryV2ContractScopes,
  type MemoryV2RequestAuthorizationSnapshot,
} from "./memory-v2-request-authorization.js";

const MEMORY_BINDING_SCOPES = [
  "memory:search",
  "memory:receipt:write",
  "memory:candidate:read",
  "memory:attest",
  "memory:feedback:write",
  "memory:review",
  "memory:admin",
  "memory:harness:search",
  "memory:harness:receipt:write",
  "memory:harness:candidate:read",
  "memory:harness:review",
] as const satisfies readonly MemoryScopeV2[];

export class MemoryV2BindingError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: "authentication_required" | "resource_binding_mismatch",
  ) {
    super(message);
    this.name = "MemoryV2BindingError";
  }
}

/**
 * Non-secret effective-authority projection shared by HTTP and MCP. The token
 * value, token id, profile, and internal binding ids never enter the contract.
 */
export function getMemoryV2Binding(
  principal: MemoryV2RequestAuthorizationSnapshot | null | undefined,
): MemoryBindingV2 {
  if (!principal) {
    throw new MemoryV2BindingError(
      "A PIM service-token principal is required",
      401,
      "authentication_required",
    );
  }
  if (!principal.projectId || principal.podId) {
    throw new MemoryV2BindingError(
      "A project-bound PIM service-token principal is required",
      403,
      "resource_binding_mismatch",
    );
  }

  const scopes = memoryV2ContractScopes(principal, MEMORY_BINDING_SCOPES);
  if (principal.resources.length === 0) {
    throw new MemoryV2BindingError(
      "No current memory resource is bound to this principal",
      403,
      "resource_binding_mismatch",
    );
  }

  const result: MemoryBindingV2 = {
    schema_version: "pim.memory-binding.v2",
    service_principal_id: principal.servicePrincipalId,
    tenant: {
      organization_id: principal.orgId,
      project_id: principal.projectId,
    },
    scopes,
    resources: principal.resources.map((binding) => ({
      ...binding.contract,
      permitted_operations: [...binding.contract.permitted_operations],
    })),
  };

  return parseMemoryContractV2("MemoryBindingV2", result);
}
