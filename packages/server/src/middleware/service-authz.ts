import type { FastifyReply, FastifyRequest } from "fastify";
import db from "../db/connection.js";
import { atLeast } from "../services/org-permissions.js";
import type { ServiceTokenScope } from "../services/service-tokens.js";
import type { ServiceTokenAuthMetadata } from "../services/service-tokens.js";
import {
  resolveMemoryRepository,
  type MemoryRepositoryBinding,
} from "../services/memory-repository-registry.js";
import { sendMemoryError } from "./memory-errors.js";
import {
  resolveMemoryHarnessPrincipalBinding,
  type MemoryHarnessPrincipalBinding,
} from "../services/memory-harness-bindings.js";
import {
  type ImplementedMemoryV2Plane,
  type MemoryV2Operation,
} from "../services/memory-v2-constants.js";
import {
  authorizeMemoryV2Request,
  type MemoryV2AuthorizationDecision,
  type MemoryV2RequestAuthorizationSnapshot,
} from "../services/memory-v2-request-authorization.js";

function serviceAuth(req: FastifyRequest) {
  return req.auth?.kind === "service_token" ? req.auth : null;
}

function forbidden(reply: FastifyReply, error: string): false {
  reply.code(403).send({ error });
  return false;
}

export function requireServiceScope(
  req: FastifyRequest,
  reply: FastifyReply,
  scope: ServiceTokenScope,
): boolean {
  const auth = serviceAuth(req);
  if (!auth) return true;
  if (auth.scopes.includes(scope)) return true;
  return forbidden(reply, `PIM service token is missing required scope: ${scope}`);
}

export function requireProjectBinding(
  req: FastifyRequest,
  reply: FastifyReply,
  projectId: string | null | undefined,
): boolean {
  const auth = serviceAuth(req);
  if (!auth) return true;
  const normalizedProjectId = projectId?.trim() || null;
  if (!normalizedProjectId) {
    if (auth.projectId || auth.podId) {
      return forbidden(reply, "PIM service token is bound to a narrower project or pod scope");
    }
    return true;
  }
  if (auth.projectId && auth.projectId !== normalizedProjectId) {
    return forbidden(reply, "PIM service token is not valid for this project");
  }
  if (auth.podId) {
    return forbidden(reply, "PIM pod-bound service token cannot access project-scoped resources");
  }
  return true;
}

export function requirePodBinding(
  req: FastifyRequest,
  reply: FastifyReply,
  podId: string | null | undefined,
): boolean {
  const auth = serviceAuth(req);
  if (!auth) return true;
  const normalizedPodId = podId?.trim() || null;
  if (!normalizedPodId) {
    if (auth.projectId || auth.podId) {
      return forbidden(reply, "PIM service token is bound to a narrower project or pod scope");
    }
    return true;
  }
  if (auth.podId && auth.podId !== normalizedPodId) {
    return forbidden(reply, "PIM service token is not valid for this pod");
  }
  if (auth.projectId) {
    const row = db
      .prepare("SELECT project_id FROM pods WHERE pod_id = ? AND org_id = ?")
      .get(normalizedPodId, auth.orgId) as { project_id: string | null } | undefined;
    if (!row || row.project_id !== auth.projectId) {
      return forbidden(reply, "PIM service token is not valid for this pod");
    }
  }
  return true;
}

export function requireResourceBinding(
  req: FastifyRequest,
  reply: FastifyReply,
  resource: { projectId?: string | null; podId?: string | null },
): boolean {
  const auth = serviceAuth(req);
  if (!auth) return true;
  if (resource.podId) return requirePodBinding(req, reply, resource.podId);
  if (resource.projectId) return requireProjectBinding(req, reply, resource.projectId);
  if (auth.projectId || auth.podId) {
    return forbidden(reply, "PIM service token is bound to a narrower project or pod scope");
  }
  return true;
}

export function rejectServiceToken(req: FastifyRequest, reply: FastifyReply): boolean {
  if (serviceAuth(req)) {
    return forbidden(reply, "PIM service tokens cannot call this endpoint");
  }
  return true;
}

export function requireAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!rejectServiceToken(req, reply)) return false;
  if (!req.membership || !atLeast(req.membership.role, "admin")) {
    return forbidden(reply, "Only admins and owners can perform this action");
  }
  return true;
}

export function requireMemoryServiceScope(
  req: FastifyRequest,
  reply: FastifyReply,
  scope: ServiceTokenScope,
): ServiceTokenAuthMetadata | null {
  const auth = serviceAuth(req);
  if (!auth || !auth.scopes.includes(scope)) {
    sendMemoryError(reply, 403, "resource_binding_mismatch", `Authenticated service principal lacks ${scope}`);
    return null;
  }
  return auth;
}

export function requireMemoryServicePrincipal(
  req: FastifyRequest,
  reply: FastifyReply,
): ServiceTokenAuthMetadata | null {
  const auth = serviceAuth(req);
  if (!auth) {
    sendMemoryError(reply, 403, "resource_binding_mismatch", "A memory service principal is required");
    return null;
  }
  return auth;
}

export function requireMemoryProjectBinding(
  req: FastifyRequest,
  reply: FastifyReply,
  projectId: string,
): ServiceTokenAuthMetadata | null {
  const auth = serviceAuth(req);
  if (!auth || !auth.projectId || auth.podId || auth.projectId !== projectId) {
    sendMemoryError(
      reply,
      403,
      "resource_binding_mismatch",
      "Request project does not match the authenticated project binding",
    );
    return null;
  }
  return auth;
}

export function requireMemoryRepositoryBinding(
  req: FastifyRequest,
  reply: FastifyReply,
  projectId: string,
  repositoryId: string,
): MemoryRepositoryBinding | null {
  const auth = requireMemoryProjectBinding(req, reply, projectId);
  if (!auth) return null;
  const binding = resolveMemoryRepository(auth.orgId, projectId, repositoryId);
  if (!binding) {
    sendMemoryError(
      reply,
      403,
      "resource_binding_mismatch",
      "Request repository does not match an authenticated project repository binding",
    );
    return null;
  }
  if (!auth.repositoryBindings?.some((allowed) => (
    allowed.repositoryRowId === binding.repository_row_id
  ))) {
    sendMemoryError(
      reply,
      403,
      "resource_binding_mismatch",
      "Request repository is outside the authenticated service-token bindings",
    );
    return null;
  }
  return binding;
}

export function requireAnyMemoryRepositoryBinding(
  req: FastifyRequest,
  reply: FastifyReply,
  projectId: string,
): ServiceTokenAuthMetadata | null {
  const auth = requireMemoryProjectBinding(req, reply, projectId);
  if (!auth) return null;
  if (!auth.repositoryBindings?.length) {
    sendMemoryError(
      reply,
      403,
      "resource_binding_mismatch",
      "Authenticated service token has no repository bindings",
    );
    return null;
  }
  return auth;
}

export function requireMemoryHarnessBinding(
  req: FastifyRequest,
  reply: FastifyReply,
  projectId: string,
  harnessId: string,
): MemoryHarnessPrincipalBinding | null {
  const auth = requireMemoryProjectBinding(req, reply, projectId);
  if (!auth) return null;
  const binding = resolveMemoryHarnessPrincipalBinding({
    servicePrincipalId: auth.servicePrincipalId,
    orgId: auth.orgId,
    projectId,
    harnessId,
  });
  if (!binding || !auth.harnessBindings?.some((allowed) => allowed.bindingId === binding.bindingId)) {
    sendMemoryError(
      reply,
      403,
      "resource_binding_mismatch",
      "Request harness is outside the authenticated service-token bindings",
    );
    return null;
  }
  return binding;
}

/**
 * Compatibility name for the single pure v2 authorization primitive. The
 * request snapshot was already proven and frozen at transport entry; this
 * helper performs no storage lookup and only narrows it to one operation and
 * exact resource.
 */
export function authorizeMemoryV2Resource(input: {
  principal: MemoryV2RequestAuthorizationSnapshot | null | undefined;
  operation: MemoryV2Operation;
  plane: ImplementedMemoryV2Plane;
  projectId: string;
  resourceRowId: string;
}): MemoryV2AuthorizationDecision {
  return authorizeMemoryV2Request({
    ...input,
    orgId: input.principal?.orgId ?? "",
  });
}
