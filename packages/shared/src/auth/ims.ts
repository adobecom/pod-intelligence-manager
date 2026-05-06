export type ImsEnv = "stg1" | "prod";

export interface ImsEndpoints {
  authorize: string;
  token: string;
  profile: string;
}

export function getImsEndpoints(env: ImsEnv): ImsEndpoints {
  const host = env === "prod" ? "ims-na1.adobelogin.com" : "ims-na1-stg1.adobelogin.com";
  return {
    authorize: `https://${host}/ims/authorize/v2`,
    token: `https://${host}/ims/token/v3`,
    profile: `https://${host}/ims/profile/v1`,
  };
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in: number;
}

export async function refreshAccessToken(params: {
  env: ImsEnv;
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
}): Promise<TokenResponse> {
  const { token } = getImsEndpoints(params.env);
  const bodyParams: Record<string, string> = {
    grant_type: "refresh_token",
    client_id: params.clientId,
    refresh_token: params.refreshToken,
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
    throw new Error(`IMS token refresh failed (${res.status}): ${text}`);
  }
  return (await res.json()) as TokenResponse;
}
