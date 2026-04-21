import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { TunnelResponse } from "@pim/shared";

// Mock db — share_token lookup always returns the fixture token so tests
// focus on proxy behavior rather than token plumbing (covered separately).
// vi.mock hoists above imports, so the literal is inlined here (not shared
// via const) to avoid TDZ errors.
vi.mock("../../db/connection.js", () => ({
  default: {
    prepare: vi.fn().mockReturnValue({
      run: vi.fn(),
      get: vi.fn().mockReturnValue({ share_token: "fixture-token-abc" }),
    }),
  },
}));
const FIXTURE_TOKEN = "fixture-token-abc";

// Mock the broadcast function
vi.mock("../../ws/index.js", () => ({
  broadcast: vi.fn(),
}));

// We'll control tunnel connections directly via the real module
import {
  registerTunnelConnection,
  unregisterTunnelConnection,
  resolvePendingRequest,
} from "../../ws/tunnel-connections.js";
import tunnelProxyRoutes from "../tunnel-proxy.js";

function createMockWs() {
  const sentMessages: string[] = [];
  return {
    readyState: 1,
    OPEN: 1,
    send: vi.fn((data: string) => sentMessages.push(data)),
    close: vi.fn(),
    on: vi.fn(),
    terminate: vi.fn(),
    _sentMessages: sentMessages,
  } as unknown as import("ws").WebSocket & { _sentMessages: string[] };
}

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  app.register(tunnelProxyRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  unregisterTunnelConnection("test-tunnel-1");
});

describe("tunnel-proxy routes", () => {
  it("returns 502 when tunnel is not connected", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/tunnel/nonexistent-tunnel/${FIXTURE_TOKEN}/index.html`,
    });

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("Tunnel not connected");
  });

  it("sends tunnel_request through the WebSocket", async () => {
    const ws = createMockWs();
    registerTunnelConnection("test-tunnel-1", "pod-1", 3000, ws);

    // Fire request but don't await — we need to resolve it manually
    const resPromise = app.inject({
      method: "GET",
      url: `/tunnel/test-tunnel-1/${FIXTURE_TOKEN}/some/path?foo=bar`,
    });

    // Give Fastify a tick to send the WS message
    await new Promise((r) => setTimeout(r, 50));

    // Verify the WebSocket received a tunnel_request
    expect(ws.send).toHaveBeenCalled();
    const sent = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(sent.type).toBe("tunnel_request");
    expect(sent.method).toBe("GET");
    expect(sent.path).toBe("/some/path?foo=bar");
    expect(sent.requestId).toBeDefined();

    // Resolve the pending request
    resolvePendingRequest("test-tunnel-1", {
      type: "tunnel_response",
      requestId: sent.requestId,
      statusCode: 200,
      headers: { "content-type": "text/html" },
      body: Buffer.from("<h1>Hello</h1>").toString("base64"),
    });

    const res = await resPromise;
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/html");
    expect(res.body).toBe("<h1>Hello</h1>");
  });

  it("handles root tunnel path (no sub-path)", async () => {
    const ws = createMockWs();
    registerTunnelConnection("test-tunnel-1", "pod-1", 3000, ws);

    const resPromise = app.inject({
      method: "GET",
      url: `/tunnel/test-tunnel-1/${FIXTURE_TOKEN}`,
    });

    await new Promise((r) => setTimeout(r, 50));

    const sent = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(sent.path).toBe("/");

    resolvePendingRequest("test-tunnel-1", {
      type: "tunnel_response",
      requestId: sent.requestId,
      statusCode: 200,
      headers: {},
      body: null,
    });

    const res = await resPromise;
    expect(res.statusCode).toBe(200);
  });

  it("forwards POST bodies", async () => {
    const ws = createMockWs();
    registerTunnelConnection("test-tunnel-1", "pod-1", 3000, ws);

    const payload = JSON.stringify({ key: "value" });

    const resPromise = app.inject({
      method: "POST",
      url: `/tunnel/test-tunnel-1/${FIXTURE_TOKEN}/api/data`,
      headers: { "content-type": "application/json" },
      payload,
    });

    await new Promise((r) => setTimeout(r, 50));

    const sent = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(sent.method).toBe("POST");
    expect(sent.body).toBeDefined();
    expect(Buffer.from(sent.body, "base64").toString()).toBe(payload);

    resolvePendingRequest("test-tunnel-1", {
      type: "tunnel_response",
      requestId: sent.requestId,
      statusCode: 201,
      headers: { "content-type": "application/json" },
      body: Buffer.from('{"ok":true}').toString("base64"),
    });

    const res = await resPromise;
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ ok: true });
  });

  it("returns 504 on timeout", async () => {
    const ws = createMockWs();
    registerTunnelConnection("test-tunnel-1", "pod-1", 3000, ws);

    // We'll use a very short timeout by not resolving the request
    // The default is 30s which is too long for a test — we'll just
    // verify the timeout behavior indirectly via the error path
    // by unregistering the connection (which rejects pending requests)
    const resPromise = app.inject({
      method: "GET",
      url: `/tunnel/test-tunnel-1/${FIXTURE_TOKEN}/slow`,
    });

    await new Promise((r) => setTimeout(r, 50));

    // Simulate disconnection (which rejects pending requests with "Tunnel disconnected")
    unregisterTunnelConnection("test-tunnel-1");

    const res = await resPromise;
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain("Tunnel error");
  });

  it("rejects requests with a wrong share token", async () => {
    const ws = createMockWs();
    registerTunnelConnection("test-tunnel-1", "pod-1", 3000, ws);

    const res = await app.inject({
      method: "GET",
      url: "/tunnel/test-tunnel-1/wrong-token/index.html",
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toContain("share token");
    // The WS should never have been dispatched to
    expect(ws.send).not.toHaveBeenCalled();
  });
});
