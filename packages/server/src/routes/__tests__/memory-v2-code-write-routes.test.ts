import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canonicalJsonSha256,
  MEMORY_CONTRACT_FIXTURES,
  MEMORY_CONTRACT_FIXTURES_V2,
  parseMemoryContractV2,
  type CodebaseMemorySearchV2,
  type CodebaseRunReceiptV2,
  type MemoryFeedbackV2,
  type MemorySearchResultV2,
} from "@pim/shared";
import db from "../../db/connection.js";
import { validateMemoryCandidate } from "../../services/memory-candidates.js";
import { scanMemoryV2Input } from "../../services/memory-v2-input-safety.js";
import { resolveMemoryV2Resource } from "../../services/memory-v2-resources.js";
import { createServiceToken } from "../../services/service-tokens.js";
import {
  createMemoryTestContext,
  type MemoryTestContext,
} from "./memory-test-app.js";

const REPOSITORY_ID = "github.com/acme/checkout";
const EMPTY_REPOSITORY_ID = "github.com/acme/empty";

let context: MemoryTestContext;
let writeToken: string;
let emptyCandidateToken: string;

function suffix(): string {
  return randomUUID().replaceAll("-", "").slice(0, 16);
}

function auth(token = writeToken): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function safeEvidenceManifest(input: {
  marker: string;
  refs: CodebaseRunReceiptV2["evidence_manifest"]["refs"];
}): CodebaseRunReceiptV2["evidence_manifest"] {
  for (let attempt = 0; attempt < 256; attempt++) {
    const body = {
      schema_version: "pim.memory-code-evidence.v2" as const,
      manifest_id: `manifest-slice3-http-${input.marker}-${attempt}`,
      refs: input.refs,
    };
    const manifest = { ...body, digest: canonicalJsonSha256(body) };
    if (scanMemoryV2Input(manifest).clean) return manifest;
  }
  throw new Error("Could not construct a deterministic safety-clean evidence manifest");
}

async function searchPack(input: {
  marker: string;
  producerRunId: string;
  baseSha?: string;
  query?: string;
}): Promise<MemorySearchResultV2> {
  const fixture = structuredClone(
    MEMORY_CONTRACT_FIXTURES_V2.MemorySearchV2,
  ) as unknown as CodebaseMemorySearchV2;
  const response = await context.app.inject({
    method: "POST",
    url: "/api/v2/memory/search",
    headers: auth(),
    payload: {
      ...fixture,
      request_id: `slice3-http-pack-${input.marker}`,
      consumer: { ...fixture.consumer, consumer_run_id: input.producerRunId },
      tenant: { project_id: context.projectA },
      resource_selector: { canonical_resource_id: REPOSITORY_ID },
      applicability: {
        ...fixture.applicability,
        repository_id: REPOSITORY_ID,
        base_sha: input.baseSha ?? "a".repeat(40),
      },
      task: input.query
        ? { ...fixture.task, query: input.query, task_class: "bug_fix" }
        : fixture.task,
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return parseMemoryContractV2("MemorySearchResultV2", response.json());
}

function buildReceipt(input: {
  marker: string;
  producerRunId: string;
  baseSha: string;
  pack: MemorySearchResultV2;
  embeddedFeedback?: boolean;
  candidate?: boolean;
}): { receipt: CodebaseRunReceiptV2; evidenceRefId: string; clientCandidateId: string } {
  const source = structuredClone(
    MEMORY_CONTRACT_FIXTURES_V2.RunReceiptV2,
  ) as unknown as CodebaseRunReceiptV2;
  const evidenceRefId = `failure-slice3-http-${input.marker}`;
  const clientCandidateId = `candidate-slice3-http-${input.marker}`;
  const failureFingerprint = `failure:slice3-http:${input.marker}`;
  const manifestRefs: CodebaseRunReceiptV2["evidence_manifest"]["refs"] =
    input.candidate === false ? [] : [{
      id: evidenceRefId,
      type: "failure" as const,
      uri: `https://github.com/acme/checkout/commit/${input.baseSha}.diff`,
      digest: `sha256:${"f".repeat(64)}`,
      origin_id: `${REPOSITORY_ID}:failure:${input.marker}`,
      occurred_at: "2026-08-08T16:00:00.000Z",
      source_authority: "observed" as const,
    }];
  const item = input.pack.items[0]!;
  const candidates: CodebaseRunReceiptV2["candidates"] = input.candidate === false
    ? []
    : [{
        schema_version: "pim.memory-candidate.v2",
        client_candidate_id: clientCandidateId,
        plane: "codebase",
        resource_row_id: input.pack.resource_binding.resource_row_id,
        scope_snapshot_digest: input.pack.scope_snapshot_digest,
        kind: "anti_pattern",
        subkind: null,
        content: {
          summary: "Avoid replaying an ambiguous provider request blindly.",
          details: "Resolve the exact failed provider event before retrying so an ambiguous result cannot duplicate the original side effect.",
          rationale: "The captured failure proves that a blind retry is unsafe for this repository path.",
        },
        applicability: {
          plane: "codebase",
          repository_id: REPOSITORY_ID,
          base_sha: input.baseSha,
          components: ["payments"],
          paths: ["src/payments/provider.ts"],
          symbols: ["lookupTransaction"],
          task_classes: ["bug_fix"],
        },
        validation: {
          strategy: "stable_failure_fingerprint",
          anchor_refs: [],
          failure_fingerprint: failureFingerprint,
        },
        exceptions: ["Does not apply after the provider proves that no side effect occurred."],
        source_run_ids: [input.producerRunId],
        evidence_refs: [evidenceRefId],
        extraction: {
          method: "model_then_deterministic_validation",
          extractor_version: "slice3-http-route-test",
          confidence: 0.95,
        },
        activation_requirement_requested: "authorized_review",
      }];
  return {
    evidenceRefId,
    clientCandidateId,
    receipt: {
      schema_version: "pim.run-receipt.v2",
      external_session_id: `slice3-http-session-${input.marker}`,
      producer: { ...source.producer, consumer_run_id: input.producerRunId },
      tenant: { project_id: context.projectA },
      plane: "codebase",
      resource_selector: { canonical_resource_id: REPOSITORY_ID },
      scope_snapshot: {
        schema_version: "pim.memory-scope-snapshot.codebase.v2",
        plane: "codebase",
        resource_binding: input.pack.resource_binding,
        repository_id: REPOSITORY_ID,
        base_sha: input.baseSha,
        scope_snapshot_digest: input.pack.scope_snapshot_digest,
      },
      task: {
        task_class: "bug_fix",
        summary: "Keep the failed retry scoped to the exact repository snapshot.",
      },
      outcome: {
        status: "completed",
        terminal_stage: "close",
        reason_code: "failure_review_ready",
        verification_status: "passed",
        failure_fingerprint: input.candidate === false ? null : failureFingerprint,
      },
      retrieval_feedback: input.embeddedFeedback === false ? [] : [{
        retrieval_pack_id: input.pack.retrieval_pack_id,
        scope_snapshot_digest: input.pack.scope_snapshot_digest,
        record_id: item.record_id,
        record_version: item.record_version,
        disposition: "helpful",
        reason_code: "slice3_http_pack_helped",
      }],
      evidence_manifest: safeEvidenceManifest({ marker: input.marker, refs: manifestRefs }),
      candidates,
    },
  };
}

function feedbackFor(input: {
  pack: MemorySearchResultV2;
  producerRunId: string;
  reasonCode?: string;
}): MemoryFeedbackV2 {
  return {
    schema_version: "pim.memory-feedback.v2",
    feedback_revision: 1,
    retrieval_pack_id: input.pack.retrieval_pack_id,
    record_id: input.pack.items[0]!.record_id,
    record_version: input.pack.items[0]!.record_version,
    producer_run_id: input.producerRunId,
    plane: "codebase",
    resource_row_id: input.pack.resource_binding.resource_row_id,
    scope_snapshot_digest: input.pack.scope_snapshot_digest,
    disposition: "helpful",
    reason_code: input.reasonCode ?? "slice3_http_later_helpful",
    outcome_evidence_refs: [],
    event_time: "2026-08-08T16:05:00.000Z",
  };
}

async function putReceipt(input: {
  producerRunId: string;
  idempotencyKey: string;
  receipt: object;
}) {
  return context.app.inject({
    method: "PUT",
    url: `/api/v2/memory/run-receipts/${encodeURIComponent(input.producerRunId)}`,
    headers: { ...auth(), "idempotency-key": input.idempotencyKey },
    payload: input.receipt,
  });
}

async function postFeedback(input: {
  idempotencyKey: string;
  feedback: object;
  token?: string;
}) {
  return context.app.inject({
    method: "POST",
    url: "/api/v2/memory/feedback",
    headers: {
      ...auth(input.token),
      "idempotency-key": input.idempotencyKey,
    },
    payload: input.feedback,
  });
}

beforeAll(async () => {
  context = await createMemoryTestContext({}, { v2Reads: true, v2Writes: true });
  const owner = db.prepare(
    "SELECT created_by_user_id FROM projects WHERE project_id = ?",
  ).get(context.projectA) as { created_by_user_id: string };
  writeToken = createServiceToken({
    orgId: context.orgA.id,
    name: "Slice 3 HTTP exact repository authority",
    scopes: [
      "memory:search",
      "memory:receipt:write",
      "memory:feedback:write",
      "memory:candidate:read",
      "memory:review",
    ],
    createdByUserId: owner.created_by_user_id,
    projectId: context.projectA,
    repositoryIds: [REPOSITORY_ID],
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  }).token;
  emptyCandidateToken = createServiceToken({
    orgId: context.orgA.id,
    name: "Slice 3 HTTP other repository candidate reader",
    scopes: ["memory:candidate:read"],
    createdByUserId: owner.created_by_user_id,
    projectId: context.projectA,
    repositoryIds: [EMPTY_REPOSITORY_ID],
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  }).token;
});

afterAll(async () => {
  if (context) await context.app.close();
});

describe("Slice 3 code memory HTTP write surface", () => {
  it("persists one typed receipt, v2-only feedback, governed status, and HTTP-only decision", async () => {
    const marker = suffix();
    const producerRunId = `example-harness-a:test:slice3-http:${marker}`;
    const baseSha = "b".repeat(40);
    const pack = await searchPack({ marker, producerRunId, baseSha });
    expect(pack.items.length).toBeGreaterThan(0);
    const fixture = buildReceipt({ marker, producerRunId, baseSha, pack });
    const idempotencyKey = `slice3-http-receipt-${marker}`;
    const legacyFeedbackBefore = (db.prepare(
      "SELECT COUNT(*) AS count FROM memory_feedback",
    ).get() as { count: number }).count;
    const migratedRecordBefore = db.prepare(
      `SELECT record.current_status, record.current_version, version.content_digest
       FROM memory_records AS record
       INNER JOIN memory_record_versions AS version
         ON version.record_id = record.record_id
        AND version.record_version = record.current_version
       WHERE record.record_id = ?`,
    ).get(context.seededRecordId);

    const acceptedResponse = await putReceipt({
      producerRunId,
      idempotencyKey,
      receipt: fixture.receipt,
    });
    expect(acceptedResponse.statusCode, acceptedResponse.body).toBe(200);
    expect(acceptedResponse.headers["cache-control"]).toBe("private, no-store");
    const accepted = parseMemoryContractV2("RunReceiptResultV2", acceptedResponse.json());
    expect(accepted).toMatchObject({
      producer_run_id: producerRunId,
      plane: "codebase",
      scope_snapshot_digest: pack.scope_snapshot_digest,
      status: "accepted",
      duplicate: false,
    });
    expect(accepted.candidate_results).toHaveLength(1);
    const candidateId = accepted.candidate_results[0]!.candidate_id;

    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM memory_v2_scope_snapshots WHERE receipt_id = ?",
    ).get(accepted.receipt_id)).toEqual({ count: 1 });
    expect(db.prepare(
      `SELECT feedback_stage, feedback_revision, COUNT(*) AS count
       FROM memory_v2_feedback_bindings
       WHERE receipt_id = ? GROUP BY feedback_stage, feedback_revision`,
    ).all(accepted.receipt_id)).toEqual([{
      feedback_stage: "receipt",
      feedback_revision: 0,
      count: 1,
    }]);
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM memory_v2_receipt_facets WHERE receipt_id = ?",
    ).get(accepted.receipt_id)).toEqual({ count: 1 });
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM memory_v2_candidate_facets WHERE candidate_id = ?",
    ).get(candidateId)).toEqual({ count: 1 });
    expect((db.prepare(
      "SELECT COUNT(*) AS count FROM memory_feedback",
    ).get() as { count: number }).count).toBe(legacyFeedbackBefore);

    const replayResponse = await putReceipt({
      producerRunId,
      idempotencyKey,
      receipt: fixture.receipt,
    });
    expect(replayResponse.statusCode, replayResponse.body).toBe(200);
    expect(parseMemoryContractV2("RunReceiptResultV2", replayResponse.json())).toMatchObject({
      receipt_id: accepted.receipt_id,
      request_digest: accepted.request_digest,
      status: "replayed",
      duplicate: true,
    });

    const changedReceipt = structuredClone(fixture.receipt);
    changedReceipt.task.summary = "Changed immutable receipt content must conflict.";
    const conflict = await putReceipt({ producerRunId, idempotencyKey, receipt: changedReceipt });
    expect(conflict.statusCode, conflict.body).toBe(409);
    expect(conflict.json()).toMatchObject({
      schema_version: "pim.error.v2",
      code: "idempotency_conflict",
      plane: "codebase",
      retryable: false,
    });
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM memory_v2_scope_snapshots WHERE receipt_id = ?",
    ).get(accepted.receipt_id)).toEqual({ count: 1 });

    const status = await context.app.inject({
      method: "GET",
      url: `/api/v2/memory/candidates/${encodeURIComponent(candidateId)}`,
      headers: auth(),
    });
    expect(status.statusCode, status.body).toBe(200);
    expect(parseMemoryContractV2("MemoryCandidateStatusV2", status.json())).toMatchObject({
      candidate_id: candidateId,
      status: "accepted",
      active_record: null,
    });
    expect(db.prepare(
      "SELECT active_record_id FROM memory_candidates_v1 WHERE candidate_id = ?",
    ).get(candidateId)).toEqual({ active_record_id: null });
    const pendingRecordId = `mem_${candidateId.slice("candidate_".length)}`;
    const pendingSearch = await searchPack({
      marker: `${marker}-pending-candidate`,
      producerRunId: `${producerRunId}:pending-search`,
      baseSha,
      query: fixture.receipt.candidates[0]!.content.summary,
    });
    expect(pendingSearch.items.map((item) => item.record_id)).not.toContain(pendingRecordId);
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM memory_records WHERE record_id = ?",
    ).get(pendingRecordId)).toEqual({ count: 0 });

    const missing = await context.app.inject({
      method: "GET",
      url: "/api/v2/memory/candidates/candidate-does-not-exist",
      headers: auth(),
    });
    const crossTenant = await context.app.inject({
      method: "GET",
      url: `/api/v2/memory/candidates/${encodeURIComponent(candidateId)}`,
      headers: auth(context.candidateReadTokenB),
    });
    const crossResource = await context.app.inject({
      method: "GET",
      url: `/api/v2/memory/candidates/${encodeURIComponent(candidateId)}`,
      headers: auth(emptyCandidateToken),
    });
    for (const response of [missing, crossTenant, crossResource]) {
      expect(response.statusCode, response.body).toBe(404);
      expect(response.json()).toMatchObject({
        schema_version: "pim.error.v2",
        code: "resource_not_found",
        plane: "codebase",
        retryable: false,
        details: [],
      });
      expect(response.body).not.toContain(context.orgA.id);
      expect(response.body).not.toContain(fixture.receipt.candidates[0]!.content.summary);
    }

    const feedback = feedbackFor({ pack, producerRunId });
    const feedbackKey = `slice3-http-feedback-${marker}`;
    const feedbackResponse = await postFeedback({
      idempotencyKey: feedbackKey,
      feedback,
    });
    expect(feedbackResponse.statusCode, feedbackResponse.body).toBe(200);
    const feedbackResult = parseMemoryContractV2(
      "MemoryFeedbackResultV2",
      feedbackResponse.json(),
    );
    expect(feedbackResult).toMatchObject({ feedback_revision: 1, duplicate: false });
    const feedbackReplay = await postFeedback({
      idempotencyKey: feedbackKey,
      feedback,
    });
    expect(feedbackReplay.statusCode, feedbackReplay.body).toBe(200);
    expect(parseMemoryContractV2("MemoryFeedbackResultV2", feedbackReplay.json())).toMatchObject({
      feedback_id: feedbackResult.feedback_id,
      feedback_revision: 1,
      duplicate: true,
    });
    const changedFeedback = { ...feedback, reason_code: "same_key_changed_feedback" };
    const feedbackConflict = await postFeedback({
      idempotencyKey: feedbackKey,
      feedback: changedFeedback,
    });
    expect(feedbackConflict.statusCode, feedbackConflict.body).toBe(409);
    expect(feedbackConflict.json()).toMatchObject({ code: "idempotency_conflict" });

    const missingPack = await postFeedback({
      idempotencyKey: `slice3-http-missing-pack-${marker}`,
      feedback: { ...feedback, retrieval_pack_id: `missing-pack-${marker}` },
    });
    expect(missingPack.statusCode, missingPack.body).toBe(422);
    expect(missingPack.json()).toMatchObject({ code: "evidence_mismatch" });
    const emptyResource = resolveMemoryV2Resource({
      orgId: context.orgA.id,
      projectId: context.projectA,
      plane: "codebase",
      canonicalResourceId: EMPTY_REPOSITORY_ID,
    });
    expect(emptyResource).not.toBeNull();
    const wrongResource = await postFeedback({
      idempotencyKey: `slice3-http-wrong-resource-${marker}`,
      feedback: { ...feedback, resource_row_id: emptyResource!.resourceRowId },
    });
    expect(wrongResource.statusCode, wrongResource.body).toBe(403);
    expect(wrongResource.json()).toMatchObject({ code: "resource_binding_mismatch" });
    expect(db.prepare(
      `SELECT feedback_stage, feedback_revision, COUNT(*) AS count
       FROM memory_v2_feedback_bindings
       WHERE receipt_id = ? GROUP BY feedback_stage, feedback_revision
       ORDER BY feedback_revision`,
    ).all(accepted.receipt_id)).toEqual([
      { feedback_stage: "receipt", feedback_revision: 0, count: 1 },
      { feedback_stage: "later", feedback_revision: 1, count: 1 },
    ]);
    expect((db.prepare(
      "SELECT COUNT(*) AS count FROM memory_feedback",
    ).get() as { count: number }).count).toBe(legacyFeedbackBefore);

    const candidateRow = db.prepare(
      "SELECT aggregate_version FROM memory_candidates_v1 WHERE candidate_id = ?",
    ).get(candidateId) as { aggregate_version: number };
    validateMemoryCandidate(candidateId, candidateRow.aggregate_version);
    const boundaryEvidenceRefs = [
      fixture.evidenceRefId,
      ...Array.from(
        { length: 63 },
        (_, index) => `boundary-evidence-${index}-${marker}`,
      ),
    ];
    const decisionBase = {
      schema_version: "pim.memory-candidate-decision.v2" as const,
      decision_revision: 1,
      plane: "codebase" as const,
      resource_row_id: pack.resource_binding.resource_row_id,
      decision: "reject" as const,
      reason_code: "slice3_http_scope_too_broad",
      explanation: "x".repeat(1_000),
      evidence_refs: boundaryEvidenceRefs,
      event_time: "2026-08-08T16:10:00.000Z",
    };
    const outOfBoundsDecisions = [
      {
        body: { ...decisionBase, explanation: "x".repeat(1_001) },
        path: "/explanation",
      },
      {
        body: {
          ...decisionBase,
          evidence_refs: [...boundaryEvidenceRefs, `boundary-evidence-64-${marker}`],
        },
        path: "/evidence_refs",
      },
    ];
    for (const invalid of outOfBoundsDecisions) {
      const response = await context.app.inject({
        method: "POST",
        url: `/api/v2/memory/candidates/${encodeURIComponent(candidateId)}/decisions`,
        headers: auth(),
        payload: invalid.body,
      });
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json()).toMatchObject({
        schema_version: "pim.error.v2",
        code: "transition_invalid",
        plane: "codebase",
        retryable: false,
        details: [expect.objectContaining({ path: invalid.path })],
      });
    }
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM memory_candidate_decisions WHERE candidate_id = ?",
    ).get(candidateId)).toEqual({ count: 0 });
    expect(db.prepare(
      "SELECT current_status FROM memory_candidates_v1 WHERE candidate_id = ?",
    ).get(candidateId)).toEqual({ current_status: "pending_review" });

    const decisionResponse = await context.app.inject({
      method: "POST",
      url: `/api/v2/memory/candidates/${encodeURIComponent(candidateId)}/decisions`,
      headers: auth(),
      payload: decisionBase,
    });
    expect(decisionResponse.statusCode, decisionResponse.body).toBe(200);
    expect(parseMemoryContractV2(
      "MemoryCandidateDecisionResultV2",
      decisionResponse.json(),
    )).toMatchObject({
      candidate_id: candidateId,
      decision: "reject",
      candidate_status: "rejected",
      active_record: null,
    });

    expect(db.prepare(
      `SELECT record.current_status, record.current_version, version.content_digest
       FROM memory_records AS record
       INNER JOIN memory_record_versions AS version
         ON version.record_id = record.record_id
        AND version.record_version = record.current_version
       WHERE record.record_id = ?`,
    ).get(context.seededRecordId)).toEqual(migratedRecordBefore);
    const v1Search = structuredClone(MEMORY_CONTRACT_FIXTURES.MemorySearchV1);
    const v1Response = await context.app.inject({
      method: "POST",
      url: "/api/v1/memory/search",
      headers: auth(context.tokenA),
      payload: {
        ...v1Search,
        request_id: `slice3-v1-preserved-${marker}`,
        tenant: { project_id: context.projectA },
        applicability: {
          ...v1Search.applicability,
          repository_id: REPOSITORY_ID,
          base_sha: baseSha,
        },
      },
    });
    expect(v1Response.statusCode, v1Response.body).toBe(200);
    expect(v1Response.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ record_id: context.seededRecordId, record_version: 1 }),
    ]));
  });

  it("rejects secrets, personal data, oversized candidates, and unknown input before effects", async () => {
    const marker = suffix();
    const producerRunId = `example-harness-a:test:slice3-http-safety:${marker}`;
    const baseSha = "c".repeat(40);
    const pack = await searchPack({ marker, producerRunId, baseSha });
    const fixture = buildReceipt({ marker, producerRunId, baseSha, pack });
    const cases: Array<[string, object, number, string]> = [
      [
        "secret",
        {
          ...fixture.receipt,
          task: { ...fixture.receipt.task, summary: "AWS key AKIAIOSFODNN7EXAMPLE" },
        },
        422,
        "secret_shaped_content",
      ],
      [
        "personal-data",
        {
          ...fixture.receipt,
          task: { ...fixture.receipt.task, summary: "Operator SSN 123-45-6789 must not persist" },
        },
        422,
        "disallowed_personal_data",
      ],
      [
        "unknown-field",
        { ...fixture.receipt, unknown_private_field: "must-not-persist" },
        400,
        "schema_invalid",
      ],
    ];
    for (const [label, receipt, expectedStatus, expectedReason] of cases) {
      const response = await putReceipt({
        producerRunId,
        idempotencyKey: `slice3-http-safety-${label}-${marker}`,
        receipt,
      });
      expect(response.statusCode, `${label}: ${response.body}`).toBe(expectedStatus);
      expect(response.json()).toMatchObject({
        schema_version: "pim.error.v2",
        code: "schema_invalid",
        plane: "codebase",
        retryable: false,
      });
      if (label !== "unknown-field") {
        expect(response.json().details).toEqual(expect.arrayContaining([
          expect.objectContaining({ reason: expectedReason }),
        ]));
      }
    }

    const oversized = structuredClone(fixture.receipt);
    oversized.candidates[0]!.exceptions = Array.from(
      { length: 32 },
      (_, index) => `${String(index).padStart(2, "0")}-${"x".repeat(997)}`,
    );
    const oversizedResponse = await putReceipt({
      producerRunId,
      idempotencyKey: `slice3-http-oversized-${marker}`,
      receipt: oversized,
    });
    expect(oversizedResponse.statusCode, oversizedResponse.body).toBe(413);
    expect(oversizedResponse.json()).toMatchObject({
      schema_version: "pim.error.v2",
      code: "schema_invalid",
    });

    const unknownFeedback = await postFeedback({
      idempotencyKey: `slice3-http-feedback-unknown-${marker}`,
      feedback: { ...feedbackFor({ pack, producerRunId }), unexpected: true },
    });
    expect(unknownFeedback.statusCode, unknownFeedback.body).toBe(400);
    expect(unknownFeedback.json()).toMatchObject({ code: "schema_invalid" });
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM memory_run_receipts WHERE producer_run_id = ?",
    ).get(producerRunId)).toEqual({ count: 0 });
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM memory_v2_scope_snapshots WHERE producer_run_id = ?",
    ).get(producerRunId)).toEqual({ count: 0 });
  });

  it("rolls the core receipt and candidate back when the v2 companion insert fails", async () => {
    const marker = suffix();
    const producerRunId = `example-harness-a:test:slice3-http-rollback:${marker}`;
    const baseSha = "e".repeat(40);
    const pack = await searchPack({ marker, producerRunId, baseSha });
    const fixture = buildReceipt({ marker, producerRunId, baseSha, pack });
    const triggerName = `test_reject_slice3_scope_${marker}`;
    db.exec(`
      CREATE TRIGGER ${triggerName}
      BEFORE INSERT ON memory_v2_scope_snapshots
      BEGIN SELECT RAISE(ABORT, 'injected Slice 3 scope failure'); END
    `);
    let response;
    try {
      response = await putReceipt({
        producerRunId,
        idempotencyKey: `slice3-http-rollback-${marker}`,
        receipt: fixture.receipt,
      });
    } finally {
      db.exec(`DROP TRIGGER ${triggerName}`);
    }
    expect(response!.statusCode, response!.body).toBe(500);
    expect(response!.json()).toMatchObject({
      schema_version: "pim.error.v2",
      code: "temporarily_unavailable",
      retryable: true,
    });
    expect(response!.body).not.toContain("injected Slice 3 scope failure");
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM memory_run_receipts WHERE producer_run_id = ?",
    ).get(producerRunId)).toEqual({ count: 0 });
    expect(db.prepare(
      `SELECT COUNT(*) AS count FROM memory_candidates_v1
       WHERE client_candidate_id = ?`,
    ).get(fixture.clientCandidateId)).toEqual({ count: 0 });
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM memory_v2_scope_snapshots WHERE producer_run_id = ?",
    ).get(producerRunId)).toEqual({ count: 0 });
    expect(db.prepare(
      `SELECT COUNT(*) AS count FROM memory_idempotency_keys
       WHERE operation = 'memory_run_receipt_v2' AND idempotency_key = ?`,
    ).get(`slice3-http-rollback-${marker}`)).toEqual({ count: 0 });
  });
});
