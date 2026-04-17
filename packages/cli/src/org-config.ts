import type { OrgConfig, Project } from "@pim/shared";

export async function fetchOrgConfig(serverUrl: string): Promise<OrgConfig> {
  const base = serverUrl.replace(/\/$/, "");
  const res = await fetch(`${base}/api/org/config`, { signal: AbortSignal.timeout(10000) });
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
  const res = await fetch(`${base}/api/org/pods`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}${text ? `: ${text}` : ""}`);
  }
  return res.json() as Promise<T[]>;
}

export async function fetchProjects(serverUrl: string): Promise<Project[]> {
  const base = serverUrl.replace(/\/$/, "");
  const res = await fetch(`${base}/api/projects`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}${text ? `: ${text}` : ""}`);
  }
  return res.json() as Promise<Project[]>;
}

export async function verifyProjectExists(serverUrl: string, projectId: string): Promise<Project> {
  const base = serverUrl.replace(/\/$/, "");
  const res = await fetch(`${base}/api/projects/${encodeURIComponent(projectId)}`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}${text ? `: ${text}` : ""}`);
  }
  return res.json() as Promise<Project>;
}
