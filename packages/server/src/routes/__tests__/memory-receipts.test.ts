import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MEMORY_CONTRACT_FIXTURES,
  canonicalJsonSha256,
  parseMemoryContract,
  parseMemoryContractV2,
  type CodeEvidenceManifestV2,
  type MemoryCandidateStatusV1,
  type MemoryCandidateV1,
  type MemorySearchResultV1,
  type MemorySearchV1,
  type RunReceiptResultV1,
  type RunReceiptV1,
} from "@pim/shared";
import db from "../../db/connection.js";
import { createMemoryTestContext, type MemoryTestContext } from "./memory-test-app.js";

const BASE_SHA = "0123456789abcdef0123456789abcdef01234567";
const TREE_SHA = "89abcdef0123456789abcdef0123456789abcdef";

let context: MemoryTestContext;

function uniqueId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function evidenceManifest(input: {
  manifestId: string;
  refId: string;
  uri?: string;
  type?: CodeEvidenceManifestV2["refs"][number]["type"];
}): CodeEvidenceManifestV2 {
  const refs: CodeEvidenceManifestV2["refs"] = [{
    id: input.refId,
    type: input.type ?? "git_diff",
    uri: input.uri ?? `https://github.com/acme/checkout/commit/${TREE_SHA}.diff`,
    digest: canonicalJsonSha256(`evidence:${input.refId}`),
    origin_id: `github.com/acme/checkout:${TREE_SHA}:${input.refId}`,
    occurred_at: "2026-08-03T18:42:00.000Z",
    source_authority: "observed",
  }];
  const manifestWithoutDigest = {
    schema_version: "pim.memory-code-evidence.v2" as const,
    manifest_id: input.manifestId,
    refs,
  };
  return parseMemoryContractV2("CodeEvidenceManifestV2", {
    ...manifestWithoutDigest,
    digest: canonicalJsonSha256(manifestWithoutDigest),
  });
}

function codebaseCandidate(input: {
  producerRunId: string;
  clientCandidateId?: string;
  evidenceRefId: string;
  marker?: string;
  repositoryId?: string;
}): MemoryCandidateV1 {
  const marker = input.marker ?? uniqueId("receiptCandidateMarker").replaceAll("-", "");
  const fixture = structuredClone(
    MEMORY_CONTRACT_FIXTURES.MemoryCandidateV1,
  ) as unknown as MemoryCandidateV1;
  return parseMemoryContract("MemoryCandidateV1", {
    ...fixture,
    client_candidate_id: input.clientCandidateId ?? uniqueId("client-candidate"),
    content: {
      summary: `Preserve the ${marker} repository invariant.`,
      details: `The ${marker} implementation must retain every typed candidate field through receipt storage and status projection.`,
      rationale: `Losing ${marker} would make later evidence correlation unsafe.`,
    },
    applicability: {
      repository_id: input.repositoryId ?? "github.com/acme/checkout",
      base_sha: BASE_SHA,
      paths: [`src/${marker}.ts`],
      symbols: [marker],
      task_classes: ["bug_fix"],
    },
    validation: { strategy: "repository_anchors" },
    exceptions: [`Does not apply outside the ${marker} code path.`],
    source_run_ids: [input.producerRunId],
    evidence_refs: [input.evidenceRefId],
    extraction: {
      method: "model_then_deterministic_validation",
      extractor_version: "fiesta-candidate-extractor.test-v1",
      confidence: 0.91,
    },
    activation_requirement_requested: "verified_merge",
    extensions: { fixture_marker: marker, retryable: false },
  });
}

function harnessCandidate(input: {
  producerRunId: string;
  evidenceRefId: string;
}): MemoryCandidateV1 {
  return parseMemoryContract("MemoryCandidateV1", {
    schema_version: "pim.memory-candidate.v1",
    client_candidate_id: uniqueId("harness-candidate"),
    plane: "harness",
    kind: "constraint",
    content: {
      summary: "Retry this harness failure only after recovery evidence.",
      details: "A stable harness failure fingerprint must remain plane-separated until the harness shadow slice is enabled.",
      rationale: "One producer run cannot make a harness routing lesson active codebase memory.",
    },
    applicability: {
      harness_id: "example-harness-a",
      harness_version_range: ">=1.0.0",
      workflow_version_range: "code-change.v3",
    },
    validation: {
      strategy: "stable_failure_fingerprint",
      failure_fingerprint: "fixture:harness:retry-exhausted:v1",
    },
    exceptions: ["Does not apply to deterministic policy rejection."],
    source_run_ids: [input.producerRunId],
    evidence_refs: [input.evidenceRefId],
    extraction: {
      method: "deterministic",
      extractor_version: "example-harness-a-harness-fixture.v1",
      confidence: 1,
    },
    activation_requirement_requested: "authorized_review",
  });
}

function receipt(input: {
  producerRunId: string;
  projectId: string;
  repositoryId?: string;
  outcomeStatus?: "completed" | "failed" | "cancelled";
  manifest?: CodeEvidenceManifestV2;
  candidates?: MemoryCandidateV1[];
  retrievalFeedback?: RunReceiptV1["retrieval_feedback"];
  taskSummary?: string;
}): RunReceiptV1 {
  const fixture = structuredClone(
    MEMORY_CONTRACT_FIXTURES.RunReceiptV1,
  ) as unknown as RunReceiptV1;
  const outcomeStatus = input.outcomeStatus ?? "completed";
  return parseMemoryContract("RunReceiptV1", {
    ...fixture,
    external_session_id: `${input.producerRunId}:session`,
    tenant: { project_id: input.projectId },
    repository: {
      repository_id: input.repositoryId ?? "github.com/acme/checkout",
      display_slug: input.repositoryId === "github.com/acme/not-bound"
        ? "Acme/Not-Bound"
        : "Acme/Checkout",
      base_sha: BASE_SHA,
      candidate_tree_sha: TREE_SHA,
      provider_pull_request_id: "github:acme/checkout#814",
      pr_head_sha: TREE_SHA,
      pull_request_url: "https://github.com/acme/checkout/pull/814",
    },
    task: {
      task_class: "bug_fix",
      summary: input.taskSummary ?? "Preserve a typed memory candidate through the Slice 2 receipt ledger.",
    },
    outcome: {
      status: outcomeStatus,
      terminal_stage: outcomeStatus === "cancelled" ? "cancelled" : "close",
      reason_code: outcomeStatus === "completed" ? "completed" : `${outcomeStatus}_fixture`,
      verification_status: outcomeStatus === "completed" ? "passed" : outcomeStatus === "failed" ? "failed" : "not_run",
      publication_status: outcomeStatus === "completed" ? "draft_pr_created" : "none",
      gate_attestation_ids: [],
      failure_fingerprint: outcomeStatus === "failed" ? "fixture:verification-failed:v1" : null,
    },
    retrieval_feedback: input.retrievalFeedback ?? [],
    ...(input.manifest ? { evidence_manifest: input.manifest } : {}),
    candidates: input.candidates ?? [],
  });
}

async function putReceipt(
  producerRunId: string,
  body: object,
  token = context.receiptTokenA,
) {
  return context.app.inject({
    method: "PUT",
    url: `/api/v1/memory/run-receipts/${encodeURIComponent(producerRunId)}`,
    headers: {
      ...auth(token),
      "idempotency-key": `receipt-v1-${producerRunId}`,
    },
    payload: body,
  });
}

async function createPendingCandidate(input: {
  projectId?: string;
  token?: string;
  marker?: string;
} = {}): Promise<{
  producerRunId: string;
  candidate: MemoryCandidateV1;
  result: RunReceiptResultV1;
  status: MemoryCandidateStatusV1;
}> {
  const producerRunId = uniqueId("fiesta-run");
  const refId = uniqueId("diff");
  const manifest = evidenceManifest({ manifestId: uniqueId("manifest"), refId });
  const candidate = codebaseCandidate({ producerRunId, evidenceRefId: refId, marker: input.marker });
  const response = await putReceipt(
    producerRunId,
    receipt({
      producerRunId,
      projectId: input.projectId ?? context.projectA,
      manifest,
      candidates: [candidate],
    }),
    input.token,
  );
  expect(response.statusCode).toBe(200);
  const result = parseMemoryContract("RunReceiptResultV1", response.json());
  const candidateResult = result.candidate_results[0];
  expect(candidateResult).toMatchObject({
    client_candidate_id: candidate.client_candidate_id,
    status: "pending_merge",
  });
  expect(candidateResult?.blockers).toContain("verified_merge_required");

  const detail = await context.app.inject({
    method: "GET",
    url: `/api/v1/memory/candidates/${encodeURIComponent(candidateResult!.candidate_id)}`,
    headers: auth(
      input.projectId === context.projectB
        ? context.candidateReadTokenB
        : context.candidateReadTokenA,
    ),
  });
  expect(detail.statusCode).toBe(200);
  return {
    producerRunId,
    candidate,
    result,
    status: parseMemoryContract("MemoryCandidateStatusV1", detail.json()),
  };
}

async function searchPack(
  consumerRunId: string,
  baseSha = BASE_SHA,
): Promise<MemorySearchResultV1> {
  const request = structuredClone(
    MEMORY_CONTRACT_FIXTURES.MemorySearchV1,
  ) as unknown as MemorySearchV1;
  request.request_id = uniqueId("receipt-feedback-search");
  request.consumer.consumer_run_id = consumerRunId;
  request.applicability = { ...request.applicability, base_sha: baseSha };
  request.tenant.project_id = context.projectA;
  const response = await context.app.inject({
    method: "POST",
    url: "/api/v1/memory/search",
    headers: auth(context.tokenA),
    payload: request,
  });
  expect(response.statusCode).toBe(200);
  const result = parseMemoryContract("MemorySearchResultV1", response.json());
  expect(result.items[0]?.record_id).toBe(context.seededRecordId);
  return result;
}

beforeAll(async () => {
  context = await createMemoryTestContext();
});

afterAll(async () => {
  if (context) await context.app.close();
});

describe("Slice 2 receipt and candidate HTTP path", () => {
  it("preserves every typed codebase candidate field and parks it pending_merge", async () => {
    const created = await createPendingCandidate();
    const candidateId = created.result.candidate_results[0]!.candidate_id;
    const stored = db.prepare(
      `SELECT candidate_json, current_status, activation_requirement, blockers_json
       FROM memory_candidates_v1 WHERE candidate_id = ?`,
    ).get(candidateId) as {
      candidate_json: string;
      current_status: string;
      activation_requirement: string;
      blockers_json: string;
    } | undefined;

    expect(stored).toBeDefined();
    expect(JSON.parse(stored!.candidate_json)).toEqual(created.candidate);
    expect(stored).toMatchObject({
      current_status: "pending_merge",
      activation_requirement: "verified_merge",
    });
    expect(JSON.parse(stored!.blockers_json)).toEqual(["verified_merge_required"]);
    expect(created.status).toMatchObject({
      candidate_id: candidateId,
      client_candidate_id: created.candidate.client_candidate_id,
      plane: "codebase",
      kind: created.candidate.kind,
      status: "pending_merge",
      activation_requirement: "verified_merge",
      blockers: ["verified_merge_required"],
      latest_transition: {
        from_status: "validating",
        to_status: "pending_merge",
        reason_code: "verified_merge_required",
      },
    });
  });

  it("replays an identical receipt with the same IDs and rejects a changed body", async () => {
    const producerRunId = uniqueId("fiesta-replay-run");
    const refId = uniqueId("diff");
    const manifest = evidenceManifest({ manifestId: uniqueId("manifest"), refId });
    const candidate = codebaseCandidate({ producerRunId, evidenceRefId: refId });
    const body = receipt({
      producerRunId,
      projectId: context.projectA,
      manifest,
      candidates: [candidate],
    });

    const first = await putReceipt(producerRunId, body);
    const replay = await putReceipt(producerRunId, body);
    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());

    const changed = structuredClone(body);
    changed.task.summary = "This changed immutable receipt body must produce an idempotency conflict.";
    const conflict = await putReceipt(producerRunId, changed);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      schema_version: "pim.error.v1",
      code: "idempotency_conflict",
    });

    expect((db.prepare(
      "SELECT COUNT(*) AS count FROM memory_run_receipts WHERE producer_run_id = ?",
    ).get(producerRunId) as { count: number }).count).toBe(1);
    expect((db.prepare(
      "SELECT COUNT(*) AS count FROM memory_candidates_v1 WHERE client_candidate_id = ?",
    ).get(candidate.client_candidate_id) as { count: number }).count).toBe(1);
  });

  it("replays an exact historical repository-optional receipt without parsing legacy response fields", async () => {
    const producerRunId = uniqueId("historical-empty-replay");
    const receiptId = uniqueId("historical-receipt");
    const currentRequest = receipt({
      producerRunId,
      projectId: context.projectA,
      candidates: [],
    });
    delete currentRequest.repository;
    const historicalManifest = {
      schema_version: "fiesta.code-evidence.v2",
      manifest_id: uniqueId("historical-manifest"),
      refs: [],
    };
    const historicalRequest = {
      ...currentRequest,
      evidence_manifest: {
        ...historicalManifest,
        digest: canonicalJsonSha256(historicalManifest),
      },
    };
    expect(() => parseMemoryContract("RunReceiptV1", historicalRequest)).toThrow();
    const requestDigest = canonicalJsonSha256(historicalRequest);
    const historicalResponseJson = JSON.stringify({
      schema_version: "pim.run-receipt-result.v1",
      receipt_id: receiptId,
      producer_run_id: producerRunId,
      request_digest: requestDigest,
      status: "accepted",
      candidate_results: [],
      evaluation_arm: "shadow",
      shadow_only: true,
      shadow_summary: {
        selected_arm: "shadow",
        prompt_eligible: false,
        routing_eligible: false,
      },
    });
    expect(() => parseMemoryContract(
      "RunReceiptResultV1",
      JSON.parse(historicalResponseJson),
    )).toThrow();

    db.prepare(`
      INSERT INTO memory_run_receipts (
        receipt_id, org_id, project_id, producer_run_id, schema_major,
        idempotency_key, request_digest, receipt_json, response_json,
        producer_harness_id, repository_row_id, repository_id, base_sha,
        outcome_status, created_at
      ) VALUES (?, ?, ?, ?, 'pim.run-receipt.v1', NULL, ?, ?, ?, ?, NULL, NULL, NULL,
                'completed', ?)
    `).run(
      receiptId,
      context.orgA.id,
      context.projectA,
      producerRunId,
      requestDigest,
      JSON.stringify(historicalRequest),
      historicalResponseJson,
      historicalRequest.producer.harness_id,
      "2026-08-03T18:42:00.000Z",
    );
    expect(db.prepare(
      "SELECT 1 FROM memory_v2_receipt_facets WHERE receipt_id = ?",
    ).get(receiptId)).toBeUndefined();

    const replay = await putReceipt(producerRunId, historicalRequest);
    expect(replay.statusCode).toBe(200);
    expect(replay.headers["content-type"]).toContain("application/json");
    expect(replay.body).toBe(historicalResponseJson);
    expect(db.prepare(
      "SELECT 1 FROM memory_v2_receipt_facets WHERE receipt_id = ?",
    ).get(receiptId)).toBeUndefined();

    const changedRequest = structuredClone(historicalRequest);
    changedRequest.task.summary = "Changed historical content must conflict.";
    const conflict = await putReceipt(producerRunId, changedRequest);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      schema_version: "pim.error.v1",
      code: "idempotency_conflict",
    });

    const widenedRequest = structuredClone(historicalRequest);
    widenedRequest.repository = {
      repository_id: "github.com/acme/empty",
      display_slug: "Acme/Empty",
      base_sha: BASE_SHA,
      candidate_tree_sha: TREE_SHA,
      provider_pull_request_id: "github:acme/empty#1",
      pr_head_sha: TREE_SHA,
      pull_request_url: "https://github.com/acme/empty/pull/1",
    };
    const unauthorizedSelector = await putReceipt(producerRunId, widenedRequest);
    expect(unauthorizedSelector.statusCode).toBe(403);
    expect(unauthorizedSelector.json()).toMatchObject({ code: "resource_binding_mismatch" });
  });

  it("rejects receipt project and repository scope widening before persistence", async () => {
    const projectRunId = uniqueId("fiesta-project-mismatch");
    const projectMismatch = await putReceipt(
      projectRunId,
      receipt({ producerRunId: projectRunId, projectId: context.projectB }),
    );
    expect(projectMismatch.statusCode).toBe(403);
    expect(projectMismatch.json()).toMatchObject({ code: "resource_binding_mismatch" });

    const repositoryRunId = uniqueId("fiesta-repository-mismatch");
    const repositoryMismatch = await putReceipt(
      repositoryRunId,
      receipt({
        producerRunId: repositoryRunId,
        projectId: context.projectA,
        repositoryId: "github.com/acme/not-bound",
      }),
    );
    expect(repositoryMismatch.statusCode).toBe(403);
    expect(repositoryMismatch.json()).toMatchObject({ code: "resource_binding_mismatch" });

    const registeredRepositoryRunId = uniqueId("fiesta-registered-repository-mismatch");
    const registeredRepositoryMismatch = await putReceipt(
      registeredRepositoryRunId,
      receipt({
        producerRunId: registeredRepositoryRunId,
        projectId: context.projectA,
        repositoryId: "github.com/acme/empty",
      }),
    );
    expect(registeredRepositoryMismatch.statusCode).toBe(403);
    expect(registeredRepositoryMismatch.json()).toMatchObject({ code: "resource_binding_mismatch" });

    for (const producerRunId of [projectRunId, repositoryRunId, registeredRepositoryRunId]) {
      expect(db.prepare(
        "SELECT receipt_id FROM memory_run_receipts WHERE producer_run_id = ?",
      ).get(producerRunId)).toBeUndefined();
    }
  });

  it("uses a non-enumerating 404 for cross-tenant candidate status", async () => {
    const created = await createPendingCandidate({
      projectId: context.projectB,
      token: context.receiptTokenB,
    });
    const candidateId = created.result.candidate_results[0]!.candidate_id;
    const crossTenant = await context.app.inject({
      method: "GET",
      url: `/api/v1/memory/candidates/${encodeURIComponent(candidateId)}`,
      headers: auth(context.candidateReadTokenA),
    });
    expect(crossTenant.statusCode).toBe(404);
    expect(crossTenant.json()).toMatchObject({
      schema_version: "pim.error.v1",
      code: "resource_not_found",
    });
    expect(JSON.stringify(crossTenant.json())).not.toContain(created.candidate.content.summary);
  });

  it.each(["failed", "cancelled"] as const)(
    "accepts a feedback-only %s terminal receipt",
    async (outcomeStatus) => {
      const producerRunId = uniqueId(`fiesta-${outcomeStatus}-run`);
      const pack = await searchPack(producerRunId);
      const item = pack.items[0]!;
      const body = receipt({
        producerRunId,
        projectId: context.projectA,
        outcomeStatus,
        candidates: [],
        retrievalFeedback: [{
          retrieval_pack_id: pack.retrieval_pack_id,
          items: [{
            record_id: item.record_id,
            record_version: item.record_version,
            checkout_validation: {
              disposition: outcomeStatus === "failed" ? "stale" : "validated",
              reason_code: `${outcomeStatus}_checkout_fixture`,
            },
            terminal_outcome: {
              use_disposition: outcomeStatus === "failed" ? "ignored" : "applied",
              use_attribution_confidence: 1,
              utility: outcomeStatus === "failed" ? "unknown" : "neutral",
              utility_source: "deterministic_outcome",
              reason_code: `${outcomeStatus}_terminal_fixture`,
            },
          }],
        }],
      });
      const response = await putReceipt(producerRunId, body);
      expect(response.statusCode).toBe(200);
      expect(parseMemoryContract("RunReceiptResultV1", response.json()).candidate_results).toEqual([]);
      const stored = db.prepare(
        `SELECT receipt_id, outcome_status FROM memory_run_receipts
         WHERE org_id = ? AND project_id = ? AND producer_run_id = ?`,
      ).get(context.orgA.id, context.projectA, producerRunId) as {
        receipt_id: string;
        outcome_status: string;
      } | undefined;
      expect(stored?.outcome_status).toBe(outcomeStatus);
      expect((db.prepare(
        "SELECT COUNT(*) AS count FROM memory_feedback WHERE receipt_id = ?",
      ).get(stored!.receipt_id) as { count: number }).count).toBe(1);
    },
  );

  it("rejects feedback attributed to another consumer run or pinned base", async () => {
    const actualRunId = uniqueId("feedback-actual-run");
    const pack = await searchPack(actualRunId);
    const item = pack.items[0]!;
    const feedback = [{
      retrieval_pack_id: pack.retrieval_pack_id,
      items: [{
        record_id: item.record_id,
        record_version: item.record_version,
        checkout_validation: { disposition: "validated" as const, reason_code: "exact_fixture" },
        terminal_outcome: {
          use_disposition: "unknown" as const,
          use_attribution_confidence: 1,
          utility: "unknown" as const,
          utility_source: "unknown" as const,
          reason_code: "exact_fixture",
        },
      }],
    }];

    const wrongRunId = uniqueId("feedback-wrong-run");
    const wrongRun = await putReceipt(wrongRunId, receipt({
      producerRunId: wrongRunId,
      projectId: context.projectA,
      candidates: [],
      retrievalFeedback: feedback,
    }));
    expect(wrongRun.statusCode).toBe(422);
    expect(wrongRun.json()).toMatchObject({ code: "evidence_mismatch" });

    const wrongBaseRunId = uniqueId("feedback-wrong-base");
    const wrongBasePack = await searchPack(wrongBaseRunId, "f".repeat(40));
    const wrongBaseItem = wrongBasePack.items[0]!;
    const wrongBase = await putReceipt(wrongBaseRunId, receipt({
      producerRunId: wrongBaseRunId,
      projectId: context.projectA,
      candidates: [],
      retrievalFeedback: [{
        retrieval_pack_id: wrongBasePack.retrieval_pack_id,
        items: [{
          ...feedback[0]!.items[0]!,
          record_id: wrongBaseItem.record_id,
          record_version: wrongBaseItem.record_version,
        }],
      }],
    }));
    expect(wrongBase.statusCode).toBe(422);
    expect(wrongBase.json()).toMatchObject({ code: "evidence_mismatch" });
  });

  it("retains a fingerprint-mismatched harness candidate as a rejected plane-separated audit row", async () => {
    const producerRunId = uniqueId("example-harness-a-harness-run");
    const refId = uniqueId("failure");
    const manifest = evidenceManifest({
      manifestId: uniqueId("harness-manifest"),
      refId,
      type: "failure",
    });
    const candidate = harnessCandidate({ producerRunId, evidenceRefId: refId });
    const body = receipt({
      producerRunId,
      projectId: context.projectA,
      outcomeStatus: "failed",
      manifest,
      candidates: [candidate],
    });
    body.producer.harness_id = (candidate.applicability as { harness_id: string }).harness_id;
    delete body.repository;
    const response = await putReceipt(producerRunId, body, context.harnessReceiptTokenA);
    expect(response.statusCode, response.body).toBe(200);
    const result = parseMemoryContract("RunReceiptResultV1", response.json());
    expect(result.candidate_results[0]).toMatchObject({
      client_candidate_id: candidate.client_candidate_id,
      status: "rejected",
    });
    expect(result.candidate_results[0]!.blockers).toContain("stable_failure_fingerprint_mismatch");

    const stored = db.prepare(
      `SELECT candidate_json, plane, repository_row_id, current_status, blockers_json
       FROM memory_candidates_v1 WHERE candidate_id = ?`,
    ).get(result.candidate_results[0]!.candidate_id) as {
      candidate_json: string;
      plane: string;
      repository_row_id: string | null;
      current_status: string;
      blockers_json: string;
    } | undefined;
    expect(JSON.parse(stored!.candidate_json)).toEqual(candidate);
    expect(stored).toMatchObject({
      plane: "harness",
      repository_row_id: null,
      current_status: "rejected",
    });
    expect(JSON.parse(stored!.blockers_json)).toContain("stable_failure_fingerprint_mismatch");
  });

  it.each([
    ["caller-issued evidence URI", `pim-evidence://fixture-manifest/diff`],
    ["local file evidence URI", "file:///tmp/pim-memory-fixture.diff"],
  ])("rejects a prohibited %s", async (_label, uri) => {
    const producerRunId = uniqueId("fiesta-bad-evidence-run");
    const refId = uniqueId("diff");
    const manifest = evidenceManifest({ manifestId: uniqueId("manifest"), refId, uri });
    const candidate = codebaseCandidate({ producerRunId, evidenceRefId: refId });
    const response = await putReceipt(
      producerRunId,
      receipt({
        producerRunId,
        projectId: context.projectA,
        manifest,
        candidates: [candidate],
      }),
    );
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      schema_version: "pim.error.v1",
      code: "evidence_unresolvable",
    });
    expect(db.prepare(
      "SELECT receipt_id FROM memory_run_receipts WHERE producer_run_id = ?",
    ).get(producerRunId)).toBeUndefined();
  });

  it("rejects oversized receipts and evidence manifests before persistence", async () => {
    const oversizedRunId = uniqueId("fiesta-oversized-run");
    const oversizedReceipt = {
      ...receipt({
        producerRunId: oversizedRunId,
        projectId: context.projectA,
      }),
      padding: "x".repeat(
        MEMORY_CONTRACT_FIXTURES.MemoryCapabilitiesV1.limits.max_receipt_bytes + 1,
      ),
    } as unknown as RunReceiptV1;
    const oversized = await putReceipt(oversizedRunId, oversizedReceipt);
    expect(oversized.statusCode).toBe(413);
    expect(db.prepare(
      "SELECT receipt_id FROM memory_run_receipts WHERE producer_run_id = ?",
    ).get(oversizedRunId)).toBeUndefined();

    const manifestRunId = uniqueId("fiesta-oversized-manifest-run");
    const refs = Array.from({
      length: MEMORY_CONTRACT_FIXTURES.MemoryCapabilitiesV1.limits.max_evidence_refs + 1,
    }, (_, index) => ({
      id: `ref-${index}`,
      type: "test_run" as const,
      uri: `https://github.com/acme/checkout/actions/runs/${index}`,
      digest: canonicalJsonSha256({ index }),
      origin_id: `github-actions:${index}`,
      occurred_at: "2026-08-03T00:00:00.000Z",
      source_authority: "verified" as const,
    }));
    const manifestBody = {
      schema_version: "pim.memory-code-evidence.v2" as const,
      manifest_id: uniqueId("oversized-manifest"),
      refs,
    };
    const oversizedManifestReceipt = {
      ...receipt({
        producerRunId: manifestRunId,
        projectId: context.projectA,
      }),
      evidence_manifest: {
        ...manifestBody,
        digest: canonicalJsonSha256(manifestBody),
      },
    } as unknown as RunReceiptV1;
    const oversizedManifest = await putReceipt(manifestRunId, oversizedManifestReceipt);
    expect(oversizedManifest.statusCode).toBe(413);
    expect(oversizedManifest.json()).toMatchObject({ code: "schema_invalid" });
    expect(db.prepare(
      "SELECT receipt_id FROM memory_run_receipts WHERE producer_run_id = ?",
    ).get(manifestRunId)).toBeUndefined();
  });

  it("rejects secret-shaped receipt content without echoing or persisting it", async () => {
    const producerRunId = uniqueId("fiesta-secret-run");
    const secret = `ghp_${"a".repeat(36)}`;
    const response = await putReceipt(
      producerRunId,
      receipt({
        producerRunId,
        projectId: context.projectA,
        taskSummary: `Investigate leaked credential ${secret} without retaining it.`,
      }),
    );
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      schema_version: "pim.error.v1",
      code: "schema_invalid",
    });
    expect(response.body).not.toContain(secret);
    expect(db.prepare(
      "SELECT receipt_id FROM memory_run_receipts WHERE producer_run_id = ?",
    ).get(producerRunId)).toBeUndefined();
  });

  it("never exposes a pending candidate through active-memory search", async () => {
    const marker = uniqueId("pendingCandidateOnly").replaceAll("-", "");
    const created = await createPendingCandidate({ marker });
    const candidateId = created.result.candidate_results[0]!.candidate_id;

    const request = structuredClone(
      MEMORY_CONTRACT_FIXTURES.MemorySearchV1,
    ) as unknown as MemorySearchV1;
    request.request_id = uniqueId("pending-candidate-search");
    request.tenant.project_id = context.projectA;
    request.task.query = marker;
    request.applicability = {
      repository_id: "github.com/acme/checkout",
      base_sha: BASE_SHA,
      paths: [`src/${marker}.ts`],
      symbols: [marker],
    };
    const response = await context.app.inject({
      method: "POST",
      url: "/api/v1/memory/search",
      headers: auth(context.tokenA),
      payload: request,
    });
    expect(response.statusCode).toBe(200);
    const result = parseMemoryContract("MemorySearchResultV1", response.json());
    expect(result.items.map((item) => item.record_id)).not.toContain(candidateId);
    expect(result.items.map((item) => item.summary)).not.toContain(created.candidate.content.summary);
    expect(db.prepare(
      "SELECT record_id FROM memory_records WHERE record_id = ?",
    ).get(candidateId)).toBeUndefined();
  });
});
