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
): Promise<ContextSearchResult> {
  return fetchJSON<ContextSearchResult>(
    `${baseUrl}/api/context-search`,
    withOrgHeader(
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      },
      orgSlug,
    ),
  );
}

interface PimClientConfigBase {
  baseUrl: string;
  agentId: string;
  scope: Scope;
  /** Org slug sent as X-Pim-Org on every request. Required once the server enforces org scoping. */
  orgSlug?: string;
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
    return withOrgHeader(init, this.config.orgSlug);
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

  // Get relevant learnings for this agent's scope with a token budget
  async getRelevantLearnings(maxTokens: number = 2000): Promise<KnowledgeQueryResult> {
    const scopes = encodeURIComponent(this.config.scope);
    return fetchJSON<KnowledgeQueryResult>(
      this.url(`/api/knowledge/relevant?scopes=${scopes}&maxTokens=${maxTokens}`),
      this.withHeaders(),
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

    const baseFetches = [
      this.getPod(),
      this.getContext(),
      this.getConflicts(),
      this.getRelevantLearnings(maxTokens),
      this.getUpdates(),
    ] as const;

    const externalFetch = opts?.externalQuery
      ? this.searchContext(opts.externalQuery)
      : null;

    const results = await Promise.allSettled([...baseFetches, externalFetch]);

    const pod = results[0].status === "fulfilled" ? (results[0].value as Pod) : null;
    if (!pod) {
      throw new Error(`Failed to fetch pod: ${results[0].status === "rejected" ? results[0].reason : "unknown"}`);
    }

    const livingDocMarkdown = results[1].status === "fulfilled" ? (results[1].value as string) : "(unavailable)";
    const conflicts = results[2].status === "fulfilled" ? (results[2].value as Conflict[]) : [];
    const relevantLearnings: KnowledgeQueryResult = results[3].status === "fulfilled"
      ? (results[3].value as KnowledgeQueryResult)
      : { nodes: [], edges: [], total_matching: 0, token_estimate: 0, truncated: false };
    const allUpdates = results[4].status === "fulfilled" ? (results[4].value as ContextUpdate[]) : [];
    const externalContext =
      externalFetch && results[5].status === "fulfilled"
        ? (results[5].value as ContextSearchResult)
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
}
