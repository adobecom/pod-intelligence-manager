import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MEMORY_CONTRACT_FIXTURES,
  canonicalJsonSha256,
  parseMemoryContract,
  type CodeEvidenceManifestV2,
  type MemoryCandidateV1,
  type MemoryFeedbackResultV1,
  type MemoryFeedbackV1,
  type MemorySearchResultV1,
  type MemorySearchV1,
  type RunReceiptResultV1,
  type RunReceiptV1,
} from "@pim/shared";
import db from "../../db/connection.js";
import { runMemoryOutboxPass } from "../../services/memory-outbox.js";
import { createMemoryTestContext, type MemoryTestContext } from "./memory-test-app.js";

const BASE_SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_BASE_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TREE_SHA = "89abcdef0123456789abcdef0123456789abcdef";
const REPOSITORY_ID = "github.com/acme/checkout";

let context: MemoryTestContext;

interface FeedbackTarget {
  producerRunId: string;
  pack: MemorySearchResultV1;
  item: MemorySearchResultV1["items"][number];
  receipt: RunReceiptResultV1;
  candidateId?: string;
}

function uniqueId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function searchRequest(producerRunId: string): MemorySearchV1 {
  const request = structuredClone(
    MEMORY_CONTRACT_FIXTURES.MemorySearchV1,
  ) as unknown as MemorySearchV1;
  request.request_id = uniqueId("feedback-search");
  request.consumer.consumer_run_id = producerRunId;
  request.tenant.project_id = context.projectA;
  request.applicability = {
    repository_id: REPOSITORY_ID,
    base_sha: BASE_SHA,
    components: ["payments"],
    paths: ["src/payments/retry.ts"],
    symbols: ["retryCharge"],
  };
  return parseMemoryContract("MemorySearchV1", request);
}

function candidateForRun(producerRunId: string): {
  candidate: MemoryCandidateV1;
  manifest: CodeEvidenceManifestV2;
} {
  const evidenceRefId = uniqueId("feedback-diff");
  const evidenceRefs: CodeEvidenceManifestV2["refs"] = [{
    id: evidenceRefId,
    type: "git_diff",
    uri: `https://github.com/acme/checkout/commit/${TREE_SHA}.diff`,
    digest: canonicalJsonSha256(`feedback evidence ${evidenceRefId}`),
    origin_id: `${REPOSITORY_ID}:${TREE_SHA}:${evidenceRefId}`,
    occurred_at: "2026-08-03T18:42:00.000Z",
    source_authority: "observed",
  }];
  const manifestBase = {
    schema_version: "pim.memory-code-evidence.v2" as const,
    manifest_id: uniqueId("feedback-manifest"),
    refs: evidenceRefs,
  };
  const manifest = parseMemoryContract("CodeEvidenceManifestV2", {
    ...manifestBase,
    digest: canonicalJsonSha256(manifestBase),
  });
  const fixture = structuredClone(
    MEMORY_CONTRACT_FIXTURES.MemoryCandidateV1,
  ) as unknown as MemoryCandidateV1;
  const candidate = parseMemoryContract("MemoryCandidateV1", {
    ...fixture,
    client_candidate_id: uniqueId("feedback-candidate"),
    applicability: {
      repository_id: REPOSITORY_ID,
      base_sha: BASE_SHA,
      paths: ["src/payments/provider.ts"],
      symbols: ["lookupTransaction"],
      task_classes: ["bug_fix"],
    },
    source_run_ids: [producerRunId],
    evidence_refs: [evidenceRefId],
  });
  return { candidate, manifest };
}

function receiptForRun(
  producerRunId: string,
  candidateInput?: ReturnType<typeof candidateForRun>,
): RunReceiptV1 {
  const receipt = structuredClone(
    MEMORY_CONTRACT_FIXTURES.RunReceiptV1,
  ) as unknown as RunReceiptV1;
  receipt.external_session_id = `${producerRunId}:session`;
  receipt.tenant = { project_id: context.projectA };
  receipt.repository = {
    repository_id: REPOSITORY_ID,
    display_slug: "Acme/Checkout",
    base_sha: BASE_SHA,
    candidate_tree_sha: TREE_SHA,
    provider_pull_request_id: "github:acme/checkout#814",
    pr_head_sha: TREE_SHA,
    pull_request_url: "https://github.com/acme/checkout/pull/814",
  };
  receipt.retrieval_feedback = [];
  receipt.candidates = candidateInput ? [candidateInput.candidate] : [];
  if (candidateInput) receipt.evidence_manifest = candidateInput.manifest;
  else delete receipt.evidence_manifest;
  return parseMemoryContract("RunReceiptV1", receipt);
}

async function createFeedbackTarget(withCandidate = false): Promise<FeedbackTarget> {
  const producerRunId = uniqueId("feedback-run");
  const search = await context.app.inject({
    method: "POST",
    url: "/api/v1/memory/search",
    headers: auth(context.tokenA),
    payload: searchRequest(producerRunId),
  });
  expect(search.statusCode).toBe(200);
  const pack = parseMemoryContract("MemorySearchResultV1", search.json());
  const item = pack.items[0];
  expect(item).toMatchObject({
    record_id: context.seededRecordId,
    record_version: 1,
  });

  const candidateInput = withCandidate ? candidateForRun(producerRunId) : undefined;
  const receiptResponse = await context.app.inject({
    method: "PUT",
    url: `/api/v1/memory/run-receipts/${encodeURIComponent(producerRunId)}`,
    headers: {
      ...auth(context.receiptTokenA),
      "idempotency-key": `feedback-receipt-${producerRunId}`,
    },
    payload: receiptForRun(producerRunId, candidateInput),
  });
  expect(receiptResponse.statusCode).toBe(200);
  const receipt = parseMemoryContract("RunReceiptResultV1", receiptResponse.json());
  if (withCandidate) {
    expect(receipt.candidate_results[0]).toMatchObject({ status: "pending_merge" });
  }
  return {
    producerRunId,
    pack,
    item: item!,
    receipt,
    candidateId: receipt.candidate_results[0]?.candidate_id,
  };
}

function feedbackFor(
  target: FeedbackTarget,
  overrides: Partial<MemoryFeedbackV1> = {},
): MemoryFeedbackV1 {
  return parseMemoryContract("MemoryFeedbackV1", {
    schema_version: "pim.memory-feedback.v1",
    feedback_revision: 1,
    retrieval_pack_id: target.pack.retrieval_pack_id,
    record_id: target.item.record_id,
    record_version: target.item.record_version,
    producer_run_id: target.producerRunId,
    repository_id: REPOSITORY_ID,
    base_sha: BASE_SHA,
    disposition: "helpful",
    reason_code: "feedback_fixture_helpful",
    outcome_evidence_refs: [],
    event_time: "2026-08-03T20:00:00.000Z",
    ...overrides,
  });
}

async function postFeedback(
  feedback: MemoryFeedbackV1,
  token = context.feedbackTokenA,
) {
  return context.app.inject({
    method: "POST",
    url: "/api/v1/memory/feedback",
    headers: auth(token),
    payload: feedback,
  });
}

beforeAll(async () => {
  context = await createMemoryTestContext();
});

afterAll(async () => {
  if (context) await context.app.close();
});

describe("Slice 4 later memory feedback", () => {
  it("accepts only the exact pack, record version, run, repository, and pinned base", async () => {
    const target = await createFeedbackTarget();
    const exact = await postFeedback(feedbackFor(target));
    expect(exact.statusCode).toBe(200);
    expect(parseMemoryContract("MemoryFeedbackResultV1", exact.json())).toMatchObject({
      feedback_revision: 1,
      duplicate: false,
      review_signal_ids: [],
    });

    const mismatches: Array<[string, Partial<MemoryFeedbackV1>]> = [
      ["pack", { retrieval_pack_id: uniqueId("missing-pack") }],
      ["record", { record_id: uniqueId("missing-record") }],
      ["version", { record_version: target.item.record_version + 1 }],
      ["run", { producer_run_id: uniqueId("different-run") }],
      ["repository", { repository_id: "github.com/acme/empty" }],
      ["base", { base_sha: OTHER_BASE_SHA }],
    ];
    for (const [label, override] of mismatches) {
      const response = await postFeedback(feedbackFor(target, {
        feedback_revision: 2,
        reason_code: `mismatched_${label}`,
        ...override,
      }));
      expect(response.statusCode, label).toBe(label === "repository" ? 403 : 422);
      expect(response.json(), label).toMatchObject({
        schema_version: "pim.error.v1",
        code: label === "repository" ? "resource_binding_mismatch" : "evidence_mismatch",
      });
    }
  });

  it("enforces feedback scope and keeps another tenant isolated", async () => {
    const target = await createFeedbackTarget();
    const body = feedbackFor(target);

    const wrongScope = await postFeedback(body, context.tokenA);
    expect(wrongScope.statusCode).toBe(403);
    expect(wrongScope.json()).toMatchObject({ code: "resource_binding_mismatch" });

    const otherTenant = await postFeedback(body, context.feedbackTokenB);
    expect(otherTenant.statusCode).toBe(422);
    expect(otherTenant.json()).toMatchObject({ code: "evidence_mismatch" });
    expect(otherTenant.body).not.toContain(context.orgA.id);

    expect((db.prepare(
      `SELECT COUNT(*) AS count FROM memory_feedback
       WHERE retrieval_pack_id = ? AND feedback_stage = 'later'`,
    ).get(target.pack.retrieval_pack_id) as { count: number }).count).toBe(0);
  });

  it("returns the original result for an identical duplicate without adding a row", async () => {
    const target = await createFeedbackTarget();
    const body = feedbackFor(target);
    const first = await postFeedback(body);
    const replay = await postFeedback(body);
    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().feedback_id).toBe(first.json().feedback_id);
    expect((db.prepare(
      `SELECT COUNT(*) AS count FROM memory_feedback
       WHERE retrieval_pack_id = ? AND feedback_stage = 'later'`,
    ).get(target.pack.retrieval_pack_id) as { count: number }).count).toBe(1);
    expect(replay.json()).toEqual(first.json());
  });

  it("rejects changed content under the same feedback identity with 409", async () => {
    const target = await createFeedbackTarget();
    const body = feedbackFor(target);
    const first = await postFeedback(body);
    expect(first.statusCode).toBe(200);

    const conflict = await postFeedback(feedbackFor(target, {
      reason_code: "changed_body_same_identity",
    }));
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      schema_version: "pim.error.v1",
      code: "idempotency_conflict",
    });
    expect((db.prepare(
      `SELECT COUNT(*) AS count FROM memory_feedback
       WHERE retrieval_pack_id = ? AND feedback_stage = 'later'`,
    ).get(target.pack.retrieval_pack_id) as { count: number }).count).toBe(1);
  });

  it("appends a later correction revision without overwriting the original", async () => {
    const target = await createFeedbackTarget();
    const original = feedbackFor(target, {
      disposition: "neutral",
      reason_code: "initial_neutral_observation",
    });
    const correction = feedbackFor(target, {
      feedback_revision: 2,
      disposition: "corrected",
      reason_code: "later_correction",
      event_time: "2026-08-03T21:00:00.000Z",
    });
    const first = await postFeedback(original);
    const second = await postFeedback(correction);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(parseMemoryContract("MemoryFeedbackResultV1", second.json())).toMatchObject({
      feedback_revision: 2,
      duplicate: false,
    });

    const rows = db.prepare(
      `SELECT feedback_revision, feedback_json FROM memory_feedback
       WHERE retrieval_pack_id = ? AND record_id = ? AND record_version = ?
         AND producer_run_id = ? AND feedback_stage = 'later'
       ORDER BY feedback_revision`,
    ).all(
      target.pack.retrieval_pack_id,
      target.item.record_id,
      target.item.record_version,
      target.producerRunId,
    ) as unknown as Array<{ feedback_revision: number; feedback_json: string }>;
    expect(rows.map((row) => row.feedback_revision)).toEqual([1, 2]);
    expect(JSON.parse(rows[0]!.feedback_json)).toEqual(original);
    expect(JSON.parse(rows[1]!.feedback_json)).toEqual(correction);
  });

  it("cannot rewrite a record or activate or alter a pending candidate", async () => {
    const target = await createFeedbackTarget(true);
    expect(target.candidateId).toBeDefined();
    const recordBefore = db.prepare(
      `SELECT record.current_status, record.current_version, record.aggregate_version,
              record.shadow_recall_eligible, version.content_json, version.content_digest
       FROM memory_records record
       INNER JOIN memory_record_versions version
         ON version.record_id = record.record_id
        AND version.record_version = record.current_version
       WHERE record.record_id = ?`,
    ).get(target.item.record_id);
    const candidateBefore = db.prepare(
      `SELECT current_status, aggregate_version, candidate_json, active_record_id,
              active_record_version
       FROM memory_candidates_v1 WHERE candidate_id = ?`,
    ).get(target.candidateId!);

    const response = await postFeedback(feedbackFor(target, {
      disposition: "harmful",
      reason_code: "harmful_but_not_authoritative",
    }));
    expect(response.statusCode).toBe(200);

    expect(db.prepare(
      `SELECT record.current_status, record.current_version, record.aggregate_version,
              record.shadow_recall_eligible, version.content_json, version.content_digest
       FROM memory_records record
       INNER JOIN memory_record_versions version
         ON version.record_id = record.record_id
        AND version.record_version = record.current_version
       WHERE record.record_id = ?`,
    ).get(target.item.record_id)).toEqual(recordBefore);
    expect(db.prepare(
      `SELECT current_status, aggregate_version, candidate_json, active_record_id,
              active_record_version
       FROM memory_candidates_v1 WHERE candidate_id = ?`,
    ).get(target.candidateId!)).toEqual(candidateBefore);
    expect(candidateBefore).toMatchObject({
      current_status: "pending_merge",
      active_record_id: null,
      active_record_version: null,
    });
  });

  it("creates one durable harmful review signal and notification job", async () => {
    const target = await createFeedbackTarget();
    const response = await postFeedback(feedbackFor(target, {
      disposition: "harmful",
      reason_code: "harmful_checkout_outcome",
    }));
    expect(response.statusCode).toBe(200);
    const result = parseMemoryContract("MemoryFeedbackResultV1", response.json());
    expect(result.review_signal_ids).toHaveLength(1);

    const signals = db.prepare(
      `SELECT signal_id, signal_type, status, reason_code
       FROM memory_review_signals WHERE feedback_id = ? ORDER BY signal_type`,
    ).all(result.feedback_id);
    expect(signals).toEqual([{
      signal_id: result.review_signal_ids[0],
      signal_type: "harmful_review",
      status: "open",
      reason_code: "harmful_checkout_outcome",
    }]);
    expect(db.prepare(
      `SELECT job_type, aggregate_type, aggregate_id, status
       FROM memory_outbox
       WHERE json_extract(payload_json, '$.feedback_id') = ?`,
    ).all(result.feedback_id)).toEqual([{
      job_type: "review_notification",
      aggregate_type: "record",
      aggregate_id: target.item.record_id,
      status: "pending",
    }]);
    expect(runMemoryOutboxPass({
      maxJobs: 1,
      aggregateIds: [target.item.record_id],
      jobTypes: ["review_notification"],
    })).toEqual({ claimed: 1, completed: 1, retried: 0, deadLettered: 0 });
  });

  it("creates stale review and checkout revalidation signals with a revalidation outbox job", async () => {
    const target = await createFeedbackTarget();
    const response = await postFeedback(feedbackFor(target, {
      disposition: "stale",
      reason_code: "checkout_anchor_no_longer_resolves",
    }));
    expect(response.statusCode).toBe(200);
    const result = parseMemoryContract("MemoryFeedbackResultV1", response.json());
    expect(result.review_signal_ids).toHaveLength(2);

    const signals = db.prepare(
      `SELECT signal_type, status FROM memory_review_signals
       WHERE feedback_id = ? ORDER BY signal_type`,
    ).all(result.feedback_id);
    expect(signals).toEqual([
      { signal_type: "checkout_anchor_revalidation", status: "open" },
      { signal_type: "stale_review", status: "open" },
    ]);
    const jobs = db.prepare(
      `SELECT job_type, aggregate_id, status FROM memory_outbox
       WHERE json_extract(payload_json, '$.feedback_id') = ? ORDER BY job_type`,
    ).all(result.feedback_id);
    expect(jobs).toEqual([
      { job_type: "record_revalidation", aggregate_id: target.item.record_id, status: "pending" },
      { job_type: "review_notification", aggregate_id: target.item.record_id, status: "pending" },
    ]);
    expect(runMemoryOutboxPass({
      maxJobs: 2,
      aggregateIds: [target.item.record_id],
      jobTypes: ["record_revalidation", "review_notification"],
    })).toEqual({ claimed: 2, completed: 2, retried: 0, deadLettered: 0 });
  });
});
