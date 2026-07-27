import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, {
  type FastifyContextConfig,
  type FastifyInstance,
  type FastifyRequest,
} from "fastify";

const catalogMocks = vi.hoisted(() => ({
  configureSkillCatalogWebhookSecret: vi.fn(),
  createSkillCatalogSource: vi.fn(),
  ensureExactSkillCatalogSnapshot: vi.fn(),
  getSkillCatalogPage: vi.fn(),
  getSkillCatalogSourceStatus: vi.fn(),
  listSkillCatalogSources: vi.fn(),
  syncSkillCatalogSource: vi.fn(),
}));

const conflictMocks = vi.hoisted(() => ({
  validateSkillConflicts: vi.fn(),
}));

const searchMocks = vi.hoisted(() => ({
  resetSkillCatalogEmbeddingRetries: vi.fn(),
  runSkillCatalogEmbeddingBackfill: vi.fn(),
  searchSkillCatalog: vi.fn(),
}));

const bundleMocks = vi.hoisted(() => ({
  importSkillCatalogBundle: vi.fn(),
}));

vi.mock("../../services/skill-catalog.js", () => ({
  ...catalogMocks,
  SkillCatalogError: class SkillCatalogError extends Error {
    constructor(
      message: string,
      public statusCode = 400,
      public code = "skill_catalog_error",
    ) {
      super(message);
    }
  },
}));

vi.mock("../../services/skill-conflicts.js", () => ({
  MAX_SKILL_CONFLICT_CANDIDATES: 20,
  SKILL_CONFLICT_ROUTE_BODY_LIMIT: 1024 * 1024 + 128 * 1024,
  ...conflictMocks,
}));

vi.mock("../../services/skill-catalog-search.js", () => ({
  DEFAULT_SKILL_SEARCH_LIMIT: 5,
  MAX_SKILL_SEARCH_LIMIT: 20,
  ...searchMocks,
}));

vi.mock("../../services/skill-catalog-bundle.js", () => ({
  SKILL_CATALOG_BUNDLE_BODY_LIMIT: 64 * 1024 * 1024,
  ...bundleMocks,
}));

import { registerJsonBodyParser } from "../../middleware/validation.js";
import { SkillCatalogLayoutError } from "../../services/skill-catalog-layout.js";
import skillCatalogRoutes from "../skill-catalog.js";

let app: FastifyInstance;
let conflictRouteConfig: FastifyContextConfig | undefined;
let searchRouteConfig: FastifyContextConfig | undefined;
let importRouteConfig: FastifyContextConfig | undefined;

const SOURCE = {
  sourceId: "mimir-main",
  orgId: "org-route",
  displayName: "Mimir",
  apiBaseUrl: "https://api.github.com",
  owner: "Adobe-acom",
  repo: "mimir",
  defaultRef: "main",
  layoutRules: [
    { glob: "projects/*/skills/**/*.md", namespace: "project:{1}" },
  ],
  excludeGlobs: [],
  credentialAlias: "GH_TOKEN",
  webhookSecretAlias: null,
  enabled: true,
  syncStatus: "pending",
  lastSyncedAt: null,
  createdAt: "2026-07-25T00:00:00.000Z",
};

beforeEach(async () => {
  vi.clearAllMocks();
  catalogMocks.createSkillCatalogSource.mockReturnValue(SOURCE);
  catalogMocks.configureSkillCatalogWebhookSecret.mockReturnValue({
    ...SOURCE,
    webhookSecretAlias: "MIMIR_WEBHOOK_SECRET",
  });
  catalogMocks.listSkillCatalogSources.mockReturnValue([SOURCE]);
  catalogMocks.getSkillCatalogSourceStatus.mockReturnValue({
    sourceId: SOURCE.sourceId,
    latestEntriesReadyCommitSha: null,
    latestSearchReadyCommitSha: null,
  });
  catalogMocks.ensureExactSkillCatalogSnapshot.mockReturnValue({
    status: "ready",
    snapshot: {
      snapshotId: "snapshot",
      sourceId: SOURCE.sourceId,
      orgId: "org-route",
      commitSha: "a".repeat(40),
      state: "entries_ready",
      createdAt: SOURCE.createdAt,
    },
  });
  catalogMocks.getSkillCatalogPage.mockReturnValue({
    catalog: {
      sourceId: SOURCE.sourceId,
      commitSha: "a".repeat(40),
      snapshotState: "entries_ready",
    },
    entries: [],
    nextPath: null,
  });
  catalogMocks.syncSkillCatalogSource.mockResolvedValue({
    state: "entries_ready",
    snapshot: {
      snapshotId: "snapshot",
      sourceId: SOURCE.sourceId,
      orgId: "org-route",
      commitSha: "a".repeat(40),
      state: "entries_ready",
      isDefaultRef: true,
      createdAt: SOURCE.createdAt,
    },
  });
  searchMocks.resetSkillCatalogEmbeddingRetries.mockReturnValue(0);
  searchMocks.runSkillCatalogEmbeddingBackfill.mockResolvedValue({
    available: false,
    processed: 0,
    hydrated: 0,
    ready: 0,
    failed: 0,
    snapshots: { entriesReady: 0, searchReady: 0 },
  });
  searchMocks.searchSkillCatalog.mockResolvedValue({
    status: "ready",
    catalog: {
      sourceId: SOURCE.sourceId,
      commitSha: "a".repeat(40),
      snapshotState: "search_ready",
    },
    results: [],
  });
  bundleMocks.importSkillCatalogBundle.mockReturnValue({
    sourceId: SOURCE.sourceId,
    commitSha: "a".repeat(40),
    snapshotState: "search_ready",
    entriesImported: 100,
    blobsImported: 90,
    embeddingDimensions: 512,
  });

  conflictRouteConfig = undefined;
  searchRouteConfig = undefined;
  importRouteConfig = undefined;
  app = Fastify();
  registerJsonBodyParser(app);
  app.addHook("onRoute", (options) => {
    if (options.url === "/api/skill-conflicts") {
      conflictRouteConfig = options.config;
    }
    if (options.url === "/api/skill-search") {
      searchRouteConfig = options.config;
    }
    if (options.url === "/api/skill-catalog/sources/:sourceId/import") {
      importRouteConfig = options.config;
    }
  });
  app.addHook("onRequest", async (req: FastifyRequest) => {
    (req as any).org = { org_id: "org-route" };
    (req as any).membership = {
      role: req.headers["x-test-role"] ?? "admin",
    };
    const scopes = String(req.headers["x-test-scopes"] ?? "")
      .split(",")
      .filter(Boolean);
    if (req.headers["x-test-service"] === "true") {
      (req as any).auth = {
        kind: "service_token",
        scopes,
        orgId: "org-route",
        ...(req.headers["x-test-project-bound"] === "true"
          ? { projectId: "project-one" }
          : {}),
      };
    } else {
      (req as any).auth = { kind: "ims_user" };
    }
  });
  app.register(skillCatalogRoutes);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe("skill catalog admin routes", () => {
  it("creates and lists org-owned sources for admins", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/skill-catalog/sources",
      payload: {
        sourceId: SOURCE.sourceId,
        displayName: SOURCE.displayName,
        owner: SOURCE.owner,
        repo: SOURCE.repo,
        credentialAlias: SOURCE.credentialAlias,
        layoutRules: SOURCE.layoutRules,
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      sourceId: SOURCE.sourceId,
      owner: SOURCE.owner,
      repo: SOURCE.repo,
    });
    expect(catalogMocks.createSkillCatalogSource).toHaveBeenCalledWith(
      "org-route",
      expect.objectContaining({ sourceId: SOURCE.sourceId }),
    );

    const listed = await app.inject({
      method: "GET",
      url: "/api/skill-catalog/sources",
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().sources).toHaveLength(1);
  });

  it("imports a portable catalog bundle through an admin-only body-suppressed route", async () => {
    const bundle = {
      schemaVersion: "pim.skill-catalog-bundle.v1",
      source: { sourceId: SOURCE.sourceId },
    };
    const response = await app.inject({
      method: "POST",
      url: `/api/skill-catalog/sources/${SOURCE.sourceId}/import`,
      payload: bundle,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      catalog: {
        sourceId: SOURCE.sourceId,
        commitSha: "a".repeat(40),
        snapshotState: "search_ready",
      },
      imported: {
        entries: 100,
        blobs: 90,
        embeddingDimensions: 512,
      },
    });
    expect(bundleMocks.importSkillCatalogBundle).toHaveBeenCalledWith({
      orgId: "org-route",
      sourceId: SOURCE.sourceId,
      bundle,
    });
    expect(importRouteConfig?.suppressRequestBodyLogging).toBe(true);

    const forbidden = await app.inject({
      method: "POST",
      url: `/api/skill-catalog/sources/${SOURCE.sourceId}/import`,
      headers: { "x-test-role": "member" },
      payload: bundle,
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it("requires an org-wide skill-catalog admin scope for service-token imports", async () => {
    const url = `/api/skill-catalog/sources/${SOURCE.sourceId}/import`;
    const missingScope = await app.inject({
      method: "POST",
      url,
      headers: {
        "x-test-service": "true",
        "x-test-scopes": "skill-catalog:read",
      },
      payload: {},
    });
    expect(missingScope.statusCode).toBe(403);

    const projectBound = await app.inject({
      method: "POST",
      url,
      headers: {
        "x-test-service": "true",
        "x-test-scopes": "skill-catalog:admin",
        "x-test-project-bound": "true",
      },
      payload: {},
    });
    expect(projectBound.statusCode).toBe(403);

    const allowed = await app.inject({
      method: "POST",
      url,
      headers: {
        "x-test-service": "true",
        "x-test-scopes": "skill-catalog:admin",
      },
      payload: {},
    });
    expect(allowed.statusCode).toBe(200);
  });

  it("returns an actionable 400 for invalid source layout rules", async () => {
    catalogMocks.createSkillCatalogSource.mockImplementationOnce(() => {
      throw new SkillCatalogLayoutError("Invalid repository path: ../x");
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/skill-catalog/sources",
      payload: {
        displayName: SOURCE.displayName,
        owner: SOURCE.owner,
        repo: SOURCE.repo,
        credentialAlias: SOURCE.credentialAlias,
        layoutRules: [{ glob: "../x", namespace: "shared" }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "skill_catalog_error",
      message: "Invalid repository path: ../x",
    });
  });

  it("rejects source management by human members", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/skill-catalog/sources",
      headers: { "x-test-role": "member" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("allows org-wide admin service tokens and rejects narrower bindings", async () => {
    const allowed = await app.inject({
      method: "GET",
      url: "/api/skill-catalog/sources",
      headers: {
        "x-test-service": "true",
        "x-test-scopes": "skill-catalog:admin",
      },
    });
    expect(allowed.statusCode).toBe(200);

    const bound = await app.inject({
      method: "GET",
      url: "/api/skill-catalog/sources",
      headers: {
        "x-test-service": "true",
        "x-test-scopes": "skill-catalog:admin",
        "x-test-project-bound": "true",
      },
    });
    expect(bound.statusCode).toBe(403);
  });

  it("configures or rotates a webhook secret alias for an existing source", async () => {
    const response = await app.inject({
      method: "PUT",
      url: `/api/skill-catalog/sources/${SOURCE.sourceId}/webhook-secret`,
      payload: { webhookSecretAlias: "MIMIR_WEBHOOK_SECRET" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      sourceId: SOURCE.sourceId,
      webhookSecretAlias: "MIMIR_WEBHOOK_SECRET",
    });
    expect(
      catalogMocks.configureSkillCatalogWebhookSecret,
    ).toHaveBeenCalledWith(
      "org-route",
      SOURCE.sourceId,
      "MIMIR_WEBHOOK_SECRET",
    );
  });

  it("resets exhausted embedding retries when an administrator syncs a source", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/skill-catalog/sources/${SOURCE.sourceId}/sync`,
    });

    expect(response.statusCode).toBe(200);
    expect(
      searchMocks.resetSkillCatalogEmbeddingRetries,
    ).toHaveBeenCalledWith("org-route", SOURCE.sourceId);
    expect(
      searchMocks.runSkillCatalogEmbeddingBackfill,
    ).toHaveBeenCalledOnce();
  });
});

describe("skill catalog read and validation routes", () => {
  it("requires the catalog-read scope for service tokens", async () => {
    const denied = await app.inject({
      method: "GET",
      url: `/api/skill-catalog/sources/${SOURCE.sourceId}`,
      headers: {
        "x-test-service": "true",
        "x-test-scopes": "project:read",
      },
    });
    expect(denied.statusCode).toBe(403);

    const allowed = await app.inject({
      method: "GET",
      url: `/api/skill-catalog/sources/${SOURCE.sourceId}`,
      headers: {
        "x-test-service": "true",
        "x-test-scopes": "skill-catalog:read",
      },
    });
    expect(allowed.statusCode).toBe(200);
  });

  it("returns 202 + Retry-After while an exact SHA is building", async () => {
    conflictMocks.validateSkillConflicts.mockReturnValue({
      status: "building",
      retryAfterSeconds: 2,
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/skill-conflicts",
      headers: {
        "x-test-service": "true",
        "x-test-scopes": "skill-conflicts:check",
      },
      payload: {
        sourceId: SOURCE.sourceId,
        baseCommitSha: "a".repeat(40),
        candidates: [
          {
            candidateId: "one",
            name: "Review",
            proposedPath: "projects/example/skills/review.md",
            targetNamespace: "project:example",
            body: "# Review",
          },
        ],
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.headers["retry-after"]).toBe("2");
    expect(response.json().error).toBe("catalog_building");
  });

  it("returns an actionable 400 for invalid candidate paths", async () => {
    conflictMocks.validateSkillConflicts.mockRejectedValueOnce(
      new SkillCatalogLayoutError(
        "Invalid repository path: /skills/foo.md",
      ),
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/skill-conflicts",
      payload: {
        sourceId: SOURCE.sourceId,
        baseCommitSha: "a".repeat(40),
        candidates: [
          {
            candidateId: "one",
            name: "Review",
            proposedPath: "/skills/foo.md",
            targetNamespace: "shared",
            body: "# Review",
          },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "skill_catalog_error",
      message: "Invalid repository path: /skills/foo.md",
    });
  });

  it("returns advisory search results without a clear verdict", async () => {
    searchMocks.searchSkillCatalog.mockResolvedValue({
      status: "ready",
      catalog: {
        sourceId: SOURCE.sourceId,
        commitSha: "b".repeat(40),
        snapshotState: "search_ready",
      },
      results: [
        {
          name: "pr-review",
          namespace: "project:example",
          path: "projects/example/skills/pr-review.md",
          blobSha: "c".repeat(40),
          similarity: 0.81,
          excerpt: "Reviews pull requests.",
          nameCollision: true,
        },
      ],
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/skill-search",
      headers: {
        "x-test-service": "true",
        "x-test-scopes": "skill-catalog:read",
      },
      payload: {
        sourceId: SOURCE.sourceId,
        query: "Review pull requests for security problems",
        tentativeName: "pr_review",
        targetNamespace: "project:example",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ready",
      catalog: { commitSha: "b".repeat(40) },
      results: [{ nameCollision: true }],
    });
    expect(response.body).not.toMatch(/"clear"/);
    expect(searchMocks.searchSkillCatalog).toHaveBeenCalledWith({
      orgId: "org-route",
      sourceId: SOURCE.sourceId,
      query: "Review pull requests for security problems",
      tentativeName: "pr_review",
      targetNamespace: "project:example",
      limit: 5,
    });
    expect(searchRouteConfig?.suppressRequestBodyLogging).toBe(true);
  });

  it("returns search unavailability as a non-blocking response", async () => {
    searchMocks.searchSkillCatalog.mockResolvedValue({
      status: "unavailable",
      results: [],
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/skill-search",
      payload: {
        sourceId: SOURCE.sourceId,
        query: "Create something new",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "unavailable",
      results: [],
    });
  });

  it("returns deterministic per-candidate results without policy fields", async () => {
    conflictMocks.validateSkillConflicts.mockReturnValue({
      status: "ready",
      response: {
        catalog: {
          commitSha: "a".repeat(40),
          snapshotState: "entries_ready",
        },
        matcherVersion: "v1",
        results: [
          {
            candidateId: "conflict",
            status: "conflict_found",
            conflicts: [{ kind: "exact_content" }],
            related: [],
          },
          {
            candidateId: "clean",
            status: "clear",
            conflicts: [],
            related: [],
          },
        ],
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/skill-conflicts",
      payload: {
        sourceId: SOURCE.sourceId,
        baseCommitSha: "a".repeat(40),
        candidates: [
          {
            candidateId: "conflict",
            name: "Review",
            proposedPath: "projects/example/skills/review.md",
            targetNamespace: "project:example",
            body: "# Review",
          },
          {
            candidateId: "clean",
            name: "Unique",
            proposedPath: "projects/example/skills/unique.md",
            targetNamespace: "project:example",
            body: "# Unique",
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().results.map((result: { status: string }) => result.status)).toEqual([
      "conflict_found",
      "clear",
    ]);
    expect(response.body).not.toMatch(/disposition|allowedAction|decision/i);
  });

  it("enforces candidate count, aggregate body limit, and log suppression", async () => {
    const tooMany = await app.inject({
      method: "POST",
      url: "/api/skill-conflicts",
      payload: {
        sourceId: SOURCE.sourceId,
        baseCommitSha: "a".repeat(40),
        candidates: Array.from({ length: 21 }, (_, index) => ({
          candidateId: `candidate-${index}`,
          name: `Candidate ${index}`,
          proposedPath: `projects/example/skills/${index}.md`,
          targetNamespace: "project:example",
          body: "# Body",
        })),
      },
    });
    expect(tooMany.statusCode).toBe(400);

    const tooLarge = await app.inject({
      method: "POST",
      url: "/api/skill-conflicts",
      payload: {
        sourceId: SOURCE.sourceId,
        baseCommitSha: "a".repeat(40),
        candidates: [
          {
            candidateId: "large",
            name: "Large",
            proposedPath: "projects/example/skills/large.md",
            targetNamespace: "project:example",
            body: "x".repeat(1_200_000),
          },
        ],
      },
    });
    expect(tooLarge.statusCode).toBe(413);
    expect(conflictRouteConfig?.suppressRequestBodyLogging).toBe(true);
  });
});
