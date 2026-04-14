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
import {
  pods,
  conflicts,
  contextUpdates,
  tunnels,
  orgPods,
  crossPodOverlaps,
  archivedPods,
  livingDocs,
  pendingWork,
} from "../mocks/fixtures";

// Swap this file's internals for real API calls when a backend exists.

export async function getPod(podId: string): Promise<Pod | null> {
  return pods[podId] ?? null;
}

export async function getConflicts(podId: string): Promise<Conflict[]> {
  return conflicts[podId] ?? [];
}

export async function getContextUpdates(
  podId: string,
): Promise<ContextUpdate[]> {
  return contextUpdates[podId] ?? [];
}

export async function getTunnels(podId: string): Promise<Tunnel[]> {
  return tunnels[podId] ?? [];
}

export async function getLivingDoc(podId: string): Promise<string> {
  return livingDocs[podId] ?? "# No living doc available for this pod.";
}

export async function getPendingWork(
  conflictId: string,
): Promise<PendingWork[]> {
  return pendingWork[conflictId] ?? [];
}

export async function getConflict(
  podId: string,
  conflictId: string,
): Promise<Conflict | null> {
  const podConflicts = conflicts[podId] ?? [];
  return podConflicts.find((c) => c.id === conflictId) ?? null;
}

export async function resolveConflict(
  podId: string,
  conflictId: string,
  resolution: string,
  resolvedBy: string,
): Promise<Conflict | null> {
  const podConflicts = conflicts[podId];
  if (!podConflicts) return null;
  const conflict = podConflicts.find((c) => c.id === conflictId);
  if (!conflict) return null;
  conflict.status = "resolved";
  conflict.resolution = resolution;
  conflict.resolved_by = resolvedBy;
  conflict.resolution_date = new Date().toISOString();
  return { ...conflict };
}

export async function getOrgPods(): Promise<OrgPodSummary[]> {
  return orgPods;
}

export async function getCrossPodOverlaps(): Promise<CrossPodOverlap[]> {
  return crossPodOverlaps;
}

export async function getArchivedPods(): Promise<ArchivedPod[]> {
  return archivedPods;
}
