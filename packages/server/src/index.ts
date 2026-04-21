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
import wsRoutes from "./routes/ws.js";
import wsTunnelRoutes from "./routes/ws-tunnel.js";
import tunnelProxyRoutes from "./routes/tunnel-proxy.js";
import { checkEscalations } from "./services/escalation.js";
import { runLintPass } from "./pim/agents/lint.js";
import { initializeKnowledgeGraph, refreshAnalysis } from "./services/knowledge-graph.js";
import { restoreGraphFromS3IfEmpty } from "./services/graph-storage.js";
import { createAuthHook } from "./middleware/auth.js";
import { resolveRequestOrg } from "./middleware/org-context.js";
import db from "./db/connection.js";

const app = Fastify({ logger: true });

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

// Initialize knowledge graph (restore from S3 if local is empty, then load from disk into memory)
await restoreGraphFromS3IfEmpty("default");
initializeKnowledgeGraph("default");
await seedKnowledgeGraph();

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
const authMode = (process.env.AUTH_MODE ?? "trust") as "trust" | "ims";
const authenticate = createAuthHook(authMode);

// Paths that must bypass auth + org-context entirely.
// WebSocket upgrades authenticate in-handler via token param or first frame.
const PUBLIC_PATHS = new Set<string>(["/api/health"]);
const PUBLIC_PREFIXES = ["/ws"];
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
      // CLI login settings — advertised so users need no env vars to run `pim login`.
      // client_secret is intentionally public: CLI clients are inherently not secret
      // (distributed to all users), so advertising it is equivalent to shipping it in the binary.
      ims_cli_client_id: process.env.IMS_CLI_CLIENT_ID ?? process.env.IMS_CLIENT_ID ?? null,
      ims_cli_client_secret: process.env.IMS_CLI_CLIENT_SECRET ?? null,
      ims_cli_scopes: process.env.IMS_CLI_SCOPES ?? "AdobeID,openid",
      db: { connected: true, active_pods: row.count },
    };
  } catch {
    reply.code(503);
    return { status: "degraded", error: "Database unreachable" };
  }
});

const PORT = parseInt(process.env.PORT ?? "4000", 10);
const ESCALATION_INTERVAL_MS = parseInt(process.env.ESCALATION_INTERVAL_MS ?? "300000", 10); // 5 min
const LINT_INTERVAL_MS = parseInt(process.env.LINT_INTERVAL_MS ?? "7200000", 10); // 2 hours
const GRAPH_REFRESH_INTERVAL_MS = parseInt(process.env.GRAPH_REFRESH_INTERVAL_MS ?? "1800000", 10); // 30 min

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

  // Periodic knowledge graph community detection refresh
  setInterval(() => {
    try {
      refreshAnalysis();
    } catch (e) {
      app.log.error(e, "Knowledge graph refresh failed");
    }
  }, GRAPH_REFRESH_INTERVAL_MS);

  app.log.info(`Escalation check interval: ${ESCALATION_INTERVAL_MS}ms`);
  app.log.info(`Lint pass interval: ${LINT_INTERVAL_MS}ms`);
  app.log.info(`Knowledge graph refresh interval: ${GRAPH_REFRESH_INTERVAL_MS}ms`);
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
