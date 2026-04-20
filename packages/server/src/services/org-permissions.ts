import type { OrgRole } from "./orgs.js";

const ROLE_RANK: Record<OrgRole, number> = { owner: 3, admin: 2, member: 1 };

export function atLeast(role: OrgRole, required: OrgRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[required];
}

export function canInvite(role: OrgRole): boolean {
  return atLeast(role, "admin");
}

export function canRemoveMember(role: OrgRole): boolean {
  return atLeast(role, "admin");
}

export function canUpdateMemberRole(role: OrgRole): boolean {
  return atLeast(role, "admin");
}

export function canEditOrg(role: OrgRole): boolean {
  return atLeast(role, "admin");
}

export function canDeleteOrg(role: OrgRole): boolean {
  return role === "owner";
}
