/**
 * CLI-only Adobe IMS OAuth helpers: PKCE + code exchange + profile fetch.
 * Generic IMS bits (endpoints, refresh, TokenResponse) live in @pim/shared/auth
 * so the MCP server can share them without pulling in the OAuth flow code.
 */

import { randomBytes, createHash } from "node:crypto";
import { getImsEndpoints, type ImsEnv, type TokenResponse } from "@pim/shared/auth";

export interface PkcePair {
  verifier: string;
  challenge: string;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function generatePkce(): PkcePair {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function generateState(): string {
  return base64url(randomBytes(16));
}

export async function exchangeCodeForToken(params: {
  env: ImsEnv;
  clientId: string;
  clientSecret?: string;
  code: string;
  verifier: string;
  redirectUri: string;
}): Promise<TokenResponse> {
  const { token } = getImsEndpoints(params.env);
  const bodyParams: Record<string, string> = {
    grant_type: "authorization_code",
    client_id: params.clientId,
    code: params.code,
    code_verifier: params.verifier,
    redirect_uri: params.redirectUri,
  };
  if (params.clientSecret) bodyParams.client_secret = params.clientSecret;
  const body = new URLSearchParams(bodyParams);
  const res = await fetch(token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`IMS token exchange failed (${res.status}): ${text}`);
  }
  return (await res.json()) as TokenResponse;
}

export async function fetchProfile(params: {
  env: ImsEnv;
  clientId: string;
  accessToken: string;
}): Promise<{ userId?: string; email?: string; displayName?: string }> {
  const { profile } = getImsEndpoints(params.env);
  const url = `${profile}?client_id=${encodeURIComponent(params.clientId)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${params.accessToken}` },
  });
  if (!res.ok) return {};
  const body = (await res.json()) as Record<string, unknown>;
  return {
    userId: typeof body.userId === "string" ? body.userId : undefined,
    email: typeof body.email === "string" ? body.email : undefined,
    displayName: typeof body.displayName === "string" ? body.displayName : undefined,
  };
}

export { getImsEndpoints, type ImsEnv, type TokenResponse } from "@pim/shared/auth";
