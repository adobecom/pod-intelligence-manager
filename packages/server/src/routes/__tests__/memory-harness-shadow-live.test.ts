import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MEMORY_CONTRACT_FIXTURES,
  canonicalJsonSha256,
  parseMemoryContract,
  type FiestaCodeEvidenceV2,
  type MemoryCandidateDecisionV1,
  type MemoryCandidateV1,
  type MemoryHarnessSearchV1,
  type MemorySearchV1,
  type RunReceiptV1,
} from "@pim/shared";
import { PimMemoryClient } from "../../../../sdk/src/memory-client.js";
import db from "../../db/connection.js";
import { createMemoryTestContext, type MemoryTestContext } from "./memory-test-app.js";

const TREE_SHA = "89abcdef0123456789abcdef0123456789abcdef";
const EVENT_TIME = "2026-08-03T00:00:00.000Z";

let context: MemoryTestContext;
let receiptClient: PimMemoryClient;
let reviewerClient: PimMemoryClient;
let harnessClient: PimMemoryClient;
let otherHarnessClient: PimMemoryClient;

function fixture(): {
  producerRunId: string;
  evidenceRefId: string;
  receipt: RunReceiptV1;
} {
  const suffix = randomUUID();
  const producerRunId = `fiesta:test:harness-live:${suffix}`;
  const evidenceRefId = `harness-live-failure-${suffix}`;
  const fingerprint = `fiesta:harness-live:timeout:${suffix}`;
  const manifestBody: Omit<FiestaCodeEvidenceV2, "digest"> = {
    schema_version: "fiesta.code-evidence.v2",
    manifest_id: `harness-live-manifest-${suffix}`,
    refs: [{
      id: evidenceRefId,
      type: "failure",
      uri: `https://github.com/acme/checkout/commit/${TREE_SHA}.log`,
      digest: canonicalJsonSha256({ failure: suffix }),
      origin_id: `fiesta:${producerRunId}:failure`,
      occurred_at: EVENT_TIME,
      source_authority: "observed",
    }],
  };
  const manifest = parseMemoryContract("FiestaCodeEvidenceV2", {
    ...manifestBody,
    digest: canonicalJsonSha256(manifestBody),
  });
  const candidate = parseMemoryContract("MemoryCandidateV1", {
    schema_version: "pim.memory-candidate.v1",
    client_candidate_id: `harness-live-candidate-${suffix}`,
    plane: "harness",
    kind: "test_strategy",
    content: {
      summary: `Inspect terminal state before retrying live timeout ${suffix}.`,
      details: `The real listener fixture ${suffix} requires Fiesta to inspect terminal tool state before retrying an ambiguous side-effecting timeout.`,
      rationale: "The exact failure fingerprint bounds this lesson to the observed harness failure mode.",
    },
    applicability: {
      harness_id: "fiesta",
      harness_version_range: "harness-shadow-v1",
      workflow_version_range: "code-change.v3",
      adapter_version_range: "fiesta-pim-adapter.v1",
      configuration_ids: ["routing-default-v2"],
    },
    validation: { strategy: "stable_failure_fingerprint", failure_fingerprint: fingerprint },
    exceptions: ["Do not retry when terminal state cannot be inspected."],
    source_run_ids: [producerRunId],
    evidence_refs: [evidenceRefId],
    extraction: {
      method: "deterministic",
      extractor_version: "fiesta-harness-live.v1",
      confidence: 1,
    },
    activation_requirement_requested: "authorized_review",
  }) as MemoryCandidateV1;
  const receipt = parseMemoryContract("RunReceiptV1", {
    schema_version: "pim.run-receipt.v1",
    external_session_id: `harness-live-thread-${suffix}`,
    producer: {
      harness_id: "fiesta",
      harness_version: "harness-shadow-v1",
      workflow_version: "code-change.v3",
      adapter_version: "fiesta-pim-adapter.v1",
    },
    tenant: { project_id: context.projectA },
    task: { task_class: "recovery", summary: `Recover live harness timeout ${suffix}.` },
    outcome: {
      status: "failed",
      terminal_stage: "close",
      reason_code: "tool_timeout_terminal_state_unknown",
      verification_status: "failed",
      publication_status: "none",
      gate_attestation_ids: [],
      failure_fingerprint: fingerprint,
    },
    retrieval_feedback: [],
    evidence_manifest: manifest,
    candidates: [candidate],
  }) as RunReceiptV1;
  return { producerRunId, evidenceRefId, receipt };
}

function searchRequest(harnessId = "fiesta"): MemoryHarnessSearchV1 {
  const base = structuredClone(
    MEMORY_CONTRACT_FIXTURES.MemoryHarnessSearchV1,
  ) as unknown as MemoryHarnessSearchV1;
  return parseMemoryContract("MemoryHarnessSearchV1", {
    ...base,
    request_id: `harness-live-search-${randomUUID()}`,
    consumer: {
      harness_id: harnessId,
      harness_version: "harness-shadow-v1",
      workflow_version: "code-change.v3",
      adapter_version: "fiesta-pim-adapter.v1",
      consumer_run_id: `harness-live-consumer-${randomUUID()}`,
    },
    tenant: { project_id: context.projectA },
    applicability: {
      harness_id: harnessId,
      harness_version_range: "harness-shadow-v1",
      workflow_version_range: "code-change.v3",
      adapter_version_range: "fiesta-pim-adapter.v1",
      configuration_ids: ["routing-default-v2"],
    },
    task: { query: "Inspect terminal state before retrying live timeout", task_class: "recovery" },
  });
}

beforeAll(async () => {
  context = await createMemoryTestContext();
  const baseUrl = await context.app.listen({ host: "127.0.0.1", port: 0 });
  receiptClient = new PimMemoryClient({ baseUrl, authToken: context.harnessReceiptTokenA });
  reviewerClient = new PimMemoryClient({ baseUrl, authToken: context.harnessReviewerTokenA });
  harnessClient = new PimMemoryClient({ baseUrl, authToken: context.harnessSearchTokenA });
  otherHarnessClient = new PimMemoryClient({ baseUrl, authToken: context.otherHarnessSearchTokenA });
});

afterAll(async () => {
  if (context) await context.app.close();
});

describe("live SDK harness shadow loop", () => {
  it("receipts, reviews, and retrieves only through exact-bound permanent shadow", async () => {
    const input = fixture();
    const accepted = await receiptClient.putRunReceipt(input.producerRunId, input.receipt);
    expect(accepted.candidate_results[0]).toMatchObject({
      status: "pending_review",
      blockers: ["authorized_review_required"],
    });
    const candidateId = accepted.candidate_results[0]!.candidate_id;
    const review = parseMemoryContract("MemoryCandidateDecisionV1", {
      schema_version: "pim.memory-candidate-decision.v1",
      decision_revision: 1,
      decision: "approve",
      reason_code: "authorized_harness_failure_reviewed",
      explanation: "The exact harness failure and bounded exception were reviewed.",
      evidence_refs: [input.evidenceRefId],
      event_time: EVENT_TIME,
    }) as MemoryCandidateDecisionV1;
    const activated = await reviewerClient.decideCandidate(candidateId, review);
    expect(activated.candidate_status).toBe("active");
    const recordId = activated.active_record!.record_id;

    const result = await harnessClient.harnessSearch(searchRequest());
    expect(result).toMatchObject({
      shadow_only: true,
      routing_influence: false,
      prompt_eligible: false,
      evaluation_arm: "shadow",
    });
    expect(result.items.map((item) => item.record_id)).toContain(recordId);
    expect(result.items.every((item) => item.prompt_eligible === false)).toBe(true);
    expect(db.prepare(
      `SELECT repository_row_id, harness_id, prompt_eligible
       FROM memory_records WHERE record_id = ?`,
    ).get(recordId)).toEqual({
      repository_row_id: null,
      harness_id: "fiesta",
      prompt_eligible: 0,
    });

    const otherResult = await otherHarnessClient.harnessSearch(searchRequest("other-harness"));
    expect(otherResult.items).toEqual([]);
    await expect(otherHarnessClient.harnessSearch(searchRequest())).rejects.toMatchObject({
      statusCode: 403,
      response: { code: "resource_binding_mismatch" },
    });

    const codebaseRequest = structuredClone(
      MEMORY_CONTRACT_FIXTURES.MemorySearchV1,
    ) as unknown as MemorySearchV1;
    codebaseRequest.request_id = `harness-live-codebase-${randomUUID()}`;
    codebaseRequest.tenant.project_id = context.projectA;
    await expect(harnessClient.search(codebaseRequest)).rejects.toMatchObject({
      statusCode: 403,
      response: { code: "resource_binding_mismatch" },
    });
  });
});
