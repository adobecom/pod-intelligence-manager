import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";
import {
  TUNNEL_REQUEST_TIMEOUT_MS,
  type TunnelRequest,
} from "@council/shared";
import db from "../db/connection.js";
import {
  getTunnelConnection,
  addPendingRequest,
  markTunnelTraffic,
} from "../ws/tunnel-connections.js";

async function proxyRequest(
  tunnelId: string,
  subPath: string,
  req: FastifyRequest,
  reply: FastifyReply,
) {
  const conn = getTunnelConnection(tunnelId);

  if (!conn) {
    reply.code(502);
    return { error: "Tunnel not connected" };
  }

  if (conn.ws.readyState !== conn.ws.OPEN) {
    reply.code(502);
    return { error: "Tunnel WebSocket is not open" };
  }

  const requestId = randomUUID();

  // Build path with query string
  const queryString = req.url.includes("?")
    ? req.url.slice(req.url.indexOf("?"))
    : "";
  const forwardPath = `/${subPath}${queryString}`;

  // Serialize headers (lowercase, single-value)
  const headers: Record<string, string> = {};
  for (const [key, val] of Object.entries(req.headers)) {
    if (val !== undefined) {
      headers[key] = Array.isArray(val) ? val.join(", ") : val;
    }
  }
  // Remove hop-by-hop headers that don't apply to localhost
  delete headers.host;
  delete headers.connection;
  delete headers.upgrade;

  // Encode body
  let bodyBase64: string | null = null;
  if (req.body) {
    let buf: Buffer;
    if (Buffer.isBuffer(req.body)) {
      buf = req.body;
    } else if (typeof req.body === "string") {
      buf = Buffer.from(req.body);
    } else {
      buf = Buffer.from(JSON.stringify(req.body));
    }
    if (buf.length > 0) {
      bodyBase64 = buf.toString("base64");
    }
  }

  const tunnelReq: TunnelRequest = {
    type: "tunnel_request",
    requestId,
    method: req.method,
    path: forwardPath,
    headers,
    body: bodyBase64,
  };

  // Mark traffic for idle detection
  markTunnelTraffic(tunnelId);

  // Reset DB status to active if it was idle
  try {
    db.prepare(
      "UPDATE tunnels SET status = 'active', last_activity = ? WHERE tunnel_id = ? AND status = 'idle'",
    ).run(new Date().toISOString(), tunnelId);
  } catch {
    // Non-critical
  }

  // Send request through the WebSocket
  conn.ws.send(JSON.stringify(tunnelReq));

  // Wait for the response
  try {
    const tunnelRes = await addPendingRequest(
      tunnelId,
      requestId,
      TUNNEL_REQUEST_TIMEOUT_MS,
    );

    reply.code(tunnelRes.statusCode);

    for (const [key, val] of Object.entries(tunnelRes.headers)) {
      const lower = key.toLowerCase();
      if (lower === "transfer-encoding" || lower === "connection") continue;
      reply.header(key, val);
    }

    if (tunnelRes.body) {
      return reply.send(Buffer.from(tunnelRes.body, "base64"));
    }

    return reply.send();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    if (message.includes("timeout")) {
      reply.code(504);
      return { error: "Tunnel request timed out" };
    }
    reply.code(502);
    return { error: `Tunnel error: ${message}` };
  }
}

export default async function tunnelProxyRoutes(app: FastifyInstance) {
  // Accept any content type on this plugin scope — we need raw bodies
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => {
    done(null, body);
  });

  // Handle /tunnel/:tunnelId (root request, no sub-path)
  app.all<{ Params: { tunnelId: string } }>(
    "/tunnel/:tunnelId",
    async (req, reply) => proxyRequest(req.params.tunnelId, "", req, reply),
  );

  // Handle /tunnel/:tunnelId/* (all sub-paths)
  app.all<{ Params: { tunnelId: string; "*": string } }>(
    "/tunnel/:tunnelId/*",
    async (req, reply) => proxyRequest(req.params.tunnelId, req.params["*"] ?? "", req, reply),
  );
}
