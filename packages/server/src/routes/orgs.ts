import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { validateBody } from "../middleware/validation.js";
import {
  createOrg,
  findOrgBySlug,
  getMembership,
  listOrgsForUser,
  listMembers,
  listPendingInvitesForOrg,
  listPendingInvitesForEmail,
  createInvite,
  revokeInvite,
  acceptInvite,
  findInviteById,
  removeMember,
  updateMemberRole,
  type OrgRole,
} from "../services/orgs.js";
import { canInvite, canRemoveMember, canUpdateMemberRole } from "../services/org-permissions.js";

const CreateOrgSchema = z.object({
  slug: z.string().min(2).max(40),
  name: z.string().min(1).max(100),
});

const InviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(["admin", "member"]),
});

const UpdateMemberRoleSchema = z.object({
  role: z.enum(["owner", "admin", "member"]),
});

/**
 * Resolve an org by slug and verify the caller is a member. Returns the org +
 * caller's role, or sends the appropriate error response and returns null.
 */
function requireMember(
  req: FastifyRequest<{ Params: { slug: string } }>,
  reply: FastifyReply,
): { org: ReturnType<typeof findOrgBySlug>; role: OrgRole } | null {
  const org = findOrgBySlug(req.params.slug);
  if (!org) {
    reply.code(404);
    reply.send({ error: "Org not found" });
    return null;
  }
  const membership = getMembership(org.org_id, req.userRecord.user_id);
  if (!membership) {
    reply.code(403);
    reply.send({ error: "Not a member of this org" });
    return null;
  }
  return { org, role: membership.role };
}

export default async function orgsRoutes(app: FastifyInstance) {
  app.get("/api/me", async (req, reply) => {
    const user = req.userRecord;
    if (!user) {
      reply.code(401);
      return { error: "Not authenticated" };
    }
    const orgs = listOrgsForUser(user.user_id).map((o) => ({
      org_id: o.org_id,
      slug: o.slug,
      name: o.name,
      role: o.role,
      created_at: o.created_at,
    }));
    const pendingInvites = listPendingInvitesForEmail(user.email).map((i) => ({
      invite_id: i.invite_id,
      org_slug: i.org_slug,
      org_name: i.org_name,
      role: i.role,
      created_at: i.created_at,
    }));
    return {
      user: {
        user_id: user.user_id,
        email: user.email,
        display_name: user.display_name,
        ims_user_id: user.ims_user_id,
      },
      orgs,
      pending_invites: pendingInvites,
    };
  });

  app.get("/api/orgs", async (req) => {
    return listOrgsForUser(req.userRecord.user_id);
  });

  app.post<{ Body: z.infer<typeof CreateOrgSchema> }>(
    "/api/orgs",
    { preHandler: validateBody(CreateOrgSchema) },
    async (req, reply) => {
      try {
        const { slug, name } = req.body;
        const org = createOrg({ slug, name, creatorUserId: req.userRecord.user_id });
        return { ...org, role: "owner" as const };
      } catch (e) {
        reply.code(400);
        return { error: e instanceof Error ? e.message : "Failed to create org" };
      }
    },
  );

  app.get<{ Params: { slug: string } }>("/api/orgs/:slug", async (req, reply) => {
    const resolved = requireMember(req, reply);
    if (!resolved || !resolved.org) return;
    return {
      ...resolved.org,
      role: resolved.role,
      members: listMembers(resolved.org.org_id),
    };
  });

  // --- Member list ---

  app.get<{ Params: { slug: string } }>("/api/orgs/:slug/members", async (req, reply) => {
    const resolved = requireMember(req, reply);
    if (!resolved || !resolved.org) return;
    return {
      members: listMembers(resolved.org.org_id),
      invites: listPendingInvitesForOrg(resolved.org.org_id).map((i) => ({
        invite_id: i.invite_id,
        email: i.email,
        role: i.role,
        created_at: i.created_at,
      })),
    };
  });

  app.patch<{
    Params: { slug: string; userId: string };
    Body: z.infer<typeof UpdateMemberRoleSchema>;
  }>(
    "/api/orgs/:slug/members/:userId",
    { preHandler: validateBody(UpdateMemberRoleSchema) },
    async (req, reply) => {
      const resolved = requireMember(req, reply);
      if (!resolved || !resolved.org) return;
      if (!canUpdateMemberRole(resolved.role)) {
        reply.code(403);
        return { error: "Only admins and owners can update member roles" };
      }
      // Protect against orphaning an org: don't allow demoting the last owner.
      if (req.body.role !== "owner") {
        const current = getMembership(resolved.org.org_id, req.params.userId);
        if (current?.role === "owner") {
          const owners = listMembers(resolved.org.org_id).filter((m) => m.role === "owner");
          if (owners.length <= 1) {
            reply.code(400);
            return { error: "Cannot demote the last owner — promote someone else first" };
          }
        }
      }
      const updated = updateMemberRole(resolved.org.org_id, req.params.userId, req.body.role);
      if (!updated) {
        reply.code(404);
        return { error: "Member not found" };
      }
      return updated;
    },
  );

  app.delete<{ Params: { slug: string; userId: string } }>(
    "/api/orgs/:slug/members/:userId",
    async (req, reply) => {
      const resolved = requireMember(req, reply);
      if (!resolved || !resolved.org) return;
      // Allow self-removal regardless of role (user is leaving the org).
      const isSelf = req.params.userId === req.userRecord.user_id;
      if (!isSelf && !canRemoveMember(resolved.role)) {
        reply.code(403);
        return { error: "Only admins and owners can remove members" };
      }
      const target = getMembership(resolved.org.org_id, req.params.userId);
      if (!target) {
        reply.code(404);
        return { error: "Member not found" };
      }
      if (target.role === "owner") {
        const owners = listMembers(resolved.org.org_id).filter((m) => m.role === "owner");
        if (owners.length <= 1) {
          reply.code(400);
          return { error: "Cannot remove the last owner" };
        }
      }
      removeMember(resolved.org.org_id, req.params.userId);
      return { ok: true };
    },
  );

  // --- Invites ---

  app.post<{ Params: { slug: string }; Body: z.infer<typeof InviteSchema> }>(
    "/api/orgs/:slug/invites",
    { preHandler: validateBody(InviteSchema) },
    async (req, reply) => {
      const resolved = requireMember(req, reply);
      if (!resolved || !resolved.org) return;
      if (!canInvite(resolved.role)) {
        reply.code(403);
        return { error: "Only admins and owners can invite members" };
      }
      const invite = createInvite({
        orgId: resolved.org.org_id,
        email: req.body.email,
        role: req.body.role,
        invitedByUserId: req.userRecord.user_id,
      });
      return invite;
    },
  );

  app.delete<{ Params: { slug: string; inviteId: string } }>(
    "/api/orgs/:slug/invites/:inviteId",
    async (req, reply) => {
      const resolved = requireMember(req, reply);
      if (!resolved || !resolved.org) return;
      if (!canInvite(resolved.role)) {
        reply.code(403);
        return { error: "Only admins and owners can revoke invites" };
      }
      const invite = findInviteById(req.params.inviteId);
      if (!invite || invite.org_id !== resolved.org.org_id) {
        reply.code(404);
        return { error: "Invite not found" };
      }
      revokeInvite(req.params.inviteId);
      return { ok: true };
    },
  );

  app.post<{ Params: { inviteId: string } }>(
    "/api/orgs/accept/:inviteId",
    async (req, reply) => {
      const invite = findInviteById(req.params.inviteId);
      if (!invite || invite.accepted_at) {
        reply.code(404);
        return { error: "Invite not found or already accepted" };
      }
      if (invite.email.toLowerCase() !== req.userRecord.email.toLowerCase()) {
        reply.code(403);
        return { error: "Invite email does not match your account" };
      }
      const membership = acceptInvite(req.params.inviteId, req.userRecord.user_id);
      if (!membership) {
        reply.code(400);
        return { error: "Failed to accept invite" };
      }
      return membership;
    },
  );
}
