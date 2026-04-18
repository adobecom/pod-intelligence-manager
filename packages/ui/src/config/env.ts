/**
 * Vite env vars live under `import.meta.env`. This module narrows the raw
 * strings and exposes defaults so call sites don't have to repeat fallbacks.
 *
 * VITE_AUTH_MODE switches the whole frontend: in `trust` we stub a `dev@local`
 * identity and skip IMS entirely; in `ims` we load imslib and redirect to
 * Adobe sign-in. The server's AUTH_MODE must match or requests will 401.
 */

export type AuthMode = "trust" | "ims";
export type ImsEnvironment = "prod" | "stg1";

interface ViteImportMetaEnv {
  VITE_AUTH_MODE?: string;
  VITE_IMS_CLIENT_ID?: string;
  VITE_IMS_SCOPES?: string;
  VITE_IMS_ENV?: string;
  MODE?: string;
  DEV?: boolean;
}

const raw = (import.meta as unknown as { env: ViteImportMetaEnv }).env ?? {};

const authMode: AuthMode = raw.VITE_AUTH_MODE === "ims" ? "ims" : "trust";

const imsEnv: ImsEnvironment = raw.VITE_IMS_ENV === "prod" ? "prod" : "stg1";

const imsClientId = raw.VITE_IMS_CLIENT_ID ?? "";
const imsScopes =
  raw.VITE_IMS_SCOPES ?? "AdobeID,openid,read_organizations,additional_info.projectedProductContext";

export const env = {
  authMode,
  imsEnv,
  imsClientId,
  imsScopes,
  isDevelopment: () => raw.DEV === true || raw.MODE !== "production",
};
