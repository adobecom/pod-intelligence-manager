import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MEMORY_CONTRACT_FIXTURES,
  canonicalJsonSha256,
  parseMemoryContract,
  type FiestaCodeEvidenceV2,
  type MemoryCandidateV1,
  type RunReceiptV1,
} from "@pim/shared";
import db from "../../db/connection.js";
import { createMemoryTestContext, type MemoryTestContext } from "../../routes/__tests__/memory-test-app.js";
import {
  canonicalEvidenceManifestDigest,
  acceptMemoryRunReceipt,
} from "../memory-receipts.js";
import { resolveMemoryRepository } from "../memory-repository-registry.js";
import {
  listMemoryDeadLetters,
  replayMemoryDeadLetter,
  runMemoryOutboxPass,
} from "../memory-outbox.js";

const TREE_SHA = "89abcdef0123456789abcdef0123456789abcdef";

let context: MemoryTestContext;

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
    schema_version: "fiesta.code-evidence.v2" as const,
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
  const manifest = parseMemoryContract("FiestaCodeEvidenceV2", {
    ...manifestBody,
    digest: canonicalEvidenceManifestDigest(manifestBody),
  }) as FiestaCodeEvidenceV2;
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
     VALUES (?, ?, ?, ?, 'candidate', ?, 1, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL)`,
  ).run(
    input.jobId,
    context.orgA.id,
    context.projectA,
    input.jobType,
    input.aggregateId,
    JSON.stringify({ aggregate_id: input.aggregateId }),
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

beforeAll(async () => {
  context = await createMemoryTestContext();
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
});
