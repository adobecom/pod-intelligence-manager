import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canonicalJsonSha256,
  MEMORY_CONTRACT_FIXTURES,
  MEMORY_CONTRACT_FIXTURES_V2,
  type CodebaseMemorySearchV2,
  type CodebaseRunReceiptV2,
  type MemoryCandidateDecisionV2,
  type MemoryCandidateStatusV1,
  type MemoryFeedbackV2,
  type MemorySearchResultV2,
  type ResourceBindingV2,
} from "@pim/shared";
import db from "../../db/connection.js";
import {
  createMemoryTestContext,
  type MemoryTestContext,
} from "../../routes/__tests__/memory-test-app.js";
import {
  getMemoryCandidateStatus,
  validateMemoryCandidate,
} from "../memory-candidates.js";
import {
  appendCodeMemoryFeedbackV2,
  decideCodeMemoryCandidateV2,
  getCodeMemoryCandidateStatusV2,
  projectMemoryV1CodeCandidateStatusV2,
  submitCodeMemoryRunReceiptV2,
} from "../memory-v2-code-write.js";
import { searchCodeMemoryV2 } from "../memory-v2-code-read.js";
import { resolveMemoryV2Resource } from "../memory-v2-resources.js";
import { reconcileMemoryV2CanonicalWrites } from "../memory-v2-startup-reconciliation.js";
import {
  createServiceToken,
  verifyMemoryV2ServiceToken,
  type MemoryV2RequestAuthorizationSnapshot,
} from "../service-tokens.js";

const REPOSITORY_ID = "github.com/acme/checkout";
const EMPTY_REPOSITORY_ID = "github.com/acme/empty";

let context: MemoryTestContext;
let principal: MemoryV2RequestAuthorizationSnapshot;
let secondPrincipal: MemoryV2RequestAuthorizationSnapshot;
let emptyCandidatePrincipal: MemoryV2RequestAuthorizationSnapshot;

function marker(): string {
  return randomUUID().replaceAll("-", "").slice(0, 16);
}

async function packFor(input: {
  marker: string;
  producerRunId: string;
  baseSha: string;
  actor?: MemoryV2RequestAuthorizationSnapshot;
}): Promise<MemorySearchResultV2> {
  const fixture = structuredClone(
    MEMORY_CONTRACT_FIXTURES_V2.MemorySearchV2,
  ) as unknown as CodebaseMemorySearchV2;
  return searchCodeMemoryV2({
    principal: input.actor ?? principal,
    request: {
      ...fixture,
      request_id: `slice3-service-pack-${input.marker}`,
      consumer: {
        ...fixture.consumer,
        consumer_run_id: input.producerRunId,
      },
      tenant: { project_id: context.projectA },
      resource_selector: { canonical_resource_id: REPOSITORY_ID },
      applicability: {
        ...fixture.applicability,
        repository_id: REPOSITORY_ID,
        base_sha: input.baseSha,
      },
    },
  });
}

interface ReceiptFixture {
  receipt: CodebaseRunReceiptV2;
  evidenceRefId: string;
  clientCandidateId: string;
  candidateSummary: string;
}

function receiptFor(input: {
  marker: string;
  producerRunId: string;
  baseSha: string;
  pack: MemorySearchResultV2;
  embeddedFeedback?: boolean;
  activationRequirement?: "verified_merge" | "verified_merge_and_test" | "authorized_review";
}): ReceiptFixture {
  const source = structuredClone(
    MEMORY_CONTRACT_FIXTURES_V2.RunReceiptV2,
  ) as unknown as CodebaseRunReceiptV2;
  const evidenceRefId = `failure-slice3-service-${input.marker}`;
  const clientCandidateId = `candidate-slice3-service-${input.marker}`;
  const failureFingerprint = `failure:slice3-service:${input.marker}`;
  const candidateSummary = "Do not blindly replay an ambiguous provider operation.";
  const manifestBody = {
    schema_version: "pim.memory-code-evidence.v2" as const,
    manifest_id: `manifest-slice3-service-${input.marker}`,
    refs: [{
      id: evidenceRefId,
      type: "failure" as const,
      uri: `https://github.com/acme/checkout/commit/${input.baseSha}`,
      digest: canonicalJsonSha256({ evidence_ref_id: evidenceRefId }),
      origin_id: `${REPOSITORY_ID}:failure:${input.marker}`,
      occurred_at: "2026-08-08T16:00:00.000Z",
      source_authority: "observed" as const,
    }],
  };
  const item = input.pack.items[0]!;
  return {
    evidenceRefId,
    clientCandidateId,
    candidateSummary,
    receipt: {
      schema_version: "pim.run-receipt.v2",
      external_session_id: `slice3-service-session-${input.marker}`,
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
        summary: "Keep an ambiguous retry pinned to the exact repository snapshot.",
      },
      outcome: {
        status: "completed",
        terminal_stage: "close",
        reason_code: "failure_review_ready",
        verification_status: "passed",
        failure_fingerprint: failureFingerprint,
      },
      retrieval_feedback: input.embeddedFeedback === false ? [] : [{
        retrieval_pack_id: input.pack.retrieval_pack_id,
        scope_snapshot_digest: input.pack.scope_snapshot_digest,
        record_id: item.record_id,
        record_version: item.record_version,
        disposition: "helpful",
        reason_code: "slice3_service_pack_helped",
      }],
      evidence_manifest: {
        ...manifestBody,
        digest: canonicalJsonSha256(manifestBody),
      },
      candidates: [{
        schema_version: "pim.memory-candidate.v2",
        client_candidate_id: clientCandidateId,
        plane: "codebase",
        resource_row_id: input.pack.resource_binding.resource_row_id,
        scope_snapshot_digest: input.pack.scope_snapshot_digest,
        kind: "anti_pattern",
        subkind: null,
        content: {
          summary: candidateSummary,
          details: "Resolve the exact failed provider event before retrying so an ambiguous result cannot duplicate the original side effect.",
          rationale: "The captured failure proves that an unqualified retry is unsafe for this repository path.",
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
          extractor_version: "slice3-service-test",
          confidence: 0.95,
        },
        activation_requirement_requested: input.activationRequirement ?? "authorized_review",
      }],
    },
  };
}

function laterFeedback(input: {
  pack: MemorySearchResultV2;
  producerRunId: string;
  reasonCode?: string;
  disposition?: MemoryFeedbackV2["disposition"];
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
    disposition: input.disposition ?? "helpful",
    reason_code: input.reasonCode ?? "slice3_service_later_feedback",
    outcome_evidence_refs: [],
    event_time: "2026-08-08T16:05:00.000Z",
  };
}

function decisionFor(input: {
  resourceRowId: string;
  evidenceRefId: string;
  decision?: MemoryCandidateDecisionV2["decision"];
  reasonCode?: string;
}): MemoryCandidateDecisionV2 {
  return {
    schema_version: "pim.memory-candidate-decision.v2",
    decision_revision: 1,
    plane: "codebase",
    resource_row_id: input.resourceRowId,
    decision: input.decision ?? "reject",
    reason_code: input.reasonCode ?? "slice3_service_scope_too_broad",
    explanation: "The failure is real, but the proposed reusable scope is broader than the reviewed evidence.",
    evidence_refs: [input.evidenceRefId],
    event_time: "2026-08-08T16:10:00.000Z",
  };
}

function count(sql: string, ...params: Array<string | number>): number {
  return (db.prepare(sql).get(...params) as { count: number }).count;
}

beforeAll(async () => {
  context = await createMemoryTestContext({}, { v2Reads: true, v2Writes: true });
  const owner = db.prepare(
    "SELECT created_by_user_id FROM projects WHERE project_id = ?",
  ).get(context.projectA) as { created_by_user_id: string };
  const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
  const scopes = [
    "memory:search",
    "memory:receipt:write",
    "memory:feedback:write",
    "memory:candidate:read",
    "memory:review",
  ] as const;
  const token = createServiceToken({
    orgId: context.orgA.id,
    name: "Slice 3 direct service authority",
    scopes: [...scopes],
    createdByUserId: owner.created_by_user_id,
    projectId: context.projectA,
    repositoryIds: [REPOSITORY_ID],
    expiresAt,
  });
  const second = createServiceToken({
    orgId: context.orgA.id,
    name: "Slice 3 second direct service authority",
    scopes: [...scopes],
    createdByUserId: owner.created_by_user_id,
    projectId: context.projectA,
    repositoryIds: [REPOSITORY_ID],
    expiresAt,
  });
  const empty = createServiceToken({
    orgId: context.orgA.id,
    name: "Slice 3 other-resource candidate reader",
    scopes: ["memory:candidate:read"],
    createdByUserId: owner.created_by_user_id,
    projectId: context.projectA,
    repositoryIds: [EMPTY_REPOSITORY_ID],
    expiresAt,
  });
  principal = verifyMemoryV2ServiceToken(token.token)!.authorization;
  secondPrincipal = verifyMemoryV2ServiceToken(second.token)!.authorization;
  emptyCandidatePrincipal = verifyMemoryV2ServiceToken(empty.token)!.authorization;
});

afterAll(async () => {
  if (context) await context.app.close();
});

describe("Slice 3 code write application service", () => {
  it.each([
    ["received", "accepted"],
    ["validating", "validating"],
    ["pending_merge", "pending_evidence"],
    ["pending_review", "pending_review"],
    ["active", "active"],
    ["rejected", "rejected"],
    ["quarantined", "rejected"],
    ["validation_failed", "failed"],
    ["activation_failed", "failed"],
  ] as const)(
    "maps stored v1 %s lifecycle labels consistently to v2 %s",
    (storedStatus, projectedStatus) => {
      const stored = structuredClone(
        MEMORY_CONTRACT_FIXTURES.MemoryCandidateStatusV1,
      ) as unknown as MemoryCandidateStatusV1;
      stored.status = storedStatus;
      stored.latest_transition.from_status = storedStatus;
      stored.latest_transition.to_status = storedStatus;
      const projected = projectMemoryV1CodeCandidateStatusV2({
        status: stored,
        organizationId: "org-acme",
        projectId: "project-checkout",
        resourceBinding: structuredClone(
          MEMORY_CONTRACT_FIXTURES_V2.MemoryCandidateStatusV2.resource_binding,
        ) as unknown as ResourceBindingV2,
      });
      expect(projected.status).toBe(projectedStatus);
      expect(projected.latest_transition).toMatchObject({
        from_status: projectedStatus,
        to_status: projectedStatus,
      });
    },
  );

  it("round-trips receipt, status, later feedback, and decision without mutating migrated v1 data", async () => {
    const id = marker();
    const producerRunId = `example-harness-a:test:slice3-service:${id}`;
    const baseSha = "a".repeat(40);
    const pack = await packFor({ marker: id, producerRunId, baseSha });
    expect(pack.items.length).toBeGreaterThan(0);
    const fixture = receiptFor({ marker: id, producerRunId, baseSha, pack });
    const receiptKey = `slice3-service-receipt-${id}`;
    const legacyFeedbackBefore = db.prepare(
      `SELECT * FROM memory_feedback WHERE org_id = ? AND project_id = ? ORDER BY feedback_id`,
    ).all(context.orgA.id, context.projectA);
    const migratedRecordBefore = db.prepare(
      `SELECT record.current_status, record.current_version, version.content_digest
       FROM memory_records AS record
       INNER JOIN memory_record_versions AS version
         ON version.record_id = record.record_id
        AND version.record_version = record.current_version
       WHERE record.record_id = ?`,
    ).get(context.seededRecordId);

    const accepted = submitCodeMemoryRunReceiptV2({
      principal,
      producerRunId,
      idempotencyKey: receiptKey,
      receipt: fixture.receipt,
    });
    expect(accepted).toMatchObject({
      producer_run_id: producerRunId,
      status: "accepted",
      duplicate: false,
      scope_snapshot_digest: pack.scope_snapshot_digest,
    });
    expect(accepted.candidate_results).toHaveLength(1);
    const candidateId = accepted.candidate_results[0]!.candidate_id;
    expect(accepted.candidate_results[0]).toMatchObject({
      status: "accepted",
      latest_transition: { from_status: null, to_status: "accepted" },
    });
    expect(getMemoryCandidateStatus(context.orgA.id, context.projectA, candidateId)).toMatchObject({
      status: "received",
      latest_transition: { from_status: null, to_status: "received" },
    });
    expect(count(
      "SELECT COUNT(*) AS count FROM memory_run_receipts WHERE receipt_id = ?",
      accepted.receipt_id,
    )).toBe(1);
    expect(count(
      "SELECT COUNT(*) AS count FROM memory_v2_receipt_facets WHERE receipt_id = ?",
      accepted.receipt_id,
    )).toBe(1);
    expect(count(
      "SELECT COUNT(*) AS count FROM memory_v2_candidate_facets WHERE candidate_id = ?",
      candidateId,
    )).toBe(1);
    expect(count(
      `SELECT COUNT(*) AS count FROM memory_outbox
       WHERE aggregate_type = 'candidate' AND aggregate_id = ? AND status = 'pending'`,
      candidateId,
    )).toBe(1);
    expect(getCodeMemoryCandidateStatusV2({
      principal,
      candidateId,
      resourceSelector: { resource_row_id: pack.resource_binding.resource_row_id },
    })).toMatchObject({
      candidate_id: candidateId,
      status: "accepted",
      latest_transition: { from_status: null, to_status: "accepted" },
      active_record: null,
    });
    expect(count(
      `SELECT COUNT(*) AS count FROM memory_v2_feedback_bindings
       WHERE receipt_id = ? AND feedback_stage = 'receipt' AND feedback_revision = 0`,
      accepted.receipt_id,
    )).toBe(1);
    expect(db.prepare(
      `SELECT * FROM memory_feedback WHERE org_id = ? AND project_id = ? ORDER BY feedback_id`,
    ).all(context.orgA.id, context.projectA)).toEqual(legacyFeedbackBefore);

    const replay = submitCodeMemoryRunReceiptV2({
      principal,
      producerRunId,
      idempotencyKey: receiptKey,
      receipt: fixture.receipt,
    });
    expect(replay).toMatchObject({
      receipt_id: accepted.receipt_id,
      request_digest: accepted.request_digest,
      status: "replayed",
      duplicate: true,
    });
    const changedReceipt = structuredClone(fixture.receipt);
    changedReceipt.task.summary = "Changed immutable receipt content must conflict.";
    expect(() => submitCodeMemoryRunReceiptV2({
      principal,
      producerRunId,
      idempotencyKey: receiptKey,
      receipt: changedReceipt,
    })).toThrow(expect.objectContaining({ code: "idempotency_conflict", statusCode: 409 }));
    expect(() => submitCodeMemoryRunReceiptV2({
      principal,
      producerRunId,
      idempotencyKey: `${receiptKey}-different`,
      receipt: fixture.receipt,
    })).toThrow(expect.objectContaining({ code: "idempotency_conflict", statusCode: 409 }));

    const afterReceipt = await packFor({
      marker: `${id}-after`,
      producerRunId: `${producerRunId}:after`,
      baseSha,
    });
    expect(afterReceipt.items.map((item) => item.record_id)).not.toContain(candidateId);
    expect(afterReceipt.items.map((item) => item.summary)).not.toContain(fixture.candidateSummary);
    expect(db.prepare(
      "SELECT active_record_id FROM memory_candidates_v1 WHERE candidate_id = ?",
    ).get(candidateId)).toEqual({ active_record_id: null });

    const feedback = laterFeedback({
      pack,
      producerRunId,
      disposition: "harmful",
    });
    const feedbackKey = `slice3-service-feedback-${id}`;
    const feedbackResult = appendCodeMemoryFeedbackV2({
      principal,
      idempotencyKey: feedbackKey,
      feedback,
    });
    expect(feedbackResult).toMatchObject({ duplicate: false, feedback_revision: 1 });
    expect(feedbackResult.review_signal_ids).toHaveLength(1);
    expect(count(
      `SELECT COUNT(*) AS count
       FROM memory_v2_feedback_review_signals AS signal
       INNER JOIN memory_outbox AS job ON job.job_id = signal.outbox_job_id
       WHERE signal.feedback_id = ?
         AND json_extract(job.payload_json, '$.feedback_source') = 'memory_v2_feedback_bindings'`,
      feedbackResult.feedback_id,
    )).toBe(1);
    expect(appendCodeMemoryFeedbackV2({
      principal,
      idempotencyKey: feedbackKey,
      feedback,
    })).toMatchObject({ feedback_id: feedbackResult.feedback_id, duplicate: true });
    expect(() => appendCodeMemoryFeedbackV2({
      principal,
      idempotencyKey: feedbackKey,
      feedback: { ...feedback, reason_code: "changed_feedback_digest" },
    })).toThrow(expect.objectContaining({ code: "idempotency_conflict", statusCode: 409 }));
    expect(() => appendCodeMemoryFeedbackV2({
      principal,
      idempotencyKey: `${feedbackKey}-different`,
      feedback,
    })).toThrow(expect.objectContaining({ code: "idempotency_conflict", statusCode: 409 }));
    expect(db.prepare(
      `SELECT * FROM memory_feedback WHERE org_id = ? AND project_id = ? ORDER BY feedback_id`,
    ).all(context.orgA.id, context.projectA)).toEqual(legacyFeedbackBefore);

    const current = db.prepare(
      "SELECT aggregate_version FROM memory_candidates_v1 WHERE candidate_id = ?",
    ).get(candidateId) as { aggregate_version: number };
    validateMemoryCandidate(candidateId, current.aggregate_version);
    expect(getMemoryCandidateStatus(context.orgA.id, context.projectA, candidateId))
      .toMatchObject({
        status: "pending_review",
        latest_transition: { from_status: "validating", to_status: "pending_review" },
      });
    expect(getCodeMemoryCandidateStatusV2({
      principal,
      candidateId,
      resourceSelector: { resource_row_id: pack.resource_binding.resource_row_id },
    })).toMatchObject({
      status: "pending_review",
      latest_transition: { from_status: "validating", to_status: "pending_review" },
    });
    const decision = decisionFor({
      resourceRowId: pack.resource_binding.resource_row_id,
      evidenceRefId: fixture.evidenceRefId,
    });
    const decided = decideCodeMemoryCandidateV2({ principal, candidateId, decision });
    expect(decided).toMatchObject({
      candidate_id: candidateId,
      decision: "reject",
      candidate_status: "rejected",
      active_record: null,
      duplicate: false,
    });
    expect(decideCodeMemoryCandidateV2({ principal, candidateId, decision }))
      .toMatchObject({ decision_id: decided.decision_id, duplicate: true });
    expect(() => decideCodeMemoryCandidateV2({
      principal,
      candidateId,
      decision: { ...decision, reason_code: "changed_decision_digest" },
    })).toThrow(expect.objectContaining({ code: "idempotency_conflict", statusCode: 409 }));

    expect(db.prepare(
      `SELECT record.current_status, record.current_version, version.content_digest
       FROM memory_records AS record
       INNER JOIN memory_record_versions AS version
         ON version.record_id = record.record_id
        AND version.record_version = record.current_version
       WHERE record.record_id = ?`,
    ).get(context.seededRecordId)).toEqual(migratedRecordBefore);
  });

  it("fails closed across principals, resources, packs, and non-enumerating status probes", async () => {
    const id = marker();
    const producerRunId = `example-harness-a:test:slice3-service-boundary:${id}`;
    const baseSha = "b".repeat(40);
    const pack = await packFor({ marker: id, producerRunId, baseSha });
    const fixture = receiptFor({ marker: id, producerRunId, baseSha, pack });
    const receiptKey = `slice3-service-boundary-${id}`;
    const accepted = submitCodeMemoryRunReceiptV2({
      principal,
      producerRunId,
      idempotencyKey: receiptKey,
      receipt: fixture.receipt,
    });
    const candidateId = accepted.candidate_results[0]!.candidate_id;

    expect(() => submitCodeMemoryRunReceiptV2({
      principal: secondPrincipal,
      producerRunId,
      idempotencyKey: receiptKey,
      receipt: fixture.receipt,
    })).toThrow(expect.objectContaining({ code: "idempotency_conflict", statusCode: 409 }));

    const missingProbe = () => getCodeMemoryCandidateStatusV2({
      principal: emptyCandidatePrincipal,
      candidateId: `candidate-missing-${id}`,
    });
    const crossResourceProbe = () => getCodeMemoryCandidateStatusV2({
      principal: emptyCandidatePrincipal,
      candidateId,
    });
    for (const probe of [missingProbe, crossResourceProbe]) {
      expect(probe).toThrow(expect.objectContaining({
        code: "resource_not_found",
        statusCode: 404,
        message: "Memory candidate is unavailable",
      }));
    }

    const feedback = laterFeedback({ pack, producerRunId });
    expect(() => appendCodeMemoryFeedbackV2({
      principal: secondPrincipal,
      idempotencyKey: `slice3-service-cross-principal-${id}`,
      feedback,
    })).toThrow(expect.objectContaining({ code: "resource_binding_mismatch", statusCode: 403 }));

    const emptyResource = resolveMemoryV2Resource({
      orgId: context.orgA.id,
      projectId: context.projectA,
      plane: "codebase",
      canonicalResourceId: EMPTY_REPOSITORY_ID,
    })!;
    expect(() => appendCodeMemoryFeedbackV2({
      principal,
      idempotencyKey: `slice3-service-cross-resource-${id}`,
      feedback: { ...feedback, resource_row_id: emptyResource.resourceRowId },
    })).toThrow(expect.objectContaining({ code: "resource_binding_mismatch", statusCode: 403 }));

    const otherPack = await packFor({
      marker: `${id}-other-snapshot`,
      producerRunId: `${producerRunId}:other-snapshot`,
      baseSha: "c".repeat(40),
    });
    expect(otherPack.scope_snapshot_digest).not.toBe(pack.scope_snapshot_digest);
    expect(() => appendCodeMemoryFeedbackV2({
      principal,
      idempotencyKey: `slice3-service-cross-pack-${id}`,
      feedback: { ...feedback, retrieval_pack_id: otherPack.retrieval_pack_id },
    })).toThrow(expect.objectContaining({ code: "evidence_mismatch", statusCode: 422 }));
  });

  it("keeps harmful and stale receipt-stage feedback as acknowledgement-only rows", async () => {
    for (const disposition of ["harmful", "stale"] as const) {
      const id = marker();
      const producerRunId = `example-harness-a:test:slice3-service-receipt-feedback:${disposition}:${id}`;
      const baseSha = disposition === "harmful" ? "2".repeat(40) : "3".repeat(40);
      const pack = await packFor({ marker: id, producerRunId, baseSha });
      const fixture = receiptFor({ marker: id, producerRunId, baseSha, pack });
      fixture.receipt.retrieval_feedback[0]!.disposition = disposition;
      fixture.receipt.retrieval_feedback[0]!.reason_code = `receipt_${disposition}_${id}`;
      const accepted = submitCodeMemoryRunReceiptV2({
        principal,
        producerRunId,
        idempotencyKey: `slice3-service-receipt-feedback-${disposition}-${id}`,
        receipt: fixture.receipt,
      });
      const binding = db.prepare(
        `SELECT feedback_id, feedback_stage, feedback_revision
         FROM memory_v2_feedback_bindings
         WHERE receipt_id = ? AND feedback_stage = 'receipt'`,
      ).get(accepted.receipt_id) as {
        feedback_id: string;
        feedback_stage: string;
        feedback_revision: number;
      };
      expect(binding).toMatchObject({ feedback_stage: "receipt", feedback_revision: 0 });
      expect(count(
        "SELECT COUNT(*) AS count FROM memory_v2_feedback_review_signals WHERE feedback_id = ?",
        binding.feedback_id,
      )).toBe(0);
      expect(count(
        `SELECT COUNT(*) AS count FROM memory_outbox
         WHERE json_valid(payload_json)
           AND json_extract(payload_json, '$.feedback_id') = ?`,
        binding.feedback_id,
      )).toBe(0);
    }
    expect(reconcileMemoryV2CanonicalWrites()).toMatchObject({ ok: true, mismatchCount: 0 });
  });

  it("rolls back every core companion and acknowledgement at both receipt failure seams", async () => {
    for (const seam of ["beforeScopeSnapshotInsert", "beforeFeedbackBindingInsert"] as const) {
      const id = marker();
      const producerRunId = `example-harness-a:test:slice3-service-rollback:${seam}:${id}`;
      const baseSha = seam === "beforeScopeSnapshotInsert" ? "d".repeat(40) : "e".repeat(40);
      const pack = await packFor({ marker: id, producerRunId, baseSha });
      const fixture = receiptFor({ marker: id, producerRunId, baseSha, pack });
      const idempotencyKey = `slice3-service-rollback-${seam}-${id}`;
      const now = new Date(Date.now() + Number.parseInt(id.slice(0, 6), 16)).toISOString();
      expect(() => submitCodeMemoryRunReceiptV2({
        principal,
        producerRunId,
        idempotencyKey,
        receipt: fixture.receipt,
        now,
        dependencies: {
          [seam]: () => {
            throw new Error(`injected ${seam}`);
          },
        },
      })).toThrow(`injected ${seam}`);

      expect(count(
        "SELECT COUNT(*) AS count FROM memory_run_receipts WHERE producer_run_id = ?",
        producerRunId,
      )).toBe(0);
      expect(count(
        "SELECT COUNT(*) AS count FROM memory_candidates_v1 WHERE client_candidate_id = ?",
        fixture.clientCandidateId,
      )).toBe(0);
      expect(count(
        "SELECT COUNT(*) AS count FROM memory_v2_scope_snapshots WHERE producer_run_id = ?",
        producerRunId,
      )).toBe(0);
      expect(count(
        `SELECT COUNT(*) AS count FROM memory_idempotency_keys
         WHERE org_id = ? AND project_id = ?
           AND ((operation = 'memory_run_receipt_v2' AND idempotency_key = ?)
             OR (operation = 'memory.run-receipt.v1' AND idempotency_key = ?))`,
        context.orgA.id,
        context.projectA,
        idempotencyKey,
        `pim.run-receipt.v1:${producerRunId}`,
      )).toBe(0);
      expect(count(
        `SELECT COUNT(*) AS count FROM memory_v2_receipt_facets
         WHERE org_id = ? AND project_id = ? AND created_at = ?`,
        context.orgA.id,
        context.projectA,
        now,
      )).toBe(0);
      expect(count(
        `SELECT COUNT(*) AS count FROM memory_v2_candidate_facets
         WHERE org_id = ? AND project_id = ? AND created_at = ?`,
        context.orgA.id,
        context.projectA,
        now,
      )).toBe(0);
      expect(count(
        `SELECT COUNT(*) AS count FROM memory_outbox
         WHERE org_id = ? AND project_id = ? AND created_at = ?`,
        context.orgA.id,
        context.projectA,
        now,
      )).toBe(0);
    }
  });

  it("rolls a later feedback companion failure back without a binding, signal, outbox, or claim", async () => {
    const id = marker();
    const producerRunId = `example-harness-a:test:slice3-service-feedback-rollback:${id}`;
    const baseSha = "f".repeat(40);
    const pack = await packFor({ marker: id, producerRunId, baseSha });
    const fixture = receiptFor({
      marker: id,
      producerRunId,
      baseSha,
      pack,
      embeddedFeedback: false,
    });
    const accepted = submitCodeMemoryRunReceiptV2({
      principal,
      producerRunId,
      idempotencyKey: `slice3-service-feedback-rollback-receipt-${id}`,
      receipt: fixture.receipt,
    });
    const feedback = laterFeedback({ pack, producerRunId, disposition: "stale" });
    const feedbackKey = `slice3-service-feedback-rollback-${id}`;
    const beforeSignals = count(
      `SELECT COUNT(*) AS count FROM memory_v2_feedback_review_signals
       WHERE org_id = ? AND project_id = ? AND record_id = ?`,
      context.orgA.id,
      context.projectA,
      feedback.record_id,
    );
    const beforeOutbox = count(
      `SELECT COUNT(*) AS count FROM memory_outbox
       WHERE org_id = ? AND project_id = ? AND aggregate_id = ?`,
      context.orgA.id,
      context.projectA,
      feedback.record_id,
    );
    expect(() => appendCodeMemoryFeedbackV2({
      principal,
      idempotencyKey: feedbackKey,
      feedback,
      dependencies: {
        beforeFeedbackBindingInsert: () => {
          throw new Error("injected later feedback companion failure");
        },
      },
    })).toThrow("injected later feedback companion failure");
    expect(count(
      `SELECT COUNT(*) AS count FROM memory_v2_feedback_bindings
       WHERE receipt_id = ? AND feedback_stage = 'later'`,
      accepted.receipt_id,
    )).toBe(0);
    expect(count(
      `SELECT COUNT(*) AS count FROM memory_v2_feedback_review_signals
       WHERE org_id = ? AND project_id = ? AND record_id = ?`,
      context.orgA.id,
      context.projectA,
      feedback.record_id,
    )).toBe(beforeSignals);
    expect(count(
      `SELECT COUNT(*) AS count FROM memory_outbox
       WHERE org_id = ? AND project_id = ? AND aggregate_id = ?`,
      context.orgA.id,
      context.projectA,
      feedback.record_id,
    )).toBe(beforeOutbox);
    expect(count(
      `SELECT COUNT(*) AS count FROM memory_idempotency_keys
       WHERE org_id = ? AND project_id = ?
         AND operation = 'memory_feedback_v2' AND idempotency_key = ?`,
      context.orgA.id,
      context.projectA,
      feedbackKey,
    )).toBe(0);
  });

  it("fails closed on verified_merge_and_test before lifecycle effects", async () => {
    const id = marker();
    const producerRunId = `example-harness-a:test:slice3-service-fail-closed:${id}`;
    const baseSha = "1".repeat(40);
    const pack = await packFor({ marker: id, producerRunId, baseSha });
    const unsupported = receiptFor({
      marker: id,
      producerRunId,
      baseSha,
      pack,
      embeddedFeedback: false,
      activationRequirement: "verified_merge_and_test",
    });
    expect(() => submitCodeMemoryRunReceiptV2({
      principal,
      producerRunId,
      idempotencyKey: `slice3-service-merge-test-${id}`,
      receipt: unsupported.receipt,
    })).toThrow(expect.objectContaining({
      code: "activation_requirement_unsatisfied",
      statusCode: 409,
    }));
    expect(count(
      "SELECT COUNT(*) AS count FROM memory_run_receipts WHERE producer_run_id = ?",
      producerRunId,
    )).toBe(0);
  });

  it("rejects v2 values that the canonical receipt and candidate ledgers cannot represent", async () => {
    const cases = [
      {
        label: "candidate-short-fingerprint",
        mutate(receipt: CodebaseRunReceiptV2) {
          receipt.candidates[0]!.validation.failure_fingerprint = "short";
        },
        expected: {
          code: "activation_requirement_unsatisfied",
          path: "/candidates/validation/failure_fingerprint",
        },
      },
      {
        label: "receipt-short-fingerprint",
        mutate(receipt: CodebaseRunReceiptV2) {
          receipt.outcome.failure_fingerprint = "short";
        },
        expected: { code: "transition_invalid", path: "/outcome/failure_fingerprint" },
      },
      {
        label: "terminal-stage-too-long",
        mutate(receipt: CodebaseRunReceiptV2) {
          receipt.outcome.terminal_stage = "x".repeat(65);
        },
        expected: { code: "transition_invalid", path: "/outcome/terminal_stage" },
      },
    ] as const;

    for (const testCase of cases) {
      const id = marker();
      const producerRunId = `example-harness-a:test:slice3-service-representability:${testCase.label}:${id}`;
      const baseSha = "4".repeat(40);
      const pack = await packFor({ marker: id, producerRunId, baseSha });
      const fixture = receiptFor({
        marker: id,
        producerRunId,
        baseSha,
        pack,
        embeddedFeedback: false,
      });
      testCase.mutate(fixture.receipt);
      expect(() => submitCodeMemoryRunReceiptV2({
        principal,
        producerRunId,
        idempotencyKey: `slice3-service-representability-${testCase.label}-${id}`,
        receipt: fixture.receipt,
      })).toThrow(expect.objectContaining({
        code: testCase.expected.code,
        statusCode: 409,
        details: expect.arrayContaining([
          expect.objectContaining({ path: testCase.expected.path }),
        ]),
      }));
      expect(count(
        "SELECT COUNT(*) AS count FROM memory_run_receipts WHERE producer_run_id = ?",
        producerRunId,
      )).toBe(0);
    }
  });
});
