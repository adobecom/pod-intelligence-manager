import "./load-env.js";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { createTables } from "./db/schema.js";
import { runSchemaMigrations } from "./db/migrations.js";
import { seedDatabase } from "./db/seed.js";
import { seedKnowledgeGraph } from "./db/seed-knowledge.js";
import podRoutes from "./routes/pods.js";
import projectRoutes from "./routes/projects.js";
import conflictRoutes from "./routes/conflicts.js";
import contextUpdateRoutes from "./routes/context-updates.js";
import tunnelRoutes from "./routes/tunnels.js";
import livingDocRoutes from "./routes/living-doc.js";
import orgRoutes from "./routes/org.js";
import orgsRoutes from "./routes/orgs.js";
import pendingWorkRoutes from "./routes/pending-work.js";
import graphRoutes from "./routes/graph.js";
import contextSearchRoutes from "./routes/context-search.js";
import agentMemoryRoutes from "./routes/agent-memory.js";
import skillCatalogRoutes from "./routes/skill-catalog.js";
import skillCatalogWebhookRoutes from "./routes/skill-catalog-webhooks.js";
import hostedMcpRoutes from "./routes/hosted-mcp.js";
import memoryCapabilitiesRoutes from "./routes/memory-capabilities.js";
import memoryMcpRoutes from "./routes/memory-mcp.js";
import memoryV2BindingRoutes from "./routes/memory-v2-binding.js";
import memoryV2CapabilitiesRoutes from "./routes/memory-v2-capabilities.js";
import memoryV2ReadinessRoutes from "./routes/memory-v2-readiness.js";
import memoryV2SearchRoutes, {
  MEMORY_V2_RECORD_ID_MAX_LENGTH,
} from "./routes/memory-v2-search.js";
import memoryV2WriteRoutes, {
  MEMORY_V2_PATH_PARAM_MAX_LENGTH,
} from "./routes/memory-v2-write.js";
import memorySearchRoutes from "./routes/memory-search.js";
import memoryHarnessSearchRoutes from "./routes/memory-harness-search.js";
import memoryReceiptRoutes from "./routes/memory-receipts.js";
import memoryCandidateRoutes from "./routes/memory-candidates.js";
import memoryAttestationRoutes from "./routes/memory-attestations.js";
import memoryFeedbackRoutes from "./routes/memory-feedback.js";
import memoryDecisionRoutes from "./routes/memory-decisions.js";
import wsRoutes from "./routes/ws.js";
import wsTunnelRoutes from "./routes/ws-tunnel.js";
import tunnelProxyRoutes from "./routes/tunnel-proxy.js";
import { checkEscalations } from "./services/escalation.js";
import { runLintPass } from "./pim/agents/lint.js";
import { initializeKnowledgeGraph, loadedOrgIds, pruneStaleNodes, refreshAnalysisIfStale } from "./services/knowledge-graph.js";
import { migrateLegacyDefaultGraph, restoreGraphFromS3IfEmpty } from "./services/graph-storage.js";
import { runScheduledGraphSynthesis } from "./services/knowledge-synthesis.js";
import { runProjectSearchRefreshTick } from "./services/project-search-refresh.js";
import { rebuildProjectSearchAfterCoreRestore } from "./services/project-search-recovery.js";
import { runSkillCatalogRefPollTick } from "./services/skill-catalog-freshness.js";
import { runSkillCatalogEmbeddingBackfill } from "./services/skill-catalog-search.js";
import { runMemoryOutboxPass } from "./services/memory-outbox.js";
import {
  runMemoryInboxPass,
  runMemoryProviderReconciliationPass,
} from "./services/memory-attestations.js";
import {
  assertCanonicalMemoryAuthorityRequired,
  installLegacySqlWriteBarriers,
} from "./services/memory-authority.js";
import { backfillLegacyMemoryTokenBindings } from "./services/service-tokens.js";
import {
  assertMemoryV2StartupReconciled,
  reconcileMemoryV2CanonicalFacets,
  reconcileMemoryV2CanonicalWrites,
} from "./services/memory-v2-startup-reconciliation.js";
import { reconcileMemoryV2Resources } from "./services/memory-v2-resources.js";
import { reconcileMemoryV2RuntimeOrigins } from "./services/memory-v2-runtime-attestations.js";
import { reconcileMemoryV2ReverificationAdmissions } from "./services/memory-v2-reverification-admission.js";
import {
  getMemoryV2Availability,
  initializeMemoryV2Availability,
} from "./services/memory-v2-availability.js";
import {
  memoryV2ReverificationEnabled,
  runMemoryV2ReverificationPass,
} from "./services/memory-v2-reverification.js";
import { memoryV2ProductionReverificationProvider } from "./services/memory-v2-reverification-provider.js";
import {
  createCloudWatchSkillCatalogMetricSink,
  setSkillCatalogMetricSink,
} from "./services/skill-catalog-metrics.js";
import {
  createCloudWatchMemoryMetricSink,
  emitMemoryOperationalMetrics,
  emitMemoryV2ReverificationDeadLetterAgeMetrics,
  setMemoryMetricSink,
} from "./services/memory-metrics.js";
import { createAuthHook } from "./middleware/auth.js";
import { resolveRequestOrg } from "./middleware/org-context.js";
import { registerJsonBodyParser } from "./middleware/validation.js";
import { registerMemoryV2AvailabilityGuard } from "./middleware/memory-v2-availability.js";
import {
  isMemoryApiPath,
  isMemoryV2ApiPath,
  sendMemoryError,
  sendMemoryV2Error,
  type PimMemoryErrorCode,
  type PimMemoryV2ErrorCode,
} from "./middleware/memory-errors.js";
import db from "./db/connection.js";

const PORT = parseInt(process.env.PORT ?? "4000", 10);
const HOST = process.env.PIM_SERVER_HOST ?? "0.0.0.0";
const app = Fastify({
  logger: true,
  routerOptions: {
    maxParamLength: Math.max(
      MEMORY_V2_RECORD_ID_MAX_LENGTH,
      MEMORY_V2_PATH_PARAM_MAX_LENGTH,
    ),
  },
});
registerJsonBodyParser(app);
setSkillCatalogMetricSink(createCloudWatchSkillCatalogMetricSink(app.log));
setMemoryMetricSink(createCloudWatchMemoryMetricSink(app.log));

// Global error handler — structured errors, no stack traces to clients
app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
  request.log.error(error);
  if (reply.sent) return;
  const statusCode = error.statusCode ?? 500;
  if (isMemoryApiPath(request.url)) {
    const candidateCode = (error as Error & { code?: string }).code;
    const v1KnownCodes = new Set<PimMemoryErrorCode>([
      "authentication_required",
      "contract_version_unsupported",
      "schema_invalid",
      "resource_binding_mismatch",
      "idempotency_conflict",
      "resource_not_found",
      "evidence_unresolvable",
      "evidence_mismatch",
      "activation_requirement_unsatisfied",
      "transition_invalid",
      "rate_limited",
      "temporarily_unavailable",
    ]);
    const v2KnownCodes = new Set<PimMemoryV2ErrorCode>([
      ...v1KnownCodes,
      "scope_required",
      "provider_unavailable",
      "reverification_required",
    ]);
    if (isMemoryV2ApiPath(request.url)) {
      const code: PimMemoryV2ErrorCode = candidateCode
        && v2KnownCodes.has(candidateCode as PimMemoryV2ErrorCode)
        ? candidateCode as PimMemoryV2ErrorCode
        : statusCode >= 500
          ? "temporarily_unavailable"
          : "schema_invalid";
      sendMemoryV2Error(
        reply,
        statusCode,
        code,
        statusCode >= 500 ? "Memory service is temporarily unavailable" : error.message,
      );
      return;
    }
    const code: PimMemoryErrorCode = candidateCode
      && v1KnownCodes.has(candidateCode as PimMemoryErrorCode)
      ? candidateCode as PimMemoryErrorCode
      : statusCode >= 500
        ? "temporarily_unavailable"
        : "schema_invalid";
    sendMemoryError(
      reply,
      statusCode,
      code,
      statusCode >= 500 ? "Memory service is temporarily unavailable" : error.message,
    );
    return;
  }
  reply.code(statusCode).send({
    error: statusCode >= 500 ? "Internal server error" : error.message,
  });
});
registerMemoryV2AvailabilityGuard(app);

// Initialize database
createTables({ memoryMigrationThroughVersion: 11 });
installLegacySqlWriteBarriers();
assertCanonicalMemoryAuthorityRequired();
const memoryV2Startup = initializeMemoryV2Availability({
  migrate: () => runSchemaMigrations(),
  reconcile: () => {
    const grandfatheredBindings = backfillLegacyMemoryTokenBindings();
    if (grandfatheredBindings > 0) {
      app.log.info(
        `Backfilled ${grandfatheredBindings} repository bindings for pre-binding memory service tokens`,
      );
    }
    const resources = reconcileMemoryV2Resources();
    const facets = reconcileMemoryV2CanonicalFacets();
    const writes = reconcileMemoryV2CanonicalWrites();
    const runtimeOrigins = reconcileMemoryV2RuntimeOrigins();
    if (!resources.ok || !facets.ok || !writes.ok || !runtimeOrigins.ok) {
      throw new Error("Memory v2 admission companions failed reconciliation");
    }
  },
  admit: () => {
    const admission = reconcileMemoryV2ReverificationAdmissions();
    app.log.info(
      {
        eligible_records: admission.eligibleRecordCount,
        missing_records: admission.missingRecordCount,
        already_covered_records: admission.alreadyCoveredRecordCount,
        admitted_records: admission.admittedRecordCount,
        codebase_admitted: admission.codebaseAdmittedCount,
        harness_admitted: admission.harnessAdmittedCount,
        admission_cap: admission.maxAdmissionRecords,
      },
      "Memory v2 reverification admission reconciled",
    );
  },
  validate: () => {
    const reconciliation = assertMemoryV2StartupReconciled();
    app.log.info(
      {
        resource_rows: reconciliation.resources.repositoryProjectionCount
          + reconciliation.resources.harnessProjectionCount,
        record_sources: reconciliation.facets.records.sourceCount,
        candidate_sources: reconciliation.facets.candidates.sourceCount,
        receipt_sources: reconciliation.facets.receipts.sourceCount,
        feedback_sources: reconciliation.facets.feedback.sourceCount,
        active_pointers: reconciliation.facets.activePointerCount,
        harness_record_versions: reconciliation.facets.harnessRead.sourceRecordVersionCount,
        harness_backfill_empty: reconciliation.facets.harnessRead.emptyBackfill,
        runtime_corroboration_domains: reconciliation.runtimeOrigins.domainCount,
        runtime_origins: reconciliation.runtimeOrigins.originCount,
        runtime_derivations: reconciliation.runtimeOrigins.derivationCount,
        runtime_root_links: reconciliation.runtimeOrigins.rootLinkCount,
        runtime_candidate_links: reconciliation.runtimeOrigins.candidateLinkCount,
        runtime_review_signals: reconciliation.runtimeOrigins.reviewSignalCount,
        runtime_origin_mismatches: reconciliation.runtimeOrigins.mismatchCount,
        reverification_policies: reconciliation.reverification.policyCount,
        reverification_states: reconciliation.reverification.stateCount,
        reverification_jobs: reconciliation.reverification.jobCount,
        reverification_attempts: reconciliation.reverification.attemptCount,
        reverification_uncovered_influence:
          reconciliation.reverification.uncoveredInfluenceRecordCount,
        reverification_historical_states: reconciliation.reverification.historicalStateCount,
        reverification_historical_influence:
          reconciliation.reverification.historicalInfluenceEligibleCount,
        reverification_graph_mismatches: reconciliation.reverification.graphMismatchCount,
      },
      "Memory v2 startup reconciliation passed",
    );
  },
});
if (memoryV2Startup.error) {
  app.log.error(
    {
      err: memoryV2Startup.error,
      memory_v2_availability: memoryV2Startup.availability,
    },
    "Memory v2 startup failed; v2 remains unavailable while shared PIM routes continue",
  );
}
seedDatabase();

// Knowledge graph init.
//
// One-shot legacy migration: before multi-tenant partitioning, every org's graph was
// stored under the literal slot "default". The first deploy that ships partitioning
// sets PIM_LEGACY_DEFAULT_GRAPH_ORG_ID to the org that should inherit that data
// (production: T3 Events under Adobecom). Migration is idempotent — once the target
// slot exists, the helper is a no-op.
const LEGACY_DEFAULT_TARGET = process.env.PIM_LEGACY_DEFAULT_GRAPH_ORG_ID?.trim();
if (LEGACY_DEFAULT_TARGET) {
  try {
    await migrateLegacyDefaultGraph(LEGACY_DEFAULT_TARGET);
  } catch (err) {
    app.log.error(err, "Legacy default-graph migration failed");
  }
}

// Eager-load every known org's graph at boot so periodic jobs see them without
// waiting for a first request. New orgs created at runtime are loaded lazily on
// first access.
const orgIds = (db.prepare("SELECT org_id FROM orgs").all() as { org_id: string }[]).map(
  (r) => r.org_id,
);
for (const orgId of orgIds) {
  await restoreGraphFromS3IfEmpty(orgId);
  initializeKnowledgeGraph(orgId);
}

// Seed the demo org's graph for fresh local installs. Skipped silently if the
// graph already has nodes or if no demo org exists in this environment.
const DEMO_ORG_ID = "org_demo";
if (orgIds.includes(DEMO_ORG_ID)) {
  await seedKnowledgeGraph(DEMO_ORG_ID);
}

// Run a startup prune so a redeploy doesn't have to wait for the first interval tick.
try {
  pruneStaleNodes();
} catch (err) {
  app.log.error(err, "Initial knowledge graph prune failed");
}

// Portable core backups omit project_search_* because those rows (especially
// embeddings) dominate backup size and are reproducible from evidence/context.
// restore-db.sh leaves a marker only for that backup format. Rebuild locally,
// after org graphs are loaded and before the server becomes healthy; connector
// polling and embedding backfill remain on the normal background schedule.
try {
  await rebuildProjectSearchAfterCoreRestore(app.log);
} catch (err) {
  // Keep core PIM available even if recovery orchestration itself fails. The
  // untouched marker causes another deterministic attempt on the next start.
  app.log.error(err, "Project search recovery orchestration failed; rebuild marker retained");
}

// Register WebSocket support
await app.register(websocket);

// CORS — allow UI origin in dev, configurable for production
await app.register(cors, {
  origin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
});

// Rate limiting — global 100 req/min, route-level overrides via config.rateLimit
await app.register(rateLimit, {
  max: 100,
  timeWindow: "1 minute",
});

// Auth — attach `req.user` on every request so routes can rely on it.
// Phase 1: trust mode upserts a dev user; ims mode verifies IMS JWT.
// Public routes (health, static) short-circuit via allowlist below.
const authMode = (process.env.AUTH_MODE ?? "ims") as "trust" | "ims";
const authenticate = createAuthHook(authMode);

// Paths that must bypass auth + org-context entirely.
// WebSocket upgrades authenticate in-handler via token param or first frame.
// The `/tunnel/` proxy authenticates via a per-tunnel share_token path segment
// (checked in tunnel-proxy.ts) so external collaborators without IMS sessions
// can load previews — matching Expo/ngrok semantics.
// `/mcp` and `/mcp/memory` perform stricter service-token-only authentication
// in their own routes before constructing a per-request MCP server.
const PUBLIC_PATHS = new Set<string>([
  "/api/health",
  "/api/cli-config",
  "/mcp",
  "/mcp/memory",
]);
const PUBLIC_PREFIXES = [
  "/ws",
  "/tunnel",
  "/api/skill-catalog/webhooks/github",
];
const isPublic = (url: string) => {
  const path = url.split("?")[0];
  return PUBLIC_PATHS.has(path) || PUBLIC_PREFIXES.some(p => path === p || path.startsWith(p + "/"));
};

// Paths that need auth but NOT org-context resolution (user-level surfaces).
const ORG_BYPASS_PREFIXES = ["/api/me", "/api/orgs"];
const needsOrgContext = (url: string) => {
  const path = url.split("?")[0];
  return !ORG_BYPASS_PREFIXES.some(p => path === p || path.startsWith(p + "/"));
};

app.addHook("onRequest", async (req, reply) => {
  if (isPublic(req.url)) return;
  await authenticate(req, reply);
  if (reply.sent) return;
  if (needsOrgContext(req.url)) {
    await resolveRequestOrg(req, reply);
  }
});

// Register routes
app.register(podRoutes);
app.register(projectRoutes);
app.register(conflictRoutes);
app.register(contextUpdateRoutes);
app.register(tunnelRoutes);
app.register(livingDocRoutes);
app.register(orgRoutes);
app.register(orgsRoutes);
app.register(pendingWorkRoutes);
app.register(graphRoutes);
app.register(contextSearchRoutes);
app.register(agentMemoryRoutes);
app.register(skillCatalogRoutes);
app.register(skillCatalogWebhookRoutes);
app.register(memoryCapabilitiesRoutes);
app.register(memoryV2BindingRoutes);
app.register(memoryV2CapabilitiesRoutes);
app.register(memoryV2ReadinessRoutes);
app.register(memoryV2SearchRoutes);
app.register(memoryV2WriteRoutes);
app.register(memorySearchRoutes);
app.register(memoryHarnessSearchRoutes);
app.register(memoryReceiptRoutes);
app.register(memoryCandidateRoutes);
app.register(memoryAttestationRoutes);
app.register(memoryFeedbackRoutes);
app.register(memoryDecisionRoutes);
app.register(hostedMcpRoutes, {
  apiBaseUrl: `http://127.0.0.1:${PORT}`,
});
app.register(memoryMcpRoutes);
app.register(wsRoutes);
app.register(wsTunnelRoutes);
app.register(tunnelProxyRoutes);

// Health check — verifies DB connectivity, returns uptime, pod count, and auth mode
const serverStartedAt = new Date().toISOString();
app.get("/api/health", async (_req, reply) => {
  try {
    const row = db.prepare("SELECT COUNT(*) as count FROM pods").get() as { count: number };
    return {
      status: "ok",
      started_at: serverStartedAt,
      uptime_seconds: Math.floor(process.uptime()),
      auth_mode: authMode,
      ims_client_id: process.env.IMS_CLIENT_ID ?? null,
      ims_env: (process.env.IMS_ENV === "prod" ? "prod" : "stg1"),
      db: { connected: true, active_pods: row.count },
    };
  } catch {
    reply.code(503);
    return { status: "degraded", error: "Database unreachable" };
  }
});

// CLI auto-config — advertises IMS client settings so `pim login` works without
// env vars. Split from /api/health so secret-shaped values don't appear on the
// endpoint that every compliance scanner crawls.
//
// Security note: `ims_cli_client_secret` is intentionally public for the
// authorization-code+PKCE flow (the code_verifier protects against code
// interception even if the secret is known). However, the refresh grant does
// NOT use PKCE, so `client_secret + refresh_token` together enable persistent
// token minting. The refresh_token lives in ~/.pim/credentials.json (chmod 600);
// treat secret rotation as an incident response action if credentials are
// compromised. Rate-limited to 10 req/min per IP to slow enumeration.
app.get("/api/cli-config", {
  config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
}, async (req) => {
  req.log.info({ ip: req.headers["x-forwarded-for"] ?? req.ip, ua: req.headers["user-agent"] }, "cli-config accessed");
  return {
    auth_mode: authMode,
    ims_env: (process.env.IMS_ENV === "prod" ? "prod" : "stg1"),
    ims_client_id: process.env.IMS_CLIENT_ID ?? null,
    ims_cli_client_id: process.env.IMS_CLI_CLIENT_ID ?? process.env.IMS_CLIENT_ID ?? null,
    ims_cli_client_secret: process.env.IMS_CLI_CLIENT_SECRET ?? null,
    ims_cli_scopes: process.env.IMS_CLI_SCOPES ?? "AdobeID,openid",
  };
});

const ESCALATION_INTERVAL_MS = parseInt(process.env.ESCALATION_INTERVAL_MS ?? "300000", 10); // 5 min
const LINT_INTERVAL_MS = parseInt(process.env.LINT_INTERVAL_MS ?? "7200000", 10); // 2 hours
const GRAPH_REFRESH_INTERVAL_MS = parseInt(process.env.GRAPH_REFRESH_INTERVAL_MS ?? "1800000", 10); // 30 min
const GRAPH_PRUNE_INTERVAL_MS = parseInt(process.env.GRAPH_PRUNE_INTERVAL_MS ?? "86400000", 10); // 24 hours
const GRAPH_SYNTHESIS_INTERVAL_MS = parseInt(process.env.GRAPH_SYNTHESIS_INTERVAL_MS ?? "604800000", 10); // 7 days
/** How often (ms) to sweep active projects for incremental search-index refresh. Default 6 h. */
const PROJECT_SEARCH_REFRESH_INTERVAL_MS = parseInt(process.env.PROJECT_SEARCH_REFRESH_INTERVAL_MS ?? "21600000", 10); // 6 hours
/** Trailing activity window (days) for determining which projects to include in the refresh sweep. */
const PROJECT_SEARCH_REFRESH_WINDOW_DAYS = parseInt(process.env.PROJECT_SEARCH_REFRESH_WINDOW_DAYS ?? "30", 10);
/** Set to "0" to disable the scheduled project-search refresh (e.g. in read-only worker processes). */
const PROJECT_SEARCH_REFRESH_ENABLED = process.env.PROJECT_SEARCH_REFRESH_ENABLED !== "0";
function positiveIntervalMs(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
/** How often to reconcile every enabled skill-catalog source's configured ref. */
const SKILL_CATALOG_POLL_INTERVAL_MS = positiveIntervalMs(
  process.env.SKILL_CATALOG_POLL_INTERVAL_MS,
  60_000,
);
/** Set to "0" to disable automatic skill-catalog ref polling. */
const SKILL_CATALOG_POLL_ENABLED = process.env.SKILL_CATALOG_POLL_ENABLED !== "0";
/** How often to retry pending/failed catalog embeddings. */
const SKILL_CATALOG_EMBED_INTERVAL_MS = positiveIntervalMs(
  process.env.SKILL_CATALOG_EMBED_INTERVAL_MS,
  60_000,
);
/** Set to "0" to disable background skill-catalog embedding work. */
const SKILL_CATALOG_EMBED_ENABLED =
  process.env.SKILL_CATALOG_EMBED_ENABLED !== "0";
const MEMORY_OUTBOX_INTERVAL_MS = positiveIntervalMs(
  process.env.MEMORY_OUTBOX_INTERVAL_MS,
  30_000,
);
const MEMORY_RECONCILE_INTERVAL_MS = positiveIntervalMs(
  process.env.MEMORY_RECONCILE_INTERVAL_MS,
  5 * 60_000,
);
const MEMORY_METRICS_INTERVAL_MS = positiveIntervalMs(
  process.env.MEMORY_METRICS_INTERVAL_MS,
  60_000,
);
const MEMORY_V2_REVERIFICATION_INTERVAL_MS = positiveIntervalMs(
  process.env.MEMORY_V2_REVERIFICATION_INTERVAL_MS,
  30_000,
);
const MEMORY_WORKERS_ENABLED = process.env.MEMORY_WORKERS_ENABLED !== "0";
let memoryV2ReverificationTimer: ReturnType<typeof setInterval> | null = null;
let memoryV2ReverificationInFlight: Promise<void> | null = null;

app.listen({ port: PORT, host: HOST }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }

  // Periodic escalation checks
  setInterval(() => {
    try {
      checkEscalations();
    } catch (e) {
      app.log.error(e, "Escalation check failed");
    }
  }, ESCALATION_INTERVAL_MS);

  // Periodic lint pass across all active pods
  setInterval(() => {
    void (async () => {
      try {
        const pods = db.prepare("SELECT pod_id FROM org_pod_summaries").all() as { pod_id: string }[];
        for (const { pod_id } of pods) {
          await runLintPass(pod_id).catch((e) => {
            app.log.error(e, "Lint pass failed for pod");
          });
        }
      } catch (e) {
        app.log.error(e, "Lint pass failed");
      }
    })();
  }, LINT_INTERVAL_MS);

  // Periodic knowledge graph community detection refresh.
  // Only recomputes when a prior mutation marked the graph stale (e.g. ad-hoc POSTs that
  // skip per-request analysis). No-op otherwise — cheap to call frequently.
  // When PIM_GRAPH_WORKER=true the function returns a Promise; either way the interval
  // fires fire-and-forget so refresh never blocks the next tick.
  setInterval(() => {
    try {
      const result = refreshAnalysisIfStale();
      if (result instanceof Promise) {
        result.catch((e) => app.log.error(e, "Knowledge graph refresh (worker) failed"));
      }
    } catch (e) {
      app.log.error(e, "Knowledge graph refresh failed");
    }
  }, GRAPH_REFRESH_INTERVAL_MS);

  // Periodic prune of stale low-confidence uncurated nodes
  setInterval(() => {
    try {
      pruneStaleNodes();
    } catch (e) {
      app.log.error(e, "Knowledge graph prune failed");
    }
  }, GRAPH_PRUNE_INTERVAL_MS);

  // Scheduled graph synthesis — one pass per loaded org per interval tick.
  // Each pass is independently gated on LLM + embeddings + sufficient embedded nodes,
  // so most ticks for empty orgs are cheap no-ops.
  setInterval(() => {
    void (async () => {
      for (const orgId of loadedOrgIds()) {
        try {
          const r = await runScheduledGraphSynthesis(orgId);
          if (!r.ok) {
            app.log.error({
              msg: "Knowledge graph synthesis failed",
              org_id: orgId,
              error: r.error ?? "unknown",
              run_id: r.run_id,
            });
            continue;
          }
          if (r.skipped) {
            app.log.debug({ msg: "Knowledge graph synthesis skipped", org_id: orgId, reason: r.skipped, run_id: r.run_id });
          } else {
            app.log.info({
              msg: "Knowledge graph synthesis completed",
              org_id: orgId,
              run_id: r.run_id,
              nodes_added: r.nodes_added ?? 0,
              edges_added: r.edges_added ?? 0,
            });
          }
        } catch (e) {
          app.log.error(e, `Knowledge graph synthesis failed for org ${orgId}`);
        }
      }
    })();
  }, GRAPH_SYNTHESIS_INTERVAL_MS);

  // Scheduled incremental project-search refresh.
  // Run once at startup so existing configured-but-empty projects do not wait a
  // full interval for their first backfill, then continue on the normal cadence.
  // Projects are spread across the interval with per-project jitter to avoid API bursts.
  // Gated by PROJECT_SEARCH_REFRESH_ENABLED (default on).
  if (PROJECT_SEARCH_REFRESH_ENABLED) {
    void runProjectSearchRefreshTick(0, app.log, PROJECT_SEARCH_REFRESH_WINDOW_DAYS).catch((e) => {
      app.log.error(e, "Initial project search refresh tick failed");
    });
    setInterval(() => {
      void (async () => {
        try {
          await runProjectSearchRefreshTick(PROJECT_SEARCH_REFRESH_INTERVAL_MS, app.log, PROJECT_SEARCH_REFRESH_WINDOW_DAYS);
        } catch (e) {
          app.log.error(e, "Project search refresh tick failed");
        }
      })();
    }, PROJECT_SEARCH_REFRESH_INTERVAL_MS);
  }

  if (SKILL_CATALOG_POLL_ENABLED) {
    const pollSkillCatalogRefs = () => {
      void runSkillCatalogRefPollTick(app.log).catch((e) => {
        app.log.error(e, "Skill catalog ref poll failed");
      });
    };
    // Reconcile once at startup so a push missed during a deploy does not wait
    // for a full interval before the source becomes current.
    pollSkillCatalogRefs();
    setInterval(pollSkillCatalogRefs, SKILL_CATALOG_POLL_INTERVAL_MS);
  }

  if (SKILL_CATALOG_EMBED_ENABLED) {
    let running = false;
    const backfillSkillCatalogEmbeddings = () => {
      if (running) return;
      running = true;
      void runSkillCatalogEmbeddingBackfill()
        .then((result) => {
          app.log.info(
            {
              available: result.available,
              failed: result.failed,
              hydrated: result.hydrated,
              processed: result.processed,
              ready: result.ready,
              search_ready_snapshots: result.snapshots.searchReady,
            },
            "Skill catalog embedding backfill completed",
          );
        })
        .catch((error) => {
          app.log.error(error, "Skill catalog embedding backfill failed");
        })
        .finally(() => {
          running = false;
        });
    };
    backfillSkillCatalogEmbeddings();
    setInterval(
      backfillSkillCatalogEmbeddings,
      SKILL_CATALOG_EMBED_INTERVAL_MS,
    );
  }

  if (MEMORY_WORKERS_ENABLED) {
    const drainMemoryOutbox = () => {
      try {
        runMemoryOutboxPass();
      } catch (error) {
        app.log.error(error, "Memory outbox pass failed");
      }
    };
    const reconcileMemoryInbox = () => {
      void runMemoryProviderReconciliationPass()
        .then(() => runMemoryInboxPass({ forceUnmatched: true }))
        .catch((error) => {
          app.log.error(error, "Memory provider reconciliation failed");
        });
    };
    drainMemoryOutbox();
    reconcileMemoryInbox();
    setInterval(drainMemoryOutbox, MEMORY_OUTBOX_INTERVAL_MS);
    setInterval(reconcileMemoryInbox, MEMORY_RECONCILE_INTERVAL_MS);
  }

  if (memoryV2ReverificationEnabled()
      && getMemoryV2Availability().status === "ready") {
    const reverifyMemory = () => {
      if (memoryV2ReverificationInFlight) {
        app.log.debug(
          { interval_ms: MEMORY_V2_REVERIFICATION_INTERVAL_MS },
          "Memory v2 reverification pass skipped because the prior pass is still running",
        );
        return;
      }
      const pass = runMemoryV2ReverificationPass({
        provider: memoryV2ProductionReverificationProvider,
      })
        .then((result) => {
          app.log.info(
            {
              scheduled: result.scheduled,
              claimed: result.claimed,
              verified: result.verified,
              retired: result.retired,
              pending: result.pending,
              dead_lettered: result.deadLettered,
            },
            "Memory v2 reverification pass completed",
          );
        })
        .catch((error) => {
          app.log.error(error, "Memory v2 reverification pass failed");
        })
        .finally(() => {
          if (memoryV2ReverificationInFlight === pass) {
            memoryV2ReverificationInFlight = null;
          }
        });
      memoryV2ReverificationInFlight = pass;
    };
    reverifyMemory();
    memoryV2ReverificationTimer = setInterval(
      reverifyMemory,
      MEMORY_V2_REVERIFICATION_INTERVAL_MS,
    );
  }

  const publishMemoryOperationalMetrics = () => {
    try {
      emitMemoryOperationalMetrics();
      emitMemoryV2ReverificationDeadLetterAgeMetrics();
    } catch (error) {
      app.log.error(error, "Memory operational metric collection failed");
    }
  };
  publishMemoryOperationalMetrics();
  setInterval(publishMemoryOperationalMetrics, MEMORY_METRICS_INTERVAL_MS);

  app.log.info(`Escalation check interval: ${ESCALATION_INTERVAL_MS}ms`);
  app.log.info(`Lint pass interval: ${LINT_INTERVAL_MS}ms`);
  app.log.info(`Knowledge graph refresh interval: ${GRAPH_REFRESH_INTERVAL_MS}ms`);
  app.log.info(`Knowledge graph prune interval: ${GRAPH_PRUNE_INTERVAL_MS}ms`);
  app.log.info(`Knowledge graph synthesis interval: ${GRAPH_SYNTHESIS_INTERVAL_MS}ms`);
  app.log.info(
    PROJECT_SEARCH_REFRESH_ENABLED
      ? `Project search refresh interval: ${PROJECT_SEARCH_REFRESH_INTERVAL_MS}ms (window: ${PROJECT_SEARCH_REFRESH_WINDOW_DAYS}d)`
      : "Project search refresh: disabled (PROJECT_SEARCH_REFRESH_ENABLED=0)",
  );
  app.log.info(
    SKILL_CATALOG_POLL_ENABLED
      ? `Skill catalog ref poll interval: ${SKILL_CATALOG_POLL_INTERVAL_MS}ms`
      : "Skill catalog ref polling: disabled (SKILL_CATALOG_POLL_ENABLED=0)",
  );
  app.log.info(
    SKILL_CATALOG_EMBED_ENABLED
      ? `Skill catalog embedding interval: ${SKILL_CATALOG_EMBED_INTERVAL_MS}ms`
      : "Skill catalog embeddings: disabled (SKILL_CATALOG_EMBED_ENABLED=0)",
  );
  app.log.info(
    MEMORY_WORKERS_ENABLED
      ? `Memory workers: outbox ${MEMORY_OUTBOX_INTERVAL_MS}ms, reconciliation ${MEMORY_RECONCILE_INTERVAL_MS}ms`
      : "Memory workers: disabled (MEMORY_WORKERS_ENABLED=0)",
  );
  app.log.info(
    {
      enabled: memoryV2ReverificationEnabled(),
      memory_v2_availability: getMemoryV2Availability(),
      interval_ms: MEMORY_V2_REVERIFICATION_INTERVAL_MS,
    },
    "Memory v2 reverification worker configured",
  );
  app.log.info(`Memory operational metrics interval: ${MEMORY_METRICS_INTERVAL_MS}ms`);
});

// Graceful shutdown so Docker restarts and ASG replacements don't corrupt SQLite WAL.
const shutdown = async (signal: string): Promise<void> => {
  app.log.info(`Received ${signal}, shutting down gracefully`);
  try {
    if (memoryV2ReverificationTimer) {
      clearInterval(memoryV2ReverificationTimer);
      memoryV2ReverificationTimer = null;
    }
    await memoryV2ReverificationInFlight;
    await app.close();
    db.close();
    process.exit(0);
  } catch (err) {
    app.log.error(err, "Graceful shutdown failed");
    process.exit(1);
  }
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
