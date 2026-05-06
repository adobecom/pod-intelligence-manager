import { type Credentials, isExpired, saveCredentials } from "./credentials.js";
import { refreshAccessToken } from "./ims.js";

/**
 * If the stored token is within 60s of expiry, swap it for a fresh one using
 * the refresh token. Persists the rotated credentials and returns them.
 * Throws if the token is expired and no refresh token is available.
 */
export async function ensureFreshToken(creds: Credentials): Promise<Credentials> {
  if (!isExpired(creds)) return creds;
  if (!creds.refresh_token) {
    throw new Error("Access token expired and no refresh token available — run 'pim login' again");
  }
  const refreshed = await refreshAccessToken({
    env: creds.ims_env,
    clientId: creds.client_id,
    clientSecret: creds.client_secret,
    refreshToken: creds.refresh_token,
  });
  const next: Credentials = {
    ...creds,
    access_token: refreshed.access_token,
    refresh_token: refreshed.refresh_token ?? creds.refresh_token,
    expires_at: Date.now() + refreshed.expires_in * 1000,
  };
  saveCredentials(next);
  return next;
}
