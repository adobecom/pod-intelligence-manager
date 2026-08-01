import type {
  Pod,
  Conflict,
  ContextUpdate,
  Project,
  ProjectAnatomy,
  OrgConfig,
  OrgTuning,
  ProjectContextUpdate,
  Tunnel,
  OrgPodSummary,
  CrossPodOverlap,
  ArchivedPod,
  PodArchiveJob,
  ArchivedProject,
  PendingWork,
  KnowledgeGraph,
  KnowledgeStats,
  KnowledgeQueryOptions,
  KnowledgeQueryResult,
  CurationRequest,
  ContextSearchRequest,
  ContextSearchResult,
  ProjectResources,
  ProjectMemoryCandidate,
  ProjectAnswerResponse,
  ProjectSearchRequest,
  ProjectSearchResponse,
  ProjectSourceHealth,
} from "@pim/shared";

// Module-level getters injected by the Auth/Org contexts at mount so the
// network layer can read the current IMS token + selected org slug without
// taking React context as a dependency.
let authTokenGetter: (() => string | null) | null = null;
let orgSlugGetter: (() => string | null) | null = null;
let orgCountGetter: (() => number) | null = null;

export function setAuthTokenGetter(getter: (() => string | null) | null): void {
  authTokenGetter = getter;
}

export function setOrgSlugGetter(getter: (() => string | null) | null): void {
  orgSlugGetter = getter;
}

export function setOrgCountGetter(getter: (() => number) | null): void {
  orgCountGetter = getter;
}

/** Read current auth token — exposed for consumers that don't use apiFetch (e.g. WebSocket URL). */
export function getAuthToken(): string | null {
  return authTokenGetter?.() ?? null;
}

/** Read current org slug — exposed for consumers that don't use apiFetch (e.g. WebSocket URL). */
export function getOrgSlug(): string | null {
  return orgSlugGetter?.() ?? null;
}

function withAuthHeaders(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers);
  const token = authTokenGetter?.();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const slug = orgSlugGetter?.();
  if (slug) headers.set("X-Pim-Org", slug);
  return { ...init, headers };
}

export async function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  const slug = orgSlugGetter?.();
  const orgCount = orgCountGetter?.() ?? 0;
  if (!slug && orgCount > 1 && isAgentMemoryPath(url)) {
    throw new Error("X-Pim-Org is required for agent-session and memory routes when multiple orgs are available");
  }
  return fetch(url, withAuthHeaders(init));
}

function isAgentMemoryPath(url: string): boolean {
  const path = url.startsWith("http") ? new URL(url).pathname : url.split("?")[0];
  return (
    path === "/api/agent-sessions" ||
    path.startsWith("/api/agent-sessions/") ||
    path.startsWith("/api/agent-runs/") ||
    path.startsWith("/api/memory-candidates/")
  );
}

async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(url, init);
  if (!res.ok) {
    if (res.status === 404) return null as T;
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export async function getPod(podId: string): Promise<Pod | null> {
  return fetchJSON<Pod | null>(`/api/pods/${podId}`);
}

export async function patchPod(
  podId: string,
  input: { project_id: string | null },
): Promise<Pod> {
  return fetchJSON<Pod>(`/api/pods/${encodeURIComponent(podId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
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
  const res = await apiFetch(`/api/pods/${podId}/living-doc`);
  if (!res.ok) return "# No living doc available for this pod.";
  return res.text();
}

export async function recordLivingDocView(podId: string, viewerId: string): Promise<void> {
  await apiFetch(`/api/pods/${podId}/living-doc/views`, {
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

export async function getArchivedProjects(): Promise<ArchivedProject[]> {
  return fetchJSON<ArchivedProject[]>("/api/org/archived-projects");
}

export async function archiveProject(projectId: string): Promise<ArchivedProject> {
  return fetchJSON<ArchivedProject>(`/api/projects/${encodeURIComponent(projectId)}/archive`, {
    method: "POST",
  });
}

export async function getOrgConfig(): Promise<OrgConfig> {
  return fetchJSON<OrgConfig>("/api/org/config");
}

export async function patchOrgConfig(body: OrgConfig): Promise<OrgConfig> {
  return fetchJSON<OrgConfig>("/api/org/config", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export interface SkillCatalogSourceSummary {
  sourceId: string;
  displayName: string;
  repository: {
    apiBaseUrl: string;
    owner: string;
    repo: string;
    defaultRef: string;
  };
  enabled: boolean;
  syncStatus: string;
  lastSyncedAt: string | null;
  latestEntriesReadyCommitSha: string | null;
  latestSearchReadyCommitSha: string | null;
  latestIndexedCommitSha: string | null;
}

export interface SkillCatalogConfiguration {
  sources: SkillCatalogSourceSummary[];
  selection: {
    projectId: string | null;
    orgDefaultSourceId: string | null;
    projectOverrideSourceId: string | null;
    effectiveSourceId: string | null;
    mode: "project" | "org_default" | "unconfigured";
    effectiveSource: SkillCatalogSourceSummary | null;
  };
}

export async function getSkillCatalogConfiguration(
  projectId?: string,
): Promise<SkillCatalogConfiguration> {
  const query = projectId
    ? `?projectId=${encodeURIComponent(projectId)}`
    : "";
  return fetchJSON<SkillCatalogConfiguration>(
    `/api/skill-catalog/config${query}`,
  );
}

export async function putOrgDefaultSkillCatalogSource(
  sourceId: string | null,
): Promise<SkillCatalogConfiguration> {
  return fetchJSON<SkillCatalogConfiguration>(
    "/api/skill-catalog/config/org-default",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId }),
    },
  );
}

export async function putProjectSkillCatalogSource(
  projectId: string,
  sourceId: string | null,
): Promise<SkillCatalogConfiguration> {
  return fetchJSON<SkillCatalogConfiguration>(
    `/api/projects/${encodeURIComponent(projectId)}/skill-catalog`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId }),
    },
  );
}

export async function getOrgTuning(): Promise<OrgTuning> {
  return fetchJSON<OrgTuning>("/api/org/tuning");
}

export interface TuningHistoryEntry {
  id: number;
  adjusted_at: string;
  signal_name: string;
  signal_value: number;
  parameter: string;
  old_value: number;
  new_value: number;
  pods_analyzed: number;
}

export async function getOrgTuningHistory(): Promise<TuningHistoryEntry[]> {
  return fetchJSON<TuningHistoryEntry[]>("/api/org/tuning/history");
}

export async function deleteOrgTuning(): Promise<OrgTuning> {
  return fetchJSON<OrgTuning>("/api/org/tuning", { method: "DELETE" });
}

export async function createPod(input: {
  name: string;
  sprint_days?: number;
  milestone_name?: string;
  project_id?: string;
}): Promise<Pod> {
  return fetchJSON<Pod>("/api/pods", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

// --- Projects (long-lived layer; off-pod context stream) ---

export async function getProjects(): Promise<Project[]> {
  return fetchJSON<Project[]>("/api/projects");
}

export async function getProject(projectId: string): Promise<Project | null> {
  return fetchJSON<Project | null>(`/api/projects/${encodeURIComponent(projectId)}`);
}

export async function createProject(input: {
  name: string;
  description?: string;
}): Promise<Project> {
  return fetchJSON<Project>("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function patchProject(
  projectId: string,
  input: { name?: string; description?: string | null; anatomy?: ProjectAnatomy },
): Promise<Project> {
  return fetchJSON<Project>(`/api/projects/${encodeURIComponent(projectId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function getProjectContextUpdates(projectId: string): Promise<ProjectContextUpdate[]> {
  return fetchJSON<ProjectContextUpdate[]>(
    `/api/projects/${encodeURIComponent(projectId)}/context-updates`,
  );
}

export async function getProjectResources(projectId: string): Promise<ProjectResources> {
  return fetchJSON<ProjectResources>(
    `/api/projects/${encodeURIComponent(projectId)}/resources`,
  );
}

export async function putProjectResources(
  projectId: string,
  resources: ProjectResources,
): Promise<ProjectResources> {
  return fetchJSON<ProjectResources>(
    `/api/projects/${encodeURIComponent(projectId)}/resources`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(resources),
    },
  );
}

export async function getProjectProfile(projectId: string): Promise<ProjectResources> {
  return fetchJSON<ProjectResources>(
    `/api/projects/${encodeURIComponent(projectId)}/profile`,
  );
}

export async function patchProjectProfile(
  projectId: string,
  patch: Partial<ProjectResources>,
): Promise<ProjectResources> {
  return fetchJSON<ProjectResources>(
    `/api/projects/${encodeURIComponent(projectId)}/profile`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    },
  );
}

export async function getProjectSourceHealth(projectId: string): Promise<ProjectSourceHealth[]> {
  return fetchJSON<ProjectSourceHealth[]>(
    `/api/projects/${encodeURIComponent(projectId)}/source-health`,
  );
}

export async function getProjectMemoryCandidates(
  projectId: string,
  status = "pending",
): Promise<ProjectMemoryCandidate[]> {
  return fetchJSON<ProjectMemoryCandidate[]>(
    `/api/projects/${encodeURIComponent(projectId)}/memory-candidates?status=${encodeURIComponent(status)}`,
  );
}

export async function promoteProjectMemoryCandidate(
  projectId: string,
  candidateId: string,
): Promise<ProjectMemoryCandidate> {
  return fetchJSON<ProjectMemoryCandidate>(
    `/api/projects/${encodeURIComponent(projectId)}/memory-candidates/${encodeURIComponent(candidateId)}/promote`,
    { method: "POST" },
  );
}

export async function rejectProjectMemoryCandidate(
  projectId: string,
  candidateId: string,
): Promise<ProjectMemoryCandidate> {
  return fetchJSON<ProjectMemoryCandidate>(
    `/api/projects/${encodeURIComponent(projectId)}/memory-candidates/${encodeURIComponent(candidateId)}/reject`,
    { method: "POST" },
  );
}

export async function answerProjectQuestion(
  projectId: string,
  query: string,
): Promise<ProjectAnswerResponse> {
  return fetchJSON<ProjectAnswerResponse>(
    `/api/projects/${encodeURIComponent(projectId)}/answers`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    },
  );
}

/** Hybrid (lexical + semantic) search over a project's indexed artifacts.
 * Set `synthesize: true` for a plain-language, cited answer over the hits. */
export async function searchProjectIndex(
  projectId: string,
  request: ProjectSearchRequest,
): Promise<ProjectSearchResponse> {
  return fetchJSON<ProjectSearchResponse>(
    `/api/projects/${encodeURIComponent(projectId)}/search`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    },
  );
}

export async function pollProjectSources(projectId: string): Promise<{
  results: Array<{ source: string; ingested: number; missing?: string }>;
  health: ProjectSourceHealth[];
}> {
  return fetchJSON(
    `/api/projects/${encodeURIComponent(projectId)}/ingest/poll`,
    { method: "POST" },
  );
}

export async function archivePod(podId: string): Promise<ArchivedPod> {
  const res = await apiFetch(`/api/pods/${encodeURIComponent(podId)}/archive`, {
    method: "POST",
  });
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  const body = await res.json() as ArchivedPod | PodArchiveJob;
  if (!isArchiveJob(body)) return body;
  return pollArchiveJob(body);
}

function isArchiveJob(value: ArchivedPod | PodArchiveJob): value is PodArchiveJob {
  return "job_id" in value && "status" in value && "status_url" in value;
}

async function pollArchiveJob(initial: PodArchiveJob): Promise<ArchivedPod> {
  let job = initial;
  if (job.status === "completed" && job.archived) return job.archived;
  if (job.status === "failed") throw new Error(job.error ?? "Archive failed");

  for (let attempt = 0; attempt < 120; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    job = await fetchJSON<PodArchiveJob>(job.status_url);
    if (job.status === "completed" && job.archived) return job.archived;
    if (job.status === "failed") throw new Error(job.error ?? "Archive failed");
  }
  throw new Error("Archive did not complete before the polling timeout");
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

/** Mirrors server `LintPassMeta` — whether the fast/Haiku supplement ran. */
export interface LintPassMeta {
  bedrock_configured: boolean;
  llm_ok: boolean;
  llm_model: string | null;
  llm_extra_findings: number;
  llm_error: string | null;
}

export async function getLintFindings(podId: string): Promise<LintFinding[]> {
  return fetchJSON<LintFinding[]>(`/api/pods/${podId}/lint-findings`);
}

export async function triggerLintPass(
  podId: string,
): Promise<{ findings: LintFinding[]; meta: LintPassMeta }> {
  return fetchJSON<{ findings: LintFinding[]; meta: LintPassMeta }>(`/api/pods/${podId}/lint`, {
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
  scope: string;
  summary: string;
  details: string;
  status: "completed" | "in_progress" | "blocked";
}

export interface SubmitResult {
  id: string;
  update: ContextUpdate;
  pim: {
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

export async function retractContextUpdate(podId: string, updateId: string): Promise<void> {
  await fetchJSON<{ ok: boolean }>(`/api/pods/${podId}/context-updates/${updateId}`, {
    method: "DELETE",
  });
}

export async function retractProjectContextUpdate(projectId: string, updateId: string): Promise<void> {
  await fetchJSON<{ ok: boolean }>(`/api/projects/${projectId}/context-updates/${updateId}`, {
    method: "DELETE",
  });
}

export interface ProjectSubmitResult {
  id: string;
  update: ProjectContextUpdate;
  pim: {
    classification: string;
    merged: boolean;
    conflictCreated: boolean;
    note?: string;
  };
}

// --- Context Search ---

export async function searchContext(
  request: ContextSearchRequest,
): Promise<ContextSearchResult> {
  return fetchJSON<ContextSearchResult>("/api/context-search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
}

// --- Orgs (user-facing) ---

export interface UserOrgSummary {
  org_id: string;
  slug: string;
  name: string;
  role: "owner" | "admin" | "member";
  created_at: string;
}

export async function createUserOrg(input: { slug: string; name: string }): Promise<UserOrgSummary> {
  const res = await apiFetch("/api/orgs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Failed to create org (${res.status})`);
  }
  return res.json() as Promise<UserOrgSummary>;
}

export type OrgRole = "owner" | "admin" | "member";

export interface OrgMember {
  user_id: string;
  email: string;
  display_name: string | null;
  role: OrgRole;
  created_at: string;
}

export interface OrgPendingInvite {
  invite_id: string;
  email: string;
  role: Exclude<OrgRole, "owner">;
  created_at: string;
}

export interface OrgMembersResponse {
  members: OrgMember[];
  invites: OrgPendingInvite[];
}

export async function getOrgMembers(slug: string): Promise<OrgMembersResponse> {
  return fetchJSON<OrgMembersResponse>(`/api/orgs/${encodeURIComponent(slug)}/members`);
}

/**
 * Wraps a 4xx body-returning API call with a throwing helper so the caller
 * gets the server's actual error text (e.g. "Cannot demote the last owner").
 */
async function postOrThrow<T>(url: string, init: RequestInit): Promise<T> {
  const res = await apiFetch(url, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export async function inviteMember(
  slug: string,
  input: { email: string; role: Exclude<OrgRole, "owner"> },
): Promise<OrgPendingInvite> {
  return postOrThrow<OrgPendingInvite>(`/api/orgs/${encodeURIComponent(slug)}/invites`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function revokeInvite(slug: string, inviteId: string): Promise<void> {
  await postOrThrow<{ ok: boolean }>(
    `/api/orgs/${encodeURIComponent(slug)}/invites/${inviteId}`,
    { method: "DELETE" },
  );
}

export async function updateMemberRole(
  slug: string,
  userId: string,
  role: OrgRole,
): Promise<OrgMember> {
  return postOrThrow<OrgMember>(
    `/api/orgs/${encodeURIComponent(slug)}/members/${userId}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    },
  );
}

export async function removeMember(slug: string, userId: string): Promise<void> {
  await postOrThrow<{ ok: boolean }>(
    `/api/orgs/${encodeURIComponent(slug)}/members/${userId}`,
    { method: "DELETE" },
  );
}

export async function acceptInvite(inviteId: string): Promise<{ org_id: string; role: OrgRole }> {
  return postOrThrow<{ org_id: string; role: OrgRole }>(
    `/api/orgs/accept/${encodeURIComponent(inviteId)}`,
    { method: "POST" },
  );
}

export async function submitProjectContextUpdate(
  projectId: string,
  input: ContextUpdateInput,
): Promise<ProjectSubmitResult> {
  return fetchJSON<ProjectSubmitResult>(
    `/api/projects/${encodeURIComponent(projectId)}/context-updates`,
    {
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
    },
  );
}
