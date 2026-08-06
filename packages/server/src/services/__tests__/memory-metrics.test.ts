import { createHmac, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  MEMORY_CONTRACT_FIXTURES,
  canonicalJsonSha256,
  parseMemoryContract,
  type FiestaCodeEvidenceV2,
  type MemoryAttestationV1,
  type MemoryCandidateV1,
  type MemoryFeedbackV1,
  type MemorySearchResultV1,
  type MemorySearchV1,
  type RunReceiptResultV1,
  type RunReceiptV1,
} from "@pim/shared";
import {
  setMemoryGithubResolver,
} from "../memory-attestations.js";
import type { AuthoritativeGithubState } from "../memory-activation.js";
import {
  createCloudWatchMemoryMetricSink,
  emitMemoryOperationalMetrics,
  getMemoryIdChainTrace,
  getMemoryOperationalSnapshot,
  getMemorySloSnapshot,
  recordMemoryMetric,
  setMemoryMetricSink,
  type MemoryMetric,
} from "../memory-metrics.js";
import {
  createMemoryTestContext,
  type MemoryTestContext,
} from "../../routes/__tests__/memory-test-app.js";
import db from "../../db/connection.js";

const BASE_SHA = "0123456789abcdef0123456789abcdef01234567";
const HEAD_SHA = "89abcdef0123456789abcdef0123456789abcdef";
const MERGE_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REPOSITORY_ID = "github.com/acme/checkout";
const WEBHOOK_SECRET = "memory-metrics-test-secret";

interface MetricCandidateRun {
  producerRunId: string;
  candidate: MemoryCandidateV1;
  receipt: RunReceiptV1;
  manifest: FiestaCodeEvidenceV2;
  diffDigest: string;
}

let context: MemoryTestContext;
let previousWebhookSecret: string | undefined;
let previousActivationRepositories: string | undefined;
const authoritativeStates = new Map<string, AuthoritativeGithubState>();

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function searchRequest(input: {
  producerRunId: string;
  requestId?: string;
  query?: string;
  paths?: string[];
  symbols?: string[];
  producer?: RunReceiptV1["producer"];
}): MemorySearchV1 {
  const fixture = structuredClone(
    MEMORY_CONTRACT_FIXTURES.MemorySearchV1,
  ) as unknown as MemorySearchV1;
  return parseMemoryContract("MemorySearchV1", {
    ...fixture,
    request_id: input.requestId ?? `metrics-search-${randomUUID()}`,
    consumer: {
      ...fixture.consumer,
      ...(input.producer ? {
        harness_version: input.producer.harness_version,
        workflow_version: input.producer.workflow_version,
        adapter_version: input.producer.adapter_version,
      } : {}),
      consumer_run_id: input.producerRunId,
    },
    tenant: { project_id: context.projectA },
    applicability: {
      repository_id: REPOSITORY_ID,
      base_sha: BASE_SHA,
      paths: input.paths ?? ["src/payments/retry.ts"],
      symbols: input.symbols ?? ["retryCharge"],
    },
    task: {
      ...fixture.task,
      query: input.query ?? fixture.task.query,
    },
  });
}

async function search(input: Parameters<typeof searchRequest>[0]): Promise<MemorySearchResultV1> {
  const response = await context.app.inject({
    method: "POST",
    url: "/api/v1/memory/search",
    headers: auth(context.tokenA),
    payload: searchRequest(input),
  });
  expect(response.statusCode, response.body).toBe(200);
  return parseMemoryContract("MemorySearchResultV1", response.json());
}

function buildCandidateRun(
  producerRunId: string,
  initialPack: MemorySearchResultV1,
): MetricCandidateRun {
  const suffix = randomUUID();
  const evidenceRefId = `metrics-diff-${suffix}`;
  const diffDigest = canonicalJsonSha256({ metrics_diff: suffix });
  const manifestContents: Omit<FiestaCodeEvidenceV2, "digest"> = {
    schema_version: "fiesta.code-evidence.v2",
    manifest_id: `metrics-manifest-${suffix}`,
    refs: [{
      id: evidenceRefId,
      type: "git_diff",
      uri: `https://github.com/acme/checkout/commit/${HEAD_SHA}.diff`,
      digest: diffDigest,
      origin_id: `${REPOSITORY_ID}:${HEAD_SHA}:${evidenceRefId}`,
      occurred_at: new Date().toISOString(),
      source_authority: "observed",
    }],
  };
  const manifest: FiestaCodeEvidenceV2 = {
    ...manifestContents,
    digest: canonicalJsonSha256(manifestContents),
  };
  const candidate: MemoryCandidateV1 = {
    schema_version: "pim.memory-candidate.v1",
    client_candidate_id: `metrics-candidate-${suffix}`,
    plane: "codebase",
    kind: "constraint",
    content: {
      summary: `Preserve the observable activation invariant ${suffix}.`,
      details: `The ${suffix} record must retain its complete ID chain without logging this memory body.`,
      rationale: "Operational tracing must connect immutable IDs without exposing memory content.",
    },
    applicability: {
      repository_id: REPOSITORY_ID,
      base_sha: BASE_SHA,
      paths: [`src/metrics-${suffix}.ts`],
      symbols: [`metrics_${suffix.replaceAll("-", "_")}`],
      task_classes: ["bug_fix"],
    },
    validation: { strategy: "repository_anchors" },
    exceptions: ["Does not apply outside the exact metrics fixture path."],
    source_run_ids: [producerRunId],
    evidence_refs: [evidenceRefId],
    extraction: {
      method: "model_then_deterministic_validation",
      extractor_version: "memory-metrics-test-v1",
      confidence: 0.94,
    },
    activation_requirement_requested: "verified_merge",
  };
  const initialItem = initialPack.items[0]!;
  const receipt: RunReceiptV1 = {
    schema_version: "pim.run-receipt.v1",
    external_session_id: `metrics-session-${suffix}`,
    producer: {
      harness_id: "fiesta",
      harness_version: "memory-metrics-test",
      workflow_version: "code-change.v3",
      adapter_version: "fiesta-pim-adapter.v1",
    },
    tenant: { project_id: context.projectA },
    repository: {
      repository_id: REPOSITORY_ID,
      display_slug: "Acme/Checkout",
      base_sha: BASE_SHA,
      candidate_tree_sha: HEAD_SHA,
      provider_pull_request_id: `github:acme/checkout#${suffix}`,
      pr_head_sha: HEAD_SHA,
      pull_request_url: `https://github.com/acme/checkout/pull/${suffix}`,
    },
    task: {
      task_class: "bug_fix",
      summary: `Exercise the memory trace chain for ${suffix}.`,
    },
    outcome: {
      status: "completed",
      terminal_stage: "close",
      reason_code: "completed",
      verification_status: "passed",
      publication_status: "pr_open",
      gate_attestation_ids: [],
      failure_fingerprint: null,
    },
    retrieval_feedback: [{
      retrieval_pack_id: initialPack.retrieval_pack_id,
      items: [{
        record_id: initialItem.record_id,
        record_version: initialItem.record_version,
        checkout_validation: {
          disposition: "validated",
          reason_code: "metrics_fixture_validated",
        },
        terminal_outcome: {
          exposure: { status: "not_exposed", consumer_phase: "shadow" },
          use_disposition: "unknown",
          use_attribution_confidence: 1,
          utility: "unknown",
          utility_source: "unknown",
          reason_code: "metrics_fixture_shadow",
        },
      }],
    }],
    evidence_manifest: manifest,
    candidates: [candidate],
  };
  return { producerRunId, candidate, receipt, manifest, diffDigest };
}

async function putCandidateRun(run: MetricCandidateRun): Promise<{
  receipt: RunReceiptResultV1;
  candidateId: string;
}> {
  const response = await context.app.inject({
    method: "PUT",
    url: `/api/v1/memory/run-receipts/${encodeURIComponent(run.producerRunId)}`,
    headers: {
      ...auth(context.receiptTokenA),
      "idempotency-key": `metrics-receipt-${run.producerRunId}`,
    },
    payload: run.receipt,
  });
  expect(response.statusCode, response.body).toBe(200);
  const receipt = parseMemoryContract("RunReceiptResultV1", response.json());
  expect(receipt.candidate_results[0]).toMatchObject({ status: "pending_merge" });
  return {
    receipt,
    candidateId: receipt.candidate_results[0]!.candidate_id,
  };
}

function attestationFor(run: MetricCandidateRun): MemoryAttestationV1 {
  const deliveryId = `metrics-delivery-${randomUUID()}`;
  return parseMemoryContract("MemoryAttestationV1", {
    schema_version: "pim.memory-attestation.v1",
    attestation_id: `metrics-attestation-${randomUUID()}`,
    provider_event_id: deliveryId,
    type: "github_merge",
    repository_id: REPOSITORY_ID,
    provider_pull_request_id: run.receipt.repository!.provider_pull_request_id,
    base_sha: BASE_SHA,
    head_sha: HEAD_SHA,
    merge_sha: MERGE_SHA,
    manifest_digest: run.manifest.digest,
    occurred_at: new Date().toISOString(),
  });
}

async function activateRun(
  run: MetricCandidateRun,
  attestation: MemoryAttestationV1,
) {
  authoritativeStates.set(attestation.provider_event_id, {
    repositoryId: REPOSITORY_ID,
    providerPullRequestId: attestation.provider_pull_request_id!,
    merged: true,
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    mergeSha: MERGE_SHA,
    manifestDigest: run.manifest.digest,
    finalDiffDigest: run.diffDigest,
    occurredAt: attestation.occurred_at,
    sourceCursor: attestation.provider_event_id,
  });
  const rawBody = JSON.stringify(attestation);
  const signature = createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex");
  const response = await context.app.inject({
    method: "POST",
    url: "/api/v1/memory/attestations/github",
    headers: {
      ...auth(context.attestTokenA),
      "content-type": "application/json",
      "x-github-delivery": attestation.provider_event_id,
      "x-github-event": "pull_request",
      "x-hub-signature-256": `sha256=${signature}`,
    },
    payload: rawBody,
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toMatchObject({ status: "activated" });
  return response.json() as {
    candidate_ids: string[];
    record_ids: string[];
  };
}

beforeAll(async () => {
  previousWebhookSecret = process.env.MEMORY_GITHUB_WEBHOOK_SECRET;
  previousActivationRepositories = process.env.MEMORY_ACTIVATION_REPOSITORIES;
  process.env.MEMORY_GITHUB_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.MEMORY_ACTIVATION_REPOSITORIES = REPOSITORY_ID;
  context = await createMemoryTestContext();
  setMemoryGithubResolver(async ({ attestation }) => {
    const state = authoritativeStates.get(attestation.provider_event_id);
    if (!state) throw new Error("Missing authoritative state for metrics fixture");
    return state;
  });
});

afterEach(() => {
  setMemoryMetricSink(null);
});

afterAll(async () => {
  setMemoryMetricSink(null);
  setMemoryGithubResolver(null);
  if (previousWebhookSecret === undefined) delete process.env.MEMORY_GITHUB_WEBHOOK_SECRET;
  else process.env.MEMORY_GITHUB_WEBHOOK_SECRET = previousWebhookSecret;
  if (previousActivationRepositories === undefined) delete process.env.MEMORY_ACTIVATION_REPOSITORIES;
  else process.env.MEMORY_ACTIVATION_REPOSITORIES = previousActivationRepositories;
  if (context) await context.app.close();
});

describe("Slice 4 memory observability", () => {
  it("isolates sink failures and emits bounded CloudWatch dimensions", async () => {
    setMemoryMetricSink(() => {
      throw new Error("telemetry unavailable");
    });
    expect(() => recordMemoryMetric({
      name: "SearchOutcome",
      value: 1,
      unit: "Count",
      dimensions: { outcome: "success" },
      fields: { request_id: "metrics-direct-fixture" },
    })).not.toThrow();

    const response = await context.app.inject({
      method: "POST",
      url: "/api/v1/memory/search",
      headers: auth(context.tokenA),
      payload: searchRequest({ producerRunId: `sink-isolation-${randomUUID()}` }),
    });
    expect(response.statusCode, response.body).toBe(200);

    const logged: Array<{ obj: unknown; msg?: string }> = [];
    const cloudWatchSink = createCloudWatchMemoryMetricSink({
      info: (obj, msg) => logged.push({ obj, msg }),
    });
    cloudWatchSink({
      name: "FeedbackOutcome",
      value: 1,
      unit: "Count",
      timestampMs: 1234,
      dimensions: { outcome: "accepted", disposition: "helpful" },
      fields: { feedback_id: "feedback-metrics-fixture" },
    });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      msg: "Memory metric",
      obj: {
        _aws: {
          Timestamp: 1234,
          CloudWatchMetrics: [{
            Namespace: "PIM/Memory",
            Dimensions: [["outcome", "disposition"]],
            Metrics: [{ Name: "FeedbackOutcome", Unit: "Count" }],
          }],
        },
        feedback_id: "feedback-metrics-fixture",
        FeedbackOutcome: 1,
      },
    });
  });

  it("reports DB-backed operational counts with zero prompt visibility and boundary leakage", () => {
    const snapshot = getMemoryOperationalSnapshot(
      context.orgA.id,
      context.projectA,
      "2026-08-03T22:00:00.000Z",
    );
    expect(snapshot).toMatchObject({
      generatedAt: "2026-08-03T22:00:00.000Z",
      orgId: context.orgA.id,
      projectId: context.projectA,
      promptVisibleRecordCount: 0,
      crossBoundaryLeakageCount: 0,
      activeCandidatesWithoutCanonicalRecords: 0,
    });
    expect(snapshot.recordsByStatus.active).toBeGreaterThanOrEqual(1);
    expect(snapshot.retrievalPackCount).toBeGreaterThanOrEqual(1);
  });

  it("publishes low-cardinality SLO health and excludes replayed dead-letter history", () => {
    const now = "2026-08-03T22:00:00.000Z";
    const pendingAt = "1900-01-01T00:00:00.000Z";
    const failedAt = "1901-01-01T00:00:00.000Z";
    const futureRetryAt = "2027-01-01T00:00:00.000Z";
    const pendingJobId = `metrics-pending-${randomUUID()}`;
    const futureJobId = `metrics-future-${randomUUID()}`;
    const activeLeaseJobId = `metrics-active-lease-${randomUUID()}`;
    const deadJobId = `metrics-dead-${randomUUID()}`;
    const replayedJobId = `metrics-replayed-${randomUUID()}`;
    const baseline = getMemorySloSnapshot(now);
    const projectBaseline = getMemoryOperationalSnapshot(
      context.orgA.id,
      context.projectA,
      now,
    );
    const insertJob = db.prepare(
      `INSERT INTO memory_outbox
         (job_id, org_id, project_id, job_type, aggregate_type, aggregate_id,
          expected_version, payload_json, status, attempt_count, max_attempts,
          next_attempt_at, lease_owner, lease_expires_at, last_error_code,
          last_error_message, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, 'metrics_fixture', 'record', ?, 1, '{}', ?, 0, 5,
               ?, NULL, NULL, NULL, NULL, ?, ?, ?)`,
    );
    insertJob.run(
      pendingJobId,
      context.orgA.id,
      context.projectA,
      `aggregate-${pendingJobId}`,
      "pending",
      pendingAt,
      pendingAt,
      pendingAt,
      null,
    );
    insertJob.run(
      futureJobId,
      context.orgA.id,
      context.projectA,
      `aggregate-${futureJobId}`,
      "pending",
      futureRetryAt,
      "1800-01-01T00:00:00.000Z",
      "1800-01-01T00:00:00.000Z",
      null,
    );
    insertJob.run(
      activeLeaseJobId,
      context.orgA.id,
      context.projectA,
      `aggregate-${activeLeaseJobId}`,
      "leased",
      pendingAt,
      "1700-01-01T00:00:00.000Z",
      "1700-01-01T00:00:00.000Z",
      null,
    );
    db.prepare(
      `UPDATE memory_outbox
       SET lease_owner = 'metrics-worker', lease_expires_at = ?
       WHERE job_id = ?`,
    ).run(futureRetryAt, activeLeaseJobId);
    insertJob.run(
      deadJobId,
      context.orgA.id,
      context.projectA,
      `aggregate-${deadJobId}`,
      "dead_letter",
      failedAt,
      failedAt,
      failedAt,
      null,
    );
    insertJob.run(
      replayedJobId,
      context.orgA.id,
      context.projectA,
      `aggregate-${replayedJobId}`,
      "completed",
      failedAt,
      failedAt,
      failedAt,
      failedAt,
    );
    const insertDeadLetter = db.prepare(
      `INSERT INTO memory_dead_letters
         (dead_letter_id, job_id, org_id, project_id, job_type, aggregate_type,
          aggregate_id, payload_digest, error_code, error_message, failed_at, replayed_at)
       VALUES (?, ?, ?, ?, 'metrics_fixture', 'record', ?, ?,
               'metrics_fixture_failed', 'bounded failure', ?, ?)`,
    );
    insertDeadLetter.run(
      `dead-${deadJobId}`,
      deadJobId,
      context.orgA.id,
      context.projectA,
      `aggregate-${deadJobId}`,
      canonicalJsonSha256({ job_id: deadJobId }),
      failedAt,
      null,
    );
    insertDeadLetter.run(
      `dead-${replayedJobId}`,
      replayedJobId,
      context.orgA.id,
      context.projectA,
      `aggregate-${replayedJobId}`,
      canonicalJsonSha256({ job_id: replayedJobId }),
      failedAt,
      now,
    );

    const emitted: MemoryMetric[] = [];
    setMemoryMetricSink((metric) => emitted.push(metric));
    try {
      const snapshot = emitMemoryOperationalMetrics(now);
      expect(snapshot).toMatchObject({
        outboxBacklog: baseline.outboxBacklog + 3,
        deadLetterCount: baseline.deadLetterCount + 1,
        oldestOutboxAgeSeconds: Math.floor((Date.parse(now) - Date.parse(pendingAt)) / 1_000),
        oldestDeadLetterAgeSeconds: Math.floor((Date.parse(now) - Date.parse(failedAt)) / 1_000),
        activePointerViolationCount: 0,
        boundaryLeakageCount: 0,
      });
      expect(getMemoryOperationalSnapshot(
        context.orgA.id,
        context.projectA,
        now,
      ).deadLetterCount).toBe(projectBaseline.deadLetterCount + 1);
      expect(emitted.map((metric) => [metric.name, metric.value, metric.unit])).toEqual([
        ["OutboxBacklog", snapshot.outboxBacklog, "Count"],
        ["OldestOutboxAgeSeconds", snapshot.oldestOutboxAgeSeconds, "Seconds"],
        ["DeadLetterCount", snapshot.deadLetterCount, "Count"],
        ["OldestDeadLetterAgeSeconds", snapshot.oldestDeadLetterAgeSeconds, "Seconds"],
        ["ActivePointerViolationCount", 0, "Count"],
        ["BoundaryLeakageCount", 0, "Count"],
      ]);
      expect(emitted.every((metric) => metric.dimensions === undefined)).toBe(true);
    } finally {
      db.prepare("DELETE FROM memory_dead_letters WHERE job_id IN (?, ?)")
        .run(deadJobId, replayedJobId);
      db.prepare("DELETE FROM memory_outbox WHERE job_id IN (?, ?, ?, ?, ?)")
        .run(pendingJobId, futureJobId, activeLeaseJobId, deadJobId, replayedJobId);
    }
  });

  it("correlates the full ID chain and emits search, feedback, and activation outcomes without bodies", async () => {
    const metrics: MemoryMetric[] = [];
    setMemoryMetricSink((metric) => metrics.push(metric));

    const producerRunId = `metrics-run-${randomUUID()}`;
    const initialPack = await search({ producerRunId });
    const initialItem = initialPack.items[0]!;
    const run = buildCandidateRun(producerRunId, initialPack);
    const accepted = await putCandidateRun(run);
    const attestation = attestationFor(run);
    const activated = await activateRun(run, attestation);
    const recordId = activated.record_ids[0]!;
    expect(activated.candidate_ids).toEqual([accepted.candidateId]);

    const applicability = run.candidate.applicability as {
      paths?: string[];
      symbols?: string[];
    };
    const futurePack = await search({
      producerRunId: `metrics-future-run-${randomUUID()}`,
      query: run.candidate.content.summary,
      paths: applicability.paths,
      symbols: applicability.symbols,
      producer: run.receipt.producer,
    });
    expect(futurePack.items.map((item) => item.record_id)).toContain(recordId);

    const laterFeedback = parseMemoryContract("MemoryFeedbackV1", {
      schema_version: "pim.memory-feedback.v1",
      feedback_revision: 1,
      retrieval_pack_id: initialPack.retrieval_pack_id,
      record_id: initialItem.record_id,
      record_version: initialItem.record_version,
      producer_run_id: producerRunId,
      repository_id: REPOSITORY_ID,
      base_sha: BASE_SHA,
      disposition: "harmful",
      reason_code: "metrics_fixture_review_signal",
      outcome_evidence_refs: [],
      event_time: new Date().toISOString(),
    } satisfies MemoryFeedbackV1);
    const feedbackResponse = await context.app.inject({
      method: "POST",
      url: "/api/v1/memory/feedback",
      headers: auth(context.feedbackTokenA),
      payload: laterFeedback,
    });
    expect(feedbackResponse.statusCode, feedbackResponse.body).toBe(200);

    const trace = getMemoryIdChainTrace(context.orgA.id, context.projectA, producerRunId);
    expect(trace).not.toBeNull();
    expect(trace).toMatchObject({
      producerRunId,
      receiptId: accepted.receipt.receipt_id,
    });
    expect(trace!.retrievals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        feedbackStage: "receipt",
        retrievalPackId: initialPack.retrieval_pack_id,
        recordId: initialItem.record_id,
        recordVersion: initialItem.record_version,
      }),
      expect.objectContaining({
        feedbackStage: "later",
        retrievalPackId: initialPack.retrieval_pack_id,
        recordId: initialItem.record_id,
        recordVersion: initialItem.record_version,
      }),
    ]));
    expect(trace!.candidates).toHaveLength(1);
    expect(trace!.candidates[0]).toMatchObject({
      candidateId: accepted.candidateId,
      manifestId: run.manifest.manifest_id,
      activeRecordId: recordId,
      activeRecordVersion: 1,
      futureRetrievalPackIds: expect.arrayContaining([futurePack.retrieval_pack_id]),
    });
    expect(trace!.candidates[0]!.transitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ toStatus: "received", reasonCode: "candidate_received" }),
      expect.objectContaining({ toStatus: "pending_merge", reasonCode: "verified_merge_required" }),
      expect.objectContaining({ toStatus: "active", reasonCode: "verified_merge_activated" }),
    ]));
    expect(getMemoryIdChainTrace(context.orgB.id, context.projectB, producerRunId)).toBeNull();

    expect(metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "SearchOutcome",
        dimensions: { outcome: "success", plane: "codebase" },
      }),
      expect.objectContaining({
        name: "SearchLatency",
        unit: "Milliseconds",
        dimensions: { outcome: "success", plane: "codebase" },
      }),
      expect.objectContaining({
        name: "ActivationOutcome",
        dimensions: { outcome: "activated", attestation_type: "github_merge" },
        fields: expect.objectContaining({
          candidate_id: accepted.candidateId,
          record_id: recordId,
          reason_code: null,
        }),
      }),
      expect.objectContaining({
        name: "FeedbackOutcome",
        dimensions: { outcome: "accepted", disposition: "harmful" },
      }),
      expect.objectContaining({
        name: "ReviewSignalCount",
        value: 1,
        dimensions: { disposition: "harmful" },
      }),
    ]));
    const serializedMetrics = JSON.stringify(metrics);
    expect(serializedMetrics).not.toContain(run.candidate.content.details);
    expect(serializedMetrics).not.toContain(run.candidate.content.rationale);

    const snapshot = getMemoryOperationalSnapshot(context.orgA.id, context.projectA);
    expect(snapshot).toMatchObject({
      promptVisibleRecordCount: 0,
      crossBoundaryLeakageCount: 0,
      activeCandidatesWithoutCanonicalRecords: 0,
    });
    expect(snapshot.laterFeedbackCount).toBeGreaterThanOrEqual(1);
    expect(snapshot.openReviewSignalCount).toBeGreaterThanOrEqual(1);

    const pointerBaseline = getMemorySloSnapshot().activePointerViolationCount;
    for (const terminalStatus of ["stale", "revoked", "superseded", "expired"]) {
      db.prepare("UPDATE memory_records SET current_status = ? WHERE record_id = ?")
        .run(terminalStatus, recordId);
      expect(getMemoryOperationalSnapshot(
        context.orgA.id,
        context.projectA,
      ).activeCandidatesWithoutCanonicalRecords).toBe(0);
      expect(getMemorySloSnapshot().activePointerViolationCount).toBe(pointerBaseline);
    }
    db.prepare("UPDATE memory_records SET current_status = 'active' WHERE record_id = ?")
      .run(recordId);

    const originalRepository = db.prepare(
      "SELECT repository_row_id FROM memory_records WHERE record_id = ?",
    ).get(recordId) as { repository_row_id: string };
    const otherRepository = db.prepare(
      `SELECT repository_row_id FROM memory_repository_registry
       WHERE org_id = ? AND project_id = ? AND repository_id = 'github.com/acme/empty'`,
    ).get(context.orgA.id, context.projectA) as { repository_row_id: string };
    db.prepare("UPDATE memory_records SET repository_row_id = ? WHERE record_id = ?")
      .run(otherRepository.repository_row_id, recordId);
    try {
      expect(getMemorySloSnapshot().activePointerViolationCount).toBe(pointerBaseline + 1);
    } finally {
      db.prepare("UPDATE memory_records SET repository_row_id = ? WHERE record_id = ?")
        .run(originalRepository.repository_row_id, recordId);
    }
  });

  it("detects persisted pack items that cross an authorized scope boundary", async () => {
    const pack = await search({ producerRunId: `metrics-leak-check-${randomUUID()}` });
    const nextOrder = (db.prepare(
      `SELECT COALESCE(MAX(item_order), -1) + 1 AS item_order
       FROM memory_retrieval_pack_items WHERE retrieval_pack_id = ?`,
    ).get(pack.retrieval_pack_id) as { item_order: number }).item_order;
    db.prepare(
      `INSERT INTO memory_retrieval_pack_items
         (retrieval_pack_id, item_order, record_id, record_version, token_count,
          rank_score, match_reasons_json, prompt_eligible)
       VALUES (?, ?, ?, 1, 1, 0, '[]', 0)`,
    ).run(pack.retrieval_pack_id, nextOrder, context.otherTenantRecordId);
    try {
      expect(getMemoryOperationalSnapshot(
        context.orgA.id,
        context.projectA,
      ).crossBoundaryLeakageCount).toBeGreaterThanOrEqual(1);
    } finally {
      db.prepare(
        `DELETE FROM memory_retrieval_pack_items
         WHERE retrieval_pack_id = ? AND item_order = ?`,
      ).run(pack.retrieval_pack_id, nextOrder);
    }
    expect(getMemoryOperationalSnapshot(
      context.orgA.id,
      context.projectA,
    ).crossBoundaryLeakageCount).toBe(0);
  });
});
