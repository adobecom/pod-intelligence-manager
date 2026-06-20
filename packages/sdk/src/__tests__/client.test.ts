import { describe, it, expect, vi, beforeEach } from "vitest";
import { PimClient } from "../client.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

function makeClient(overrides = {}) {
  return new PimClient({
    baseUrl: "http://localhost:4000",
    podId: "pod-1",
    agentId: "agent-fe",
    scope: "frontend",
    ...overrides,
  });
}

function mockOk(body: any = {}) {
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  });
}

function mockError(status: number, body: string) {
  mockFetch.mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve({ error: body }),
    text: () => Promise.resolve(body),
  });
}

describe("PimClient", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe("constructor", () => {
    it("requires exactly one of podId or projectId", () => {
      expect(
        () =>
          new PimClient({
            baseUrl: "http://localhost:4000",
            agentId: "a",
            scope: "frontend",
            podId: "p",
            projectId: "proj",
          } as never),
      ).toThrow(/exactly one of podId or projectId/);
      expect(
        () =>
          new PimClient({
            baseUrl: "http://localhost:4000",
            agentId: "a",
            scope: "frontend",
          } as never),
      ).toThrow(/exactly one of podId or projectId/);
    });
  });

  describe("report", () => {
    it("sends POST to the correct URL", async () => {
      mockOk({ id: "ctx-001", update: {}, pim: {} });
      const client = makeClient();

      await client.report({
        type: "progress",
        summary: "Form done",
        details: "Added validation",
        status: "in_progress",
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:4000/api/pods/pod-1/context-updates",
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("sends POST to project URL when project-scoped", async () => {
      mockOk({ id: "pcu-001", update: {}, pim: {} });
      const client = new PimClient({
        baseUrl: "http://localhost:4000",
        projectId: "project-demo",
        agentId: "agent-fe",
        scope: "frontend",
      });

      await client.report({
        type: "decision",
        summary: "Chose SQLite",
        details: "",
        status: "completed",
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:4000/api/projects/project-demo/context-updates",
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("merges agent_id and scope from config into body", async () => {
      mockOk({ id: "ctx-001", update: {}, pim: {} });
      const client = makeClient();

      await client.report({
        type: "progress",
        summary: "Form done",
        details: "",
        status: "in_progress",
      });

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.agent_id).toBe("agent-fe");
      expect(callBody.scope).toBe("frontend");
    });

    it("throws on non-2xx response", async () => {
      mockError(400, "Validation failed");
      const client = makeClient();

      await expect(
        client.report({ type: "progress", summary: "x", details: "", status: "in_progress" }),
      ).rejects.toThrow("PIM API error 400");
    });

    it("returns queued pressure responses without treating them as failures", async () => {
      mockOk({
        queued: true,
        queue_id: "queue-1",
        queue_size: 2,
        conflict_pressure: 0.91,
        message: "Pod is in critical conflict state",
      });
      const client = makeClient();

      const result = await client.report({
        type: "progress",
        summary: "PR opened",
        details: "Queued while pressure is critical",
        status: "in_progress",
      });

      expect(result).toEqual(expect.objectContaining({ queued: true, conflict_pressure: 0.91 }));
    });
  });

  describe("agent memory", () => {
    it("creates an agent session with default binding metadata and auth headers", async () => {
      mockOk({ session_id: "sess-1", status: "active" });
      const client = makeClient({ orgSlug: "adobecom", authToken: "token-1" });

      await client.createAgentSession({
        goal: "Implement Fiesta integration",
        metadata: { external_trace_refs: ["ls-run-1"] },
      });

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:4000/api/agent-sessions");
      expect(init.method).toBe("POST");
      expect(new Headers(init.headers).get("X-Pim-Org")).toBe("adobecom");
      expect(new Headers(init.headers).get("Authorization")).toBe("Bearer token-1");
      expect(JSON.parse(init.body)).toEqual({
        project_id: null,
        pod_id: "pod-1",
        scope: "frontend",
        agent_id: "agent-fe",
        goal: "Implement Fiesta integration",
        metadata: { external_trace_refs: ["ls-run-1"] },
      });
    });

    it("creates an agent session from a project-scoped client", async () => {
      mockOk({ session_id: "sess-1", status: "active" });
      const client = makeClient({ podId: undefined, projectId: "project-demo" });

      await client.createAgentSession({ current_task: "Plan project-only run" });

      expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
        project_id: "project-demo",
        pod_id: null,
        scope: "frontend",
        agent_id: "agent-fe",
        current_task: "Plan project-only run",
      });
    });

    it("creates runs, appends sparse events, and writes checkpoints", async () => {
      mockOk({});
      const client = makeClient();

      await client.createAgentRun("sess-1", {
        input_prompt: "Issue body",
        model: "gpt-test",
        provider: "openai",
      });
      await client.appendAgentRunEvent("run-1", {
        event_type: "file_change",
        summary: "Changed planner prompt",
        artifact_refs: [{ type: "file", path: "src/nodes/planner.py" }],
        expected_seq: 1,
      });
      await client.createAgentCheckpoint("sess-1", {
        run_id: "run-1",
        snapshot: { spec: { acceptance_criteria: ["KG learnings rendered"] } },
        summary: "Planner spec checkpoint",
      });

      expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:4000/api/agent-sessions/sess-1/runs");
      expect(mockFetch.mock.calls[0][1].method).toBe("POST");
      expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
        input_prompt: "Issue body",
        model: "gpt-test",
        provider: "openai",
      });

      expect(mockFetch.mock.calls[1][0]).toBe("http://localhost:4000/api/agent-runs/run-1/events");
      expect(JSON.parse(mockFetch.mock.calls[1][1].body)).toEqual({
        event_type: "file_change",
        summary: "Changed planner prompt",
        artifact_refs: [{ type: "file", path: "src/nodes/planner.py" }],
        expected_seq: 1,
      });

      expect(mockFetch.mock.calls[2][0]).toBe("http://localhost:4000/api/agent-sessions/sess-1/checkpoints");
      expect(JSON.parse(mockFetch.mock.calls[2][1].body)).toEqual({
        run_id: "run-1",
        snapshot: { spec: { acceptance_criteria: ["KG learnings rendered"] } },
        summary: "Planner spec checkpoint",
      });
    });

    it("updates session working state and ends a run with aggregate costs", async () => {
      mockOk({});
      const client = makeClient();

      await client.updateAgentSessionWorkingState("sess-1", {
        working_state: { phase: "verification" },
        current_task: "Run tests",
        merge: true,
      });
      await client.endAgentRun("run-1", {
        status: "completed",
        final_output: "Verification passed",
        token_input_count: 12,
        token_output_count: 34,
        total_cost_usd: 0.056,
        context_update_id: "ctx-1",
      });

      expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:4000/api/agent-sessions/sess-1/working-state");
      expect(mockFetch.mock.calls[0][1].method).toBe("PATCH");
      expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
        working_state: { phase: "verification" },
        current_task: "Run tests",
        merge: true,
      });

      expect(mockFetch.mock.calls[1][0]).toBe("http://localhost:4000/api/agent-runs/run-1/end");
      expect(mockFetch.mock.calls[1][1].method).toBe("PATCH");
      expect(JSON.parse(mockFetch.mock.calls[1][1].body)).toEqual({
        status: "completed",
        final_output: "Verification passed",
        token_input_count: 12,
        token_output_count: 34,
        total_cost_usd: 0.056,
        context_update_id: "ctx-1",
      });
    });

    it("rolls up sessions and reviews memory candidates", async () => {
      mockOk([]);
      const client = makeClient();

      await client.rollupAgentSession("sess-1");
      await client.listSessionMemoryCandidates("sess-1", { status: "pending" });
      await client.promoteMemoryCandidate("mc-1");
      await client.rejectMemoryCandidate("mc-2");
      await client.endAgentSession("sess-1");

      expect(mockFetch.mock.calls[0]).toEqual([
        "http://localhost:4000/api/agent-sessions/sess-1/rollup",
        expect.objectContaining({ method: "POST" }),
      ]);
      expect(mockFetch.mock.calls[1][0]).toBe(
        "http://localhost:4000/api/agent-sessions/sess-1/memory-candidates?status=pending",
      );
      expect(mockFetch.mock.calls[2]).toEqual([
        "http://localhost:4000/api/memory-candidates/mc-1/promote",
        expect.objectContaining({ method: "POST" }),
      ]);
      expect(mockFetch.mock.calls[3]).toEqual([
        "http://localhost:4000/api/memory-candidates/mc-2/reject",
        expect.objectContaining({ method: "POST" }),
      ]);
      expect(mockFetch.mock.calls[4]).toEqual([
        "http://localhost:4000/api/agent-sessions/sess-1/end",
        expect.objectContaining({ method: "POST" }),
      ]);
    });

    it("fetches resume context with an event limit", async () => {
      mockOk({ session: {}, working_state: {}, recent_events: [] });
      const client = makeClient();

      await client.getAgentResumeContext("sess-1", 50);

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:4000/api/agent-sessions/sess-1/resume-context?event_limit=50",
        undefined,
      );
    });
  });

  describe("getContext", () => {
    it("sends GET and returns text", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve("# Living Doc\n\nContent here"),
      });
      const client = makeClient();

      const result = await client.getContext();
      expect(result).toBe("# Living Doc\n\nContent here");
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:4000/api/pods/pod-1/living-doc",
        undefined,
      );
    });
  });

  describe("getPod", () => {
    it("sends GET to /api/pods/:podId", async () => {
      mockOk({ pod_id: "pod-1", name: "Alpha" });
      const client = makeClient();

      const pod = await client.getPod();
      expect(pod.pod_id).toBe("pod-1");
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:4000/api/pods/pod-1",
        undefined,
      );
    });
  });

  describe("getConflicts", () => {
    it("sends GET to /api/pods/:podId/conflicts", async () => {
      mockOk([]);
      const client = makeClient();

      await client.getConflicts();
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:4000/api/pods/pod-1/conflicts",
        undefined,
      );
    });
  });

  describe("getUpdates", () => {
    it("sends GET to /api/pods/:podId/context-updates", async () => {
      mockOk([]);
      const client = makeClient();

      await client.getUpdates();
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:4000/api/pods/pod-1/context-updates",
        undefined,
      );
    });
  });

  describe("queryKnowledge", () => {
    it("sends POST with body to /api/knowledge/query", async () => {
      mockOk({ nodes: [] });
      const client = makeClient();

      await client.queryKnowledge({ filters: { domains: ["frontend"] }, max_tokens: 2000 });

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:4000/api/knowledge/query",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  describe("getRelevantLearnings", () => {
    it("builds URL with query params", async () => {
      mockOk({ nodes: [] });
      const client = makeClient();

      await client.getRelevantLearnings(1500);

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:4000/api/knowledge/relevant?scopes=frontend&maxTokens=1500",
        undefined,
      );
    });

    it("defaults to 4000 max tokens", async () => {
      mockOk({ nodes: [] });
      const client = makeClient();

      await client.getRelevantLearnings();

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("maxTokens=4000"),
        undefined,
      );
    });

    it("sends taskQuery as the first-class relevant-learning query parameter", async () => {
      mockOk({ nodes: [] });
      const client = makeClient();

      await client.getRelevantLearnings(1500, { taskQuery: "speaker put contract" });

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:4000/api/knowledge/relevant?scopes=frontend&maxTokens=1500&taskQuery=speaker%20put%20contract",
        undefined,
      );
    });
  });

  describe("getPrecedents", () => {
    it("encodes conflict summary in URL", async () => {
      mockOk({ nodes: [] });
      const client = makeClient();

      await client.getPrecedents("API contract mismatch", 500);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("conflict=API%20contract%20mismatch"),
        undefined,
      );
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("maxTokens=500"),
        undefined,
      );
    });
  });

  describe("searchContext", () => {
    it("forwards org and auth headers from the client config", async () => {
      mockOk({ query: "contract", hits: [], sources_used: [] });
      const client = makeClient({ orgSlug: "adobecom", authToken: "token-1" });

      await client.searchContext("contract");

      const [, init] = mockFetch.mock.calls[0];
      expect(new Headers(init.headers).get("X-Pim-Org")).toBe("adobecom");
      expect(new Headers(init.headers).get("Authorization")).toBe("Bearer token-1");
    });
  });

  describe("pullSessionContext", () => {
    function mockSessionContextResponses() {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("/living-doc")) {
          return Promise.resolve({
            ok: true,
            text: () => Promise.resolve("# Living"),
          });
        }
        if (url.includes("/conflicts")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
        }
        if (url.includes("/context-updates")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
        }
        if (url.includes("/knowledge/relevant")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ nodes: [], total_matching: 0, truncated: false }),
          });
        }
        if (url.includes("/api/context-search")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ query: "speaker put contract", hits: [], sources_used: [] }),
          });
        }
        if (url.includes("/api/pods/pod-1")) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                pod_id: "pod-1",
                name: "Alpha",
                sprint_start: "",
                sprint_end: "",
                day_number: 1,
                total_days: 5,
                conflict_pressure: 0,
                milestone: { name: "M", target_date: "", percent_complete: 0 },
                areas: [],
              }),
          });
        }
        return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve("") });
      });
    }

    it("parallel-fetches living doc, pod, conflicts, learnings, updates", async () => {
      mockSessionContextResponses();

      const client = makeClient();
      const ctx = await client.pullSessionContext({ recentUpdateLimit: 3 });

      expect(ctx.livingDocMarkdown).toBe("# Living");
      expect(ctx.pod.name).toBe("Alpha");
      expect(ctx.recentUpdates).toEqual([]);
      expect(ctx.pulledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(mockFetch).toHaveBeenCalled();
    });

    it("does not use the pod milestone as the default KG query", async () => {
      mockSessionContextResponses();

      const client = makeClient();
      await client.pullSessionContext();

      const knowledgeUrl = mockFetch.mock.calls
        .map(([url]) => String(url))
        .find((url) => url.includes("/knowledge/relevant"));
      expect(knowledgeUrl).toBe(
        "http://localhost:4000/api/knowledge/relevant?scopes=frontend&maxTokens=4000&compactHeadingOffset=2",
      );
    });

    it("uses taskQuery as the task-specific KG query when supplied", async () => {
      mockSessionContextResponses();

      const client = makeClient();
      await client.pullSessionContext({ taskQuery: "speaker put contract" });

      const knowledgeUrl = mockFetch.mock.calls
        .map(([url]) => String(url))
        .find((url) => url.includes("/knowledge/relevant"));
      expect(knowledgeUrl).toContain("taskQuery=speaker%20put%20contract");
    });

    it("keeps externalQuery as a taskQuery alias", async () => {
      mockSessionContextResponses();

      const client = makeClient();
      await client.pullSessionContext({ externalQuery: "speaker put contract" });

      const knowledgeUrl = mockFetch.mock.calls
        .map(([url]) => String(url))
        .find((url) => url.includes("/knowledge/relevant"));
      expect(knowledgeUrl).toContain("taskQuery=speaker%20put%20contract");
    });
  });

  describe("pullProjectSessionContext", () => {
    function mockProjectSessionContextResponses() {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("/api/projects/project-demo/context-updates")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
        }
        if (url.includes("/api/projects/project-demo/search")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              query: "speaker put contract",
              project_id: "project-demo",
              hits: [
                {
                  document_id: "doc-1",
                  source: "project_update",
                  source_type: "project_context_update",
                  source_id: "pcu-1",
                  title: "Speaker API contract",
                  snippet: "Use the existing PUT contract.",
                  freshness: "fresh",
                  score: 12,
                  matched: { lexical: true },
                },
              ],
              sources_used: ["project_update"],
              documents_by_source: { project_update: 1 },
              detected_identifiers: [],
              embedding_coverage: 0,
              retrieval_mode: "lexical",
              total_documents: 1,
              generated_at: "2026-06-01T00:00:00.000Z",
            }),
          });
        }
        if (url.includes("/knowledge/relevant")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ nodes: [], total_matching: 0, truncated: false }),
          });
        }
        if (url.includes("/api/context-search")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ query: "speaker put contract", hits: [], sources_used: [] }),
          });
        }
        if (url.includes("/api/projects/project-demo")) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                project_id: "project-demo",
                name: "Demo Project",
                description: "",
                created_at: "",
              }),
          });
        }
        return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve("") });
      });
    }

    it("does not use the project name as the default KG query", async () => {
      mockProjectSessionContextResponses();

      const client = makeClient({ podId: undefined, projectId: "project-demo" });
      const ctx = await client.pullProjectSessionContext();

      const knowledgeUrl = mockFetch.mock.calls
        .map(([url]) => String(url))
        .find((url) => url.includes("/knowledge/relevant"));
      expect(knowledgeUrl).toBe(
        "http://localhost:4000/api/knowledge/relevant?scopes=frontend&maxTokens=4000&projectId=project-demo&compactHeadingOffset=2",
      );
      expect(ctx.recentUpdates).toEqual([]);
      expect(ctx.projectSearch).toBeUndefined();
      expect(mockFetch.mock.calls.some(([url]) => String(url).includes("/context-updates"))).toBe(false);
      expect(mockFetch.mock.calls.some(([url]) => String(url).includes("/search"))).toBe(false);
    });

    it("uses taskQuery for project KG and ranked project-update search when supplied", async () => {
      mockProjectSessionContextResponses();

      const client = makeClient({ podId: undefined, projectId: "project-demo" });
      const ctx = await client.pullProjectSessionContext({ taskQuery: "speaker put contract" });

      const knowledgeUrl = mockFetch.mock.calls
        .map(([url]) => String(url))
        .find((url) => url.includes("/knowledge/relevant"));
      expect(knowledgeUrl).toContain("taskQuery=speaker%20put%20contract");
      const searchCall = mockFetch.mock.calls.find(([url]) => String(url).includes("/api/projects/project-demo/search"));
      expect(searchCall).toBeTruthy();
      expect(JSON.parse(searchCall![1].body)).toEqual({
        query: "speaker put contract",
        sources: ["project_update", "pod_update"],
        max_hits: 20,
        synthesize: true,
        include_kg: false,
        include_mind_map: false,
      });
      expect(ctx.projectSearch?.hits[0].source_id).toBe("pcu-1");
      expect(ctx.recentUpdates).toEqual([]);
    });

    it("keeps externalQuery as the project taskQuery alias", async () => {
      mockProjectSessionContextResponses();

      const client = makeClient({ podId: undefined, projectId: "project-demo" });
      await client.pullProjectSessionContext({ externalQuery: "speaker put contract" });

      const knowledgeUrl = mockFetch.mock.calls
        .map(([url]) => String(url))
        .find((url) => url.includes("/knowledge/relevant"));
      expect(knowledgeUrl).toContain("taskQuery=speaker%20put%20contract");
    });

    it("pullProjectTaskContext requires no project feed fallback", async () => {
      mockProjectSessionContextResponses();

      const client = makeClient({ podId: undefined, projectId: "project-demo" });
      await client.pullProjectTaskContext("speaker put contract", { recentUpdateLimit: 5 });

      const searchCall = mockFetch.mock.calls.find(([url]) => String(url).includes("/api/projects/project-demo/search"));
      expect(searchCall).toBeTruthy();
      expect(JSON.parse(searchCall![1].body).max_hits).toBe(5);
      expect(mockFetch.mock.calls.some(([url]) => String(url).includes("/context-updates"))).toBe(false);
    });
  });
});
