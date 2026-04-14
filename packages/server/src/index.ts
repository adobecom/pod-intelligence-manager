import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { createTables } from "./db/schema.js";
import { seedDatabase } from "./db/seed.js";
import podRoutes from "./routes/pods.js";
import conflictRoutes from "./routes/conflicts.js";
import contextUpdateRoutes from "./routes/context-updates.js";
import tunnelRoutes from "./routes/tunnels.js";
import livingDocRoutes from "./routes/living-doc.js";
import orgRoutes from "./routes/org.js";
import pendingWorkRoutes from "./routes/pending-work.js";
import wsRoutes from "./routes/ws.js";

const app = Fastify({ logger: true });

// Initialize database
createTables();
seedDatabase();

// Register WebSocket support
await app.register(websocket);

// Register routes
app.register(podRoutes);
app.register(conflictRoutes);
app.register(contextUpdateRoutes);
app.register(tunnelRoutes);
app.register(livingDocRoutes);
app.register(orgRoutes);
app.register(pendingWorkRoutes);
app.register(wsRoutes);

// Health check
app.get("/api/health", async () => ({ status: "ok" }));

const PORT = parseInt(process.env.PORT ?? "4000", 10);

app.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
});
