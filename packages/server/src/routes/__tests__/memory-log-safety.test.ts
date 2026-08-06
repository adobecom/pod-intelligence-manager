import { Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MEMORY_CONTRACT_FIXTURES,
  type MemorySearchV1,
} from "@pim/shared";
import {
  createMemoryTestContext,
  type MemoryTestContext,
} from "./memory-test-app.js";

let context: MemoryTestContext;
const logChunks: string[] = [];

beforeAll(async () => {
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      logChunks.push(chunk.toString());
      callback();
    },
  });
  context = await createMemoryTestContext({
    logger: { level: "info", stream },
  });
});

afterAll(async () => {
  if (context) await context.app.close();
});

describe("memory API log safety", () => {
  it("does not log tokens, raw prompts, hidden reasoning, or evidence bodies", async () => {
    const suffix = randomUUID();
    const rawPrompt = `raw-prompt-${suffix}`;
    const hiddenReasoning = `hidden-reasoning-${suffix}`;
    const evidenceBody = `evidence-body-${suffix}`;
    const search = structuredClone(
      MEMORY_CONTRACT_FIXTURES.MemorySearchV1,
    ) as unknown as MemorySearchV1;
    search.request_id = `log-safety-search-${suffix}`;
    search.tenant.project_id = context.projectA;
    search.task.query = rawPrompt;

    const searched = await context.app.inject({
      method: "POST",
      url: "/api/v1/memory/search",
      headers: { authorization: `Bearer ${context.tokenA}` },
      payload: search,
    });
    expect(searched.statusCode, searched.body).toBe(200);

    const rejected = await context.app.inject({
      method: "PUT",
      url: `/api/v1/memory/run-receipts/log-safety-${suffix}`,
      headers: { authorization: `Bearer ${context.receiptTokenA}` },
      payload: {
        schema_version: "pim.run-receipt.v1",
        tenant: { project_id: context.projectA },
        raw_prompt: rawPrompt,
        hidden_reasoning: hiddenReasoning,
        evidence_body: evidenceBody,
      },
    });
    expect(rejected.statusCode).toBe(400);

    const serializedLogs = logChunks.join("");
    for (const sensitive of [
      context.tokenA,
      context.receiptTokenA,
      rawPrompt,
      hiddenReasoning,
      evidenceBody,
    ]) {
      expect(serializedLogs).not.toContain(sensitive);
    }
  });
});
