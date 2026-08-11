import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MEMORY_CONTRACT_FIXTURES,
  canonicalJsonSha256,
  parseMemoryContract,
  type CodeEvidenceManifestV2,
  type MemoryCandidateV1,
  type MemorySearchV1,
  type RunReceiptV1,
} from "@pim/shared";
import db from "../../db/connection.js";
import {
  backfillLegacyMemoryTokenBindings,
  createServiceToken,
  listServiceTokens,
  verifyServiceToken,
} from "../../services/service-tokens.js";
import { createMemoryTestContext, type MemoryTestContext } from "./memory-test-app.js";

const BASE_SHA = "0123456789abcdef0123456789abcdef01234567";
const HEAD_SHA = "89abcdef0123456789abcdef0123456789abcdef";

let context: MemoryTestContext;
let emptyReviewerToken: string;
let checkoutAdminToken: string;
let legacyUnboundSearchToken: string;

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  context = await createMemoryTestContext();
  const project = db.prepare(
    "SELECT created_by_user_id FROM projects WHERE project_id = ?",
  ).get(context.projectA) as { created_by_user_id: string };
  const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
  const emptyReviewer = createServiceToken({
    orgId: context.orgA.id,
    name: "Empty repository reviewer",
    scopes: ["memory:review", "memory:candidate:read"],
    createdByUserId: project.created_by_user_id,
    projectId: context.projectA,
    repositoryIds: ["github.com/acme/empty"],
    expiresAt,
  });
  emptyReviewerToken = emptyReviewer.token;
  expect(verifyServiceToken(emptyReviewer.token)?.auth.repositoryBindings).toEqual([{
    repositoryRowId: expect.any(String),
    repositoryId: "github.com/acme/empty",
  }]);

  checkoutAdminToken = createServiceToken({
    orgId: context.orgA.id,
    name: "Checkout-only memory admin",
    scopes: ["memory:admin"],
    createdByUserId: project.created_by_user_id,
    projectId: context.projectA,
    repositoryIds: ["github.com/acme/checkout"],
    expiresAt,
  }).token;

  const legacy = createServiceToken({
    orgId: context.orgA.id,
    name: "Legacy token without repository rows",
    scopes: ["project:read"],
    createdByUserId: project.created_by_user_id,
    projectId: context.projectA,
    expiresAt,
  });
  db.prepare(
    "UPDATE service_tokens SET scopes_json = ? WHERE token_id = ?",
  ).run(JSON.stringify(["memory:search"]), legacy.token_id);
  legacyUnboundSearchToken = legacy.token;
});

afterAll(async () => {
  if (context) await context.app.close();
});

async function createCheckoutCandidate(): Promise<string> {
  const suffix = randomUUID();
  const producerRunId = `fiesta:repository-authz:${suffix}`;
  const evidenceRefId = `authz-diff-${suffix}`;
  const manifestBody: Omit<CodeEvidenceManifestV2, "digest"> = {
    schema_version: "pim.memory-code-evidence.v2",
    manifest_id: `authz-manifest-${suffix}`,
    refs: [{
      id: evidenceRefId,
      type: "git_diff",
      uri: `https://github.com/acme/checkout/commit/${HEAD_SHA}.diff`,
      digest: canonicalJsonSha256({ evidence: suffix }),
      origin_id: `github.com/acme/checkout:${HEAD_SHA}:${evidenceRefId}`,
      occurred_at: new Date().toISOString(),
      source_authority: "observed",
    }],
  };
  const manifest = parseMemoryContract("CodeEvidenceManifestV2", {
    ...manifestBody,
    digest: canonicalJsonSha256(manifestBody),
  });
  const candidate = parseMemoryContract("MemoryCandidateV1", {
    schema_version: "pim.memory-candidate.v1",
    client_candidate_id: `authz-candidate-${suffix}`,
    plane: "codebase",
    kind: "constraint",
    content: {
      summary: `Keep repository authority exact for ${suffix}.`,
      details: "A project-bound reviewer for another repository must not inspect or decide this checkout candidate.",
      rationale: "Repository membership is narrower than project membership.",
    },
    applicability: {
      repository_id: "github.com/acme/checkout",
      base_sha: BASE_SHA,
      paths: [`src/authz/${suffix}.ts`],
      symbols: [`authz_${suffix.replaceAll("-", "_")}`],
      task_classes: ["bug_fix"],
    },
    validation: { strategy: "repository_anchors" },
    exceptions: [],
    source_run_ids: [producerRunId],
    evidence_refs: [evidenceRefId],
    extraction: {
      method: "model_then_deterministic_validation",
      extractor_version: "repository-authz-test-v1",
      confidence: 0.95,
    },
    activation_requirement_requested: "verified_merge",
  }) as MemoryCandidateV1;
  const fixture = structuredClone(MEMORY_CONTRACT_FIXTURES.RunReceiptV1) as unknown as RunReceiptV1;
  const receipt = parseMemoryContract("RunReceiptV1", {
    ...fixture,
    external_session_id: `authz-session-${suffix}`,
    tenant: { project_id: context.projectA },
    repository: {
      repository_id: "github.com/acme/checkout",
      display_slug: "Acme/Checkout",
      base_sha: BASE_SHA,
      candidate_tree_sha: HEAD_SHA,
      provider_pull_request_id: `github:acme/checkout#${suffix}`,
      pr_head_sha: HEAD_SHA,
      pull_request_url: `https://github.com/acme/checkout/pull/${suffix}`,
    },
    evidence_manifest: manifest,
    candidates: [candidate],
  });
  const response = await context.app.inject({
    method: "PUT",
    url: `/api/v1/memory/run-receipts/${encodeURIComponent(producerRunId)}`,
    headers: {
      ...auth(context.receiptTokenA),
      "idempotency-key": `authz-receipt-${suffix}`,
    },
    payload: receipt,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json().candidate_results[0].candidate_id as string;
}

describe("memory service-token repository authorization", () => {
  it("requires exact repository rows when issuing a new memory-scoped token", () => {
    const createdByUserId = (db.prepare(
      "SELECT created_by_user_id FROM projects WHERE project_id = ?",
    ).get(context.projectA) as { created_by_user_id: string }).created_by_user_id;
    expect(() => createServiceToken({
      orgId: context.orgA.id,
      name: "Unsafe unbound memory token",
      scopes: ["memory:search"],
      createdByUserId,
      projectId: context.projectA,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    })).toThrow(/at least one exact repository binding/);
    expect(listServiceTokens(context.orgA.id)).toContainEqual(expect.objectContaining({
      name: "Empty repository reviewer",
      repository_ids: ["github.com/acme/empty"],
    }));
  });

  it("fails closed for a legacy memory token that has no repository binding rows", async () => {
    const request = structuredClone(MEMORY_CONTRACT_FIXTURES.MemorySearchV1) as unknown as MemorySearchV1;
    request.request_id = `legacy-unbound-${randomUUID()}`;
    request.tenant = { project_id: context.projectA };
    const response = await context.app.inject({
      method: "POST",
      url: "/api/v1/memory/search",
      headers: auth(legacyUnboundSearchToken),
      payload: request,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "resource_binding_mismatch" });
  });

  it("does not let an empty-repository principal inspect or review a checkout candidate", async () => {
    const candidateId = await createCheckoutCandidate();
    const detail = await context.app.inject({
      method: "GET",
      url: `/api/v1/memory/candidates/${encodeURIComponent(candidateId)}`,
      headers: auth(emptyReviewerToken),
    });
    expect(detail.statusCode).toBe(403);
    expect(detail.json()).toMatchObject({ code: "resource_binding_mismatch" });

    const decision = await context.app.inject({
      method: "POST",
      url: `/api/v1/memory/candidates/${encodeURIComponent(candidateId)}/decisions`,
      headers: auth(emptyReviewerToken),
      payload: MEMORY_CONTRACT_FIXTURES.MemoryCandidateDecisionV1,
    });
    expect(decision.statusCode).toBe(403);
    expect(decision.json()).toMatchObject({ code: "resource_binding_mismatch" });
    expect((db.prepare(
      "SELECT COUNT(*) AS count FROM memory_candidate_decisions WHERE candidate_id = ?",
    ).get(candidateId) as { count: number }).count).toBe(0);
  });

  it("protects record detail with the same exact repository binding", async () => {
    const response = await context.app.inject({
      method: "GET",
      url: `/api/v1/memory/records/${context.seededRecordId}?version=1`,
      headers: auth(context.tokenEmptyA),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "resource_binding_mismatch" });
  });

  // Runs last: the backfill grandfathers every zero-binding memory token in the
  // database, including the legacy fixture the fail-closed test above depends on.
  it("grandfathers pre-binding memory tokens onto every currently registered project repository", async () => {
    const project = db.prepare(
      "SELECT created_by_user_id FROM projects WHERE project_id = ?",
    ).get(context.projectA) as { created_by_user_id: string };
    const legacy = createServiceToken({
      orgId: context.orgA.id,
      name: "Pre-binding search token",
      scopes: ["project:read"],
      createdByUserId: project.created_by_user_id,
      projectId: context.projectA,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    db.prepare(
      "UPDATE service_tokens SET scopes_json = ? WHERE token_id = ?",
    ).run(JSON.stringify(["memory:search"]), legacy.token_id);

    const inserted = backfillLegacyMemoryTokenBindings();
    expect(inserted).toBeGreaterThanOrEqual(2);
    expect(backfillLegacyMemoryTokenBindings()).toBe(0);

    expect(
      verifyServiceToken(legacy.token)?.auth.repositoryBindings.map(
        (binding) => binding.repositoryId,
      ),
    ).toEqual(["github.com/acme/checkout", "github.com/acme/empty"]);
    expect(db.prepare(
      `SELECT COUNT(*) AS count
       FROM memory_v2_service_token_resource_bindings
       WHERE token_id = ?`,
    ).get(legacy.token_id)).toEqual({ count: 2 });
    // Tokens minted with explicit bindings keep their narrow set.
    expect(verifyServiceToken(emptyReviewerToken)?.auth.repositoryBindings).toEqual([{
      repositoryRowId: expect.any(String),
      repositoryId: "github.com/acme/empty",
    }]);

    const request = structuredClone(
      MEMORY_CONTRACT_FIXTURES.MemorySearchV1,
    ) as unknown as MemorySearchV1;
    request.request_id = `legacy-grandfathered-${randomUUID()}`;
    request.tenant = { project_id: context.projectA };
    const response = await context.app.inject({
      method: "POST",
      url: "/api/v1/memory/search",
      headers: auth(legacy.token),
      payload: request,
    });
    expect(response.statusCode).toBe(200);
  });
});
