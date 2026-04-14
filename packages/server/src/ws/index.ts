import type { WebSocket } from "ws";

export interface WSEvent {
  type:
    | "context_update_added"
    | "conflict_created"
    | "conflict_resolved"
    | "conflict_escalated"
    | "pressure_changed"
    | "living_doc_updated"
    | "tunnel_status_changed"
    | "lint_completed"
    | "knowledge_updated";
  podId: string;
  payload: unknown;
}

// Map of podId -> Set of connected WebSocket clients
const clients = new Map<string, Set<WebSocket>>();

export function addClient(podId: string, ws: WebSocket) {
  if (!clients.has(podId)) {
    clients.set(podId, new Set());
  }
  clients.get(podId)!.add(ws);

  ws.on("close", () => {
    const podClients = clients.get(podId);
    if (podClients) {
      podClients.delete(ws);
      if (podClients.size === 0) clients.delete(podId);
    }
  });
}

export function broadcast(event: WSEvent) {
  const podClients = clients.get(event.podId);
  if (!podClients) return;

  const message = JSON.stringify(event);
  for (const ws of podClients) {
    if (ws.readyState === ws.OPEN) {
      ws.send(message);
    }
  }
}

export function broadcastToAll(event: Omit<WSEvent, "podId"> & { podId?: string }) {
  const message = JSON.stringify(event);
  for (const [, podClients] of clients) {
    for (const ws of podClients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(message);
      }
    }
  }
}
