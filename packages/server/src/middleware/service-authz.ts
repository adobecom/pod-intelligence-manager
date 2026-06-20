import type { FastifyReply, FastifyRequest } from "fastify";
import db from "../db/connection.js";
import { atLeast } from "../services/org-permissions.js";
import type { ServiceTokenScope } from "../services/service-tokens.js";

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
