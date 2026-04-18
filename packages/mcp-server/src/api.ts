import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  loadCredentials,
  ensureFreshToken,
  assertSecurePermissions,
  type Credentials,
} from "@pim/shared/auth";

const API_BASE = process.env.PIM_API_URL ?? "http://localhost:4000";

interface HealthSnapshot {
  authMode: "trust" | "ims";
}

/**
 * MCP runs out-of-process (spawned by Claude Desktop) so we can't do an
 * interactive OAuth flow here. We read `~/.pim/credentials.json` written by
 * `pim login`, refresh on expiry, and inject Authorization + X-Pim-Org on
 * every call. In trust mode the server ignores the headers entirely.
 */

let healthCache: HealthSnapshot | null = null;
let healthPromise: Promise<HealthSnapshot> | null = null;

/**
 * Probe the server's /api/health once per process and remember the auth mode.
 * Only caches successful responses — a transient network blip won't lock the
 * MCP into a fallback mode for its entire lifetime. On failure we treat the
 * call as trust mode for this request but retry the probe next time.
 */
async function getHealth(): Promise<HealthSnapshot> {
  if (healthCache) return healthCache;
  if (healthPromise) return healthPromise;
  const attempt = (async () => {
    const res = await fetch(`${API_BASE}/api/health`);
    if (!res.ok) throw new Error(`health ${res.status}`);
    const body = (await res.json()) as { auth_mode?: "trust" | "ims" };
    const snapshot: HealthSnapshot = { authMode: body.auth_mode === "ims" ? "ims" : "trust" };
    healthCache = snapshot;
    return snapshot;
  })();
  healthPromise = attempt.catch(() => {
    // Drop the cached promise so the next call retries. The current call falls
    // back to trust mode — the real request that follows will surface a clearer
    // error than a startup-time crash if the server is actually down.
    healthPromise = null;
    return { authMode: "trust" as const };
  });
  return healthPromise;
}

function findGitRoot(): string | null {
  try {
    const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" });
    return r.status === 0 ? r.stdout.trim() || null : null;
  } catch {
    return null;
  }
}

function readPimJsonOrgSlug(): string | null {
  const root = findGitRoot();
  if (!root) return null;
  try {
    const raw = readFileSync(path.join(root, ".pim.json"), "utf-8");
    const json = JSON.parse(raw) as { orgSlug?: string };
    return json.orgSlug?.trim() || null;
  } catch {
    return null;
  }
}

function resolveOrgSlug(): string | null {
  return process.env.PIM_ORG_SLUG?.trim() || readPimJsonOrgSlug();
}

let warnedAboutMissingCreds = false;
let warnedAboutMissingOrg = false;

async function buildHeaders(hasBody: boolean): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  if (hasBody) headers["Content-Type"] = "application/json";

  const health = await getHealth();
  if (health.authMode === "trust") return headers;

  // IMS mode — we need both the bearer token and the org slug.
  assertSecurePermissions();
  let creds: Credentials | null = loadCredentials();
  if (creds) {
    try {
      creds = await ensureFreshToken(creds);
    } catch (e) {
      // Refresh failed — fall through with no Authorization header; the
      // server will 401 and the error will surface to Claude with the
      // "run 'pim login'" hint included.
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[pim-mcp] ${msg}`);
      creds = null;
    }
  }
  if (creds) {
    headers["Authorization"] = `Bearer ${creds.access_token}`;
  } else if (!warnedAboutMissingCreds) {
    warnedAboutMissingCreds = true;
    console.error("[pim-mcp] No credentials found at ~/.pim/credentials.json — run 'pim login' first.");
  }

  const orgSlug = resolveOrgSlug();
  if (orgSlug) {
    headers["X-Pim-Org"] = orgSlug;
  } else if (!warnedAboutMissingOrg) {
    warnedAboutMissingOrg = true;
    console.error(
      "[pim-mcp] No org slug configured — set PIM_ORG_SLUG or add orgSlug to the repo's .pim.json.",
    );
  }

  return headers;
}

export async function apiFetch<T>(path: string): Promise<T> {
  const headers = await buildHeaders(false);
  const res = await fetch(`${API_BASE}${path}`, { headers });
  if (!res.ok) throw new Error(`PIM API ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export async function apiFetchText(path: string): Promise<string> {
  const headers = await buildHeaders(false);
  const res = await fetch(`${API_BASE}${path}`, { headers });
  if (!res.ok) throw new Error(`PIM API ${res.status}: ${await res.text()}`);
  return res.text();
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const headers = await buildHeaders(body != null);
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`PIM API ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export async function apiPut<T>(path: string, body?: unknown): Promise<T> {
  const headers = await buildHeaders(body != null);
  const res = await fetch(`${API_BASE}${path}`, {
    method: "PUT",
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`PIM API ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export async function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  const headers = await buildHeaders(body != null);
  const res = await fetch(`${API_BASE}${path}`, {
    method: "PATCH",
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`PIM API ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}
