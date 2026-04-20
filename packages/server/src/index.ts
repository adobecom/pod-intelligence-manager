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
import pendingWorkRoutes from "./routes/pending-work.js";
import graphRoutes from "./routes/graph.js";
import contextSearchRoutes from "./routes/context-search.js";
import wsRoutes from "./routes/ws.js";
import wsTunnelRoutes from "./routes/ws-tunnel.js";
import tunnelProxyRoutes from "./routes/tunnel-proxy.js";
import { checkEscalations } from "./services/escalation.js";
import { runLintPass } from "./pim/agents/lint.js";
import { initializeKnowledgeGraph, refreshAnalysis } from "./services/knowledge-graph.js";
import { createAuthHook } from "./middleware/auth.js";
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

// Initialize knowledge graph (load from disk into memory)
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

// Auth — protect write routes (POST/PUT/DELETE/PATCH)
const authMode = (process.env.AUTH_MODE ?? "trust") as "trust" | "ims";
const authenticate = createAuthHook(authMode);
app.addHook("onRequest", async (req, reply) => {
  if (["POST", "PUT", "DELETE", "PATCH"].includes(req.method)) {
    await authenticate(req, reply);
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
app.register(pendingWorkRoutes);
app.register(graphRoutes);
app.register(contextSearchRoutes);
app.register(wsRoutes);
app.register(wsTunnelRoutes);
app.register(tunnelProxyRoutes);

// Health check — verifies DB connectivity, returns uptime and pod count
const serverStartedAt = new Date().toISOString();
app.get("/api/health", async (_req, reply) => {
  try {
    const row = db.prepare("SELECT COUNT(*) as count FROM pods").get() as { count: number };
    return {
      status: "ok",
      started_at: serverStartedAt,
      uptime_seconds: Math.floor(process.uptime()),
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
