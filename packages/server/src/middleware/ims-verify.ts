import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export interface ImsClaims extends JWTPayload {
  user_id?: string;
  email?: string;
  name?: string;
  client_id?: string;
  type?: string;
  scope?: string;
  as?: string;
}

function imsEnv(): "prod" | "stg1" {
  return (process.env.IMS_ENV ?? "stg1") === "prod" ? "prod" : "stg1";
}

function jwksUrl(env: "prod" | "stg1"): URL {
  return env === "prod"
    ? new URL("https://ims-na1.adobelogin.com/ims/keys")
    : new URL("https://ims-na1-stg1.adobelogin.com/ims/keys");
}

function profileUrl(env: "prod" | "stg1"): string {
  return env === "prod"
    ? "https://ims-na1.adobelogin.com/ims/profile/v1"
    : "https://ims-na1-stg1.adobelogin.com/ims/profile/v1";
}

const _jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function getJwks() {
  const env = imsEnv();
  if (!_jwksCache.has(env)) _jwksCache.set(env, createRemoteJWKSet(jwksUrl(env)));
  return _jwksCache.get(env)!;
}

async function fetchImsProfile(token: string, env: "prod" | "stg1"): Promise<{ email?: string; displayName?: string; userId?: string }> {
  const res = await fetch(profileUrl(env), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`IMS profile fetch failed: ${res.status}`);
  return res.json() as Promise<{ email?: string; displayName?: string; userId?: string }>;
}

/**
 * Verify an IMS-issued JWT. Throws if signature or expiry are bad.
 * IMS stg1 access tokens omit the standard `iss` claim (they use `as` instead),
 * so issuer validation is skipped — JWKS signature check provides the security guarantee.
 * Email is not embedded in IMS access tokens; it is fetched from the profile endpoint.
 */
export async function verifyImsToken(token: string): Promise<ImsClaims> {
  const env = imsEnv();
  const { payload } = await jwtVerify(token, getJwks(), {
    clockTolerance: 60,
  });
  const claims = payload as ImsClaims;

  // Fail-closed client_id check: if IMS_CLIENT_ID is set, the token MUST carry a
  // matching client_id claim. An absent claim is rejected, not silently passed.
  // Opt out with IMS_REQUIRE_CLIENT_ID_MATCH=false when clients intentionally differ.
  const requireClientMatch =
    process.env.IMS_REQUIRE_CLIENT_ID_MATCH !== "false" && !!process.env.IMS_CLIENT_ID;
  if (requireClientMatch) {
    if (!claims.client_id || claims.client_id !== process.env.IMS_CLIENT_ID) {
      throw new Error("IMS token client_id missing or does not match IMS_CLIENT_ID");
    }
  }

  if (!claims.email || !claims.user_id) {
    const profile = await fetchImsProfile(token, env);
    if (!claims.email && profile.email) claims.email = profile.email;
    if (!claims.user_id && profile.userId) claims.user_id = profile.userId;
    if (!claims.name && profile.displayName) claims.name = profile.displayName;
  }

  // Fail-closed: if email is still missing after the profile fetch, reject rather
  // than silently letting the request through without a domain check.
  if (!claims.email) {
    throw new Error("IMS token has no email — profile fetch failed or token has no email claim");
  }

  // Reject non-Adobe accounts. Override with IMS_ALLOWED_EMAIL_DOMAIN=@example.com.
  const allowedDomain = (process.env.IMS_ALLOWED_EMAIL_DOMAIN ?? "@adobe.com").toLowerCase();
  if (!claims.email.toLowerCase().endsWith(allowedDomain)) {
    throw new Error(`Email domain not permitted: ${claims.email}`);
  }

  return claims;
}
