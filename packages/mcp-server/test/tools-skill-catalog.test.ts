import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { z, type ZodRawShape } from "zod";

process.env.PIM_API_URL = "http://pim.test";
process.env.PIM_ORG_SLUG = "adobecom";

const api = await import("../src/api.ts");
const { registerTools } = await import("../src/tools.ts");

type FetchCall = { url: string; init?: RequestInit };
type ToolResult = { content: Array<{ type: "text"; text: string }> };
type ToolHandler = (input: Record<string, unknown>) => Promise<ToolResult>;
type RegisteredTool = {
  schema: ZodRawShape;
  handler: ToolHandler;
};

const FULL_SHA = "a".repeat(40);

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
}

function installFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    calls.push({ url, init });
    if (url.endsWith("/api/health")) {
      return jsonResponse({ auth_mode: "trust" });
    }
    return handler(url, init);
  }) as typeof fetch;
  return calls;
}

function registerToolHandlers(): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  registerTools({
    tool(
      name: string,
      _description: string,
      schema: ZodRawShape,
      handler: ToolHandler,
    ) {
      tools.set(name, { schema, handler });
    },
  } as never);
  return tools;
}

function parseToolResult(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

function validCandidate() {
  return {
    candidate_id: "candidate-1",
    name: "Pull Request Review",
    description: "Reviews pull requests for correctness and security.",
    proposed_path: "projects/example/skills/pr-review.md",
    target_namespace: "project:example",
    body: "# Pull Request Review\n\nReview the proposed changes.",
    replaces_path: "projects/example/skills/old-review.md",
  };
}

beforeEach(() => {
  process.env.PIM_ORG_SLUG = "adobecom";
  api._resetOrgSelectionForTests();
});

test("registers bounded skill schemas without the stale intent phase", () => {
  const tools = registerToolHandlers();
  const search = tools.get("search_skills");
  const conflicts = tools.get("check_skill_conflicts");
  const catalog = tools.get("view_skill_catalog");

  assert.ok(search);
  assert.ok(conflicts);
  assert.ok(catalog);
  assert.equal("phase" in conflicts.schema, false);
  assert.equal("intent_preflight" in conflicts.schema, false);

  const searchSchema = z.object(search.schema);
  const conflictSchema = z.object(conflicts.schema);
  const catalogSchema = z.object(catalog.schema);

  assert.throws(() =>
    searchSchema.parse({
      source_id: "mimir-main",
      query: "Review pull requests",
      target_namespace: "organization-wide",
    }));
  assert.throws(() =>
    searchSchema.parse({
      source_id: "mimir-main",
      query: "Review pull requests",
      limit: 21,
    }));
  assert.throws(() =>
    conflictSchema.parse({
      source_id: "mimir-main",
      base_commit_sha: "abc123",
      candidates: [validCandidate()],
    }));
  assert.throws(() =>
    conflictSchema.parse({
      source_id: "mimir-main",
      base_commit_sha: FULL_SHA,
      candidates: Array.from({ length: 21 }, (_, index) => ({
        ...validCandidate(),
        candidate_id: `candidate-${index}`,
      })),
    }));
  assert.throws(() =>
    catalogSchema.parse({
      source_id: "mimir-main",
      limit: 201,
    }));
});

test("search_skills maps MCP names to the advisory search API", async () => {
  const calls = installFetch((url, init) => {
    assert.equal(url, "http://pim.test/api/skill-search");
    assert.equal(init?.method, "POST");
    assert.deepEqual(JSON.parse(String(init?.body)), {
      sourceId: "mimir-main",
      query: "Review pull requests for security problems",
      tentativeName: "pr-review",
      targetNamespace: "project:example",
      limit: 3,
    });
    return jsonResponse({
      status: "ready",
      catalog: {
        sourceId: "mimir-main",
        commitSha: FULL_SHA,
        snapshotState: "search_ready",
      },
      results: [
        {
          name: "pull-request-auditor",
          namespace: "shared",
          path: "shared/skills/pull-request-auditor.md",
          similarity: 0.82,
          nameCollision: false,
        },
      ],
    });
  });
  const tool = registerToolHandlers().get("search_skills")!;

  const result = parseToolResult(await tool.handler({
    source_id: "mimir-main",
    query: "Review pull requests for security problems",
    tentative_name: "pr-review",
    target_namespace: "project:example",
    limit: 3,
  }));

  assert.equal(result.status, "ready");
  assert.equal((result.results as unknown[]).length, 1);
  assert.equal(calls.filter((call) => call.url.endsWith("/api/skill-search")).length, 1);
});

test("search_skills preserves unavailable as a non-verdict", async () => {
  installFetch((url) => {
    assert.equal(url, "http://pim.test/api/skill-search");
    return jsonResponse({ status: "unavailable", results: [] });
  });
  const tool = registerToolHandlers().get("search_skills")!;

  const result = parseToolResult(await tool.handler({
    source_id: "mimir-main",
    query: "Create a brand new skill",
  }));

  assert.deepEqual(result, { status: "unavailable", results: [] });
  assert.equal(JSON.stringify(result).includes("clear"), false);
});

test("check_skill_conflicts maps final candidates and preserves facts", async () => {
  const calls = installFetch((url, init) => {
    assert.equal(url, "http://pim.test/api/skill-conflicts");
    assert.equal(init?.method, "POST");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.deepEqual(body, {
      sourceId: "mimir-main",
      baseCommitSha: FULL_SHA,
      candidates: [
        {
          candidateId: "candidate-1",
          name: "Pull Request Review",
          description: "Reviews pull requests for correctness and security.",
          proposedPath: "projects/example/skills/pr-review.md",
          targetNamespace: "project:example",
          body: "# Pull Request Review\n\nReview the proposed changes.",
          replacesPath: "projects/example/skills/old-review.md",
        },
      ],
    });
    assert.equal("phase" in body, false);
    return jsonResponse({
      catalog: {
        commitSha: FULL_SHA,
        snapshotState: "search_ready",
      },
      matcherVersion: "v1",
      results: [
        {
          candidateId: "candidate-1",
          status: "conflict_found",
          conflicts: [{ kind: "same_namespace_name" }],
          related: [{ path: "shared/skills/reviewer.md", similarity: 0.7 }],
        },
      ],
    });
  });
  const tool = registerToolHandlers().get("check_skill_conflicts")!;

  const result = parseToolResult(await tool.handler({
    source_id: "mimir-main",
    base_commit_sha: FULL_SHA,
    candidates: [validCandidate()],
    phase: "intent_preflight",
  }));

  const candidate = (result.results as Array<Record<string, unknown>>)[0]!;
  assert.equal(candidate.status, "conflict_found");
  assert.deepEqual(candidate.conflicts, [{ kind: "same_namespace_name" }]);
  assert.deepEqual(candidate.related, [
    { path: "shared/skills/reviewer.md", similarity: 0.7 },
  ]);
  assert.equal(calls.filter((call) => call.url.endsWith("/api/skill-conflicts")).length, 1);
});

test("check_skill_conflicts returns a 202 catalog_building body for retry", async () => {
  installFetch((url) => {
    assert.equal(url, "http://pim.test/api/skill-conflicts");
    return jsonResponse(
      {
        error: "catalog_building",
        sourceId: "mimir-main",
        commitSha: FULL_SHA,
      },
      202,
      { "Retry-After": "2" },
    );
  });
  const tool = registerToolHandlers().get("check_skill_conflicts")!;

  const result = parseToolResult(await tool.handler({
    source_id: "mimir-main",
    base_commit_sha: FULL_SHA,
    candidates: [validCandidate()],
  }));

  assert.deepEqual(result, {
    error: "catalog_building",
    sourceId: "mimir-main",
    commitSha: FULL_SHA,
  });
});

test("check_skill_conflicts keeps catalog_not_ready as a tool error", async () => {
  installFetch((url) => {
    assert.equal(url, "http://pim.test/api/skill-conflicts");
    return jsonResponse(
      {
        error: "catalog_not_ready",
        sourceId: "mimir-main",
        commitSha: FULL_SHA,
      },
      503,
    );
  });
  const tool = registerToolHandlers().get("check_skill_conflicts")!;

  await assert.rejects(
    () =>
      tool.handler({
        source_id: "mimir-main",
        base_commit_sha: FULL_SHA,
        candidates: [validCandidate()],
      }),
    /PIM API 503:.*catalog_not_ready/,
  );
});

test("view_skill_catalog encodes filters and preserves the catalog page", async () => {
  const calls = installFetch((url, init) => {
    assert.equal(
      url,
      `http://pim.test/api/skill-catalog?sourceId=mimir-main&commitSha=${FULL_SHA}&namespace=project%3Aexample&cursor=next%2B%2F%3D&limit=25`,
    );
    assert.equal(init?.method, undefined);
    return jsonResponse({
      catalog: {
        sourceId: "mimir-main",
        commitSha: FULL_SHA,
        snapshotState: "entries_ready",
      },
      entries: [
        {
          name: "pr-review",
          namespace: "project:example",
          path: "projects/example/skills/pr-review.md",
        },
      ],
      nextCursor: null,
    });
  });
  const tool = registerToolHandlers().get("view_skill_catalog")!;

  const result = parseToolResult(await tool.handler({
    source_id: "mimir-main",
    commit_sha: FULL_SHA,
    namespace: "project:example",
    cursor: "next+/=",
    limit: 25,
  }));

  assert.equal((result.catalog as { commitSha: string }).commitSha, FULL_SHA);
  assert.equal((result.entries as unknown[]).length, 1);
  assert.equal(calls.filter((call) => call.url.includes("/api/skill-catalog?")).length, 1);
});

test("view_skill_catalog returns a 202 catalog_building body for retry", async () => {
  installFetch((url) => {
    assert.equal(
      url,
      `http://pim.test/api/skill-catalog?sourceId=mimir-main&commitSha=${FULL_SHA}`,
    );
    return jsonResponse(
      {
        error: "catalog_building",
        sourceId: "mimir-main",
        commitSha: FULL_SHA,
      },
      202,
      { "Retry-After": "2" },
    );
  });
  const tool = registerToolHandlers().get("view_skill_catalog")!;

  const result = parseToolResult(await tool.handler({
    source_id: "mimir-main",
    commit_sha: FULL_SHA,
  }));

  assert.deepEqual(result, {
    error: "catalog_building",
    sourceId: "mimir-main",
    commitSha: FULL_SHA,
  });
});

test("view_skill_catalog keeps catalog_not_ready as a tool error", async () => {
  installFetch((url) => {
    assert.equal(url, "http://pim.test/api/skill-catalog?sourceId=mimir-main");
    return jsonResponse(
      {
        error: "catalog_not_ready",
        message: "The requested catalog snapshot is not ready",
      },
      503,
    );
  });
  const tool = registerToolHandlers().get("view_skill_catalog")!;

  await assert.rejects(
    () => tool.handler({ source_id: "mimir-main" }),
    /PIM API 503:.*catalog_not_ready/,
  );
});
