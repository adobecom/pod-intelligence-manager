import { randomUUID } from "crypto";
import db, { withTransaction } from "../db/connection.js";
import { ensureOrgConfig } from "./org-settings.js";

export type OrgRole = "owner" | "admin" | "member";

export interface OrgRecord {
  org_id: string;
  slug: string;
  name: string;
  created_by_user_id: string;
  created_at: string;
}

export interface MembershipRecord {
  org_id: string;
  user_id: string;
  role: OrgRole;
  created_at: string;
}

export interface OrgWithRole extends OrgRecord {
  role: OrgRole;
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/**
 * Resolve the org_id for a pod. Used internally when an operation must know the
 * org but only has a pod id (e.g. ingestion, context updates on a pod).
 */
export function getOrgIdForPod(podId: string): string | null {
  const row = db.prepare("SELECT org_id FROM pods WHERE pod_id = ?").get(podId) as
    | { org_id: string | null }
    | undefined;
  return row?.org_id ?? null;
}

/**
 * Phase-1 fallback for code paths that pre-date the org model and don't have a
 * resolved `req.org` yet. Returns the "demo" org's id if it exists — undefined
 * otherwise. Callers MUST handle the undefined case (e.g. by 400-ing the
 * request). This helper will be removed in a later phase once `req.org` is
 * universally available.
 */
let _defaultOrgIdCache: string | null = null;
export function getDefaultOrgId(): string | undefined {
  if (_defaultOrgIdCache) return _defaultOrgIdCache;
  const row = db.prepare("SELECT org_id FROM orgs WHERE slug = ?").get("demo") as
    | { org_id: string }
    | undefined;
  if (row) {
    _defaultOrgIdCache = row.org_id;
    return row.org_id;
  }
  return undefined;
}

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

export function findOrgBySlug(slug: string): OrgRecord | null {
  return (db.prepare("SELECT * FROM orgs WHERE slug = ?").get(slug) as OrgRecord | undefined) ?? null;
}

export function findOrgById(orgId: string): OrgRecord | null {
  return (db.prepare("SELECT * FROM orgs WHERE org_id = ?").get(orgId) as OrgRecord | undefined) ?? null;
}

export function getMembership(orgId: string, userId: string): MembershipRecord | null {
  return (
    (db
      .prepare("SELECT * FROM memberships WHERE org_id = ? AND user_id = ?")
      .get(orgId, userId) as MembershipRecord | undefined) ?? null
  );
}

export function listOrgsForUser(userId: string): OrgWithRole[] {
  return db
    .prepare(
      `SELECT o.org_id, o.slug, o.name, o.created_by_user_id, o.created_at, m.role
       FROM orgs o
       INNER JOIN memberships m ON m.org_id = o.org_id
       WHERE m.user_id = ?
       ORDER BY o.created_at ASC`,
    )
    .all(userId) as unknown as OrgWithRole[];
}

export function listMembers(orgId: string) {
  return db
    .prepare(
      `SELECT u.user_id, u.email, u.display_name, m.role, m.created_at
       FROM memberships m
       INNER JOIN users u ON u.user_id = m.user_id
       WHERE m.org_id = ?
       ORDER BY m.created_at ASC`,
    )
    .all(orgId) as Array<{
    user_id: string;
    email: string;
    display_name: string | null;
    role: OrgRole;
    created_at: string;
  }>;
}

export interface CreateOrgInput {
  slug: string;
  name: string;
  creatorUserId: string;
  orgId?: string;
}

export function createOrg({ slug, name, creatorUserId, orgId }: CreateOrgInput): OrgRecord {
  if (!isValidSlug(slug)) {
    throw new Error("Org slug must be 2–40 chars, lowercase alphanumeric and hyphens");
  }
  const existing = findOrgBySlug(slug);
  if (existing) {
    throw new Error(`Org slug "${slug}" is already taken`);
  }
  const id = orgId ?? `org_${randomUUID()}`;
  const now = new Date().toISOString();

  withTransaction(() => {
    db.prepare(
      "INSERT INTO orgs (org_id, slug, name, created_by_user_id, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, slug, name, creatorUserId, now);
    db.prepare(
      "INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)",
    ).run(id, creatorUserId, now);
    ensureOrgConfig(id);
  });

  return { org_id: id, slug, name, created_by_user_id: creatorUserId, created_at: now };
}

export function addMember(orgId: string, userId: string, role: OrgRole): MembershipRecord {
  const now = new Date().toISOString();
  db.prepare(
    "INSERT OR REPLACE INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, ?, COALESCE((SELECT created_at FROM memberships WHERE org_id = ? AND user_id = ?), ?))",
  ).run(orgId, userId, role, orgId, userId, now);
  return getMembership(orgId, userId)!;
}

export function removeMember(orgId: string, userId: string): void {
  db.prepare("DELETE FROM memberships WHERE org_id = ? AND user_id = ?").run(orgId, userId);
}

export function updateMemberRole(orgId: string, userId: string, role: OrgRole): MembershipRecord | null {
  db.prepare("UPDATE memberships SET role = ? WHERE org_id = ? AND user_id = ?").run(role, orgId, userId);
  return getMembership(orgId, userId);
}

// --- Invites ---

export interface InviteRecord {
  invite_id: string;
  org_id: string;
  email: string;
  role: Exclude<OrgRole, "owner">;
  invited_by_user_id: string;
  created_at: string;
  accepted_at: string | null;
}

export function listPendingInvitesForOrg(orgId: string): InviteRecord[] {
  return db
    .prepare(
      `SELECT * FROM org_invites
       WHERE org_id = ? AND accepted_at IS NULL
       ORDER BY created_at ASC`,
    )
    .all(orgId) as unknown as InviteRecord[];
}

export function listPendingInvitesForEmail(email: string): Array<InviteRecord & { org_slug: string; org_name: string }> {
  return db
    .prepare(
      `SELECT i.*, o.slug AS org_slug, o.name AS org_name
       FROM org_invites i
       INNER JOIN orgs o ON o.org_id = i.org_id
       WHERE lower(i.email) = lower(?) AND i.accepted_at IS NULL
       ORDER BY i.created_at ASC`,
    )
    .all(email) as unknown as Array<InviteRecord & { org_slug: string; org_name: string }>;
}

export function findInviteById(inviteId: string): InviteRecord | null {
  return (
    (db.prepare("SELECT * FROM org_invites WHERE invite_id = ?").get(inviteId) as
      | InviteRecord
      | undefined) ?? null
  );
}

export function createInvite(input: {
  orgId: string;
  email: string;
  role: Exclude<OrgRole, "owner">;
  invitedByUserId: string;
}): { record: InviteRecord; created: boolean } {
  // Avoid duplicate pending invites for the same email/org.
  const existing = db
    .prepare(
      "SELECT * FROM org_invites WHERE org_id = ? AND lower(email) = lower(?) AND accepted_at IS NULL",
    )
    .get(input.orgId, input.email) as InviteRecord | undefined;
  if (existing) return { record: existing, created: false };

  const id = `inv_${randomUUID()}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO org_invites (invite_id, org_id, email, role, invited_by_user_id, created_at, accepted_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`,
  ).run(id, input.orgId, input.email, input.role, input.invitedByUserId, now);
  return {
    record: {
      invite_id: id,
      org_id: input.orgId,
      email: input.email,
      role: input.role,
      invited_by_user_id: input.invitedByUserId,
      created_at: now,
      accepted_at: null,
    },
    created: true,
  };
}

export function revokeInvite(inviteId: string): void {
  db.prepare("DELETE FROM org_invites WHERE invite_id = ? AND accepted_at IS NULL").run(inviteId);
}

/** Mark the invite accepted and enroll the user as a member in a single txn. */
export function acceptInvite(inviteId: string, userId: string): MembershipRecord | null {
  const invite = findInviteById(inviteId);
  if (!invite || invite.accepted_at) return null;
  const now = new Date().toISOString();
  withTransaction(() => {
    db.prepare(
      "INSERT OR REPLACE INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, ?, COALESCE((SELECT created_at FROM memberships WHERE org_id = ? AND user_id = ?), ?))",
    ).run(invite.org_id, userId, invite.role, invite.org_id, userId, now);
    db.prepare("UPDATE org_invites SET accepted_at = ? WHERE invite_id = ?").run(now, inviteId);
  });
  return getMembership(invite.org_id, userId);
}
