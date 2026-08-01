import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import Fastify, {
  type FastifyContextConfig,
  type FastifyInstance,
} from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createTables } from "../../db/schema.js";
import db from "../../db/connection.js";
import { registerJsonBodyParser } from "../../middleware/validation.js";
import {
  createServiceToken,
  type CreatedServiceToken,
} from "../../services/service-tokens.js";
import { createOrg } from "../../services/orgs.js";
import { upsertUserByIms } from "../../services/users.js";
import hostedMcpRoutes, { HOSTED_MCP_BODY_LIMIT } from "../hosted-mcp.js";

interface ApiCall {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

let app: FastifyInstance;
let baseUrl: string;
let valid: CreatedServiceToken;
let underScoped: CreatedServiceToken;
let extraScoped: CreatedServiceToken;
let projectBound: CreatedServiceToken;
let podBound: CreatedServiceToken;
let expired: CreatedServiceToken;
let postRouteConfig: FastifyContextConfig | undefined;
const apiCalls: ApiCall[] = [];

function futureExpiry(): string {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
}

function createToken(
  orgId: string,
  ownerUserId: string,
  name: string,
  scopes: string[],
  projectId?: string,
): CreatedServiceToken {
  return createServiceToken({
    orgId,
    name,
    scopes,
    createdByUserId: ownerUserId,
    projectId,
    expiresAt: futureExpiry(),
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fetchImpl = vi.fn(async (
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
  apiCalls.push({ url, headers: new Headers(init?.headers), body });

  if (url.endsWith("/api/skill-search")) {
    if (body.query === "catalog unavailable") {
      return jsonResponse({ status: "unavailable", results: [] });
    }
    return jsonResponse({
      status: "ready",
      catalog: {
        sourceId: "org-default",
        selectionMode: body.projectId ? "project" : "org_default",
        commitSha: "a".repeat(40),
        snapshotState: "search_ready",
      },
      results: [{ name: "existing-review", path: "shared/existing-review.md" }],
    });
  }

  const candidates = body.candidates as Array<{ candidateId: string; name: string }>;
  const candidate = candidates[0]!;
  if (candidate.name === "Catalog Building") {
    return jsonResponse({
      error: "catalog_building",
      sourceId: "org-default",
      commitSha: "b".repeat(40),
    }, 202);
  }
  if (candidate.name === "Catalog Unavailable") {
    return jsonResponse({
      error: "catalog_not_ready",
      message: "Catalog snapshot is unavailable",
    }, 503);
  }
  return jsonResponse({
    catalog: {
      sourceId: "org-default",
      selectionMode: body.projectId ? "project" : "org_default",
      commitSha: "a".repeat(40),
      snapshotState: "entries_ready",
    },
    matcherVersion: "v1",
    results: [{
      candidateId: candidate.candidateId,
      status: candidate.name === "Known Duplicate" ? "conflict_found" : "clear",
      conflicts:
        candidate.name === "Known Duplicate"
          ? [{ kind: "same_namespace_name" }]
          : [],
      related: [],
    }],
  });
}) as unknown as typeof fetch;

function mcpHeaders(token?: string): Record<string, string> {
  return {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

function initializePayload() {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "hosted-mcp-test", version: "1.0.0" },
    },
  };
}

function candidate(name: string) {
  return {
    candidate_id: name.toLowerCase().replaceAll(" ", "-"),
    name,
    proposed_path: "shared/skills/candidate.md",
    target_namespace: "shared",
    body: `# ${name}\n\nFinal skill Markdown.`,
  };
}

function parseToolText(result: unknown): Record<string, unknown> {
  const content =
    typeof result === "object" && result !== null
      ? (result as { content?: unknown }).content
      : undefined;
  if (!Array.isArray(content)) throw new Error("Expected tool content");
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    throw new Error("Expected text tool content");
  }
  return JSON.parse(first.text) as Record<string, unknown>;
}

beforeAll(async () => {
  createTables();
  const owner = upsertUserByIms({
    email: "hosted-mcp-owner@example.com",
    display_name: "Hosted MCP Owner",
  });
  const org = createOrg({
    slug: "hosted-mcp",
    name: "Hosted MCP",
    creatorUserId: owner.user_id,
  });
  db.prepare(
    `INSERT INTO projects
       (project_id, name, description, created_at, anatomy_json, org_id, created_by_user_id)
     VALUES (?, ?, NULL, ?, ?, ?, ?)`,
  ).run(
    "project-hosted",
    "Hosted Project",
    new Date().toISOString(),
    JSON.stringify({ internal: [], external: [] }),
    org.org_id,
    owner.user_id,
  );
  db.prepare(
    `INSERT INTO pods
       (pod_id, name, sprint_start, sprint_end, day_number, total_days,
        conflict_pressure, milestone_json, project_id, org_id, created_by_user_id)
     VALUES (?, ?, '2026-07-27', '2026-07-31', 1, 5, 0, ?, ?, ?, ?)`,
  ).run(
    "pod-hosted",
    "Hosted Pod",
    JSON.stringify({
      name: "Hosted MCP",
      target_date: "2026-07-31",
      percent_complete: 0,
    }),
    "project-hosted",
    org.org_id,
    owner.user_id,
  );

  valid = createToken(
    org.org_id,
    owner.user_id,
    "valid-hosted",
    ["skill-catalog:read", "skill-conflicts:check"],
  );
  underScoped = createToken(
    org.org_id,
    owner.user_id,
    "under-scoped-hosted",
    ["skill-catalog:read"],
  );
  extraScoped = createToken(
    org.org_id,
    owner.user_id,
    "extra-scoped-hosted",
    ["skill-catalog:read", "skill-conflicts:check", "project:read"],
  );
  projectBound = createToken(
    org.org_id,
    owner.user_id,
    "project-bound-hosted",
    ["skill-catalog:read", "skill-conflicts:check"],
    "project-hosted",
  );
  podBound = createServiceToken({
    orgId: org.org_id,
    name: "pod-bound-hosted",
    scopes: ["skill-catalog:read", "skill-conflicts:check"],
    createdByUserId: owner.user_id,
    podId: "pod-hosted",
    expiresAt: futureExpiry(),
  });
  expired = createToken(
    org.org_id,
    owner.user_id,
    "expired-hosted",
    ["skill-catalog:read", "skill-conflicts:check"],
  );
  db.prepare("UPDATE service_tokens SET expires_at = ? WHERE token_id = ?").run(
    new Date(Date.now() - 1_000).toISOString(),
    expired.token_id,
  );

  app = Fastify({ logger: false });
  registerJsonBodyParser(app);
  app.addHook("onRoute", (options) => {
    if (options.method === "POST" && options.url === "/mcp") {
      postRouteConfig = options.config;
    }
  });
  await app.register(hostedMcpRoutes, {
    apiBaseUrl: "http://127.0.0.1:4000",
    fetchImpl,
  });
  baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
});

afterAll(async () => {
  await app.close();
});

describe("hosted skills MCP authentication", () => {
  it.each([
    ["missing", () => undefined],
    ["non-service", () => "not-a-service-token"],
    [
      "invalid",
      () =>
        `${valid.token.slice(0, -1)}${valid.token.endsWith("0") ? "1" : "0"}`,
    ],
    ["expired", () => expired.token],
  ])("rejects %s credentials with 401", async (_label, getToken) => {
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: mcpHeaders(getToken()),
      payload: initializePayload(),
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toHaveProperty("error");
  });

  it.each([
    ["project-bound", () => projectBound.token],
    ["pod-bound", () => podBound.token],
    ["under-scoped", () => underScoped.token],
    ["extra-scoped", () => extraScoped.token],
  ])("rejects %s service tokens with 403", async (_label, getToken) => {
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: mcpHeaders(getToken()),
      payload: initializePayload(),
    });

    expect(response.statusCode).toBe(403);
  });

  it("returns 405 for GET and DELETE and exposes no legacy SSE route", async () => {
    const [get, remove, legacySse] = await Promise.all([
      app.inject({ method: "GET", url: "/mcp" }),
      app.inject({ method: "DELETE", url: "/mcp" }),
      app.inject({ method: "GET", url: "/sse" }),
    ]);

    expect(get.statusCode).toBe(405);
    expect(get.headers.allow).toBe("POST");
    expect(remove.statusCode).toBe(405);
    expect(legacySse.statusCode).toBe(404);
  });

  it("marks authorization and candidate bodies as suppressed and caps request size", async () => {
    expect(postRouteConfig).toMatchObject({
      suppressRequestBodyLogging: true,
      suppressAuthorizationHeaderLogging: true,
      suppressCandidateMarkdownLogging: true,
    });

    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: mcpHeaders(valid.token),
      payload: JSON.stringify({
        ...initializePayload(),
        padding: "x".repeat(HOSTED_MCP_BODY_LIMIT),
      }),
    });
    expect(response.statusCode).toBe(413);
  });
});

describe("hosted skills MCP transport", () => {
  it("works with the SDK Streamable HTTP client and lists only the two skill tools", async () => {
    const client = new Client({ name: "hosted-sdk-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${baseUrl}/mcp`),
      {
        requestInit: {
          headers: { authorization: `Bearer ${valid.token}` },
        },
      },
    );

    try {
      await client.connect(transport);
      expect(transport.sessionId).toBeUndefined();
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        "check_skill_conflicts",
        "search_skills",
      ]);

      const search = listed.tools.find((tool) => tool.name === "search_skills")!;
      expect(search.inputSchema.required).toEqual(["query"]);
      expect(Object.keys(search.inputSchema.properties ?? {}).sort()).toEqual([
        "limit",
        "project_id",
        "query",
        "source_id",
        "target_namespace",
        "tentative_name",
      ]);

      const conflicts = listed.tools.find(
        (tool) => tool.name === "check_skill_conflicts",
      )!;
      expect(conflicts.inputSchema.required).toEqual(["candidates"]);
      expect(Object.keys(conflicts.inputSchema.properties ?? {}).sort()).toEqual([
        "base_commit_sha",
        "candidates",
        "project_id",
        "source_id",
      ]);
    } finally {
      await client.close();
    }
  });

  it("derives the org from the token and never infers hosted project context", async () => {
    process.env.PIM_PROJECT_ID = "must-not-be-used-by-hosted-mcp";
    apiCalls.length = 0;
    const client = new Client({ name: "hosted-call-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${baseUrl}/mcp`),
      {
        requestInit: {
          headers: {
            authorization: `Bearer ${valid.token}`,
            "x-pim-org": "attacker-supplied-org",
          },
        },
      },
    );

    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: "search_skills",
        arguments: { query: "review pull requests" },
      });
      expect(parseToolText(result)).toMatchObject({
        status: "ready",
        catalog: { selectionMode: "org_default" },
      });

      const apiCall = apiCalls.at(-1)!;
      expect(apiCall.url).toBe("http://127.0.0.1:4000/api/skill-search");
      expect(apiCall.headers.get("authorization")).toBe(`Bearer ${valid.token}`);
      expect(apiCall.headers.get("x-pim-org")).toBe("hosted-mcp");
      expect(apiCall.body).toEqual({ query: "review pull requests" });

      await client.callTool({
        name: "search_skills",
        arguments: {
          project_id: "project-hosted",
          query: "review pull requests",
        },
      });
      expect(apiCalls.at(-1)!.body).toMatchObject({
        projectId: "project-hosted",
        query: "review pull requests",
      });
    } finally {
      delete process.env.PIM_PROJECT_ID;
      await client.close();
    }
  });

  it("preserves conflict, clear, building, unavailable, and failure semantics", async () => {
    const client = new Client({ name: "hosted-outcomes-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${baseUrl}/mcp`),
      {
        requestInit: {
          headers: { authorization: `Bearer ${valid.token}` },
        },
      },
    );

    try {
      await client.connect(transport);

      const duplicate = parseToolText(await client.callTool({
        name: "check_skill_conflicts",
        arguments: { candidates: [candidate("Known Duplicate")] },
      }));
      expect(duplicate.results).toEqual([
        expect.objectContaining({ status: "conflict_found" }),
      ]);

      const clear = parseToolText(await client.callTool({
        name: "check_skill_conflicts",
        arguments: { candidates: [candidate("Known Clear")] },
      }));
      expect(clear.results).toEqual([
        expect.objectContaining({ status: "clear", conflicts: [] }),
      ]);

      const building = parseToolText(await client.callTool({
        name: "check_skill_conflicts",
        arguments: { candidates: [candidate("Catalog Building")] },
      }));
      expect(building).toMatchObject({ error: "catalog_building" });

      const unavailableSearch = parseToolText(await client.callTool({
        name: "search_skills",
        arguments: { query: "catalog unavailable" },
      }));
      expect(unavailableSearch).toEqual({ status: "unavailable", results: [] });
      expect(JSON.stringify(unavailableSearch)).not.toContain("clear");

      const unavailableCatalog = await client.callTool({
        name: "check_skill_conflicts",
        arguments: { candidates: [candidate("Catalog Unavailable")] },
      });
      expect(unavailableCatalog.isError).toBe(true);
      expect(JSON.stringify(unavailableCatalog.content)).not.toContain("\"status\":\"clear\"");

      const invalid = await client.callTool({
        name: "check_skill_conflicts",
        arguments: {
          candidates: [{
            ...candidate("Invalid Candidate"),
            target_namespace: "organization-wide",
          }],
        },
      });
      expect(invalid.isError).toBe(true);
    } finally {
      await client.close();
    }
  });
});
