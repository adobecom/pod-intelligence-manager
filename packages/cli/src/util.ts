import type { Command } from "commander";
import chalk from "chalk";

export function getBaseUrl(program: Command): string {
  return program.opts().server as string;
}

// Module-level org slug set at CLI entry from resolveOrgSlug(); injected
// on every request so the server can scope by org without each call site
// having to thread the slug through.
let moduleOrgSlug: string | null = null;
// Bearer token from ~/.pim/credentials.json, primed by the CLI entry point
// when the server is in IMS mode. Null in trust mode.
let moduleAuthToken: string | null = null;

export function setOrgSlug(slug: string | null | undefined): void {
  moduleOrgSlug = slug ?? null;
}

export function getOrgSlug(): string | null {
  return moduleOrgSlug;
}

export function setAuthToken(token: string | null | undefined): void {
  moduleAuthToken = token ?? null;
}

export function getAuthToken(): string | null {
  return moduleAuthToken;
}

/** Merge X-Pim-Org + Authorization into an optional headers init. */
export function withAuthHeaders(init?: RequestInit): RequestInit | undefined {
  if (!moduleOrgSlug && !moduleAuthToken) return init;
  const headers = new Headers(init?.headers);
  if (moduleOrgSlug) headers.set("X-Pim-Org", moduleOrgSlug);
  if (moduleAuthToken) headers.set("Authorization", `Bearer ${moduleAuthToken}`);
  return { ...init, headers };
}

export async function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  const merged = withAuthHeaders(init);
  return merged === undefined ? fetch(url) : fetch(url, merged);
}

export async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(url, init);
  if (!res.ok) {
    const body = await res.text();
    console.error(chalk.red(`\n  Error: ${res.status} — ${body}\n`));
    process.exit(1);
  }
  return res.json() as Promise<T>;
}
