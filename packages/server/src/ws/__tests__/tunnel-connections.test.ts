import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock db before importing the module under test
vi.mock("../../db/connection.js", () => ({
  default: {
    prepare: vi.fn().mockReturnValue({
      run: vi.fn(),
      get: vi.fn(),
    }),
  },
}));

vi.mock("../index.js", () => ({
  broadcast: vi.fn(),
}));

import {
  registerTunnelConnection,
  unregisterTunnelConnection,
  getTunnelConnection,
  hasTunnelConnection,
  addPendingRequest,
  resolvePendingRequest,
  handleResponseChunk,
  markTunnelTraffic,
} from "../tunnel-connections.js";
import type { TunnelResponse, TunnelResponseChunk } from "@pim/shared";

function createMockWs() {
  return {
    readyState: 1, // OPEN
    OPEN: 1,
    send: vi.fn(),
    close: vi.fn(),
    on: vi.fn(),
    terminate: vi.fn(),
  } as unknown as import("ws").WebSocket;
}

describe("tunnel-connections", () => {
  beforeEach(() => {
    // Clean up any leftover connections
    for (const id of ["test-1", "test-2", "test-3"]) {
      unregisterTunnelConnection(id);
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("registerTunnelConnection / getTunnelConnection", () => {
    it("registers and retrieves a connection", () => {
      const ws = createMockWs();
      registerTunnelConnection("test-1", "pod-1", 3000, ws);

      expect(hasTunnelConnection("test-1")).toBe(true);
      const conn = getTunnelConnection("test-1");
      expect(conn).toBeDefined();
      expect(conn!.tunnelId).toBe("test-1");
      expect(conn!.podId).toBe("pod-1");
      expect(conn!.ws).toBe(ws);
    });

    it("returns undefined for unknown tunnel", () => {
      expect(getTunnelConnection("nonexistent")).toBeUndefined();
      expect(hasTunnelConnection("nonexistent")).toBe(false);
    });
  });

  describe("unregisterTunnelConnection", () => {
    it("removes the connection", () => {
      const ws = createMockWs();
      registerTunnelConnection("test-1", "pod-1", 3000, ws);
      unregisterTunnelConnection("test-1");

      expect(hasTunnelConnection("test-1")).toBe(false);
    });

    it("rejects pending requests on unregister", async () => {
      const ws = createMockWs();
      registerTunnelConnection("test-1", "pod-1", 3000, ws);

      const promise = addPendingRequest("test-1", "req-1", 5000);
      unregisterTunnelConnection("test-1");

      await expect(promise).rejects.toThrow("Tunnel disconnected");
    });

    it("is a no-op for unknown tunnel", () => {
      // Should not throw
      unregisterTunnelConnection("nonexistent");
    });
  });

  describe("addPendingRequest / resolvePendingRequest", () => {
    it("resolves when a matching response arrives", async () => {
      const ws = createMockWs();
      registerTunnelConnection("test-1", "pod-1", 3000, ws);

      const promise = addPendingRequest("test-1", "req-1", 5000);

      const response: TunnelResponse = {
        type: "tunnel_response",
        requestId: "req-1",
        statusCode: 200,
        headers: { "content-type": "text/html" },
        body: Buffer.from("<h1>Hello</h1>").toString("base64"),
      };

      resolvePendingRequest("test-1", response);

      const result = await promise;
      expect(result.statusCode).toBe(200);
      expect(result.headers["content-type"]).toBe("text/html");
      expect(Buffer.from(result.body!, "base64").toString()).toBe("<h1>Hello</h1>");
    });

    it("rejects with timeout", async () => {
      const ws = createMockWs();
      registerTunnelConnection("test-1", "pod-1", 3000, ws);

      const promise = addPendingRequest("test-1", "req-timeout", 50);

      await expect(promise).rejects.toThrow("Tunnel request timeout");
    });

    it("rejects if tunnel not connected", async () => {
      await expect(addPendingRequest("nonexistent", "req-1", 5000)).rejects.toThrow(
        "Tunnel not connected",
      );
    });

    it("ignores response for unknown requestId", () => {
      const ws = createMockWs();
      registerTunnelConnection("test-1", "pod-1", 3000, ws);

      // Should not throw
      resolvePendingRequest("test-1", {
        type: "tunnel_response",
        requestId: "unknown",
        statusCode: 200,
        headers: {},
        body: null,
      });
    });
  });

  describe("handleResponseChunk", () => {
    it("assembles chunked response and resolves", async () => {
      const ws = createMockWs();
      registerTunnelConnection("test-1", "pod-1", 3000, ws);

      const promise = addPendingRequest("test-1", "req-chunked", 5000);

      const chunk1 = Buffer.from("Hello ");
      const chunk2 = Buffer.from("World");

      handleResponseChunk("test-1", {
        type: "tunnel_response_chunk",
        requestId: "req-chunked",
        statusCode: 200,
        headers: { "content-type": "text/plain" },
        chunk: chunk1.toString("base64"),
        done: false,
      });

      handleResponseChunk("test-1", {
        type: "tunnel_response_chunk",
        requestId: "req-chunked",
        chunk: chunk2.toString("base64"),
        done: true,
      });

      const result = await promise;
      expect(result.statusCode).toBe(200);
      expect(Buffer.from(result.body!, "base64").toString()).toBe("Hello World");
    });
  });

  describe("markTunnelTraffic", () => {
    it("updates lastTraffic timestamp", () => {
      const ws = createMockWs();
      registerTunnelConnection("test-1", "pod-1", 3000, ws);

      const before = getTunnelConnection("test-1")!.lastTraffic;
      // Small delay to ensure Date.now() advances
      markTunnelTraffic("test-1");
      const after = getTunnelConnection("test-1")!.lastTraffic;

      expect(after).toBeGreaterThanOrEqual(before);
    });

    it("is a no-op for unknown tunnel", () => {
      // Should not throw
      markTunnelTraffic("nonexistent");
    });
  });
});
