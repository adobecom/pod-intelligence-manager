import type {
  Pod,
  Project,
  Conflict,
  ContextUpdate,
  ProjectContextUpdate,
  ContextUpdateType,
  WorkStatus,
  Scope,
  Artifact,
  InputRequest,
  KnowledgeQueryOptions,
  KnowledgeQueryResult,
  AdHocLearningInput,
  ContextSearchRequest,
  ContextSearchResult,
} from "@pim/shared";

export interface SessionContextOptions {
  learningsMaxTokens?: number;
  recentUpdateLimit?: number;
  externalQuery?: string;
}

export interface SessionContext {
  pulledAt: string;
  pod: Pod;
  livingDocMarkdown: string;
  conflicts: Conflict[];
  relevantLearnings: KnowledgeQueryResult;
  recentUpdates: ContextUpdate[];
  externalContext?: ContextSearchResult;
}

export interface ProjectSessionContext {
  pulledAt: string;
  project: Project;
  relevantLearnings: KnowledgeQueryResult;
  recentUpdates: ProjectContextUpdate[];
  externalContext?: ContextSearchResult;
}

/** Merge org header (X-Pim-Org) into an init record when an org slug is present. */
function withOrgHeader(
  init: RequestInit | undefined,
  orgSlug: string | undefined,
): RequestInit | undefined {
  if (!orgSlug) return init;
  const headers = new Headers(init?.headers);
  headers.set("X-Pim-Org", orgSlug);
  return { ...init, headers };
}

// Pod-agnostic helper for callers that don't need a full PimClient.
// Used by the `pim search` CLI (which should not require PIM_POD_ID).
export async function searchContext(
  baseUrl: string,
  request: ContextSearchRequest,
  orgSlug?: string,
  authToken?: string,
): Promise<ContextSearchResult> {
  let init = withOrgHeader(
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    },
    orgSlug,
  );
  if (authToken) {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${authToken}`);
    init = { ...init, headers };
  }
  return fetchJSON<ContextSearchResult>(`${baseUrl}/api/context-search`, init);
}

interface PimClientConfigBase {
  baseUrl: string;
  agentId: string;
  scope: Scope;
  /** Org slug sent as X-Pim-Org on every request. Required once the server enforces org scoping. */
  orgSlug?: string;
  /** IMS Bearer token forwarded as Authorization header. Required when the server runs in IMS auth mode. */
  authToken?: string;
}

export type PimClientConfig =
  | (PimClientConfigBase & { podId: string; projectId?: undefined })
  | (PimClientConfigBase & { projectId: string; podId?: undefined });

export interface ReportInput {
  type: ContextUpdateType;
  summary: string;
  details: string;
  artifacts?: Artifact[];
  status: WorkStatus;
  blocks?: string[];
  blocked_by?: string[];
  needs_input_from?: InputRequest[];
}

export interface ReportResult {
  id: string;
  update: ContextUpdate | ProjectContextUpdate;
  pim: {
    classification: string;
    merged: boolean;
    conflictCreated: boolean;
    conflictId?: string;
    note?: string;
  };
}

async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`PIM API error ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

export class PimClient {
  private config: PimClientConfig;

  constructor(config: PimClientConfig) {
    const hasPod = Boolean(config.podId);
    const hasProj = Boolean(config.projectId);
    if (hasPod === hasProj) {
      throw new Error("PimClient requires exactly one of podId or projectId");
    }
    this.config = config;
  }

  private isPodMode(): boolean {
    return Boolean(this.config.podId);
  }

  private url(path: string): string {
    return `${this.config.baseUrl}${path}`;
  }

  private withHeaders(init?: RequestInit): RequestInit | undefined {
    let result = withOrgHeader(init, this.config.orgSlug);
    if (this.config.authToken) {
      const headers = new Headers(result?.headers);
      headers.set("Authorization", `Bearer ${this.config.authToken}`);
      result = { ...result, headers };
    }
    return result;
  }

  // Submit a context update to PIM
  async report(input: ReportInput): Promise<ReportResult> {
    const path = this.isPodMode()
      ? `/api/pods/${this.config.podId}/context-updates`
      : `/api/projects/${this.config.projectId}/context-updates`;
    return fetchJSON<ReportResult>(
      this.url(path),
      this.withHeaders({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: this.config.agentId,
          scope: this.config.scope,
          ...input,
        }),
      }),
    );
  }

  // Fetch the current living doc for the pod
  async getContext(): Promise<string> {
    if (!this.isPodMode()) throw new Error("getContext requires a pod-scoped client (podId)");
    const res = await fetch(
      this.url(`/api/pods/${this.config.podId}/living-doc`),
      this.withHeaders(),
    );
    if (!res.ok) throw new Error(`Failed to fetch living doc: ${res.status}`);
    return res.text();
  }

  // Fetch current pod state
  async getPod(): Promise<Pod> {
    if (!this.isPodMode()) throw new Error("getPod requires a pod-scoped client (podId)");
    return fetchJSON<Pod>(this.url(`/api/pods/${this.config.podId}`), this.withHeaders());
  }

  async getProject(): Promise<Project> {
    if (this.isPodMode()) throw new Error("getProject requires a project-scoped client (projectId)");
    return fetchJSON<Project>(this.url(`/api/projects/${this.config.projectId}`), this.withHeaders());
  }

  // Fetch current conflicts for the pod
  async getConflicts(): Promise<Conflict[]> {
    if (!this.isPodMode()) throw new Error("getConflicts requires a pod-scoped client (podId)");
    return fetchJSON<Conflict[]>(
      this.url(`/api/pods/${this.config.podId}/conflicts`),
      this.withHeaders(),
    );
  }

  // Fetch context updates for the pod
  async getUpdates(): Promise<ContextUpdate[]> {
    if (!this.isPodMode()) throw new Error("getUpdates requires a pod-scoped client (podId)");
    return fetchJSON<ContextUpdate[]>(
      this.url(`/api/pods/${this.config.podId}/context-updates`),
      this.withHeaders(),
    );
  }

  async getProjectUpdates(): Promise<ProjectContextUpdate[]> {
    if (this.isPodMode()) throw new Error("getProjectUpdates requires a project-scoped client (projectId)");
    return fetchJSON<ProjectContextUpdate[]>(
      this.url(`/api/projects/${this.config.projectId}/context-updates`),
      this.withHeaders(),
    );
  }

  // Query the organizational knowledge graph with token budget
  async queryKnowledge(options: KnowledgeQueryOptions): Promise<KnowledgeQueryResult> {
    return fetchJSON<KnowledgeQueryResult>(
      this.url("/api/knowledge/query"),
      this.withHeaders({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(options),
      }),
    );
  }

  // Get relevant learnings for this agent's scope with a token budget.
  // Pass `projectId` to scope results to org-wide + that project only (no cross-project bleed).
  // Pass `query` as free text to enable semantic (embedding) scoring; without it, scoring
  // falls back to keyword + domain matching only.
  async getRelevantLearnings(
    maxTokens: number = 2000,
    opts?: { projectId?: string | null; query?: string },
  ): Promise<KnowledgeQueryResult> {
    const scopes = encodeURIComponent(this.config.scope);
    const projectParam = opts?.projectId
      ? `&projectId=${encodeURIComponent(opts.projectId)}`
      : "";
    const queryParam = opts?.query?.trim()
      ? `&query=${encodeURIComponent(opts.query.trim())}`
      : "";
    return fetchJSON<KnowledgeQueryResult>(
      this.url(`/api/knowledge/relevant?scopes=${scopes}&maxTokens=${maxTokens}${projectParam}${queryParam}`),
      this.withHeaders(),
    );
  }

  // Submit a confirmed learning to the org knowledge graph from outside any active pod
  // (bug fixes, chatbot/agent conversations, etc.). The node enters the curation queue.
  // Returns 409 when a near-duplicate already exists.
  async submitLearning(
    input: AdHocLearningInput,
  ): Promise<{ nodesAdded: number; edgesAdded: number; nodeId: string }> {
    return fetchJSON<{ nodesAdded: number; edgesAdded: number; nodeId: string }>(
      this.url("/api/knowledge/nodes"),
      this.withHeaders({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
    );
  }

  // Look up historical precedents for a conflict
  async getPrecedents(conflictSummary: string, maxTokens: number = 1000): Promise<KnowledgeQueryResult> {
    const conflict = encodeURIComponent(conflictSummary);
    return fetchJSON<KnowledgeQueryResult>(
      this.url(`/api/knowledge/precedents?conflict=${conflict}&maxTokens=${maxTokens}`),
      this.withHeaders(),
    );
  }

  // Cross-source external context search (Slack, Fluffyjaws, Jira, Confluence,
  // GitHub, git). Pod-agnostic — pod_id is included from the client config only
  // when the client is pod-scoped, which enables local git search.
  async searchContext(
    query: string,
    opts?: Omit<ContextSearchRequest, "query">,
  ): Promise<ContextSearchResult> {
    const body: ContextSearchRequest = {
      query,
      ...opts,
      pod_id: opts?.pod_id ?? this.config.podId,
    };
    return searchContext(this.config.baseUrl, body, this.config.orgSlug);
  }

  // Pull bundled session context (living doc, pod state, conflicts, learnings, recent updates)
  async pullSessionContext(opts?: SessionContextOptions): Promise<SessionContext> {
    if (!this.isPodMode()) {
      throw new Error(
        "pullSessionContext requires a pod-scoped client (podId). For project-only mode use getProject(), getProjectUpdates(), and queryKnowledge().",
      );
    }
    const maxTokens = opts?.learningsMaxTokens ?? 2000;
    const recentLimit = opts?.recentUpdateLimit ?? 20;

    // Fetch the pod first so we can scope learnings to its project (avoids cross-project knowledge bleed).
    // Do not use the milestone name as the default semantic query: it is broad
    // enough to hard-gate away task-relevant learnings. A caller-supplied
    // externalQuery is task-specific, so it is safe to use for KG ranking.
    const pod = await this.getPod();
    const taskQuery = opts?.externalQuery?.trim() || undefined;
    const learningsOpts = {
      projectId: pod.project_id ?? null,
      query: taskQuery,
    };

    const baseFetches = [
      this.getContext(),
      this.getConflicts(),
      this.getRelevantLearnings(maxTokens, learningsOpts),
      this.getUpdates(),
    ] as const;

    const externalFetch = opts?.externalQuery
      ? this.searchContext(opts.externalQuery)
      : null;

    const results = await Promise.allSettled([...baseFetches, externalFetch]);

    const livingDocMarkdown = results[0].status === "fulfilled" ? (results[0].value as string) : "(unavailable)";
    const conflicts = results[1].status === "fulfilled" ? (results[1].value as Conflict[]) : [];
    const relevantLearnings: KnowledgeQueryResult = results[2].status === "fulfilled"
      ? (results[2].value as KnowledgeQueryResult)
      : { nodes: [], edges: [], total_matching: 0, token_estimate: 0, truncated: false };
    const allUpdates = results[3].status === "fulfilled" ? (results[3].value as ContextUpdate[]) : [];
    const externalContext =
      externalFetch && results[4].status === "fulfilled"
        ? (results[4].value as ContextSearchResult)
        : undefined;

    return {
      pulledAt: new Date().toISOString(),
      pod,
      livingDocMarkdown,
      conflicts,
      relevantLearnings,
      recentUpdates: allUpdates.slice(0, recentLimit),
      ...(externalContext ? { externalContext } : {}),
    };
  }

  /**
   * Project-scoped equivalent of pullSessionContext. Use this on project-only clients
   * (PM, review, or between-sprint agents) to get a single bundled read: project
   * metadata, recent project context updates, project-scoped org learnings, and an
   * optional external context search.
   */
  async pullProjectSessionContext(opts?: SessionContextOptions): Promise<ProjectSessionContext> {
    if (this.isPodMode()) {
      throw new Error(
        "pullProjectSessionContext requires a project-scoped client (projectId). For pod mode use pullSessionContext().",
      );
    }
    const maxTokens = opts?.learningsMaxTokens ?? 2000;
    const recentLimit = opts?.recentUpdateLimit ?? 20;

    // Fetch project first for metadata. Project names are intentionally not used
    // as the default semantic KG query because they are too broad and can filter
    // out task-relevant learnings. Use externalQuery when a task-specific query
    // is available.
    const project = await this.getProject();
    const taskQuery = opts?.externalQuery?.trim() || undefined;
    const learningsOpts = {
      projectId: this.config.projectId ?? null,
      query: taskQuery,
    };

    const baseFetches = [
      this.getProjectUpdates(),
      this.getRelevantLearnings(maxTokens, learningsOpts),
    ] as const;

    const externalFetch = opts?.externalQuery
      ? this.searchContext(opts.externalQuery, { project_id: this.config.projectId })
      : null;

    const results = await Promise.allSettled([...baseFetches, externalFetch]);

    const allUpdates = results[0].status === "fulfilled" ? (results[0].value as ProjectContextUpdate[]) : [];
    const relevantLearnings: KnowledgeQueryResult = results[1].status === "fulfilled"
      ? (results[1].value as KnowledgeQueryResult)
      : { nodes: [], edges: [], total_matching: 0, token_estimate: 0, truncated: false };
    const externalContext =
      externalFetch && results[2].status === "fulfilled"
        ? (results[2].value as ContextSearchResult)
        : undefined;

    return {
      pulledAt: new Date().toISOString(),
      project,
      relevantLearnings,
      recentUpdates: allUpdates.slice(0, recentLimit),
      ...(externalContext ? { externalContext } : {}),
    };
  }
}
