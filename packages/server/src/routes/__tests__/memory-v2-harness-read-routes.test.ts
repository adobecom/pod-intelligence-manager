import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canonicalJsonSha256,
  parseMemoryContractV2,
  type HarnessMemorySearchV2,
} from "@pim/shared";
import db from "../../db/connection.js";
import { importActiveHarnessMemoryRecord } from "../../services/memory-harness-records.js";
import { resolveMemoryV2Resource } from "../../services/memory-v2-resources.js";
import { ensureMemoryV2EvidenceVerifiedTrust } from "../../services/memory-v2-trust.js";
import { createMemoryTestContext, type MemoryTestContext } from "./memory-test-app.js";

let context: MemoryTestContext;
let recordId: string;
let counter = 0;
const fixedNow = "2026-08-10T12:00:00.000Z";

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function request(configurationDigests: string[] = []): HarnessMemorySearchV2 {
  const resource = resolveMemoryV2Resource({
    orgId: context.orgA.id,
    projectId: context.projectA,
    plane: "harness",
    canonicalResourceId: "example-harness-a",
  })!;
  return parseMemoryContractV2("HarnessMemorySearchV2", {
    schema_version: "pim.memory-search.v2",
    request_id: `slice4-http-${++counter}`,
    consumer: {
      harness_id: "example-harness-a",
      harness_version: "harness-v1",
      workflow_version: "code-change.v3",
      adapter_version: "example-harness-a-pim-adapter.v1",
      consumer_run_id: `slice4-http-consumer-${randomUUID()}`,
    },
    tenant: { project_id: context.projectA },
    plane: "harness",
    resource_selector: { resource_row_id: resource.resourceRowId },
    applicability: {
      plane: "harness",
      harness_id: "example-harness-a",
      harness_version_range: "harness-v1",
      workflow_version_range: "code-change.v3",
      adapter_version_range: "example-harness-a-pim-adapter.v1",
      configuration_ids: ["routing-default-v2"],
      configuration_digests: configurationDigests,
      model_ids: ["gpt-harness-a"],
      tool_ids: ["terminal-state-inspector"],
    },
    task: { query: "Inspect terminal tool state before retrying timeout", task_class: "recovery" },
    temporal: { mode: "current", valid_at: fixedNow, recorded_at: fixedNow },
    budget: { max_tokens: 1800, max_items: 8 },
    options: { include_explanations: true },
  });
}

beforeAll(async () => {
  context = await createMemoryTestContext({}, { v2Reads: true });
  const record = importActiveHarnessMemoryRecord({
    orgId: context.orgA.id,
    projectId: context.projectA,
    recordId: `slice4-http-record-${randomUUID()}`,
    kind: "test_strategy",
    content: {
      summary: "Inspect terminal tool state before retrying a timeout.",
      details: "Inspect the terminal state after an ambiguous timeout before retrying a side-effecting harness operation.",
      rationale: "This prevents duplicate effects when the first tool call actually completed.",
    },
    applicability: {
      harness_id: "example-harness-a",
      harness_version_range: "harness-v1",
      workflow_version_range: "code-change.v3",
      adapter_version_range: "example-harness-a-pim-adapter.v1",
      configuration_ids: ["routing-default-v2"],
      model_ids: ["gpt-harness-a"],
      tool_ids: ["terminal-state-inspector"],
    },
    exceptions: ["Do not retry if the terminal state cannot be established."],
    compatibility: {
      harness_version_range: "harness-v1",
      workflow_version_range: "code-change.v3",
      adapter_version_range: "example-harness-a-pim-adapter.v1",
    },
    validation: {
      strategy: "stable_failure_fingerprint",
      failure_fingerprint: "example-harness-a:http:terminal-state-unknown:v1",
    },
    evidence: [{
      evidence_ref_id: "slice4-http-failure",
      type: "failure",
      digest: canonicalJsonSha256({ failure: "http-terminal-state-unknown" }),
      origin_id: "example-harness-a:slice4:http:failure",
      source_authority: "observed",
    }],
    evidenceSummary: { strength: "observed", ref_count: 1 },
    freshness: { last_confirmed_at: fixedNow, expires_at: "2027-08-10T12:00:00.000Z" },
    provenance: { extractor_version: "slice4-http.v1" },
    actorId: "slice4-http-reviewer",
    decisionRefs: ["slice4-http-decision"],
    reasonCode: "authorized_harness_failure_reviewed",
    explanation: "The harness lesson was approved for retrieval.",
    now: fixedNow,
  });
  recordId = record.recordId;
  ensureMemoryV2EvidenceVerifiedTrust({
    recordId: record.recordId,
    recordVersion: record.recordVersion,
    orgId: context.orgA.id,
    projectId: context.projectA,
    evidenceVerifiedAt: record.freshness.last_confirmed_at,
    now: fixedNow,
  });
});

afterAll(async () => {
  if (context) await context.app.close();
});

describe("Slice 4 harness v2 canonical HTTP surface", () => {
  it("searches the exact harness, writes a v2 pack, and serves immutable detail", async () => {
    const input = request();
    const response = await context.app.inject({
      method: "POST",
      url: "/api/v2/memory/search",
      headers: auth(context.harnessSearchTokenA),
      payload: input,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers.vary).toBe("Authorization");
    const result = parseMemoryContractV2("MemorySearchResultV2", response.json());
    expect(result).toMatchObject({
      plane: "harness",
    });
    expect(result.items.map((item) => item.record_id)).toContain(recordId);
    expect(db.prepare(
      `SELECT plane FROM memory_v2_retrieval_packs
       WHERE retrieval_pack_id = ?`,
    ).get(result.retrieval_pack_id)).toEqual({ plane: "harness" });
    expect(db.prepare(
      "SELECT 1 FROM memory_retrieval_packs WHERE request_id = ?",
    ).get(input.request_id)).toBeUndefined();

    const detail = await context.app.inject({
      method: "GET",
      url: `/api/v2/memory/records/${encodeURIComponent(recordId)}?version=1`,
      headers: auth(context.harnessSearchTokenA),
    });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(parseMemoryContractV2("MemoryRecordV2", detail.json())).toMatchObject({
      record_id: recordId,
      plane: "harness",
      subkind: "verification_sequence",
    });
  });

  it("returns an empty pack for configuration digests current storage cannot prove", async () => {
    const response = await context.app.inject({
      method: "POST",
      url: "/api/v2/memory/search",
      headers: auth(context.harnessSearchTokenA),
      payload: request([canonicalJsonSha256({ configuration: "routing-default-v2" })]),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      plane: "harness",
      items: [],
      token_count: 0,
    });
  });

  it("does not reveal record existence across codebase and harness bindings", async () => {
    const missingRecordId = `slice4-http-missing-${randomUUID()}`;
    const pairs = [
      { token: context.tokenA, existingRecordId: recordId },
      { token: context.harnessSearchTokenA, existingRecordId: context.seededRecordId },
    ];
    for (const pair of pairs) {
      const responses = await Promise.all([
        pair.existingRecordId,
        missingRecordId,
      ].map((selectedRecordId) => context.app.inject({
        method: "GET",
        url: `/api/v2/memory/records/${encodeURIComponent(selectedRecordId)}?version=1`,
        headers: auth(pair.token),
      })));
      const failures = responses.map((response) => {
        expect(response.statusCode, response.body).toBe(404);
        const error = parseMemoryContractV2("PimErrorV2", response.json());
        return {
          code: error.code,
          message: error.message,
          plane: error.plane,
          retryable: error.retryable,
          details: error.details,
        };
      });
      expect(failures[0]).toEqual(failures[1]);
      expect(failures[0]).toEqual({
        code: "resource_not_found",
        message: "Memory record is unavailable",
        plane: null,
        retryable: false,
        details: [],
      });
    }
  });

  it("rejects code-only and example-harness-b principals without a v2 pack effect", async () => {
    const input = request();
    const before = db.prepare(
      "SELECT COUNT(*) AS count FROM memory_v2_retrieval_packs",
    ).get();
    for (const token of [context.tokenA, context.otherHarnessSearchTokenA]) {
      const response = await context.app.inject({
        method: "POST",
        url: "/api/v2/memory/search",
        headers: auth(token),
        payload: input,
      });
      expect(response.statusCode, response.body).toBe(404);
      expect(response.json()).toMatchObject({ retryable: false });
    }
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM memory_v2_retrieval_packs",
    ).get()).toEqual(before);
  });
});
