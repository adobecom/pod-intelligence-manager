import "./load-env.js";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { createTables } from "./db/schema.js";
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
import wsRoutes from "./routes/ws.js";
import wsTunnelRoutes from "./routes/ws-tunnel.js";
import tunnelProxyRoutes from "./routes/tunnel-proxy.js";
import { checkEscalations } from "./services/escalation.js";
import { runLintPass } from "./pim/agents/lint.js";
import { initializeKnowledgeGraph, loadedOrgIds, pruneStaleNodes, refreshAnalysisIfStale } from "./services/knowledge-graph.js";
import { migrateLegacyDefaultGraph, restoreGraphFromS3IfEmpty } from "./services/graph-storage.js";
import { runScheduledGraphSynthesis } from "./services/knowledge-synthesis.js";
import { runProjectSearchRefreshTick } from "./services/project-search-refresh.js";
import { createAuthHook } from "./middleware/auth.js";
import { resolveRequestOrg } from "./middleware/org-context.js";
import { registerJsonBodyParser } from "./middleware/validation.js";
import db from "./db/connection.js";

const app = Fastify({ logger: true });
registerJsonBodyParser(app);

// Global error handler — structured errors, no stack traces to clients
app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
  request.log.error(error);
  if (reply.sent) return;
  const statusCode = error.statusCode ?? 500;
  reply.code(statusCode).send({
    error: statusCode >= 500 ? "Internal server error" : error.message,
  });
});

// Initialize database
createTables();
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
const PUBLIC_PATHS = new Set<string>(["/api/health", "/api/cli-config"]);
const PUBLIC_PREFIXES = ["/ws", "/tunnel"];
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

const PORT = parseInt(process.env.PORT ?? "4000", 10);
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

app.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
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
});

// Graceful shutdown so Docker restarts and ASG replacements don't corrupt SQLite WAL.
const shutdown = async (signal: string): Promise<void> => {
  app.log.info(`Received ${signal}, shutting down gracefully`);
  try {
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
