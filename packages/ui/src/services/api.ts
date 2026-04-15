import type {
  Pod,
  Conflict,
  ContextUpdate,
  Tunnel,
  OrgPodSummary,
  CrossPodOverlap,
  ArchivedPod,
  PendingWork,
  KnowledgeGraph,
  KnowledgeStats,
  KnowledgeQueryOptions,
  KnowledgeQueryResult,
  CurationRequest,
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

export async function recordLivingDocView(podId: string, viewerId: string): Promise<void> {
  await fetch(`/api/pods/${podId}/living-doc/views`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ viewer_id: viewerId }),
  });
}

export interface LivingDocViewerStat {
  viewer_id: string;
  last_viewed_at: string;
  view_count: number;
  regens_since_last_view: number;
}

export interface LivingDocStats {
  pod_id: string;
  last_regenerated_at: string | null;
  regen_count: number;
  viewers: LivingDocViewerStat[];
}

export async function getLivingDocStats(podId: string): Promise<LivingDocStats> {
  return fetchJSON<LivingDocStats>(`/api/pods/${podId}/living-doc/stats`);
}

export interface AgentQualityStat {
  agent_id: string;
  update_count: number;
  avg_quality: number;
  min_quality: number;
  max_quality: number;
}

export async function getQualityStats(podId: string): Promise<AgentQualityStat[]> {
  return fetchJSON<AgentQualityStat[]>(`/api/pods/${podId}/quality-stats`);
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

export async function createPod(input: {
  name: string;
  sprint_days?: number;
  milestone_name?: string;
}): Promise<Pod> {
  return fetchJSON<Pod>("/api/pods", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function archivePod(podId: string): Promise<ArchivedPod> {
  return fetchJSON<ArchivedPod>(`/api/pods/${podId}/archive`, {
    method: "POST",
  });
}

export interface LintFinding {
  id: string;
  pod_id: string;
  timestamp: string;
  type: string;
  severity: string;
  summary: string;
  area: string | null;
  suggestion: string | null;
}

export async function getLintFindings(podId: string): Promise<LintFinding[]> {
  return fetchJSON<LintFinding[]>(`/api/pods/${podId}/lint-findings`);
}

export async function triggerLintPass(podId: string): Promise<{ findings: LintFinding[] }> {
  return fetchJSON<{ findings: LintFinding[] }>(`/api/pods/${podId}/lint`, {
    method: "POST",
  });
}

// --- Knowledge Graph API ---

export async function getKnowledgeGraph(): Promise<KnowledgeGraph> {
  return fetchJSON<KnowledgeGraph>("/api/knowledge/graph");
}

export async function getKnowledgeStats(): Promise<KnowledgeStats> {
  return fetchJSON<KnowledgeStats>("/api/knowledge/stats");
}

export async function queryKnowledge(options: KnowledgeQueryOptions): Promise<KnowledgeQueryResult> {
  return fetchJSON<KnowledgeQueryResult>("/api/knowledge/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
  });
}

export async function curateKnowledgeNode(
  nodeId: string,
  request: CurationRequest,
): Promise<void> {
  await fetchJSON<{ ok: boolean }>(`/api/knowledge/nodes/${nodeId}/curate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
}

export interface ContextUpdateInput {
  agent_id?: string;
  type: "progress" | "blocker" | "spec_change" | "question" | "decision";
  scope: "frontend" | "backend" | "design" | "qa" | "infra" | "pm";
  summary: string;
  details: string;
  status: "completed" | "in_progress" | "blocked";
}

export interface SubmitResult {
  id: string;
  update: ContextUpdate;
  council: {
    classification: string;
    merged: boolean;
    conflictCreated: boolean;
    conflictId?: string;
    note?: string;
  };
}

export async function submitContextUpdate(
  podId: string,
  input: ContextUpdateInput,
): Promise<SubmitResult> {
  return fetchJSON<SubmitResult>(`/api/pods/${podId}/context-updates`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agent_id: input.agent_id ?? "human-user",
      type: input.type,
      scope: input.scope,
      summary: input.summary,
      details: input.details,
      status: input.status,
      artifacts: [],
      blocks: [],
      blocked_by: [],
      needs_input_from: [],
    }),
  });
}
