import type {
  Pod,
  Conflict,
  ContextUpdate,
  Tunnel,
  OrgPodSummary,
  CrossPodOverlap,
  ArchivedPod,
  PendingWork,
} from "@council/shared";

async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    if (res.status === 404) return null as T;
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export async function getPod(podId: string): Promise<Pod | null> {
  return fetchJSON<Pod | null>(`/api/pods/${podId}`);
}

export async function getConflicts(podId: string): Promise<Conflict[]> {
  return fetchJSON<Conflict[]>(`/api/pods/${podId}/conflicts`);
}

export async function getContextUpdates(
  podId: string,
): Promise<ContextUpdate[]> {
  return fetchJSON<ContextUpdate[]>(`/api/pods/${podId}/context-updates`);
}

export async function getTunnels(podId: string): Promise<Tunnel[]> {
  return fetchJSON<Tunnel[]>(`/api/pods/${podId}/tunnels`);
}

export async function getLivingDoc(podId: string): Promise<string> {
  const res = await fetch(`/api/pods/${podId}/living-doc`);
  if (!res.ok) return "# No living doc available for this pod.";
  return res.text();
}

export async function getPendingWork(
  conflictId: string,
): Promise<PendingWork[]> {
  return fetchJSON<PendingWork[]>(`/api/conflicts/${conflictId}/pending-work`);
}

export async function getConflict(
  podId: string,
  conflictId: string,
): Promise<Conflict | null> {
  return fetchJSON<Conflict | null>(`/api/pods/${podId}/conflicts/${conflictId}`);
}

export async function resolveConflict(
  podId: string,
  conflictId: string,
  resolution: string,
  resolvedBy: string,
): Promise<Conflict | null> {
  return fetchJSON<Conflict | null>(
    `/api/pods/${podId}/conflicts/${conflictId}/resolve`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resolution, resolved_by: resolvedBy }),
    },
  );
}

export async function getOrgPods(): Promise<OrgPodSummary[]> {
  return fetchJSON<OrgPodSummary[]>("/api/org/pods");
}

export async function getCrossPodOverlaps(): Promise<CrossPodOverlap[]> {
  return fetchJSON<CrossPodOverlap[]>("/api/org/overlaps");
}

export async function getArchivedPods(): Promise<ArchivedPod[]> {
  return fetchJSON<ArchivedPod[]>("/api/org/archived");
}
