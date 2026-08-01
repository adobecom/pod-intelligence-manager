import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { SkillCatalogNamespace } from "@pim/shared";
import { atLeast } from "../services/org-permissions.js";
import type { ServiceTokenScope } from "../services/service-tokens.js";
import { validateBody } from "../middleware/validation.js";
import { requireProjectBinding } from "../middleware/service-authz.js";
import {
  configureSkillCatalogWebhookSecret,
  createSkillCatalogSource,
  ensureExactSkillCatalogSnapshot,
  getLatestSearchReadySnapshot,
  getSkillCatalogPage,
  getSkillCatalogSourceStatus,
  listSkillCatalogSources,
  SkillCatalogError,
  syncSkillCatalogSource,
  type SkillCatalogSource,
} from "../services/skill-catalog.js";
import {
  getSkillCatalogConfiguration,
  resolvedSkillCatalogMetadata,
  resolveSkillCatalogSource,
  setOrgDefaultSkillCatalogSource,
  setProjectSkillCatalogSource,
  type ResolvedSkillCatalogSource,
} from "../services/skill-catalog-config.js";
import {
  MAX_SKILL_CONFLICT_CANDIDATES,
  SKILL_CONFLICT_ROUTE_BODY_LIMIT,
  validateSkillConflicts,
} from "../services/skill-conflicts.js";
import {
  DEFAULT_SKILL_SEARCH_LIMIT,
  MAX_SKILL_SEARCH_LIMIT,
  resetSkillCatalogEmbeddingRetries,
  runSkillCatalogEmbeddingBackfill,
  searchSkillCatalog,
} from "../services/skill-catalog-search.js";
import {
  importSkillCatalogBundle,
  SKILL_CATALOG_BUNDLE_BODY_LIMIT,
} from "../services/skill-catalog-bundle.js";
import { SkillCatalogLayoutError } from "../services/skill-catalog-layout.js";

declare module "fastify" {
  interface FastifyContextConfig {
    suppressRequestBodyLogging?: boolean;
  }
}

const LayoutRuleSchema = z.object({
  glob: z.string().min(1).max(500),
  namespace: z.string().min(1).max(160),
});

const CreateSourceSchema = z.object({
  sourceId: z.string().min(1).max(128).optional(),
  displayName: z.string().min(1).max(160),
  apiBaseUrl: z.string().url().optional(),
  owner: z.string().min(1).max(100),
  repo: z.string().min(1).max(100),
  defaultRef: z.string().min(1).max(255).optional(),
  layoutRules: z.array(LayoutRuleSchema).min(1).max(50),
  excludeGlobs: z.array(z.string().min(1).max(500)).max(100).optional(),
  credentialAlias: z.string().min(1).max(128),
  webhookSecretAlias: z.string().min(1).max(128).optional(),
  enabled: z.boolean().optional(),
});

const ConfigureWebhookSecretSchema = z.object({
  webhookSecretAlias: z.string().min(1).max(128).nullable(),
});

const SkillNamespaceSchema = z.custom<SkillCatalogNamespace>(
  (value) =>
    typeof value === "string" &&
    (value === "shared" ||
      /^project:[A-Za-z0-9](?:[A-Za-z0-9._-]{0,127})$/.test(value)),
  "Must be shared or project:<id>",
);

const ConflictCandidateSchema = z.object({
  candidateId: z.string().min(1).max(200),
  name: z.string().min(1).max(500),
  description: z.string().max(4_000).optional(),
  proposedPath: z.string().min(1).max(1_024),
  targetNamespace: SkillNamespaceSchema,
  body: z.string(),
  replacesPath: z.string().min(1).max(1_024).optional(),
});

const SkillConflictsSchema = z.object({
  projectId: z.string().min(1).max(200).optional(),
  sourceId: z.string().min(1).max(128).optional(),
  baseCommitSha: z
    .string()
    .regex(/^[0-9a-f]{40}$/i, "Must be a full Git SHA")
    .optional(),
  candidates: z
    .array(ConflictCandidateSchema)
    .min(1)
    .max(MAX_SKILL_CONFLICT_CANDIDATES),
});

const SkillSearchSchema = z.object({
  projectId: z.string().min(1).max(200).optional(),
  sourceId: z.string().min(1).max(128).optional(),
  query: z.string().min(1).max(16_000),
  tentativeName: z.string().min(1).max(500).optional(),
  targetNamespace: SkillNamespaceSchema.optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_SKILL_SEARCH_LIMIT)
    .default(DEFAULT_SKILL_SEARCH_LIMIT),
});

const SetCatalogSourceSchema = z.object({
  sourceId: z.string().min(1).max(128).nullable(),
});

const SKILL_SEARCH_ROUTE_BODY_LIMIT = 64 * 1024;

interface CatalogCursor {
  sourceId: string;
  commitSha: string;
  namespace: string | null;
  path: string;
}

function sourceResponse(source: SkillCatalogSource) {
  return {
    sourceId: source.sourceId,
    displayName: source.displayName,
    apiBaseUrl: source.apiBaseUrl,
    owner: source.owner,
    repo: source.repo,
    defaultRef: source.defaultRef,
    layoutRules: source.layoutRules,
    excludeGlobs: source.excludeGlobs,
    credentialAlias: source.credentialAlias,
    webhookSecretAlias: source.webhookSecretAlias,
    enabled: source.enabled,
    syncStatus: source.syncStatus,
    lastSyncedAt: source.lastSyncedAt,
    createdAt: source.createdAt,
  };
}

function forbidden(reply: FastifyReply, error: string): false {
  reply.code(403).send({ error });
  return false;
}

function requireOrgWideServiceToken(
  req: FastifyRequest,
  reply: FastifyReply,
): boolean {
  if (req.auth?.kind !== "service_token") return true;
  if (!req.auth.projectId && !req.auth.podId) return true;
  return forbidden(
    reply,
    "PIM service token is bound to a narrower project or pod scope",
  );
}

function requireAnyServiceScope(
  req: FastifyRequest,
  reply: FastifyReply,
  scopes: ServiceTokenScope[],
): boolean {
  if (req.auth?.kind !== "service_token") return true;
  if (scopes.some((scope) => req.auth.kind === "service_token" && req.auth.scopes.includes(scope))) {
    return requireOrgWideServiceToken(req, reply);
  }
  return forbidden(
    reply,
    `PIM service token is missing required scope: ${scopes.join(" or ")}`,
  );
}

function requireCatalogAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.auth?.kind === "service_token") {
    return requireAnyServiceScope(req, reply, ["skill-catalog:admin"]);
  }
  if (!req.membership || !atLeast(req.membership.role, "admin")) {
    return forbidden(reply, "Only admins and owners can manage skill catalog sources");
  }
  return true;
}

function requireCatalogConfigurationWriter(
  req: FastifyRequest,
  reply: FastifyReply,
): boolean {
  if (req.auth?.kind === "service_token") {
    return forbidden(
      reply,
      "PIM service tokens cannot change skill catalog configuration",
    );
  }
  if (!req.membership) {
    return forbidden(reply, "Organization membership is required");
  }
  return true;
}

function requireCatalogOperationScope(
  req: FastifyRequest,
  reply: FastifyReply,
  scopes: ServiceTokenScope[],
  projectId?: string,
): boolean {
  if (req.auth?.kind !== "service_token") return true;
  if (!scopes.some((scope) => req.auth?.kind === "service_token" && req.auth.scopes.includes(scope))) {
    return forbidden(
      reply,
      `PIM service token is missing required scope: ${scopes.join(" or ")}`,
    );
  }
  return requireProjectBinding(req, reply, projectId);
}

function sendCatalogError(reply: FastifyReply, error: unknown) {
  const catalogError =
    error instanceof SkillCatalogLayoutError
      ? new SkillCatalogError(error.message)
      : error;
  if (!(catalogError instanceof SkillCatalogError)) throw error;
  reply.code(catalogError.statusCode);
  return { error: catalogError.code, message: catalogError.message };
}

function catalogResponseMetadata(
  resolved: ResolvedSkillCatalogSource,
  commitSha: string | null,
  snapshotState: "entries_ready" | "search_ready" | null,
) {
  return {
    ...resolvedSkillCatalogMetadata(resolved),
    commitSha,
    snapshotState,
  };
}

function encodeCursor(cursor: CatalogCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): CatalogCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as CatalogCursor).sourceId !== "string" ||
      typeof (parsed as CatalogCursor).commitSha !== "string" ||
      !(
        (parsed as CatalogCursor).namespace === null ||
        typeof (parsed as CatalogCursor).namespace === "string"
      ) ||
      typeof (parsed as CatalogCursor).path !== "string"
    ) {
      throw new Error("invalid shape");
    }
    return parsed as CatalogCursor;
  } catch {
    throw new SkillCatalogError("Invalid catalog cursor");
  }
}

export default async function skillCatalogRoutes(app: FastifyInstance) {
  app.post<{ Body: z.infer<typeof CreateSourceSchema> }>(
    "/api/skill-catalog/sources",
    { preHandler: validateBody(CreateSourceSchema) },
    async (req, reply) => {
      if (!requireCatalogAdmin(req, reply)) return;
      try {
        const source = createSkillCatalogSource(req.org!.org_id, req.body);
        reply.code(201);
        return sourceResponse(source);
      } catch (error) {
        return sendCatalogError(reply, error);
      }
    },
  );

  app.get("/api/skill-catalog/sources", async (req, reply) => {
    if (!requireCatalogAdmin(req, reply)) return;
    return {
      sources: listSkillCatalogSources(req.org!.org_id).map(sourceResponse),
    };
  });

  app.get<{
    Querystring: { projectId?: string };
  }>("/api/skill-catalog/config", async (req, reply) => {
    if (
      !requireAnyServiceScope(req, reply, [
        "skill-catalog:read",
        "skill-catalog:admin",
      ])
    ) {
      return;
    }
    const query = z
      .object({
        projectId: z.string().min(1).max(200).optional(),
      })
      .safeParse(req.query);
    if (!query.success) {
      reply.code(400);
      return { error: "Validation failed", details: query.error.issues };
    }
    try {
      return getSkillCatalogConfiguration(
        req.org!.org_id,
        query.data.projectId,
      );
    } catch (error) {
      return sendCatalogError(reply, error);
    }
  });

  app.put<{ Body: z.infer<typeof SetCatalogSourceSchema> }>(
    "/api/skill-catalog/config/org-default",
    { preHandler: validateBody(SetCatalogSourceSchema) },
    async (req, reply) => {
      if (!requireCatalogConfigurationWriter(req, reply)) return;
      try {
        return setOrgDefaultSkillCatalogSource(
          req.org!.org_id,
          req.body.sourceId,
        );
      } catch (error) {
        return sendCatalogError(reply, error);
      }
    },
  );

  app.put<{
    Params: { projectId: string };
    Body: z.infer<typeof SetCatalogSourceSchema>;
  }>(
    "/api/projects/:projectId/skill-catalog",
    { preHandler: validateBody(SetCatalogSourceSchema) },
    async (req, reply) => {
      if (!requireCatalogConfigurationWriter(req, reply)) return;
      try {
        return setProjectSkillCatalogSource(
          req.org!.org_id,
          req.params.projectId,
          req.body.sourceId,
        );
      } catch (error) {
        return sendCatalogError(reply, error);
      }
    },
  );

  app.get<{ Params: { sourceId: string } }>(
    "/api/skill-catalog/sources/:sourceId",
    async (req, reply) => {
      if (
        !requireAnyServiceScope(req, reply, [
          "skill-catalog:read",
          "skill-catalog:admin",
        ])
      ) {
        return;
      }
      try {
        return getSkillCatalogSourceStatus(req.org!.org_id, req.params.sourceId);
      } catch (error) {
        return sendCatalogError(reply, error);
      }
    },
  );

  app.post<{ Params: { sourceId: string } }>(
    "/api/skill-catalog/sources/:sourceId/sync",
    async (req, reply) => {
      if (!requireCatalogAdmin(req, reply)) return;
      try {
        const result = await syncSkillCatalogSource(
          req.org!.org_id,
          req.params.sourceId,
        );
        if (result.state === "failed") {
          reply.code(503);
          return {
            error: "catalog_not_ready",
            message: result.error ?? "Catalog snapshot build failed",
            commitSha: result.snapshot.commitSha,
          };
        }
        resetSkillCatalogEmbeddingRetries(
          req.org!.org_id,
          req.params.sourceId,
        );
        void runSkillCatalogEmbeddingBackfill().catch((error) => {
          req.log.warn(
            {
              error: error instanceof Error ? error.message : String(error),
              source_id: req.params.sourceId,
            },
            "Skill catalog embedding backfill failed",
          );
        });
        return {
          catalog: {
            sourceId: req.params.sourceId,
            commitSha: result.snapshot.commitSha,
            snapshotState: result.snapshot.state,
          },
        };
      } catch (error) {
        return sendCatalogError(reply, error);
      }
    },
  );

  app.post<{ Params: { sourceId: string }; Body: unknown }>(
    "/api/skill-catalog/sources/:sourceId/import",
    {
      bodyLimit: SKILL_CATALOG_BUNDLE_BODY_LIMIT,
      config: { suppressRequestBodyLogging: true },
    },
    async (req, reply) => {
      if (!requireCatalogAdmin(req, reply)) return;
      try {
        const result = importSkillCatalogBundle({
          orgId: req.org!.org_id,
          sourceId: req.params.sourceId,
          bundle: req.body,
        });
        return {
          catalog: {
            sourceId: result.sourceId,
            commitSha: result.commitSha,
            snapshotState: result.snapshotState,
          },
          imported: {
            entries: result.entriesImported,
            blobs: result.blobsImported,
            embeddingDimensions: result.embeddingDimensions,
          },
        };
      } catch (error) {
        return sendCatalogError(reply, error);
      }
    },
  );

  app.put<{
    Params: { sourceId: string };
    Body: z.infer<typeof ConfigureWebhookSecretSchema>;
  }>(
    "/api/skill-catalog/sources/:sourceId/webhook-secret",
    { preHandler: validateBody(ConfigureWebhookSecretSchema) },
    async (req, reply) => {
      if (!requireCatalogAdmin(req, reply)) return;
      try {
        return sourceResponse(
          configureSkillCatalogWebhookSecret(
            req.org!.org_id,
            req.params.sourceId,
            req.body.webhookSecretAlias,
          ),
        );
      } catch (error) {
        return sendCatalogError(reply, error);
      }
    },
  );

  app.get<{
    Querystring: {
      sourceId?: string;
      commitSha?: string;
      namespace?: string;
      cursor?: string;
      limit?: string;
    };
  }>("/api/skill-catalog", async (req, reply) => {
    if (
      !requireAnyServiceScope(req, reply, [
        "skill-catalog:read",
        "skill-catalog:admin",
      ])
    ) {
      return;
    }
    const query = z
      .object({
        sourceId: z.string().min(1).max(128),
        commitSha: z.string().regex(/^[0-9a-f]{40}$/i).optional(),
        namespace: SkillNamespaceSchema.optional(),
        cursor: z.string().min(1).max(4_000).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      })
      .safeParse(req.query);
    if (!query.success) {
      reply.code(400);
      return { error: "Validation failed", details: query.error.issues };
    }

    try {
      const cursor = query.data.cursor ? decodeCursor(query.data.cursor) : null;
      if (
        cursor &&
        (cursor.sourceId !== query.data.sourceId ||
          cursor.namespace !== (query.data.namespace ?? null) ||
          (query.data.commitSha &&
            cursor.commitSha.toLowerCase() !== query.data.commitSha.toLowerCase()))
      ) {
        throw new SkillCatalogError("Catalog cursor does not match the request");
      }
      const commitSha = query.data.commitSha ?? cursor?.commitSha;
      if (commitSha) {
        const availability = ensureExactSkillCatalogSnapshot(
          req.org!.org_id,
          query.data.sourceId,
          commitSha,
        );
        if (availability.status === "building") {
          reply.header("Retry-After", String(availability.retryAfterSeconds));
          reply.code(202);
          return {
            error: "catalog_building",
            sourceId: query.data.sourceId,
            commitSha,
          };
        }
        if (availability.status === "failed") {
          reply.code(503);
          return {
            error: "catalog_not_ready",
            sourceId: query.data.sourceId,
            commitSha,
          };
        }
      }
      const page = getSkillCatalogPage({
        orgId: req.org!.org_id,
        sourceId: query.data.sourceId,
        commitSha,
        namespace: query.data.namespace,
        afterPath: cursor?.path,
        limit: query.data.limit,
      });
      return {
        catalog: page.catalog,
        entries: page.entries,
        nextCursor: page.nextPath
          ? encodeCursor({
              sourceId: query.data.sourceId,
              commitSha: page.catalog.commitSha,
              namespace: query.data.namespace ?? null,
              path: page.nextPath,
            })
          : null,
      };
    } catch (error) {
      return sendCatalogError(reply, error);
    }
  });

  app.post<{ Body: z.infer<typeof SkillSearchSchema> }>(
    "/api/skill-search",
    {
      bodyLimit: SKILL_SEARCH_ROUTE_BODY_LIMIT,
      config: { suppressRequestBodyLogging: true },
      preHandler: validateBody(SkillSearchSchema),
    },
    async (req, reply) => {
      if (
        !requireCatalogOperationScope(
          req,
          reply,
          ["skill-catalog:read", "skill-catalog:admin"],
          req.body.projectId,
        )
      ) {
        return;
      }
      const startedAt = Date.now();
      try {
        const resolved = resolveSkillCatalogSource({
          orgId: req.org!.org_id,
          projectId: req.body.projectId,
          sourceId: req.body.sourceId,
        });
        const outcome = await searchSkillCatalog({
          orgId: req.org!.org_id,
          sourceId: resolved.source.sourceId,
          projectId: resolved.projectId,
          selectionMode: resolved.selectionMode,
          query: req.body.query,
          tentativeName: req.body.tentativeName,
          targetNamespace: req.body.targetNamespace,
          limit: req.body.limit,
        });
        const latestSearchReady =
          outcome.status === "ready"
            ? null
            : getLatestSearchReadySnapshot(
                req.org!.org_id,
                resolved.source.sourceId,
              );
        const commitSha =
          outcome.status === "ready"
            ? outcome.catalog.commitSha
            : latestSearchReady?.commitSha ?? null;
        req.log.info(
          {
            latency_ms: Date.now() - startedAt,
            result_count: outcome.results.length,
            project_id: resolved.projectId,
            source_id: resolved.source.sourceId,
            selection_mode: resolved.selectionMode,
            repository_owner: resolved.source.owner,
            repository_name: resolved.source.repo,
            commit_sha: commitSha,
            status: outcome.status,
          },
          "Skill catalog search completed",
        );
        return {
          ...outcome,
          catalog: catalogResponseMetadata(
            resolved,
            commitSha,
            commitSha ? "search_ready" : null,
          ),
        };
      } catch (error) {
        return sendCatalogError(reply, error);
      }
    },
  );

  app.post<{ Body: z.infer<typeof SkillConflictsSchema> }>(
    "/api/skill-conflicts",
    {
      bodyLimit: SKILL_CONFLICT_ROUTE_BODY_LIMIT,
      // The global logger does not serialize request bodies. This marker is
      // intentionally available to future logging hooks so this sensitive
      // route remains excluded if body logging is ever added.
      config: { suppressRequestBodyLogging: true },
      preHandler: validateBody(SkillConflictsSchema),
    },
    async (req, reply) => {
      if (
        !requireCatalogOperationScope(
          req,
          reply,
          ["skill-conflicts:check"],
          req.body.projectId,
        )
      ) {
        return;
      }
      const startedAt = Date.now();
      try {
        const resolved = resolveSkillCatalogSource({
          orgId: req.org!.org_id,
          projectId: req.body.projectId,
          sourceId: req.body.sourceId,
        });
        const outcome = await validateSkillConflicts({
          orgId: req.org!.org_id,
          sourceId: resolved.source.sourceId,
          baseCommitSha: req.body.baseCommitSha,
          projectId: resolved.projectId,
          selectionMode: resolved.selectionMode,
          candidates: req.body.candidates,
        });
        const logFields = {
          latency_ms: Date.now() - startedAt,
          candidate_count: req.body.candidates.length,
          project_id: resolved.projectId,
          source_id: resolved.source.sourceId,
          selection_mode: resolved.selectionMode,
          repository_owner: resolved.source.owner,
          repository_name: resolved.source.repo,
        };
        if (outcome.status === "building") {
          req.log.info(
            {
              ...logFields,
              commit_sha: req.body.baseCommitSha ?? null,
              status: outcome.status,
            },
            "Skill catalog conflict check completed",
          );
          reply.header("Retry-After", String(outcome.retryAfterSeconds));
          reply.code(202);
          return {
            error: "catalog_building",
            sourceId: resolved.source.sourceId,
            commitSha: req.body.baseCommitSha ?? null,
            catalog: catalogResponseMetadata(
              resolved,
              req.body.baseCommitSha ?? null,
              null,
            ),
          };
        }
        if (outcome.status === "failed") {
          req.log.info(
            {
              ...logFields,
              commit_sha: outcome.snapshot.commitSha,
              status: outcome.status,
            },
            "Skill catalog conflict check completed",
          );
          reply.code(503);
          return {
            error: "catalog_not_ready",
            sourceId: resolved.source.sourceId,
            commitSha: outcome.snapshot.commitSha,
            catalog: catalogResponseMetadata(
              resolved,
              outcome.snapshot.commitSha,
              null,
            ),
          };
        }
        req.log.info(
          {
            ...logFields,
            commit_sha: outcome.response.catalog.commitSha,
            status: outcome.status,
          },
          "Skill catalog conflict check completed",
        );
        return {
          ...outcome.response,
          catalog: {
            ...catalogResponseMetadata(
              resolved,
              outcome.response.catalog.commitSha,
              outcome.response.catalog.snapshotState,
            ),
          },
        };
      } catch (error) {
        return sendCatalogError(reply, error);
      }
    },
  );
}
