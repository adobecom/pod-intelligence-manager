import { describe, it, expect, vi, beforeEach } from "vitest";
import { CouncilClient } from "../client.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

function makeClient(overrides = {}) {
  return new CouncilClient({
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

describe("CouncilClient", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe("constructor", () => {
    it("requires exactly one of podId or projectId", () => {
      expect(
        () =>
          new CouncilClient({
            baseUrl: "http://localhost:4000",
            agentId: "a",
            scope: "frontend",
            podId: "p",
            projectId: "proj",
          } as never),
      ).toThrow(/exactly one of podId or projectId/);
      expect(
        () =>
          new CouncilClient({
            baseUrl: "http://localhost:4000",
            agentId: "a",
            scope: "frontend",
          } as never),
      ).toThrow(/exactly one of podId or projectId/);
    });
  });

  describe("report", () => {
    it("sends POST to the correct URL", async () => {
      mockOk({ id: "ctx-001", update: {}, council: {} });
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
      mockOk({ id: "pcu-001", update: {}, council: {} });
      const client = new CouncilClient({
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
      mockOk({ id: "ctx-001", update: {}, council: {} });
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
      ).rejects.toThrow("Council API error 400");
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
      expect(mockFetch).toHaveBeenCalledWith("http://localhost:4000/api/pods/pod-1/living-doc");
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

    it("defaults to 2000 max tokens", async () => {
      mockOk({ nodes: [] });
      const client = makeClient();

      await client.getRelevantLearnings();

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("maxTokens=2000"),
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

  describe("pullSessionContext", () => {
    it("parallel-fetches living doc, pod, conflicts, learnings, updates", async () => {
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

      const client = makeClient();
      const ctx = await client.pullSessionContext({ recentUpdateLimit: 3 });

      expect(ctx.livingDocMarkdown).toBe("# Living");
      expect(ctx.pod.name).toBe("Alpha");
      expect(ctx.recentUpdates).toEqual([]);
      expect(ctx.pulledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(mockFetch).toHaveBeenCalled();
    });
  });
});
