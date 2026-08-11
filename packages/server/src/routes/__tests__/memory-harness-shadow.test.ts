import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MEMORY_CONTRACT_FIXTURES,
  canonicalJsonSha256,
  parseMemoryContract,
  type CodeEvidenceManifestV2,
  type MemoryCandidateDecisionV1,
  type MemoryCandidateV1,
  type MemoryHarnessSearchV1,
  type RunReceiptV1,
} from "@pim/shared";
import db from "../../db/connection.js";
import {
  createServiceToken,
  verifyServiceToken,
} from "../../services/service-tokens.js";
import { canonicalHarnessMemoryClaimKey } from "../../services/memory-harness-records.js";
import { createMemoryTestContext, type MemoryTestContext } from "./memory-test-app.js";

const TREE_SHA = "89abcdef0123456789abcdef0123456789abcdef";
const EVENT_TIME = "2026-08-03T00:00:00.000Z";
const FAILURE_FINGERPRINT = "example-harness-a:tool-timeout:terminal-state-unknown:v1";

let context: MemoryTestContext;

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function harnessFixture(): {
  producerRunId: string;
  failureRefId: string;
  candidate: MemoryCandidateV1;
  receipt: RunReceiptV1;
} {
  const suffix = randomUUID();
  const producerRunId = `example-harness-a:test:harness:${suffix}`;
  const failureRefId = `failure-${suffix}`;
  const refs: CodeEvidenceManifestV2["refs"] = [{
    id: failureRefId,
    type: "failure",
    uri: `https://github.com/acme/checkout/commit/${TREE_SHA}.log`,
    digest: canonicalJsonSha256({ failure: suffix }),
    origin_id: `example-harness-a:${producerRunId}:failure`,
    occurred_at: EVENT_TIME,
    source_authority: "observed",
  }];
  const manifestBody: Omit<CodeEvidenceManifestV2, "digest"> = {
    schema_version: "pim.memory-code-evidence.v2",
    manifest_id: `harness-manifest-${suffix}`,
    refs,
  };
  const manifest = parseMemoryContract("CodeEvidenceManifestV2", {
    ...manifestBody,
    digest: canonicalJsonSha256(manifestBody),
  });
  const candidate = parseMemoryContract("MemoryCandidateV1", {
    schema_version: "pim.memory-candidate.v1",
    client_candidate_id: `harness-candidate-${suffix}`,
    plane: "harness",
    kind: "test_strategy",
    content: {
      summary: `Check terminal tool state before retrying timeout ${suffix}.`,
      details: `When example harness A observes timeout ${suffix}, it must inspect the terminal tool state before deciding whether another side-effecting call is safe.`,
      rationale: "A stable failure fingerprint prevents ambiguous timeouts from becoming unconditional retry guidance.",
    },
    applicability: {
      harness_id: "example-harness-a",
      harness_version_range: "harness-v1",
      workflow_version_range: "code-change.v3",
      adapter_version_range: "example-adapter-a.v1",
      configuration_ids: ["routing-default-v2"],
      model_ids: ["gpt-harness"],
      tool_ids: ["terminal-state-inspector"],
    },
    validation: {
      strategy: "stable_failure_fingerprint",
      failure_fingerprint: FAILURE_FINGERPRINT,
    },
    exceptions: ["Do not retry tools whose terminal state cannot be inspected."],
    source_run_ids: [producerRunId],
    evidence_refs: refs.map((ref) => ref.id),
    extraction: {
      method: "deterministic",
      extractor_version: "example-harness-extractor.v1",
      confidence: 1,
    },
    activation_requirement_requested: "authorized_review",
  });
  const receipt = parseMemoryContract("RunReceiptV1", {
    schema_version: "pim.run-receipt.v1",
    external_session_id: `example-harness-a-thread-${suffix}`,
    producer: {
      harness_id: "example-harness-a",
      harness_version: "harness-v1",
      workflow_version: "code-change.v3",
      adapter_version: "example-adapter-a.v1",
    },
    tenant: { project_id: context.projectA },
    task: { task_class: "recovery", summary: `Recover safely from tool timeout ${suffix}.` },
    outcome: {
      status: "failed",
      terminal_stage: "close",
      reason_code: "tool_timeout_terminal_state_unknown",
      verification_status: "failed",
      publication_status: "none",
      gate_attestation_ids: [],
      failure_fingerprint: FAILURE_FINGERPRINT,
    },
    retrieval_feedback: [],
    evidence_manifest: manifest,
    candidates: [candidate],
  });
  return { producerRunId, failureRefId, candidate, receipt };
}

function searchRequest(input: {
  requestId?: string;
  projectId?: string;
  harnessId?: string;
  configurationIds?: string[] | null;
  modelIds?: string[] | null;
  toolIds?: string[] | null;
} = {}): MemoryHarnessSearchV1 {
  const fixture = structuredClone(
    MEMORY_CONTRACT_FIXTURES.MemoryHarnessSearchV1,
  ) as unknown as MemoryHarnessSearchV1;
  const harnessId = input.harnessId ?? "example-harness-a";
  return parseMemoryContract("MemoryHarnessSearchV1", {
    ...fixture,
    request_id: input.requestId ?? `harness-search-${randomUUID()}`,
    consumer: {
      harness_id: harnessId,
      harness_version: "harness-v1",
      workflow_version: "code-change.v3",
      adapter_version: "example-adapter-a.v1",
      consumer_run_id: `harness-consumer-${randomUUID()}`,
    },
    tenant: { project_id: input.projectId ?? context.projectA },
    applicability: {
      harness_id: harnessId,
      harness_version_range: "harness-v1",
      workflow_version_range: "code-change.v3",
      adapter_version_range: "example-adapter-a.v1",
      ...(input.configurationIds === null
        ? {}
        : { configuration_ids: input.configurationIds ?? ["routing-default-v2"] }),
      ...(input.modelIds === null
        ? {}
        : { model_ids: input.modelIds ?? ["gpt-harness"] }),
      ...(input.toolIds === null
        ? {}
        : { tool_ids: input.toolIds ?? ["terminal-state-inspector"] }),
    },
    task: { query: "Check terminal tool state before retrying timeout", task_class: "recovery" },
  });
}

function decision(failureRefId: string): MemoryCandidateDecisionV1 {
  return parseMemoryContract("MemoryCandidateDecisionV1", {
    schema_version: "pim.memory-candidate-decision.v1",
    decision_revision: 1,
    decision: "approve",
    reason_code: "authorized_harness_failure_reviewed",
    explanation: "The exact stable failure evidence and bounded retry exception were reviewed.",
    evidence_refs: [failureRefId],
    event_time: EVENT_TIME,
  });
}

beforeAll(async () => {
  context = await createMemoryTestContext();
});

afterAll(async () => {
  if (context) await context.app.close();
});

describe("harness memory", () => {
  it("accepts, reviews, and retrieves a repository-free harness lesson", async () => {
    const fixture = harnessFixture();
    const acceptedResponse = await context.app.inject({
      method: "PUT",
      url: `/api/v1/memory/run-receipts/${encodeURIComponent(fixture.producerRunId)}`,
      headers: {
        ...auth(context.harnessReceiptTokenA),
        "idempotency-key": `harness-receipt-${fixture.producerRunId}`,
      },
      payload: fixture.receipt,
    });
    expect(acceptedResponse.statusCode, acceptedResponse.body).toBe(200);
    const accepted = acceptedResponse.json();
    expect(accepted.candidate_results[0]).toMatchObject({
      status: "pending_review",
      blockers: ["authorized_review_required"],
    });
    const candidateId = accepted.candidate_results[0].candidate_id as string;
    expect(db.prepare(
      `SELECT plane, repository_row_id, current_status
       FROM memory_candidates_v1 WHERE candidate_id = ?`,
    ).get(candidateId)).toEqual({
      plane: "harness",
      repository_row_id: null,
      current_status: "pending_review",
    });
    expect(db.prepare(
      `SELECT repository_row_id FROM memory_run_receipts WHERE producer_run_id = ?`,
    ).get(fixture.producerRunId)).toEqual({ repository_row_id: null });

    const wrongReviewer = await context.app.inject({
      method: "POST",
      url: `/api/v1/memory/candidates/${encodeURIComponent(candidateId)}/decisions`,
      headers: auth(context.reviewerTokenA),
      payload: decision(fixture.failureRefId),
    });
    expect(wrongReviewer.statusCode).toBe(403);

    const reviewedResponse = await context.app.inject({
      method: "POST",
      url: `/api/v1/memory/candidates/${encodeURIComponent(candidateId)}/decisions`,
      headers: auth(context.harnessReviewerTokenA),
      payload: decision(fixture.failureRefId),
    });
    expect(reviewedResponse.statusCode, reviewedResponse.body).toBe(200);
    const reviewed = reviewedResponse.json();
    expect(reviewed).toMatchObject({ candidate_status: "active", decision: "approve" });
    const recordId = reviewed.active_record.record_id as string;
    expect(db.prepare(
      `SELECT plane, repository_row_id, harness_id, current_status
       FROM memory_records WHERE record_id = ?`,
    ).get(recordId)).toEqual({
      plane: "harness",
      repository_row_id: null,
      harness_id: "example-harness-a",
      current_status: "active",
    });
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM memory_record_versions_fts WHERE record_key = ?",
    ).get(`${recordId}:1`)).toEqual({ count: 1 });
    const request = searchRequest();
    const searchedResponse = await context.app.inject({
      method: "POST",
      url: "/api/v1/memory/harness/search",
      headers: auth(context.harnessSearchTokenA),
      payload: request,
    });
    expect(searchedResponse.statusCode, searchedResponse.body).toBe(200);
    const searched = searchedResponse.json();
    expect(searched).toMatchObject({
      plane: "harness",
      harness_id: "example-harness-a",
    });
    expect(searched.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ record_id: recordId }),
    ]));
    expect(db.prepare(
      `SELECT repository_row_id, repository_id, harness_id, plane
       FROM memory_retrieval_packs WHERE retrieval_pack_id = ?`,
    ).get(searched.retrieval_pack_id)).toEqual({
      repository_row_id: null,
      repository_id: null,
      harness_id: "example-harness-a",
      plane: "harness",
    });

    for (const scopedRequest of [
      searchRequest({ configurationIds: null }),
      searchRequest({ configurationIds: ["routing-other"] }),
      searchRequest({ modelIds: null }),
      searchRequest({ modelIds: ["model-other"] }),
      searchRequest({ toolIds: null }),
      searchRequest({ toolIds: ["tool-other"] }),
    ]) {
      const overgeneralized = await context.app.inject({
        method: "POST",
        url: "/api/v1/memory/harness/search",
        headers: auth(context.harnessSearchTokenA),
        payload: scopedRequest,
      });
      expect(overgeneralized.statusCode, overgeneralized.body).toBe(200);
      expect(overgeneralized.json().items.map((item: { record_id: string }) => item.record_id))
        .not.toContain(recordId);
    }

    const replay = await context.app.inject({
      method: "POST",
      url: "/api/v1/memory/harness/search",
      headers: auth(context.harnessSearchTokenA),
      payload: request,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(searched);
    const changed = structuredClone(request);
    changed.task.query = "Changed query under the same immutable request ID";
    const conflict = await context.app.inject({
      method: "POST",
      url: "/api/v1/memory/harness/search",
      headers: auth(context.harnessSearchTokenA),
      payload: changed,
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: "idempotency_conflict" });

    const verified = verifyServiceToken(context.harnessSearchTokenA);
    expect(verified?.auth).toMatchObject({ repositoryBindings: [] });
    expect(verified?.auth.harnessBindings?.map((binding) => binding.harnessId))
      .toEqual(["example-harness-a"]);
  });

  it("enforces exact harness/project/scope boundaries and strict contracts", async () => {
    const otherHarness = await context.app.inject({
      method: "POST",
      url: "/api/v1/memory/harness/search",
      headers: auth(context.otherHarnessSearchTokenA),
      payload: searchRequest({ harnessId: "example-harness-b" }),
    });
    expect(otherHarness.statusCode, otherHarness.body).toBe(200);
    expect(otherHarness.json().items).toEqual([]);

    for (const [token, request] of [
      [context.otherHarnessSearchTokenA, searchRequest()],
      [context.otherProjectHarnessSearchTokenA, searchRequest()],
      [context.tokenA, searchRequest()],
    ] as const) {
      const response = await context.app.inject({
        method: "POST",
        url: "/api/v1/memory/harness/search",
        headers: auth(token),
        payload: request,
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: "resource_binding_mismatch" });
    }

    const codebaseRequest = structuredClone(MEMORY_CONTRACT_FIXTURES.MemorySearchV1);
    (codebaseRequest as { tenant: { project_id: string } }).tenant.project_id = context.projectA;
    const crossPlane = await context.app.inject({
      method: "POST",
      url: "/api/v1/memory/search",
      headers: auth(context.harnessSearchTokenA),
      payload: codebaseRequest,
    });
    expect(crossPlane.statusCode).toBe(403);

    const invalid = { ...searchRequest(), unexpected: true };
    const invalidResponse = await context.app.inject({
      method: "POST",
      url: "/api/v1/memory/harness/search",
      headers: auth(context.harnessSearchTokenA),
      payload: invalid,
    });
    expect(invalidResponse.statusCode).toBe(400);
    expect(invalidResponse.json()).toMatchObject({ code: "schema_invalid" });

    const oversizedResponse = await context.app.inject({
      method: "POST",
      url: "/api/v1/memory/harness/search",
      headers: auth(context.harnessSearchTokenA),
      payload: { ...searchRequest(), padding: "x".repeat(33 * 1024) },
    });
    expect(oversizedResponse.statusCode).toBe(413);

    const owner = db.prepare(
      "SELECT created_by_user_id FROM orgs WHERE org_id = ?",
    ).get(context.orgA.id) as { created_by_user_id: string };
    expect(() => createServiceToken({
      orgId: context.orgA.id,
      name: "Unbound harness token",
      scopes: ["memory:harness:search"],
      createdByUserId: owner.created_by_user_id,
      projectId: context.projectA,
      harnessIds: [],
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    })).toThrow(/exact harness binding/i);
  });

  it("uses the full normalized claim and extractor version without undefined JSON fields", () => {
    const fixture = harnessFixture();
    const candidate = fixture.candidate;
    const sparseApplicability = {
      harness_id: "example-harness-a",
      workflow_version_range: "code-change.v3",
    };
    const baseline = canonicalHarnessMemoryClaimKey({
      kind: candidate.kind,
      content: candidate.content,
      applicability: sparseApplicability,
      provenance: { extractor_version: candidate.extraction.extractor_version },
    });
    expect(canonicalHarnessMemoryClaimKey({
      kind: candidate.kind,
      content: {
        summary: `  ${candidate.content.summary.toUpperCase()}  `,
        details: `  ${candidate.content.details.replaceAll(" ", "  ")}  `,
        rationale: `  ${candidate.content.rationale.replaceAll(" ", "  ")}  `,
      },
      applicability: { ...sparseApplicability, configuration_ids: [] },
      provenance: { extractor_version: candidate.extraction.extractor_version },
    })).toBe(baseline);
    expect(canonicalHarnessMemoryClaimKey({
      kind: candidate.kind,
      content: { ...candidate.content, details: `${candidate.content.details} Different.` },
      applicability: sparseApplicability,
      provenance: { extractor_version: candidate.extraction.extractor_version },
    })).not.toBe(baseline);
    expect(canonicalHarnessMemoryClaimKey({
      kind: candidate.kind,
      content: candidate.content,
      applicability: sparseApplicability,
      provenance: { extractor_version: "example-harness-extractor.v2" },
    })).not.toBe(baseline);
  });

});
