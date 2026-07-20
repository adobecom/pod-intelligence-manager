import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

process.env.PIM_API_URL = "http://pim.test";
process.env.PIM_ORG_SLUG = "adobecom";

const api = await import("../src/api.ts");
const { registerTools } = await import("../src/tools.ts");

type FetchCall = { url: string; init?: RequestInit };
type ToolResult = { content: Array<{ type: "text"; text: string }> };
type ToolHandler = (input: Record<string, unknown>) => Promise<ToolResult>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return calls;
}

function registerToolHandlers(): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  registerTools({
    tool(name: string, _description: string, _schema: unknown, handler: ToolHandler) {
      tools.set(name, handler);
    },
  } as never);
  return tools;
}

function parseToolResult(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

function baseApiHandler(url: string, init?: RequestInit): Response {
  if (url.endsWith("/api/health")) return jsonResponse({ auth_mode: "trust" });
  if (url.endsWith("/api/projects/project-demo")) {
    return jsonResponse({ project_id: "project-demo", name: "Demo Project" });
  }
  if (url.includes("/api/knowledge/relevant")) {
    return jsonResponse({ nodes: [], edges: [], total_matching: 0, token_estimate: 0, truncated: false });
  }
  if (url.endsWith("/api/context-search")) {
    assert.equal(init?.method, "POST");
    return jsonResponse({ query: "speaker put contract", hits: [], sources_used: [] });
  }
  throw new Error(`Unexpected URL ${url}`);
}

beforeEach(() => {
  process.env.PIM_ORG_SLUG = "adobecom";
  api._resetOrgSelectionForTests();
});

test("get_project_session_context requests compact heading offset 2", async () => {
  const calls = installFetch(baseApiHandler);
  const tools = registerToolHandlers();

  const result = await tools.get("get_project_session_context")!({
    project_id: "project-demo",
    agent_id: "agent-fe",
    scope: "frontend",
  });

  const body = parseToolResult(result);
  assert.equal((body.project as { name?: string }).name, "Demo Project");
  const knowledgeCall = calls.find((call) => call.url.includes("/api/knowledge/relevant"));
  assert.ok(knowledgeCall);
  assert.equal(
    knowledgeCall.url,
    "http://pim.test/api/knowledge/relevant?scopes=frontend&maxTokens=4000&projectId=project-demo&compactHeadingOffset=2",
  );
});

test("get_project_session_context delivers compact KG context without debug payload bloat", async () => {
  installFetch((url, init) => {
    if (url.includes("/api/knowledge/relevant")) {
      return jsonResponse({
        nodes: Array.from({ length: 8 }, (_, index) => ({
          id: `kg-${index + 1}`,
          type: "pattern",
          summary: `Learning ${index + 1}`,
          details: "large details that should not enter the session prompt",
          source_pod_name: "Seed Pod",
          confidence_score: 0.9,
        })),
        edges: [{ source: "kg-1", target: "kg-2", type: "relates_to" }],
        explanations: [{ node_id: "kg-1", score_components: { very: "large" } }],
        compact_context: "# PIM KG Compact Context\n- Learning 1\n- Learning 2\n- Learning 3",
        compact_context_node_count: 3,
        total_matching: 20,
        token_estimate: 600,
        truncated: true,
        retrieval_diagnostics: { mode: "hybrid", returned_count: 8 },
      });
    }
    return baseApiHandler(url, init);
  });
  const tools = registerToolHandlers();

  const result = await tools.get("get_project_session_context")!({
    project_id: "project-demo",
    agent_id: "agent-fe",
    scope: "frontend",
  });

  const body = parseToolResult(result);
  const learnings = body.relevant_learnings as Record<string, unknown>;
  assert.equal(learnings.candidate_node_count, 8);
  assert.equal((learnings.nodes as unknown[]).length, 3);
  assert.equal(learnings.explanations, undefined);
  assert.deepEqual(learnings.edges, []);
  assert.match(String(learnings.compact_context), /Learning 1/);
  assert.ok(Number(learnings.delivered_token_estimate) < Number(learnings.token_estimate));
});

test("get_project_session_context includes task-ranked project search when task query is supplied", async () => {
  const calls = installFetch((url, init) => {
    if (url.endsWith("/api/projects/project-demo/search")) {
      assert.equal(init?.method, "POST");
      return jsonResponse({
        query: "speaker put contract",
        hits: [{ source_id: "pcu-1", source: "project_update", title: "Speaker API contract" }],
      });
    }
    return baseApiHandler(url, init);
  });
  const tools = registerToolHandlers();

  const result = await tools.get("get_project_session_context")!({
    project_id: "project-demo",
    agent_id: "agent-fe",
    scope: "frontend",
    task_query: "speaker put contract",
  });

  const searchCall = calls.find((call) => call.url.endsWith("/api/projects/project-demo/search"));
  assert.ok(searchCall);
  assert.deepEqual(JSON.parse(String(searchCall.init?.body)), {
    query: "speaker put contract",
    sources: ["project_update", "pod_update"],
    max_hits: 20,
    synthesize: true,
    include_kg: false,
    include_mind_map: false,
  });

  const body = parseToolResult(result);
  assert.equal(((body.project_search as { hits: Array<{ source_id: string }> }).hits[0]!).source_id, "pcu-1");
  assert.equal(body.project_search_error, undefined);
});

test("get_project_session_context surfaces project search errors explicitly", async () => {
  installFetch((url, init) => {
    if (url.endsWith("/api/projects/project-demo/search")) {
      assert.equal(init?.method, "POST");
      return jsonResponse({ error: "Search exploded" }, 500);
    }
    return baseApiHandler(url, init);
  });
  const tools = registerToolHandlers();

  const result = await tools.get("get_project_session_context")!({
    project_id: "project-demo",
    agent_id: "agent-fe",
    scope: "frontend",
    task_query: "speaker put contract",
  });

  const body = parseToolResult(result);
  assert.equal(body.project_search, undefined);
  assert.match(String(body.project_search_error), /PIM API 500/);
  assert.match(String(body.project_search_error), /Search exploded/);
});
