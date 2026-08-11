import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canonicalJsonSha256,
  MEMORY_CONTRACT_FIXTURES,
  MEMORY_CONTRACT_FIXTURES_V2,
  type CodebaseMemorySearchV2,
  type MemoryRecordV1,
  type MemorySearchV1,
} from "@pim/shared";
import db from "../../db/connection.js";
import { importActiveMemoryRecord } from "../memory-records.js";
import {
  getCodeMemoryPackV2,
  getCodeMemoryRecordHistoryV2,
  getCodeMemoryRecordV2,
  MemoryV2CodeReadError,
  searchCodeMemoryV2,
} from "../memory-v2-code-read.js";
import { executeMemorySearch } from "../memory-search.js";
import {
  applyMemoryErasurePlan,
  createMemoryRetentionPolicyVersion,
  planMemoryRetention,
} from "../memory-data-governance.js";
import {
  resolveMemoryRepository,
} from "../memory-repository-registry.js";
import { resolveMemoryV2Resource } from "../memory-v2-resources.js";
import {
  ensureMemoryV2EvidenceVerifiedTrust,
  getMemoryV2RecordTrust,
} from "../memory-v2-trust.js";
import {
  createServiceToken,
  revokeServiceToken,
  verifyMemoryV2ServiceToken,
  type MemoryV2RequestAuthorizationSnapshot,
} from "../service-tokens.js";
import {
  createMemoryTestContext,
  type MemoryTestContext,
} from "../../routes/__tests__/memory-test-app.js";

let context: MemoryTestContext;
let principalA: MemoryV2RequestAuthorizationSnapshot;
let principalEmptyA: MemoryV2RequestAuthorizationSnapshot;
let requestCounter = 0;

function request(input: Partial<CodebaseMemorySearchV2> = {}): CodebaseMemorySearchV2 {
  const fixture = structuredClone(
    MEMORY_CONTRACT_FIXTURES_V2.MemorySearchV2,
  ) as unknown as CodebaseMemorySearchV2;
  return {
    ...fixture,
    ...input,
    request_id: input.request_id ?? `v2-code-read-${++requestCounter}`,
    tenant: input.tenant ?? { project_id: context.projectA },
    resource_selector: Object.prototype.hasOwnProperty.call(input, "resource_selector")
      ? input.resource_selector!
      : { canonical_resource_id: "github.com/acme/checkout" },
    applicability: input.applicability ?? {
      ...fixture.applicability,
      repository_id: "github.com/acme/checkout",
    },
  };
}

beforeAll(async () => {
  context = await createMemoryTestContext();
  principalA = verifyMemoryV2ServiceToken(context.tokenA)!.authorization;
  principalEmptyA = verifyMemoryV2ServiceToken(context.tokenEmptyA)!.authorization;
});

afterAll(async () => {
  if (context) await context.app.close();
});

describe("Slice 2 codebase v2 read service", () => {
  it("deep-freezes every credential and exact-resource authority layer", () => {
    const resource = principalA.resources[0]!;
    expect(Object.isFrozen(principalA)).toBe(true);
    expect(Object.isFrozen(principalA.org)).toBe(true);
    expect(Object.isFrozen(principalA.membership)).toBe(true);
    expect(Object.isFrozen(principalA.scopes)).toBe(true);
    expect(Object.isFrozen(principalA.repositoryBindings)).toBe(true);
    expect(Object.isFrozen(principalA.harnessBindings)).toBe(true);
    expect(Object.isFrozen(principalA.resources)).toBe(true);
    expect(Object.isFrozen(resource)).toBe(true);
    expect(Object.isFrozen(resource.operations)).toBe(true);
    expect(Object.isFrozen(resource.canonicalAliases)).toBe(true);
    expect(Object.isFrozen(resource.resource)).toBe(true);
    expect(Object.isFrozen(resource.contract)).toBe(true);
    expect(Object.isFrozen(resource.contract.permitted_operations)).toBe(true);
    expect(Object.isFrozen(resource.source)).toBe(true);
    expect(Object.isFrozen(resource.source.kind === "repository"
      ? resource.source.repository
      : resource.source.harness)).toBe(true);

    const before = structuredClone(resource.contract);
    expect(() => (resource.contract.permitted_operations as string[]).push("review"))
      .toThrow(TypeError);
    expect(() => (resource.canonicalAliases as string[]).push("github.com/acme/forged"))
      .toThrow(TypeError);
    expect(resource.contract).toEqual(before);
  });

  it("reuses v1 ranking while atomically writing only the v2 pack namespace", async () => {
    const v2Request = request();
    const result = await searchCodeMemoryV2({ principal: principalA, request: v2Request });

    expect(result).toMatchObject({
      schema_version: "pim.memory-search-result.v2",
      request_id: v2Request.request_id,
      plane: "codebase",
    });
    expect(result.items[0]).toMatchObject({
      record_id: context.seededRecordId,
      plane: "codebase",
      subkind: null,
    });
    expect(result.resource_binding.resource_row_id)
      .toBe(result.items[0]!.resource_binding.resource_row_id);

    expect(db.prepare(
      "SELECT retrieval_pack_id FROM memory_retrieval_packs WHERE request_id = ?",
    ).get(v2Request.request_id)).toBeUndefined();
    expect(db.prepare(
      `SELECT retrieval_pack_id, request_digest, scope_snapshot_digest
       FROM memory_v2_retrieval_packs WHERE retrieval_pack_id = ?`,
    ).get(result.retrieval_pack_id)).toMatchObject({
      retrieval_pack_id: result.retrieval_pack_id,
      scope_snapshot_digest: result.scope_snapshot_digest,
    });
    expect(db.prepare(
      `SELECT response_resource_id FROM memory_idempotency_keys
       WHERE operation = 'memory_search_v2' AND idempotency_key = ?`,
    ).get(v2Request.request_id)).toEqual({ response_resource_id: result.retrieval_pack_id });

    const pack = getCodeMemoryPackV2({ principal: principalA, packId: result.retrieval_pack_id });
    expect(pack).toMatchObject({
      retrieval_pack_id: result.retrieval_pack_id,
      request_id: result.request_id,
      scope_snapshot_digest: result.scope_snapshot_digest,
    });
    expect(pack.items.map((item) => [item.record_id, item.record_version, item.match_reasons]))
      .toEqual(result.items.map((item) => [item.record_id, item.record_version, item.match_reasons]));
  });

  it("matches the unchanged v1 selection, order, reasons, token budget, and omissions", async () => {
    const v2Request = request();
    const repository = resolveMemoryRepository(
      context.orgA.id,
      context.projectA,
      "github.com/acme/checkout",
    )!;
    const v1Fixture = structuredClone(
      MEMORY_CONTRACT_FIXTURES.MemorySearchV1,
    ) as unknown as MemorySearchV1;
    const v1Request: MemorySearchV1 = {
      ...v1Fixture,
      request_id: `${v2Request.request_id}-v1`,
      consumer: v2Request.consumer,
      tenant: v2Request.tenant,
      plane: "codebase",
      applicability: {
        repository_id: repository.repository_id,
        base_sha: v2Request.applicability.base_sha!,
        components: v2Request.applicability.components,
        paths: v2Request.applicability.paths,
        symbols: v2Request.applicability.symbols,
        task_classes: v2Request.applicability.task_classes,
      },
      task: v2Request.task,
      temporal: v2Request.temporal,
      budget: v2Request.budget,
      options: v2Request.options,
    };
    const [v1, v2] = await Promise.all([
      executeMemorySearch({
        orgId: context.orgA.id,
        principalId: principalA.servicePrincipalId,
        repository,
        request: v1Request,
      }),
      searchCodeMemoryV2({ principal: principalA, request: v2Request }),
    ]);

    expect(v2.items.map((item) => ({
      id: item.record_id,
      version: item.record_version,
      reasons: item.match_reasons,
    }))).toEqual(v1.items.map((item) => ({
      id: item.record_id,
      version: item.record_version,
      reasons: item.match_reasons,
    })));
    expect(v2.token_count).toBe(v1.token_count);
    expect(v2.omitted_count).toBe(v1.omitted_count);
  });

  it("replays the same pack and conflicts without creating another effect", async () => {
    const v2Request = request();
    const first = await searchCodeMemoryV2({ principal: principalA, request: v2Request });
    const replay = await searchCodeMemoryV2({ principal: principalA, request: v2Request });
    expect(replay).toEqual(first);

    await expect(searchCodeMemoryV2({
      principal: principalA,
      request: {
        ...v2Request,
        task: { ...v2Request.task, query: `${v2Request.task.query} changed` },
      },
    })).rejects.toMatchObject({ code: "idempotency_conflict", statusCode: 409 });
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM memory_v2_retrieval_packs WHERE request_id = ?",
    ).get(v2Request.request_id)).toEqual({ count: 1 });
  });

  it("supports single-binding inference but rejects base-SHA and resource widening", async () => {
    const inferred = await searchCodeMemoryV2({
      principal: principalA,
      request: request({ resource_selector: null }),
    });
    expect(inferred.resource_binding.canonical_resource_id).toBe("github.com/acme/checkout");

    await expect(searchCodeMemoryV2({
      principal: principalA,
      request: request({
        applicability: {
          ...request().applicability,
          base_sha: null,
        },
      }),
    })).rejects.toMatchObject({ code: "schema_invalid", statusCode: 400 });

    await expect(searchCodeMemoryV2({
      principal: principalA,
      request: request({
        resource_selector: { canonical_resource_id: "github.com/acme/empty" },
        applicability: {
          ...request().applicability,
          repository_id: "github.com/acme/empty",
        },
      }),
    })).rejects.toMatchObject({ code: "resource_not_found", statusCode: 404 });
  });

  it("requires exact selectors for a multi-repository principal and isolates each pack scope", async () => {
    const owner = db.prepare(
      "SELECT created_by_user_id FROM projects WHERE project_id = ?",
    ).get(context.projectA) as { created_by_user_id: string };
    const multiToken = createServiceToken({
      orgId: context.orgA.id,
      name: "Slice 2 multi-repository search",
      scopes: ["memory:search"],
      createdByUserId: owner.created_by_user_id,
      projectId: context.projectA,
      repositoryIds: ["github.com/acme/checkout", "github.com/acme/empty"],
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const multiPrincipal = verifyMemoryV2ServiceToken(multiToken.token)!.authorization;
    const ambiguousRequest = request({ resource_selector: null });

    await expect(searchCodeMemoryV2({
      principal: multiPrincipal,
      request: ambiguousRequest,
    })).rejects.toMatchObject({ code: "resource_binding_mismatch", statusCode: 403 });
    expect(db.prepare(
      "SELECT 1 FROM memory_v2_retrieval_packs WHERE request_id = ?",
    ).get(ambiguousRequest.request_id)).toBeUndefined();

    const checkoutBaseSha = "c".repeat(40);
    const checkoutRequest = request({
      resource_selector: { canonical_resource_id: "github.com/acme/checkout" },
      applicability: {
        ...request().applicability,
        repository_id: "github.com/acme/checkout",
        base_sha: checkoutBaseSha,
      },
    });
    const emptyBaseSha = "d".repeat(40);
    const emptyRequest = request({
      resource_selector: { canonical_resource_id: "github.com/acme/empty" },
      applicability: {
        ...request().applicability,
        repository_id: "github.com/acme/empty",
        base_sha: emptyBaseSha,
      },
    });
    const checkout = await searchCodeMemoryV2({
      principal: multiPrincipal,
      request: checkoutRequest,
    });
    const empty = await searchCodeMemoryV2({
      principal: multiPrincipal,
      request: emptyRequest,
    });

    expect(checkout.retrieval_pack_id).not.toBe(empty.retrieval_pack_id);
    expect(checkout.resource_binding).toMatchObject({
      canonical_resource_id: "github.com/acme/checkout",
    });
    expect(empty.resource_binding).toMatchObject({
      canonical_resource_id: "github.com/acme/empty",
    });
    expect(checkout.resource_binding.resource_row_id)
      .not.toBe(empty.resource_binding.resource_row_id);
    expect(checkout.scope_snapshot_digest).toBe(canonicalJsonSha256({
      schema_version: "pim.memory-scope-snapshot.codebase.v2",
      plane: "codebase",
      resource_binding: checkout.resource_binding,
      repository_id: "github.com/acme/checkout",
      base_sha: checkoutBaseSha,
    }));
    expect(empty.scope_snapshot_digest).toBe(canonicalJsonSha256({
      schema_version: "pim.memory-scope-snapshot.codebase.v2",
      plane: "codebase",
      resource_binding: empty.resource_binding,
      repository_id: "github.com/acme/empty",
      base_sha: emptyBaseSha,
    }));
    const storedPack = db.prepare(
      `SELECT retrieval_pack_id, resource_row_id, scope_snapshot_digest
       FROM memory_v2_retrieval_packs WHERE request_id = ?`,
    );
    expect(storedPack.get(checkoutRequest.request_id)).toEqual({
      retrieval_pack_id: checkout.retrieval_pack_id,
      resource_row_id: checkout.resource_binding.resource_row_id,
      scope_snapshot_digest: checkout.scope_snapshot_digest,
    });
    expect(storedPack.get(emptyRequest.request_id)).toEqual({
      retrieval_pack_id: empty.retrieval_pack_id,
      resource_row_id: empty.resource_binding.resource_row_id,
      scope_snapshot_digest: empty.scope_snapshot_digest,
    });
  });

  it("binds idempotency to the authenticated principal without a second effect", async () => {
    const owner = db.prepare(
      "SELECT created_by_user_id FROM projects WHERE project_id = ?",
    ).get(context.projectA) as { created_by_user_id: string };
    const secondToken = createServiceToken({
      orgId: context.orgA.id,
      name: "Slice 2 distinct search principal",
      scopes: ["memory:search"],
      createdByUserId: owner.created_by_user_id,
      projectId: context.projectA,
      repositoryIds: ["github.com/acme/checkout"],
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const secondPrincipal = verifyMemoryV2ServiceToken(secondToken.token)!.authorization;
    const sharedRequest = request();
    const first = await searchCodeMemoryV2({ principal: principalA, request: sharedRequest });

    await expect(searchCodeMemoryV2({
      principal: secondPrincipal,
      request: sharedRequest,
    })).rejects.toMatchObject({ code: "idempotency_conflict", statusCode: 409 });

    expect(db.prepare(
      `SELECT retrieval_pack_id, principal_id FROM memory_v2_retrieval_packs
       WHERE request_id = ?`,
    ).all(sharedRequest.request_id)).toEqual([{
      retrieval_pack_id: first.retrieval_pack_id,
      principal_id: principalA.servicePrincipalId,
    }]);
    expect(db.prepare(
      `SELECT COUNT(*) AS count FROM memory_idempotency_keys
       WHERE operation = 'memory_search_v2' AND idempotency_key = ?`,
    ).get(sharedRequest.request_id)).toEqual({ count: 1 });
  });

  it("serves immutable detail/history and reauthorizes pack scope", async () => {
    const result = await searchCodeMemoryV2({ principal: principalA, request: request() });
    const detail = getCodeMemoryRecordV2({
      principal: principalA,
      recordId: context.seededRecordId,
      recordVersion: 1,
    });
    expect(detail).toMatchObject({
      schema_version: "pim.memory-record.v2",
      record_id: context.seededRecordId,
      record_version: 1,
      subkind: null,
      evidence_summary: { distinct_corroboration_domain_count: 0 },
      freshness: { last_verified_at: null, next_reverify_at: null },
    });
    const history = getCodeMemoryRecordHistoryV2({
      principal: principalA,
      recordId: context.seededRecordId,
    });
    expect(history.versions).toEqual([detail]);

    const reviewer = verifyMemoryV2ServiceToken(context.reviewerTokenA)!.authorization;
    for (const recordId of [context.seededRecordId, "missing-code-history"]) {
      expect(() => getCodeMemoryRecordHistoryV2({
        principal: reviewer,
        recordId,
      })).toThrow(expect.objectContaining({
        code: "scope_required",
        statusCode: 403,
        message: "The required memory scope is unavailable",
      }));
    }

    expect(() => getCodeMemoryPackV2({
      principal: principalEmptyA,
      packId: result.retrieval_pack_id,
    })).toThrow(MemoryV2CodeReadError);
  });

  it("maps the known GitHub merge attestation without accepting unknown evidence", async () => {
    const repository = resolveMemoryRepository(
      context.orgA.id,
      context.projectA,
      "github.com/acme/checkout",
    )!;
    const digest = `sha256:${"a".repeat(64)}`;
    const record = importActiveMemoryRecord({
      orgId: context.orgA.id,
      projectId: context.projectA,
      repositoryRowId: repository.repository_row_id,
      recordId: `merge-evidence-${++requestCounter}`,
      kind: "constraint",
      content: {
        summary: "Merge attestation evidence remains typed.",
        details: "The known GitHub merge attestation maps to a bounded v2 attestation handle.",
        rationale: "The v2 read path must not guess unknown evidence types.",
      },
      applicability: {
        repository_id: repository.repository_id,
        base_sha: "b".repeat(40),
        paths: ["src/merge-evidence.ts"],
        symbols: ["mergeEvidence"],
        task_classes: ["bug_fix"],
      },
      exceptions: [],
      compatibility: {
        harness_version_range: "*",
        workflow_version_range: "*",
        adapter_version_range: "*",
      },
      validation: {
        strategy: "repository_anchors",
        anchor_refs: [{ type: "path", value: "src/merge-evidence.ts", digest }],
      },
      evidence: [{
        evidence_ref_id: "merge-attestation-known",
        type: "github_merge",
        digest,
        origin_id: "github-event:merge-attestation-known",
        source_authority: "verified",
      }],
      evidenceSummary: { strength: "verified_merge", ref_count: 1 },
      freshness: { last_confirmed_at: new Date().toISOString(), expires_at: null },
      provenance: { producer: "slice-2-test", extractor_version: "v1" },
    });

    const detail = getCodeMemoryRecordV2({
      principal: principalA,
      recordId: record.record_id,
      recordVersion: 1,
    });
    expect(detail.evidence).toEqual([expect.objectContaining({
      evidence_ref_id: "merge-attestation-known",
      type: "runtime_attestation",
      source_authority: "verified",
    })]);
  });

  it("omits a facetless low-level record from v2 eligibility", async () => {
    const resource = resolveMemoryV2Resource({
      orgId: context.orgA.id,
      projectId: context.projectA,
      plane: "codebase",
      canonicalResourceId: "github.com/acme/checkout",
    })!;
    const facet = db.prepare(
      `SELECT * FROM memory_v2_record_facets
       WHERE record_id = ? AND record_version = 1`,
    ).get(context.seededRecordId) as Record<string, string | number | null>;
    const trust = getMemoryV2RecordTrust(context.seededRecordId, 1)!;
    db.prepare(
      "DELETE FROM memory_v2_record_facets WHERE record_id = ? AND record_version = 1",
    ).run(context.seededRecordId);
    const v2Request = request({
      resource_selector: { resource_row_id: resource.resourceRowId },
    });
    try {
      const result = await searchCodeMemoryV2({ principal: principalA, request: v2Request });
      expect(result.items).toEqual([]);
      expect(db.prepare(
        "SELECT 1 FROM memory_v2_retrieval_packs WHERE request_id = ?",
      ).get(v2Request.request_id)).toEqual({ 1: 1 });
      expect(db.prepare(
        `SELECT 1 FROM memory_idempotency_keys
         WHERE operation = 'memory_search_v2' AND idempotency_key = ?`,
      ).get(v2Request.request_id)).toEqual({ 1: 1 });
    } finally {
      db.prepare(
        `INSERT INTO memory_v2_record_facets
           (record_id, record_version, org_id, project_id, plane, resource_row_id,
            broad_kind, subtype, projection_status, facet_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        facet.record_id,
        facet.record_version,
        facet.org_id,
        facet.project_id,
        facet.plane,
        facet.resource_row_id,
        facet.broad_kind,
        facet.subtype,
        facet.projection_status,
        facet.facet_json,
        facet.created_at,
      );
      ensureMemoryV2EvidenceVerifiedTrust({
        recordId: context.seededRecordId,
        recordVersion: 1,
        orgId: context.orgA.id,
        projectId: context.projectA,
        evidenceVerifiedAt: trust.evidenceVerifiedAt!,
      });
    }
  });

  it("validates the replay copy against the immutable pack instead of trusting the claim", async () => {
    const v2Request = request();
    const result = await searchCodeMemoryV2({ principal: principalA, request: v2Request });
    expect(result.items.length).toBeGreaterThan(0);
    const forged = structuredClone(result);
    forged.items[0]!.summary = "A valid but forged idempotency response must not bypass the pack.";
    db.prepare(
      `UPDATE memory_idempotency_keys SET response_json = ?
       WHERE org_id = ? AND project_id = ?
         AND operation = 'memory_search_v2' AND idempotency_key = ?`,
    ).run(
      JSON.stringify(forged),
      context.orgA.id,
      context.projectA,
      v2Request.request_id,
    );

    await expect(searchCodeMemoryV2({ principal: principalA, request: v2Request }))
      .rejects.toMatchObject({ code: "temporarily_unavailable", statusCode: 503 });
    expect(getCodeMemoryPackV2({
      principal: principalA,
      packId: result.retrieval_pack_id,
    }).retrieval_pack_id).toBe(result.retrieval_pack_id);
  });

  it("lets an authorized in-flight search finish and applies authority changes to the next request", async () => {
    const repository = resolveMemoryRepository(
      context.orgA.id,
      context.projectA,
      "github.com/acme/checkout",
    )!;
    const fixture = structuredClone(
      MEMORY_CONTRACT_FIXTURES.MemoryRecordV1,
    ) as unknown as MemoryRecordV1;
    const embeddedRecord = importActiveMemoryRecord({
      orgId: context.orgA.id,
      projectId: context.projectA,
      repositoryRowId: repository.repository_row_id,
      recordId: `commit-reauth-embedding-${++requestCounter}`,
      kind: fixture.kind,
      content: fixture.content,
      applicability: {
        ...fixture.applicability,
        repository_id: repository.repository_id,
      },
      exceptions: fixture.exceptions,
      compatibility: fixture.compatibility,
      validation: fixture.validation,
      evidence: fixture.evidence,
      evidenceSummary: fixture.evidence_summary,
      freshness: fixture.freshness,
      provenance: { producer: "slice-2-test", extractor_version: "v1" },
      embedding: [1, 0],
    });
    ensureMemoryV2EvidenceVerifiedTrust({
      recordId: embeddedRecord.record_id,
      recordVersion: embeddedRecord.record_version,
      orgId: context.orgA.id,
      projectId: context.projectA,
      evidenceVerifiedAt: embeddedRecord.freshness.last_confirmed_at,
    });
    const owner = db.prepare(
      "SELECT created_by_user_id FROM projects WHERE project_id = ?",
    ).get(context.projectA) as { created_by_user_id: string };
    const cases = [
      {
        name: "revoked",
        mutate: (tokenId: string, _principalId: string) => {
          expect(revokeServiceToken(context.orgA.id, tokenId)).toBe(true);
        },
      },
      {
        name: "expired",
        mutate: (tokenId: string, _principalId: string) => {
          db.prepare("UPDATE service_tokens SET expires_at = ? WHERE token_id = ?")
            .run("2000-01-01T00:00:00.000Z", tokenId);
        },
      },
      {
        name: "disabled",
        mutate: (_tokenId: string, principalId: string) => {
          db.prepare(
            "UPDATE service_principals SET disabled_at = ? WHERE service_principal_id = ?",
          ).run(new Date().toISOString(), principalId);
        },
      },
      {
        name: "scope-narrowed",
        mutate: (tokenId: string, _principalId: string) => {
          db.prepare("UPDATE service_tokens SET scopes_json = ? WHERE token_id = ?")
            .run(JSON.stringify([]), tokenId);
        },
      },
    ] as const;

    for (const scenario of cases) {
      const created = createServiceToken({
        orgId: context.orgA.id,
        name: `Slice 2 commit reauth ${scenario.name}`,
        scopes: ["memory:search", "memory:receipt:write"],
        createdByUserId: owner.created_by_user_id,
        projectId: context.projectA,
        repositoryIds: [repository.repository_id],
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
      const principal = verifyMemoryV2ServiceToken(created.token)!.authorization;
      const v2Request = request({
        request_id: `commit-reauth-${scenario.name}-${++requestCounter}`,
      });
      let markEmbeddingStarted!: () => void;
      const embeddingStarted = new Promise<void>((resolve) => {
        markEmbeddingStarted = resolve;
      });
      let releaseEmbedding!: () => void;
      const embeddingRelease = new Promise<void>((resolve) => {
        releaseEmbedding = resolve;
      });
      const pending = searchCodeMemoryV2({
        principal,
        request: v2Request,
        dependencies: {
          generateQueryEmbedding: async () => {
            markEmbeddingStarted();
            await embeddingRelease;
            return [1, 0];
          },
        },
      });
      await embeddingStarted;
      scenario.mutate(created.token_id, created.service_principal_id);
      releaseEmbedding();
      const completed = await pending;
      expect(completed.request_id).toBe(v2Request.request_id);
      expect(db.prepare(
        "SELECT 1 FROM memory_v2_retrieval_packs WHERE request_id = ?",
      ).get(v2Request.request_id)).toBeDefined();
      expect(db.prepare(
        `SELECT 1 FROM memory_idempotency_keys
         WHERE operation = 'memory_search_v2' AND idempotency_key = ?`,
      ).get(v2Request.request_id)).toBeDefined();

      const next = verifyMemoryV2ServiceToken(created.token);
      if (scenario.name === "scope-narrowed") {
        expect(next).not.toBeNull();
        await expect(searchCodeMemoryV2({
          principal: next!.authorization,
          request: request({ request_id: `next-${scenario.name}-${++requestCounter}` }),
        })).rejects.toMatchObject({ code: "scope_required", statusCode: 403 });
      } else {
        expect(next).toBeNull();
      }
    }
  });

  it("redacts the persisted v2 replay copy and fails closed after pack retention", async () => {
    const v2Request = request();
    const result = await searchCodeMemoryV2({ principal: principalA, request: v2Request });
    const claimBefore = db.prepare(
      `SELECT request_digest, response_resource_type, response_resource_id,
              response_json, expires_at
       FROM memory_idempotency_keys
       WHERE org_id = ? AND project_id = ?
         AND operation = 'memory_search_v2' AND idempotency_key = ?`,
    ).get(context.orgA.id, context.projectA, v2Request.request_id) as Record<string, string>;
    expect(JSON.parse(claimBefore.response_json)).toEqual(result);
    expect(claimBefore).toMatchObject({
      response_resource_type: "memory_v2_retrieval_pack",
      response_resource_id: result.retrieval_pack_id,
    });

    if (!db.prepare("SELECT 1 FROM memory_authority_transitions LIMIT 1").get()) {
      const authorityDigest = canonicalJsonSha256({ fixture: "slice-2-governance" });
      db.prepare(
        `INSERT INTO memory_legacy_import_runs
           (import_run_id, inventory_digest, resolution_digest, source_bundle_digest,
            source_item_count, imported_count, pending_count, quarantined_count,
            deduplicated_count, report_json, created_at)
         VALUES (?, ?, ?, ?, 0, 0, 0, 0, 0, '{}', ?)`,
      ).run(
        `slice-2-governance-${v2Request.request_id}`,
        authorityDigest,
        authorityDigest,
        authorityDigest,
        new Date().toISOString(),
      );
      db.prepare(
        `INSERT INTO memory_authority_transitions
           (transition_id, revision, from_authority, to_authority, legacy_writes_frozen,
            import_run_id, actor_id, reason_code, occurred_at)
         VALUES (?, 1, 'legacy', 'migration_locked', 1, ?, 'slice-2-test',
                 'cutover_started', ?),
                (?, 2, 'migration_locked', 'canonical', 1, ?, 'slice-2-test',
                 'cutover_complete', ?)`,
      ).run(
        `slice-2-authority-lock-${v2Request.request_id}`,
        `slice-2-governance-${v2Request.request_id}`,
        new Date().toISOString(),
        `slice-2-authority-canonical-${v2Request.request_id}`,
        `slice-2-governance-${v2Request.request_id}`,
        new Date().toISOString(),
      );
    }
    const plannedAt = new Date(Date.parse(claimBefore.expires_at) + 1_000).toISOString();
    createMemoryRetentionPolicyVersion({
      orgId: context.orgA.id,
      projectId: context.projectA,
      dataClass: "retrieval_pack",
      retentionDays: 0,
      actorId: "slice-2-privacy-test",
      reasonCode: "retain_expired_v2_search_pack",
      now: plannedAt,
    }, db);
    const plan = planMemoryRetention({
      orgId: context.orgA.id,
      projectId: context.projectA,
      dataClass: "retrieval_pack",
      actorId: "slice-2-privacy-test",
      reasonCode: "apply_expired_v2_search_pack_retention",
      now: plannedAt,
    }, db);
    expect(plan.targets).toContainEqual(expect.objectContaining({
      resource_class: "retrieval_pack",
      resource_id: result.retrieval_pack_id,
    }));
    applyMemoryErasurePlan({
      plan,
      expectedPlanDigest: plan.plan_digest,
      downtimeConfirmed: true,
      compact: false,
      now: plannedAt,
    }, db);

    expect(db.prepare(
      `SELECT request_digest, response_resource_type, response_resource_id, response_json
       FROM memory_idempotency_keys
       WHERE org_id = ? AND project_id = ?
         AND operation = 'memory_search_v2' AND idempotency_key = ?`,
    ).get(context.orgA.id, context.projectA, v2Request.request_id)).toEqual({
      request_digest: claimBefore.request_digest,
      response_resource_type: "memory_v2_retrieval_pack",
      response_resource_id: result.retrieval_pack_id,
      response_json: "{}",
    });
    expect(db.prepare(
      `SELECT response_json, token_count, omitted_count
       FROM memory_v2_retrieval_packs WHERE retrieval_pack_id = ?`,
    ).get(result.retrieval_pack_id)).toEqual({
      response_json: "{}",
      token_count: 0,
      omitted_count: 0,
    });
    await expect(searchCodeMemoryV2({ principal: principalA, request: v2Request }))
      .rejects.toMatchObject({ code: "temporarily_unavailable", statusCode: 503 });
    await expect(searchCodeMemoryV2({
      principal: principalA,
      request: {
        ...v2Request,
        task: { ...v2Request.task, query: `${v2Request.task.query} changed` },
      },
    })).rejects.toMatchObject({ code: "idempotency_conflict", statusCode: 409 });
  });
});
