import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  canonicalJsonSha256,
  MEMORY_CONTRACT_FIXTURES,
  MEMORY_CONTRACT_FIXTURES_V2,
  type CodebaseMemorySearchV2,
  type MemorySearchV1,
  type ResourceBindingV2,
} from "@pim/shared";
import db from "../../db/connection.js";
import {
  getMemoryRecord,
  importActiveMemoryRecord,
  transitionMemoryRecordStatus,
} from "../memory-records.js";
import {
  getCodeMemoryRecordHistoryV2,
  getCodeMemoryRecordV2,
  searchCodeMemoryV2,
} from "../memory-v2-code-read.js";
import {
  getHarnessMemoryRecordV2,
} from "../memory-v2-harness-read.js";
import {
  importActiveHarnessMemoryRecord,
  listCurrentHarnessMemoryRecords,
} from "../memory-harness-records.js";
import { executeMemorySearch } from "../memory-search.js";
import { resolveMemoryRepository } from "../memory-repository-registry.js";
import { resolveMemoryV2Resource } from "../memory-v2-resources.js";
import {
  createMemoryV2ReverificationPolicy,
  getMemoryV2ReverificationHealth,
  getMemoryV2Readiness,
  MemoryV2ReverificationError,
  runMemoryV2ReverificationPass,
  scheduleDueMemoryV2Reverifications,
  type MemoryV2Plane,
  type MemoryV2ReverificationCommitStage,
  type MemoryV2ReverificationProvider,
  type MemoryV2ReverificationProviderResult,
} from "../memory-v2-reverification.js";
import {
  verifyMemoryV2ServiceToken,
  type MemoryV2RequestAuthorizationSnapshot,
} from "../service-tokens.js";
import {
  createMemoryTestContext,
  type MemoryTestContext,
} from "../../routes/__tests__/memory-test-app.js";
import {
  ensureMemoryV2EvidenceVerifiedTrust,
  getMemoryV2RecordTrust,
} from "../memory-v2-trust.js";

const PASS_NOW = "2026-08-10T12:00:00.000Z";
const LAST_VERIFIED = "2025-08-10T12:00:00.000Z";
const YEAR_SECONDS = 31_536_000;
const EVIDENCE_DIGEST = canonicalJsonSha256({ fixture: "slice-6-reverification" });

interface Target {
  recordId: string;
  recordVersion: number;
  plane: MemoryV2Plane;
  resourceRowId: string;
}

interface StateRow {
  state_version: number;
  status: string;
  influence_eligible: number;
  last_verified_at: string | null;
  next_reverify_at: string;
  consecutive_failures: number;
  last_error_code: string | null;
  latest_decision_id: string | null;
}

interface JobRow {
  job_id: string;
  expected_state_version: number;
  status: string;
  attempt_count: number;
  next_attempt_at: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  last_error_code: string | null;
}

let context: MemoryTestContext;
let codePrincipal: MemoryV2RequestAuthorizationSnapshot;
let harnessPrincipal: MemoryV2RequestAuthorizationSnapshot;
let previousReverificationEnabled: string | undefined;

function addMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

function addSeconds(timestamp: string, seconds: number): string {
  return addMilliseconds(timestamp, seconds * 1_000);
}

function codeFixture(): CodebaseMemorySearchV2 {
  return structuredClone(
    MEMORY_CONTRACT_FIXTURES_V2.MemorySearchV2,
  ) as unknown as CodebaseMemorySearchV2;
}

function seedCodeTarget(input: {
  label: string;
  now?: string;
  expiresAt?: string | null;
}): Target {
  const repository = resolveMemoryRepository(
    context.orgA.id,
    context.projectA,
    "github.com/acme/checkout",
  )!;
  const id = `slice6-code-${input.label}-${randomUUID()}`;
  const fixture = codeFixture();
  const now = input.now ?? LAST_VERIFIED;
  const path = `src/slice6/${input.label}-${id.slice(-8)}.ts`;
  const symbol = `slice6_${input.label.replaceAll("-", "_")}_${id.slice(-8)}`;
  const record = importActiveMemoryRecord({
    orgId: context.orgA.id,
    projectId: context.projectA,
    repositoryRowId: repository.repository_row_id,
    recordId: id,
    kind: "constraint",
    content: {
      summary: `Slice 6 ${input.label} authoritative memory`,
      details: `This unique record exercises ${input.label} scheduled reverification behavior.`,
      rationale: "Scheduled truth checks must fail closed without creating a second lifecycle writer.",
    },
    applicability: {
      repository_id: repository.repository_id,
      base_sha: fixture.applicability.base_sha!,
      paths: [path],
      symbols: [symbol],
      task_classes: ["bug_fix"],
    },
    exceptions: [],
    compatibility: {
      harness_version_range: "*",
      workflow_version_range: "*",
      adapter_version_range: "*",
    },
    validation: {
      strategy: "repository_anchors",
      anchor_refs: [{ type: "path", value: path, digest: EVIDENCE_DIGEST }],
    },
    evidence: [{
      evidence_ref_id: `${id}-evidence`,
      type: "github_merge",
      digest: EVIDENCE_DIGEST,
      origin_id: `github-event:${id}`,
      source_authority: "verified",
    }],
    evidenceSummary: { strength: "verified_merge", ref_count: 1 },
    freshness: { last_confirmed_at: now, expires_at: input.expiresAt ?? null },
    provenance: { producer: "slice6-test", extractor_version: "v1" },
    now,
  });
  const facet = db.prepare(
    `SELECT resource_row_id FROM memory_v2_record_facets
     WHERE record_id = ? AND record_version = ?`,
  ).get(record.record_id, record.record_version) as { resource_row_id: string };
  ensureMemoryV2EvidenceVerifiedTrust({
    recordId: record.record_id,
    recordVersion: record.record_version,
    orgId: context.orgA.id,
    projectId: context.projectA,
    evidenceVerifiedAt: now,
    now: PASS_NOW,
  });
  return {
    recordId: record.record_id,
    recordVersion: record.record_version,
    plane: "codebase",
    resourceRowId: facet.resource_row_id,
  };
}

function seedHarnessTarget(input: { label: string; now?: string }): Target {
  const id = `slice6-harness-${input.label}-${randomUUID()}`;
  const now = input.now ?? LAST_VERIFIED;
  const record = importActiveHarnessMemoryRecord({
    orgId: context.orgA.id,
    projectId: context.projectA,
    recordId: id,
    kind: "test_strategy",
    content: {
      summary: `Slice 6 ${input.label} runtime-attestation memory`,
      details: `This unique harness record exercises ${input.label} scheduled reverification.`,
      rationale: "Runtime evidence must not remain influential after authoritative retirement.",
    },
    applicability: {
      harness_id: "example-harness-a",
      harness_version_range: "harness-shadow-v1",
      workflow_version_range: "code-change.v3",
      adapter_version_range: "example-harness-a-pim-adapter.v1",
      configuration_ids: [`slice6-${input.label}`],
      model_ids: ["gpt-harness-shadow"],
      tool_ids: ["terminal-state-inspector"],
    },
    exceptions: [],
    compatibility: {
      harness_version_range: "harness-shadow-v1",
      workflow_version_range: "code-change.v3",
      adapter_version_range: "example-harness-a-pim-adapter.v1",
    },
    validation: {
      strategy: "stable_failure_fingerprint",
      failure_fingerprint: `slice6:${input.label}:${id.slice(-8)}`,
    },
    evidence: [{
      evidence_ref_id: `${id}-evidence`,
      type: "failure",
      digest: EVIDENCE_DIGEST,
      origin_id: `example-harness-a:${id}`,
      source_authority: "observed",
    }],
    evidenceSummary: { strength: "observed", ref_count: 1 },
    freshness: { last_confirmed_at: now, expires_at: null },
    provenance: { extractor_version: "slice6-test.v1" },
    actorId: "slice6-test-reviewer",
    decisionRefs: [`slice6-${input.label}-admission`],
    reasonCode: "authorized_harness_failure_reviewed",
    explanation: "A bounded harness lesson was admitted for Slice 6 reverification testing.",
    now,
  });
  const facet = db.prepare(
    `SELECT resource_row_id FROM memory_v2_record_facets
     WHERE record_id = ? AND record_version = ?`,
  ).get(record.recordId, record.recordVersion) as { resource_row_id: string };
  ensureMemoryV2EvidenceVerifiedTrust({
    recordId: record.recordId,
    recordVersion: record.recordVersion,
    orgId: context.orgA.id,
    projectId: context.projectA,
    evidenceVerifiedAt: now,
    now: PASS_NOW,
  });
  return {
    recordId: record.recordId,
    recordVersion: record.recordVersion,
    plane: "harness",
    resourceRowId: facet.resource_row_id,
  };
}

function admit(input: {
  target: Target;
  lastVerifiedAt?: string;
  now?: string;
  intervalSeconds?: number;
  maxAgeSeconds?: number;
  maxAttempts?: number;
}): void {
  createMemoryV2ReverificationPolicy({
    recordId: input.target.recordId,
    recordVersion: input.target.recordVersion,
    orgId: context.orgA.id,
    projectId: context.projectA,
    plane: input.target.plane,
    resourceRowId: input.target.resourceRowId,
    resolverType: input.target.plane === "codebase" ? "github" : "runtime_attestation",
    intervalSeconds: input.intervalSeconds ?? YEAR_SECONDS,
    maxAgeSeconds: input.maxAgeSeconds ?? YEAR_SECONDS * 2,
    maxAttempts: input.maxAttempts ?? 8,
    createdBy: "slice6-test",
    lastVerifiedAt: input.lastVerifiedAt ?? LAST_VERIFIED,
    now: input.now ?? PASS_NOW,
  });
}

function stateFor(target: Target): StateRow {
  return db.prepare(
    `SELECT state_version, status, influence_eligible, last_verified_at,
            next_reverify_at,
            consecutive_failures, last_error_code, latest_decision_id
     FROM memory_v2_reverification_state
     WHERE record_id = ? AND record_version = ?`,
  ).get(target.recordId, target.recordVersion) as unknown as StateRow;
}

function jobsFor(target: Target): JobRow[] {
  return db.prepare(
    `SELECT job_id, expected_state_version, status, attempt_count,
            next_attempt_at, lease_owner, lease_expires_at, last_error_code
     FROM memory_v2_reverification_jobs
     WHERE record_id = ? AND record_version = ?
     ORDER BY created_at, job_id`,
  ).all(target.recordId, target.recordVersion) as unknown as JobRow[];
}

function recordStatus(target: Target): { current_status: string } {
  return db.prepare(
    "SELECT current_status FROM memory_records WHERE record_id = ?",
  ).get(target.recordId) as { current_status: string };
}

function countRows(table: string, target: Target): number {
  return Number((db.prepare(
    `SELECT COUNT(*) AS count FROM ${table} WHERE record_id = ? AND record_version = ?`,
  ).get(target.recordId, target.recordVersion) as { count: number }).count);
}

function verifiedProvider(at: string): MemoryV2ReverificationProvider {
  return async () => ({
    outcome: "verified",
    verifiedAt: at,
    evidenceDigest: EVIDENCE_DIGEST,
    sourceOccurredAt: at,
  });
}

function terminalProvider(
  outcome: "contradicted" | "withdrawn" | "expired",
  at: string,
): MemoryV2ReverificationProvider {
  return async () => ({
    outcome,
    evidenceDigest: EVIDENCE_DIGEST,
    sourceOccurredAt: at,
    reasonCode: `authoritative_${outcome}`,
  });
}

const unavailableProvider: MemoryV2ReverificationProvider = async () => ({
  outcome: "unavailable",
  errorCode: "provider_down",
});

function codeV2Request(query: string, requestId: string): CodebaseMemorySearchV2 {
  const fixture = codeFixture();
  return {
    ...fixture,
    request_id: requestId,
    tenant: { project_id: context.projectA },
    resource_selector: { canonical_resource_id: "github.com/acme/checkout" },
    applicability: {
      ...fixture.applicability,
      repository_id: "github.com/acme/checkout",
    },
    task: { ...fixture.task, query },
    temporal: { mode: "current", valid_at: PASS_NOW, recorded_at: PASS_NOW },
    budget: { ...fixture.budget, max_items: 32 },
  };
}

function codeV1Request(query: string, requestId: string): MemorySearchV1 {
  const fixture = structuredClone(
    MEMORY_CONTRACT_FIXTURES.MemorySearchV1,
  ) as unknown as MemorySearchV1;
  return {
    ...fixture,
    request_id: requestId,
    tenant: { project_id: context.projectA },
    applicability: {
      ...fixture.applicability,
      repository_id: "github.com/acme/checkout",
    },
    task: { ...fixture.task, query },
    temporal: { mode: "current", valid_at: PASS_NOW, recorded_at: PASS_NOW },
    budget: { ...fixture.budget, max_items: 32 },
  };
}

function readinessBinding(): ResourceBindingV2 {
  const resource = resolveMemoryV2Resource({
    orgId: context.orgA.id,
    projectId: context.projectA,
    plane: "codebase",
    canonicalResourceId: "github.com/acme/checkout",
  })!;
  return {
    resource_row_id: resource.resourceRowId,
    organization_id: resource.orgId,
    project_id: resource.projectId,
    plane: resource.plane,
    resource_type: resource.resourceType,
    canonical_resource_id: resource.canonicalResourceId,
    provider: resource.provider,
    provider_resource_id: resource.providerResourceId,
    display_label: resource.displayLabel,
    permitted_operations: ["readiness"],
  };
}

beforeAll(async () => {
  previousReverificationEnabled = process.env.MEMORY_V2_REVERIFICATION_ENABLED;
  process.env.MEMORY_V2_REVERIFICATION_ENABLED = "1";
  context = await createMemoryTestContext({}, { v2Reads: true });
  codePrincipal = verifyMemoryV2ServiceToken(context.tokenA)!.authorization;
  harnessPrincipal = verifyMemoryV2ServiceToken(context.harnessSearchTokenA)!.authorization;
});

afterAll(async () => {
  if (context) await context.app.close();
  if (previousReverificationEnabled === undefined) {
    delete process.env.MEMORY_V2_REVERIFICATION_ENABLED;
  } else {
    process.env.MEMORY_V2_REVERIFICATION_ENABLED = previousReverificationEnabled;
  }
});

describe.sequential("Slice 6 scheduled reverification service", () => {
  it("degrades bounded readiness for both missing coverage and an overdue covered record", async () => {
    const target = seedCodeTarget({ label: "readiness-missing-coverage" });
    const readiness = getMemoryV2Readiness({
      orgId: context.orgA.id,
      projectId: context.projectA,
      plane: "codebase",
      resourceBinding: readinessBinding(),
      checkedAt: PASS_NOW,
      reverificationEnabled: true,
    });
    expect(readiness).toMatchObject({
      status: "degraded",
      fresh_count: 0,
      due_count: 0,
      pending_count: 0,
    });

    admit({
      target,
      lastVerifiedAt: PASS_NOW,
      now: PASS_NOW,
      intervalSeconds: YEAR_SECONDS,
      maxAgeSeconds: YEAR_SECONDS * 2,
    });
    expect(getMemoryV2ReverificationHealth({
      recordId: target.recordId,
      recordVersion: target.recordVersion,
      now: PASS_NOW,
      reverificationEnabled: true,
    })).toMatchObject({
      status: "fresh",
      healthy: true,
      policyRevision: 1,
    });
    const overdueAt = addSeconds(PASS_NOW, YEAR_SECONDS);
    expect(getMemoryV2Readiness({
      orgId: context.orgA.id,
      projectId: context.projectA,
      plane: "codebase",
      resourceBinding: readinessBinding(),
      checkedAt: overdueAt,
      reverificationEnabled: true,
    })).toMatchObject({
      status: "degraded",
      fresh_count: 0,
      due_count: 1,
      pending_count: 0,
    });
    expect((await runMemoryV2ReverificationPass({
      now: overdueAt,
      workerId: "slice6-readiness-overdue-cleanup",
      maxJobs: 1,
      provider: verifiedProvider(overdueAt),
    })).verified).toBe(1);
  });

  it("bounds scheduling, generates one deterministic job per state version, and drains idempotently", async () => {
    const targets = ["bound-a", "bound-b", "bound-c"].map((label) => {
      const target = seedCodeTarget({ label });
      admit({ target });
      return target;
    });

    expect(scheduleDueMemoryV2Reverifications({ now: PASS_NOW, maxJobs: 2 })).toBe(2);
    expect(scheduleDueMemoryV2Reverifications({ now: PASS_NOW, maxJobs: 0 })).toBe(0);
    expect(targets.reduce((sum, target) => sum + jobsFor(target).length, 0)).toBe(2);
    expect(scheduleDueMemoryV2Reverifications({ now: PASS_NOW, maxJobs: 2 })).toBe(1);
    expect(scheduleDueMemoryV2Reverifications({ now: PASS_NOW, maxJobs: 2 })).toBe(0);
    expect(targets.reduce((sum, target) => sum + jobsFor(target).length, 0)).toBe(3);

    const result = await runMemoryV2ReverificationPass({
      now: PASS_NOW,
      workerId: "slice6-bounds",
      maxJobs: 3,
      provider: verifiedProvider(PASS_NOW),
    });
    expect(result).toMatchObject({ scheduled: 0, claimed: 3, verified: 3 });
    for (const target of targets) {
      expect(stateFor(target)).toMatchObject({ status: "fresh", influence_eligible: 1 });
      expect(jobsFor(target)).toHaveLength(1);
      expect(jobsFor(target)[0]).toMatchObject({ status: "completed", attempt_count: 1 });
    }
  });

  it("commits verified, contradicted, withdrawn, and expired outcomes on both planes", async () => {
    const cases = [
      "verified",
      "contradicted",
      "withdrawn",
      "expired",
    ] as const;
    for (const plane of ["codebase", "harness"] as const) {
      for (const outcome of cases) {
        const target = plane === "codebase"
          ? seedCodeTarget({ label: `${plane}-${outcome}` })
          : seedHarnessTarget({ label: `${plane}-${outcome}` });
        admit({ target });
        const provider = outcome === "verified"
          ? verifiedProvider(PASS_NOW)
          : terminalProvider(outcome, PASS_NOW);

        const result = await runMemoryV2ReverificationPass({
          now: PASS_NOW,
          workerId: `slice6-${plane}-${outcome}`,
          maxJobs: 1,
          provider,
        });
        const expectedCanonical = outcome === "verified"
          ? "active"
          : outcome === "expired" ? "expired" : "revoked";
        expect(result).toMatchObject({
          claimed: 1,
          verified: outcome === "verified" ? 1 : 0,
          retired: outcome === "verified" ? 0 : 1,
        });
        expect(stateFor(target)).toMatchObject({
          status: outcome === "verified" ? "fresh" : outcome,
          influence_eligible: outcome === "verified" ? 1 : 0,
        });
        expect(recordStatus(target).current_status).toBe(expectedCanonical);
        expect(countRows("memory_v2_reverification_decisions", target)).toBe(1);
        expect(jobsFor(target)[0]).toMatchObject({ status: "completed", attempt_count: 1 });
        expect(getMemoryV2RecordTrust(target.recordId, target.recordVersion)).toMatchObject({
          trustStatus: outcome === "verified" ? "trusted" : "untrusted",
          trustBasis: "evidence_verified",
        });

        const detail = plane === "codebase"
          ? getCodeMemoryRecordV2({
              principal: codePrincipal,
              recordId: target.recordId,
              recordVersion: target.recordVersion,
            })
          : getHarnessMemoryRecordV2({
              principal: harnessPrincipal,
              recordId: target.recordId,
              recordVersion: target.recordVersion,
            });
        expect(detail).toMatchObject({ lifecycle: { status: expectedCanonical } });
        if (plane === "harness" && outcome !== "verified") {
          expect(listCurrentHarnessMemoryRecords({
            orgId: context.orgA.id,
            projectId: context.projectA,
            harnessId: "example-harness-a",
            now: PASS_NOW,
          }).map((record) => record.recordId)).not.toContain(target.recordId);
        }
      }
    }
  });

  it("lets canonical effective-time expiry override a verified provider result", async () => {
    const target = seedCodeTarget({
      label: "canonical-expiry-override",
      expiresAt: PASS_NOW,
    });
    admit({ target });

    const result = await runMemoryV2ReverificationPass({
      now: PASS_NOW,
      workerId: "slice6-canonical-expiry",
      maxJobs: 1,
      provider: verifiedProvider(PASS_NOW),
    });

    expect(result).toMatchObject({ claimed: 1, verified: 0, retired: 1 });
    expect(stateFor(target)).toMatchObject({ status: "expired", influence_eligible: 0 });
    expect(recordStatus(target)).toEqual({ current_status: "expired" });
    expect(db.prepare(
      `SELECT provider_outcome, reason_code, canonical_to_status
       FROM memory_v2_reverification_decisions WHERE record_id = ?`,
    ).get(target.recordId)).toEqual({
      provider_outcome: "expired",
      reason_code: "canonical_effective_time_expired",
      canonical_to_status: "expired",
    });
  });

  it("schedules canonical expires_at even when it precedes the policy interval", async () => {
    const expiresAt = addSeconds(PASS_NOW, 60);
    const target = seedCodeTarget({
      label: "canonical-expiry-before-interval",
      now: PASS_NOW,
      expiresAt,
    });
    admit({
      target,
      lastVerifiedAt: PASS_NOW,
      now: PASS_NOW,
      intervalSeconds: 3_600,
      maxAgeSeconds: 7_200,
    });

    expect(stateFor(target).next_reverify_at).toBe(expiresAt);
    expect(await runMemoryV2ReverificationPass({
      now: expiresAt,
      workerId: "slice6-early-canonical-expiry",
      maxJobs: 1,
      provider: verifiedProvider(expiresAt),
    })).toMatchObject({ scheduled: 1, claimed: 1, verified: 0, retired: 1 });
    expect(recordStatus(target).current_status).toBe("expired");
    expect(stateFor(target)).toMatchObject({ status: "expired", influence_eligible: 0 });
  });

  it("keeps future canonical expiry as the next bound after a successful verification", async () => {
    const lastVerifiedAt = addSeconds(PASS_NOW, -3_600);
    const expiresAt = addSeconds(PASS_NOW, 300);
    const target = seedCodeTarget({
      label: "verified-future-expiry-bound",
      now: lastVerifiedAt,
      expiresAt,
    });
    admit({
      target,
      lastVerifiedAt,
      now: PASS_NOW,
      intervalSeconds: 3_600,
      maxAgeSeconds: 7_200,
    });

    expect((await runMemoryV2ReverificationPass({
      now: PASS_NOW,
      workerId: "slice6-verified-expiry-bound",
      maxJobs: 1,
      provider: verifiedProvider(PASS_NOW),
    })).verified).toBe(1);
    expect(stateFor(target)).toMatchObject({
      status: "fresh",
      influence_eligible: 1,
      last_verified_at: PASS_NOW,
      next_reverify_at: expiresAt,
    });
  });

  it("rejects mismatched plane/resolver policy admission without writing policy or state", () => {
    const codeTarget = seedCodeTarget({ label: "wrong-resolver-code" });
    const harnessTarget = seedHarnessTarget({ label: "wrong-resolver-harness" });
    const base = {
      orgId: context.orgA.id,
      projectId: context.projectA,
      intervalSeconds: YEAR_SECONDS,
      maxAgeSeconds: YEAR_SECONDS * 2,
      maxAttempts: 8,
      createdBy: "slice6-test",
      lastVerifiedAt: LAST_VERIFIED,
      now: PASS_NOW,
    };

    expect(() => createMemoryV2ReverificationPolicy({
      ...base,
      recordId: codeTarget.recordId,
      recordVersion: codeTarget.recordVersion,
      orgId: context.orgA.id,
      projectId: context.projectA,
      plane: "codebase",
      resourceRowId: codeTarget.resourceRowId,
      resolverType: "runtime_attestation",
    })).toThrow(MemoryV2ReverificationError);
    expect(() => createMemoryV2ReverificationPolicy({
      ...base,
      recordId: harnessTarget.recordId,
      recordVersion: harnessTarget.recordVersion,
      plane: "harness",
      resourceRowId: harnessTarget.resourceRowId,
      resolverType: "github",
    })).toThrow(MemoryV2ReverificationError);
    expect(() => createMemoryV2ReverificationPolicy({
      ...base,
      recordId: codeTarget.recordId,
      recordVersion: codeTarget.recordVersion,
      plane: "harness",
      resourceRowId: codeTarget.resourceRowId,
      resolverType: "runtime_attestation",
    })).toThrow(MemoryV2ReverificationError);

    for (const target of [codeTarget, harnessTarget]) {
      expect(countRows("memory_v2_reverification_policies", target)).toBe(0);
      expect(countRows("memory_v2_reverification_state", target)).toBe(0);
    }
  });

  it("keeps provider unavailability pending without removing prior trust or eligibility", async () => {
    const lastVerifiedAt = addSeconds(PASS_NOW, -60);
    const target = seedCodeTarget({ label: "provider-outage", now: lastVerifiedAt });
    admit({
      target,
      lastVerifiedAt,
      intervalSeconds: 60,
      maxAgeSeconds: 120,
      maxAttempts: 64,
    });

    const pending = await runMemoryV2ReverificationPass({
      now: PASS_NOW,
      workerId: "slice6-outage-pending",
      maxJobs: 1,
      provider: unavailableProvider,
    });
    expect(pending).toMatchObject({ claimed: 1, pending: 1, retired: 0, deadLettered: 0 });
    expect(stateFor(target)).toMatchObject({
      status: "pending",
      influence_eligible: 1,
      consecutive_failures: 1,
      last_error_code: "provider_down",
    });
    expect(recordStatus(target)).toEqual({ current_status: "active" });
    expect(getMemoryV2RecordTrust(target.recordId, target.recordVersion)).toMatchObject({
      trustStatus: "trusted",
      trustBasis: "evidence_verified",
    });

    const retried = await runMemoryV2ReverificationPass({
      now: addSeconds(PASS_NOW, 120),
      workerId: "slice6-outage-retry",
      maxJobs: 1,
      provider: unavailableProvider,
    });
    expect(retried).toMatchObject({ claimed: 1, pending: 1, retired: 0 });
    expect(stateFor(target)).toMatchObject({
      status: "pending",
      influence_eligible: 1,
      consecutive_failures: 2,
      last_error_code: "provider_down",
    });
    expect(recordStatus(target)).toEqual({ current_status: "active" });
    expect(getMemoryV2RecordTrust(target.recordId, target.recordVersion)?.trustStatus)
      .toBe("trusted");
  });

  it("dead-letters an exhausted job without early retirement and schedules a new bounded job", async () => {
    const lastVerifiedAt = addSeconds(PASS_NOW, -60);
    const target = seedCodeTarget({ label: "deadletter-reschedule", now: lastVerifiedAt });
    admit({
      target,
      lastVerifiedAt,
      intervalSeconds: 60,
      maxAgeSeconds: 600,
      maxAttempts: 1,
    });

    const first = await runMemoryV2ReverificationPass({
      now: PASS_NOW,
      workerId: "slice6-deadletter-1",
      maxJobs: 1,
      provider: unavailableProvider,
    });
    expect(first).toMatchObject({ pending: 1, retired: 0, deadLettered: 1 });
    expect(stateFor(target)).toMatchObject({ status: "pending", influence_eligible: 1 });
    expect(recordStatus(target).current_status).toBe("active");
    expect(jobsFor(target)).toHaveLength(1);
    expect(jobsFor(target)[0]).toMatchObject({ status: "dead_letter", attempt_count: 1 });

    const secondAt = addSeconds(PASS_NOW, 1);
    const second = await runMemoryV2ReverificationPass({
      now: secondAt,
      workerId: "slice6-deadletter-2",
      maxJobs: 1,
      provider: unavailableProvider,
    });
    expect(second).toMatchObject({ scheduled: 1, claimed: 1, pending: 1, deadLettered: 1 });
    expect(jobsFor(target)).toHaveLength(2);
    expect(new Set(jobsFor(target).map((job) => job.job_id)).size).toBe(2);
    expect(recordStatus(target).current_status).toBe("active");

    const thirdRetry = await runMemoryV2ReverificationPass({
      now: addSeconds(PASS_NOW, 120),
      workerId: "slice6-deadletter-3",
      maxJobs: 1,
      provider: unavailableProvider,
    });
    expect(thirdRetry).toMatchObject({
      scheduled: 1,
      claimed: 1,
      pending: 1,
      retired: 0,
      deadLettered: 1,
    });
    expect(jobsFor(target)).toHaveLength(3);
    expect(stateFor(target)).toMatchObject({ status: "pending", influence_eligible: 1 });
    expect(recordStatus(target).current_status).toBe("active");
    expect(getMemoryV2RecordTrust(target.recordId, target.recordVersion)?.trustStatus)
      .toBe("trusted");
  });

  it("uses only the default-off enabled switch before scheduling or claiming", async () => {
    const target = seedCodeTarget({ label: "environment-pause" });
    admit({ target });
    const stateBefore = stateFor(target);
    const previousEnabled = process.env.MEMORY_V2_REVERIFICATION_ENABLED;
    try {
      delete process.env.MEMORY_V2_REVERIFICATION_ENABLED;
      expect(scheduleDueMemoryV2Reverifications({ now: PASS_NOW, maxJobs: 1 })).toBe(0);
      expect(await runMemoryV2ReverificationPass({
        now: PASS_NOW,
        workerId: "slice6-disabled",
        maxJobs: 1,
        provider: verifiedProvider(PASS_NOW),
      })).toEqual({
        enabled: false,
        scheduled: 0,
        claimed: 0,
        verified: 0,
        retired: 0,
        pending: 0,
        deadLettered: 0,
      });
      expect(stateFor(target)).toEqual(stateBefore);
      expect(jobsFor(target)).toEqual([]);
    } finally {
      if (previousEnabled === undefined) delete process.env.MEMORY_V2_REVERIFICATION_ENABLED;
      else process.env.MEMORY_V2_REVERIFICATION_ENABLED = previousEnabled;
    }

    expect((await runMemoryV2ReverificationPass({
      now: PASS_NOW,
      workerId: "slice6-unpaused",
      maxJobs: 1,
      provider: verifiedProvider(PASS_NOW),
    })).verified).toBe(1);
  });

  it("rolls back decision, lifecycle, state, job-finalization, and attempt stages atomically", async () => {
    const stages: MemoryV2ReverificationCommitStage[] = [
      "after_decision",
      "after_lifecycle",
      "after_state",
      "after_job",
      "after_attempt",
    ];
    for (const stage of stages) {
      const target = seedCodeTarget({ label: `rollback-${stage}` });
      admit({ target });
      const transitionsBefore = Number((db.prepare(
        `SELECT COUNT(*) AS count FROM memory_transitions
         WHERE aggregate_type = 'record' AND aggregate_id = ?`,
      ).get(target.recordId) as { count: number }).count);

      await expect(runMemoryV2ReverificationPass({
        now: PASS_NOW,
        workerId: `slice6-${stage}`,
        maxJobs: 1,
        leaseMs: 1_000,
        provider: terminalProvider("contradicted", PASS_NOW),
        beforeCommit: (currentStage) => {
          if (currentStage === stage) throw new Error(`injected-${stage}`);
        },
      })).rejects.toThrow(`injected-${stage}`);

      expect(recordStatus(target).current_status).toBe("active");
      expect(stateFor(target)).toMatchObject({
        status: "due",
        influence_eligible: 1,
        latest_decision_id: null,
      });
      expect(countRows("memory_v2_reverification_decisions", target)).toBe(0);
      expect(db.prepare(
        `SELECT COUNT(*) AS count FROM memory_v2_reverification_job_attempts AS attempt
         JOIN memory_v2_reverification_jobs AS job ON job.job_id = attempt.job_id
         WHERE job.record_id = ? AND job.record_version = ?`,
      ).get(target.recordId, target.recordVersion)).toEqual({ count: 0 });
      expect(jobsFor(target)[0]).toMatchObject({ status: "leased", attempt_count: 1 });
      expect(db.prepare(
        `SELECT COUNT(*) AS count FROM memory_transitions
         WHERE aggregate_type = 'record' AND aggregate_id = ?`,
      ).get(target.recordId)).toEqual({ count: transitionsBefore });

      const cleanupAt = addMilliseconds(PASS_NOW, 1_001);
      let cleanupProviderCalls = 0;
      expect(await runMemoryV2ReverificationPass({
        now: cleanupAt,
        workerId: `slice6-${stage}-cleanup`,
        maxJobs: 1,
        leaseMs: 1_000,
        provider: async (input) => {
          cleanupProviderCalls += 1;
          return verifiedProvider(cleanupAt)(input);
        },
      })).toMatchObject({ claimed: 1, pending: 1 });
      expect(cleanupProviderCalls).toBe(0);

      const retryAt = addMilliseconds(cleanupAt, 1_000);
      expect((await runMemoryV2ReverificationPass({
        now: retryAt,
        workerId: `slice6-${stage}-retry`,
        maxJobs: 1,
        leaseMs: 1_000,
        provider: verifiedProvider(retryAt),
      })).verified).toBe(1);
    }
  });

  it("removes an explicitly contradicted record from active search while preserving audit detail and history", async () => {
    const target = seedCodeTarget({
      label: "active-search-retirement",
    });
    admit({ target });
    const query = "Slice 6 active-search-retirement authoritative memory";
    const repository = resolveMemoryRepository(
      context.orgA.id,
      context.projectA,
      "github.com/acme/checkout",
    )!;

    const beforeV1 = await executeMemorySearch({
      orgId: context.orgA.id,
      principalId: codePrincipal.servicePrincipalId,
      repository,
      request: codeV1Request(query, `slice6-v1-before-${randomUUID()}`),
    }, { now: () => new Date(PASS_NOW) });
    const beforeV2 = await searchCodeMemoryV2({
      principal: codePrincipal,
      request: codeV2Request(query, `slice6-v2-before-${randomUUID()}`),
      dependencies: { now: () => new Date(PASS_NOW) },
    });
    expect(beforeV1.items.map((item) => item.record_id)).toContain(target.recordId);
    expect(beforeV2.items.map((item) => item.record_id)).toContain(target.recordId);

    const retired = await runMemoryV2ReverificationPass({
      now: PASS_NOW,
      workerId: "slice6-retirement-search",
      maxJobs: 1,
      provider: terminalProvider("contradicted", PASS_NOW),
    });
    expect(retired.retired).toBe(1);

    const afterV1 = await executeMemorySearch({
      orgId: context.orgA.id,
      principalId: codePrincipal.servicePrincipalId,
      repository,
      request: codeV1Request(query, `slice6-v1-after-${randomUUID()}`),
    }, { now: () => new Date(PASS_NOW) });
    const afterV2 = await searchCodeMemoryV2({
      principal: codePrincipal,
      request: codeV2Request(query, `slice6-v2-after-${randomUUID()}`),
      dependencies: { now: () => new Date(PASS_NOW) },
    });
    expect(afterV1.items.map((item) => item.record_id)).not.toContain(target.recordId);
    expect(afterV2.items.map((item) => item.record_id)).not.toContain(target.recordId);

    expect(getMemoryRecord(
      context.orgA.id,
      context.projectA,
      target.recordId,
      target.recordVersion,
    )).toMatchObject({ lifecycle: { status: "revoked" } });
    expect(getCodeMemoryRecordV2({
      principal: codePrincipal,
      recordId: target.recordId,
      recordVersion: target.recordVersion,
    })).toMatchObject({
      lifecycle: { status: "revoked" },
    });
    expect(getCodeMemoryRecordHistoryV2({
      principal: codePrincipal,
      recordId: target.recordId,
    })).toMatchObject({
      lifecycle: { status: "revoked" },
      current_version: target.recordVersion,
    });
    expect(recordStatus(target)).toEqual({ current_status: "revoked" });
    expect(stateFor(target)).toMatchObject({ status: "contradicted", influence_eligible: 0 });
    expect(getMemoryV2RecordTrust(target.recordId, target.recordVersion)?.trustStatus)
      .toBe("untrusted");
  });

  it("finalizes an expired lease without re-calling the provider and verifies after backoff", async () => {
    const target = seedCodeTarget({ label: "race-lease" });
    admit({ target });
    await expect(runMemoryV2ReverificationPass({
      now: PASS_NOW,
      workerId: "slice6-race-lease",
      maxJobs: 1,
      leaseMs: 1_000,
      provider: async () => {
        db.prepare(
          `UPDATE memory_v2_reverification_jobs
           SET lease_expires_at = ?, updated_at = ?
           WHERE record_id = ? AND record_version = ? AND status = 'leased'`,
        ).run(PASS_NOW, PASS_NOW, target.recordId, target.recordVersion);
        return verifiedProvider(PASS_NOW)({} as never);
      },
    })).rejects.toMatchObject({ code: "transition_invalid" });
    expect(recordStatus(target).current_status).toBe("active");
    expect(countRows("memory_v2_reverification_decisions", target)).toBe(0);
    expect(stateFor(target)).toMatchObject({ status: "due", latest_decision_id: null });
    expect(jobsFor(target)[0]).toMatchObject({ status: "leased", attempt_count: 1 });
    expect(db.prepare(
      `SELECT COUNT(*) AS count FROM memory_v2_reverification_job_attempts AS attempt
       JOIN memory_v2_reverification_jobs AS job ON job.job_id = attempt.job_id
       WHERE job.record_id = ? AND job.record_version = ?`,
    ).get(target.recordId, target.recordVersion)).toEqual({ count: 0 });

    const cleanupAt = addMilliseconds(PASS_NOW, 1);
    let takeoverProviderCalls = 0;
    expect(await runMemoryV2ReverificationPass({
      now: cleanupAt,
      workerId: "slice6-race-lease-cleanup",
      maxJobs: 1,
      provider: async (input) => {
        takeoverProviderCalls += 1;
        return verifiedProvider(cleanupAt)(input);
      },
    })).toMatchObject({ claimed: 1, pending: 1, deadLettered: 0 });
    expect(takeoverProviderCalls).toBe(0);
    expect(jobsFor(target)[0]).toMatchObject({
      status: "pending",
      attempt_count: 1,
      last_error_code: "reverification_lease_expired",
    });
    expect(stateFor(target)).toMatchObject({
      status: "pending",
      last_error_code: "reverification_lease_expired",
    });
    expect(db.prepare(
      `SELECT attempt.attempt_number, attempt.outcome, attempt.error_code
       FROM memory_v2_reverification_job_attempts AS attempt
       JOIN memory_v2_reverification_jobs AS job ON job.job_id = attempt.job_id
       WHERE job.record_id = ? AND job.record_version = ?`,
    ).all(target.recordId, target.recordVersion)).toEqual([{
      attempt_number: 1,
      outcome: "retry",
      error_code: "reverification_lease_expired",
    }]);

    const verifiedAt = addMilliseconds(PASS_NOW, 1_001);
    expect(await runMemoryV2ReverificationPass({
      now: verifiedAt,
      workerId: "slice6-race-lease-after-backoff",
      maxJobs: 1,
      provider: verifiedProvider(verifiedAt),
    })).toMatchObject({ claimed: 1, verified: 1 });
    expect(jobsFor(target)[0]).toMatchObject({ status: "completed", attempt_count: 2 });
    expect(db.prepare(
      `SELECT attempt_number, outcome
       FROM memory_v2_reverification_job_attempts
       WHERE job_id = ? ORDER BY attempt_number`,
    ).all(jobsFor(target)[0]!.job_id)).toEqual([
      { attempt_number: 1, outcome: "retry" },
      { attempt_number: 2, outcome: "verified" },
    ]);
  });

  it("bounds repeated expired leases by max attempts without takeover provider calls", async () => {
    const target = seedCodeTarget({ label: "race-lease-max-attempt" });
    admit({ target, maxAttempts: 2 });
    let abandonedProviderCalls = 0;
    let takeoverProviderCalls = 0;
    for (const [index, now] of [PASS_NOW, addMilliseconds(PASS_NOW, 1_001)].entries()) {
      await expect(runMemoryV2ReverificationPass({
        now,
        workerId: `slice6-race-lease-max-abandoned-${index}`,
        maxJobs: 1,
        leaseMs: 1_000,
        provider: async () => {
          abandonedProviderCalls += 1;
          db.prepare(
            `UPDATE memory_v2_reverification_jobs
             SET lease_expires_at = ?, updated_at = ?
             WHERE record_id = ? AND record_version = ? AND status = 'leased'`,
          ).run(now, now, target.recordId, target.recordVersion);
          return {
            outcome: "verified",
            verifiedAt: now,
            evidenceDigest: EVIDENCE_DIGEST,
          };
        },
      })).rejects.toMatchObject({ code: "transition_invalid" });
      expect(jobsFor(target)[0]).toMatchObject({
        status: "leased",
        attempt_count: index + 1,
      });

      const recoveredAt = addMilliseconds(now, 1);
      const recovered = await runMemoryV2ReverificationPass({
        now: recoveredAt,
        workerId: `slice6-race-lease-max-recovered-${index}`,
        maxJobs: 1,
        provider: async (input) => {
          takeoverProviderCalls += 1;
          return unavailableProvider(input);
        },
      });
      expect(recovered).toMatchObject({
        claimed: 1,
        pending: 1,
        retired: 0,
        deadLettered: index === 1 ? 1 : 0,
      });
    }

    expect(abandonedProviderCalls).toBe(2);
    expect(takeoverProviderCalls).toBe(0);
    expect(jobsFor(target)[0]).toMatchObject({ status: "dead_letter", attempt_count: 2 });
    expect(db.prepare(
      `SELECT attempt_number, outcome, error_code
       FROM memory_v2_reverification_job_attempts
       WHERE job_id = ? ORDER BY attempt_number`,
    ).all(jobsFor(target)[0]!.job_id)).toEqual([
      {
        attempt_number: 1,
        outcome: "retry",
        error_code: "reverification_lease_expired",
      },
      {
        attempt_number: 2,
        outcome: "dead_letter",
        error_code: "reverification_lease_expired",
      },
    ]);
    expect(recordStatus(target).current_status).toBe("active");
  });

  it("rejects a stale state-version worker without recording a decision or lifecycle change", async () => {
    const target = seedCodeTarget({ label: "race-state" });
    admit({ target });
    await expect(runMemoryV2ReverificationPass({
      now: PASS_NOW,
      workerId: "slice6-race-state",
      maxJobs: 1,
      provider: async () => {
        db.prepare(
          `UPDATE memory_v2_reverification_state
           SET state_version = state_version + 1, updated_at = ?
           WHERE record_id = ? AND record_version = ?`,
        ).run(PASS_NOW, target.recordId, target.recordVersion);
        return {
          outcome: "verified",
          verifiedAt: PASS_NOW,
          evidenceDigest: EVIDENCE_DIGEST,
        };
      },
    })).rejects.toMatchObject({ code: "transition_invalid" });
    expect(recordStatus(target).current_status).toBe("active");
    expect(countRows("memory_v2_reverification_decisions", target)).toBe(0);
    expect(stateFor(target)).toMatchObject({ status: "due", latest_decision_id: null });
  });

  it("rejects a stale policy worker after policy revision without replaying its result", async () => {
    const target = seedCodeTarget({ label: "race-policy" });
    admit({ target });
    await expect(runMemoryV2ReverificationPass({
      now: PASS_NOW,
      workerId: "slice6-race-policy",
      maxJobs: 1,
      provider: async () => {
        admit({ target, now: PASS_NOW });
        return {
          outcome: "verified",
          verifiedAt: PASS_NOW,
          evidenceDigest: EVIDENCE_DIGEST,
        };
      },
    })).rejects.toMatchObject({ code: "transition_invalid" });
    expect(recordStatus(target).current_status).toBe("active");
    expect(countRows("memory_v2_reverification_decisions", target)).toBe(0);
    expect(jobsFor(target)[0]).toMatchObject({
      status: "dead_letter",
      last_error_code: "reverification_policy_superseded",
    });
    expect(stateFor(target)).toMatchObject({ status: "due", latest_decision_id: null });
    expect((await runMemoryV2ReverificationPass({
      now: PASS_NOW,
      workerId: "slice6-race-policy-current-revision",
      maxJobs: 1,
      provider: verifiedProvider(PASS_NOW),
    }))).toMatchObject({ scheduled: 1, claimed: 1, verified: 1 });
  });

  it("rejects a stale canonical-version worker and preserves only the concurrent lifecycle write", async () => {
    const target = seedCodeTarget({ label: "race-canonical" });
    admit({ target });
    await expect(runMemoryV2ReverificationPass({
      now: PASS_NOW,
      workerId: "slice6-race-canonical",
      maxJobs: 1,
      provider: async () => {
        transitionMemoryRecordStatus({
          orgId: context.orgA.id,
          projectId: context.projectA,
          recordId: target.recordId,
          toStatus: "stale",
          actorId: "concurrent-lifecycle-writer",
          reasonCode: "concurrent_canonical_change",
          explanation: "Simulate a canonical lifecycle CAS race.",
          expectedCurrentVersion: target.recordVersion,
          expectedCurrentStatus: "active",
          now: PASS_NOW,
          canonicalResult: true,
        });
        return {
          outcome: "verified",
          verifiedAt: PASS_NOW,
          evidenceDigest: EVIDENCE_DIGEST,
        };
      },
    })).rejects.toBeInstanceOf(MemoryV2ReverificationError);
    expect(recordStatus(target).current_status).toBe("stale");
    expect(countRows("memory_v2_reverification_decisions", target)).toBe(0);
    expect(stateFor(target)).toMatchObject({
      status: "withdrawn",
      influence_eligible: 0,
      last_error_code: "canonical_lifecycle_stale",
      latest_decision_id: null,
    });
  });

  it("bounds a hung provider by the lease-derived timeout and records it as unavailable", async () => {
    const target = seedCodeTarget({ label: "provider-timeout" });
    admit({ target });
    vi.useFakeTimers();
    try {
      const pass = runMemoryV2ReverificationPass({
        now: PASS_NOW,
        workerId: "slice6-provider-timeout",
        maxJobs: 1,
        leaseMs: 1_000,
        provider: async () => new Promise<MemoryV2ReverificationProviderResult>(() => undefined),
      });
      await vi.advanceTimersByTimeAsync(501);
      expect(await pass).toMatchObject({ claimed: 1, pending: 1, retired: 0 });
    } finally {
      vi.useRealTimers();
    }
    expect(stateFor(target)).toMatchObject({
      status: "pending",
      influence_eligible: 1,
      last_verified_at: LAST_VERIFIED,
      last_error_code: "reverification_provider_timeout",
    });
    expect(getMemoryV2RecordTrust(target.recordId, target.recordVersion)?.trustStatus)
      .toBe("trusted");
  });

  it("treats malformed, future, and regressed provider timestamps as unavailable without renewal", async () => {
    const cases: Array<{
      label: string;
      result: MemoryV2ReverificationProviderResult;
      errorCode: string;
    }> = [
      {
        label: "malformed-verified-at",
        result: {
          outcome: "verified",
          verifiedAt: "not-a-timestamp",
          evidenceDigest: EVIDENCE_DIGEST,
        },
        errorCode: "reverification_verified_at_invalid",
      },
      {
        label: "future-verified-at",
        result: {
          outcome: "verified",
          verifiedAt: addMilliseconds(PASS_NOW, 1),
          evidenceDigest: EVIDENCE_DIGEST,
        },
        errorCode: "reverification_verified_at_invalid",
      },
      {
        label: "future-source-at",
        result: {
          outcome: "verified",
          verifiedAt: PASS_NOW,
          sourceOccurredAt: addMilliseconds(PASS_NOW, 1),
          evidenceDigest: EVIDENCE_DIGEST,
        },
        errorCode: "reverification_source_time_invalid",
      },
      {
        label: "regressed-verified-at",
        result: {
          outcome: "verified",
          verifiedAt: addMilliseconds(LAST_VERIFIED, -1),
          evidenceDigest: EVIDENCE_DIGEST,
        },
        errorCode: "reverification_verified_at_regressed",
      },
    ];

    for (const testCase of cases) {
      const target = seedCodeTarget({ label: testCase.label });
      admit({ target });
      const result = await runMemoryV2ReverificationPass({
        now: PASS_NOW,
        workerId: `slice6-${testCase.label}`,
        maxJobs: 1,
        provider: async () => testCase.result,
      });
      expect(result).toMatchObject({ claimed: 1, verified: 0, pending: 1, retired: 0 });
      expect(stateFor(target)).toMatchObject({
        status: "pending",
        influence_eligible: 1,
        last_verified_at: LAST_VERIFIED,
        consecutive_failures: 1,
        last_error_code: testCase.errorCode,
      });
      expect(recordStatus(target).current_status).toBe("active");
      expect(getMemoryV2RecordTrust(target.recordId, target.recordVersion)?.trustStatus)
        .toBe("trusted");
      expect(db.prepare(
        `SELECT provider_outcome, reason_code
         FROM memory_v2_reverification_decisions WHERE record_id = ?`,
      ).get(target.recordId)).toEqual({
        provider_outcome: "unavailable",
        reason_code: testCase.errorCode,
      });
    }
  });

  it("does not schedule, call a provider, or strand a lease for an externally retired canonical record", async () => {
    const target = seedCodeTarget({ label: "external-canonical-terminal" });
    admit({ target });
    transitionMemoryRecordStatus({
      orgId: context.orgA.id,
      projectId: context.projectA,
      recordId: target.recordId,
      toStatus: "stale",
      actorId: "external-canonical-writer",
      reasonCode: "external_canonical_retirement",
      explanation: "Simulate a canonical transition outside the reverification worker.",
      expectedCurrentVersion: target.recordVersion,
      expectedCurrentStatus: "active",
      now: PASS_NOW,
      canonicalResult: true,
    });
    let providerCalls = 0;
    expect(await runMemoryV2ReverificationPass({
      now: PASS_NOW,
      workerId: "slice6-external-canonical-terminal",
      maxJobs: 1,
      provider: async () => {
        providerCalls += 1;
        return {
          outcome: "verified",
          verifiedAt: PASS_NOW,
          evidenceDigest: EVIDENCE_DIGEST,
        };
      },
    })).toMatchObject({ scheduled: 0, claimed: 0 });
    expect(providerCalls).toBe(0);
    expect(jobsFor(target)).toEqual([]);
    expect(countRows("memory_v2_reverification_decisions", target)).toBe(0);
    expect(recordStatus(target).current_status).toBe("stale");
    expect(getMemoryV2RecordTrust(target.recordId, target.recordVersion)?.trustStatus)
      .toBe("untrusted");
  });
});
