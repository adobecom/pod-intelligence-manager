import type { Command } from "commander";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { platform } from "node:os";
import chalk from "chalk";
import { getBaseUrl, apiFetch, setAuthToken, setOrgSlug } from "../util.js";
import {
  generatePkce,
  generateState,
  exchangeCodeForToken,
  fetchProfile,
} from "../ims.js";
import {
  getImsEndpoints,
  ensureFreshToken,
  loadCredentials,
  saveCredentials,
  clearCredentials,
  getCredentialsPath,
  assertSecurePermissions,
  type Credentials,
  type ImsEnv,
} from "@pim/shared/auth";

interface CliConfigResponse {
  auth_mode?: "trust" | "ims";
  ims_client_id?: string;
  ims_env?: ImsEnv;
  ims_cli_client_id?: string;
  ims_cli_client_secret?: string;
  ims_cli_scopes?: string;
}

async function fetchCliConfig(baseUrl: string): Promise<CliConfigResponse> {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/cli-config`);
  if (!res.ok) throw new Error(`CLI config fetch failed: ${res.status}`);
  return (await res.json()) as CliConfigResponse;
}

/** Best-effort open the URL in the user's default browser. */
function openBrowser(url: string): void {
  const cmd =
    platform() === "darwin" ? "open" :
    platform() === "win32" ? "start" :
    "xdg-open";
  try {
    const child = spawn(cmd, [url], { stdio: "ignore", detached: true, shell: platform() === "win32" });
    child.unref();
  } catch {
    // fall through — caller prints the URL
  }
}

/**
 * Bind a local HTTP listener on an ephemeral port, return the port + a Promise
 * that resolves with the OAuth code once IMS redirects back to us. Rejects if
 * IMS returns an error query param or the expected `state` doesn't match.
 */
function startLoopbackListener(expectedState: string): Promise<{
  port: number;
  codePromise: Promise<string>;
  close: () => void;
}> {
  return new Promise((resolveServer, rejectServer) => {
    let resolveCode: (code: string) => void;
    let rejectCode: (err: Error) => void;
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
      reply.end(renderPage("Signed in", "You're signed in to PIM. You can close this tab."));
      resolveCode(code);
    });

    server.on("error", rejectServer);
    const PIM_CALLBACK_PORT = parseInt(process.env.PIM_CALLBACK_PORT ?? "9876", 10);
    server.listen(PIM_CALLBACK_PORT, "localhost", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        rejectServer(new Error("Failed to bind loopback port"));
        return;
      }
      resolveServer({
        port: addr.port,
        codePromise,
        close: () => server.close(),
      });
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

export function registerLoginCommand(program: Command): void {
  program
    .command("login")
    .description("Sign in with your Adobe account (opens browser). Writes ~/.pim/credentials.json.")
    .action(async () => {
      const baseUrl = getBaseUrl(program).replace(/\/$/, "");

      let cliConfig: CliConfigResponse;
      try {
        cliConfig = await fetchCliConfig(baseUrl);
      } catch (err) {
        console.error(chalk.red(`\n  Could not reach ${baseUrl}: ${err instanceof Error ? err.message : err}\n`));
        process.exit(1);
      }

      if (cliConfig.auth_mode === "trust") {
        console.log(chalk.yellow("\n  Server is in trust mode — no login required.\n"));
        return;
      }

      const clientId = process.env.PIM_IMS_CLIENT_ID ?? cliConfig.ims_cli_client_id ?? cliConfig.ims_client_id;
      const clientSecret = process.env.PIM_IMS_CLIENT_SECRET ?? cliConfig.ims_cli_client_secret;
      const imsEnv: ImsEnv = (process.env.PIM_IMS_ENV as ImsEnv) ?? cliConfig.ims_env ?? "stg1";
      if (!clientId) {
        console.error(
          chalk.red(
            "\n  Server did not advertise an IMS client_id.\n" +
              "  Set PIM_IMS_CLIENT_ID in your environment or fix server config.\n",
          ),
        );
        process.exit(1);
      }

      const pkce = generatePkce();
      const state = generateState();
      const scope =
        process.env.PIM_IMS_SCOPES ?? cliConfig.ims_cli_scopes ?? "AdobeID,openid";

      const listener = await startLoopbackListener(state);
      const redirectUri = `http://localhost:${listener.port}/callback`;

      const { authorize } = getImsEndpoints(imsEnv);
      const authUrl = new URL(authorize);
      authUrl.searchParams.set("client_id", clientId);
      authUrl.searchParams.set("scope", scope);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("code_challenge", pkce.challenge);
      authUrl.searchParams.set("code_challenge_method", "S256");
      authUrl.searchParams.set("state", state);

      console.log(chalk.cyan("\n  Opening browser to sign in with Adobe IMS…"));
      console.log(chalk.gray(`  If it doesn't open, paste this URL:\n  ${authUrl.toString()}\n`));
      openBrowser(authUrl.toString());

      let code: string;
      try {
        code = await listener.codePromise;
      } catch (err) {
        listener.close();
        console.error(chalk.red(`\n  Sign-in failed: ${err instanceof Error ? err.message : err}\n`));
        process.exit(1);
      }
      listener.close();

      let tokenResponse;
      try {
        tokenResponse = await exchangeCodeForToken({
          env: imsEnv,
          clientId,
          clientSecret,
          code,
          verifier: pkce.verifier,
          redirectUri,
        });
      } catch (err) {
        console.error(chalk.red(`\n  Token exchange failed: ${err instanceof Error ? err.message : err}\n`));
        process.exit(1);
      }

      const profile = await fetchProfile({ env: imsEnv, clientId, accessToken: tokenResponse.access_token });

      const creds: Credentials = {
        access_token: tokenResponse.access_token,
        refresh_token: tokenResponse.refresh_token,
        expires_at: Date.now() + tokenResponse.expires_in * 1000,
        email: profile.email,
        ims_user_id: profile.userId,
        client_id: clientId,
        ims_env: imsEnv,
      };
      saveCredentials(creds);

      console.log(chalk.green(`\n  Signed in as ${profile.email ?? profile.userId ?? "Adobe user"}.`));
      console.log(chalk.gray(`  Credentials saved to ${getCredentialsPath()} (chmod 600).\n`));
    });

  program
    .command("logout")
    .description("Delete ~/.pim/credentials.json and clear the local IMS session.")
    .action(() => {
      const removed = clearCredentials();
      if (removed) {
        console.log(chalk.green("\n  Signed out. Credentials file deleted.\n"));
      } else {
        console.log(chalk.yellow("\n  No credentials file found — already signed out.\n"));
      }
    });

  program
    .command("whoami")
    .description("Show the currently signed-in Adobe user and default org.")
    .action(async () => {
      const baseUrl = getBaseUrl(program).replace(/\/$/, "");
      assertSecurePermissions();

      let token: string | null = null;
      const creds = loadCredentials();
      if (creds) {
        const fresh = await ensureFreshToken(creds);
        token = fresh.access_token;
      }

      // Prime the module getters used by apiFetch so /api/me carries auth.
      setAuthToken(token);
      // whoami doesn't need an org scope, but if the user has a default slug
      // pinned, we keep it primed for the downstream GET in case servers ever
      // require it on the me endpoint.
      setOrgSlug(null);

      try {
        const res = await apiFetch(`${baseUrl}/api/me`);
        if (res.status === 401) {
          console.log(chalk.yellow("\n  Not signed in. Run 'pim login' to get started.\n"));
          process.exit(1);
        }
        if (!res.ok) {
          console.error(chalk.red(`\n  Server returned ${res.status}\n`));
          process.exit(1);
        }
        const body = (await res.json()) as {
          user: { email: string; display_name: string | null };
          orgs: Array<{ slug: string; name: string; role: string }>;
        };
        console.log("");
        console.log(`  ${chalk.bold("Email:")} ${body.user.email}`);
        if (body.user.display_name) console.log(`  ${chalk.bold("Name:")}  ${body.user.display_name}`);
        if (body.orgs.length === 0) {
          console.log(chalk.gray("  No orgs yet — visit the PIM web UI to create one or accept an invite."));
        } else {
          console.log(`  ${chalk.bold("Orgs:")}`);
          for (const o of body.orgs) {
            console.log(`    - ${o.name} (${o.slug}) — ${o.role}`);
          }
        }
        console.log("");
      } catch (err) {
        console.error(chalk.red(`\n  ${err instanceof Error ? err.message : err}\n`));
        process.exit(1);
      }
    });
}

export { ensureFreshToken } from "@pim/shared/auth";
