import type {
  Pod,
  Conflict,
  ContextUpdate,
  ContextUpdateType,
  WorkStatus,
  Scope,
  Artifact,
  InputRequest,
  KnowledgeQueryOptions,
  KnowledgeQueryResult,
} from "@council/shared";

export interface CouncilClientConfig {
  baseUrl: string;
  podId: string;
  agentId: string;
  scope: Scope;
}

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
  update: ContextUpdate;
  council: {
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
    throw new Error(`Council API error ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

export class CouncilClient {
  private config: CouncilClientConfig;

  constructor(config: CouncilClientConfig) {
    this.config = config;
  }

  private url(path: string): string {
    return `${this.config.baseUrl}${path}`;
  }

  // Submit a context update to the Council
  async report(input: ReportInput): Promise<ReportResult> {
    return fetchJSON<ReportResult>(
      this.url(`/api/pods/${this.config.podId}/context-updates`),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: this.config.agentId,
          scope: this.config.scope,
          ...input,
        }),
      },
    );
  }

  // Fetch the current living doc for the pod
  async getContext(): Promise<string> {
    const res = await fetch(this.url(`/api/pods/${this.config.podId}/living-doc`));
    if (!res.ok) throw new Error(`Failed to fetch living doc: ${res.status}`);
    return res.text();
  }

  // Fetch current pod state
  async getPod(): Promise<Pod> {
    return fetchJSON<Pod>(this.url(`/api/pods/${this.config.podId}`));
  }

  // Fetch current conflicts for the pod
  async getConflicts(): Promise<Conflict[]> {
    return fetchJSON<Conflict[]>(this.url(`/api/pods/${this.config.podId}/conflicts`));
  }

  // Fetch context updates for the pod
  async getUpdates(): Promise<ContextUpdate[]> {
    return fetchJSON<ContextUpdate[]>(this.url(`/api/pods/${this.config.podId}/context-updates`));
  }

  // Query the organizational knowledge graph with token budget
  async queryKnowledge(options: KnowledgeQueryOptions): Promise<KnowledgeQueryResult> {
    return fetchJSON<KnowledgeQueryResult>(this.url("/api/knowledge/query"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options),
    });
  }

  // Get relevant learnings for this agent's scope with a token budget
  async getRelevantLearnings(maxTokens: number = 2000): Promise<KnowledgeQueryResult> {
    const scopes = encodeURIComponent(this.config.scope);
    return fetchJSON<KnowledgeQueryResult>(
      this.url(`/api/knowledge/relevant?scopes=${scopes}&maxTokens=${maxTokens}`),
    );
  }

  // Look up historical precedents for a conflict
  async getPrecedents(conflictSummary: string, maxTokens: number = 1000): Promise<KnowledgeQueryResult> {
    const conflict = encodeURIComponent(conflictSummary);
    return fetchJSON<KnowledgeQueryResult>(
      this.url(`/api/knowledge/precedents?conflict=${conflict}&maxTokens=${maxTokens}`),
    );
  }
}
