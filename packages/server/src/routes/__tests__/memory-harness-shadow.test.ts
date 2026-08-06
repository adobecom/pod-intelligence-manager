import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MEMORY_CONTRACT_FIXTURES,
  canonicalJsonSha256,
  parseMemoryContract,
  type FiestaCodeEvidenceV2,
  type MemoryAttestationV1,
  type MemoryCandidateDecisionV1,
  type MemoryCandidateV1,
  type MemoryHarnessSearchV1,
  type RunReceiptV1,
} from "@pim/shared";
import db from "../../db/connection.js";
import { getMemoryOperationalSnapshot } from "../../services/memory-metrics.js";
import {
  setMemoryGithubResolver,
} from "../../services/memory-attestations.js";
import type { AuthoritativeGithubState } from "../../services/memory-activation.js";
import {
  createServiceToken,
  verifyServiceToken,
} from "../../services/service-tokens.js";
import { canonicalHarnessMemoryClaimKey } from "../../services/memory-harness-records.js";
import { createMemoryTestContext, type MemoryTestContext } from "./memory-test-app.js";

const TREE_SHA = "89abcdef0123456789abcdef0123456789abcdef";
const BASE_SHA = "0123456789abcdef0123456789abcdef01234567";
const MERGE_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FIESTA_REPOSITORY_ID = "github.com/acme/checkout";
const WEBHOOK_SECRET = "memory-harness-shadow-test-secret";
const EVENT_TIME = "2026-08-03T00:00:00.000Z";
const FAILURE_FINGERPRINT = "fiesta:tool-timeout:terminal-state-unknown:v1";

let context: MemoryTestContext;
let previousWebhookSecret: string | undefined;
let previousActivationRepositories: string | undefined;
let previousFiestaRepository: string | undefined;
const authoritativeStates = new Map<string, AuthoritativeGithubState>();

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function harnessFixture(includeGitDiff = false): {
  producerRunId: string;
  failureRefId: string;
  candidate: MemoryCandidateV1;
  receipt: RunReceiptV1;
} {
  const suffix = randomUUID();
  const producerRunId = `fiesta:test:harness-shadow:${suffix}`;
  const failureRefId = `failure-${suffix}`;
  const refs: FiestaCodeEvidenceV2["refs"] = [{
    id: failureRefId,
    type: "failure",
    uri: `https://github.com/acme/checkout/commit/${TREE_SHA}.log`,
    digest: canonicalJsonSha256({ failure: suffix }),
    origin_id: `fiesta:${producerRunId}:failure`,
    occurred_at: EVENT_TIME,
    source_authority: "observed",
  }];
  if (includeGitDiff) {
    refs.push({
      id: `diff-${suffix}`,
      type: "git_diff",
      uri: `https://github.com/acme/checkout/commit/${TREE_SHA}.diff`,
      digest: canonicalJsonSha256({ diff: suffix }),
      origin_id: `github.com/acme/checkout:${TREE_SHA}:diff`,
      occurred_at: EVENT_TIME,
      source_authority: "observed",
    });
  }
  const manifestBody: Omit<FiestaCodeEvidenceV2, "digest"> = {
    schema_version: "fiesta.code-evidence.v2",
    manifest_id: `harness-manifest-${suffix}`,
    refs,
  };
  const manifest = parseMemoryContract("FiestaCodeEvidenceV2", {
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
      details: `When Fiesta observes timeout ${suffix}, it must inspect the terminal tool state before deciding whether another side-effecting call is safe.`,
      rationale: "A stable failure fingerprint prevents ambiguous timeouts from becoming unconditional retry guidance.",
    },
    applicability: {
      harness_id: "fiesta",
      harness_version_range: "harness-shadow-v1",
      workflow_version_range: "code-change.v3",
      adapter_version_range: "fiesta-pim-adapter.v1",
      configuration_ids: ["routing-default-v2"],
      model_ids: ["gpt-harness-shadow"],
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
      extractor_version: "fiesta-harness-extractor.v1",
      confidence: 1,
    },
    activation_requirement_requested: "authorized_review",
  });
  const receipt = parseMemoryContract("RunReceiptV1", {
    schema_version: "pim.run-receipt.v1",
    external_session_id: `fiesta-harness-thread-${suffix}`,
    producer: {
      harness_id: "fiesta",
      harness_version: "harness-shadow-v1",
      workflow_version: "code-change.v3",
      adapter_version: "fiesta-pim-adapter.v1",
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
  const harnessId = input.harnessId ?? "fiesta";
  return parseMemoryContract("MemoryHarnessSearchV1", {
    ...fixture,
    request_id: input.requestId ?? `harness-search-${randomUUID()}`,
    consumer: {
      harness_id: harnessId,
      harness_version: "harness-shadow-v1",
      workflow_version: "code-change.v3",
      adapter_version: "fiesta-pim-adapter.v1",
      consumer_run_id: `harness-consumer-${randomUUID()}`,
    },
    tenant: { project_id: input.projectId ?? context.projectA },
    applicability: {
      harness_id: harnessId,
      harness_version_range: "harness-shadow-v1",
      workflow_version_range: "code-change.v3",
      adapter_version_range: "fiesta-pim-adapter.v1",
      ...(input.configurationIds === null
        ? {}
        : { configuration_ids: input.configurationIds ?? ["routing-default-v2"] }),
      ...(input.modelIds === null
        ? {}
        : { model_ids: input.modelIds ?? ["gpt-harness-shadow"] }),
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

function mergeAttestation(fixture: ReturnType<typeof harnessFixture>): {
  attestation: MemoryAttestationV1;
  diffDigest: string;
} {
  const manifest = fixture.receipt.evidence_manifest!;
  const diff = manifest.refs.find((ref) => ref.type === "git_diff")!;
  const deliveryId = `harness-merge-${randomUUID()}`;
  return {
    attestation: parseMemoryContract("MemoryAttestationV1", {
      schema_version: "pim.memory-attestation.v1",
      attestation_id: `harness-attestation-${randomUUID()}`,
      provider_event_id: deliveryId,
      type: "github_merge",
      repository_id: FIESTA_REPOSITORY_ID,
      provider_pull_request_id: `github:acme/checkout#${randomUUID()}`,
      base_sha: BASE_SHA,
      head_sha: TREE_SHA,
      merge_sha: MERGE_SHA,
      manifest_digest: manifest.digest,
      occurred_at: new Date().toISOString(),
    }),
    diffDigest: diff.digest,
  };
}

async function postMergeAttestation(attestation: MemoryAttestationV1) {
  const rawBody = JSON.stringify(attestation);
  const signature = createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex");
  return context.app.inject({
    method: "POST",
    url: "/api/v1/memory/attestations/github",
    headers: {
      authorization: `Bearer ${context.attestTokenA}`,
      "content-type": "application/json",
      "x-github-delivery": attestation.provider_event_id,
      "x-github-event": "pull_request",
      "x-hub-signature-256": `sha256=${signature}`,
    },
    payload: rawBody,
  });
}

beforeAll(async () => {
  previousWebhookSecret = process.env.MEMORY_GITHUB_WEBHOOK_SECRET;
  previousActivationRepositories = process.env.MEMORY_ACTIVATION_REPOSITORIES;
  previousFiestaRepository = process.env.MEMORY_FIESTA_REPOSITORY_ID;
  process.env.MEMORY_GITHUB_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.MEMORY_ACTIVATION_REPOSITORIES = FIESTA_REPOSITORY_ID;
  process.env.MEMORY_FIESTA_REPOSITORY_ID = FIESTA_REPOSITORY_ID;
  context = await createMemoryTestContext();
  setMemoryGithubResolver(async ({ attestation }) => {
    const state = authoritativeStates.get(attestation.provider_event_id);
    if (!state) throw new Error("Missing authoritative harness merge state fixture");
    return state;
  });
});

afterAll(async () => {
  setMemoryGithubResolver(null);
  if (previousWebhookSecret === undefined) delete process.env.MEMORY_GITHUB_WEBHOOK_SECRET;
  else process.env.MEMORY_GITHUB_WEBHOOK_SECRET = previousWebhookSecret;
  if (previousActivationRepositories === undefined) delete process.env.MEMORY_ACTIVATION_REPOSITORIES;
  else process.env.MEMORY_ACTIVATION_REPOSITORIES = previousActivationRepositories;
  if (previousFiestaRepository === undefined) delete process.env.MEMORY_FIESTA_REPOSITORY_ID;
  else process.env.MEMORY_FIESTA_REPOSITORY_ID = previousFiestaRepository;
  if (context) await context.app.close();
});

describe("Slice 6 harness shadow memory", () => {
  it("accepts, reviews, and retrieves a repository-free harness lesson in permanent shadow", async () => {
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
      `SELECT plane, repository_row_id, harness_id, current_status,
              shadow_recall_eligible, prompt_eligible
       FROM memory_records WHERE record_id = ?`,
    ).get(recordId)).toEqual({
      plane: "harness",
      repository_row_id: null,
      harness_id: "fiesta",
      current_status: "active",
      shadow_recall_eligible: 1,
      prompt_eligible: 0,
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
      harness_id: "fiesta",
      shadow_only: true,
      routing_influence: false,
      prompt_eligible: false,
      evaluation_arm: "shadow",
    });
    expect(searched.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ record_id: recordId, prompt_eligible: false }),
    ]));
    expect(db.prepare(
      `SELECT repository_row_id, repository_id, harness_id, plane, prompt_eligible,
              evaluation_arm, prompt_item_count, prompt_token_count
       FROM memory_retrieval_packs WHERE retrieval_pack_id = ?`,
    ).get(searched.retrieval_pack_id)).toEqual({
      repository_row_id: null,
      repository_id: null,
      harness_id: "fiesta",
      plane: "harness",
      prompt_eligible: 0,
      evaluation_arm: "shadow",
      prompt_item_count: 0,
      prompt_token_count: 0,
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
    expect(verified?.auth.harnessBindings?.map((binding) => binding.harnessId)).toEqual(["fiesta"]);
  });

  it("enforces exact harness/project/scope boundaries and strict contracts", async () => {
    const otherHarness = await context.app.inject({
      method: "POST",
      url: "/api/v1/memory/harness/search",
      headers: auth(context.otherHarnessSearchTokenA),
      payload: searchRequest({ harnessId: "other-harness" }),
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
      harness_id: "fiesta",
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
      provenance: { extractor_version: "fiesta-harness-extractor.v2" },
    })).not.toBe(baseline);
  });

  it("keeps harness code-change lessons blocked without a verified Fiesta merge path", async () => {
    const fixture = harnessFixture(true);
    const acceptedResponse = await context.app.inject({
      method: "PUT",
      url: `/api/v1/memory/run-receipts/${encodeURIComponent(fixture.producerRunId)}`,
      headers: auth(context.harnessReceiptTokenA),
      payload: fixture.receipt,
    });
    expect(acceptedResponse.statusCode, acceptedResponse.body).toBe(200);
    const accepted = acceptedResponse.json().candidate_results[0];
    expect(accepted).toMatchObject({ status: "pending_review" });
    expect(accepted.blockers).toEqual(expect.arrayContaining([
      "authorized_review_required",
      "verified_fiesta_merge_required",
    ]));
    const review = await context.app.inject({
      method: "POST",
      url: `/api/v1/memory/candidates/${encodeURIComponent(accepted.candidate_id)}/decisions`,
      headers: auth(context.harnessReviewerTokenA),
      payload: decision(fixture.failureRefId),
    });
    expect(review.statusCode).toBe(409);
    expect(review.json()).toMatchObject({ code: "activation_requirement_unsatisfied" });
    expect(db.prepare(
      "SELECT active_record_id FROM memory_candidates_v1 WHERE candidate_id = ?",
    ).get(accepted.candidate_id)).toEqual({ active_record_id: null });
  });

  it("activates a harness code-change lesson only after the final Fiesta diff is independently verified", async () => {
    const fixture = harnessFixture(true);
    const acceptedResponse = await context.app.inject({
      method: "PUT",
      url: `/api/v1/memory/run-receipts/${encodeURIComponent(fixture.producerRunId)}`,
      headers: auth(context.harnessReceiptTokenA),
      payload: fixture.receipt,
    });
    expect(acceptedResponse.statusCode, acceptedResponse.body).toBe(200);
    const candidateId = acceptedResponse.json().candidate_results[0].candidate_id as string;
    const wrong = mergeAttestation(fixture);
    authoritativeStates.set(wrong.attestation.provider_event_id, {
      repositoryId: FIESTA_REPOSITORY_ID,
      providerPullRequestId: wrong.attestation.provider_pull_request_id!,
      merged: true,
      baseSha: BASE_SHA,
      headSha: TREE_SHA,
      mergeSha: MERGE_SHA,
      manifestDigest: wrong.attestation.manifest_digest,
      finalDiffDigest: canonicalJsonSha256({ wrong_diff: randomUUID() }),
      occurredAt: wrong.attestation.occurred_at,
      sourceCursor: wrong.attestation.provider_event_id,
    });
    const wrongResponse = await postMergeAttestation(wrong.attestation);
    expect(wrongResponse.statusCode, wrongResponse.body).toBe(200);

    const blocked = await context.app.inject({
      method: "POST",
      url: `/api/v1/memory/candidates/${encodeURIComponent(candidateId)}/decisions`,
      headers: auth(context.harnessReviewerTokenA),
      payload: decision(fixture.failureRefId),
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ code: "activation_requirement_unsatisfied" });

    const verified = mergeAttestation(fixture);
    authoritativeStates.set(verified.attestation.provider_event_id, {
      repositoryId: FIESTA_REPOSITORY_ID,
      providerPullRequestId: verified.attestation.provider_pull_request_id!,
      merged: true,
      baseSha: BASE_SHA,
      headSha: TREE_SHA,
      mergeSha: MERGE_SHA,
      manifestDigest: verified.attestation.manifest_digest,
      finalDiffDigest: verified.diffDigest,
      occurredAt: verified.attestation.occurred_at,
      sourceCursor: verified.attestation.provider_event_id,
    });
    const verifiedResponse = await postMergeAttestation(verified.attestation);
    expect(verifiedResponse.statusCode, verifiedResponse.body).toBe(200);
    expect(db.prepare(
      `SELECT authoritative_diff_digest FROM memory_attestations
       WHERE provider_event_id = ?`,
    ).get(verified.attestation.provider_event_id)).toEqual({
      authoritative_diff_digest: verified.diffDigest,
    });

    process.env.MEMORY_FIESTA_REPOSITORY_ID = "github.com/acme/not-fiesta";
    const wrongRepository = await context.app.inject({
      method: "POST",
      url: `/api/v1/memory/candidates/${encodeURIComponent(candidateId)}/decisions`,
      headers: auth(context.harnessReviewerTokenA),
      payload: decision(fixture.failureRefId),
    });
    expect(wrongRepository.statusCode).toBe(409);
    process.env.MEMORY_FIESTA_REPOSITORY_ID = FIESTA_REPOSITORY_ID;

    const reviewedResponse = await context.app.inject({
      method: "POST",
      url: `/api/v1/memory/candidates/${encodeURIComponent(candidateId)}/decisions`,
      headers: auth(context.harnessReviewerTokenA),
      payload: decision(fixture.failureRefId),
    });
    expect(reviewedResponse.statusCode, reviewedResponse.body).toBe(200);
    const recordId = reviewedResponse.json().active_record.record_id as string;
    const stored = db.prepare(
      "SELECT provenance_json FROM memory_record_versions WHERE record_id = ? AND record_version = 1",
    ).get(recordId) as { provenance_json: string };
    const provenance = JSON.parse(stored.provenance_json) as Record<string, unknown>;
    expect(provenance).toMatchObject({
      fiesta_merge_attestation_id: expect.any(String),
      fiesta_merge_repository_id: FIESTA_REPOSITORY_ID,
      fiesta_merge_sha: MERGE_SHA,
      shadow_only: true,
    });
    const mergeAttestationId = provenance.fiesta_merge_attestation_id;
    expect(typeof mergeAttestationId).toBe("string");
    expect(db.prepare(
      `SELECT COUNT(*) AS count FROM memory_origins
       WHERE org_id = ? AND project_id = ? AND source_type = 'github_attestation'
         AND attestation_row_id = ?`,
    ).get(
      context.orgA.id,
      context.projectA,
      mergeAttestationId as string,
    )).toEqual({ count: 1 });
  });

  it("counts a same-project cross-harness pack item as boundary leakage", () => {
    const row = db.prepare(
      `SELECT pack.retrieval_pack_id
       FROM memory_retrieval_packs pack
       INNER JOIN memory_retrieval_pack_items item
         ON item.retrieval_pack_id = pack.retrieval_pack_id
       WHERE pack.org_id = ? AND pack.project_id = ? AND pack.plane = 'harness'
         AND pack.harness_id = 'fiesta'
       ORDER BY pack.created_at DESC LIMIT 1`,
    ).get(context.orgA.id, context.projectA) as { retrieval_pack_id: string } | undefined;
    expect(row).toBeDefined();
    db.prepare(
      "UPDATE memory_retrieval_packs SET harness_id = 'other-harness' WHERE retrieval_pack_id = ?",
    ).run(row!.retrieval_pack_id);
    try {
      expect(getMemoryOperationalSnapshot(
        context.orgA.id,
        context.projectA,
      ).crossBoundaryLeakageCount).toBeGreaterThanOrEqual(1);
    } finally {
      db.prepare(
        "UPDATE memory_retrieval_packs SET harness_id = 'fiesta' WHERE retrieval_pack_id = ?",
      ).run(row!.retrieval_pack_id);
    }
    expect(getMemoryOperationalSnapshot(
      context.orgA.id,
      context.projectA,
    ).crossBoundaryLeakageCount).toBe(0);
  });
});
