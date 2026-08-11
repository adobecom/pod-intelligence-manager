import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MEMORY_CONTRACT_FIXTURES,
  canonicalJsonSha256,
  parseMemoryContract,
  type CodeEvidenceManifestV2,
  type MemoryAttestationV1,
  type MemoryCandidateV1,
  type MemoryFeedbackV1,
  type MemorySearchV1,
  type RunReceiptV1,
} from "@pim/shared";
import { PimMemoryClient } from "../../../../sdk/src/memory-client.js";
import db from "../../db/connection.js";
import { setMemoryGithubResolver } from "../../services/memory-attestations.js";
import type { AuthoritativeGithubState } from "../../services/memory-activation.js";
import { createMemoryTestContext, type MemoryTestContext } from "./memory-test-app.js";

const BASE_SHA = "0123456789abcdef0123456789abcdef01234567";
const HEAD_SHA = "89abcdef0123456789abcdef0123456789abcdef";
const MERGE_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REPOSITORY_ID = "github.com/acme/checkout";
const WEBHOOK_SECRET = "memory-closed-loop-live-secret";

let context: MemoryTestContext;
let baseUrl = "";
let searchClient: PimMemoryClient;
let receiptClient: PimMemoryClient;
let candidateClient: PimMemoryClient;
let feedbackClient: PimMemoryClient;
let previousWebhookSecret: string | undefined;
let previousActivationRepositories: string | undefined;
const authoritativeStates = new Map<string, AuthoritativeGithubState>();

function searchRequest(input: {
  requestId: string;
  producerRunId: string;
  harnessVersion: string;
  query: string;
  paths: string[];
  symbols: string[];
}): MemorySearchV1 {
  const fixture = structuredClone(
    MEMORY_CONTRACT_FIXTURES.MemorySearchV1,
  ) as unknown as MemorySearchV1;
  return parseMemoryContract("MemorySearchV1", {
    ...fixture,
    request_id: input.requestId,
    consumer: {
      harness_id: "fiesta",
      harness_version: input.harnessVersion,
      workflow_version: "code-change.v3",
      adapter_version: "fiesta-pim-adapter.v1",
      consumer_run_id: input.producerRunId,
    },
    tenant: { project_id: context.projectA },
    plane: "codebase",
    applicability: {
      repository_id: REPOSITORY_ID,
      base_sha: BASE_SHA,
      paths: input.paths,
      symbols: input.symbols,
      task_classes: ["bug_fix"],
    },
    task: { query: input.query, task_class: "bug_fix" },
    temporal: { mode: "current" },
  });
}

beforeAll(async () => {
  previousWebhookSecret = process.env.MEMORY_GITHUB_WEBHOOK_SECRET;
  previousActivationRepositories = process.env.MEMORY_ACTIVATION_REPOSITORIES;
  process.env.MEMORY_GITHUB_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.MEMORY_ACTIVATION_REPOSITORIES = REPOSITORY_ID;
  context = await createMemoryTestContext();
  setMemoryGithubResolver(async ({ attestation, repository }) => {
    expect(repository.repository_id).toBe(REPOSITORY_ID);
    const state = authoritativeStates.get(attestation.provider_event_id);
    if (!state) throw new Error("Closed-loop authoritative GitHub state was not installed");
    return state;
  });
  baseUrl = await context.app.listen({ host: "127.0.0.1", port: 0 });
  searchClient = new PimMemoryClient({ baseUrl, authToken: context.tokenA });
  receiptClient = new PimMemoryClient({ baseUrl, authToken: context.receiptTokenA });
  candidateClient = new PimMemoryClient({ baseUrl, authToken: context.candidateReadTokenA });
  feedbackClient = new PimMemoryClient({ baseUrl, authToken: context.feedbackTokenA });
});

afterAll(async () => {
  setMemoryGithubResolver(null);
  if (previousWebhookSecret === undefined) delete process.env.MEMORY_GITHUB_WEBHOOK_SECRET;
  else process.env.MEMORY_GITHUB_WEBHOOK_SECRET = previousWebhookSecret;
  if (previousActivationRepositories === undefined) delete process.env.MEMORY_ACTIVATION_REPOSITORIES;
  else process.env.MEMORY_ACTIVATION_REPOSITORIES = previousActivationRepositories;
  if (context) await context.app.close();
});

describe("live SDK closed-loop memory integration", () => {
  it("searches, receipts exact feedback, activates by verified merge, and appends a correction", async () => {
    const suffix = randomUUID();
    const producerRunId = `fiesta:test:closed-loop:${suffix}`;
    const harnessVersion = `closed-loop-${suffix}`;
    const candidatePath = `src/closed-loop/${suffix}.ts`;
    const candidateSymbol = `closed_loop_${suffix.replaceAll("-", "_")}`;

    const seedPack = await searchClient.search(searchRequest({
      requestId: `closed-loop-seed-search-${suffix}`,
      producerRunId,
      harnessVersion,
      query: "Payment retries must reuse the original idempotency key.",
      paths: ["src/payments/retry.ts"],
      symbols: ["retryCharge"],
    }));
    const seedItem = seedPack.items.find((item) => item.record_id === context.seededRecordId);
    expect(seedItem).toMatchObject({
      record_id: context.seededRecordId,
      record_version: 1,
    });
    if (!seedItem) throw new Error("Closed-loop seed record was not returned");

    const evidenceRefId = `closed-loop-diff-${suffix}`;
    const diffDigest = canonicalJsonSha256({ diff: suffix });
    const occurredAt = new Date().toISOString();
    const manifestBody: Omit<CodeEvidenceManifestV2, "digest"> = {
      schema_version: "pim.memory-code-evidence.v2",
      manifest_id: `closed-loop-manifest-${suffix}`,
      refs: [{
        id: evidenceRefId,
        type: "git_diff",
        uri: `https://github.com/acme/checkout/commit/${HEAD_SHA}.diff`,
        digest: diffDigest,
        origin_id: `${REPOSITORY_ID}:${HEAD_SHA}:${evidenceRefId}`,
        occurred_at: occurredAt,
        source_authority: "observed",
      }],
    };
    const manifest = parseMemoryContract("CodeEvidenceManifestV2", {
      ...manifestBody,
      digest: canonicalJsonSha256(manifestBody),
    });
    const candidate = parseMemoryContract("MemoryCandidateV1", {
      schema_version: "pim.memory-candidate.v1",
      client_candidate_id: `closed-loop-candidate-${suffix}`,
      plane: "codebase",
      kind: "constraint",
      content: {
        summary: `Preserve the closed-loop checkout invariant ${suffix}.`,
        details: `The ${suffix} implementation must retain the exact verified record version across later retrieval and feedback.`,
        rationale: "A version-pinned closed loop prevents outcome feedback from drifting onto a different memory claim.",
      },
      applicability: {
        repository_id: REPOSITORY_ID,
        base_sha: BASE_SHA,
        paths: [candidatePath],
        symbols: [candidateSymbol],
        task_classes: ["bug_fix"],
      },
      validation: { strategy: "repository_anchors" },
      exceptions: ["Does not apply outside this exact checkout boundary."],
      source_run_ids: [producerRunId],
      evidence_refs: [evidenceRefId],
      extraction: {
        method: "model_then_deterministic_validation",
        extractor_version: "fiesta-candidate-extractor.closed-loop-live-v1",
        confidence: 0.96,
      },
      activation_requirement_requested: "verified_merge",
    }) as MemoryCandidateV1;
    const providerPullRequestId = `github:acme/checkout#${suffix}`;
    const receipt = parseMemoryContract("RunReceiptV1", {
      schema_version: "pim.run-receipt.v1",
      external_session_id: `fiesta-closed-loop-thread-${suffix}`,
      producer: {
        harness_id: "fiesta",
        harness_version: harnessVersion,
        workflow_version: "code-change.v3",
        adapter_version: "fiesta-pim-adapter.v1",
      },
      tenant: { project_id: context.projectA },
      repository: {
        repository_id: REPOSITORY_ID,
        display_slug: "Acme/Checkout",
        base_sha: BASE_SHA,
        candidate_tree_sha: HEAD_SHA,
        provider_pull_request_id: providerPullRequestId,
        pr_head_sha: HEAD_SHA,
        pull_request_url: `https://github.com/acme/checkout/pull/${suffix}`,
      },
      task: {
        task_class: "bug_fix",
        summary: `Exercise a real-listener memory closed loop for ${suffix}.`,
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
        retrieval_pack_id: seedPack.retrieval_pack_id,
        items: [{
          record_id: seedItem.record_id,
          record_version: seedItem.record_version,
          checkout_validation: {
            disposition: "validated",
            reason_code: "closed_loop_seed_checkout_validated",
          },
          terminal_outcome: {
            use_disposition: "applied",
            use_attribution_confidence: 1,
            utility: "helpful",
            utility_source: "deterministic_outcome",
            reason_code: "closed_loop_seed_prevented_retry_drift",
          },
        }],
      }],
      evidence_manifest: manifest,
      candidates: [candidate],
    }) as RunReceiptV1;

    const accepted = await receiptClient.putRunReceipt(
      producerRunId,
      receipt,
      `closed-loop-receipt-${producerRunId}`,
    );
    expect(accepted.candidate_results[0]).toMatchObject({
      client_candidate_id: candidate.client_candidate_id,
      status: "pending_merge",
      blockers: ["verified_merge_required"],
    });
    expect(db.prepare(
      `SELECT retrieval_pack_id, record_id, record_version, feedback_stage
       FROM memory_feedback
       WHERE producer_run_id = ? AND feedback_stage = 'receipt'`,
    ).all(producerRunId)).toEqual([{
      retrieval_pack_id: seedPack.retrieval_pack_id,
      record_id: seedItem.record_id,
      record_version: seedItem.record_version,
      feedback_stage: "receipt",
    }]);

    const candidateId = accepted.candidate_results[0]!.candidate_id;
    expect(await candidateClient.getCandidate(candidateId)).toMatchObject({
      candidate_id: candidateId,
      status: "pending_merge",
      activation_requirement: "verified_merge",
      blockers: ["verified_merge_required"],
    });

    const deliveryId = `github-delivery-${suffix}`;
    const attestation = parseMemoryContract("MemoryAttestationV1", {
      schema_version: "pim.memory-attestation.v1",
      attestation_id: `closed-loop-attestation-${suffix}`,
      provider_event_id: deliveryId,
      type: "github_merge",
      repository_id: REPOSITORY_ID,
      provider_pull_request_id: providerPullRequestId,
      base_sha: BASE_SHA,
      head_sha: HEAD_SHA,
      merge_sha: MERGE_SHA,
      manifest_digest: manifest.digest,
      occurred_at: new Date().toISOString(),
    }) as MemoryAttestationV1;
    authoritativeStates.set(deliveryId, {
      repositoryId: REPOSITORY_ID,
      providerPullRequestId,
      merged: true,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      mergeSha: MERGE_SHA,
      manifestDigest: manifest.digest,
      finalDiffDigest: diffDigest,
      occurredAt: attestation.occurred_at,
      sourceCursor: deliveryId,
    });
    const rawAttestation = JSON.stringify(attestation);
    const signature = `sha256=${createHmac("sha256", WEBHOOK_SECRET)
      .update(rawAttestation)
      .digest("hex")}`;
    const attestationResponse = await fetch(`${baseUrl}/api/v1/memory/attestations/github`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${context.attestTokenA}`,
        "Content-Type": "application/json",
        "X-GitHub-Delivery": deliveryId,
        "X-GitHub-Event": "pull_request",
        "X-Hub-Signature-256": signature,
      },
      body: rawAttestation,
    });
    expect(attestationResponse.status).toBe(200);
    expect(await attestationResponse.json()).toMatchObject({
      accepted: true,
      duplicate: false,
      status: "activated",
      candidate_ids: [candidateId],
    });

    const activeCandidate = await candidateClient.getCandidate(candidateId);
    expect(activeCandidate).toMatchObject({
      candidate_id: candidateId,
      status: "active",
      blockers: [],
      active_record: { record_version: 1 },
    });
    const activeRecordId = activeCandidate.active_record!.record_id;
    const detail = await searchClient.getRecord(activeRecordId, 1);
    expect(detail).toMatchObject({
      record_id: activeRecordId,
      record_version: 1,
      lifecycle: { status: "active" },
      content: candidate.content,
      applicability: candidate.applicability,
    });

    const activatedPack = await searchClient.search(searchRequest({
      requestId: `closed-loop-activated-search-${suffix}`,
      producerRunId,
      harnessVersion,
      query: candidate.content.summary,
      paths: [candidatePath],
      symbols: [candidateSymbol],
    }));
    const activatedItem = activatedPack.items.find((item) => item.record_id === activeRecordId);
    expect(activatedItem).toMatchObject({
      record_id: activeRecordId,
      record_version: 1,
      kind: candidate.kind,
      summary: candidate.content.summary,
    });
    if (!activatedItem) throw new Error("Activated record was not returned in the later pack");

    const initialFeedback = parseMemoryContract("MemoryFeedbackV1", {
      schema_version: "pim.memory-feedback.v1",
      feedback_revision: 1,
      retrieval_pack_id: activatedPack.retrieval_pack_id,
      record_id: activeRecordId,
      record_version: activatedItem.record_version,
      producer_run_id: producerRunId,
      repository_id: REPOSITORY_ID,
      base_sha: BASE_SHA,
      disposition: "helpful",
      reason_code: "closed_loop_activated_record_helpful",
      outcome_evidence_refs: [evidenceRefId],
      event_time: new Date().toISOString(),
    }) as MemoryFeedbackV1;
    const correction = parseMemoryContract("MemoryFeedbackV1", {
      ...initialFeedback,
      feedback_revision: 2,
      disposition: "corrected",
      reason_code: "closed_loop_later_correction",
      event_time: new Date(Date.now() + 1).toISOString(),
    }) as MemoryFeedbackV1;
    const firstFeedback = await feedbackClient.submitFeedback(initialFeedback);
    const correctedFeedback = await feedbackClient.submitFeedback(correction);
    expect(firstFeedback).toMatchObject({
      feedback_revision: 1,
      duplicate: false,
    });
    expect(correctedFeedback).toMatchObject({
      feedback_revision: 2,
      duplicate: false,
    });
    expect(correctedFeedback.feedback_id).not.toBe(firstFeedback.feedback_id);
    expect(db.prepare(
      `SELECT feedback_revision, feedback_json
       FROM memory_feedback
       WHERE producer_run_id = ? AND retrieval_pack_id = ? AND record_id = ?
         AND record_version = ? AND feedback_stage = 'later'
       ORDER BY feedback_revision`,
    ).all(
      producerRunId,
      activatedPack.retrieval_pack_id,
      activeRecordId,
      activatedItem.record_version,
    )).toEqual([
      { feedback_revision: 1, feedback_json: JSON.stringify(initialFeedback) },
      { feedback_revision: 2, feedback_json: JSON.stringify(correction) },
    ]);
  });
});
