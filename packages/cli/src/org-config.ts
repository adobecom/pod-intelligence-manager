import type { OrgConfig, Project } from "@pim/shared";
import { apiFetch } from "./util.js";

export interface UserOrgSummary {
  org_id: string;
  slug: string;
  name: string;
  role: "owner" | "admin" | "member";
  created_at: string;
}

/** Orgs the authenticated user is a member of. In trust mode returns the `demo` org. */
export async function fetchUserOrgs(serverUrl: string): Promise<UserOrgSummary[]> {
  const base = serverUrl.replace(/\/$/, "");
  const res = await apiFetch(`${base}/api/orgs`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}${text ? `: ${text}` : ""}`);
  }
  return res.json() as Promise<UserOrgSummary[]>;
}

export async function fetchOrgConfig(serverUrl: string): Promise<OrgConfig> {
  const base = serverUrl.replace(/\/$/, "");
  const res = await apiFetch(`${base}/api/org/config`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}${text ? `: ${text}` : ""}`);
  }
  return res.json() as Promise<OrgConfig>;
}

export function scopeIdsFromConfig(config: OrgConfig): Set<string> {
  return new Set(config.scopes.map(s => s.id));
}

/** First scope id from the server (stable order as returned). Use for templates when user omits --scope. */
export function defaultScopeIdFromConfig(config: OrgConfig): string | undefined {
  return config.scopes[0]?.id;
}

export function formatScopeChoicesForError(config: OrgConfig): string {
  return config.scopes.map(s => `${s.id} (${s.label})`).join(", ");
}

export async function fetchOrgPods<T extends { pod_id: string; name: string }>(serverUrl: string): Promise<T[]> {
  const base = serverUrl.replace(/\/$/, "");
  const res = await apiFetch(`${base}/api/org/pods`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}${text ? `: ${text}` : ""}`);
  }
  return res.json() as Promise<T[]>;
}

export async function fetchProjects(serverUrl: string): Promise<Project[]> {
  const base = serverUrl.replace(/\/$/, "");
  const res = await apiFetch(`${base}/api/projects`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}${text ? `: ${text}` : ""}`);
  }
  return res.json() as Promise<Project[]>;
}

export async function verifyProjectExists(serverUrl: string, projectId: string): Promise<Project> {
  const base = serverUrl.replace(/\/$/, "");
  const res = await apiFetch(`${base}/api/projects/${encodeURIComponent(projectId)}`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}${text ? `: ${text}` : ""}`);
  }
  return res.json() as Promise<Project>;
}
