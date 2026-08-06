import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseMemoryContract } from "@pim/shared";
import memoryCapabilitiesRoutes from "../memory-capabilities.js";

const app = Fastify();
let baseUrl = "";

beforeAll(async () => {
  await app.register(memoryCapabilitiesRoutes);
  baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
});

afterAll(async () => {
  await app.close();
});

describe("live memory capability negotiation", () => {
  it("negotiates the generated v1 contract against an actual HTTP listener", async () => {
    const response = await fetch(`${baseUrl}/api/v1/memory/capabilities`);
    expect(response.status).toBe(200);
    const capabilities = parseMemoryContract("MemoryCapabilitiesV1", await response.json());
    expect(capabilities.planes).toEqual(["codebase", "harness"]);
    expect(capabilities.temporal_modes).toEqual(["current"]);
    expect(capabilities.supported_schemas.requests).toContain("pim.memory-search.v1");
    expect(capabilities.supported_schemas.requests).toContain("pim.memory-harness-search.v1");
    expect(capabilities.supported_schemas.responses).toContain("pim.memory-harness-search-result.v1");
  });
});
