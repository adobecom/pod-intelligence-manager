import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { parseMemoryContractV2 } from "@pim/shared";
import { registerMemoryV2AvailabilityGuard } from "../../middleware/memory-v2-availability.js";
import { registerJsonBodyParser } from "../../middleware/validation.js";
import {
  markMemoryV2Ready,
  markMemoryV2Unavailable,
} from "../../services/memory-v2-availability.js";
import memoryMcpRoutes from "../memory-mcp.js";
import memoryV2BindingRoutes from "../memory-v2-binding.js";
import memoryV2CapabilitiesRoutes from "../memory-v2-capabilities.js";
import memoryV2ReadinessRoutes from "../memory-v2-readiness.js";
import memoryV2SearchRoutes from "../memory-v2-search.js";
import memoryV2WriteRoutes from "../memory-v2-write.js";

afterEach(() => {
  markMemoryV2Ready();
});

async function availabilityApp() {
  const app = Fastify();
  registerJsonBodyParser(app);
  registerMemoryV2AvailabilityGuard(app);
  app.get("/api/v1/memory/capabilities", async () => ({ status: "v1-ok" }));
  app.get("/api/pods", async () => ({ status: "pods-ok" }));
  app.get("/api/skill-catalog/conflicts", async () => ({ status: "skills-ok" }));
  await app.register(memoryV2BindingRoutes);
  await app.register(memoryV2CapabilitiesRoutes);
  await app.register(memoryV2ReadinessRoutes);
  await app.register(memoryV2SearchRoutes);
  await app.register(memoryV2WriteRoutes);
  await app.register(memoryMcpRoutes);
  await app.ready();
  return app;
}

describe("memory v2 unavailable route gating", () => {
  it("returns one typed 503 across every v2 HTTPS route while non-v2 routes continue", async () => {
    markMemoryV2Unavailable(
      "reconciliation_failed",
      new Date("2026-08-10T19:00:00.000Z"),
    );
    const app = await availabilityApp();
    try {
      const requests = [
        { method: "GET", url: "/api/v2/memory/capabilities" },
        { method: "GET", url: "/api/v2/memory/binding" },
        { method: "GET", url: "/api/v2/memory/readiness" },
        { method: "POST", url: "/api/v2/memory/search", payload: {} },
        { method: "GET", url: "/api/v2/memory/records/record-v2" },
        { method: "GET", url: "/api/v2/memory/records/record-v2/history" },
        { method: "GET", url: "/api/v2/memory/packs/pack-v2" },
        { method: "PUT", url: "/api/v2/memory/run-receipts/run-v2", payload: {} },
        { method: "POST", url: "/api/v2/memory/feedback", payload: {} },
        { method: "GET", url: "/api/v2/memory/candidates/candidate-v2" },
        { method: "POST", url: "/api/v2/memory/candidates/candidate-v2/decisions", payload: {} },
      ] as const;
      for (const request of requests) {
        const response = await app.inject(request);
        expect(response.statusCode, `${request.method} ${request.url}: ${response.body}`).toBe(503);
        expect(parseMemoryContractV2("PimErrorV2", response.json())).toMatchObject({
          code: "temporarily_unavailable",
          retryable: true,
          details: [
            { path: "/availability/reason", reason: "reconciliation_failed" },
            { path: "/availability/changed_at", reason: "2026-08-10T19:00:00.000Z" },
          ],
        });
      }

      for (const url of [
        "/api/v1/memory/capabilities",
        "/api/pods",
        "/api/skill-catalog/conflicts",
      ]) {
        const response = await app.inject({ method: "GET", url });
        expect(response.statusCode, response.body).toBe(200);
      }
    } finally {
      await app.close();
    }
  });

  it("returns a typed MCP 503 before authentication or v2 storage access", async () => {
    markMemoryV2Unavailable(
      "migration_failed",
      new Date("2026-08-10T20:00:00.000Z"),
    );
    const app = await availabilityApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/mcp/memory",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "mcp-protocol-version": "2026-07-28",
        },
        payload: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "pim_memory_capabilities",
            arguments: {},
          },
        },
      });
      expect(response.statusCode, response.body).toBe(503);
      const body = response.json();
      expect(body).toMatchObject({
        jsonrpc: "2.0",
        error: { code: -32603 },
        id: null,
      });
      expect(parseMemoryContractV2("PimErrorV2", body.error.data)).toMatchObject({
        code: "temporarily_unavailable",
        retryable: true,
        details: [
          { path: "/availability/reason", reason: "migration_failed" },
          { path: "/availability/changed_at", reason: "2026-08-10T20:00:00.000Z" },
        ],
      });
      expect(response.headers["cache-control"]).toBe("private, no-store");
    } finally {
      await app.close();
    }
  });

  it("allows v2 routes again after startup reaches ready", async () => {
    markMemoryV2Ready(new Date("2026-08-10T21:00:00.000Z"));
    const app = await availabilityApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v2/memory/capabilities",
      });
      expect(response.statusCode, response.body).toBe(200);
    } finally {
      await app.close();
    }
  });
});
