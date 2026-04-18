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

function expectedIssuer(env: "prod" | "stg1"): string {
  return process.env.IMS_EXPECTED_ISSUER
    ?? (env === "prod" ? "https://ims-na1.adobelogin.com" : "https://ims-na1-stg1.adobelogin.com");
}

let _jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks() {
  if (!_jwks) _jwks = createRemoteJWKSet(jwksUrl(imsEnv()));
  return _jwks;
}

/**
 * Verify an IMS-issued JWT. Throws if signature, issuer, audience or expiry are bad.
 * IMS access tokens carry `user_id` (IMS profile id), `email` (for openid scope),
 * and `client_id` (= the expected audience).
 */
export async function verifyImsToken(token: string): Promise<ImsClaims> {
  const audience = process.env.IMS_EXPECTED_AUDIENCE ?? process.env.IMS_CLIENT_ID;
  const { payload } = await jwtVerify(token, getJwks(), {
    issuer: expectedIssuer(imsEnv()),
    // IMS JWT access tokens sometimes set `aud` to the client_id, sometimes to the
    // IMS endpoint itself. Only enforce audience when it's explicitly configured.
    ...(audience ? { audience } : {}),
  });
  const claims = payload as ImsClaims;
  if (process.env.IMS_REQUIRE_CLIENT_ID_MATCH === "true" && process.env.IMS_CLIENT_ID) {
    if (claims.client_id && claims.client_id !== process.env.IMS_CLIENT_ID) {
      throw new Error("IMS token client_id does not match IMS_CLIENT_ID");
    }
  }
  return claims;
}
