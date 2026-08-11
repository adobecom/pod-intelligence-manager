import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canonicalJsonSha256,
  type CodeEvidenceManifestV2,
  type MemoryCandidateV1,
  type RunReceiptV1,
} from "@pim/shared";
import { PimMemoryClient } from "../../../../sdk/src/memory-client.js";
import { createMemoryTestContext, type MemoryTestContext } from "./memory-test-app.js";

const BASE_SHA = "0123456789abcdef0123456789abcdef01234567";
const TREE_SHA = "89abcdef0123456789abcdef0123456789abcdef";

let context: MemoryTestContext;
let receiptClient: PimMemoryClient;
let candidateReadClient: PimMemoryClient;

beforeAll(async () => {
  context = await createMemoryTestContext();
  const baseUrl = await context.app.listen({ host: "127.0.0.1", port: 0 });
  receiptClient = new PimMemoryClient({ baseUrl, authToken: context.receiptTokenA });
  candidateReadClient = new PimMemoryClient({ baseUrl, authToken: context.candidateReadTokenA });
});

afterAll(async () => {
  if (context) await context.app.close();
});

describe("live SDK Slice 2 receipt contract", () => {
  it("round-trips a typed codebase candidate and replays the same receipt IDs", async () => {
    const suffix = randomUUID();
    const producerRunId = `fiesta:test:live-receipt:${suffix}`;
    const clientCandidateId = `fiesta-candidate-${suffix}`;
    const evidenceRefId = `diff-${suffix}`;
    const manifestContents: Omit<CodeEvidenceManifestV2, "digest"> = {
      schema_version: "pim.memory-code-evidence.v2",
      manifest_id: `manifest-${suffix}`,
      refs: [{
        id: evidenceRefId,
        type: "git_diff",
        uri: `https://github.com/acme/checkout/commit/${TREE_SHA}.diff`,
        digest: canonicalJsonSha256(`live-evidence-${suffix}`),
        origin_id: `github.com/acme/checkout:${TREE_SHA}:${evidenceRefId}`,
        occurred_at: "2026-08-03T18:42:00.000Z",
        source_authority: "observed",
      }],
    };
    const evidenceManifest: CodeEvidenceManifestV2 = {
      ...manifestContents,
      digest: canonicalJsonSha256(manifestContents),
    };
    const candidate: MemoryCandidateV1 = {
      schema_version: "pim.memory-candidate.v1",
      client_candidate_id: clientCandidateId,
      plane: "codebase",
      kind: "constraint",
      content: {
        summary: "Payment retries must retain the original idempotency key.",
        details: "A retry with a new key can create a duplicate provider charge.",
        rationale: "The provider treats each idempotency key as a distinct operation.",
      },
      applicability: {
        repository_id: "github.com/acme/checkout",
        base_sha: BASE_SHA,
        paths: ["src/payments/retry.ts"],
        symbols: ["retryCharge"],
        task_classes: ["bug_fix"],
      },
      validation: { strategy: "repository_anchors" },
      exceptions: ["Does not apply to read-only status checks."],
      source_run_ids: [producerRunId],
      evidence_refs: [evidenceRefId],
      extraction: {
        method: "model_then_deterministic_validation",
        extractor_version: "fiesta-candidate-extractor.live-test-v1",
        confidence: 0.9,
      },
      activation_requirement_requested: "verified_merge",
    };
    const receipt: RunReceiptV1 = {
      schema_version: "pim.run-receipt.v1",
      external_session_id: `fiesta-thread-${suffix}`,
      producer: {
        harness_id: "fiesta",
        harness_version: "live-test",
        workflow_version: "code-change.v3",
        adapter_version: "fiesta-pim-adapter.v1",
      },
      tenant: { project_id: context.projectA },
      repository: {
        repository_id: "github.com/acme/checkout",
        display_slug: "Acme/Checkout",
        base_sha: BASE_SHA,
        candidate_tree_sha: TREE_SHA,
        provider_pull_request_id: "github:acme/checkout#814",
        pr_head_sha: TREE_SHA,
        pull_request_url: "https://github.com/acme/checkout/pull/814",
      },
      task: {
        task_class: "bug_fix",
        summary: "Prevent duplicate charges during payment retries.",
      },
      outcome: {
        status: "completed",
        terminal_stage: "close",
        reason_code: "completed",
        verification_status: "passed",
        publication_status: "draft_pr_created",
        gate_attestation_ids: [],
        failure_fingerprint: null,
      },
      retrieval_feedback: [],
      evidence_manifest: evidenceManifest,
      candidates: [candidate],
    };
    const idempotencyKey = `receipt-v1-${producerRunId}`;

    const first = await receiptClient.putRunReceipt(producerRunId, receipt, idempotencyKey);
    expect(first.status).toBe("accepted");
    expect(first.candidate_results).toHaveLength(1);
    expect(first.candidate_results[0]).toMatchObject({
      client_candidate_id: clientCandidateId,
      status: "pending_merge",
      blockers: ["verified_merge_required"],
    });

    const candidateId = first.candidate_results[0]!.candidate_id;
    const candidateStatus = await candidateReadClient.getCandidate(candidateId);
    expect(candidateStatus).toMatchObject({
      candidate_id: candidateId,
      client_candidate_id: clientCandidateId,
      plane: "codebase",
      kind: "constraint",
      status: "pending_merge",
      activation_requirement: "verified_merge",
      blockers: ["verified_merge_required"],
    });

    const replay = await receiptClient.putRunReceipt(producerRunId, receipt, idempotencyKey);
    expect(replay.receipt_id).toBe(first.receipt_id);
    expect(replay.candidate_results[0]!.candidate_id).toBe(candidateId);
    expect(replay.request_digest).toBe(first.request_digest);
  });
});
