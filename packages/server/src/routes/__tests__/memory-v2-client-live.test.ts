import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canonicalJsonSha256,
  MEMORY_CONTRACT_FIXTURES_V2,
  type CodebaseRunReceiptV2,
  type CodebaseMemorySearchV2,
  type HarnessMemorySearchV2,
  type MemoryFeedbackV2,
  type MemorySearchResultV2,
} from "@pim/shared";
import { PimMemoryV2Client } from "../../../../sdk/src/memory-v2-client.js";
import db from "../../db/connection.js";
import { validateMemoryCandidate } from "../../services/memory-candidates.js";
import { importActiveHarnessMemoryRecord } from "../../services/memory-harness-records.js";
import { ensureMemoryV2EvidenceVerifiedTrust } from "../../services/memory-v2-trust.js";
import { scanMemoryV2Input } from "../../services/memory-v2-input-safety.js";
import { createServiceToken } from "../../services/service-tokens.js";
import {
  MEMORY_V2_RECORD_ID_MAX_LENGTH,
} from "../memory-v2-search.js";
import {
  createMemoryTestContext,
  type MemoryTestContext,
} from "./memory-test-app.js";

let context: MemoryTestContext;
let client: PimMemoryV2Client;
let harnessClient: PimMemoryV2Client;
let adminClient: PimMemoryV2Client;
let harnessRecordId = "";

const REPOSITORY_ID = "github.com/acme/checkout";

function safeEvidenceManifest(input: {
  suffix: string;
  refs: CodebaseRunReceiptV2["evidence_manifest"]["refs"];
}): CodebaseRunReceiptV2["evidence_manifest"] {
  for (let attempt = 0; attempt < 256; attempt++) {
    const body = {
      schema_version: "pim.memory-code-evidence.v2" as const,
      manifest_id: `manifest-live-v2-${input.suffix}-${attempt}`,
      refs: input.refs,
    };
    const manifest = { ...body, digest: canonicalJsonSha256(body) };
    if (scanMemoryV2Input(manifest).clean) return manifest;
  }
  throw new Error("Could not construct a deterministic safety-clean evidence manifest");
}

function receiptFor(input: {
  suffix: string;
  producerRunId: string;
  baseSha: string;
  pack: MemorySearchResultV2;
}): { receipt: CodebaseRunReceiptV2; evidenceRefId: string } {
  const source = structuredClone(
    MEMORY_CONTRACT_FIXTURES_V2.RunReceiptV2,
  ) as unknown as CodebaseRunReceiptV2;
  const evidenceRefId = `failure-live-v2-${input.suffix}`;
  const failureFingerprint = `failure:live-v2:${input.suffix}`;
  const manifestRefs: CodebaseRunReceiptV2["evidence_manifest"]["refs"] = [{
      id: evidenceRefId,
      type: "failure" as const,
      uri: `https://github.com/acme/checkout/commit/${input.baseSha}.diff`,
      digest: `sha256:${"f".repeat(64)}`,
      origin_id: `${REPOSITORY_ID}:failure:${input.suffix}`,
      occurred_at: "2026-08-08T18:00:00.000Z",
      source_authority: "observed" as const,
    }];
  const item = input.pack.items[0]!;
  return {
    evidenceRefId,
    receipt: {
      schema_version: "pim.run-receipt.v2",
      external_session_id: `live-v2-session-${input.suffix}`,
      producer: {
        ...source.producer,
        consumer_run_id: input.producerRunId,
      },
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
        summary: "Keep a failed retry scoped to the exact repository snapshot.",
      },
      outcome: {
        status: "completed",
        terminal_stage: "close",
        reason_code: "failure_review_ready",
        verification_status: "passed",
        failure_fingerprint: failureFingerprint,
      },
      retrieval_feedback: [{
        retrieval_pack_id: input.pack.retrieval_pack_id,
        scope_snapshot_digest: input.pack.scope_snapshot_digest,
        record_id: item.record_id,
        record_version: item.record_version,
        disposition: "helpful",
        reason_code: "live_v2_pack_helped",
      }],
      evidence_manifest: safeEvidenceManifest({ suffix: input.suffix, refs: manifestRefs }),
      candidates: [{
        schema_version: "pim.memory-candidate.v2",
        client_candidate_id: `candidate-live-v2-${input.suffix}`,
        plane: "codebase",
        resource_row_id: input.pack.resource_binding.resource_row_id,
        scope_snapshot_digest: input.pack.scope_snapshot_digest,
        kind: "anti_pattern",
        subkind: null,
        content: {
          summary: "Avoid replaying the failed provider request blindly.",
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
        exceptions: ["Does not apply when the provider confirms no side effect occurred."],
        source_run_ids: [input.producerRunId],
        evidence_refs: [evidenceRefId],
        extraction: {
          method: "model_then_deterministic_validation",
          extractor_version: "live-v2-client-test",
          confidence: 0.94,
        },
        activation_requirement_requested: "authorized_review",
      }],
    },
  };
}

beforeAll(async () => {
  context = await createMemoryTestContext({
    routerOptions: { maxParamLength: MEMORY_V2_RECORD_ID_MAX_LENGTH },
  }, { v2Reads: true, v2Writes: true });
  const owner = db.prepare(
    "SELECT created_by_user_id FROM projects WHERE project_id = ?",
  ).get(context.projectA) as { created_by_user_id: string };
  const token = createServiceToken({
    orgId: context.orgA.id,
    name: "Live strict v2 generated client",
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
  });
  harnessRecordId = `memory-live-sdk-slice4-${randomUUID()}`;
  const harnessRecord = importActiveHarnessMemoryRecord({
    orgId: context.orgA.id,
    projectId: context.projectA,
    recordId: harnessRecordId,
    kind: "anti_pattern",
    content: {
      summary: "Inspect terminal tool state before retrying a timeout.",
      details: "An ambiguous timeout may hide a completed side effect, so resolve the exact terminal state first.",
      rationale: "Blind retries can duplicate a side effect that already completed.",
    },
    applicability: {
      harness_id: "example-harness-a",
      harness_version_range: "7b6e858",
      workflow_version_range: "code-change.v3",
      adapter_version_range: "example-harness-a-pim-adapter.v2",
      configuration_ids: ["routing-default-v2"],
      model_ids: ["claude-sonnet"],
      tool_ids: ["github"],
    },
    exceptions: ["Do not retry when terminal state cannot be resolved."],
    compatibility: {
      harness_version_range: "7b6e858",
      workflow_version_range: "code-change.v3",
      adapter_version_range: "example-harness-a-pim-adapter.v2",
    },
    validation: {
      strategy: "stable_failure_fingerprint",
      failure_fingerprint: "fixture:harness:tool-timeout:v2",
    },
    evidence: [{
      evidence_ref_id: "evidence-live-sdk-slice4-harness",
      type: "authorized_review",
      digest: `sha256:${"9".repeat(64)}`,
      origin_id: "example-harness-a:live-sdk-slice4:authorized-review",
      source_authority: "authorized_review",
    }],
    evidenceSummary: { strength: "reviewed", ref_count: 1 },
    freshness: { last_confirmed_at: "2026-08-07T17:00:00.000Z", expires_at: null },
    provenance: {
      source: "slice4_live_sdk_acceptance",
      extractor_version: "slice4-live-sdk-test-v1",
    },
    actorId: "slice4-live-sdk-reviewer",
    decisionRefs: ["decision-live-sdk-slice4-harness"],
    reasonCode: "authorized_harness_failure_reviewed",
    explanation: "The bounded timeout failure behavior was reviewed.",
    now: "2026-08-07T17:00:00.000Z",
  });
  ensureMemoryV2EvidenceVerifiedTrust({
    recordId: harnessRecord.recordId,
    recordVersion: harnessRecord.recordVersion,
    orgId: context.orgA.id,
    projectId: context.projectA,
    evidenceVerifiedAt: "2026-08-07T17:00:00.000Z",
  });
  const baseUrl = await context.app.listen({ host: "127.0.0.1", port: 0 });
  client = new PimMemoryV2Client({
    baseUrl,
    authToken: token.token,
    orgSlug: context.orgA.slug,
  });
  harnessClient = new PimMemoryV2Client({
    baseUrl,
    authToken: context.harnessSearchTokenA,
    orgSlug: context.orgA.slug,
  });
  adminClient = new PimMemoryV2Client({
    baseUrl,
    authToken: context.adminTokenA,
    orgSlug: context.orgA.slug,
  });
});

afterAll(async () => {
  if (context) await context.app.close();
});

describe("live strict v2 generated-client Slice 2 and Slice 3 contract", () => {
  it("negotiates authority, replays code search, and expands immutable detail/history", async () => {
    const capabilities = await client.capabilities();
    expect(capabilities.schema_version).toBe("pim.memory-capabilities.v2");
    expect(capabilities.known_planes).toEqual(["codebase", "harness"]);

    const binding = await client.binding();
    expect(binding.tenant).toEqual({
      organization_id: context.orgA.id,
      project_id: context.projectA,
    });
    expect(binding.resources).toContainEqual(expect.objectContaining({
      plane: "codebase",
      canonical_resource_id: "github.com/acme/checkout",
      permitted_operations: expect.arrayContaining(["search", "detail", "history", "pack"]),
    }));
    expect(await client.readiness({
      plane: "codebase",
      resource_selector: { canonical_resource_id: REPOSITORY_ID },
    })).toMatchObject({
      schema_version: "pim.memory-readiness.v2",
      tenant: {
        organization_id: context.orgA.id,
        project_id: context.projectA,
      },
      plane: "codebase",
      resource_binding: { canonical_resource_id: REPOSITORY_ID },
      status: "healthy",
      reverification_supported: true,
      worker_status: "disabled",
    });

    const fixture = structuredClone(
      MEMORY_CONTRACT_FIXTURES_V2.MemorySearchV2,
    ) as unknown as CodebaseMemorySearchV2;
    const request: CodebaseMemorySearchV2 = {
      ...fixture,
      request_id: "live-generated-client-v2-search-1",
      tenant: { project_id: context.projectA },
      resource_selector: { canonical_resource_id: "github.com/acme/checkout" },
      applicability: {
        ...fixture.applicability,
        repository_id: "github.com/acme/checkout",
      },
    };
    const result = await client.searchCode(request);
    expect(result.items[0]).toMatchObject({
      record_id: context.seededRecordId,
      record_version: 1,
    });
    expect((await client.searchCode(request)).retrieval_pack_id).toBe(
      result.retrieval_pack_id,
    );
    expect(await client.getPack(result.retrieval_pack_id)).toMatchObject({
      retrieval_pack_id: result.retrieval_pack_id,
      plane: "codebase",
      resource_binding: result.resource_binding,
      items: result.items.map((item) => expect.objectContaining({
        record_id: item.record_id,
        record_version: item.record_version,
      })),
    });

    const detail = await client.getRecord(context.seededRecordId, 1);
    expect(detail).toMatchObject({
      record_id: context.seededRecordId,
      record_version: 1,
      resource_binding: result.resource_binding,
    });
    const history = await client.getRecordHistory(context.seededRecordId);
    expect(history.current_version).toBe(1);
    expect(history.versions).toEqual([detail]);
  });

  it("round-trips the Slice 3 write path through a real listener", async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
    const producerRunId = `example-harness-a:test:live-v2:${suffix}`;
    const baseSha = "d".repeat(40);
    const fixture = structuredClone(
      MEMORY_CONTRACT_FIXTURES_V2.MemorySearchV2,
    ) as unknown as CodebaseMemorySearchV2;
    const pack = await client.searchCode({
      ...fixture,
      request_id: `live-v2-write-pack-${suffix}`,
      consumer: { ...fixture.consumer, consumer_run_id: producerRunId },
      tenant: { project_id: context.projectA },
      resource_selector: { canonical_resource_id: REPOSITORY_ID },
      applicability: {
        ...fixture.applicability,
        repository_id: REPOSITORY_ID,
        base_sha: baseSha,
      },
    });
    expect(pack.items.length).toBeGreaterThan(0);

    const { receipt, evidenceRefId } = receiptFor({
      suffix,
      producerRunId,
      baseSha,
      pack,
    });
    const idempotencyKey = `live-v2-receipt-${suffix}`;
    const accepted = await client.putRunReceipt(producerRunId, idempotencyKey, receipt);
    expect(accepted).toMatchObject({
      producer_run_id: producerRunId,
      plane: "codebase",
      scope_snapshot_digest: pack.scope_snapshot_digest,
      status: "accepted",
      duplicate: false,
    });
    expect(accepted.candidate_results).toHaveLength(1);

    const replay = await client.putRunReceipt(producerRunId, idempotencyKey, receipt);
    expect(replay).toMatchObject({
      receipt_id: accepted.receipt_id,
      request_digest: accepted.request_digest,
      status: "replayed",
      duplicate: true,
    });

    const candidateId = accepted.candidate_results[0]!.candidate_id;
    expect(await client.getCandidate(candidateId)).toMatchObject({
      candidate_id: candidateId,
      status: "accepted",
      active_record: null,
    });

    const candidateRow = db.prepare(
      "SELECT aggregate_version FROM memory_candidates_v1 WHERE candidate_id = ?",
    ).get(candidateId) as { aggregate_version: number };
    validateMemoryCandidate(candidateId, candidateRow.aggregate_version);
    expect(await client.getCandidate(candidateId)).toMatchObject({
      candidate_id: candidateId,
      status: "pending_review",
      active_record: null,
    });

    const feedback: MemoryFeedbackV2 = {
      schema_version: "pim.memory-feedback.v2",
      feedback_revision: 1,
      retrieval_pack_id: pack.retrieval_pack_id,
      record_id: pack.items[0]!.record_id,
      record_version: pack.items[0]!.record_version,
      producer_run_id: producerRunId,
      plane: "codebase",
      resource_row_id: pack.resource_binding.resource_row_id,
      scope_snapshot_digest: pack.scope_snapshot_digest,
      disposition: "helpful",
      reason_code: "live_v2_later_feedback",
      outcome_evidence_refs: [],
      event_time: "2026-08-08T18:05:00.000Z",
    };
    const feedbackResult = await client.submitFeedback(
      `live-v2-feedback-${suffix}`,
      feedback,
    );
    expect(feedbackResult).toMatchObject({
      feedback_revision: 1,
      plane: "codebase",
      duplicate: false,
    });

    const decision = await client.decideCandidate(candidateId, {
      schema_version: "pim.memory-candidate-decision.v2",
      decision_revision: 1,
      plane: "codebase",
      resource_row_id: pack.resource_binding.resource_row_id,
      decision: "reject",
      reason_code: "live_v2_scope_too_broad",
      explanation: "The failure is real, but the proposed reusable claim is broader than the reviewed evidence.",
      evidence_refs: [evidenceRefId],
      event_time: "2026-08-08T18:10:00.000Z",
    });
    expect(decision).toMatchObject({
      candidate_id: candidateId,
      decision: "reject",
      candidate_status: "rejected",
      active_record: null,
      duplicate: false,
    });
    expect(await client.getCandidate(candidateId)).toMatchObject({
      status: "rejected",
      active_record: null,
    });
  });
});

describe("live strict v2 generated-client Slice 4 harness contract", () => {
  it("searches one exact harness and expands its immutable detail", async () => {
    const source = structuredClone(
      MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpHarnessSearchInputV2,
    );
    const request: HarnessMemorySearchV2 = {
      ...source,
      request_id: "live-generated-client-v2-harness-search-1",
      consumer: {
        ...source.consumer,
        harness_id: "example-harness-a",
        adapter_version: "example-harness-a-pim-adapter.v2",
        consumer_run_id: "example-harness-a:test:live-sdk:run-1",
      },
      tenant: { project_id: context.projectA },
      resource_selector: { canonical_resource_id: "example-harness-a" },
      applicability: {
        ...source.applicability,
        harness_id: "example-harness-a",
        adapter_version_range: "example-harness-a-pim-adapter.v2",
        configuration_ids: [...source.applicability.configuration_ids],
        configuration_digests: [],
        model_ids: [...source.applicability.model_ids],
        tool_ids: [...source.applicability.tool_ids],
      },
    };

    const binding = await harnessClient.binding();
    expect(binding.resources).toContainEqual(expect.objectContaining({
      plane: "harness",
      resource_type: "harness",
      canonical_resource_id: "example-harness-a",
      permitted_operations: expect.arrayContaining(["search", "detail", "pack"]),
    }));
    expect(await harnessClient.readiness({
      plane: "harness",
      resource_selector: { canonical_resource_id: "example-harness-a" },
    })).toMatchObject({
      schema_version: "pim.memory-readiness.v2",
      tenant: {
        organization_id: context.orgA.id,
        project_id: context.projectA,
      },
      plane: "harness",
      resource_binding: { canonical_resource_id: "example-harness-a" },
      status: "healthy",
      reverification_supported: true,
      worker_status: "disabled",
    });

    const result = await harnessClient.searchHarness(request);
    expect(result).toMatchObject({
      request_id: request.request_id,
      plane: "harness",
      resource_binding: { canonical_resource_id: "example-harness-a" },
    });
    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        record_id: harnessRecordId,
        record_version: 1,
        plane: "harness",
      }),
    ]));
    expect((await harnessClient.searchHarness(request)).retrieval_pack_id).toBe(
      result.retrieval_pack_id,
    );
    expect(await harnessClient.getPack(result.retrieval_pack_id)).toMatchObject({
      retrieval_pack_id: result.retrieval_pack_id,
      plane: "harness",
      resource_binding: result.resource_binding,
    });

    const detail = await harnessClient.getRecord(harnessRecordId, 1);
    expect(detail).toMatchObject({
      record_id: harnessRecordId,
      record_version: 1,
      plane: "harness",
      subkind: "failure_pattern",
      resource_binding: result.resource_binding,
    });
  });
});
