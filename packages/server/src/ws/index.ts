import type { WebSocket } from "ws";

export interface WSEvent {
  type:
    | "context_update_added"
    | "context_update_quality_revised"
    | "conflict_created"
    | "conflict_resolved"
    | "conflict_escalated"
    | "pressure_changed"
    | "living_doc_updated"
    | "tunnel_status_changed"
    | "lint_completed"
    | "knowledge_updated"
    | "living_doc_viewed"
    | "project_context_update_added";
  podId: string;
  payload: unknown;
}

const HEARTBEAT_INTERVAL_MS = 60_000; // Ping every 60s
const IDLE_TIMEOUT_MS = 20 * 60_000;  // Mark idle after 20min of no traffic

interface ClientMeta {
  ws: WebSocket;
  podId: string;
  alive: boolean;
  lastActivity: number;
  idle: boolean;
}

// Map of podId -> Set of connected WebSocket clients
const clients = new Map<string, Set<ClientMeta>>();

// Heartbeat: ping all clients every 60s, terminate unresponsive ones
const heartbeatTimer = setInterval(() => {
  const now = Date.now();
  for (const [podId, podClients] of clients) {
    for (const meta of podClients) {
      if (!meta.alive) {
        // No pong since last ping — connection is dead
        meta.ws.terminate();
        podClients.delete(meta);
        continue;
      }

      // Mark idle after 20min of no inbound traffic
      if (!meta.idle && now - meta.lastActivity >= IDLE_TIMEOUT_MS) {
        meta.idle = true;
        try {
          meta.ws.send(JSON.stringify({ type: "status", status: "idle" }));
        } catch { /* ignore send errors on dying sockets */ }
      }

      meta.alive = false;
      meta.ws.ping();
    }

    if (podClients.size === 0) clients.delete(podId);
  }
}, HEARTBEAT_INTERVAL_MS);

// Allow the timer to not keep the process alive
if (heartbeatTimer.unref) heartbeatTimer.unref();

export function addClient(podId: string, ws: WebSocket) {
  if (!clients.has(podId)) {
    clients.set(podId, new Set());
  }

  const meta: ClientMeta = {
    ws,
    podId,
    alive: true,
    lastActivity: Date.now(),
    idle: false,
  };

  ws.on("pong", () => {
    meta.alive = true;
  });

  ws.on("message", () => {
    meta.lastActivity = Date.now();
    meta.alive = true;
    if (meta.idle) {
      meta.idle = false;
    }
  });

  clients.get(podId)!.add(meta);

  ws.on("close", () => {
    const podClients = clients.get(podId);
    if (podClients) {
      podClients.delete(meta);
      if (podClients.size === 0) clients.delete(podId);
    }
  });
}

export function broadcast(event: WSEvent) {
  const podClients = clients.get(event.podId);
  if (!podClients) return;

  const message = JSON.stringify(event);
  for (const meta of podClients) {
    if (meta.ws.readyState === meta.ws.OPEN) {
      meta.ws.send(message);
    }
  }
}

export function broadcastToAll(event: Omit<WSEvent, "podId"> & { podId?: string }) {
  const message = JSON.stringify(event);
  for (const [, podClients] of clients) {
    for (const meta of podClients) {
      if (meta.ws.readyState === meta.ws.OPEN) {
        meta.ws.send(message);
      }
    }
  }
}
