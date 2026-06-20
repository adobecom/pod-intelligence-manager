import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import db, { withTransaction } from "../db/connection.js";
import type { UserRecord } from "./users.js";

export const SERVICE_TOKEN_PREFIX = "pim_svc_";
const LAST_USED_THROTTLE_MS = 60_000;

export const SERVICE_TOKEN_SCOPES = [
  "project:read",
  "project-context:read",
  "knowledge:read",
  "context-search:read",
  "agent-session:read",
  "agent-session:write",
  "agent-memory:curate",
  "context-update:write",
  "org-config:read",
] as const;

export type ServiceTokenScope = typeof SERVICE_TOKEN_SCOPES[number];

export interface ServiceTokenAuthMetadata {
  kind: "service_token";
  tokenId: string;
  servicePrincipalId: string;
  scopes: ServiceTokenScope[];
  orgId: string;
  projectId?: string;
  podId?: string;
}

export interface VerifiedServiceToken {
  user: UserRecord;
  auth: ServiceTokenAuthMetadata;
}

export interface ServiceTokenListItem {
  token_id: string;
  service_principal_id: string;
  name: string;
  token_prefix: string;
  scopes: ServiceTokenScope[];
  project_id: string | null;
  pod_id: string | null;
  expires_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

export interface CreatedServiceToken extends ServiceTokenListItem {
  token: string;
}

export class ServiceTokenError extends Error {
  constructor(message: string, public statusCode = 400) {
    super(message);
    this.name = "ServiceTokenError";
  }
}

interface ServiceTokenRow {
  token_id: string;
  service_principal_id: string;
  token_prefix: string;
  token_hash: string;
  scopes_json: string;
  project_id: string | null;
  pod_id: string | null;
  expires_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
  created_by_user_id: string;
}

interface ServicePrincipalRow {
  service_principal_id: string;
  user_id: string;
  org_id: string;
  name: string;
  created_by_user_id: string;
  created_at: string;
  disabled_at: string | null;
}

type JoinedTokenRow = ServiceTokenRow & {
  name: string;
  org_id: string;
  disabled_at: string | null;
};

const scopeSet = new Set<string>(SERVICE_TOKEN_SCOPES);

function randomHex(byteLength: number): string {
  return randomBytes(byteLength).toString("hex");
}

function id(prefix: "svcprn" | "svctok"): string {
  return `${prefix}${randomHex(8)}`;
}

export function isServiceTokenValue(token: string | undefined | null): boolean {
  return Boolean(token?.startsWith(SERVICE_TOKEN_PREFIX));
}

export function parseServiceToken(token: string): { tokenId: string; secret: string } | null {
  if (!token.startsWith(SERVICE_TOKEN_PREFIX)) return null;
  const rest = token.slice(SERVICE_TOKEN_PREFIX.length);
  const parts = rest.split("_");
  if (parts.length !== 2) return null;
  const [tokenId, secret] = parts;
  if (!/^svctok[0-9a-f]+$/.test(tokenId)) return null;
  if (!/^[0-9a-f]+$/.test(secret)) return null;
  return { tokenId, secret };
}

function hashSecret(secret: string): string {
  const pepper = process.env.PIM_SERVICE_TOKEN_PEPPER?.trim();
  if (pepper) {
    return createHmac("sha256", pepper).update(secret).digest("hex");
  }
  return createHash("sha256").update(secret).digest("hex");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b)) return false;
  const aBuf = Buffer.from(a, "hex");
  const bBuf = Buffer.from(b, "hex");
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function parseScopes(raw: string): ServiceTokenScope[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((scope): scope is ServiceTokenScope => typeof scope === "string" && scopeSet.has(scope));
}

function normalizeScopes(scopes: string[]): ServiceTokenScope[] {
  const normalized = Array.from(new Set(scopes.map((scope) => scope.trim()).filter(Boolean)));
  if (normalized.length === 0) {
    throw new ServiceTokenError("At least one service-token scope is required");
  }
  const invalid = normalized.filter((scope) => !scopeSet.has(scope));
  if (invalid.length > 0) {
    throw new ServiceTokenError(`Invalid service-token scope: ${invalid.join(", ")}`);
  }
  return normalized as ServiceTokenScope[];
}

function toListItem(row: JoinedTokenRow): ServiceTokenListItem {
  return {
    token_id: row.token_id,
    service_principal_id: row.service_principal_id,
    name: row.name,
    token_prefix: row.token_prefix,
    scopes: parseScopes(row.scopes_json),
    project_id: row.project_id,
    pod_id: row.pod_id,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    last_used_at: row.last_used_at,
    created_at: row.created_at,
  };
}

export function createServiceToken(input: {
  orgId: string;
  name: string;
  scopes: string[];
  createdByUserId: string;
  projectId?: string | null;
  podId?: string | null;
  expiresAt: string;
}): CreatedServiceToken {
  const name = input.name.trim();
  if (!name) throw new ServiceTokenError("Service-token name is required");
  if (input.projectId && input.podId) {
    throw new ServiceTokenError("A service token cannot be both project-bound and pod-bound");
  }
  const expiresMs = Date.parse(input.expiresAt);
  if (!Number.isFinite(expiresMs) || expiresMs <= Date.now()) {
    throw new ServiceTokenError("Service-token expiry must be in the future");
  }

  const scopes = normalizeScopes(input.scopes);
  const projectId = input.projectId?.trim() || null;
  const podId = input.podId?.trim() || null;
  const now = new Date().toISOString();
  const servicePrincipalId = id("svcprn");
  const tokenId = id("svctok");
  const secret = randomHex(32);
  const rawToken = `${SERVICE_TOKEN_PREFIX}${tokenId}_${secret}`;
  const tokenPrefix = `${SERVICE_TOKEN_PREFIX}${tokenId}`;
  const userId = `user_svc_${servicePrincipalId}`;

  return withTransaction(() => {
    if (projectId) {
      const project = db
        .prepare("SELECT project_id FROM projects WHERE project_id = ? AND org_id = ?")
        .get(projectId, input.orgId);
      if (!project) throw new ServiceTokenError(`Project not found: ${projectId}`, 404);
    }
    if (podId) {
      const pod = db
        .prepare("SELECT pod_id FROM pods WHERE pod_id = ? AND org_id = ?")
        .get(podId, input.orgId);
      if (!pod) throw new ServiceTokenError(`Pod not found: ${podId}`, 404);
    }

    db.prepare(
      `INSERT INTO users (user_id, ims_user_id, email, display_name, is_service, created_at, last_login_at)
       VALUES (?, NULL, ?, ?, 1, ?, NULL)`,
    ).run(
      userId,
      `service+${servicePrincipalId}@pim.local`,
      `Service: ${name}`,
      now,
    );
    db.prepare(
      `INSERT INTO service_principals
         (service_principal_id, user_id, org_id, name, created_by_user_id, created_at, disabled_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    ).run(servicePrincipalId, userId, input.orgId, name, input.createdByUserId, now);
    db.prepare(
      "INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)",
    ).run(input.orgId, userId, now);
    db.prepare(
      `INSERT INTO service_tokens
         (token_id, service_principal_id, token_prefix, token_hash, scopes_json, project_id, pod_id,
          expires_at, revoked_at, last_used_at, created_at, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    ).run(
      tokenId,
      servicePrincipalId,
      tokenPrefix,
      hashSecret(secret),
      JSON.stringify(scopes),
      projectId,
      podId,
      input.expiresAt,
      now,
      input.createdByUserId,
    );

    return {
      token: rawToken,
      token_id: tokenId,
      service_principal_id: servicePrincipalId,
      name,
      token_prefix: tokenPrefix,
      scopes,
      project_id: projectId,
      pod_id: podId,
      expires_at: input.expiresAt,
      revoked_at: null,
      last_used_at: null,
      created_at: now,
    };
  });
}

export function listServiceTokens(orgId: string): ServiceTokenListItem[] {
  const rows = db
    .prepare(
      `SELECT
         t.*,
         sp.name AS name,
         sp.org_id AS org_id,
         sp.disabled_at AS disabled_at
       FROM service_tokens t
       INNER JOIN service_principals sp ON sp.service_principal_id = t.service_principal_id
       WHERE sp.org_id = ?
       ORDER BY t.created_at DESC`,
    )
    .all(orgId) as unknown as JoinedTokenRow[];
  return rows.map(toListItem);
}

export function revokeServiceToken(orgId: string, tokenId: string): boolean {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE service_tokens
       SET revoked_at = COALESCE(revoked_at, ?)
       WHERE token_id = ?
         AND service_principal_id IN (
           SELECT service_principal_id FROM service_principals WHERE org_id = ?
         )`,
    )
    .run(now, tokenId, orgId);
  return result.changes > 0;
}

function maybeTouchLastUsed(token: ServiceTokenRow): void {
  const nowMs = Date.now();
  const lastMs = token.last_used_at ? Date.parse(token.last_used_at) : 0;
  if (Number.isFinite(lastMs) && nowMs - lastMs < LAST_USED_THROTTLE_MS) return;
  db.prepare("UPDATE service_tokens SET last_used_at = ? WHERE token_id = ?").run(
    new Date(nowMs).toISOString(),
    token.token_id,
  );
}

export function verifyServiceToken(rawToken: string): VerifiedServiceToken | null {
  const parsed = parseServiceToken(rawToken);
  if (!parsed) return null;

  const token = db
    .prepare("SELECT * FROM service_tokens WHERE token_id = ?")
    .get(parsed.tokenId) as unknown as ServiceTokenRow | undefined;
  if (!token) return null;
  if (token.revoked_at) return null;
  const expiresMs = Date.parse(token.expires_at);
  if (!Number.isFinite(expiresMs) || expiresMs <= Date.now()) return null;

  const presentedHash = hashSecret(parsed.secret);
  if (!timingSafeEqualHex(token.token_hash, presentedHash)) return null;

  const principal = db
    .prepare("SELECT * FROM service_principals WHERE service_principal_id = ?")
    .get(token.service_principal_id) as unknown as ServicePrincipalRow | undefined;
  if (!principal || principal.disabled_at) return null;

  const user = db
    .prepare("SELECT * FROM users WHERE user_id = ? AND is_service = 1")
    .get(principal.user_id) as unknown as UserRecord | undefined;
  if (!user) return null;

  maybeTouchLastUsed(token);

  return {
    user: {
      user_id: user.user_id,
      ims_user_id: user.ims_user_id,
      email: user.email,
      display_name: user.display_name,
      is_service: Number(user.is_service ?? 1),
      created_at: user.created_at,
      last_login_at: user.last_login_at,
    },
    auth: {
      kind: "service_token",
      tokenId: token.token_id,
      servicePrincipalId: token.service_principal_id,
      scopes: parseScopes(token.scopes_json),
      orgId: principal.org_id,
      ...(token.project_id ? { projectId: token.project_id } : {}),
      ...(token.pod_id ? { podId: token.pod_id } : {}),
    },
  };
}
