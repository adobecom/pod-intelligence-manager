import type { WebSocket } from "ws";
import type {
  TunnelResponse,
  TunnelResponseChunk,
} from "@council/shared";
import db from "../db/connection.js";
import { broadcast } from "./index.js";

const IDLE_CHECK_INTERVAL_MS = 60_000;
const IDLE_TIMEOUT_MS = 20 * 60_000;

interface PendingRequest {
  resolve: (msg: TunnelResponse) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  chunks: Buffer[];
  headersReceived?: { statusCode: number; headers: Record<string, string> };
}

interface TunnelConnection {
  ws: WebSocket;
  tunnelId: string;
  podId: string;
  localPort: number;
  pending: Map<string, PendingRequest>;
  lastTraffic: number;
}

const connections = new Map<string, TunnelConnection>();

export function registerTunnelConnection(
  tunnelId: string,
  podId: string,
  localPort: number,
  ws: WebSocket,
): void {
  connections.set(tunnelId, {
    ws,
    tunnelId,
    podId,
    localPort,
    pending: new Map(),
    lastTraffic: Date.now(),
  });
}

export function unregisterTunnelConnection(tunnelId: string): void {
  const conn = connections.get(tunnelId);
  if (conn) {
    // Reject all pending requests
    for (const [, req] of conn.pending) {
      clearTimeout(req.timeout);
      req.reject(new Error("Tunnel disconnected"));
    }
    conn.pending.clear();
    connections.delete(tunnelId);
  }
}

export function getTunnelConnection(tunnelId: string): TunnelConnection | undefined {
  return connections.get(tunnelId);
}

export function hasTunnelConnection(tunnelId: string): boolean {
  return connections.has(tunnelId);
}

/** Register a pending request and return a promise that resolves with the response. */
export function addPendingRequest(
  tunnelId: string,
  requestId: string,
  timeoutMs: number,
): Promise<TunnelResponse> {
  const conn = connections.get(tunnelId);
  if (!conn) return Promise.reject(new Error("Tunnel not connected"));

  return new Promise<TunnelResponse>((resolve, reject) => {
    const timeout = setTimeout(() => {
      conn.pending.delete(requestId);
      reject(new Error("Tunnel request timeout"));
    }, timeoutMs);

    conn.pending.set(requestId, {
      resolve,
      reject,
      timeout,
      chunks: [],
    });
  });
}

/** Handle a TunnelResponse message from the CLI. */
export function resolvePendingRequest(
  tunnelId: string,
  msg: TunnelResponse,
): void {
  const conn = connections.get(tunnelId);
  if (!conn) return;

  conn.lastTraffic = Date.now();

  const pending = conn.pending.get(msg.requestId);
  if (!pending) return;

  clearTimeout(pending.timeout);
  conn.pending.delete(msg.requestId);
  pending.resolve(msg);
}

/** Reject a pending request (e.g. CLI reported an error for a specific requestId). */
export function rejectPendingRequest(
  tunnelId: string,
  requestId: string,
  error: string,
): void {
  const conn = connections.get(tunnelId);
  if (!conn) return;

  const pending = conn.pending.get(requestId);
  if (!pending) return;

  clearTimeout(pending.timeout);
  conn.pending.delete(requestId);
  pending.reject(new Error(error));
}

/** Handle a TunnelResponseChunk message from the CLI. */
export function handleResponseChunk(
  tunnelId: string,
  msg: TunnelResponseChunk,
): void {
  const conn = connections.get(tunnelId);
  if (!conn) return;

  conn.lastTraffic = Date.now();

  const pending = conn.pending.get(msg.requestId);
  if (!pending) return;

  // Store headers from first chunk
  if (msg.statusCode !== undefined && msg.headers) {
    pending.headersReceived = {
      statusCode: msg.statusCode,
      headers: msg.headers,
    };
  }

  pending.chunks.push(Buffer.from(msg.chunk, "base64"));

  if (msg.done) {
    clearTimeout(pending.timeout);
    conn.pending.delete(msg.requestId);

    const fullBody = Buffer.concat(pending.chunks);
    const head = pending.headersReceived ?? { statusCode: 200, headers: {} };

    pending.resolve({
      type: "tunnel_response",
      requestId: msg.requestId,
      statusCode: head.statusCode,
      headers: head.headers,
      body: fullBody.toString("base64"),
    });
  }
}

/** Record that traffic flowed through a tunnel (called on outbound request). */
export function markTunnelTraffic(tunnelId: string): void {
  const conn = connections.get(tunnelId);
  if (conn) conn.lastTraffic = Date.now();
}

// Periodic idle detection: mark tunnels as idle after 20 min of no traffic
const idleTimer = setInterval(() => {
  const now = Date.now();
  for (const [tunnelId, conn] of connections) {
    if (now - conn.lastTraffic >= IDLE_TIMEOUT_MS) {
      try {
        db.prepare(
          "UPDATE tunnels SET status = 'idle' WHERE tunnel_id = ? AND status = 'active'",
        ).run(tunnelId);

        const row = db.prepare("SELECT * FROM tunnels WHERE tunnel_id = ?").get(tunnelId) as
          | { tunnel_id: string; pod_id: string; dev_name: string; branch: string; url: string; status: string; last_activity: string }
          | undefined;

        if (row && row.status === "idle") {
          broadcast({
            type: "tunnel_status_changed",
            podId: conn.podId,
            payload: row,
          });
        }
      } catch {
        // DB error — skip this cycle
      }
    }
  }
}, IDLE_CHECK_INTERVAL_MS);

if (idleTimer.unref) idleTimer.unref();
