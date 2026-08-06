import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MEMORY_CONTRACT_FIXTURES,
  canonicalJsonSha256,
  parseMemoryContract,
  type FiestaCodeEvidenceV2,
  type MemoryAttestationV1,
  type MemoryCandidateStatusV1,
  type MemoryCandidateV1,
  type MemorySearchResultV1,
  type MemorySearchV1,
  type RunReceiptResultV1,
  type RunReceiptV1,
} from "@pim/shared";
import db from "../../db/connection.js";
import {
  listMemoryInboxDeadLetters,
  replayMemoryInboxDeadLetter,
  runMemoryInboxPass,
  runMemoryProviderReconciliationPass,
  setMemoryGithubProviderEventSource,
  setMemoryGithubResolver,
  submitGithubMemoryAttestation,
} from "../../services/memory-attestations.js";
import type { AuthoritativeGithubState } from "../../services/memory-activation.js";
import { getMemoryOperationalSnapshot } from "../../services/memory-metrics.js";
import { updateMemoryPromptPolicy } from "../../services/memory-prompt-policy.js";
import type { MemoryRepositoryBinding } from "../../services/memory-repository-registry.js";
import type { ServiceTokenAuthMetadata } from "../../services/service-tokens.js";
import { createMemoryTestContext, type MemoryTestContext } from "./memory-test-app.js";

const BASE_SHA = "0123456789abcdef0123456789abcdef01234567";
const HEAD_SHA = "89abcdef0123456789abcdef0123456789abcdef";
const MERGE_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const REPOSITORY_ID = "github.com/acme/checkout";
const WEBHOOK_SECRET = "memory-attestation-test-secret";

interface CandidateRun {
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

function installFixtureGithubResolver(): void {
  setMemoryGithubResolver(async ({ attestation }) => {
    const state = authoritativeStates.get(attestation.provider_event_id);
    if (!state) throw new Error("Missing authoritative GitHub state fixture");
    return state;
  });
}

function buildCandidateRun(input: { projectId?: string } = {}): CandidateRun {
  const suffix = randomUUID();
  const producerRunId = `fiesta:test:merge:${suffix}`;
  const evidenceRefId = `diff-${suffix}`;
  const diffDigest = canonicalJsonSha256({ diff: suffix });
  const manifestContents: Omit<FiestaCodeEvidenceV2, "digest"> = {
    schema_version: "fiesta.code-evidence.v2",
    manifest_id: `manifest-${suffix}`,
    refs: [{
      id: evidenceRefId,
      type: "git_diff",
      uri: `https://github.com/acme/checkout/commit/${HEAD_SHA}.diff`,
      digest: diffDigest,
      origin_id: `github.com/acme/checkout:${HEAD_SHA}:${evidenceRefId}`,
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
    client_candidate_id: `candidate-${suffix}`,
    plane: "codebase",
    kind: "constraint",
    content: {
      summary: `Preserve the verified merge invariant ${suffix}.`,
      details: `The ${suffix} path must remain readable through canonical and lexical storage.`,
      rationale: "Only independently verified merge evidence may make this repository claim active.",
    },
    applicability: {
      repository_id: "github.com/acme/checkout",
      base_sha: BASE_SHA,
      paths: [`src/verified-${suffix}.ts`],
      symbols: [`verified_${suffix.replaceAll("-", "_")}`],
      task_classes: ["bug_fix"],
    },
    validation: { strategy: "repository_anchors" },
    exceptions: ["Does not apply outside this exact repository path."],
    source_run_ids: [producerRunId],
    evidence_refs: [evidenceRefId],
    extraction: {
      method: "model_then_deterministic_validation",
      extractor_version: "fiesta-candidate-extractor.attestation-test-v1",
      confidence: 0.93,
    },
    activation_requirement_requested: "verified_merge",
  };
  const receipt: RunReceiptV1 = {
    schema_version: "pim.run-receipt.v1",
    external_session_id: `fiesta-thread-${suffix}`,
    producer: {
      harness_id: "fiesta",
      harness_version: "attestation-test",
      workflow_version: "code-change.v3",
      adapter_version: "fiesta-pim-adapter.v1",
    },
    tenant: { project_id: input.projectId ?? context.projectA },
    repository: {
      repository_id: "github.com/acme/checkout",
      display_slug: "Acme/Checkout",
      base_sha: BASE_SHA,
      candidate_tree_sha: HEAD_SHA,
      provider_pull_request_id: `github:acme/checkout#${suffix}`,
      pr_head_sha: HEAD_SHA,
      pull_request_url: `https://github.com/acme/checkout/pull/${suffix}`,
    },
    task: { task_class: "bug_fix", summary: `Verify merge activation for ${suffix}.` },
    outcome: {
      status: "completed",
      terminal_stage: "close",
      reason_code: "completed",
      verification_status: "passed",
      publication_status: "pr_open",
      gate_attestation_ids: [],
      failure_fingerprint: null,
    },
    retrieval_feedback: [],
    evidence_manifest: manifest,
    candidates: [candidate],
  };
  return { producerRunId, candidate, receipt, manifest, diffDigest };
}

async function putCandidateRun(
  run: CandidateRun,
  token = context.receiptTokenA,
): Promise<string> {
  const response = await context.app.inject({
    method: "PUT",
    url: `/api/v1/memory/run-receipts/${encodeURIComponent(run.producerRunId)}`,
    headers: {
      authorization: `Bearer ${token}`,
      "idempotency-key": `receipt-v1-${run.producerRunId}`,
    },
    payload: run.receipt,
  });
  expect(response.statusCode, response.body).toBe(200);
  const result = parseMemoryContract("RunReceiptResultV1", response.json()) as RunReceiptResultV1;
  expect(result.candidate_results[0]).toMatchObject({
    client_candidate_id: run.candidate.client_candidate_id,
    status: "pending_merge",
    blockers: ["verified_merge_required"],
  });
  return result.candidate_results[0]!.candidate_id;
}

async function candidateStatus(candidateId: string): Promise<MemoryCandidateStatusV1> {
  const response = await context.app.inject({
    method: "GET",
    url: `/api/v1/memory/candidates/${encodeURIComponent(candidateId)}`,
    headers: { authorization: `Bearer ${context.candidateReadTokenA}` },
  });
  expect(response.statusCode, response.body).toBe(200);
  return parseMemoryContract("MemoryCandidateStatusV1", response.json());
}

function attestationFor(
  run: CandidateRun,
  overrides: Partial<MemoryAttestationV1> = {},
): MemoryAttestationV1 {
  const deliveryId = `github-delivery-${randomUUID()}`;
  return parseMemoryContract("MemoryAttestationV1", {
    schema_version: "pim.memory-attestation.v1",
    attestation_id: `attestation-${randomUUID()}`,
    provider_event_id: deliveryId,
    type: "github_merge",
    repository_id: "github.com/acme/checkout",
    provider_pull_request_id: run.receipt.repository!.provider_pull_request_id,
    base_sha: BASE_SHA,
    head_sha: HEAD_SHA,
    merge_sha: MERGE_SHA,
    manifest_digest: run.manifest.digest,
    occurred_at: new Date().toISOString(),
    ...overrides,
  });
}

function authoritativeState(
  run: CandidateRun,
  attestation: MemoryAttestationV1,
  overrides: Partial<AuthoritativeGithubState> = {},
): AuthoritativeGithubState {
  return {
    repositoryId: attestation.repository_id,
    providerPullRequestId: attestation.provider_pull_request_id!,
    merged: attestation.type === "github_merge",
    reverted: attestation.type === "github_revert",
    baseSha: attestation.base_sha!,
    headSha: attestation.head_sha!,
    mergeSha: attestation.merge_sha ?? MERGE_SHA,
    manifestDigest: attestation.manifest_digest,
    finalDiffDigest: run.diffDigest,
    occurredAt: attestation.occurred_at,
    sourceCursor: attestation.provider_event_id,
    ...overrides,
  };
}

async function postAttestation(input: {
  attestation: MemoryAttestationV1;
  token?: string;
  signature?: string;
}) {
  const rawBody = JSON.stringify(input.attestation);
  const signature = input.signature ?? `sha256=${createHmac("sha256", WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex")}`;
  return context.app.inject({
    method: "POST",
    url: "/api/v1/memory/attestations/github",
    headers: {
      authorization: `Bearer ${input.token ?? context.attestTokenA}`,
      "content-type": "application/json",
      "x-github-delivery": input.attestation.provider_event_id,
      "x-github-event": "pull_request",
      "x-hub-signature-256": signature,
    },
    payload: rawBody,
  });
}

async function searchFor(run: CandidateRun): Promise<MemorySearchResultV1> {
  const fixture = structuredClone(MEMORY_CONTRACT_FIXTURES.MemorySearchV1) as unknown as MemorySearchV1;
  const applicability = run.candidate.applicability as {
    repository_id: string;
    paths?: string[];
    symbols?: string[];
  };
  const request: MemorySearchV1 = {
    ...fixture,
    request_id: `attestation-search-${randomUUID()}`,
    consumer: {
      ...fixture.consumer,
      harness_version: run.receipt.producer.harness_version,
      workflow_version: run.receipt.producer.workflow_version,
      adapter_version: run.receipt.producer.adapter_version,
      consumer_run_id: `fiesta:test:search:${randomUUID()}`,
    },
    tenant: { project_id: context.projectA },
    applicability: {
      repository_id: applicability.repository_id,
      paths: applicability.paths,
      symbols: applicability.symbols,
    },
    task: {
      query: run.candidate.content.summary,
      task_class: "bug_fix",
    },
    temporal: { mode: "current" },
  };
  const response = await context.app.inject({
    method: "POST",
    url: "/api/v1/memory/search",
    headers: { authorization: `Bearer ${context.tokenA}` },
    payload: request,
  });
  expect(response.statusCode).toBe(200);
  return parseMemoryContract("MemorySearchResultV1", response.json());
}

beforeAll(async () => {
  previousWebhookSecret = process.env.MEMORY_GITHUB_WEBHOOK_SECRET;
  previousActivationRepositories = process.env.MEMORY_ACTIVATION_REPOSITORIES;
  process.env.MEMORY_GITHUB_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.MEMORY_ACTIVATION_REPOSITORIES = REPOSITORY_ID;
  context = await createMemoryTestContext();
  installFixtureGithubResolver();
});

afterAll(async () => {
  setMemoryGithubProviderEventSource(null);
  setMemoryGithubResolver(null);
  if (previousWebhookSecret === undefined) delete process.env.MEMORY_GITHUB_WEBHOOK_SECRET;
  else process.env.MEMORY_GITHUB_WEBHOOK_SECRET = previousWebhookSecret;
  if (previousActivationRepositories === undefined) delete process.env.MEMORY_ACTIVATION_REPOSITORIES;
  else process.env.MEMORY_ACTIVATION_REPOSITORIES = previousActivationRepositories;
  if (context) await context.app.close();
});

describe("Slice 3 GitHub attestation trust path", () => {
  it("rejects a bad signature and prevents a receipt writer from attesting", async () => {
    const run = buildCandidateRun();
    const attestation = attestationFor(run);
    authoritativeStates.set(attestation.provider_event_id, authoritativeState(run, attestation));

    const forged = await postAttestation({
      attestation,
      signature: `sha256=${"0".repeat(64)}`,
    });
    expect(forged.statusCode).toBe(401);
    expect(forged.json()).toMatchObject({ code: "authentication_required" });

    const wrongScope = await postAttestation({
      attestation,
      token: context.receiptTokenA,
    });
    expect(wrongScope.statusCode).toBe(403);
    expect(wrongScope.json()).toMatchObject({ code: "resource_binding_mismatch" });
    expect(db.prepare(
      "SELECT inbox_event_id FROM memory_inbox WHERE provider_delivery_id = ?",
    ).get(attestation.provider_event_id)).toBeUndefined();
  });

  it("fails closed when the activation repository allowlist is absent", async () => {
    const run = buildCandidateRun();
    const attestation = attestationFor(run);
    authoritativeStates.set(attestation.provider_event_id, authoritativeState(run, attestation));
    delete process.env.MEMORY_ACTIVATION_REPOSITORIES;
    try {
      const response = await postAttestation({ attestation });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: "resource_binding_mismatch" });
      expect(db.prepare(
        "SELECT inbox_event_id FROM memory_inbox WHERE provider_delivery_id = ?",
      ).get(attestation.provider_event_id)).toBeUndefined();
    } finally {
      process.env.MEMORY_ACTIVATION_REPOSITORIES = REPOSITORY_ID;
    }
  });

  it("never replays a delivery result across an org, project, or repository scope", async () => {
    const run = buildCandidateRun();
    const attestation = attestationFor(run);
    authoritativeStates.set(attestation.provider_event_id, authoritativeState(run, attestation));
    const original = await postAttestation({ attestation });
    expect(original.statusCode).toBe(200);

    const repository = db.prepare(
      `SELECT * FROM memory_repository_registry
       WHERE org_id = ? AND project_id = ? AND repository_id = ?`,
    ).get(context.orgB.id, context.projectB, REPOSITORY_ID) as unknown as MemoryRepositoryBinding;
    const auth: ServiceTokenAuthMetadata = {
      kind: "service_token",
      tokenId: `scope-collision-${randomUUID()}`,
      servicePrincipalId: `scope-collision-principal-${randomUUID()}`,
      scopes: ["memory:attest"],
      orgId: context.orgB.id,
      projectId: context.projectB,
      repositoryBindings: [{
        repositoryRowId: repository.repository_row_id,
        repositoryId: repository.repository_id,
      }],
    };
    await expect(submitGithubMemoryAttestation({
      auth,
      repository,
      deliveryId: attestation.provider_event_id,
      rawBody: Buffer.from(JSON.stringify(attestation)),
      attestation,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: "idempotency_conflict",
    });
  });

  it("retains a verified merge received before its candidate and reconciles it later", async () => {
    const run = buildCandidateRun();
    const attestation = attestationFor(run);
    authoritativeStates.set(attestation.provider_event_id, authoritativeState(run, attestation));

    const early = await postAttestation({ attestation });
    expect(early.statusCode).toBe(200);
    const originalResponse = early.json();
    expect(originalResponse).toMatchObject({
      schema_version: "pim.memory-attestation-result.v1",
      accepted: true,
      duplicate: false,
      status: "unmatched",
      candidate_ids: [],
    });
    expect(db.prepare(
      "SELECT status FROM memory_inbox WHERE provider_delivery_id = ?",
    ).get(attestation.provider_event_id)).toMatchObject({ status: "unmatched" });

    const candidateId = await putCandidateRun(run);
    const status = await candidateStatus(candidateId);
    expect(status.status).toBe("active");
    expect(status.active_record?.record_version).toBe(1);
    expect(db.prepare(
      "SELECT status FROM memory_inbox WHERE provider_delivery_id = ?",
    ).get(attestation.provider_event_id)).toMatchObject({ status: "completed" });
    const exactReplay = await postAttestation({ attestation });
    expect(exactReplay.statusCode).toBe(200);
    expect(exactReplay.json()).toEqual(originalResponse);
  });

  it("polls past a missed webhook into the durable inbox and advances its provider cursor exactly once", async () => {
    const matchingRun = buildCandidateRun();
    const unrelatedRun = buildCandidateRun();
    const matchingCandidateId = await putCandidateRun(matchingRun);
    const unrelatedCandidateId = await putCandidateRun(unrelatedRun);
    const attestation = attestationFor(matchingRun);
    authoritativeStates.set(
      attestation.provider_event_id,
      authoritativeState(matchingRun, attestation),
    );
    const repository = db.prepare(
      `SELECT * FROM memory_repository_registry
       WHERE org_id = ? AND project_id = ? AND repository_id = ?`,
    ).get(
      context.orgA.id,
      context.projectA,
      REPOSITORY_ID,
    ) as unknown as MemoryRepositoryBinding;
    const observedCursors: Array<string | null> = [];
    let poll = 0;
    setMemoryGithubProviderEventSource(async ({ repository: polled, cursor }) => {
      expect(polled.repository_row_id).toBe(repository.repository_row_id);
      observedCursors.push(cursor);
      poll += 1;
      return {
        events: [{
          deliveryId: attestation.provider_event_id,
          sourceCursor: "github-repository-event-42",
          attestation,
        }],
        nextCursor: poll === 1
          ? "github-repository-event-42"
          : "github-repository-event-43",
      };
    });

    try {
      expect(db.prepare(
        "SELECT inbox_event_id FROM memory_inbox WHERE provider_delivery_id = ?",
      ).get(attestation.provider_event_id)).toBeUndefined();

      const firstAt = new Date().toISOString();
      const first = await runMemoryProviderReconciliationPass({
        repositoryRowIds: [repository.repository_row_id],
        maxRepositories: 1,
        maxEventsPerRepository: 4,
        now: firstAt,
      });
      expect(first).toEqual([{
        repositoryRowId: repository.repository_row_id,
        previousCursor: null,
        nextCursor: "github-repository-event-42",
        discoveredCount: 1,
        duplicateCount: 0,
        processedCount: 1,
      }]);
      expect(db.prepare(
        `SELECT status, source_cursor, payload_json, processed_at
         FROM memory_inbox WHERE provider_delivery_id = ?`,
      ).get(attestation.provider_event_id)).toMatchObject({
        status: "completed",
        source_cursor: "github-repository-event-42",
        payload_json: JSON.stringify(attestation),
        processed_at: firstAt,
      });
      expect((await candidateStatus(matchingCandidateId)).status).toBe("active");
      expect((await candidateStatus(unrelatedCandidateId)).status).toBe("pending_merge");
      expect(db.prepare(
        `SELECT cursor_value, aggregate_version, last_successful_sync_at
         FROM memory_provider_cursors
         WHERE repository_row_id = ? AND provider = 'github'
           AND stream_name = 'repository_events_poll'`,
      ).get(repository.repository_row_id)).toEqual({
        cursor_value: "github-repository-event-42",
        aggregate_version: 1,
        last_successful_sync_at: firstAt,
      });

      const secondAt = new Date(Date.parse(firstAt) + 60_000).toISOString();
      const replay = await runMemoryProviderReconciliationPass({
        repositoryRowIds: [repository.repository_row_id],
        maxRepositories: 1,
        maxEventsPerRepository: 4,
        now: secondAt,
      });
      expect(replay).toEqual([{
        repositoryRowId: repository.repository_row_id,
        previousCursor: "github-repository-event-42",
        nextCursor: "github-repository-event-43",
        discoveredCount: 0,
        duplicateCount: 1,
        processedCount: 0,
      }]);
      expect(observedCursors).toEqual([null, "github-repository-event-42"]);
      expect(db.prepare(
        `SELECT cursor_value, aggregate_version, last_successful_sync_at
         FROM memory_provider_cursors
         WHERE repository_row_id = ? AND provider = 'github'
           AND stream_name = 'repository_events_poll'`,
      ).get(repository.repository_row_id)).toEqual({
        cursor_value: "github-repository-event-43",
        aggregate_version: 2,
        last_successful_sync_at: secondAt,
      });
      expect(db.prepare(
        `SELECT COUNT(*) AS count FROM memory_inbox
         WHERE provider_delivery_id = ?`,
      ).get(attestation.provider_event_id)).toEqual({ count: 1 });
      expect(db.prepare(
        `SELECT COUNT(*) AS count FROM memory_attestations
         WHERE provider_delivery_id = ?`,
      ).get(attestation.provider_event_id)).toEqual({ count: 1 });
      expect(db.prepare(
        `SELECT COUNT(*) AS count FROM memory_transitions
         WHERE aggregate_type = 'candidate' AND aggregate_id = ? AND to_status = 'active'`,
      ).get(matchingCandidateId)).toEqual({ count: 1 });

      const failedAt = new Date(Date.parse(secondAt) + 60_000).toISOString();
      setMemoryGithubProviderEventSource(async () => {
        throw new Error("simulated provider polling outage");
      });
      await expect(runMemoryProviderReconciliationPass({
        repositoryRowIds: [repository.repository_row_id],
        maxRepositories: 1,
        now: failedAt,
      })).rejects.toThrow("simulated provider polling outage");
      expect(db.prepare(
        `SELECT cursor_value, aggregate_version, last_attempted_sync_at,
                last_successful_sync_at, last_error_code, last_error_message
         FROM memory_provider_cursors
         WHERE repository_row_id = ? AND provider = 'github'
           AND stream_name = 'repository_events_poll'`,
      ).get(repository.repository_row_id)).toEqual({
        cursor_value: "github-repository-event-43",
        aggregate_version: 3,
        last_attempted_sync_at: failedAt,
        last_successful_sync_at: secondAt,
        last_error_code: "temporarily_unavailable",
        last_error_message: "Provider event poll failed",
      });
    } finally {
      setMemoryGithubProviderEventSource(null);
    }
  });

  it("polls an active verified candidate for a genuinely missed GitHub revert", async () => {
    const run = buildCandidateRun();
    const candidateId = await putCandidateRun(run);
    const merge = attestationFor(run);
    authoritativeStates.set(merge.provider_event_id, authoritativeState(run, merge));
    expect((await postAttestation({ attestation: merge })).statusCode).toBe(200);
    const active = await candidateStatus(candidateId);
    const recordId = active.active_record!.record_id;
    const repository = db.prepare(
      `SELECT * FROM memory_repository_registry
       WHERE org_id = ? AND project_id = ? AND repository_id = ?`,
    ).get(
      context.orgA.id,
      context.projectA,
      REPOSITORY_ID,
    ) as unknown as MemoryRepositoryBinding;
    const revertCursor = "c".repeat(40);
    const revertTemplate = attestationFor(run, { type: "github_revert" });
    const revertState = authoritativeState(run, revertTemplate, {
      merged: true,
      reverted: true,
      sourceCursor: revertCursor,
    });
    const resolvedTypes: string[] = [];
    setMemoryGithubProviderEventSource(null);
    setMemoryGithubResolver(async ({ attestation }) => {
      resolvedTypes.push(attestation.type);
      if (attestation.type === "github_revert"
          && attestation.provider_pull_request_id
            === run.receipt.repository!.provider_pull_request_id) {
        return revertState;
      }
      return {
        repositoryId: attestation.repository_id,
        providerPullRequestId: attestation.provider_pull_request_id!,
        merged: false,
        reverted: false,
        baseSha: attestation.base_sha!,
        headSha: attestation.head_sha!,
        mergeSha: attestation.merge_sha ?? MERGE_SHA,
        manifestDigest: attestation.manifest_digest,
        finalDiffDigest: run.diffDigest,
        occurredAt: attestation.occurred_at,
        sourceCursor: attestation.provider_event_id,
      };
    });

    try {
      expect(db.prepare(
        `SELECT inbox_event_id FROM memory_inbox
         WHERE event_type = 'github_revert' AND source_cursor = ?`,
      ).get(revertCursor)).toBeUndefined();
      const reconciledAt = new Date().toISOString();
      const first = await runMemoryProviderReconciliationPass({
        repositoryRowIds: [repository.repository_row_id],
        maxRepositories: 1,
        maxEventsPerRepository: 128,
        now: reconciledAt,
      });
      expect(first).toEqual([expect.objectContaining({
        repositoryRowId: repository.repository_row_id,
        discoveredCount: 1,
        duplicateCount: 0,
        processedCount: 1,
      })]);
      const firstCursor = first[0]!.nextCursor;
      expect(firstCursor).toMatch(/^candidate_scan_v1:candidate_/);
      expect(resolvedTypes.filter((type) => type === "github_revert").length)
        .toBeGreaterThanOrEqual(2);
      expect(db.prepare(
        `SELECT status, event_type, source_cursor, processed_at
         FROM memory_inbox
         WHERE event_type = 'github_revert' AND source_cursor = ?`,
      ).get(revertCursor)).toEqual({
        status: "completed",
        event_type: "github_revert",
        source_cursor: revertCursor,
        processed_at: reconciledAt,
      });
      expect(db.prepare(
        "SELECT current_status FROM memory_records WHERE record_id = ?",
      ).get(recordId)).toEqual({ current_status: "revoked" });
      expect((await searchFor(run)).items.map((item) => item.record_id)).not.toContain(recordId);
      expect(db.prepare(
        `SELECT COUNT(*) AS count FROM memory_transitions
         WHERE aggregate_type = 'record' AND aggregate_id = ?`,
      ).get(recordId)).toEqual({ count: 2 });

      const replay = await runMemoryProviderReconciliationPass({
        repositoryRowIds: [repository.repository_row_id],
        maxRepositories: 1,
        maxEventsPerRepository: 128,
        now: new Date(Date.parse(reconciledAt) + 60_000).toISOString(),
      });
      expect(replay).toEqual([expect.objectContaining({
        previousCursor: firstCursor,
        nextCursor: null,
        discoveredCount: 0,
        duplicateCount: 0,
        processedCount: 0,
      })]);
      expect(db.prepare(
        `SELECT COUNT(*) AS count FROM memory_inbox
         WHERE event_type = 'github_revert' AND source_cursor = ?`,
      ).get(revertCursor)).toEqual({ count: 1 });
      expect(db.prepare(
        `SELECT COUNT(*) AS count FROM memory_transitions
         WHERE aggregate_type = 'record' AND aggregate_id = ?`,
      ).get(recordId)).toEqual({ count: 2 });
    } finally {
      installFixtureGithubResolver();
      setMemoryGithubProviderEventSource(null);
    }
  });

  it("durably rotates past the per-repository candidate limit for merges and reverts", async () => {
    const runs = Array.from({ length: 4 }, () => buildCandidateRun({ projectId: context.projectB }));
    const candidateIds: string[] = [];
    for (const run of runs) candidateIds.push(await putCandidateRun(run, context.receiptTokenB));

    const repository = db.prepare(
      `SELECT * FROM memory_repository_registry
       WHERE org_id = ? AND project_id = ? AND repository_id = ?`,
    ).get(
      context.orgB.id,
      context.projectB,
      REPOSITORY_ID,
    ) as unknown as MemoryRepositoryBinding;
    const initialMerge = attestationFor(runs[0]!);
    authoritativeStates.set(
      initialMerge.provider_event_id,
      authoritativeState(runs[0]!, initialMerge),
    );
    const auth: ServiceTokenAuthMetadata = {
      kind: "service_token",
      tokenId: `candidate-fairness-${randomUUID()}`,
      servicePrincipalId: `candidate-fairness-principal-${randomUUID()}`,
      scopes: ["memory:attest"],
      orgId: context.orgB.id,
      projectId: context.projectB,
      repositoryBindings: [{
        repositoryRowId: repository.repository_row_id,
        repositoryId: repository.repository_id,
      }],
    };
    await submitGithubMemoryAttestation({
      auth,
      repository,
      deliveryId: initialMerge.provider_event_id,
      rawBody: Buffer.from(JSON.stringify(initialMerge)),
      attestation: initialMerge,
    });
    const recordToRevoke = (db.prepare(
      "SELECT active_record_id FROM memory_candidates_v1 WHERE candidate_id = ?",
    ).get(candidateIds[0]!) as { active_record_id: string }).active_record_id;

    db.prepare(
      `DELETE FROM memory_provider_cursors
       WHERE repository_row_id = ? AND provider = 'github'
         AND stream_name = 'repository_events_poll'`,
    ).run(repository.repository_row_id);
    const revertCursor = `missed-revert-${randomUUID()}`;
    const probedPullRequests = new Set<string>();
    setMemoryGithubProviderEventSource(null);
    setMemoryGithubResolver(async ({ attestation }) => {
      const runIndex = runs.findIndex((run) =>
        run.receipt.repository!.provider_pull_request_id
          === attestation.provider_pull_request_id);
      if (runIndex < 0) throw new Error("Unexpected repository candidate in fairness test");
      if (attestation.provider_event_id.startsWith("poll-probe-")) {
        probedPullRequests.add(attestation.provider_pull_request_id!);
      }
      const run = runs[runIndex]!;
      if (attestation.type === "github_revert") {
        return authoritativeState(run, attestation, {
          merged: true,
          reverted: runIndex === 0,
          sourceCursor: runIndex === 0 ? revertCursor : attestation.provider_event_id,
        });
      }
      return authoritativeState(run, attestation, {
        merged: runIndex === 3,
        reverted: false,
        sourceCursor: attestation.provider_event_id,
      });
    });

    try {
      let expectedCursor: string | null = null;
      const now = new Date().toISOString();
      for (let pass = 1; pass <= 6; pass += 1) {
        const result = await runMemoryProviderReconciliationPass({
          repositoryRowIds: [repository.repository_row_id],
          maxRepositories: 1,
          maxEventsPerRepository: 1,
          now,
        });
        expect(result).toHaveLength(1);
        expect(result[0]!.previousCursor).toBe(expectedCursor);
        expectedCursor = result[0]!.nextCursor;
        expect(db.prepare(
          `SELECT cursor_value, aggregate_version
           FROM memory_provider_cursors
           WHERE repository_row_id = ? AND provider = 'github'
             AND stream_name = 'repository_events_poll'`,
        ).get(repository.repository_row_id)).toEqual({
          cursor_value: expectedCursor,
          aggregate_version: pass,
        });
      }

      expect(probedPullRequests).toEqual(new Set(
        runs.map((run) => run.receipt.repository!.provider_pull_request_id),
      ));
      expect(db.prepare(
        "SELECT current_status FROM memory_records WHERE record_id = ?",
      ).get(recordToRevoke)).toEqual({ current_status: "revoked" });
      expect(db.prepare(
        "SELECT current_status FROM memory_candidates_v1 WHERE candidate_id = ?",
      ).get(candidateIds[3])).toEqual({ current_status: "active" });
      for (const candidateId of candidateIds.slice(1, 3)) {
        expect(db.prepare(
          "SELECT current_status FROM memory_candidates_v1 WHERE candidate_id = ?",
        ).get(candidateId)).toEqual({ current_status: "pending_merge" });
      }
      expect(db.prepare(
        `SELECT COUNT(*) AS count FROM memory_inbox
         WHERE repository_row_id = ? AND event_type = 'github_revert'
           AND source_cursor = ?`,
      ).get(repository.repository_row_id, revertCursor)).toEqual({ count: 1 });
      expect(db.prepare(
        `SELECT COUNT(*) AS count FROM memory_attestations
         WHERE repository_row_id = ? AND attestation_type = 'github_merge'
           AND provider_pull_request_id = ?`,
      ).get(
        repository.repository_row_id,
        runs[3]!.receipt.repository!.provider_pull_request_id!,
      )).toEqual({ count: 1 });
    } finally {
      installFixtureGithubResolver();
      setMemoryGithubProviderEventSource(null);
    }
  });

  it("durably rotates repositories beyond the pass limit after a poll failure", async () => {
    await putCandidateRun(buildCandidateRun());
    await putCandidateRun(
      buildCandidateRun({ projectId: context.projectB }),
      context.receiptTokenB,
    );
    const repositories = db.prepare(
      `SELECT * FROM memory_repository_registry
       WHERE repository_id = ?
         AND ((org_id = ? AND project_id = ?) OR (org_id = ? AND project_id = ?))
       ORDER BY org_id, project_id, repository_id`,
    ).all(
      REPOSITORY_ID,
      context.orgA.id,
      context.projectA,
      context.orgB.id,
      context.projectB,
    ) as unknown as MemoryRepositoryBinding[];
    expect(repositories).toHaveLength(2);
    db.prepare(
      `DELETE FROM memory_provider_cursors
       WHERE provider = 'github' AND stream_name = 'repository_events_poll'
         AND repository_row_id IN (?, ?)`,
    ).run(repositories[0]!.repository_row_id, repositories[1]!.repository_row_id);

    const attempts: string[] = [];
    let failFirstPoll = true;
    setMemoryGithubProviderEventSource(async ({ repository, cursor }) => {
      attempts.push(repository.repository_row_id);
      if (failFirstPoll) {
        failFirstPoll = false;
        throw new Error("bounded repository poll failed");
      }
      return {
        events: [],
        nextCursor: cursor ?? `repository_scan_v1:${repository.repository_row_id}`,
      };
    });

    try {
      const now = new Date().toISOString();
      const repositoryRowIds = repositories.map((repository) => repository.repository_row_id);
      await expect(runMemoryProviderReconciliationPass({
        repositoryRowIds,
        maxRepositories: 1,
        maxEventsPerRepository: 1,
        now,
      })).rejects.toThrow("bounded repository poll failed");
      const failedRepositoryRowId = attempts[0]!;
      const otherRepositoryRowId = repositoryRowIds.find((id) => id !== failedRepositoryRowId)!;
      expect(db.prepare(
        `SELECT cursor_value, aggregate_version, last_attempted_sync_at,
                last_successful_sync_at, last_error_code
         FROM memory_provider_cursors
         WHERE repository_row_id = ? AND provider = 'github'
           AND stream_name = 'repository_events_poll'`,
      ).get(failedRepositoryRowId)).toEqual({
        cursor_value: null,
        aggregate_version: 1,
        last_attempted_sync_at: now,
        last_successful_sync_at: null,
        last_error_code: "temporarily_unavailable",
      });

      const second = await runMemoryProviderReconciliationPass({
        repositoryRowIds,
        maxRepositories: 1,
        maxEventsPerRepository: 1,
        now,
      });
      expect(second).toEqual([expect.objectContaining({
        repositoryRowId: otherRepositoryRowId,
        previousCursor: null,
      })]);
      const third = await runMemoryProviderReconciliationPass({
        repositoryRowIds,
        maxRepositories: 1,
        maxEventsPerRepository: 1,
        now,
      });
      expect(third).toEqual([expect.objectContaining({
        repositoryRowId: failedRepositoryRowId,
        previousCursor: null,
      })]);
      expect(attempts).toEqual([
        failedRepositoryRowId,
        otherRepositoryRowId,
        failedRepositoryRowId,
      ]);
      expect(db.prepare(
        `SELECT cursor_value, aggregate_version, last_successful_sync_at,
                last_error_code, last_error_message
         FROM memory_provider_cursors
         WHERE repository_row_id = ? AND provider = 'github'
           AND stream_name = 'repository_events_poll'`,
      ).get(failedRepositoryRowId)).toEqual({
        cursor_value: `repository_scan_v1:${failedRepositoryRowId}`,
        aggregate_version: 2,
        last_successful_sync_at: now,
        last_error_code: null,
        last_error_message: null,
      });
    } finally {
      setMemoryGithubProviderEventSource(null);
    }
  });

  it("keeps fake, wrong-repository, wrong-head, and wrong-manifest evidence pending", async () => {
    const run = buildCandidateRun();
    const candidateId = await putCandidateRun(run);
    const cases: Array<{
      name: string;
      attestation: MemoryAttestationV1;
      stateOverrides?: Partial<AuthoritativeGithubState>;
      expectedStatus: number;
    }> = [];

    const fake = attestationFor(run);
    cases.push({ name: "unmerged", attestation: fake, stateOverrides: { merged: false }, expectedStatus: 422 });
    cases.push({
      name: "wrong repository",
      attestation: attestationFor(run, { repository_id: "github.com/acme/empty" }),
      expectedStatus: 403,
    });
    cases.push({
      name: "wrong head",
      attestation: attestationFor(run, { head_sha: OTHER_SHA }),
      expectedStatus: 422,
    });
    cases.push({
      name: "wrong manifest",
      attestation: attestationFor(run, { manifest_digest: `sha256:${"c".repeat(64)}` }),
      expectedStatus: 422,
    });

    for (const testCase of cases) {
      authoritativeStates.set(
        testCase.attestation.provider_event_id,
        authoritativeState(run, testCase.attestation, testCase.stateOverrides),
      );
      const response = await postAttestation({ attestation: testCase.attestation });
      expect(response.statusCode, testCase.name).toBe(testCase.expectedStatus);
      expect((await candidateStatus(candidateId)).status, testCase.name).toBe("pending_merge");
    }
    expect(db.prepare(
      "SELECT active_record_id FROM memory_candidates_v1 WHERE candidate_id = ?",
    ).get(candidateId)).toMatchObject({ active_record_id: null });
  });

  it("activates a verified match exactly once and remains lexically readable without an embedding", async () => {
    const run = buildCandidateRun();
    const candidateId = await putCandidateRun(run);
    const attestation = attestationFor(run);
    authoritativeStates.set(attestation.provider_event_id, authoritativeState(run, attestation));

    const activated = await postAttestation({ attestation });
    expect(activated.statusCode).toBe(200);
    const originalResponse = activated.json();
    expect(originalResponse).toMatchObject({
      schema_version: "pim.memory-attestation-result.v1",
      accepted: true,
      duplicate: false,
      status: "activated",
      candidate_ids: [candidateId],
    });
    const status = await candidateStatus(candidateId);
    expect(status).toMatchObject({
      status: "active",
      blockers: [],
      active_record: { record_version: 1 },
      latest_transition: {
        from_status: "pending_merge",
        to_status: "active",
        reason_code: "verified_merge_activated",
      },
    });
    const recordId = status.active_record!.record_id;

    const replay = await postAttestation({ attestation });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(originalResponse);
    expect((db.prepare(
      `SELECT COUNT(*) AS count FROM memory_transitions
       WHERE aggregate_type = 'candidate' AND aggregate_id = ? AND to_status = 'active'`,
    ).get(candidateId) as { count: number }).count).toBe(1);
    expect((db.prepare(
      "SELECT COUNT(*) AS count FROM memory_records WHERE record_id = ?",
    ).get(recordId) as { count: number }).count).toBe(1);

    const detail = await context.app.inject({
      method: "GET",
      url: `/api/v1/memory/records/${encodeURIComponent(recordId)}?version=1`,
      headers: { authorization: `Bearer ${context.tokenA}` },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      record_id: recordId,
      record_version: 1,
      prompt_eligible: false,
      lifecycle: { status: "active" },
      content: run.candidate.content,
    });
    expect(db.prepare(
      "SELECT embedding_json FROM memory_record_versions WHERE record_id = ? AND record_version = 1",
    ).get(recordId)).toMatchObject({ embedding_json: null });
    expect(db.prepare(
      "SELECT record_key FROM memory_record_versions_fts WHERE record_key = ?",
    ).get(`${recordId}:1`)).toMatchObject({ record_key: `${recordId}:1` });
    expect(db.prepare(
      "SELECT shadow_recall_eligible, prompt_eligible FROM memory_records WHERE record_id = ?",
    ).get(recordId)).toMatchObject({ shadow_recall_eligible: 1, prompt_eligible: 0 });
    expect((await searchFor(run)).items.map((item) => item.record_id)).toContain(recordId);
  });

  it("marks only new verified activations eligible after an explicit passing expansion gate", async () => {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO memory_release_gate_decisions
         (decision_id, org_id, project_id, stage, decision, status,
          metric_snapshot_json, dataset_digest, reasons_json, created_at)
       VALUES (?, ?, ?, 'expansion', 'continue', 'pass', '{}', ?, '[]', ?)`,
    ).run(
      `gate-${randomUUID()}`,
      context.orgA.id,
      context.projectA,
      canonicalJsonSha256({ fixture: "automatic-activation-gate" }),
      now,
    );
    updateMemoryPromptPolicy({
      orgId: context.orgA.id,
      projectId: context.projectA,
      principalId: "attestation-test-policy-owner",
      update: {
        schema_version: "pim.memory-prompt-policy-update.v1",
        expected_revision: 0,
        enabled: false,
        kill_switch: true,
        automatic_activation_enabled: true,
        canary_percentage: 0,
        allowed_repository_ids: [],
        allowed_kinds: [],
        max_prompt_items: 3,
        max_prompt_tokens: 800,
      },
      now,
    });

    try {
      const run = buildCandidateRun();
      const candidateId = await putCandidateRun(run);
      const attestation = attestationFor(run);
      authoritativeStates.set(attestation.provider_event_id, authoritativeState(run, attestation));
      expect((await postAttestation({ attestation })).statusCode).toBe(200);
      const recordId = (await candidateStatus(candidateId)).active_record!.record_id;
      expect(db.prepare(
        "SELECT prompt_eligible FROM memory_records WHERE record_id = ?",
      ).get(recordId)).toEqual({ prompt_eligible: 1 });
    } finally {
      updateMemoryPromptPolicy({
        orgId: context.orgA.id,
        projectId: context.projectA,
        principalId: "attestation-test-policy-owner",
        update: {
          schema_version: "pim.memory-prompt-policy-update.v1",
          expected_revision: 1,
          enabled: false,
          kill_switch: true,
          automatic_activation_enabled: false,
          canary_percentage: 0,
          allowed_repository_ids: [],
          allowed_kinds: [],
          max_prompt_items: 3,
          max_prompt_tokens: 800,
        },
      });
    }
  });

  it("rechecks the activation allowlist before processing a delayed inbox event", async () => {
    const run = buildCandidateRun();
    const candidateId = await putCandidateRun(run);
    const attestation = attestationFor(run);
    const state = authoritativeState(run, attestation);
    authoritativeStates.set(attestation.provider_event_id, state);
    setMemoryGithubResolver(async () => {
      throw new Error("temporary GitHub outage");
    });
    try {
      const deferred = await postAttestation({ attestation });
      expect(deferred.statusCode).toBe(503);
      const row = db.prepare(
        `SELECT inbox_event_id FROM memory_inbox
         WHERE provider_delivery_id = ?`,
      ).get(attestation.provider_event_id) as { inbox_event_id: string };

      let resolutionCalls = 0;
      setMemoryGithubResolver(async () => {
        resolutionCalls += 1;
        return state;
      });
      delete process.env.MEMORY_ACTIVATION_REPOSITORIES;
      const processed = await runMemoryInboxPass({
        workerId: `allowlist-recheck-${randomUUID()}`,
        maxEvents: 1,
        inboxEventIds: [row.inbox_event_id],
        now: new Date(Date.now() + 5 * 60_000).toISOString(),
      });
      expect(processed).toHaveLength(1);
      expect(processed[0]).toMatchObject({ errorCode: "resource_binding_mismatch" });
      expect(resolutionCalls).toBe(0);
      expect((await candidateStatus(candidateId)).status).toBe("pending_merge");
      expect(db.prepare(
        "SELECT status, last_error_code FROM memory_inbox WHERE inbox_event_id = ?",
      ).get(row.inbox_event_id)).toMatchObject({
        status: "pending",
        last_error_code: "resource_binding_mismatch",
      });
    } finally {
      process.env.MEMORY_ACTIVATION_REPOSITORIES = REPOSITORY_ID;
      installFixtureGithubResolver();
    }
  });

  it("lists scoped inbox dead letters, replays them safely, and includes them in operations", async () => {
    const run = buildCandidateRun();
    const attestation = attestationFor(run);
    const state = authoritativeState(run, attestation);
    const baselineDeadLetters = getMemoryOperationalSnapshot(
      context.orgA.id,
      context.projectA,
    ).deadLetterCount;
    setMemoryGithubResolver(async () => {
      throw new Error("GitHub unavailable for dead-letter fixture");
    });
    try {
      expect((await postAttestation({ attestation })).statusCode).toBe(503);
      const row = db.prepare(
        `SELECT inbox_event_id, repository_row_id FROM memory_inbox
         WHERE provider_delivery_id = ?`,
      ).get(attestation.provider_event_id) as {
        inbox_event_id: string;
        repository_row_id: string;
      };
      db.prepare(
        `UPDATE memory_inbox SET max_attempts = 2, next_attempt_at = ?
         WHERE inbox_event_id = ?`,
      ).run("2000-01-01T00:00:00.000Z", row.inbox_event_id);
      await runMemoryInboxPass({
        workerId: `dead-letter-${randomUUID()}`,
        maxEvents: 1,
        inboxEventIds: [row.inbox_event_id],
        now: new Date(Date.now() + 60_000).toISOString(),
      });

      expect(listMemoryInboxDeadLetters(context.orgA.id, context.projectA)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            inbox_event_id: row.inbox_event_id,
            provider_delivery_id: attestation.provider_event_id,
            last_error_code: "temporarily_unavailable",
          }),
        ]),
      );
      expect(listMemoryInboxDeadLetters(context.orgB.id, context.projectB)).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ inbox_event_id: row.inbox_event_id })]),
      );
      expect(getMemoryOperationalSnapshot(
        context.orgA.id,
        context.projectA,
      ).deadLetterCount).toBe(baselineDeadLetters + 1);
      expect(replayMemoryInboxDeadLetter({
        orgId: context.orgB.id,
        projectId: context.projectB,
        repositoryRowId: row.repository_row_id,
        inboxEventId: row.inbox_event_id,
      })).toBe(false);

      authoritativeStates.set(attestation.provider_event_id, state);
      installFixtureGithubResolver();
      const replayedAt = new Date(Date.now() + 2 * 60_000).toISOString();
      expect(replayMemoryInboxDeadLetter({
        orgId: context.orgA.id,
        projectId: context.projectA,
        repositoryRowId: row.repository_row_id,
        inboxEventId: row.inbox_event_id,
        now: replayedAt,
      })).toBe(true);
      const replayRow = db.prepare(
        `SELECT status, last_replayed_at, attempt_history_json
         FROM memory_inbox WHERE inbox_event_id = ?`,
      ).get(row.inbox_event_id) as {
        status: string;
        last_replayed_at: string;
        attempt_history_json: string;
      };
      expect(replayRow).toMatchObject({
        status: "pending",
        last_replayed_at: replayedAt,
      });
      expect(JSON.parse(replayRow.attempt_history_json)).toEqual(expect.arrayContaining([
        expect.objectContaining({ outcome: "replayed", replayed_at: replayedAt }),
      ]));
      await runMemoryInboxPass({
        workerId: `dead-letter-replay-${randomUUID()}`,
        maxEvents: 1,
        inboxEventIds: [row.inbox_event_id],
        now: replayedAt,
      });
      expect(db.prepare(
        "SELECT status, response_json FROM memory_inbox WHERE inbox_event_id = ?",
      ).get(row.inbox_event_id)).toMatchObject({
        status: "unmatched",
        response_json: expect.any(String),
      });
      expect(listMemoryInboxDeadLetters(context.orgA.id, context.projectA)).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ inbox_event_id: row.inbox_event_id })]),
      );
      expect(getMemoryOperationalSnapshot(
        context.orgA.id,
        context.projectA,
      ).deadLetterCount).toBe(baselineDeadLetters);
    } finally {
      installFixtureGithubResolver();
    }
  });

  it("revokes a reverted merge from search while preserving detail and lifecycle history", async () => {
    const run = buildCandidateRun();
    const candidateId = await putCandidateRun(run);
    const merge = attestationFor(run);
    authoritativeStates.set(merge.provider_event_id, authoritativeState(run, merge));
    expect((await postAttestation({ attestation: merge })).statusCode).toBe(200);
    const active = await candidateStatus(candidateId);
    const recordId = active.active_record!.record_id;
    expect((await searchFor(run)).items.map((item) => item.record_id)).toContain(recordId);

    const revert = attestationFor(run, {
      type: "github_revert",
      merge_sha: MERGE_SHA,
    });
    authoritativeStates.set(
      revert.provider_event_id,
      authoritativeState(run, revert, { merged: true, reverted: true }),
    );
    const reverted = await postAttestation({ attestation: revert });
    expect(reverted.statusCode).toBe(200);
    expect(reverted.json()).toMatchObject({
      accepted: true,
      duplicate: false,
      status: "reverted",
      candidate_ids: [candidateId],
      record_ids: [recordId],
    });
    expect((await postAttestation({ attestation: revert })).json()).toEqual(reverted.json());

    expect((await searchFor(run)).items.map((item) => item.record_id)).not.toContain(recordId);
    const detail = await context.app.inject({
      method: "GET",
      url: `/api/v1/memory/records/${encodeURIComponent(recordId)}?version=1`,
      headers: { authorization: `Bearer ${context.tokenA}` },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      record_id: recordId,
      record_version: 1,
      lifecycle: { status: "revoked" },
      transition_summary: { reason_code: "verified_merge_reverted" },
    });
    expect((db.prepare(
      `SELECT COUNT(*) AS count FROM memory_transitions
       WHERE aggregate_type = 'record' AND aggregate_id = ?`,
    ).get(recordId) as { count: number }).count).toBe(2);
  });
});
