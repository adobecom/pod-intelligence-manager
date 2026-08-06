import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MEMORY_CONTRACT_FIXTURES, type MemorySearchV1 } from "@pim/shared";
import { PimMemoryClient } from "../../../../sdk/src/memory-client.js";
import { createMemoryTestContext, type MemoryTestContext } from "./memory-test-app.js";

let context: MemoryTestContext;
let client: PimMemoryClient;

beforeAll(async () => {
  context = await createMemoryTestContext();
  const baseUrl = await context.app.listen({ host: "127.0.0.1", port: 0 });
  client = new PimMemoryClient({ baseUrl, authToken: context.tokenA });
});

afterAll(async () => {
  if (context) await context.app.close();
});

describe("live generated-client Slice 1 contract", () => {
  it("negotiates, searches a seeded record, replays its pack, and expands the immutable detail", async () => {
    const capabilities = await client.capabilities();
    expect(capabilities.planes).toEqual(["codebase", "harness"]);

    const fixture = structuredClone(MEMORY_CONTRACT_FIXTURES.MemorySearchV1) as unknown as MemorySearchV1;
    const request: MemorySearchV1 = {
      ...fixture,
      request_id: "live-generated-client-search-1",
      tenant: { project_id: context.projectA },
    };
    const result = await client.search(request);
    expect(result.items[0]?.record_id).toBe(context.seededRecordId);
    expect((await client.search(request)).retrieval_pack_id).toBe(result.retrieval_pack_id);

    const detail = await client.getRecord(result.items[0].record_id, result.items[0].record_version);
    expect(detail.record_id).toBe(context.seededRecordId);
    expect(detail.record_version).toBe(1);
  });
});
