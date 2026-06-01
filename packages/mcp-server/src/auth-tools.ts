import { createServer } from "node:http";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  loadCredentials,
  saveCredentials,
  ensureFreshToken,
  generatePkce,
  generateState,
  exchangeCodeForToken,
  fetchImsProfile,
  getImsEndpoints,
  type ImsEnv,
  type Credentials,
} from "@pim/shared/auth";
import { getOrgSelectionStatus, type OrgSelectionStatus } from "./api.js";

const API_BASE = process.env.PIM_API_URL ?? "http://localhost:4000";
const CALLBACK_PORT = parseInt(process.env.PIM_CALLBACK_PORT ?? "9876", 10);

interface CliConfigResponse {
  auth_mode?: "trust" | "ims";
  ims_client_id?: string;
  ims_env?: ImsEnv;
  ims_cli_client_id?: string;
  ims_cli_client_secret?: string;
  ims_cli_scopes?: string;
}

interface PendingAuth {
  clientId: string;
  clientSecret?: string;
  imsEnv: ImsEnv;
  verifier: string;
  redirectUri: string;
  codePromise: Promise<string>;
  close: () => void;
}

// Module-level: persists across tool calls within one MCP server process.
let pendingAuth: PendingAuth | null = null;

function startLoopbackListener(expectedState: string): Promise<{
  codePromise: Promise<string>;
  close: () => void;
}> {
  return new Promise((resolveServer, rejectServer) => {
    let resolveCode!: (code: string) => void;
    let rejectCode!: (err: Error) => void;
    const codePromise = new Promise<string>((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });

    const server = createServer((req, reply) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== "/callback") {
        reply.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get("error");
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");

      if (error) {
        reply.writeHead(400, { "Content-Type": "text/html" });
        reply.end(renderPage("Sign-in failed", `Adobe IMS returned an error: ${error}. You can close this tab.`));
        rejectCode(new Error(`IMS authorization error: ${error}`));
        return;
      }
      if (state !== expectedState) {
        reply.writeHead(400, { "Content-Type": "text/html" });
        reply.end(renderPage("Sign-in failed", "State mismatch — possible CSRF. You can close this tab."));
        rejectCode(new Error("OAuth state mismatch"));
        return;
      }
      if (!code) {
        reply.writeHead(400, { "Content-Type": "text/html" });
        reply.end(renderPage("Sign-in failed", "No authorization code returned. You can close this tab."));
        rejectCode(new Error("No authorization code returned"));
        return;
      }

      reply.writeHead(200, { "Content-Type": "text/html" });
      reply.end(renderPage("Signed in", "You're signed in to PIM. You can close this tab and return to Claude."));
      resolveCode(code);
    });

    server.on("error", rejectServer);
    server.listen(CALLBACK_PORT, "localhost", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        rejectServer(new Error("Failed to bind loopback port"));
        return;
      }
      resolveServer({ codePromise, close: () => server.close() });
    });
  });
}

function renderPage(title: string, message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title} - PIM</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f5f5}
.card{background:white;padding:32px 48px;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.1);text-align:center}
h1{margin:0 0 12px;color:#e1251b}</style></head><body>
<div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`;
}

const json = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

function withOrgStatus<T extends Record<string, unknown>>(
  data: T,
  orgStatus: OrgSelectionStatus,
): T & {
  active_org_slug: string | null;
  effective_source: OrgSelectionStatus["effective_source"];
  needs_org_selection?: boolean;
  no_orgs_available?: boolean;
  orgs: OrgSelectionStatus["orgs"];
  org_status: OrgSelectionStatus;
} {
  return {
    ...data,
    active_org_slug: orgStatus.active_org_slug,
    effective_source: orgStatus.effective_source,
    ...(orgStatus.needs_org_selection ? { needs_org_selection: true } : {}),
    ...(orgStatus.no_orgs_available ? { no_orgs_available: true } : {}),
    orgs: orgStatus.orgs,
    org_status: orgStatus,
  };
}

export function registerAuthTools(server: McpServer): void {
  server.tool(
    "authenticate",
    "Start Adobe IMS OAuth sign-in for PIM. Checks for existing valid credentials first — if already signed in, returns immediately. Otherwise fetches server config, starts a local callback listener on port 9876 (or PIM_CALLBACK_PORT), and returns the Adobe sign-in URL for the user to open. Call complete_authentication after the user confirms they have signed in.",
    {},
    async () => {
      // Clean up any stale pending auth
      if (pendingAuth) {
        try { pendingAuth.close(); } catch {}
        pendingAuth = null;
      }

      // Check for existing valid credentials
      const existing = loadCredentials();
      if (existing) {
        try {
          const fresh = await ensureFreshToken(existing);
          const profile = await fetchImsProfile({
            env: fresh.ims_env,
            clientId: fresh.client_id,
            accessToken: fresh.access_token,
          });
          const orgStatus = await getOrgSelectionStatus();
          return json(withOrgStatus({
            status: "already_authenticated",
            email: profile.email ?? existing.email,
            message: orgStatus.needs_org_selection
              ? "Already signed in. Choose an org with set_active_org before using org-scoped tools."
              : "Already signed in. No need to call complete_authentication.",
          }, orgStatus));
        } catch {
          // Token dead — fall through to fresh login
        }
      }

      // Fetch CLI config (includes ims_cli_client_secret). /api/health intentionally
      // omits the secret per the security split documented in server/src/index.ts.
      let cliConfig: CliConfigResponse;
      try {
        const res = await fetch(`${API_BASE}/api/cli-config`);
        if (!res.ok) throw new Error(`status ${res.status}`);
        cliConfig = (await res.json()) as CliConfigResponse;
      } catch (err) {
        throw new Error(
          `Cannot reach PIM server at ${API_BASE}: ${err instanceof Error ? err.message : err}. ` +
          "Set PIM_API_URL if the server is not at the default address.",
        );
      }

      if (cliConfig.auth_mode === "trust") {
        const orgStatus = await getOrgSelectionStatus();
        return json(withOrgStatus({
          status: "trust_mode",
          message: orgStatus.needs_org_selection
            ? "Server is in trust mode — authentication is not required. Choose an org with set_active_org before using org-scoped tools."
            : "Server is in trust mode — authentication is not required.",
        }, orgStatus));
      }

      const clientId = process.env.PIM_IMS_CLIENT_ID ?? cliConfig.ims_cli_client_id ?? cliConfig.ims_client_id;
      if (!clientId) {
        throw new Error(
          "Server did not advertise an IMS client_id. " +
          "Set PIM_IMS_CLIENT_ID in the MCP server environment, or set IMS_CLI_CLIENT_ID on the PIM server.",
        );
      }

      const clientSecret = process.env.PIM_IMS_CLIENT_SECRET ?? cliConfig.ims_cli_client_secret;
      const imsEnv: ImsEnv = (process.env.PIM_IMS_ENV as ImsEnv) ?? cliConfig.ims_env ?? "stg1";
      const scope = process.env.PIM_IMS_SCOPES ?? cliConfig.ims_cli_scopes ?? "AdobeID,openid";

      const pkce = generatePkce();
      const state = generateState();

      let listener: { codePromise: Promise<string>; close: () => void };
      try {
        listener = await startLoopbackListener(state);
      } catch (err) {
        throw new Error(
          `Failed to start local callback listener on port ${CALLBACK_PORT}: ${err instanceof Error ? err.message : err}. ` +
          "Set PIM_CALLBACK_PORT to use a different port.",
        );
      }

      const redirectUri = `http://localhost:${CALLBACK_PORT}/callback`;
      const { authorize } = getImsEndpoints(imsEnv);
      const authUrl = new URL(authorize);
      authUrl.searchParams.set("client_id", clientId);
      authUrl.searchParams.set("scope", scope);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("code_challenge", pkce.challenge);
      authUrl.searchParams.set("code_challenge_method", "S256");
      authUrl.searchParams.set("state", state);

      pendingAuth = {
        clientId,
        clientSecret,
        imsEnv,
        verifier: pkce.verifier,
        redirectUri,
        codePromise: listener.codePromise,
        close: listener.close,
      };

      return json({
        status: "pending",
        auth_url: authUrl.toString(),
        message:
          "Open the URL above in your browser and sign in with your Adobe account. " +
          "Once the browser shows the 'Signed in' page, tell Claude and call complete_authentication.",
      });
    },
  );

  server.tool(
    "complete_authentication",
    "Complete Adobe IMS OAuth sign-in after the user has visited the URL returned by authenticate and signed in. Waits for the browser callback (up to timeout_seconds), exchanges the authorization code for tokens, and writes credentials to ~/.pim/credentials.json.",
    {
      timeout_seconds: z
        .number()
        .int()
        .min(5)
        .max(300)
        .optional()
        .describe("Seconds to wait for the browser callback before giving up (default 120)."),
    },
    async ({ timeout_seconds = 120 }) => {
      if (!pendingAuth) {
        throw new Error("No pending authentication session. Call authenticate first.");
      }

      const auth = pendingAuth;

      let code: string;
      try {
        code = await Promise.race([
          auth.codePromise,
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`Timed out after ${timeout_seconds}s — the browser callback was not received.`)),
              timeout_seconds * 1000,
            ),
          ),
        ]);
      } catch (err) {
        auth.close();
        pendingAuth = null;
        throw new Error(`Authentication failed: ${err instanceof Error ? err.message : err}`);
      }

      auth.close();
      pendingAuth = null;

      const tokenResponse = await exchangeCodeForToken({
        env: auth.imsEnv,
        clientId: auth.clientId,
        clientSecret: auth.clientSecret,
        code,
        verifier: auth.verifier,
        redirectUri: auth.redirectUri,
      });

      const profile = await fetchImsProfile({
        env: auth.imsEnv,
        clientId: auth.clientId,
        accessToken: tokenResponse.access_token,
      });

      const creds: Credentials = {
        access_token: tokenResponse.access_token,
        refresh_token: tokenResponse.refresh_token,
        expires_at: Date.now() + tokenResponse.expires_in * 1000,
        email: profile.email,
        ims_user_id: profile.userId,
        client_id: auth.clientId,
        client_secret: auth.clientSecret,
        ims_env: auth.imsEnv,
      };
      saveCredentials(creds);
      const orgStatus = await getOrgSelectionStatus();

      return json(withOrgStatus({
        status: "success",
        email: profile.email ?? profile.userId ?? "Adobe user",
        message: orgStatus.needs_org_selection
          ? `Signed in as ${profile.email ?? profile.userId ?? "Adobe user"}. Credentials saved to ~/.pim/credentials.json. Choose an org with set_active_org before using org-scoped tools.`
          : `Signed in as ${profile.email ?? profile.userId ?? "Adobe user"}. Credentials saved to ~/.pim/credentials.json.`,
      }, orgStatus));
    },
  );
}
