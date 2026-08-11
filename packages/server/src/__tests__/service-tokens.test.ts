import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const { testDb } = vi.hoisted(() => {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  return { testDb: db };
});

vi.mock("../db/connection.js", () => ({
  default: testDb,
  withTransaction: (fn: () => unknown) => fn(),
  withImmediateTransaction: (fn: () => unknown) => fn(),
}));

vi.mock("../services/knowledge-graph.js", () => ({
  initializeKnowledgeGraph: vi.fn(),
  refreshAnalysis: vi.fn(),
  getGraph: vi.fn().mockReturnValue({ nodes: [], edges: [] }),
  getStats: vi.fn().mockReturnValue({ total_nodes: 0, by_type: {}, by_confidence: {}, by_domain: {} }),
  stripEmbeddingsFromGraph: vi.fn((graph) => graph),
  curateNode: vi.fn().mockResolvedValue(true),
  getPrecedents: vi.fn().mockResolvedValue({ nodes: [] }),
  getContractedRelevantLearnings: vi.fn().mockResolvedValue({
    nodes: [],
    truncated: false,
    total_matching: 0,
    token_estimate: 0,
    edges: [],
  }),
  queryKnowledgeSemantic: vi.fn().mockReturnValue({
    nodes: [],
    edges: [],
    total_matching: 0,
    token_estimate: 0,
    truncated: false,
  }),
}));

vi.mock("../services/slack.js", () => ({
  notifyOrgInviteDM: vi.fn(),
  notifyConflictResolved: vi.fn(),
}));

import { createTables } from "../db/schema.js";
import { registerJsonBodyParser } from "../middleware/validation.js";
import { createAuthHook } from "../middleware/auth.js";
import { resolveRequestOrg } from "../middleware/org-context.js";
import orgRoutes from "../routes/org.js";
import orgsRoutes from "../routes/orgs.js";
import projectRoutes from "../routes/projects.js";
import graphRoutes from "../routes/graph.js";
import podRoutes from "../routes/pods.js";
import livingDocRoutes from "../routes/living-doc.js";
import conflictRoutes from "../routes/conflicts.js";
import { createOrg } from "../services/orgs.js";
import { registerMemoryRepository } from "../services/memory-repository-registry.js";
import { memoryV2HarnessSourceRowId } from "../services/memory-v2-resources.js";
import { upsertUserByIms } from "../services/users.js";

const HUMAN_EMAIL = "dev@local";

let app: FastifyInstance;
let ownerUserId: string;

function authHeader(token: string, org?: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    ...(org ? { "x-pim-org": org } : {}),
  };
}

function createProject(orgId: string, projectId: string, name: string): void {
  testDb
    .prepare(
      `INSERT INTO projects
         (project_id, name, description, created_at, anatomy_json, org_id, created_by_user_id)
       VALUES (?, ?, NULL, ?, ?, ?, ?)`,
    )
    .run(projectId, name, new Date().toISOString(), JSON.stringify({ internal: [], external: [] }), orgId, ownerUserId);
}

function createPod(orgId: string, projectId: string, podId: string, name: string): void {
  const now = new Date().toISOString();
  testDb
    .prepare(
      `INSERT INTO pods
         (pod_id, name, sprint_start, sprint_end, day_number, total_days, conflict_pressure,
          milestone_json, project_id, org_id, created_by_user_id)
       VALUES (?, ?, '2026-01-01', '2026-01-05', 1, 5, 0.0, ?, ?, ?, ?)`,
    )
    .run(
      podId,
      name,
      JSON.stringify({ name: "Sprint Goal", target_date: "2026-01-05", percent_complete: 0 }),
      projectId,
      orgId,
      ownerUserId,
    );
  testDb
    .prepare("INSERT INTO pod_areas (pod_id, scope, owner, status, last_activity) VALUES (?, 'backend', 'harness', 'active', ?)")
    .run(podId, now);
  testDb
    .prepare("INSERT INTO living_docs (pod_id, markdown, last_regenerated_at, regen_count) VALUES (?, ?, ?, 1)")
    .run(podId, `# ${name}\n\nHarness context.`, now);
  testDb
    .prepare(
      `INSERT INTO conflicts
         (id, pod_id, created_at, status, severity, summary, sides_json, master_analysis, impact_json, org_id)
       VALUES (?, ?, ?, 'open', 'medium', ?, ?, 'analysis', ?, ?)`,
    )
    .run(
      `${podId}-conflict`,
      podId,
      now,
      `${name} conflict`,
      JSON.stringify([]),
      JSON.stringify([]),
      orgId,
    );
}

async function createManagedToken(input: {
  orgSlug: string;
  name?: string;
  scopes: string[];
  authentication_profile?: "private_pim_service_token";
  project_id?: string;
  pod_id?: string;
  repository_ids?: string[];
  harness_ids?: string[];
  expires_in_days?: number;
}) {
  const res = await app.inject({
    method: "POST",
    url: "/api/org/service-tokens",
    headers: { "x-pim-org": input.orgSlug },
    payload: {
      name: input.name ?? `token-${Date.now()}`,
      scopes: input.scopes,
      authentication_profile: input.authentication_profile,
      project_id: input.project_id,
      pod_id: input.pod_id,
      repository_ids: input.repository_ids,
      harness_ids: input.harness_ids,
      expires_in_days: input.expires_in_days ?? 30,
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as {
    token: string;
    token_id: string;
    service_principal_id: string;
    token_prefix: string;
    scopes: string[];
    project_id: string | null;
    pod_id: string | null;
    repository_ids: string[];
    harness_ids: string[];
    mcp_profile?: {
      authenticationProfile: string;
      audience: string;
      resourceIndicator: string;
      endpointPath: string;
      createdAt: string;
    };
  };
}

beforeAll(async () => {
  createTables();
  const owner = upsertUserByIms({ email: HUMAN_EMAIL, display_name: "Dev User" });
  ownerUserId = owner.user_id;

  app = Fastify();
  registerJsonBodyParser(app);
  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    const statusCode = error.statusCode ?? 500;
    reply.code(statusCode).send({ error: statusCode >= 500 ? "Internal server error" : error.message });
  });

  const authenticate = createAuthHook("trust");
  app.addHook("onRequest", async (req, reply) => {
    await authenticate(req, reply);
    if (reply.sent) return;
    const path = req.url.split("?")[0];
    const orgBypass = ["/api/me", "/api/orgs"].some((p) => path === p || path.startsWith(p + "/"));
    if (!orgBypass) {
      await resolveRequestOrg(req, reply);
    }
  });

  app.get("/api/test/who", async (req) => ({
    user_id: req.userRecord.user_id,
    is_service: req.userRecord.is_service,
    auth: req.auth,
    org_id: req.org?.org_id,
    membership_role: req.membership?.role,
  }));

  app.register(orgRoutes);
  app.register(orgsRoutes);
  app.register(projectRoutes);
  app.register(graphRoutes);
  app.register(podRoutes);
  app.register(livingDocRoutes);
  app.register(conflictRoutes);

  await app.ready();
});

afterAll(async () => {
  await app.close();
  testDb.close();
});

describe("PIM service tokens", () => {
  it("creates, lists, uses, and revokes a service token without returning the raw token from list", async () => {
    const org = createOrg({ slug: "svc-main", name: "Service Main", creatorUserId: ownerUserId });
    const created = await createManagedToken({
      orgSlug: org.slug,
      name: "harness-read",
      scopes: ["org-config:read", "knowledge:read"],
    });
    expect(created.token).toMatch(/^pim_svc_svctok[0-9a-f]+_[0-9a-f]+$/);
    expect(testDb.prepare(
      "SELECT COUNT(*) AS count FROM memory_v2_service_token_mcp_profiles WHERE token_id = ?",
    ).get(created.token_id)).toEqual({ count: 0 });

    const use = await app.inject({
      method: "GET",
      url: "/api/org/config",
      headers: authHeader(created.token, org.slug),
    });
    expect(use.statusCode).toBe(200);

    const listed = await app.inject({
      method: "GET",
      url: "/api/org/service-tokens",
      headers: { "x-pim-org": org.slug },
    });
    expect(listed.statusCode).toBe(200);
    const tokens = listed.json().tokens as Array<Record<string, unknown>>;
    expect(tokens[0]).not.toHaveProperty("token");
    expect(tokens[0].token_prefix).toBe(created.token_prefix);
    expect(listed.body).not.toContain(created.token);
    expect(tokens[0].last_used_at).toEqual(expect.any(String));

    const revoke = await app.inject({
      method: "POST",
      url: `/api/org/service-tokens/${created.token_id}/revoke`,
      headers: { "x-pim-org": org.slug },
    });
    expect(revoke.statusCode).toBe(200);

    const afterRevoke = await app.inject({
      method: "GET",
      url: "/api/org/config",
      headers: authHeader(created.token, org.slug),
    });
    expect(afterRevoke.statusCode).toBe(401);
  });

  it("lets an org admin explicitly mint a least-privilege private memory MCP credential", async () => {
    const org = createOrg({ slug: "svc-mcp", name: "Service MCP", creatorUserId: ownerUserId });
    createProject(org.org_id, "project-mcp", "Project MCP");

    const response = await app.inject({
      method: "POST",
      url: "/api/org/service-tokens",
      headers: { "x-pim-org": org.slug },
      payload: {
        name: "example-harness-a-mcp",
        authentication_profile: "private_pim_service_token",
        scopes: [
          "memory:harness:search",
          "memory:harness:receipt:write",
          "memory:harness:candidate:read",
        ],
        project_id: "project-mcp",
        harness_ids: ["example-harness-a"],
        expires_in_days: 30,
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    const created = response.json();

    expect(created.token).toMatch(/^pim_svc_svctok[0-9a-f]+_[0-9a-f]+$/);
    expect(created).toMatchObject({
      project_id: "project-mcp",
      pod_id: null,
      repository_ids: [],
      harness_ids: ["example-harness-a"],
      mcp_profile: {
        authenticationProfile: "private_pim_service_token",
        audience: "urn:pim:audience:mcp-memory",
        resourceIndicator: "urn:pim:resource:mcp-memory",
        endpointPath: "/mcp/memory",
        createdAt: expect.any(String),
      },
    });

    const profile = testDb.prepare(
      `SELECT authentication_profile, audience, resource_indicator, endpoint_path
       FROM memory_v2_service_token_mcp_profiles WHERE token_id = ?`,
    ).get(created.token_id);
    expect(profile).toEqual({
      authentication_profile: "private_pim_service_token",
      audience: "urn:pim:audience:mcp-memory",
      resource_indicator: "urn:pim:resource:mcp-memory",
      endpoint_path: "/mcp/memory",
    });
    const binding = testDb.prepare(
      `SELECT resource.plane, resource.canonical_resource_id, binding.operations_json
       FROM memory_v2_service_token_resource_bindings AS binding
       INNER JOIN memory_v2_resources AS resource
         ON resource.resource_row_id = binding.resource_row_id
       WHERE binding.token_id = ?`,
    ).get(created.token_id) as { plane: string; canonical_resource_id: string; operations_json: string };
    expect(binding).toMatchObject({
      plane: "harness",
      canonical_resource_id: "example-harness-a",
    });
    expect(JSON.parse(binding.operations_json)).toEqual(expect.arrayContaining([
      "search",
      "receipt_write",
      "candidate_read",
    ]));
    expect(JSON.parse(binding.operations_json)).not.toEqual(expect.arrayContaining([
      "review",
      "activation",
    ]));

    const listed = await app.inject({
      method: "GET",
      url: "/api/org/service-tokens",
      headers: { "x-pim-org": org.slug },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain(created.token);
    const listedToken = (listed.json().tokens as Array<Record<string, unknown>>)
      .find((token) => token.token_id === created.token_id);
    expect(listedToken).not.toHaveProperty("token");
    expect(listedToken).not.toHaveProperty("mcp_profile");
  });

  it("rejects unsafe, unbound, and pod-bound private memory MCP issuance", async () => {
    const org = createOrg({ slug: "svc-mcp-denied", name: "Service MCP Denied", creatorUserId: ownerUserId });
    createProject(org.org_id, "project-mcp-denied", "Project MCP Denied");

    const attempts = [
      {
        name: "missing-resource",
        scopes: ["memory:harness:search"],
        project_id: "project-mcp-denied",
      },
      {
        name: "review-authority",
        scopes: ["memory:harness:review"],
        project_id: "project-mcp-denied",
        harness_ids: ["example-harness-a"],
      },
      {
        name: "pod-authority",
        scopes: ["memory:harness:search"],
        project_id: "project-mcp-denied",
        pod_id: "pod-not-allowed",
        harness_ids: ["example-harness-a"],
      },
    ];

    for (const attempt of attempts) {
      const response = await app.inject({
        method: "POST",
        url: "/api/org/service-tokens",
        headers: { "x-pim-org": org.slug },
        payload: {
          ...attempt,
          authentication_profile: "private_pim_service_token",
          expires_in_days: 30,
        },
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it("does not infer the private MCP profile from ordinary memory scopes and bindings", async () => {
    const org = createOrg({ slug: "svc-mcp-ordinary", name: "Service MCP Ordinary", creatorUserId: ownerUserId });
    createProject(org.org_id, "project-mcp-ordinary", "Project MCP Ordinary");
    const ordinary = await createManagedToken({
      orgSlug: org.slug,
      scopes: ["memory:harness:search"],
      project_id: "project-mcp-ordinary",
      harness_ids: ["example-harness-a"],
    });
    expect(ordinary).not.toHaveProperty("mcp_profile");
    expect(testDb.prepare(
      "SELECT COUNT(*) AS count FROM memory_v2_service_token_mcp_profiles WHERE token_id = ?",
    ).get(ordinary.token_id)).toEqual({ count: 0 });
  });

  it("keeps unrelated token minting independent from a drifted v2 repository companion", async () => {
    const org = createOrg({ slug: "svc-unrelated", name: "Service Unrelated", creatorUserId: ownerUserId });
    createProject(org.org_id, "project-unrelated", "Project Unrelated");
    testDb.prepare("UPDATE projects SET resources_json = ? WHERE project_id = ? AND org_id = ?").run(
      JSON.stringify({ github: { repos: ["acme/unrelated"] } }),
      "project-unrelated",
      org.org_id,
    );
    const repository = registerMemoryRepository({
      orgId: org.org_id,
      projectId: "project-unrelated",
      providerRepositoryId: "provider-unrelated",
      repositoryId: "github.com/acme/unrelated",
      displaySlug: "Acme/Unrelated",
    });
    testDb.prepare(
      "UPDATE memory_v2_resources SET display_label = 'drifted' WHERE source_row_id = ?",
    ).run(repository.repository_row_id);

    const created = await createManagedToken({
      orgSlug: org.slug,
      scopes: ["project:read"],
      project_id: "project-unrelated",
      repository_ids: ["github.com/acme/unrelated"],
    });
    expect(created.repository_ids).toEqual(["github.com/acme/unrelated"]);
    expect(testDb.prepare(
      "SELECT COUNT(*) AS count FROM memory_v2_service_token_resource_bindings WHERE token_id = ?",
    ).get(created.token_id)).toEqual({ count: 0 });
  });

  it("maps v2 projection conflicts from token minting to a typed private error", async () => {
    const org = createOrg({ slug: "svc-mcp-conflict", name: "Service MCP Conflict", creatorUserId: ownerUserId });
    createProject(org.org_id, "project-mcp-conflict", "Project MCP Conflict");
    const now = new Date().toISOString();
    testDb.prepare(
      `INSERT INTO memory_v2_resources
         (resource_row_id, org_id, project_id, plane, resource_type,
          canonical_resource_id, display_label, provider, provider_resource_id,
          classification, retention_reference, source_authority, source_row_id,
          valid_from, valid_until, created_at, updated_at)
       VALUES (?, ?, ?, 'harness', 'harness', ?, 'drifted-label', NULL, NULL,
               'internal', NULL, 'memory_harness_principal_bindings', ?, ?, NULL, ?, ?)`,
    ).run(
      "v2res_harness:drifted",
      org.org_id,
      "project-mcp-conflict",
      "example-harness-a",
      memoryV2HarnessSourceRowId({
        orgId: org.org_id,
        projectId: "project-mcp-conflict",
        harnessId: "example-harness-a",
      }),
      now,
      now,
      now,
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/org/service-tokens",
      headers: { "x-pim-org": org.slug },
      payload: {
        name: "conflicting-mcp-profile",
        authentication_profile: "private_pim_service_token",
        scopes: ["memory:harness:search"],
        project_id: "project-mcp-conflict",
        harness_ids: ["example-harness-a"],
        expires_in_days: 30,
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.json()).toEqual({
      schema_version: "pim.error.v2",
      code: "idempotency_conflict",
      message: "Harness resource companion conflicts with its authority row",
      request_id: null,
      plane: null,
      retryable: false,
      details: [],
    });
  });

  it("attaches a synthetic service user and service auth metadata", async () => {
    const org = createOrg({ slug: "svc-who", name: "Service Who", creatorUserId: ownerUserId });
    const created = await createManagedToken({
      orgSlug: org.slug,
      scopes: ["org-config:read"],
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/test/who",
      headers: authHeader(created.token, org.slug),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user_id).toMatch(/^user_svc_svcprn/);
    expect(body.is_service).toBe(1);
    expect(body.auth).toMatchObject({
      kind: "service_token",
      tokenId: created.token_id,
      servicePrincipalId: created.service_principal_id,
      orgId: org.org_id,
      expiresAt: expect.any(String),
    });
    expect(body.membership_role).toBe("member");
  });

  it("requires X-Pim-Org and rejects org mismatches for service-token requests", async () => {
    const org = createOrg({ slug: "svc-org-a", name: "Service Org A", creatorUserId: ownerUserId });
    createOrg({ slug: "svc-org-b", name: "Service Org B", creatorUserId: ownerUserId });
    const created = await createManagedToken({
      orgSlug: org.slug,
      scopes: ["org-config:read"],
    });

    const missing = await app.inject({
      method: "GET",
      url: "/api/org/config",
      headers: authHeader(created.token),
    });
    expect(missing.statusCode).toBe(400);

    const wrong = await app.inject({
      method: "GET",
      url: "/api/org/config",
      headers: authHeader(created.token, "svc-org-b"),
    });
    expect(wrong.statusCode).toBe(403);
  });

  it("rejects malformed, wrong-secret, expired, and disabled service tokens", async () => {
    const org = createOrg({ slug: "svc-invalid", name: "Service Invalid", creatorUserId: ownerUserId });
    const created = await createManagedToken({
      orgSlug: org.slug,
      scopes: ["org-config:read"],
    });

    const wrongSecret = `${created.token.slice(0, -1)}${created.token.endsWith("0") ? "1" : "0"}`;
    for (const token of [
      "pim_svc_bad_format_extra",
      wrongSecret,
    ]) {
      const res = await app.inject({
        method: "GET",
        url: "/api/org/config",
        headers: authHeader(token, org.slug),
      });
      expect(res.statusCode).toBe(401);
    }

    testDb.prepare("UPDATE service_tokens SET expires_at = ? WHERE token_id = ?").run(
      new Date(Date.now() - 1000).toISOString(),
      created.token_id,
    );
    const expired = await app.inject({
      method: "GET",
      url: "/api/org/config",
      headers: authHeader(created.token, org.slug),
    });
    expect(expired.statusCode).toBe(401);

    const disabled = await createManagedToken({
      orgSlug: org.slug,
      name: "disabled",
      scopes: ["org-config:read"],
    });
    testDb.prepare("UPDATE service_principals SET disabled_at = ? WHERE service_principal_id = ?").run(
      new Date().toISOString(),
      disabled.service_principal_id,
    );
    const disabledRes = await app.inject({
      method: "GET",
      url: "/api/org/config",
      headers: authHeader(disabled.token, org.slug),
    });
    expect(disabledRes.statusCode).toBe(401);
  });

  it("enforces service-token scopes and project bindings", async () => {
    const org = createOrg({ slug: "svc-projects", name: "Service Projects", creatorUserId: ownerUserId });
    createProject(org.org_id, "project-alpha", "Project Alpha");
    createProject(org.org_id, "project-beta", "Project Beta");
    const created = await createManagedToken({
      orgSlug: org.slug,
      scopes: ["project:read"],
      project_id: "project-alpha",
    });

    const allowed = await app.inject({
      method: "GET",
      url: "/api/projects/project-alpha",
      headers: authHeader(created.token, org.slug),
    });
    expect(allowed.statusCode).toBe(200);

    const deniedProject = await app.inject({
      method: "GET",
      url: "/api/projects/project-beta",
      headers: authHeader(created.token, org.slug),
    });
    expect(deniedProject.statusCode).toBe(403);

    const missingWriteScope = await app.inject({
      method: "POST",
      url: "/api/projects/project-alpha/context-updates",
      headers: authHeader(created.token, org.slug),
      payload: { summary: "not checked because scope fails first" },
    });
    expect(missingWriteScope.statusCode).toBe(403);

    const orgWideKnowledge = await app.inject({
      method: "POST",
      url: "/api/knowledge/query",
      headers: authHeader(created.token, org.slug),
      payload: { filters: {}, max_tokens: 100 },
    });
    expect(orgWideKnowledge.statusCode).toBe(403);
  });

  it("allows org-scoped service tokens to read pod session context endpoints", async () => {
    const org = createOrg({ slug: "svc-pod-context", name: "Service Pod Context", creatorUserId: ownerUserId });
    createProject(org.org_id, "project-context", "Project Context");
    createPod(org.org_id, "project-context", "pod-context", "Pod Context");
    const created = await createManagedToken({
      orgSlug: org.slug,
      scopes: ["project:read", "project-context:read"],
    });

    const pod = await app.inject({
      method: "GET",
      url: "/api/pods/pod-context",
      headers: authHeader(created.token, org.slug),
    });
    expect(pod.statusCode).toBe(200);
    expect(pod.json()).toMatchObject({ pod_id: "pod-context", project_id: "project-context" });

    const livingDoc = await app.inject({
      method: "GET",
      url: "/api/pods/pod-context/living-doc",
      headers: authHeader(created.token, org.slug),
    });
    expect(livingDoc.statusCode).toBe(200);
    expect(livingDoc.body).toContain("Harness context");

    const conflicts = await app.inject({
      method: "GET",
      url: "/api/pods/pod-context/conflicts",
      headers: authHeader(created.token, org.slug),
    });
    expect(conflicts.statusCode).toBe(200);
    expect(conflicts.json()).toHaveLength(1);
  });

  it("keeps pod context reads constrained by service-token scopes and bindings", async () => {
    const org = createOrg({ slug: "svc-pod-binding", name: "Service Pod Binding", creatorUserId: ownerUserId });
    createProject(org.org_id, "project-allowed", "Project Allowed");
    createProject(org.org_id, "project-denied", "Project Denied");
    createPod(org.org_id, "project-allowed", "pod-allowed", "Pod Allowed");
    createPod(org.org_id, "project-denied", "pod-denied", "Pod Denied");
    const projectBound = await createManagedToken({
      orgSlug: org.slug,
      scopes: ["project:read", "project-context:read"],
      project_id: "project-allowed",
    });
    const metadataOnly = await createManagedToken({
      orgSlug: org.slug,
      scopes: ["project:read"],
    });

    const allowed = await app.inject({
      method: "GET",
      url: "/api/pods/pod-allowed/living-doc",
      headers: authHeader(projectBound.token, org.slug),
    });
    expect(allowed.statusCode).toBe(200);

    const deniedBinding = await app.inject({
      method: "GET",
      url: "/api/pods/pod-denied/living-doc",
      headers: authHeader(projectBound.token, org.slug),
    });
    expect(deniedBinding.statusCode).toBe(403);

    const deniedScope = await app.inject({
      method: "GET",
      url: "/api/pods/pod-allowed/living-doc",
      headers: authHeader(metadataOnly.token, org.slug),
    });
    expect(deniedScope.statusCode).toBe(403);
  });

  it("rejects service tokens from human and token-management surfaces", async () => {
    const org = createOrg({ slug: "svc-human", name: "Service Human", creatorUserId: ownerUserId });
    const created = await createManagedToken({
      orgSlug: org.slug,
      scopes: ["org-config:read"],
    });

    const me = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: authHeader(created.token),
    });
    expect(me.statusCode).toBe(403);

    const management = await app.inject({
      method: "GET",
      url: "/api/org/service-tokens",
      headers: authHeader(created.token, org.slug),
    });
    expect(management.statusCode).toBe(403);
  });

  it("prevents human email upsert from colliding with service-principal users", async () => {
    const org = createOrg({ slug: "svc-email", name: "Service Email", creatorUserId: ownerUserId });
    const created = await createManagedToken({
      orgSlug: org.slug,
      scopes: ["org-config:read"],
    });
    const serviceEmail = `service+${created.service_principal_id}@pim.local`;
    const human = upsertUserByIms({ email: serviceEmail, display_name: "Human Collision" });

    expect(human.user_id).not.toBe(`user_svc_${created.service_principal_id}`);
    expect(human.is_service).toBe(0);
  });

  it("rejects private memory MCP token management when the caller is not an admin", async () => {
    const org = createOrg({ slug: "svc-member", name: "Service Member", creatorUserId: ownerUserId });
    testDb.prepare("UPDATE memberships SET role = 'member' WHERE org_id = ? AND user_id = ?").run(org.org_id, ownerUserId);

    const res = await app.inject({
      method: "POST",
      url: "/api/org/service-tokens",
      headers: { "x-pim-org": org.slug },
      payload: {
        name: "not-admin",
        authentication_profile: "private_pim_service_token",
        scopes: ["memory:harness:search"],
        project_id: "project-not-admin",
        harness_ids: ["example-harness-a"],
        expires_in_days: 30,
      },
    });
    expect(res.statusCode).toBe(403);
  });
});
