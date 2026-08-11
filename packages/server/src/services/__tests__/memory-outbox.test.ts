import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MEMORY_CONTRACT_FIXTURES,
  MEMORY_CONTRACT_FIXTURES_V2,
  canonicalJsonSha256,
  parseMemoryContract,
  type CodebaseMemorySearchV2,
  type CodebaseRunReceiptV2,
  type CodeEvidenceManifestV2,
  type MemoryCandidateV1,
  type MemoryFeedbackV2,
  type MemorySearchResultV2,
  type RunReceiptV1,
} from "@pim/shared";
import db from "../../db/connection.js";
import { createMemoryTestContext, type MemoryTestContext } from "../../routes/__tests__/memory-test-app.js";
import {
  canonicalEvidenceManifestDigest,
  acceptMemoryRunReceipt,
} from "../memory-receipts.js";
import { resolveMemoryRepository } from "../memory-repository-registry.js";
import { searchCodeMemoryV2 } from "../memory-v2-code-read.js";
import {
  appendCodeMemoryFeedbackV2,
  submitCodeMemoryRunReceiptV2,
} from "../memory-v2-code-write.js";
import {
  listMemoryDeadLetters,
  replayMemoryDeadLetter,
  runMemoryOutboxPass,
} from "../memory-outbox.js";
import {
  createServiceToken,
  verifyMemoryV2ServiceToken,
  type MemoryV2RequestAuthorizationSnapshot,
} from "../service-tokens.js";

const TREE_SHA = "89abcdef0123456789abcdef0123456789abcdef";
const REPOSITORY_ID = "github.com/acme/checkout";

let context: MemoryTestContext;
let v2Principal: MemoryV2RequestAuthorizationSnapshot;

function uniqueId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function createQueuedCandidate(now: string): { candidateId: string; jobId: string } {
  const producerRunId = uniqueId("outbox-run");
  const evidenceRefId = uniqueId("outbox-diff");
  const candidateFixture = structuredClone(
    MEMORY_CONTRACT_FIXTURES.MemoryCandidateV1,
  ) as unknown as MemoryCandidateV1;
  const candidate = parseMemoryContract("MemoryCandidateV1", {
    ...candidateFixture,
    client_candidate_id: uniqueId("outbox-candidate"),
    source_run_ids: [producerRunId],
    evidence_refs: [evidenceRefId],
  });
  const manifestBody = {
    schema_version: "pim.memory-code-evidence.v2" as const,
    manifest_id: uniqueId("outbox-manifest"),
    refs: [{
      id: evidenceRefId,
      type: "git_diff" as const,
      uri: `https://github.com/acme/checkout/commit/${TREE_SHA}.diff`,
      digest: canonicalJsonSha256({ evidenceRefId }),
      origin_id: `github.com/acme/checkout:${TREE_SHA}:${evidenceRefId}`,
      occurred_at: now,
      source_authority: "observed" as const,
    }],
  };
  const manifest = parseMemoryContract("CodeEvidenceManifestV2", {
    ...manifestBody,
    digest: canonicalEvidenceManifestDigest(manifestBody),
  }) as CodeEvidenceManifestV2;
  const receiptFixture = structuredClone(
    MEMORY_CONTRACT_FIXTURES.RunReceiptV1,
  ) as unknown as RunReceiptV1;
  const receipt = parseMemoryContract("RunReceiptV1", {
    ...receiptFixture,
    external_session_id: `${producerRunId}:session`,
    tenant: { project_id: context.projectA },
    evidence_manifest: manifest,
    candidates: [candidate],
  });
  const repository = resolveMemoryRepository(
    context.orgA.id,
    context.projectA,
    "github.com/acme/checkout",
  );
  expect(repository).not.toBeNull();
  const accepted = acceptMemoryRunReceipt({
    orgId: context.orgA.id,
    projectId: context.projectA,
    principalId: "outbox-test-producer",
    producerRunId,
    repository: repository!,
    receipt,
    now,
  });
  const candidateId = accepted.result.candidate_results[0]!.candidate_id;
  const job = db.prepare(
    "SELECT job_id FROM memory_outbox WHERE job_type = 'candidate_validation' AND aggregate_id = ?",
  ).get(candidateId) as { job_id: string } | undefined;
  expect(job).toBeDefined();
  return { candidateId, jobId: job!.job_id };
}

function insertSyntheticJob(input: {
  jobId: string;
  jobType: string;
  aggregateId: string;
  aggregateType?: string;
  payload?: Record<string, unknown>;
  status: "pending" | "leased";
  attemptCount: number;
  maxAttempts: number;
  now: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
}): void {
  db.prepare(
    `INSERT INTO memory_outbox
       (job_id, org_id, project_id, job_type, aggregate_type, aggregate_id,
        expected_version, payload_json, status, attempt_count, max_attempts,
        next_attempt_at, lease_owner, lease_expires_at, last_error_code,
        last_error_message, created_at, updated_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL)`,
  ).run(
    input.jobId,
    context.orgA.id,
    context.projectA,
    input.jobType,
    input.aggregateType ?? "candidate",
    input.aggregateId,
    JSON.stringify(input.payload ?? { aggregate_id: input.aggregateId }),
    input.status,
    input.attemptCount,
    input.maxAttempts,
    input.now,
    input.leaseOwner ?? null,
    input.leaseExpiresAt ?? null,
    input.now,
    input.now,
  );
}

async function createV2FeedbackJobs(
  disposition: "harmful" | "stale",
): Promise<{
  feedbackId: string;
  recordId: string;
  jobs: Array<{ job_id: string; signal_id: string; signal_type: string }>;
  now: string;
}> {
  const suffix = uniqueId(`outbox-v2-${disposition}`);
  const producerRunId = `fiesta:test:${suffix}`;
  const baseSha = disposition === "harmful" ? "a".repeat(40) : "b".repeat(40);
  const searchFixture = structuredClone(
    MEMORY_CONTRACT_FIXTURES_V2.MemorySearchV2,
  ) as unknown as CodebaseMemorySearchV2;
  const pack = await searchCodeMemoryV2({
    principal: v2Principal,
    request: {
      ...searchFixture,
      request_id: `${suffix}-search`,
      consumer: {
        ...searchFixture.consumer,
        consumer_run_id: producerRunId,
      },
      tenant: { project_id: context.projectA },
      resource_selector: { canonical_resource_id: REPOSITORY_ID },
      applicability: {
        ...searchFixture.applicability,
        repository_id: REPOSITORY_ID,
        base_sha: baseSha,
      },
    },
  }) as MemorySearchResultV2;
  const item = pack.items[0];
  if (!item) throw new Error("Missing v2 outbox search fixture item");

  const receiptFixture = structuredClone(
    MEMORY_CONTRACT_FIXTURES_V2.RunReceiptV2,
  ) as unknown as CodebaseRunReceiptV2;
  const evidenceBody = {
    schema_version: "pim.memory-code-evidence.v2" as const,
    manifest_id: `${suffix}-manifest`,
    refs: [{
      ...receiptFixture.evidence_manifest.refs[0]!,
      id: `${suffix}-evidence`,
      uri: `https://github.com/acme/checkout/commit/${baseSha}.diff`,
      digest: canonicalJsonSha256({ suffix }),
      origin_id: `${REPOSITORY_ID}:${baseSha}:${suffix}`,
    }],
  };
  const receipt: CodebaseRunReceiptV2 = {
    ...receiptFixture,
    external_session_id: `${suffix}-session`,
    producer: {
      ...receiptFixture.producer,
      consumer_run_id: producerRunId,
    },
    tenant: { project_id: context.projectA },
    resource_selector: { canonical_resource_id: REPOSITORY_ID },
    scope_snapshot: {
      schema_version: "pim.memory-scope-snapshot.codebase.v2",
      plane: "codebase",
      resource_binding: pack.resource_binding,
      repository_id: REPOSITORY_ID,
      base_sha: baseSha,
      scope_snapshot_digest: pack.scope_snapshot_digest,
    },
    retrieval_feedback: [],
    evidence_manifest: {
      ...evidenceBody,
      digest: canonicalEvidenceManifestDigest(evidenceBody),
    },
    candidates: [],
  };
  const now = new Date().toISOString();
  submitCodeMemoryRunReceiptV2({
    principal: v2Principal,
    producerRunId,
    idempotencyKey: `${suffix}-receipt-key`,
    receipt,
    now,
  });
  const feedback: MemoryFeedbackV2 = {
    schema_version: "pim.memory-feedback.v2",
    feedback_revision: 1,
    retrieval_pack_id: pack.retrieval_pack_id,
    record_id: item.record_id,
    record_version: item.record_version,
    producer_run_id: producerRunId,
    plane: "codebase",
    resource_row_id: pack.resource_binding.resource_row_id,
    scope_snapshot_digest: pack.scope_snapshot_digest,
    disposition,
    reason_code: `${disposition}_outbox_review`,
    outcome_evidence_refs: [],
    event_time: now,
  };
  const accepted = appendCodeMemoryFeedbackV2({
    principal: v2Principal,
    idempotencyKey: `${suffix}-feedback-key`,
    feedback,
    now,
  });
  const jobs = db.prepare(
    `SELECT job.job_id, signal.signal_id, signal.signal_type
     FROM memory_v2_feedback_review_signals AS signal
     INNER JOIN memory_outbox AS job ON job.job_id = signal.outbox_job_id
     WHERE signal.feedback_id = ?
     ORDER BY signal.signal_type`,
  ).all(accepted.feedback_id) as unknown as Array<{
    job_id: string;
    signal_id: string;
    signal_type: string;
  }>;
  return { feedbackId: accepted.feedback_id, recordId: item.record_id, jobs, now };
}

function insertLegacySignal(input: {
  feedbackId: string;
  signalId: string;
  status: "open" | "resolved";
  now: string;
}): void {
  const suffix = uniqueId("legacy-signal");
  const packId = `${suffix}-pack`;
  const repository = resolveMemoryRepository(
    context.orgA.id,
    context.projectA,
    REPOSITORY_ID,
  );
  if (!repository) throw new Error("Missing legacy outbox repository fixture");
  db.prepare(
    `INSERT INTO memory_retrieval_packs
       (retrieval_pack_id, org_id, project_id, request_id, request_digest,
        repository_row_id, repository_id, harness_id, plane, query, policy_version,
        ranker_version, authorized_scope_json, token_count, omitted_count,
        response_json, created_at, expires_at, consumer_run_id, request_base_sha)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'codebase', 'outbox collision',
             'outbox-test', 'outbox-test', '[]', 1, 0, '{}', ?, ?, ?, ?)`,
  ).run(
    packId,
    context.orgA.id,
    context.projectA,
    `${suffix}-request`,
    canonicalJsonSha256({ suffix }),
    repository.repository_row_id,
    REPOSITORY_ID,
    input.now,
    new Date(Date.parse(input.now) + 60_000).toISOString(),
    `${suffix}-run`,
    TREE_SHA,
  );
  db.prepare(
    `INSERT INTO memory_retrieval_pack_items
       (retrieval_pack_id, item_order, record_id, record_version, token_count,
        rank_score, match_reasons_json, prompt_eligible)
     VALUES (?, 0, ?, 1, 1, 1, '[]', 0)`,
  ).run(packId, context.seededRecordId);
  const feedbackJson = {
    disposition: "harmful",
    reason_code: "legacy_collision_fixture",
  };
  db.prepare(
    `INSERT INTO memory_feedback
       (feedback_id, org_id, project_id, receipt_id, producer_run_id,
        retrieval_pack_id, record_id, record_version, feedback_stage,
        feedback_revision, feedback_json, feedback_digest, created_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, 1, 'later', 1, ?, ?, ?)`,
  ).run(
    input.feedbackId,
    context.orgA.id,
    context.projectA,
    `${suffix}-run`,
    packId,
    context.seededRecordId,
    JSON.stringify(feedbackJson),
    canonicalJsonSha256(feedbackJson),
    input.now,
  );
  db.prepare(
    `INSERT INTO memory_review_signals
       (signal_id, org_id, project_id, feedback_id, record_id, record_version,
        signal_type, reason_code, status, created_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, 1, 'harmful_review', 'legacy_collision_fixture', ?, ?, ?)`,
  ).run(
    input.signalId,
    context.orgA.id,
    context.projectA,
    input.feedbackId,
    context.seededRecordId,
    input.status,
    input.now,
    input.status === "resolved" ? input.now : null,
  );
}

beforeAll(async () => {
  context = await createMemoryTestContext();
  const owner = db.prepare(
    "SELECT created_by_user_id FROM projects WHERE project_id = ?",
  ).get(context.projectA) as { created_by_user_id: string };
  const token = createServiceToken({
    orgId: context.orgA.id,
    name: "Memory v2 outbox test authority",
    scopes: ["memory:search", "memory:receipt:write", "memory:feedback:write"],
    createdByUserId: owner.created_by_user_id,
    projectId: context.projectA,
    repositoryIds: [REPOSITORY_ID],
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  v2Principal = verifyMemoryV2ServiceToken(token.token)!.authorization;
});

afterAll(async () => {
  if (context) await context.app.close();
});

describe("memory outbox durability", () => {
  it("records one stable completed attempt for candidate validation", () => {
    const now = "2026-08-03T20:00:00.000Z";
    const queued = createQueuedCandidate(now);

    expect(runMemoryOutboxPass({
      workerId: "candidate-worker",
      maxJobs: 1,
      aggregateIds: [queued.candidateId],
      now,
    })).toEqual({ claimed: 1, completed: 1, retried: 0, deadLettered: 0 });
    expect(runMemoryOutboxPass({
      workerId: "candidate-worker-replay",
      maxJobs: 1,
      aggregateIds: [queued.candidateId],
      now,
    })).toEqual({ claimed: 0, completed: 0, retried: 0, deadLettered: 0 });

    expect(db.prepare(
      `SELECT status, attempt_count, lease_owner, lease_expires_at, completed_at
       FROM memory_outbox WHERE job_id = ?`,
    ).get(queued.jobId)).toEqual({
      status: "completed",
      attempt_count: 1,
      lease_owner: null,
      lease_expires_at: null,
      completed_at: now,
    });
    expect(db.prepare(
      `SELECT attempt_number, worker_id, outcome, error_code
       FROM memory_outbox_attempts WHERE job_id = ?`,
    ).all(queued.jobId)).toEqual([{
      attempt_number: 1,
      worker_id: "candidate-worker",
      outcome: "completed",
      error_code: null,
    }]);
    expect(db.prepare(
      "SELECT current_status FROM memory_candidates_v1 WHERE candidate_id = ?",
    ).get(queued.candidateId)).toEqual({ current_status: "pending_merge" });
  });

  it("reclaims an expired lease without duplicating the completed attempt", () => {
    const now = "2026-08-03T21:00:00.000Z";
    const queued = createQueuedCandidate(now);
    runMemoryOutboxPass({
      workerId: "candidate-primer",
      maxJobs: 1,
      aggregateIds: [queued.candidateId],
      now,
    });
    const recoveryJobId = uniqueId("expired-lease-job");
    insertSyntheticJob({
      jobId: recoveryJobId,
      jobType: "candidate_validation",
      aggregateId: queued.candidateId,
      status: "leased",
      attemptCount: 1,
      maxAttempts: 3,
      now,
      leaseOwner: "crashed-worker",
      leaseExpiresAt: "2026-08-03T20:59:59.000Z",
    });
    db.prepare(
      `INSERT INTO memory_outbox_attempts
         (attempt_id, job_id, attempt_number, worker_id, started_at,
          completed_at, outcome, error_code)
       VALUES (?, ?, 1, 'crashed-worker', ?, NULL, NULL, NULL)`,
    ).run(uniqueId("attempt"), recoveryJobId, "2026-08-03T20:59:00.000Z");

    expect(runMemoryOutboxPass({
      workerId: "recovery-worker",
      maxJobs: 1,
      aggregateIds: [queued.candidateId],
      now,
    })).toEqual({ claimed: 1, completed: 1, retried: 0, deadLettered: 0 });
    expect(db.prepare(
      "SELECT status, attempt_count, lease_owner FROM memory_outbox WHERE job_id = ?",
    ).get(recoveryJobId)).toEqual({
      status: "completed",
      attempt_count: 2,
      lease_owner: null,
    });
    expect(db.prepare(
      `SELECT attempt_number, worker_id, outcome
       FROM memory_outbox_attempts WHERE job_id = ? ORDER BY attempt_number`,
    ).all(recoveryJobId)).toEqual([
      { attempt_number: 1, worker_id: "crashed-worker", outcome: null },
      { attempt_number: 2, worker_id: "recovery-worker", outcome: "completed" },
    ]);
  });

  it("bounds retries, dead-letters failures, and records replay observability", () => {
    const firstAttemptAt = "2026-08-03T22:00:00.000Z";
    const secondAttemptAt = "2026-08-03T22:00:01.000Z";
    const replayedAt = "2026-08-03T22:05:00.000Z";
    const jobId = uniqueId("unsupported-job");
    insertSyntheticJob({
      jobId,
      jobType: "unsupported_fixture",
      aggregateId: uniqueId("unsupported-aggregate"),
      status: "pending",
      attemptCount: 0,
      maxAttempts: 2,
      now: firstAttemptAt,
    });

    expect(runMemoryOutboxPass({ workerId: "retry-worker", maxJobs: 1, now: firstAttemptAt }))
      .toEqual({ claimed: 1, completed: 0, retried: 1, deadLettered: 0 });
    expect(runMemoryOutboxPass({ workerId: "retry-worker", maxJobs: 1, now: firstAttemptAt }))
      .toEqual({ claimed: 0, completed: 0, retried: 0, deadLettered: 0 });
    expect(runMemoryOutboxPass({ workerId: "retry-worker", maxJobs: 1, now: secondAttemptAt }))
      .toEqual({ claimed: 1, completed: 0, retried: 0, deadLettered: 1 });

    expect(db.prepare(
      `SELECT status, attempt_count, last_error_code, lease_owner
       FROM memory_outbox WHERE job_id = ?`,
    ).get(jobId)).toEqual({
      status: "dead_letter",
      attempt_count: 2,
      last_error_code: "outbox_job_unsupported",
      lease_owner: null,
    });
    expect(db.prepare(
      `SELECT attempt_number, outcome, error_code
       FROM memory_outbox_attempts WHERE job_id = ? ORDER BY attempt_number`,
    ).all(jobId)).toEqual([
      { attempt_number: 1, outcome: "retry", error_code: "outbox_job_unsupported" },
      { attempt_number: 2, outcome: "dead_letter", error_code: "outbox_job_unsupported" },
    ]);
    expect(listMemoryDeadLetters(context.orgA.id, context.projectA)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          job_id: jobId,
          error_code: "outbox_job_unsupported",
          replayed_at: null,
        }),
      ]),
    );

    expect(replayMemoryDeadLetter(jobId, replayedAt)).toBe(true);
    expect(db.prepare(
      `SELECT status, attempt_count, max_attempts, next_attempt_at
       FROM memory_outbox WHERE job_id = ?`,
    ).get(jobId)).toEqual({
      status: "pending",
      attempt_count: 2,
      max_attempts: 7,
      next_attempt_at: replayedAt,
    });
    expect(runMemoryOutboxPass({ workerId: "replay-worker", maxJobs: 1, now: replayedAt }))
      .toEqual({ claimed: 1, completed: 0, retried: 1, deadLettered: 0 });
    expect(db.prepare(
      `SELECT attempt_number, worker_id, outcome, error_code
       FROM memory_outbox_attempts WHERE job_id = ? AND attempt_number = 3`,
    ).get(jobId)).toEqual({
      attempt_number: 3,
      worker_id: "replay-worker",
      outcome: "retry",
      error_code: "outbox_job_unsupported",
    });
    expect(listMemoryDeadLetters(context.orgA.id, context.projectA)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ job_id: jobId, replayed_at: replayedAt }),
      ]),
    );
  });

  it("refreshes candidate validation CAS state when replaying a recoverable dead letter", () => {
    const failedAt = "2026-08-03T23:00:00.000Z";
    const replayedAt = "2026-08-03T23:05:00.000Z";
    const queued = createQueuedCandidate(failedAt);
    db.prepare(
      `UPDATE memory_outbox
       SET expected_version = 999, max_attempts = 1
       WHERE job_id = ?`,
    ).run(queued.jobId);

    expect(runMemoryOutboxPass({
      workerId: "recoverable-failure-worker",
      maxJobs: 1,
      aggregateIds: [queued.candidateId],
      now: failedAt,
    })).toEqual({ claimed: 1, completed: 0, retried: 0, deadLettered: 1 });
    const failedCandidate = db.prepare(
      `SELECT current_status, aggregate_version
       FROM memory_candidates_v1 WHERE candidate_id = ?`,
    ).get(queued.candidateId) as { current_status: string; aggregate_version: number };
    expect(failedCandidate).toEqual({ current_status: "validation_failed", aggregate_version: 3 });

    expect(replayMemoryDeadLetter(queued.jobId, replayedAt)).toBe(true);
    expect(db.prepare(
      `SELECT status, expected_version FROM memory_outbox WHERE job_id = ?`,
    ).get(queued.jobId)).toEqual({
      status: "pending",
      expected_version: failedCandidate.aggregate_version,
    });
    expect(runMemoryOutboxPass({
      workerId: "recovered-validation-worker",
      maxJobs: 1,
      aggregateIds: [queued.candidateId],
      now: replayedAt,
    })).toEqual({ claimed: 1, completed: 1, retried: 0, deadLettered: 0 });
    expect(db.prepare(
      "SELECT current_status FROM memory_candidates_v1 WHERE candidate_id = ?",
    ).get(queued.candidateId)).toEqual({ current_status: "pending_merge" });
  });

  it("completes source-qualified native-v2 harmful and stale review jobs", async () => {
    for (const disposition of ["harmful", "stale"] as const) {
      const fixture = await createV2FeedbackJobs(disposition);
      expect(fixture.jobs.map((job) => job.signal_type)).toEqual(
        disposition === "harmful"
          ? ["harmful_review"]
          : ["checkout_anchor_revalidation", "stale_review"],
      );
      expect(runMemoryOutboxPass({
        workerId: `v2-${disposition}-worker`,
        maxJobs: fixture.jobs.length,
        aggregateIds: [fixture.recordId],
        jobTypes: ["review_notification", "record_revalidation"],
        now: fixture.now,
      })).toEqual({
        claimed: fixture.jobs.length,
        completed: fixture.jobs.length,
        retried: 0,
        deadLettered: 0,
      });
      expect(db.prepare(
        `SELECT job_id, status FROM memory_outbox
         WHERE job_id IN (${fixture.jobs.map(() => "?").join(",")})
         ORDER BY job_id`,
      ).all(...fixture.jobs.map((job) => job.job_id))).toEqual(
        fixture.jobs
          .map((job) => ({ job_id: job.job_id, status: "completed" }))
          .sort((left, right) => left.job_id.localeCompare(right.job_id)),
      );
    }
  });

  it("uses the v2 source when legacy feedback and signal IDs collide", async () => {
    const fixture = await createV2FeedbackJobs("harmful");
    const job = fixture.jobs[0]!;
    insertLegacySignal({
      feedbackId: fixture.feedbackId,
      signalId: job.signal_id,
      status: "resolved",
      now: fixture.now,
    });

    expect(runMemoryOutboxPass({
      workerId: "v2-collision-worker",
      maxJobs: 1,
      aggregateIds: [fixture.recordId],
      jobTypes: ["review_notification"],
      now: fixture.now,
    })).toEqual({ claimed: 1, completed: 1, retried: 0, deadLettered: 0 });
    expect(db.prepare(
      "SELECT status, last_error_code FROM memory_outbox WHERE job_id = ?",
    ).get(job.job_id)).toEqual({ status: "completed", last_error_code: null });
  });

  it("dead-letters a v2-sourced review job when only a legacy closure exists", () => {
    const now = new Date().toISOString();
    const feedbackId = uniqueId("missing-v2-feedback");
    const signalId = uniqueId("missing-v2-signal");
    const jobId = uniqueId("missing-v2-closure-job");
    insertLegacySignal({ feedbackId, signalId, status: "open", now });
    insertSyntheticJob({
      jobId,
      jobType: "review_notification",
      aggregateType: "record",
      aggregateId: context.seededRecordId,
      payload: {
        feedback_source: "memory_v2_feedback_bindings",
        feedback_id: feedbackId,
        signal_id: signalId,
      },
      status: "pending",
      attemptCount: 0,
      maxAttempts: 1,
      now,
    });

    expect(runMemoryOutboxPass({
      workerId: "missing-v2-closure-worker",
      maxJobs: 1,
      aggregateIds: [context.seededRecordId],
      jobTypes: ["review_notification"],
      now,
    })).toEqual({ claimed: 1, completed: 0, retried: 0, deadLettered: 1 });
    expect(db.prepare(
      `SELECT status, attempt_count, last_error_code
       FROM memory_outbox WHERE job_id = ?`,
    ).get(jobId)).toEqual({
      status: "dead_letter",
      attempt_count: 1,
      last_error_code: "review_signal_not_found",
    });
    expect(listMemoryDeadLetters(context.orgA.id, context.projectA)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          job_id: jobId,
          error_code: "review_signal_not_found",
          replayed_at: null,
        }),
      ]),
    );
  });
});
