import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  canonicalJsonSha256,
  parseMemoryContractV2,
  type HarnessMemorySearchV2,
  type HarnessRuntimeEvidenceHandleV2,
  type MemoryCandidateDecisionV2,
  type ResourceBindingV2,
} from "@pim/shared";
import db, { withImmediateTransaction } from "../../db/connection.js";
import {
  createMemoryTestContext,
  type MemoryTestContext,
} from "../../routes/__tests__/memory-test-app.js";
import { harnessWriteFixture } from "../../routes/__tests__/memory-v2-harness-write-fixture.js";
import { getMemoryCandidateStatus, validateMemoryCandidate } from "../memory-candidates.js";
import {
  canonicalHarnessMemoryClaimKey,
  importActiveHarnessMemoryRecord,
} from "../memory-harness-records.js";
import {
  assertMemoryV2StoredCandidateFacet,
  assertMemoryV2StoredRecordFacet,
  memoryV2NativeHarnessRecordProjectionDigest,
} from "../memory-v2-canonical-writes.js";
import { getMemoryV2Binding } from "../memory-v2-binding.js";
import {
  decideHarnessMemoryCandidateV2,
  getHarnessMemoryCandidateStatusV2,
  submitHarnessMemoryRunReceiptV2,
} from "../memory-v2-harness-write.js";
import {
  getHarnessMemoryRecordV2,
  searchHarnessMemoryV2,
} from "../memory-v2-harness-read.js";
import {
  applyMemoryErasurePlan,
  createMemoryRetentionPolicyVersion,
  planMemoryRetention,
} from "../memory-data-governance.js";
import { setMemoryMetricSink, type MemoryMetric } from "../memory-metrics.js";
import {
  resolveMemoryRuntimeAttestation,
  setMemoryRuntimeAttestationVerifier,
} from "../memory-v2-runtime-attestations.js";
import { reconcileMemoryV2CanonicalFacets } from "../memory-v2-startup-reconciliation.js";
import {
  createServiceToken,
  revokeServiceToken,
  verifyMemoryV2ServiceToken,
  type MemoryV2RequestAuthorizationSnapshot,
} from "../service-tokens.js";

const NOW = "2026-08-10T12:00:00.000Z";
let context: MemoryTestContext;
let ownerId: string;
let metrics: MemoryMetric[] = [];

function marker(label: string): string {
  return `${label}-${randomUUID().replaceAll("-", "").slice(0, 10)}`;
}

function verifiedResolution(input: {
  auth: { producerPrincipalId: string };
  handle: HarnessRuntimeEvidenceHandleV2;
  receivedAt: string;
}) {
  return {
    providerIdentity: `service_principal:${input.auth.producerPrincipalId}`,
    providerDomainKey: `approved_domain:${input.auth.producerPrincipalId}`,
    providerEventId: input.handle.provider_event_id,
    immutableDigest: input.handle.immutable_digest,
    occurredAt: input.handle.occurred_at,
    verifiedAt: input.receivedAt,
    outcomeFingerprint: canonicalJsonSha256(input.handle.outcome),
    observationType: input.handle.observation_type,
    sourceAuthority: "verified" as const,
  };
}

function authority(name: string): {
  token: string;
  principal: MemoryV2RequestAuthorizationSnapshot;
  binding: ResourceBindingV2;
} {
  const created = createServiceToken({
    orgId: context.orgA.id,
    name,
    scopes: [
      "memory:harness:receipt:write",
      "memory:harness:candidate:read",
      "memory:harness:search",
    ],
    createdByUserId: ownerId,
    projectId: context.projectA,
    harnessIds: ["example-harness-a"],
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  const principal = verifyMemoryV2ServiceToken(created.token)!.authorization;
  const binding = getMemoryV2Binding(principal).resources.find((item) => (
    item.plane === "harness" && item.canonical_resource_id === "example-harness-a"
  ))!;
  return { token: created.token, principal, binding };
}

function searchRequest(requestId: string, binding: ResourceBindingV2): HarnessMemorySearchV2 {
  return parseMemoryContractV2("HarnessMemorySearchV2", {
    schema_version: "pim.memory-search.v2",
    request_id: requestId,
    consumer: {
      harness_id: "example-harness-a",
      harness_version: "7b6e858",
      workflow_version: "code-change.v3",
      adapter_version: "example-harness-a-pim-adapter.v2",
      consumer_run_id: `consumer-${requestId}`,
    },
    tenant: { project_id: context.projectA },
    plane: "harness",
    resource_selector: { resource_row_id: binding.resource_row_id },
    applicability: {
      plane: "harness",
      harness_id: "example-harness-a",
      harness_version_range: "7b6e858",
      workflow_version_range: "code-change.v3",
      adapter_version_range: "example-harness-a-pim-adapter.v2",
      configuration_ids: ["routing-default-v2"],
      configuration_digests: [],
      model_ids: ["claude-sonnet"],
      tool_ids: ["github"],
    },
    task: {
      query: "A harness timeout can hide a completed side effect",
      task_class: "recovery",
    },
    temporal: { mode: "current", valid_at: NOW, recorded_at: NOW },
    budget: { max_tokens: 1800, max_items: 8 },
    options: { include_explanations: true },
  });
}

function decision(input: {
  resourceRowId: string;
  evidenceRefId?: string;
  revision?: number;
}): MemoryCandidateDecisionV2 {
  return parseMemoryContractV2("MemoryCandidateDecisionV2", {
    schema_version: "pim.memory-candidate-decision.v2",
    decision_revision: input.revision ?? 1,
    plane: "harness",
    resource_row_id: input.resourceRowId,
    decision: "approve",
    reason_code: "authorized_runtime_failure_reviewed",
    explanation: "An authorized reviewer approved the exact runtime-origin lesson for shadow retrieval.",
    evidence_refs: input.evidenceRefId ? [input.evidenceRefId] : [],
    event_time: NOW,
  });
}

function producerEffects(producerRunId: string): {
  receipts: number;
  snapshots: number;
  origins: number;
} {
  return {
    receipts: Number((db.prepare(
      "SELECT COUNT(*) AS count FROM memory_run_receipts WHERE producer_run_id = ?",
    ).get(producerRunId) as { count: number }).count),
    snapshots: Number((db.prepare(
      "SELECT COUNT(*) AS count FROM memory_v2_scope_snapshots WHERE producer_run_id = ?",
    ).get(producerRunId) as { count: number }).count),
    origins: Number((db.prepare(
      "SELECT COUNT(*) AS count FROM memory_v2_origins WHERE producer_run_id = ?",
    ).get(producerRunId) as { count: number }).count),
  };
}

beforeAll(async () => {
  context = await createMemoryTestContext({}, { v2Reads: true, v2Writes: true });
  if (!db.prepare("SELECT 1 FROM memory_authority_transitions LIMIT 1").get()) {
    const digest = canonicalJsonSha256({ fixture: "slice5-harness-governance" });
    db.prepare(
      `INSERT INTO memory_legacy_import_runs
         (import_run_id, inventory_digest, resolution_digest, source_bundle_digest,
          source_item_count, imported_count, pending_count, quarantined_count,
          deduplicated_count, report_json, created_at)
       VALUES ('slice5-harness-cutover', ?, ?, ?, 0, 0, 0, 0, 0, '{}', ?)`,
    ).run(digest, digest, digest, NOW);
    db.prepare(
      `INSERT INTO memory_authority_transitions
         (transition_id, revision, from_authority, to_authority,
          legacy_writes_frozen, import_run_id, actor_id, reason_code, occurred_at)
       VALUES
         ('slice5-harness-authority-1', 1, 'legacy', 'migration_locked', 1,
          'slice5-harness-cutover', 'slice5-test', 'cutover_started', ?),
         ('slice5-harness-authority-2', 2, 'migration_locked', 'canonical', 1,
          'slice5-harness-cutover', 'slice5-test', 'cutover_complete', ?)`,
    ).run(NOW, NOW);
  }
  ownerId = (db.prepare(
    "SELECT created_by_user_id FROM projects WHERE project_id = ?",
  ).get(context.projectA) as { created_by_user_id: string }).created_by_user_id;
});

beforeEach(() => {
  metrics = [];
  setMemoryMetricSink((metric) => metrics.push(metric));
  setMemoryRuntimeAttestationVerifier(async (input) => verifiedResolution(input));
});

afterEach(() => {
  setMemoryRuntimeAttestationVerifier(null);
  setMemoryMetricSink(null);
});

afterAll(async () => {
  if (context) await context.app.close();
});

describe("Slice 3 native harness lifecycle", () => {
  it("commits a topologically ordered receipt once, replays without the provider, and preserves snapshot configuration", async () => {
    const actor = authority("Slice 5 receipt replay authority");
    const producerRunId = `run-${marker("replay")}`;
    const fixture = harnessWriteFixture({
      marker: marker("receipt"),
      producerRunId,
      projectId: context.projectA,
      resourceBinding: actor.binding,
      includeDerivation: true,
      configurationDigests: "empty",
    });
    expect(actor.binding.permitted_operations).toEqual(expect.arrayContaining([
      "receipt_write",
      "candidate_write",
      "runtime_attestation_write",
      "candidate_read",
    ]));
    fixture.receipt.evidence_handles.reverse();
    let providerCalls = 0;
    setMemoryRuntimeAttestationVerifier(async (input) => {
      providerCalls += 1;
      return verifiedResolution(input);
    });

    const accepted = await submitHarnessMemoryRunReceiptV2({
      principal: actor.principal,
      producerRunId,
      idempotencyKey: fixture.idempotencyKey,
      receipt: fixture.receipt,
      now: NOW,
    });
    expect(accepted).toMatchObject({
      plane: "harness",
      status: "accepted",
      duplicate: false,
      candidate_results: [{
        subkind: "failure_pattern",
        activation_requirement: "authorized_review",
        status: "accepted",
        latest_transition: { from_status: null, to_status: "accepted" },
        active_record: null,
      }],
    });
    expect(providerCalls).toBe(2);
    expect(producerEffects(producerRunId)).toEqual({ receipts: 1, snapshots: 1, origins: 2 });
    expect(metrics.filter((metric) => metric.name === "RuntimeOriginDomainCount")).toHaveLength(2);
    const candidateId = accepted.candidate_results[0]!.candidate_id;
    expect(getMemoryCandidateStatus(context.orgA.id, context.projectA, candidateId)).toMatchObject({
      status: "received",
      latest_transition: { from_status: null, to_status: "received" },
    });
    const storedCandidate = db.prepare(
      "SELECT candidate_json FROM memory_candidates_v1 WHERE candidate_id = ?",
    ).get(candidateId) as { candidate_json: string };
    expect(JSON.parse(storedCandidate.candidate_json).extensions).toMatchObject({
      v2_configuration_digest: fixture.configurationDigest,
      v2_configuration_selector_digest: null,
      v2_activation_requirement_requested: "independently_verified_runtime",
    });

    const replayed = await submitHarnessMemoryRunReceiptV2({
      principal: actor.principal,
      producerRunId,
      idempotencyKey: fixture.idempotencyKey,
      receipt: fixture.receipt,
      now: NOW,
    });
    expect(replayed).toMatchObject({
      receipt_id: accepted.receipt_id,
      request_digest: accepted.request_digest,
      status: "replayed",
      duplicate: true,
    });
    expect(providerCalls).toBe(2);
    expect(metrics.filter((metric) => metric.name === "RuntimeOriginDomainCount")).toHaveLength(2);

    expect(getHarnessMemoryCandidateStatusV2({
      principal: actor.principal,
      candidateId,
      resourceSelector: { resource_row_id: actor.binding.resource_row_id },
      receiptId: accepted.receipt_id,
      producerRunId,
    })).toMatchObject({ candidate_id: candidateId, status: "accepted" });
    const other = authority("Slice 5 non-enumerating other producer");
    expect(() => getHarnessMemoryCandidateStatusV2({
      principal: other.principal,
      candidateId,
      resourceSelector: { resource_row_id: actor.binding.resource_row_id },
      receiptId: accepted.receipt_id,
      producerRunId,
    })).toThrow(expect.objectContaining({ statusCode: 404, code: "resource_not_found" }));
  });

  it("accepts and exactly replays a zero-candidate terminal receipt without provider effects", async () => {
    const actor = authority("Slice 3 zero-candidate receipt authority");
    const producerRunId = `run-${marker("zero-candidate")}`;
    const fixture = harnessWriteFixture({
      marker: marker("zero-candidate-fixture"),
      producerRunId,
      projectId: context.projectA,
      resourceBinding: actor.binding,
      includeCandidate: false,
    });
    let providerCalls = 0;
    setMemoryRuntimeAttestationVerifier(async (input) => {
      providerCalls += 1;
      return verifiedResolution(input);
    });

    const accepted = await submitHarnessMemoryRunReceiptV2({
      principal: actor.principal,
      producerRunId,
      idempotencyKey: fixture.idempotencyKey,
      receipt: fixture.receipt,
      now: NOW,
    });
    expect(accepted).toMatchObject({
      status: "accepted",
      duplicate: false,
      candidate_results: [],
    });
    expect(providerCalls).toBe(0);
    expect(producerEffects(producerRunId)).toEqual({ receipts: 1, snapshots: 1, origins: 0 });
    expect((db.prepare(
      "SELECT COUNT(*) AS count FROM memory_receipt_candidates WHERE receipt_id = ?",
    ).get(accepted.receipt_id) as { count: number }).count).toBe(0);

    const replayed = await submitHarnessMemoryRunReceiptV2({
      principal: actor.principal,
      producerRunId,
      idempotencyKey: fixture.idempotencyKey,
      receipt: fixture.receipt,
      now: NOW,
    });
    expect(replayed).toMatchObject({
      receipt_id: accepted.receipt_id,
      request_digest: accepted.request_digest,
      status: "replayed",
      duplicate: true,
      candidate_results: [],
    });
    expect(providerCalls).toBe(0);
    expect(reconcileMemoryV2CanonicalFacets().receipts.mismatchCount).toBe(0);
  });

  it("returns 503 with zero effects on provider outage and rolls back a late insertion failure", async () => {
    const actor = authority("Slice 5 provider outage authority");
    const outageRun = `run-${marker("outage")}`;
    const outage = harnessWriteFixture({
      marker: marker("outage-fixture"),
      producerRunId: outageRun,
      projectId: context.projectA,
      resourceBinding: actor.binding,
    });
    setMemoryRuntimeAttestationVerifier(async () => {
      throw new Error("provider offline");
    });
    await expect(submitHarnessMemoryRunReceiptV2({
      principal: actor.principal,
      producerRunId: outageRun,
      idempotencyKey: outage.idempotencyKey,
      receipt: outage.receipt,
      now: NOW,
    })).rejects.toMatchObject({ statusCode: 503, code: "temporarily_unavailable" });
    expect(producerEffects(outageRun)).toEqual({ receipts: 0, snapshots: 0, origins: 0 });
    expect(metrics).toEqual([]);

    setMemoryRuntimeAttestationVerifier(async (input) => verifiedResolution(input));
    const rollbackRun = `run-${marker("rollback")}`;
    const rollback = harnessWriteFixture({
      marker: marker("rollback-fixture"),
      producerRunId: rollbackRun,
      projectId: context.projectA,
      resourceBinding: actor.binding,
    });
    await expect(submitHarnessMemoryRunReceiptV2({
      principal: actor.principal,
      producerRunId: rollbackRun,
      idempotencyKey: rollback.idempotencyKey,
      receipt: rollback.receipt,
      now: NOW,
      dependencies: { beforeRuntimeEvidenceInsert: () => { throw new Error("late failure"); } },
    })).rejects.toThrow("late failure");
    expect(producerEffects(rollbackRun)).toEqual({ receipts: 0, snapshots: 0, origins: 0 });
    expect(metrics).toEqual([]);
  });

  it("rejects valid-v2 content boundaries that the canonical v1 bridge cannot preserve", async () => {
    const actor = authority("Slice 5 content representability authority");
    const cases = [
      ["summary", "x"],
      ["summary", "x".repeat(501)],
      ["details", "x"],
      ["details", "x".repeat(8_001)],
      ["rationale", "x"],
      ["rationale", "x".repeat(4_001)],
    ] as const;
    let providerCalls = 0;
    setMemoryRuntimeAttestationVerifier(async (input) => {
      providerCalls += 1;
      return verifiedResolution(input);
    });
    for (const [field, value] of cases) {
      const producerRunId = `run-${marker(`content-${field}`)}`;
      const fixture = harnessWriteFixture({
        marker: marker(`content-${field}-fixture`),
        producerRunId,
        projectId: context.projectA,
        resourceBinding: actor.binding,
      });
      fixture.receipt.candidates[0]!.content[field] = value;
      expect(() => parseMemoryContractV2("HarnessRunReceiptV2", fixture.receipt)).not.toThrow();
      await expect(submitHarnessMemoryRunReceiptV2({
        principal: actor.principal,
        producerRunId,
        idempotencyKey: fixture.idempotencyKey,
        receipt: fixture.receipt,
        now: NOW,
      })).rejects.toMatchObject({
        statusCode: 409,
        details: [{ path: `/candidates/0/content/${field}` }],
      });
      expect(producerEffects(producerRunId)).toEqual({ receipts: 0, snapshots: 0, origins: 0 });
    }
    expect(providerCalls).toBe(0);
  });

  it("rejects every remaining valid-v2 value the v1 bridge cannot preserve before provider effects", async () => {
    const actor = authority("Slice 5 bridge representability authority");
    const cases: Array<{
      label: string;
      path: string;
      mutate(fixture: ReturnType<typeof harnessWriteFixture>): void;
    }> = [
      {
        label: "terminal-stage",
        path: "/outcome/terminal_stage",
        mutate: (fixture) => { fixture.receipt.outcome.terminal_stage = "x".repeat(65); },
      },
      {
        label: "short-fingerprint",
        path: "/outcome/failure_fingerprint",
        mutate: (fixture) => {
          fixture.receipt.outcome.failure_fingerprint = "short";
          fixture.receipt.candidates[0]!.validation.failure_fingerprint = "short";
          for (const handle of fixture.receipt.evidence_handles) {
            handle.outcome.failure_fingerprint = "short";
          }
        },
      },
      {
        label: "inconclusive",
        path: "/outcome/verification_status",
        mutate: (fixture) => { fixture.receipt.outcome.verification_status = "inconclusive"; },
      },
      {
        label: "source-runs",
        path: "/candidates/source_run_ids",
        mutate: (fixture) => {
          fixture.receipt.candidates[0]!.source_run_ids = [
            fixture.producerRunId,
            ...Array.from({ length: 16 }, (_, index) => `source-run-${index}`),
          ];
        },
      },
      {
        label: "too-much-evidence",
        path: "/candidates/evidence_refs",
        mutate: (fixture) => {
          const template = fixture.receipt.evidence_handles[0]!;
          if (template.handle_type !== "root_origin") throw new Error("root fixture required");
          const handles = Array.from({ length: 65 }, (_, index) => ({
            ...structuredClone(template),
            evidence_ref_id: `runtime-bound-${index}`,
            provider_event_id: `runtime-bound-event-${index}`,
            immutable_digest: canonicalJsonSha256({ runtimeBound: index }),
          }));
          fixture.receipt.evidence_handles = handles;
          fixture.receipt.candidates[0]!.evidence_refs = handles.map(
            (handle) => handle.evidence_ref_id,
          );
        },
      },
      {
        label: "exception-length",
        path: "/candidates/exceptions",
        mutate: (fixture) => { fixture.receipt.candidates[0]!.exceptions = ["x".repeat(1_001)]; },
      },
      {
        label: "model-length",
        path: "/candidates/applicability/model_ids",
        mutate: (fixture) => {
          fixture.receipt.candidates[0]!.applicability.model_ids = ["m".repeat(161)];
        },
      },
      {
        label: "tool-count",
        path: "/candidates/applicability/tool_ids",
        mutate: (fixture) => {
          fixture.receipt.candidates[0]!.applicability.tool_ids = Array.from(
            { length: 33 },
            (_, index) => `tool-${index}`,
          );
        },
      },
      {
        label: "tool-length",
        path: "/candidates/applicability/tool_ids",
        mutate: (fixture) => {
          fixture.receipt.candidates[0]!.applicability.tool_ids = ["t".repeat(161)];
        },
      },
      {
        label: "configuration-count",
        path: "/candidates/applicability/configuration_digests",
        mutate: (fixture) => {
          fixture.receipt.candidates[0]!.applicability.configuration_digests = [
            fixture.configurationDigest,
            canonicalJsonSha256({ configuration: "other" }),
          ];
        },
      },
      {
        label: "configuration-mismatch",
        path: "/candidates/applicability/configuration_digests",
        mutate: (fixture) => {
          fixture.receipt.candidates[0]!.applicability.configuration_digests = [
            canonicalJsonSha256({ configuration: "not-the-snapshot" }),
          ];
        },
      },
    ];
    let providerCalls = 0;
    setMemoryRuntimeAttestationVerifier(async (input) => {
      providerCalls += 1;
      return verifiedResolution(input);
    });

    for (const testCase of cases) {
      const producerRunId = `run-${marker(testCase.label)}`;
      const fixture = harnessWriteFixture({
        marker: marker(`${testCase.label}-fixture`),
        producerRunId,
        projectId: context.projectA,
        resourceBinding: actor.binding,
      });
      testCase.mutate(fixture);
      expect(() => parseMemoryContractV2("HarnessRunReceiptV2", fixture.receipt)).not.toThrow();
      await expect(submitHarnessMemoryRunReceiptV2({
        principal: actor.principal,
        producerRunId,
        idempotencyKey: fixture.idempotencyKey,
        receipt: fixture.receipt,
        now: NOW,
      })).rejects.toMatchObject({
        statusCode: 409,
        code: "activation_requirement_unsatisfied",
        details: [{ path: testCase.path }],
      });
      expect(producerEffects(producerRunId)).toEqual({ receipts: 0, snapshots: 0, origins: 0 });
    }
    expect(providerCalls).toBe(0);
  });

  it("rejects too many candidates or broken derivations before resolution", async () => {
    const actor = authority("Slice 5 pre-resolution gates authority");
    let providerCalls = 0;
    setMemoryRuntimeAttestationVerifier(async (input) => {
      providerCalls += 1;
      return verifiedResolution(input);
    });
    const cases = [
      {
        label: "candidate-cardinality",
        mutate: (fixture: ReturnType<typeof harnessWriteFixture>) => {
          fixture.receipt.candidates.push(structuredClone(fixture.receipt.candidates[0]!));
        },
        code: "activation_requirement_unsatisfied",
      },
      {
        label: "missing-parent",
        mutate: (fixture: ReturnType<typeof harnessWriteFixture>) => {
          fixture.receipt.evidence_handles[1]!.derivation_parent_refs = ["missing-parent"];
        },
        code: "evidence_unresolvable",
        includeDerivation: true,
      },
    ] as const;
    for (const item of cases) {
      const producerRunId = `run-${marker(item.label)}`;
      const fixture = harnessWriteFixture({
        marker: marker(`${item.label}-fixture`),
        producerRunId,
        projectId: context.projectA,
        resourceBinding: actor.binding,
        includeDerivation: "includeDerivation" in item && item.includeDerivation,
      });
      item.mutate(fixture);
      await expect(submitHarnessMemoryRunReceiptV2({
        principal: actor.principal,
        producerRunId,
        idempotencyKey: fixture.idempotencyKey,
        receipt: fixture.receipt,
        now: NOW,
      })).rejects.toMatchObject({ code: item.code });
      expect(producerEffects(producerRunId)).toEqual({ receipts: 0, snapshots: 0, origins: 0 });
    }
    expect(providerCalls).toBe(0);
  });

  it.each(["revoked", "disabled", "binding_removed"] as const)(
    "lets an authorized in-flight receipt survive %s and denies the next request",
    async (mutation) => {
      const actor = authority(`Slice 5 ${mutation} race authority`);
      const producerRunId = `run-${marker(mutation)}`;
      const fixture = harnessWriteFixture({
        marker: marker(`${mutation}-fixture`),
        producerRunId,
        projectId: context.projectA,
        resourceBinding: actor.binding,
      });
      setMemoryRuntimeAttestationVerifier(async (input) => {
        if (mutation === "revoked") {
          revokeServiceToken(context.orgA.id, actor.principal.tokenId);
        } else if (mutation === "disabled") {
          db.prepare(
            "UPDATE service_principals SET disabled_at = ? WHERE service_principal_id = ?",
          ).run(NOW, actor.principal.servicePrincipalId);
        } else {
          db.prepare(
            `DELETE FROM memory_v2_service_token_resource_bindings
             WHERE token_id = ? AND service_principal_id = ?
               AND org_id = ? AND project_id = ?`,
          ).run(
            actor.principal.tokenId,
            actor.principal.servicePrincipalId,
            context.orgA.id,
            context.projectA,
          );
        }
        return verifiedResolution(input);
      });
      const accepted = await submitHarnessMemoryRunReceiptV2({
        principal: actor.principal,
        producerRunId,
        idempotencyKey: fixture.idempotencyKey,
        receipt: fixture.receipt,
        now: NOW,
      });
      expect(accepted.duplicate).toBe(false);
      expect(producerEffects(producerRunId)).toEqual({ receipts: 1, snapshots: 1, origins: 1 });
      expect(metrics.length).toBeGreaterThan(0);

      const next = verifyMemoryV2ServiceToken(actor.token);
      if (mutation === "binding_removed") {
        expect(next).not.toBeNull();
        const nextRunId = `run-${marker(`${mutation}-next`)}`;
        const nextFixture = harnessWriteFixture({
          marker: marker(`${mutation}-next-fixture`),
          producerRunId: nextRunId,
          projectId: context.projectA,
          resourceBinding: actor.binding,
        });
        await expect(submitHarnessMemoryRunReceiptV2({
          principal: next!.authorization,
          producerRunId: nextRunId,
          idempotencyKey: nextFixture.idempotencyKey,
          receipt: nextFixture.receipt,
          now: NOW,
        })).rejects.toMatchObject({ code: "resource_binding_mismatch", statusCode: 403 });
      } else {
        expect(next).toBeNull();
      }
    },
  );

  it("validates, reviews, activates, and retrieves a failure-derived lesson", async () => {
    const actor = authority("Slice 5 activation producer");
    const producerRunId = `run-${marker("activate")}`;
    const fixture = harnessWriteFixture({
      marker: marker("activate-fixture"),
      producerRunId,
      projectId: context.projectA,
      resourceBinding: actor.binding,
      includeDerivation: true,
    });
    const accepted = await submitHarnessMemoryRunReceiptV2({
      principal: actor.principal,
      producerRunId,
      idempotencyKey: fixture.idempotencyKey,
      receipt: fixture.receipt,
      now: NOW,
    });
    const candidateId = accepted.candidate_results[0]!.candidate_id;
    const expectedRecordId = `mem_${candidateId.slice("candidate_".length)}`;
    const searchPrincipal = verifyMemoryV2ServiceToken(context.harnessSearchTokenA)!.authorization;
    const before = await searchHarnessMemoryV2({
      principal: searchPrincipal,
      request: searchRequest(`pre-${marker("search")}`, actor.binding),
      dependencies: { now: () => new Date(NOW) },
    });
    expect(before.items.map((item) => item.record_id)).not.toContain(expectedRecordId);

    expect(validateMemoryCandidate(candidateId, 1)).toMatchObject({
      current_status: "pending_review",
    });
    expect(getHarnessMemoryCandidateStatusV2({
      principal: actor.principal,
      candidateId,
      resourceSelector: { resource_row_id: actor.binding.resource_row_id },
      receiptId: accepted.receipt_id,
      producerRunId,
    })).toMatchObject({
      status: "pending_review",
      latest_transition: { from_status: "validating", to_status: "pending_review" },
      activation_requirement: "authorized_review",
      blockers: expect.arrayContaining(["authorized_review_required", "origin_quorum_unavailable"]),
    });

    const decisionBody = decision({
      resourceRowId: actor.binding.resource_row_id,
      evidenceRefId: fixture.evidenceRefIds[0]!,
    });
    const decisionResponse = await context.app.inject({
      method: "POST",
      url: `/api/v2/memory/candidates/${encodeURIComponent(candidateId)}/decisions`,
      headers: { authorization: `Bearer ${context.harnessReviewerTokenA}` },
      payload: decisionBody,
    });
    expect(decisionResponse.statusCode, decisionResponse.body).toBe(200);
    const approved = parseMemoryContractV2(
      "MemoryCandidateDecisionResultV2",
      decisionResponse.json(),
    );
    expect(approved).toMatchObject({
      plane: "harness",
      candidate_status: "active",
      active_record: { record_id: expectedRecordId, record_version: 1 },
    });
    const replayResponse = await context.app.inject({
      method: "POST",
      url: `/api/v2/memory/candidates/${encodeURIComponent(candidateId)}/decisions`,
      headers: { authorization: `Bearer ${context.harnessReviewerTokenA}` },
      payload: decisionBody,
    });
    expect(replayResponse.statusCode, replayResponse.body).toBe(200);
    expect(parseMemoryContractV2(
      "MemoryCandidateDecisionResultV2",
      replayResponse.json(),
    )).toMatchObject({
      decision_id: approved.decision_id,
      active_record: approved.active_record,
      duplicate: true,
    });
    assertMemoryV2StoredCandidateFacet(candidateId);
    assertMemoryV2StoredRecordFacet({ recordId: expectedRecordId, recordVersion: 1 });

    const after = await searchHarnessMemoryV2({
      principal: searchPrincipal,
      request: searchRequest(`post-${marker("search")}`, actor.binding),
      dependencies: { now: () => new Date(NOW) },
    });
    expect(after).toMatchObject({
      plane: "harness",
    });
    expect(after.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        record_id: expectedRecordId,
        subkind: "failure_pattern",
      }),
    ]));
    expect(getHarnessMemoryRecordV2({
      principal: searchPrincipal,
      recordId: expectedRecordId,
      recordVersion: 1,
    })).toMatchObject({
      subkind: "failure_pattern",
      applicability: { configuration_digests: [fixture.configurationDigest] },
      evidence_summary: { distinct_corroboration_domain_count: 1 },
    });
  });

  it.each(["runtime_attestation", "authorized_review"] as const)(
    "accepts a successful-run %s lesson with a null failure fingerprint and keeps review gating",
    async (validationStrategy) => {
      const actor = authority(`Slice 3 ${validationStrategy} producer`);
      const reviewer = verifyMemoryV2ServiceToken(context.harnessReviewerTokenA)!.authorization;
      const producerRunId = `run-${marker(validationStrategy)}`;
      const fixture = harnessWriteFixture({
        marker: marker(`${validationStrategy}-fixture`),
        producerRunId,
        projectId: context.projectA,
        resourceBinding: actor.binding,
        subtype: "workflow_strategy",
        validationStrategy,
      });
      expect(fixture.receipt.outcome).toMatchObject({
        status: "completed",
        verification_status: "passed",
        failure_fingerprint: null,
      });

      const accepted = await submitHarnessMemoryRunReceiptV2({
        principal: actor.principal,
        producerRunId,
        idempotencyKey: fixture.idempotencyKey,
        receipt: fixture.receipt,
        now: NOW,
      });
      const candidateId = accepted.candidate_results[0]!.candidate_id;
      expect(validateMemoryCandidate(candidateId, 1)).toMatchObject({
        current_status: "pending_review",
        activation_requirement: "authorized_review",
      });
      const storedCandidate = JSON.parse((db.prepare(
        "SELECT candidate_json FROM memory_candidates_v1 WHERE candidate_id = ?",
      ).get(candidateId) as { candidate_json: string }).candidate_json);
      expect(storedCandidate.validation).toEqual({ strategy: "policy_owner_review" });

      const approved = decideHarnessMemoryCandidateV2({
        principal: reviewer,
        candidateId,
        decision: decision({
          resourceRowId: actor.binding.resource_row_id,
          evidenceRefId: fixture.evidenceRefIds[0],
        }),
        now: NOW,
      });
      expect(approved).toMatchObject({
        candidate_status: "active",
        active_record: { record_version: 1 },
      });
      const provenance = JSON.parse((db.prepare(
        `SELECT provenance_json FROM memory_record_versions
         WHERE record_id = ? AND record_version = ?`,
      ).get(
        approved.active_record!.record_id,
        approved.active_record!.record_version,
      ) as { provenance_json: string }).provenance_json);
      expect(provenance).toMatchObject({
        v2_validation_strategy: validationStrategy,
        failure_fingerprint: null,
        runtime_origin_ids: validationStrategy === "runtime_attestation"
          ? [expect.any(String)]
          : [],
      });
      assertMemoryV2StoredCandidateFacet(candidateId);
      assertMemoryV2StoredRecordFacet({
        recordId: approved.active_record!.record_id,
        recordVersion: approved.active_record!.record_version,
      });
    },
  );

  it("persists and replays feedback-only receipts against the exact native retrieval pack item", async () => {
    const actor = authority("Slice 3 feedback-only producer");
    const reviewer = verifyMemoryV2ServiceToken(context.harnessReviewerTokenA)!.authorization;
    const seedRun = `run-${marker("feedback-seed")}`;
    const seed = harnessWriteFixture({
      marker: marker("feedback-seed-fixture"),
      producerRunId: seedRun,
      projectId: context.projectA,
      resourceBinding: actor.binding,
      subtype: "tool_constraint",
    });
    const seeded = await submitHarnessMemoryRunReceiptV2({
      principal: actor.principal,
      producerRunId: seedRun,
      idempotencyKey: seed.idempotencyKey,
      receipt: seed.receipt,
      now: NOW,
    });
    const seedCandidateId = seeded.candidate_results[0]!.candidate_id;
    validateMemoryCandidate(seedCandidateId, 1);
    const activated = decideHarnessMemoryCandidateV2({
      principal: reviewer,
      candidateId: seedCandidateId,
      decision: decision({
        resourceRowId: actor.binding.resource_row_id,
        evidenceRefId: seed.evidenceRefIds[0],
      }),
      now: NOW,
    }).active_record!;

    const search = await searchHarnessMemoryV2({
      principal: actor.principal,
      request: searchRequest(`feedback-pack-${marker("search")}`, actor.binding),
      dependencies: { now: () => new Date(NOW) },
    });
    const retrieved = search.items.find((item) => item.record_id === activated.record_id)!;
    expect(retrieved).toBeDefined();

    const feedbackRun = `run-${marker("feedback-only")}`;
    const feedbackFixture = harnessWriteFixture({
      marker: marker("feedback-only-fixture"),
      producerRunId: feedbackRun,
      projectId: context.projectA,
      resourceBinding: actor.binding,
      includeCandidate: false,
    });
    feedbackFixture.receipt.retrieval_feedback = [{
      retrieval_pack_id: search.retrieval_pack_id,
      scope_snapshot_digest: search.scope_snapshot_digest,
      record_id: retrieved.record_id,
      record_version: retrieved.record_version,
      disposition: "helpful",
      reason_code: "prevented_duplicate_retry",
    }];
    const accepted = await submitHarnessMemoryRunReceiptV2({
      principal: actor.principal,
      producerRunId: feedbackRun,
      idempotencyKey: feedbackFixture.idempotencyKey,
      receipt: feedbackFixture.receipt,
      now: NOW,
    });
    expect(accepted).toMatchObject({ candidate_results: [], duplicate: false });
    expect(producerEffects(feedbackRun)).toEqual({ receipts: 1, snapshots: 1, origins: 0 });
    const binding = db.prepare(
      `SELECT producer_principal_id, retrieval_pack_id, record_id, record_version,
              plane, resource_row_id, scope_snapshot_digest, feedback_json,
              feedback_digest, response_json
       FROM memory_v2_feedback_bindings WHERE receipt_id = ?`,
    ).get(accepted.receipt_id) as Record<string, unknown>;
    expect(binding).toMatchObject({
      producer_principal_id: actor.principal.servicePrincipalId,
      retrieval_pack_id: search.retrieval_pack_id,
      record_id: retrieved.record_id,
      record_version: retrieved.record_version,
      plane: "harness",
      resource_row_id: actor.binding.resource_row_id,
      scope_snapshot_digest: search.scope_snapshot_digest,
      feedback_digest: canonicalJsonSha256(feedbackFixture.receipt.retrieval_feedback[0]!),
    });
    expect(JSON.parse(binding.feedback_json as string)).toEqual(
      feedbackFixture.receipt.retrieval_feedback[0],
    );
    expect(JSON.parse(binding.response_json as string)).toEqual(accepted);

    const replayed = await submitHarnessMemoryRunReceiptV2({
      principal: actor.principal,
      producerRunId: feedbackRun,
      idempotencyKey: feedbackFixture.idempotencyKey,
      receipt: feedbackFixture.receipt,
      now: NOW,
    });
    expect(replayed).toMatchObject({
      receipt_id: accepted.receipt_id,
      request_digest: accepted.request_digest,
      candidate_results: [],
      duplicate: true,
      status: "replayed",
    });

    const changed = structuredClone(feedbackFixture.receipt);
    changed.retrieval_feedback[0]!.disposition = "harmful";
    await expect(submitHarnessMemoryRunReceiptV2({
      principal: actor.principal,
      producerRunId: feedbackRun,
      idempotencyKey: feedbackFixture.idempotencyKey,
      receipt: changed,
      now: NOW,
    })).rejects.toMatchObject({ statusCode: 409, code: "idempotency_conflict" });
  });

  it("keeps legacy keys stable while native semantic selectors exclude projection identities", () => {
    const legacy = {
      kind: "constraint" as const,
      content: {
        summary: "Retry only after resolving the original provider event.",
        details: "The migrated harness lesson keeps its normalized v1 claim identity unchanged.",
        rationale: "An ambiguous retry can repeat an already completed side effect.",
      },
      applicability: {
        harness_id: "example-harness-a",
        workflow_version_range: "code-change.v3",
        configuration_ids: ["routing-default-v2"],
      },
      provenance: { extractor_version: "migrated-v1-extractor" },
    };
    const legacyKey = canonicalHarnessMemoryClaimKey(legacy);
    expect(canonicalHarnessMemoryClaimKey({
      ...legacy,
      provenance: {
        extractor_version: "migrated-v1-extractor",
        legacy_import_id: "legacy-import-metadata-does-not-change-the-claim",
      },
    })).toBe(legacyKey);

    const configurationDigest = canonicalJsonSha256({ configuration: "semantic-selector" });
    const nativeKey = canonicalHarnessMemoryClaimKey({
      ...legacy,
      subtype: "tool_constraint",
      configurationDigests: [configurationDigest],
      provenance: {
        extractor_version: "migrated-v1-extractor",
        candidate_id: "candidate-native-a",
        v2_subtype: "tool_constraint",
        v2_projection_digest: canonicalJsonSha256({ projection: "native-a" }),
      },
    });
    expect(nativeKey).not.toBe(legacyKey);
    expect(canonicalHarnessMemoryClaimKey({
      ...legacy,
      subtype: "tool_constraint",
      configurationDigests: [configurationDigest],
      provenance: {
        extractor_version: "migrated-v1-extractor",
        candidate_id: "candidate-native-b",
        v2_subtype: "tool_constraint",
        v2_projection_digest: canonicalJsonSha256({ projection: "native-b" }),
      },
    })).toBe(nativeKey);
    expect(canonicalHarnessMemoryClaimKey({
      ...legacy,
      subtype: "escalation_requirement",
      configurationDigests: [configurationDigest],
      provenance: { extractor_version: "migrated-v1-extractor" },
    })).not.toBe(nativeKey);
    expect(canonicalHarnessMemoryClaimKey({
      ...legacy,
      subtype: "tool_constraint",
      configurationDigests: [],
      provenance: { extractor_version: "migrated-v1-extractor" },
    })).not.toBe(nativeKey);
  });

  it("converges two identity-distinct native receipts with the same semantic lesson", async () => {
    const actor = authority("Slice 3 semantic convergence producer");
    const reviewer = verifyMemoryV2ServiceToken(context.harnessReviewerTokenA)!.authorization;
    const claimMarker = marker("shared-semantic-claim");
    const fixtures = ["first", "second"].map((identity) => {
      const producerRunId = `run-${marker(`converge-${identity}`)}`;
      return harnessWriteFixture({
        marker: marker(`converge-${identity}-fixture`),
        claimMarker,
        producerRunId,
        projectId: context.projectA,
        resourceBinding: actor.binding,
        subtype: "tool_constraint",
        configurationDigests: "exact",
      });
    });
    const activated: Array<{ record_id: string; record_version: number }> = [];
    const candidateIds: string[] = [];

    for (const [index, fixture] of fixtures.entries()) {
      const accepted = await submitHarnessMemoryRunReceiptV2({
        principal: actor.principal,
        producerRunId: fixture.producerRunId,
        idempotencyKey: fixture.idempotencyKey,
        receipt: fixture.receipt,
        now: NOW,
      });
      const candidateId = accepted.candidate_results[0]!.candidate_id;
      candidateIds.push(candidateId);
      validateMemoryCandidate(candidateId, 1);
      activated.push(decideHarnessMemoryCandidateV2({
        principal: reviewer,
        candidateId,
        decision: decision({
          resourceRowId: actor.binding.resource_row_id,
          evidenceRefId: fixture.evidenceRefIds[0],
        }),
        now: NOW,
      }).active_record!);
      if (index === 0) {
        const first = activated[0]!;
        expect(first.record_version).toBe(1);
        const source = db.prepare(
          `SELECT provenance_json FROM memory_record_versions
           WHERE record_id = ? AND record_version = 1`,
        ).get(first.record_id) as { provenance_json: string };
        const provenance = JSON.parse(source.provenance_json) as Record<string, unknown>;
        provenance.v2_projection_digest = memoryV2NativeHarnessRecordProjectionDigest({
          candidateId: candidateId,
          recordId: first.record_id,
          recordVersion: 2,
          resourceRowId: actor.binding.resource_row_id,
          subtype: "tool_constraint",
          scopeSnapshotDigest: provenance.scope_snapshot_digest as string,
          runtimeOriginIds: provenance.runtime_origin_ids as string[],
          corroborationDomainIds: provenance.v2_corroboration_domain_ids as string[],
          distinctCorroborationDomainCount:
            provenance.v2_distinct_corroboration_domain_count as number,
          scopeConfigurationDigest: provenance.v2_scope_configuration_digest as string,
          configurationDigests: provenance.v2_configuration_digests as string[],
          runtimeEvidenceDigest: provenance.runtime_evidence_digest as string,
        });
        withImmediateTransaction(() => {
          db.prepare(
            `INSERT INTO memory_record_versions (
               record_id, record_version, content_json, applicability_json, exceptions_json,
               compatibility_json, validation_json, evidence_json, evidence_summary_json,
               freshness_json, provenance_json, embedding_json, content_digest, recorded_at
             )
             SELECT record_id, 2, content_json, applicability_json, exceptions_json,
                    compatibility_json, validation_json, evidence_json, evidence_summary_json,
                    freshness_json, ?, embedding_json, content_digest, ?
             FROM memory_record_versions WHERE record_id = ? AND record_version = 1`,
          ).run(JSON.stringify(provenance), NOW, first.record_id);
          db.prepare(
            `INSERT INTO memory_v2_record_facets (
               record_id, record_version, org_id, project_id, plane, resource_row_id,
               broad_kind, subtype, projection_status, facet_json, created_at
             )
             SELECT record_id, 2, org_id, project_id, plane, resource_row_id,
                    broad_kind, subtype, projection_status, facet_json, ?
             FROM memory_v2_record_facets WHERE record_id = ? AND record_version = 1`,
          ).run(NOW, first.record_id);
          db.prepare(
            `UPDATE memory_records
             SET current_version = 2, aggregate_version = aggregate_version + 1, updated_at = ?
             WHERE record_id = ? AND current_version = 1`,
          ).run(NOW, first.record_id);
          db.prepare(
            `UPDATE memory_candidates_v1 SET active_record_version = 2
             WHERE candidate_id = ? AND active_record_id = ? AND active_record_version = 1`,
          ).run(candidateId, first.record_id);
        });
        assertMemoryV2StoredRecordFacet({ recordId: first.record_id, recordVersion: 2 });
      }
    }

    expect(fixtures[0]!.producerRunId).not.toBe(fixtures[1]!.producerRunId);
    expect(fixtures[0]!.clientCandidateId).not.toBe(fixtures[1]!.clientCandidateId);
    expect(candidateIds[0]).not.toBe(candidateIds[1]);
    expect(activated[1]).toEqual({
      record_id: activated[0]!.record_id,
      record_version: 2,
    });
    expect(getMemoryCandidateStatus(context.orgA.id, context.projectA, candidateIds[1]!))
      .toMatchObject({
        status: "active",
        active_record: activated[1],
      });

    const currentRecordId = activated[0]!.record_id;
    db.prepare(
      "UPDATE memory_candidates_v1 SET active_record_id = 'mem_wrong_record' WHERE candidate_id = ?",
    ).run(candidateIds[0]);
    expect(() => assertMemoryV2StoredRecordFacet({
      recordId: currentRecordId,
      recordVersion: 1,
    })).toThrow(/activated source candidate/);
    db.prepare(
      `UPDATE memory_candidates_v1 SET active_record_id = ?, active_record_version = 2
       WHERE candidate_id = ?`,
    ).run(currentRecordId, candidateIds[0]);

    db.prepare(
      "UPDATE memory_candidates_v1 SET active_record_version = 1 WHERE candidate_id = ?",
    ).run(candidateIds[0]);
    expect(() => assertMemoryV2StoredRecordFacet({
      recordId: currentRecordId,
      recordVersion: 1,
    })).toThrow(/activated source candidate/);
    db.prepare(
      "UPDATE memory_candidates_v1 SET active_record_version = 2 WHERE candidate_id = ?",
    ).run(candidateIds[0]);

    let futureVersionError: unknown;
    expect(() => withImmediateTransaction(() => {
      const source = db.prepare(
        `SELECT provenance_json FROM memory_record_versions
         WHERE record_id = ? AND record_version = 2`,
      ).get(currentRecordId) as { provenance_json: string };
      const provenance = JSON.parse(source.provenance_json) as Record<string, unknown>;
      provenance.v2_projection_digest = memoryV2NativeHarnessRecordProjectionDigest({
        candidateId: candidateIds[0]!,
        recordId: currentRecordId,
        recordVersion: 3,
        resourceRowId: actor.binding.resource_row_id,
        subtype: "tool_constraint",
        scopeSnapshotDigest: provenance.scope_snapshot_digest as string,
        runtimeOriginIds: provenance.runtime_origin_ids as string[],
        corroborationDomainIds: provenance.v2_corroboration_domain_ids as string[],
        distinctCorroborationDomainCount:
          provenance.v2_distinct_corroboration_domain_count as number,
        scopeConfigurationDigest: provenance.v2_scope_configuration_digest as string,
        configurationDigests: provenance.v2_configuration_digests as string[],
        runtimeEvidenceDigest: provenance.runtime_evidence_digest as string,
      });
      db.prepare(
        `INSERT INTO memory_record_versions (
           record_id, record_version, content_json, applicability_json, exceptions_json,
           compatibility_json, validation_json, evidence_json, evidence_summary_json,
           freshness_json, provenance_json, embedding_json, content_digest, recorded_at
         )
         SELECT record_id, 3, content_json, applicability_json, exceptions_json,
                compatibility_json, validation_json, evidence_json, evidence_summary_json,
                freshness_json, ?, embedding_json, content_digest, ?
         FROM memory_record_versions WHERE record_id = ? AND record_version = 2`,
      ).run(JSON.stringify(provenance), NOW, currentRecordId);
      db.prepare(
        `INSERT INTO memory_v2_record_facets (
           record_id, record_version, org_id, project_id, plane, resource_row_id,
           broad_kind, subtype, projection_status, facet_json, created_at
         )
         SELECT record_id, 3, org_id, project_id, plane, resource_row_id,
                broad_kind, subtype, projection_status, facet_json, ?
         FROM memory_v2_record_facets WHERE record_id = ? AND record_version = 2`,
      ).run(NOW, currentRecordId);
      try {
        assertMemoryV2StoredRecordFacet({ recordId: currentRecordId, recordVersion: 3 });
      } catch (error) {
        futureVersionError = error;
      }
      throw new Error("rollback future record version fixture");
    })).toThrow("rollback future record version fixture");
    expect(futureVersionError).toEqual(expect.objectContaining({
      message: expect.stringMatching(/activated source candidate/),
    }));
    expect(db.prepare(
      "SELECT 1 FROM memory_record_versions WHERE record_id = ? AND record_version = 3",
    ).get(currentRecordId)).toBeUndefined();
    assertMemoryV2StoredRecordFacet({ recordId: currentRecordId, recordVersion: 1 });
    assertMemoryV2StoredRecordFacet({ recordId: currentRecordId, recordVersion: 2 });
  });

  it("keeps exact and empty configuration selectors separate through native activation and detail", async () => {
    const actor = authority("Slice 5 configuration selector producer");
    const reviewer = verifyMemoryV2ServiceToken(context.harnessReviewerTokenA)!.authorization;
    const searchPrincipal = verifyMemoryV2ServiceToken(context.harnessSearchTokenA)!.authorization;
    const fixtures = ["exact", "empty"].map((configurationDigests) => {
      const producerRunId = `run-${marker(`selector-${configurationDigests}`)}`;
      return harnessWriteFixture({
        marker: marker(`selector-${configurationDigests}-fixture`),
        producerRunId,
        projectId: context.projectA,
        resourceBinding: actor.binding,
        configurationDigests: configurationDigests as "exact" | "empty",
      });
    });
    const activated: Array<{ recordId: string; configurationDigest: string }> = [];

    for (const fixture of fixtures) {
      const accepted = await submitHarnessMemoryRunReceiptV2({
        principal: actor.principal,
        producerRunId: fixture.producerRunId,
        idempotencyKey: fixture.idempotencyKey,
        receipt: fixture.receipt,
        now: NOW,
      });
      const candidateId = accepted.candidate_results[0]!.candidate_id;
      expect(validateMemoryCandidate(candidateId, 1)).toMatchObject({
        current_status: "pending_review",
      });
      const approved = decideHarnessMemoryCandidateV2({
        principal: reviewer,
        candidateId,
        decision: decision({
          resourceRowId: actor.binding.resource_row_id,
          evidenceRefId: fixture.evidenceRefIds[0]!,
        }),
        now: NOW,
      });
      const recordId = approved.active_record!.record_id;
      expect(recordId).toBe(`mem_${candidateId.slice("candidate_".length)}`);
      activated.push({ recordId, configurationDigest: fixture.configurationDigest });
    }

    expect(activated[0]!.recordId).not.toBe(activated[1]!.recordId);
    const exact = getHarnessMemoryRecordV2({
      principal: searchPrincipal,
      recordId: activated[0]!.recordId,
      recordVersion: 1,
    });
    const empty = getHarnessMemoryRecordV2({
      principal: searchPrincipal,
      recordId: activated[1]!.recordId,
      recordVersion: 1,
    });
    expect(exact.applicability).toMatchObject({
      configuration_digests: [activated[0]!.configurationDigest],
    });
    expect(empty.applicability).toMatchObject({ configuration_digests: [] });

    const emptyProvenance = JSON.parse((db.prepare(
      `SELECT provenance_json FROM memory_record_versions
       WHERE record_id = ? AND record_version = 1`,
    ).get(activated[1]!.recordId) as { provenance_json: string }).provenance_json);
    expect(emptyProvenance).toMatchObject({
      v2_scope_configuration_digest: activated[1]!.configurationDigest,
      v2_configuration_digests: [],
    });
    const claimKeys = activated.map((item) => (db.prepare(
      "SELECT claim_key FROM memory_records WHERE record_id = ?",
    ).get(item.recordId) as { claim_key: string }).claim_key);
    expect(claimKeys[0]).not.toBe(claimKeys[1]);
  });

  it("maps a native activation record-id conflict to the bounded decision surface", async () => {
    const actor = authority("Slice 5 bounded decision conflict producer");
    const producerRunId = `run-${marker("bounded-conflict")}`;
    const fixture = harnessWriteFixture({
      marker: marker("bounded-conflict-fixture"),
      producerRunId,
      projectId: context.projectA,
      resourceBinding: actor.binding,
    });
    const accepted = await submitHarnessMemoryRunReceiptV2({
      principal: actor.principal,
      producerRunId,
      idempotencyKey: fixture.idempotencyKey,
      receipt: fixture.receipt,
      now: NOW,
    });
    const candidateId = accepted.candidate_results[0]!.candidate_id;
    expect(validateMemoryCandidate(candidateId, 1)).toMatchObject({
      current_status: "pending_review",
    });
    const collidingRecordId = `mem_${candidateId.slice("candidate_".length)}`;
    importActiveHarnessMemoryRecord({
      orgId: context.orgA.id,
      projectId: context.projectA,
      recordId: collidingRecordId,
      kind: "anti_pattern",
      content: {
        summary: "A deliberately colliding migrated harness record.",
        details: "This fixture reserves the deterministic record identifier with different immutable content.",
        rationale: "The v2 decision adapter must return a bounded conflict instead of leaking a raw error.",
      },
      applicability: {
        harness_id: "example-harness-a",
        workflow_version_range: "code-change.v3",
      },
      exceptions: ["This collision exists only inside the decision adapter regression test."],
      compatibility: {
        harness_version_range: "7b6e858",
        workflow_version_range: "code-change.v3",
        adapter_version_range: "example-harness-a-pim-adapter.v2",
      },
      validation: {
        strategy: "stable_failure_fingerprint",
        failure_fingerprint: "legacy-record-id-collision",
      },
      evidence: [{
        evidence_ref_id: "legacy-collision-evidence",
        type: "authorized_review",
        digest: canonicalJsonSha256({ evidence: "legacy-collision" }),
        origin_id: "legacy-collision-origin",
        source_authority: "authorized_review",
      }],
      evidenceSummary: { strength: "reviewed", ref_count: 1 },
      freshness: { last_confirmed_at: NOW, expires_at: null },
      provenance: { extractor_version: "migrated-v1-collision-fixture" },
      actorId: "slice5-conflict-fixture",
      decisionRefs: ["legacy-collision-decision"],
      reasonCode: "legacy_collision_fixture",
      explanation: "Reserve the native deterministic record identifier for bounded-error coverage.",
      now: NOW,
    });
    const reviewer = verifyMemoryV2ServiceToken(context.harnessReviewerTokenA)!.authorization;
    expect(() => decideHarnessMemoryCandidateV2({
      principal: reviewer,
      candidateId,
      decision: decision({
        resourceRowId: actor.binding.resource_row_id,
        evidenceRefId: fixture.evidenceRefIds[0]!,
      }),
      now: NOW,
    })).toThrow(expect.objectContaining({
      statusCode: 409,
      code: "idempotency_conflict",
    }));
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM memory_candidate_decisions WHERE candidate_id = ?",
    ).get(candidateId)).toEqual({ count: 0 });
    expect(getMemoryCandidateStatus(context.orgA.id, context.projectA, candidateId)).toMatchObject({
      status: "pending_review",
    });
    expect(db.prepare(
      `SELECT active_record_id, active_record_version FROM memory_candidates_v1
       WHERE candidate_id = ?`,
    ).get(candidateId)).toEqual({ active_record_id: null, active_record_version: null });
  });

  it.each(["tool_constraint", "escalation_requirement"] as const)(
    "keeps native %s mapped across fresh activation, replay assertions, and startup",
    async (subtype) => {
      const actor = authority(`Slice 5 ${subtype} producer`);
      const producerRunId = `run-${marker(subtype)}`;
      const fixture = harnessWriteFixture({
        marker: marker(`${subtype}-fixture`),
        producerRunId,
        projectId: context.projectA,
        resourceBinding: actor.binding,
        subtype,
        activationRequirement: "authorized_review",
      });
      const accepted = await submitHarnessMemoryRunReceiptV2({
        principal: actor.principal,
        producerRunId,
        idempotencyKey: fixture.idempotencyKey,
        receipt: fixture.receipt,
        now: NOW,
      });
      const candidateId = accepted.candidate_results[0]!.candidate_id;
      validateMemoryCandidate(candidateId, 1);
      const reviewer = verifyMemoryV2ServiceToken(context.harnessReviewerTokenA)!.authorization;
      const approved = decideHarnessMemoryCandidateV2({
        principal: reviewer,
        candidateId,
        decision: decision({
          resourceRowId: actor.binding.resource_row_id,
          evidenceRefId: fixture.evidenceRefIds[0]!,
        }),
        now: NOW,
      });
      const recordId = approved.active_record!.record_id;
      assertMemoryV2StoredCandidateFacet(candidateId);
      assertMemoryV2StoredRecordFacet({ recordId, recordVersion: 1 });
      expect((db.prepare(
        "SELECT subtype, projection_status FROM memory_v2_record_facets WHERE record_id = ?",
      ).get(recordId))).toEqual({ subtype, projection_status: "mapped" });
      const startup = reconcileMemoryV2CanonicalFacets();
      if (!startup.ok) throw new Error(JSON.stringify(startup));
    },
  );

  it("rejects runtime evidence appended after the receipt idempotency claim is finalized", async () => {
    const actor = authority("Slice 5 finalized evidence producer");
    const producerRunId = `run-${marker("finalized")}`;
    const fixture = harnessWriteFixture({
      marker: marker("finalized-fixture"),
      producerRunId,
      projectId: context.projectA,
      resourceBinding: actor.binding,
    });
    const accepted = await submitHarnessMemoryRunReceiptV2({
      principal: actor.principal,
      producerRunId,
      idempotencyKey: fixture.idempotencyKey,
      receipt: fixture.receipt,
      now: NOW,
    });
    const candidateId = accepted.candidate_results[0]!.candidate_id;
    const effectsBefore = producerEffects(producerRunId);
    const extraRef = `runtime-extra-${marker("finalized")}`;
    const extraHandle: HarnessRuntimeEvidenceHandleV2 = {
      ...fixture.receipt.evidence_handles[0]!,
      evidence_ref_id: extraRef,
      provider_event_id: `runtime-event-extra-${marker("finalized")}`,
      immutable_digest: canonicalJsonSha256({ extraRef }),
      derivation_parent_refs: [],
    };
    await expect(resolveMemoryRuntimeAttestation({
      auth: {
        orgId: actor.principal.orgId,
        projectId: actor.principal.projectId!,
        resourceRowId: actor.binding.resource_row_id,
        producerPrincipalId: actor.principal.servicePrincipalId,
        producerRunId,
        evidenceRefId: extraRef,
        clientCandidateIds: [fixture.clientCandidateId],
      },
      handle: extraHandle,
      receiptId: accepted.receipt_id,
      candidateBindings: [{ clientCandidateId: fixture.clientCandidateId, candidateId }],
      parentOriginsByEvidenceRef: new Map(),
      now: NOW,
    })).rejects.toMatchObject({ statusCode: 409, code: "idempotency_conflict" });
    expect(producerEffects(producerRunId)).toEqual(effectsBefore);
    expect(getHarnessMemoryCandidateStatusV2({
      principal: actor.principal,
      candidateId,
      resourceSelector: { resource_row_id: actor.binding.resource_row_id },
      receiptId: accepted.receipt_id,
      producerRunId,
    })).toMatchObject({ status: "accepted", active_record: null });
    expect(reconcileMemoryV2CanonicalFacets().ok).toBe(true);
  });

  it("preserves rejected native candidate history only behind its governed runtime-evidence tombstone", async () => {
    const actor = authority("Slice 5 retained terminal evidence producer");
    const producerRunId = `run-${marker("retained-terminal")}`;
    const fixture = harnessWriteFixture({
      marker: marker("retained-terminal-fixture"),
      producerRunId,
      projectId: context.projectA,
      resourceBinding: actor.binding,
    });
    const accepted = await submitHarnessMemoryRunReceiptV2({
      principal: actor.principal,
      producerRunId,
      idempotencyKey: fixture.idempotencyKey,
      receipt: fixture.receipt,
      now: NOW,
    });
    const candidateId = accepted.candidate_results[0]!.candidate_id;
    expect(validateMemoryCandidate(candidateId, 1)).toMatchObject({
      current_status: "pending_review",
    });
    const reviewer = verifyMemoryV2ServiceToken(context.harnessReviewerTokenA)!.authorization;
    const rejection = parseMemoryContractV2("MemoryCandidateDecisionV2", {
      ...decision({
        resourceRowId: actor.binding.resource_row_id,
        evidenceRefId: fixture.evidenceRefIds[0]!,
      }),
      decision: "reject",
      reason_code: "runtime_evidence_not_reusable",
      explanation: "The reviewed runtime failure should remain terminal history without activation.",
    });
    expect(decideHarnessMemoryCandidateV2({
      principal: reviewer,
      candidateId,
      decision: rejection,
      now: NOW,
    })).toMatchObject({ candidate_status: "rejected", active_record: null });

    createMemoryRetentionPolicyVersion({
      orgId: context.orgA.id,
      projectId: context.projectA,
      dataClass: "evidence",
      retentionDays: 0,
      actorId: "slice5-native-retention-admin",
      reasonCode: "native_runtime_evidence_expired",
      effectiveAt: "2026-08-10T13:00:00.000Z",
      now: "2026-08-10T13:00:00.000Z",
    });
    const plan = planMemoryRetention({
      orgId: context.orgA.id,
      projectId: context.projectA,
      dataClass: "evidence",
      actorId: "slice5-native-retention-admin",
      reasonCode: "native_runtime_evidence_expired",
      now: "2026-08-10T14:00:00.000Z",
      backupRetentionDays: 0,
    });
    const runtimeResourceId = `memory_v2_runtime_receipt:${accepted.receipt_id}`;
    expect(plan.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        resource_class: "evidence",
        resource_id: runtimeResourceId,
        action: "physical_delete",
      }),
    ]));
    applyMemoryErasurePlan({
      plan,
      expectedPlanDigest: plan.plan_digest,
      downtimeConfirmed: true,
      compact: false,
      now: "2026-08-10T14:00:00.000Z",
    });
    expect(db.prepare(
      "SELECT 1 FROM memory_v2_origins WHERE receipt_id = ?",
    ).get(accepted.receipt_id)).toBeUndefined();
    const tombstone = db.prepare(
      `SELECT tombstone_id FROM memory_erasure_tombstones
       WHERE resource_class = 'evidence' AND resource_id = ?
         AND erasure_method = 'physical_delete'`,
    ).get(runtimeResourceId) as { tombstone_id: string };
    expect(tombstone.tombstone_id).toBeTruthy();
    expect(getHarnessMemoryCandidateStatusV2({
      principal: actor.principal,
      candidateId,
      resourceSelector: { resource_row_id: actor.binding.resource_row_id },
      receiptId: accepted.receipt_id,
      producerRunId,
    })).toMatchObject({ status: "rejected", active_record: null });
    expect(reconcileMemoryV2CanonicalFacets().ok).toBe(true);

    expect(() => withImmediateTransaction(() => {
      db.prepare(
        "UPDATE memory_candidates_v1 SET current_status = 'pending_review' WHERE candidate_id = ?",
      ).run(candidateId);
      expect(() => getHarnessMemoryCandidateStatusV2({
        principal: actor.principal,
        candidateId,
        resourceSelector: { resource_row_id: actor.binding.resource_row_id },
        receiptId: accepted.receipt_id,
        producerRunId,
      })).toThrow();
      expect(reconcileMemoryV2CanonicalFacets().ok).toBe(false);
      throw new Error("rollback-nonterminal-retention-probe");
    })).toThrow("rollback-nonterminal-retention-probe");

    expect(() => withImmediateTransaction(() => {
      db.exec("DROP TRIGGER memory_erasure_tombstones_no_delete");
      db.prepare(
        "DELETE FROM memory_erasure_tombstones WHERE tombstone_id = ?",
      ).run(tombstone.tombstone_id);
      expect(() => getHarnessMemoryCandidateStatusV2({
        principal: actor.principal,
        candidateId,
        resourceSelector: { resource_row_id: actor.binding.resource_row_id },
        receiptId: accepted.receipt_id,
        producerRunId,
      })).toThrow();
      expect(reconcileMemoryV2CanonicalFacets().ok).toBe(false);
      throw new Error("rollback-missing-tombstone-probe");
    })).toThrow("rollback-missing-tombstone-probe");

    expect(db.prepare(
      "SELECT 1 FROM memory_erasure_tombstones WHERE tombstone_id = ?",
    ).get(tombstone.tombstone_id)).toBeTruthy();
    expect(getHarnessMemoryCandidateStatusV2({
      principal: actor.principal,
      candidateId,
      resourceSelector: { resource_row_id: actor.binding.resource_row_id },
      receiptId: accepted.receipt_id,
      producerRunId,
    })).toMatchObject({ status: "rejected", active_record: null });
    expect(reconcileMemoryV2CanonicalFacets().ok).toBe(true);
  });

  it("fails live status and activation closed on self-digesting deep-origin corruption", async () => {
    const actor = authority("Slice 5 deep closure corruption producer");
    const producerRunId = `run-${marker("deep-closure")}`;
    const fixture = harnessWriteFixture({
      marker: marker("deep-closure-fixture"),
      producerRunId,
      projectId: context.projectA,
      resourceBinding: actor.binding,
    });
    const accepted = await submitHarnessMemoryRunReceiptV2({
      principal: actor.principal,
      producerRunId,
      idempotencyKey: fixture.idempotencyKey,
      receipt: fixture.receipt,
      now: NOW,
    });
    const candidateId = accepted.candidate_results[0]!.candidate_id;
    expect(validateMemoryCandidate(candidateId, 1)).toMatchObject({
      current_status: "pending_review",
    });
    const origin = db.prepare(
      `SELECT origin_id, resolution_json, resolution_digest
       FROM memory_v2_origins WHERE receipt_id = ? ORDER BY evidence_ref_id LIMIT 1`,
    ).get(accepted.receipt_id) as {
      origin_id: string;
      resolution_json: string;
      resolution_digest: string;
    };
    const guard = db.prepare(
      `SELECT sql FROM sqlite_schema
       WHERE type = 'trigger' AND name = 'memory_v2_origins_no_update'`,
    ).get() as { sql: string };
    const updateResolution = (resolutionJson: string, resolutionDigest: string): void => {
      db.exec("DROP TRIGGER memory_v2_origins_no_update");
      try {
        db.prepare(
          `UPDATE memory_v2_origins SET resolution_json = ?, resolution_digest = ?
           WHERE origin_id = ?`,
        ).run(resolutionJson, resolutionDigest, origin.origin_id);
      } finally {
        db.exec(guard.sql);
      }
    };
    const corruptedResolution = {
      ...(JSON.parse(origin.resolution_json) as Record<string, unknown>),
      provider_identity: `corrupted:${marker("provider")}`,
    };
    updateResolution(
      JSON.stringify(corruptedResolution),
      canonicalJsonSha256(corruptedResolution),
    );

    expect(() => getHarnessMemoryCandidateStatusV2({
      principal: actor.principal,
      candidateId,
      resourceSelector: { resource_row_id: actor.binding.resource_row_id },
      receiptId: accepted.receipt_id,
      producerRunId,
    })).toThrow();
    const reviewer = verifyMemoryV2ServiceToken(context.harnessReviewerTokenA)!.authorization;
    expect(() => decideHarnessMemoryCandidateV2({
      principal: reviewer,
      candidateId,
      decision: decision({
        resourceRowId: actor.binding.resource_row_id,
        evidenceRefId: fixture.evidenceRefIds[0]!,
      }),
      now: NOW,
    })).toThrow();
    expect(db.prepare(
      `SELECT current_status, active_record_id, active_record_version
       FROM memory_candidates_v1 WHERE candidate_id = ?`,
    ).get(candidateId)).toEqual({
      current_status: "pending_review",
      active_record_id: null,
      active_record_version: null,
    });
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM memory_candidate_decisions WHERE candidate_id = ?",
    ).get(candidateId)).toEqual({ count: 0 });
    expect(reconcileMemoryV2CanonicalFacets().ok).toBe(false);

    updateResolution(origin.resolution_json, origin.resolution_digest);
    expect(getHarnessMemoryCandidateStatusV2({
      principal: actor.principal,
      candidateId,
      resourceSelector: { resource_row_id: actor.binding.resource_row_id },
      receiptId: accepted.receipt_id,
      producerRunId,
    })).toMatchObject({ status: "pending_review", active_record: null });
    expect(reconcileMemoryV2CanonicalFacets().ok).toBe(true);
  });
});
