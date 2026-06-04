import type { FastifyRequest, FastifyReply } from "fastify";
import {
  findOrgBySlug,
  getMembership,
  listOrgsForUser,
  type OrgRecord,
  type MembershipRecord,
} from "../services/orgs.js";

declare module "fastify" {
  interface FastifyRequest {
    org?: OrgRecord;
    membership?: MembershipRecord;
  }
}

const ORG_HEADER = "x-pim-org";

function requiresExplicitOrg(url: string): boolean {
  const path = url.split("?")[0] ?? url;
  return (
    path === "/api/agent-sessions" ||
    path.startsWith("/api/agent-sessions/") ||
    path.startsWith("/api/agent-runs/") ||
    path.startsWith("/api/memory-candidates/")
  );
}

/**
 * Resolves the request's org from either the `X-Pim-Org` header (slug) or,
 * when the header is absent, the authenticated user's first membership.
 * Attaches `req.org` + `req.membership` on success; responds 401/403/404 on failure.
 *
 * Caller must ensure auth has run first (req.userRecord is populated).
 */
export async function resolveRequestOrg(req: FastifyRequest, reply: FastifyReply) {
  if (!req.userRecord) {
    return reply.code(401).send({ error: "Not authenticated" });
  }

  const headerVal = req.headers[ORG_HEADER];
  const slug = Array.isArray(headerVal) ? headerVal[0] : headerVal;

  if (slug) {
    const org = findOrgBySlug(slug);
    if (!org) {
      return reply.code(404).send({ error: `Org "${slug}" not found` });
    }
    const membership = getMembership(org.org_id, req.userRecord.user_id);
    if (!membership) {
      return reply.code(403).send({ error: "Not a member of this org" });
    }
    req.org = org;
    req.membership = membership;
    return;
  }

  // No header — fall back to the user's first org. Clients that don't yet send
  // the header (pre-Phase-3 UI, pre-Phase-5 CLI) still work against their
  // canonical org. Multi-org users SHOULD send the header.
  const orgs = listOrgsForUser(req.userRecord.user_id);
  if (orgs.length === 0) {
    return reply.code(409).send({ error: "User has no orgs; create one first" });
  }
  if (orgs.length > 1 && requiresExplicitOrg(req.url)) {
    return reply.code(400).send({
      error: "X-Pim-Org is required for agent-session and memory routes when the user belongs to multiple orgs",
    });
  }
  const primary = orgs[0];
  req.org = {
    org_id: primary.org_id,
    slug: primary.slug,
    name: primary.name,
    created_by_user_id: primary.created_by_user_id,
    created_at: primary.created_at,
  };
  req.membership = {
    org_id: primary.org_id,
    user_id: req.userRecord.user_id,
    role: primary.role,
    created_at: primary.created_at,
  };
}
