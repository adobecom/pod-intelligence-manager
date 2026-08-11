import {
  type MemoryMcpReadinessInputV2,
  type MemoryPlaneV2,
  type MemoryReadinessV2,
  type PimErrorV2,
  type ResourceBindingV2,
} from "@pim/shared";
import { authorizeMemoryV2Resource } from "../middleware/service-authz.js";
import {
  getMemoryV2Binding,
  MemoryV2BindingError,
} from "./memory-v2-binding.js";
import {
  getMemoryV2Readiness,
  MemoryV2ReverificationError,
} from "./memory-v2-reverification.js";
import type {
  AuthorizedMemoryV2ResourceContext,
  MemoryV2RequestAuthorizationSnapshot,
} from "./memory-v2-request-authorization.js";

type MemoryV2ReadinessErrorCode = Extract<
  PimErrorV2["code"],
  | "authentication_required"
  | "scope_required"
  | "resource_binding_mismatch"
  | "temporarily_unavailable"
>;

export class MemoryV2ReadinessError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: MemoryV2ReadinessErrorCode,
    readonly plane: MemoryPlaneV2 | null,
    readonly details: PimErrorV2["details"] = [],
  ) {
    super(message);
    this.name = "MemoryV2ReadinessError";
  }
}

function readinessError(
  message: string,
  statusCode: number,
  code: MemoryV2ReadinessErrorCode,
  plane: MemoryPlaneV2 | null,
  path?: string,
  reason?: string,
): MemoryV2ReadinessError {
  return new MemoryV2ReadinessError(
    message,
    statusCode,
    code,
    plane,
    path && reason ? [{ path, reason }] : [],
  );
}

function requireProjectPrincipal(
  principal: MemoryV2RequestAuthorizationSnapshot | null | undefined,
  plane: MemoryMcpReadinessInputV2["plane"],
): MemoryV2RequestAuthorizationSnapshot {
  if (!principal) {
    throw readinessError(
      "A PIM service-token principal is required",
      401,
      "authentication_required",
      plane,
    );
  }
  if (!principal.projectId || principal.podId) {
    throw readinessError(
      "A project-bound PIM service-token principal is required",
      403,
      "resource_binding_mismatch",
      plane,
    );
  }
  return principal;
}

function selectedResourceBinding(input: {
  principal: MemoryV2RequestAuthorizationSnapshot;
  request: MemoryMcpReadinessInputV2;
}): ResourceBindingV2 {
  let binding;
  try {
    binding = getMemoryV2Binding(input.principal);
  } catch (error) {
    if (error instanceof MemoryV2BindingError) {
      throw readinessError(
        error.message,
        error.statusCode,
        error.code,
        input.request.plane,
      );
    }
    throw error;
  }

  const expectedResourceType = input.request.plane === "codebase"
    ? "repository"
    : "harness";
  const resources = binding.resources.filter((resource) => (
    resource.plane === input.request.plane
    && resource.resource_type === expectedResourceType
    && ("resource_row_id" in input.request.resource_selector
      ? resource.resource_row_id === input.request.resource_selector.resource_row_id
      : resource.canonical_resource_id
        === input.request.resource_selector.canonical_resource_id)
  ));
  if (resources.length !== 1) {
    throw readinessError(
      "The selected memory resource is outside the authenticated binding",
      403,
      "resource_binding_mismatch",
      input.request.plane,
      "/resource_selector",
      "selector must resolve exactly one bound resource on the requested plane",
    );
  }
  return resources[0]!;
}

function readinessAuthorization(input: {
  principal: MemoryV2RequestAuthorizationSnapshot;
  plane: MemoryMcpReadinessInputV2["plane"];
  resourceBinding: ResourceBindingV2;
}): AuthorizedMemoryV2ResourceContext {
  const decision = authorizeMemoryV2Resource({
    principal: input.principal,
    operation: "readiness",
    plane: input.plane,
    projectId: input.principal.projectId!,
    resourceRowId: input.resourceBinding.resource_row_id,
  });
  if (decision.decision === "allow") {
    if (!input.resourceBinding.permitted_operations.includes("readiness")) {
      throw readinessError(
        "Memory readiness authorization is temporarily inconsistent",
        503,
        "temporarily_unavailable",
        input.plane,
      );
    }
    return decision.context;
  }
  if (decision.reason === "principal_unavailable") {
    throw readinessError(
      "The authenticated service-token principal is no longer available",
      401,
      "authentication_required",
      input.plane,
    );
  }
  if (decision.reason === "scope_missing") {
    throw readinessError(
      "The required memory scope is unavailable",
      403,
      "scope_required",
      input.plane,
    );
  }
  throw readinessError(
    "The selected memory resource is outside the authenticated binding",
    403,
    "resource_binding_mismatch",
    input.plane,
  );
}

export function authorizeMemoryV2Readiness(input: {
  principal: MemoryV2RequestAuthorizationSnapshot | null | undefined;
  request: MemoryMcpReadinessInputV2;
}): AuthorizedMemoryV2ResourceContext {
  const principal = requireProjectPrincipal(input.principal, input.request.plane);
  const resourceBinding = selectedResourceBinding({ principal, request: input.request });
  return readinessAuthorization({
    principal,
    plane: input.request.plane,
    resourceBinding,
  });
}

/**
 * Authorizes one exact resource and delegates to the bounded Slice-6 readiness
 * projection. This is shared by HTTP and MCP so transport identifiers never
 * widen the authenticated plane/resource binding.
 */
export function readAuthorizedMemoryV2Readiness(input: {
  authorization: AuthorizedMemoryV2ResourceContext;
  request: MemoryMcpReadinessInputV2;
}): MemoryReadinessV2 {
  const { authorization } = input;
  const principal = authorization.principal;
  const resourceBinding: ResourceBindingV2 = {
    ...authorization.binding,
    permitted_operations: [...authorization.binding.permitted_operations],
  };
  if (authorization.operation !== "readiness"
      || authorization.resource.plane !== input.request.plane
      || authorization.binding.organization_id !== principal.orgId
      || authorization.binding.project_id !== principal.projectId
      || ("resource_row_id" in input.request.resource_selector
        ? input.request.resource_selector.resource_row_id !== resourceBinding.resource_row_id
        : input.request.resource_selector.canonical_resource_id
          !== resourceBinding.canonical_resource_id)) {
    throw readinessError(
      "The selected memory resource is outside the authenticated binding",
      403,
      "resource_binding_mismatch",
      input.request.plane,
    );
  }
  try {
    return getMemoryV2Readiness({
      orgId: principal.orgId,
      projectId: principal.projectId!,
      plane: input.request.plane,
      resourceBinding,
    });
  } catch (error) {
    if (error instanceof MemoryV2ReverificationError) {
      if (error.code === "resource_binding_mismatch") {
        throw readinessError(
          "The selected memory resource is outside the authenticated binding",
          403,
          "resource_binding_mismatch",
          input.request.plane,
        );
      }
      throw readinessError(
        "Memory readiness is temporarily unavailable",
        503,
        "temporarily_unavailable",
        input.request.plane,
      );
    }
    throw error;
  }
}

export function readMemoryV2Readiness(input: {
  principal: MemoryV2RequestAuthorizationSnapshot | null | undefined;
  request: MemoryMcpReadinessInputV2;
}): MemoryReadinessV2 {
  return readAuthorizedMemoryV2Readiness({
    authorization: authorizeMemoryV2Readiness(input),
    request: input.request,
  });
}
