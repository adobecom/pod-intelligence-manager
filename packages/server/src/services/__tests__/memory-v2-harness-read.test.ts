import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canonicalJsonSha256,
  MEMORY_CONTRACT_FIXTURES_V2,
  parseMemoryContractV2,
  type CodebaseMemorySearchV2,
  type HarnessMemorySearchV2,
  type MemoryHarnessSearchV1,
} from "@pim/shared";
import db from "../../db/connection.js";
import {
  getHarnessMemoryRecord,
  importActiveHarnessMemoryRecord,
  type HarnessMemoryRecord,
} from "../memory-harness-records.js";
import { resolveMemoryHarnessPrincipalBinding } from "../memory-harness-bindings.js";
import { executeHarnessMemorySearch } from "../memory-harness-search.js";
import {
  getHarnessMemoryPackV2,
  getHarnessMemoryRecordV2,
  searchHarnessMemoryV2,
} from "../memory-v2-harness-read.js";
import { searchCodeMemoryV2 } from "../memory-v2-code-read.js";
import {
  getMemoryPackV2,
  getMemoryRecordV2,
} from "../memory-v2-read-dispatch.js";
import { resolveMemoryV2Resource } from "../memory-v2-resources.js";
import {
  ensureMemoryV2EvidenceVerifiedTrust,
  getMemoryV2RecordTrust,
} from "../memory-v2-trust.js";
import {
  verifyMemoryV2ServiceToken,
  type MemoryV2RequestAuthorizationSnapshot,
} from "../service-tokens.js";
import {
  createMemoryTestContext,
  type MemoryTestContext,
} from "../../routes/__tests__/memory-test-app.js";

let context: MemoryTestContext;
let principal: MemoryV2RequestAuthorizationSnapshot;
let harnessRecord: HarnessMemoryRecord;
let requestCounter = 0;
const now = "2026-08-10T12:00:00.000Z";

function v2Request(input: {
  requestId?: string;
  configurationDigests?: string[];
  harnessId?: string;
  resourceSelector?: HarnessMemorySearchV2["resource_selector"];
} = {}): HarnessMemorySearchV2 {
  const harnessId = input.harnessId ?? "example-harness-a";
  const resource = resolveMemoryV2Resource({
    orgId: context.orgA.id,
    projectId: context.projectA,
    plane: "harness",
    canonicalResourceId: harnessId,
  });
  return parseMemoryContractV2("HarnessMemorySearchV2", {
    schema_version: "pim.memory-search.v2",
    request_id: input.requestId ?? `slice4-harness-${++requestCounter}`,
    consumer: {
      harness_id: harnessId,
      harness_version: "harness-shadow-v1",
      workflow_version: "code-change.v3",
      adapter_version: "example-harness-a-pim-adapter.v1",
      consumer_run_id: `slice4-consumer-${randomUUID()}`,
    },
    tenant: { project_id: context.projectA },
    plane: "harness",
    resource_selector: Object.prototype.hasOwnProperty.call(input, "resourceSelector")
      ? input.resourceSelector!
      : resource ? { resource_row_id: resource.resourceRowId } : null,
    applicability: {
      plane: "harness",
      harness_id: harnessId,
      harness_version_range: "harness-shadow-v1",
      workflow_version_range: "code-change.v3",
      adapter_version_range: "example-harness-a-pim-adapter.v1",
      configuration_ids: ["routing-default-v2"],
      configuration_digests: input.configurationDigests ?? [],
      model_ids: ["gpt-harness-shadow"],
      tool_ids: ["terminal-state-inspector"],
    },
    task: {
      query: "Inspect terminal tool state before retrying timeout",
      task_class: "recovery",
    },
    temporal: { mode: "current", valid_at: now, recorded_at: now },
    budget: { max_tokens: 1800, max_items: 8 },
    options: { include_explanations: true },
  });
}

function codeV2Request(requestId: string): CodebaseMemorySearchV2 {
  const fixture = structuredClone(
    MEMORY_CONTRACT_FIXTURES_V2.MemorySearchV2,
  ) as unknown as CodebaseMemorySearchV2;
  return {
    ...fixture,
    request_id: requestId,
    tenant: { project_id: context.projectA },
    resource_selector: { canonical_resource_id: "github.com/acme/checkout" },
    applicability: {
      ...fixture.applicability,
      repository_id: "github.com/acme/checkout",
    },
  };
}

function readErrorShape(read: () => unknown): {
  code: unknown;
  statusCode: unknown;
  message: unknown;
  plane: unknown;
  details: unknown;
} {
  try {
    read();
  } catch (error) {
    const failure = error as {
      code?: unknown;
      statusCode?: unknown;
      message?: unknown;
      plane?: unknown;
      details?: unknown;
    };
    return {
      code: failure.code,
      statusCode: failure.statusCode,
      message: failure.message,
      plane: failure.plane,
      details: failure.details,
    };
  }
  throw new Error("Memory read unexpectedly succeeded");
}

function toV1(request: HarnessMemorySearchV2, requestId: string): MemoryHarnessSearchV1 {
  return {
    schema_version: "pim.memory-harness-search.v1",
    request_id: requestId,
    consumer: request.consumer,
    tenant: request.tenant,
    plane: "harness",
    applicability: {
      harness_id: request.applicability.harness_id,
      harness_version_range: request.applicability.harness_version_range,
      workflow_version_range: request.applicability.workflow_version_range,
      adapter_version_range: request.applicability.adapter_version_range,
      configuration_ids: request.applicability.configuration_ids,
      model_ids: request.applicability.model_ids,
      tool_ids: request.applicability.tool_ids,
    },
    task: request.task,
    temporal: request.temporal,
    budget: request.budget,
    options: request.options,
  } as MemoryHarnessSearchV1;
}

beforeAll(async () => {
  context = await createMemoryTestContext();
  principal = verifyMemoryV2ServiceToken(context.harnessSearchTokenA)!.authorization;
  harnessRecord = importActiveHarnessMemoryRecord({
    orgId: context.orgA.id,
    projectId: context.projectA,
    recordId: `slice4-record-${randomUUID()}`,
    kind: "test_strategy",
    content: {
      summary: "Inspect terminal tool state before retrying a timeout.",
      details: "When a tool call times out, inspect its terminal state before deciding whether a side-effecting retry is safe.",
      rationale: "This avoids repeating an operation whose first invocation may already have succeeded.",
    },
    applicability: {
      harness_id: "example-harness-a",
      harness_version_range: "harness-shadow-v1",
      workflow_version_range: "code-change.v3",
      adapter_version_range: "example-harness-a-pim-adapter.v1",
      configuration_ids: ["routing-default-v2"],
      model_ids: ["gpt-harness-shadow"],
      tool_ids: ["terminal-state-inspector"],
    },
    exceptions: ["Do not retry when the terminal state cannot be inspected."],
    compatibility: {
      harness_version_range: "harness-shadow-v1",
      workflow_version_range: "code-change.v3",
      adapter_version_range: "example-harness-a-pim-adapter.v1",
    },
    validation: {
      strategy: "stable_failure_fingerprint",
      failure_fingerprint: "example-harness-a:tool-timeout:terminal-state-unknown:v1",
    },
    evidence: [{
      evidence_ref_id: "slice4-failure-ref",
      type: "failure",
      digest: canonicalJsonSha256({ failure: "terminal-state-unknown" }),
      origin_id: "example-harness-a:slice4:failure",
      source_authority: "observed",
    }],
    evidenceSummary: { strength: "observed", ref_count: 1 },
    freshness: { last_confirmed_at: now, expires_at: "2027-08-10T12:00:00.000Z" },
    provenance: { extractor_version: "slice4-test.v1" },
    actorId: "slice4-test-reviewer",
    decisionRefs: ["slice4-decision"],
    reasonCode: "authorized_harness_failure_reviewed",
    explanation: "The bounded harness lesson was reviewed for shadow retrieval.",
    now,
  });
  ensureMemoryV2EvidenceVerifiedTrust({
    recordId: harnessRecord.recordId,
    recordVersion: harnessRecord.recordVersion,
    orgId: context.orgA.id,
    projectId: context.projectA,
    evidenceVerifiedAt: harnessRecord.freshness.last_confirmed_at,
    now,
  });
});

afterAll(async () => {
  if (context) await context.app.close();
});

describe("Slice 4 harness v2 read service", () => {
  it("reuses v1 ranking and atomically persists an immutable v2 pack", async () => {
    const request = v2Request();
    const binding = resolveMemoryHarnessPrincipalBinding({
      servicePrincipalId: principal.servicePrincipalId,
      orgId: principal.orgId,
      projectId: context.projectA,
      harnessId: "example-harness-a",
    })!;
    const v1 = executeHarnessMemorySearch({
      orgId: principal.orgId,
      projectId: context.projectA,
      principalId: principal.servicePrincipalId,
      binding,
      request: toV1(request, `${request.request_id}-v1`),
      now: new Date(now),
    });
    const v2 = await searchHarnessMemoryV2({
      principal,
      request,
      dependencies: { now: () => new Date(now) },
    });

    expect(v2).toMatchObject({
      plane: "harness",
      token_count: v1.token_count,
      omitted_count: v1.omitted_count,
    });
    expect(v2.items.map((item) => ({
      recordId: item.record_id,
      version: item.record_version,
      reasons: item.match_reasons,
    }))).toEqual(v1.items.map((item) => ({
      recordId: item.record_id,
      version: item.record_version,
      reasons: item.match_reasons,
    })));
    expect(v2.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        record_id: harnessRecord.recordId,
        subkind: "verification_sequence",
      }),
    ]));
    expect(db.prepare(
      "SELECT 1 FROM memory_retrieval_packs WHERE request_id = ?",
    ).get(request.request_id)).toBeUndefined();
    expect(db.prepare(
      `SELECT plane FROM memory_v2_retrieval_packs
       WHERE retrieval_pack_id = ?`,
    ).get(v2.retrieval_pack_id)).toEqual({ plane: "harness" });

    expect(getHarnessMemoryRecordV2({
      principal,
      recordId: harnessRecord.recordId,
      recordVersion: harnessRecord.recordVersion,
    })).toMatchObject({
      plane: "harness",
      subkind: "verification_sequence",
    });
    expect(getHarnessMemoryPackV2({
      principal,
      packId: v2.retrieval_pack_id,
      now,
    })).toMatchObject({
      plane: "harness",
      retrieval_pack_id: v2.retrieval_pack_id,
    });

    expect(await searchHarnessMemoryV2({
      principal,
      request,
      dependencies: { now: () => new Date(now) },
    })).toEqual(v2);
    await expect(searchHarnessMemoryV2({
      principal,
      request: { ...request, task: { ...request.task, query: "changed request" } },
    })).rejects.toMatchObject({ code: "idempotency_conflict", statusCode: 409 });
  });

  it("returns an empty v2 pack for an unprovable configuration digest", async () => {
    const result = await searchHarnessMemoryV2({
      principal,
      request: v2Request({
        configurationDigests: [canonicalJsonSha256({ configuration: "routing-default-v2" })],
      }),
      dependencies: { now: () => new Date(now) },
    });
    expect(result).toMatchObject({
      plane: "harness",
      items: [],
      token_count: 0,
    });
    expect(db.prepare(
      "SELECT plane FROM memory_v2_retrieval_packs WHERE retrieval_pack_id = ?",
    ).get(result.retrieval_pack_id)).toEqual({ plane: "harness" });
  });

  it("shares the v2 search request-id namespace with codebase search in both directions", async () => {
    const codePrincipal = verifyMemoryV2ServiceToken(context.tokenA)!.authorization;
    const codeFirstRequestId = `slice4-code-first-${randomUUID()}`;
    const codeFirst = await searchCodeMemoryV2({
      principal: codePrincipal,
      request: codeV2Request(codeFirstRequestId),
    });
    await expect(searchHarnessMemoryV2({
      principal,
      request: v2Request({ requestId: codeFirstRequestId }),
    })).rejects.toMatchObject({ code: "idempotency_conflict", statusCode: 409 });
    expect(db.prepare(
      `SELECT operation, COUNT(*) AS count FROM memory_idempotency_keys
       WHERE org_id = ? AND project_id = ? AND idempotency_key = ?
       GROUP BY operation`,
    ).get(context.orgA.id, context.projectA, codeFirstRequestId)).toEqual({
      operation: "memory_search_v2",
      count: 1,
    });
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM memory_v2_retrieval_packs WHERE request_id = ?",
    ).get(codeFirstRequestId)).toEqual({ count: 1 });
    expect(codeFirst.plane).toBe("codebase");

    const harnessFirstRequestId = `slice4-harness-first-${randomUUID()}`;
    const harnessFirst = await searchHarnessMemoryV2({
      principal,
      request: v2Request({ requestId: harnessFirstRequestId }),
      dependencies: { now: () => new Date(now) },
    });
    await expect(searchCodeMemoryV2({
      principal: codePrincipal,
      request: codeV2Request(harnessFirstRequestId),
    })).rejects.toMatchObject({ code: "idempotency_conflict", statusCode: 409 });
    expect(db.prepare(
      `SELECT operation, COUNT(*) AS count FROM memory_idempotency_keys
       WHERE org_id = ? AND project_id = ? AND idempotency_key = ?
       GROUP BY operation`,
    ).get(context.orgA.id, context.projectA, harnessFirstRequestId)).toEqual({
      operation: "memory_search_v2",
      count: 1,
    });
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM memory_v2_retrieval_packs WHERE request_id = ?",
    ).get(harnessFirstRequestId)).toEqual({ count: 1 });
    expect(harnessFirst.plane).toBe("harness");
  });

  it("resolves generic record and pack IDs only after effective read authorization", async () => {
    const codePrincipal = verifyMemoryV2ServiceToken(context.tokenA)!.authorization;
    const harnessPrincipal = principal;
    const noReadScopePrincipal = verifyMemoryV2ServiceToken(context.harnessReviewerTokenA)!.authorization;
    const harnessPack = await searchHarnessMemoryV2({
      principal: harnessPrincipal,
      request: v2Request({ requestId: `slice4-dispatch-harness-${randomUUID()}` }),
      dependencies: { now: () => new Date(now) },
    });
    const codePack = await searchCodeMemoryV2({
      principal: codePrincipal,
      request: codeV2Request(`slice4-dispatch-code-${randomUUID()}`),
    });
    const missingRecordId = `slice4-missing-record-${randomUUID()}`;
    const missingPackId = `v2pack_missing_${randomUUID()}`;

    const unavailableRecord = {
      code: "resource_not_found",
      statusCode: 404,
      message: "Memory record is unavailable",
      plane: undefined,
      details: [],
    };
    expect(readErrorShape(() => getMemoryRecordV2({
      principal: codePrincipal,
      recordId: harnessRecord.recordId,
      recordVersion: harnessRecord.recordVersion,
    }))).toEqual(unavailableRecord);
    expect(readErrorShape(() => getMemoryRecordV2({
      principal: codePrincipal,
      recordId: missingRecordId,
      recordVersion: 1,
    }))).toEqual(unavailableRecord);
    expect(readErrorShape(() => getMemoryRecordV2({
      principal: harnessPrincipal,
      recordId: context.seededRecordId,
      recordVersion: 1,
    }))).toEqual(unavailableRecord);
    expect(readErrorShape(() => getMemoryRecordV2({
      principal: harnessPrincipal,
      recordId: missingRecordId,
      recordVersion: 1,
    }))).toEqual(unavailableRecord);

    const unavailablePack = {
      code: "resource_not_found",
      statusCode: 404,
      message: "Memory retrieval pack is unavailable",
      plane: undefined,
      details: [],
    };
    expect(readErrorShape(() => getMemoryPackV2({
      principal: codePrincipal,
      packId: harnessPack.retrieval_pack_id,
      now,
    }))).toEqual(unavailablePack);
    expect(readErrorShape(() => getMemoryPackV2({
      principal: codePrincipal,
      packId: missingPackId,
      now,
    }))).toEqual(unavailablePack);
    expect(readErrorShape(() => getMemoryPackV2({
      principal: harnessPrincipal,
      packId: codePack.retrieval_pack_id,
      now,
    }))).toEqual(unavailablePack);
    expect(readErrorShape(() => getMemoryPackV2({
      principal: harnessPrincipal,
      packId: missingPackId,
      now,
    }))).toEqual(unavailablePack);

    const scopeFailure = {
      code: "scope_required",
      statusCode: 403,
      message: "The required memory read scope is not authorized",
      plane: undefined,
      details: [],
    };
    expect(readErrorShape(() => getMemoryRecordV2({
      principal: noReadScopePrincipal,
      recordId: harnessRecord.recordId,
      recordVersion: harnessRecord.recordVersion,
    }))).toEqual(scopeFailure);
    expect(readErrorShape(() => getMemoryRecordV2({
      principal: noReadScopePrincipal,
      recordId: missingRecordId,
      recordVersion: 1,
    }))).toEqual(scopeFailure);
    expect(readErrorShape(() => getMemoryPackV2({
      principal: noReadScopePrincipal,
      packId: harnessPack.retrieval_pack_id,
      now,
    }))).toEqual(scopeFailure);
    expect(readErrorShape(() => getMemoryPackV2({
      principal: noReadScopePrincipal,
      packId: missingPackId,
      now,
    }))).toEqual(scopeFailure);

    const codeFacet = db.prepare(
      `SELECT * FROM memory_v2_record_facets
       WHERE record_id = ? AND record_version = 1`,
    ).get(context.seededRecordId) as Record<string, unknown>;
    const codeTrust = getMemoryV2RecordTrust(context.seededRecordId, 1)!;
    try {
      db.prepare(
        "DELETE FROM memory_v2_record_facets WHERE record_id = ? AND record_version = 1",
      ).run(context.seededRecordId);
      expect(readErrorShape(() => getMemoryRecordV2({
        principal: codePrincipal,
        recordId: context.seededRecordId,
        recordVersion: 1,
      }))).toEqual({
        code: "temporarily_unavailable",
        statusCode: 503,
        message: "Memory service is temporarily unavailable",
        plane: "codebase",
        details: [],
      });
    } finally {
      db.prepare(
        `INSERT INTO memory_v2_record_facets
           (record_id, record_version, org_id, project_id, plane, resource_row_id,
            broad_kind, subtype, projection_status, facet_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        codeFacet.record_id as string,
        codeFacet.record_version as number,
        codeFacet.org_id as string,
        codeFacet.project_id as string,
        codeFacet.plane as string,
        codeFacet.resource_row_id as string,
        codeFacet.broad_kind as string,
        codeFacet.subtype as string | null,
        codeFacet.projection_status as string,
        codeFacet.facet_json as string,
        codeFacet.created_at as string,
      );
      ensureMemoryV2EvidenceVerifiedTrust({
        recordId: context.seededRecordId,
        recordVersion: 1,
        orgId: context.orgA.id,
        projectId: context.projectA,
        evidenceVerifiedAt: codeTrust.evidenceVerifiedAt!,
      });
    }
  });

  it("rejects unbound selectors uniformly before resource lookup or a pack effect", async () => {
    const harnessResource = resolveMemoryV2Resource({
      orgId: context.orgA.id,
      projectId: context.projectA,
      plane: "harness",
      canonicalResourceId: "example-harness-a",
    })!;
    const codeResource = resolveMemoryV2Resource({
      orgId: context.orgA.id,
      projectId: context.projectA,
      plane: "codebase",
      canonicalResourceId: "github.com/acme/checkout",
    })!;
    const selectors: HarnessMemorySearchV2["resource_selector"][] = [
      { resource_row_id: harnessResource.resourceRowId },
      { resource_row_id: `v2res_harness:${randomUUID()}` },
      { resource_row_id: codeResource.resourceRowId },
      { canonical_resource_id: harnessResource.canonicalResourceId },
      { canonical_resource_id: `missing-harness-${randomUUID()}` },
    ];
    const before = db.prepare(
      "SELECT COUNT(*) AS count FROM memory_v2_retrieval_packs",
    ).get();
    const noHarnessScope = verifyMemoryV2ServiceToken(context.tokenA)!.authorization;
    const unboundHarness = verifyMemoryV2ServiceToken(context.otherHarnessSearchTokenA)!.authorization;
    const attempts = [
      ...selectors.map((resourceSelector) => ({ principal: noHarnessScope, resourceSelector })),
      ...selectors.map((resourceSelector) => ({ principal: unboundHarness, resourceSelector })),
    ];
    const outcomes = await Promise.allSettled(attempts.map((attempt, index) => (
      searchHarnessMemoryV2({
        principal: attempt.principal,
        request: v2Request({
          requestId: `slice4-unbound-${index}-${randomUUID()}`,
          resourceSelector: attempt.resourceSelector,
        }),
      })
    )));
    const errors = outcomes.map((outcome) => {
      if (outcome.status !== "rejected") {
        throw new Error("Unbound harness search unexpectedly succeeded");
      }
      const error = outcome.reason as {
        code?: string;
        statusCode?: number;
        message?: string;
        details?: unknown[];
      };
      return {
        code: error.code,
        statusCode: error.statusCode,
        message: error.message,
        details: error.details,
      };
    });
    expect(new Set(errors.map((error) => JSON.stringify(error)))).toEqual(new Set([
      JSON.stringify({
        code: "resource_not_found",
        statusCode: 404,
        message: "Memory harness is unavailable",
        details: [],
      }),
    ]));
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM memory_v2_retrieval_packs",
    ).get()).toEqual(before);
  });

  it("fails closed for a missing or wrong mapped facet instead of silently filtering", async () => {
    const facet = db.prepare(
      `SELECT * FROM memory_v2_record_facets
       WHERE record_id = ? AND record_version = ?`,
    ).get(harnessRecord.recordId, harnessRecord.recordVersion) as Record<string, unknown>;
    try {
      db.prepare(
        "DELETE FROM memory_v2_record_facets WHERE record_id = ? AND record_version = ?",
      ).run(harnessRecord.recordId, harnessRecord.recordVersion);
      expect(() => getHarnessMemoryRecordV2({
        principal,
        recordId: harnessRecord.recordId,
        recordVersion: harnessRecord.recordVersion,
      })).toThrow(expect.objectContaining({
        code: "temporarily_unavailable",
        statusCode: 503,
      }));

      db.prepare(
        `INSERT INTO memory_v2_record_facets
           (record_id, record_version, org_id, project_id, plane, resource_row_id,
            broad_kind, subtype, projection_status, facet_json, created_at)
         VALUES (?, ?, ?, ?, 'harness', ?, 'decision', 'workflow_strategy', 'mapped',
                 '{"projection":"v1","source_plane":"harness","projection_reason":"lossless"}', ?)`,
      ).run(
        harnessRecord.recordId,
        harnessRecord.recordVersion,
        facet.org_id as string,
        facet.project_id as string,
        facet.resource_row_id as string,
        facet.created_at as string,
      );
      expect(() => getHarnessMemoryRecordV2({
        principal,
        recordId: harnessRecord.recordId,
        recordVersion: harnessRecord.recordVersion,
      })).toThrow(expect.objectContaining({
        code: "temporarily_unavailable",
        statusCode: 503,
      }));
      db.prepare(
        "DELETE FROM memory_v2_record_facets WHERE record_id = ? AND record_version = ?",
      ).run(harnessRecord.recordId, harnessRecord.recordVersion);
    } finally {
      if (!db.prepare(
        "SELECT 1 FROM memory_v2_record_facets WHERE record_id = ? AND record_version = ?",
      ).get(harnessRecord.recordId, harnessRecord.recordVersion)) {
        db.prepare(
          `INSERT INTO memory_v2_record_facets
             (record_id, record_version, org_id, project_id, plane, resource_row_id,
              broad_kind, subtype, projection_status, facet_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          facet.record_id as string,
          facet.record_version as number,
          facet.org_id as string,
          facet.project_id as string,
          facet.plane as string,
          facet.resource_row_id as string,
          facet.broad_kind as string,
          facet.subtype as string,
          facet.projection_status as string,
          facet.facet_json as string,
          facet.created_at as string,
        );
      }
      ensureMemoryV2EvidenceVerifiedTrust({
        recordId: harnessRecord.recordId,
        recordVersion: harnessRecord.recordVersion,
        orgId: context.orgA.id,
        projectId: context.projectA,
        evidenceVerifiedAt: harnessRecord.freshness.last_confirmed_at,
        now,
      });
    }
  });

  it("excludes an explicitly ambiguous legacy constraint while serving mapped rows", async () => {
    const ambiguous = importActiveHarnessMemoryRecord({
      orgId: context.orgA.id,
      projectId: context.projectA,
      recordId: `slice4-ambiguous-${randomUUID()}`,
      kind: "constraint",
      content: {
        summary: "Pause before an unbounded harness escalation.",
        details: "The legacy broad constraint does not say whether this is a tool constraint or an escalation requirement.",
        rationale: "V2 must not guess a narrower subtype from the broad legacy kind.",
      },
      applicability: {
        harness_id: "example-harness-a",
        harness_version_range: "harness-shadow-v1",
        workflow_version_range: "code-change.v3",
        adapter_version_range: "example-harness-a-pim-adapter.v1",
        configuration_ids: ["routing-default-v2"],
        model_ids: ["gpt-harness-shadow"],
        tool_ids: ["terminal-state-inspector"],
      },
      exceptions: [],
      compatibility: {
        harness_version_range: "harness-shadow-v1",
        workflow_version_range: "code-change.v3",
        adapter_version_range: "example-harness-a-pim-adapter.v1",
      },
      validation: {
        strategy: "stable_failure_fingerprint",
        failure_fingerprint: "example-harness-a:ambiguous-legacy-constraint:v1",
      },
      evidence: [{
        evidence_ref_id: `slice4-ambiguous-ref-${randomUUID()}`,
        type: "failure",
        digest: canonicalJsonSha256({ ambiguous: true }),
        origin_id: "example-harness-a:slice4:ambiguous",
        source_authority: "observed",
      }],
      evidenceSummary: { strength: "observed", ref_count: 1 },
      freshness: { last_confirmed_at: now, expires_at: "2027-08-10T12:00:00.000Z" },
      provenance: { extractor_version: "slice4-test.v1" },
      actorId: "slice4-test-reviewer",
      decisionRefs: ["slice4-ambiguous-decision"],
      reasonCode: "legacy_constraint_reviewed",
      explanation: "The broad legacy constraint remains quarantined from v2 serving.",
      now,
    });
    const result = await searchHarnessMemoryV2({
      principal,
      request: v2Request(),
      dependencies: { now: () => new Date(now) },
    });
    expect(result.items.map((item) => item.record_id)).toContain(harnessRecord.recordId);
    expect(result.items.map((item) => item.record_id)).not.toContain(ambiguous.recordId);
    expect(() => getHarnessMemoryRecordV2({
      principal,
      recordId: ambiguous.recordId,
      recordVersion: ambiguous.recordVersion,
    })).toThrow(expect.objectContaining({
      code: "temporarily_unavailable",
      statusCode: 503,
    }));
  });

  it("keeps transitionless low-level legacy rows readable on v1 but omits them from v2", async () => {
    const recordId = `slice4-transitionless-${randomUUID()}`;
    const source = db.prepare(
      "SELECT * FROM memory_records WHERE record_id = ?",
    ).get(harnessRecord.recordId) as Record<string, unknown>;
    const version = db.prepare(
      "SELECT * FROM memory_record_versions WHERE record_id = ? AND record_version = 1",
    ).get(harnessRecord.recordId) as Record<string, unknown>;
    db.prepare(
      `INSERT INTO memory_records
         (record_id, org_id, project_id, repository_row_id, harness_id, plane, kind,
          current_version, current_status, aggregate_version, shadow_recall_eligible,
          prompt_eligible, claim_key, valid_from, valid_until, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, NULL, 'example-harness-a', 'harness', 'test_strategy', 1, 'active', 1, 1,
               0, ?, ?, NULL, ?, ?, ?)`,
    ).run(
      recordId,
      context.orgA.id,
      context.projectA,
      canonicalJsonSha256({ recordId }),
      source.valid_from as string,
      source.expires_at as string | null,
      now,
      now,
    );
    db.prepare(
      `INSERT INTO memory_record_versions
         (record_id, record_version, content_json, applicability_json, exceptions_json,
          compatibility_json, validation_json, evidence_json, evidence_summary_json,
          freshness_json, provenance_json, embedding_json, content_digest, recorded_at)
       VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).run(
      recordId,
      version.content_json as string,
      version.applicability_json as string,
      version.exceptions_json as string,
      version.compatibility_json as string,
      version.validation_json as string,
      version.evidence_json as string,
      version.evidence_summary_json as string,
      version.freshness_json as string,
      version.provenance_json as string,
      canonicalJsonSha256({ recordId, content: version.content_digest }),
      now,
    );
    const resource = resolveMemoryV2Resource({
      orgId: context.orgA.id,
      projectId: context.projectA,
      plane: "harness",
      canonicalResourceId: "example-harness-a",
    })!;
    db.prepare(
      `INSERT INTO memory_v2_record_facets
         (record_id, record_version, org_id, project_id, plane, resource_row_id,
          broad_kind, subtype, projection_status, facet_json, created_at)
       VALUES (?, 1, ?, ?, 'harness', ?, 'test_strategy', 'verification_sequence',
               'mapped', '{"projection":"v1","source_plane":"harness","projection_reason":"lossless"}', ?)`,
    ).run(recordId, context.orgA.id, context.projectA, resource.resourceRowId, now);

    expect(getHarnessMemoryRecord({
      orgId: context.orgA.id,
      projectId: context.projectA,
      harnessId: "example-harness-a",
      recordId,
    })).toMatchObject({ recordId, transitionSummary: null });
    const binding = resolveMemoryHarnessPrincipalBinding({
      servicePrincipalId: principal.servicePrincipalId,
      orgId: principal.orgId,
      projectId: context.projectA,
      harnessId: "example-harness-a",
    })!;
    const request = v2Request();
    const v1 = executeHarnessMemorySearch({
      orgId: principal.orgId,
      projectId: context.projectA,
      principalId: principal.servicePrincipalId,
      binding,
      request: toV1(request, `${request.request_id}-legacy`),
      now: new Date(now),
    });
    expect(v1.items.map((item) => item.record_id)).toContain(recordId);
    const v2 = await searchHarnessMemoryV2({
      principal,
      request,
      dependencies: { now: () => new Date(now) },
    });
    expect(v2.items.map((item) => item.record_id)).not.toContain(recordId);
  });
});
