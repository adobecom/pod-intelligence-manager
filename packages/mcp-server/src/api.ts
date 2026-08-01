import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import {
  loadCredentials,
  ensureFreshToken,
  assertSecurePermissions,
  type Credentials,
} from "@pim/shared/auth";

const API_BASE = process.env.PIM_API_URL ?? "http://localhost:4000";
const FETCH_TIMEOUT_MS = 45_000;

type OrgSelectionSource =
  | "PIM_ORG_SLUG"
  | ".pim.json"
  | "~/.pim/config.json"
  | "/api/me"
  | "none";

interface PimUserConfig {
  active_org_slug?: string;
  [key: string]: unknown;
}

export interface OrgSummary {
  org_id: string;
  slug: string;
  name: string;
  role: "owner" | "admin" | "member";
  created_at: string;
}

interface MeResponse {
  orgs: OrgSummary[];
}

export interface OrgSelectionStatus {
  active_org_slug: string | null;
  effective_source: OrgSelectionSource;
  orgs: OrgSummary[];
  needs_org_selection?: boolean;
  no_orgs_available?: boolean;
  saved_active_org_slug?: string;
  saved_default_overridden?: boolean;
  overridden_by?: {
    source: Exclude<OrgSelectionSource, "~/.pim/config.json" | "/api/me" | "none">;
    active_org_slug: string;
  };
  message?: string;
}

function withTimeout(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

interface HealthSnapshot {
  authMode: "trust" | "ims";
}

/**
 * MCP runs out-of-process (spawned by Claude Desktop) so we can't do an
 * interactive OAuth flow here. We read `~/.pim/credentials.json` written by
 * `pim login`, refresh on expiry, and inject Authorization + X-Pim-Org on
 * every call. In trust mode Authorization is omitted, but X-Pim-Org is still
 * attached so standalone MCP users do not fall through to the server's legacy
 * first-org default.
 */

let healthCache: HealthSnapshot | null = null;
let healthPromise: Promise<HealthSnapshot> | null = null;
let runtimeActiveOrgSlug: string | null = null;

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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/api/health`, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
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

interface PimRepoConfig {
  orgSlug?: unknown;
  projectId?: unknown;
}

function readPimJson(): PimRepoConfig | null {
  const root = findGitRoot();
  if (!root) return null;
  try {
    const raw = readFileSync(path.join(root, ".pim.json"), "utf-8");
    const json = JSON.parse(raw) as unknown;
    return json && typeof json === "object" && !Array.isArray(json)
      ? (json as PimRepoConfig)
      : null;
  } catch {
    return null;
  }
}

function readPimJsonOrgSlug(): string | null {
  const orgSlug = readPimJson()?.orgSlug;
  return typeof orgSlug === "string" ? orgSlug.trim() || null : null;
}

/**
 * Resolve MCP project context without guessing: explicit tool input wins,
 * followed by the process environment and the current repository binding.
 * Returning undefined intentionally delegates the final choice to the
 * server's configured organization default.
 */
export function resolveProjectId(explicitProjectId?: string): string | undefined {
  const explicit = explicitProjectId?.trim();
  if (explicit) return explicit;
  const environment = process.env.PIM_PROJECT_ID?.trim();
  if (environment) return environment;
  const repositoryProjectId = readPimJson()?.projectId;
  if (typeof repositoryProjectId !== "string") return undefined;
  return repositoryProjectId.trim() || undefined;
}

function pimDir(): string {
  return path.join(os.homedir(), ".pim");
}

function userConfigPath(): string {
  return path.join(pimDir(), "config.json");
}

function loadUserConfig(): PimUserConfig {
  const p = userConfigPath();
  if (!existsSync(p)) return {};
  try {
    const raw = readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as PimUserConfig)
      : {};
  } catch {
    return {};
  }
}

function saveUserConfig(config: PimUserConfig): void {
  const dir = pimDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o700);
  }
  const p = userConfigPath();
  writeFileSync(p, JSON.stringify(config, null, 2), "utf-8");
  chmodSync(p, 0o600);
}

function readSavedActiveOrgSlug(): string | null {
  if (runtimeActiveOrgSlug) return runtimeActiveOrgSlug;
  const active = loadUserConfig().active_org_slug;
  return typeof active === "string" ? active.trim() || null : null;
}

function persistActiveOrgSlug(slug: string): void {
  const current = loadUserConfig();
  current.active_org_slug = slug;
  saveUserConfig(current);
  runtimeActiveOrgSlug = slug;
}

interface ConfiguredOrgSlug {
  slug: string;
  source: Exclude<OrgSelectionSource, "/api/me" | "none">;
  savedActiveOrgSlug?: string;
}

function configuredOrgSlug(): ConfiguredOrgSlug | null {
  const savedActiveOrgSlug = readSavedActiveOrgSlug() ?? undefined;
  const env = process.env.PIM_ORG_SLUG?.trim();
  if (env) return { slug: env, source: "PIM_ORG_SLUG", savedActiveOrgSlug };

  const repo = readPimJsonOrgSlug();
  if (repo) return { slug: repo, source: ".pim.json", savedActiveOrgSlug };

  if (savedActiveOrgSlug) {
    return {
      slug: savedActiveOrgSlug,
      source: "~/.pim/config.json",
      savedActiveOrgSlug,
    };
  }
  return null;
}

function isOrgBypassPath(requestPath: string): boolean {
  const clean = requestPath.split("?")[0] ?? requestPath;
  return (
    clean === "/api/me" ||
    clean.startsWith("/api/me/") ||
    clean === "/api/orgs" ||
    clean.startsWith("/api/orgs/") ||
    clean === "/api/health" ||
    clean === "/api/cli-config"
  );
}

function orgStatusFromOrgs(
  orgs: OrgSummary[],
  configured: ConfiguredOrgSlug | null,
): OrgSelectionStatus {
  if (configured) {
    const status: OrgSelectionStatus = {
      active_org_slug: configured.slug,
      effective_source: configured.source,
      orgs,
    };
    if (configured.savedActiveOrgSlug) {
      status.saved_active_org_slug = configured.savedActiveOrgSlug;
    }
    if (
      configured.savedActiveOrgSlug &&
      configured.source !== "~/.pim/config.json" &&
      configured.savedActiveOrgSlug !== configured.slug
    ) {
      status.saved_default_overridden = true;
      status.overridden_by = {
        source: configured.source as "PIM_ORG_SLUG" | ".pim.json",
        active_org_slug: configured.slug,
      };
      status.message =
        `Saved default org "${configured.savedActiveOrgSlug}" exists, but current requests use ` +
        `"${configured.slug}" from ${configured.source}.`;
    }
    return status;
  }

  if (orgs.length === 1) {
    persistActiveOrgSlug(orgs[0].slug);
    return {
      active_org_slug: orgs[0].slug,
      effective_source: "/api/me",
      orgs,
      saved_active_org_slug: orgs[0].slug,
      message: `Auto-selected the only available org: ${orgs[0].slug}.`,
    };
  }

  if (orgs.length === 0) {
    return {
      active_org_slug: null,
      effective_source: "none",
      orgs,
      no_orgs_available: true,
      message: "No orgs are available for this account. Create or accept an org invite before using PIM tools.",
    };
  }

  return {
    active_org_slug: null,
    effective_source: "none",
    orgs,
    needs_org_selection: true,
    message: "Multiple orgs are available. Call list_orgs, then set_active_org with the org slug to use.",
  };
}

function orgSelectionError(status: OrgSelectionStatus): Error {
  return new Error(JSON.stringify(status, null, 2));
}

let warnedAboutMissingCreds = false;
let warnedAboutMissingOrg = false;

async function buildAuthHeaders(hasBody: boolean): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  if (hasBody) headers["Content-Type"] = "application/json";

  const health = await getHealth();
  if (health.authMode === "trust") return headers;

  // IMS mode — we need the bearer token. Org selection is resolved separately
  // so trust mode can still attach X-Pim-Org.
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
    console.error("[pim-mcp] Not authenticated — call the `authenticate` tool to sign in.");
  }

  return headers;
}

async function fetchMe(headers?: Record<string, string>): Promise<MeResponse> {
  const { signal, clear } = withTimeout(FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}/api/me`, {
      headers: headers ?? await buildAuthHeaders(false),
      signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`PIM API ${res.status}: ${body || "Failed to fetch /api/me"}`);
    }
    return res.json() as Promise<MeResponse>;
  } finally {
    clear();
  }
}

async function resolveOrgForRequest(headers: Record<string, string>): Promise<{
  slug: string;
  source: OrgSelectionSource;
}> {
  const configured = configuredOrgSlug();
  if (configured) return { slug: configured.slug, source: configured.source };

  const me = await fetchMe(headers);
  const status = orgStatusFromOrgs(me.orgs, null);
  if (status.active_org_slug) {
    return { slug: status.active_org_slug, source: status.effective_source };
  }

  if (!warnedAboutMissingOrg) {
    warnedAboutMissingOrg = true;
    console.error(
      "[pim-mcp] No active org selected — call `list_orgs` and `set_active_org`, " +
      "or set PIM_ORG_SLUG / .pim.json orgSlug.",
    );
  }
  throw orgSelectionError(status);
}

async function buildHeaders(hasBody: boolean, requestPath: string): Promise<Record<string, string>> {
  const headers = await buildAuthHeaders(hasBody);
  if (!isOrgBypassPath(requestPath)) {
    const org = await resolveOrgForRequest(headers);
    headers["X-Pim-Org"] = org.slug;
  }
  return headers;
}

export async function getOrgSelectionStatus(): Promise<OrgSelectionStatus> {
  const headers = await buildAuthHeaders(false);
  const me = await fetchMe(headers);
  return orgStatusFromOrgs(me.orgs, configuredOrgSlug());
}

export async function setActiveOrg(orgSlug: string): Promise<
  OrgSelectionStatus & { selected_org: OrgSummary; persisted: true }
> {
  const slug = orgSlug.trim();
  if (!slug) throw new Error("org_slug is required");

  const headers = await buildAuthHeaders(false);
  const me = await fetchMe(headers);
  const selected = me.orgs.find((o) => o.slug === slug);
  if (!selected) {
    throw new Error(JSON.stringify({
      error: `You are not a member of org "${slug}".`,
      orgs: me.orgs,
    }, null, 2));
  }

  persistActiveOrgSlug(selected.slug);
  const status = orgStatusFromOrgs(me.orgs, configuredOrgSlug());
  return {
    ...status,
    selected_org: selected,
    persisted: true,
    saved_active_org_slug: selected.slug,
    ...(status.saved_default_overridden
      ? {
          message:
            `Saved default org "${selected.slug}", but current requests still use ` +
            `"${status.active_org_slug}" from ${status.effective_source}.`,
        }
      : { message: `Active org set to ${selected.slug}.` }),
  };
}

export function _resetOrgSelectionForTests(): void {
  runtimeActiveOrgSlug = null;
  healthCache = null;
  healthPromise = null;
  warnedAboutMissingCreds = false;
  warnedAboutMissingOrg = false;
}

export async function apiFetch<T>(path: string): Promise<T> {
  const { signal, clear } = withTimeout(FETCH_TIMEOUT_MS);
  try {
    const headers = await buildHeaders(false, path);
    const res = await fetch(`${API_BASE}${path}`, { headers, signal });
    if (!res.ok) throw new Error(`PIM API ${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  } finally {
    clear();
  }
}

export async function apiFetchText(path: string): Promise<string> {
  const { signal, clear } = withTimeout(FETCH_TIMEOUT_MS);
  try {
    const headers = await buildHeaders(false, path);
    const res = await fetch(`${API_BASE}${path}`, { headers, signal });
    if (!res.ok) throw new Error(`PIM API ${res.status}: ${await res.text()}`);
    return res.text();
  } finally {
    clear();
  }
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const { signal, clear } = withTimeout(FETCH_TIMEOUT_MS);
  try {
    const headers = await buildHeaders(body != null, path);
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers,
      body: body != null ? JSON.stringify(body) : undefined,
      signal,
    });
    if (!res.ok) throw new Error(`PIM API ${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  } finally {
    clear();
  }
}

export async function apiPut<T>(path: string, body?: unknown): Promise<T> {
  const { signal, clear } = withTimeout(FETCH_TIMEOUT_MS);
  try {
    const headers = await buildHeaders(body != null, path);
    const res = await fetch(`${API_BASE}${path}`, {
      method: "PUT",
      headers,
      body: body != null ? JSON.stringify(body) : undefined,
      signal,
    });
    if (!res.ok) throw new Error(`PIM API ${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  } finally {
    clear();
  }
}

export async function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  const { signal, clear } = withTimeout(FETCH_TIMEOUT_MS);
  try {
    const headers = await buildHeaders(body != null, path);
    const res = await fetch(`${API_BASE}${path}`, {
      method: "PATCH",
      headers,
      body: body != null ? JSON.stringify(body) : undefined,
      signal,
    });
    if (!res.ok) throw new Error(`PIM API ${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  } finally {
    clear();
  }
}

export async function apiDelete<T>(path: string, body?: unknown): Promise<T> {
  const { signal, clear } = withTimeout(FETCH_TIMEOUT_MS);
  try {
    const headers = await buildHeaders(body != null, path);
    const res = await fetch(`${API_BASE}${path}`, {
      method: "DELETE",
      headers,
      body: body != null ? JSON.stringify(body) : undefined,
      signal,
    });
    if (!res.ok) throw new Error(`PIM API ${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  } finally {
    clear();
  }
}
