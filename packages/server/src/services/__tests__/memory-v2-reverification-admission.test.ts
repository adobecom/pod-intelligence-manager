import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { canonicalJsonSha256 } from "@pim/shared";
import db from "../../db/connection.js";
import {
  createMemoryTestContext,
  type MemoryTestContext,
} from "../../routes/__tests__/memory-test-app.js";
import {
  importActiveHarnessMemoryRecord,
} from "../memory-harness-records.js";
import {
  importActiveMemoryRecord,
  transitionMemoryRecordStatus,
} from "../memory-records.js";
import { resolveMemoryRepository } from "../memory-repository-registry.js";
import {
  ensureMemoryV2ReverificationAdmission,
  memoryV2ReverificationAdmissionConfig,
  MemoryV2ReverificationAdmissionError,
  reconcileMemoryV2ReverificationAdmissions,
} from "../memory-v2-reverification-admission.js";
import { reconcileMemoryV2Reverification } from "../memory-v2-startup-reconciliation.js";
import {
  memoryV2ReverificationEnabled,
  scheduleDueMemoryV2Reverifications,
} from "../memory-v2-reverification.js";
import {
  ensureMemoryV2EvidenceVerifiedTrust,
  getMemoryV2RecordTrust,
} from "../memory-v2-trust.js";

const LAST_VERIFIED_AT = "2026-08-01T00:00:00.000Z";
// createMemoryTestContext seeds additional eligible trust rows at the real wall clock. Keep the
// simulated admission after those rows instead of using a fixed date that eventually becomes past.
const ADMISSION_AT = new Date(Date.now() + 86_400_000).toISOString();
const EVIDENCE_DIGEST = canonicalJsonSha256({ fixture: "reverification-admission" });
const POLICY_ENV_NAMES = [
  "MEMORY_V2_REVERIFICATION_ENABLED",
  "MEMORY_V2_REVERIFICATION_POLICY_INTERVAL_SECONDS",
  "MEMORY_V2_REVERIFICATION_POLICY_MAX_AGE_SECONDS",
  "MEMORY_V2_REVERIFICATION_POLICY_MAX_ATTEMPTS",
  "MEMORY_V2_REVERIFICATION_ADMISSION_MAX_RECORDS",
] as const;

interface SeededTarget {
  recordId: string;
  recordVersion: number;
  plane: "codebase" | "harness";
}

let context: MemoryTestContext;
let savedEnvironment: Map<string, string | undefined>;

function seedCode(label: string): SeededTarget {
  const repository = resolveMemoryRepository(
    context.orgA.id,
    context.projectA,
    "github.com/acme/checkout",
  );
  if (!repository) throw new Error("Admission fixture repository is unavailable");
  const suffix = randomUUID();
  const record = importActiveMemoryRecord({
    orgId: context.orgA.id,
    projectId: context.projectA,
    repositoryRowId: repository.repository_row_id,
    recordId: `mem-admission-code-${suffix}`,
    kind: "constraint",
    content: {
      summary: `Preserve the ${label} admission invariant ${suffix}.`,
      details: `The ${label} record proves that a migrated prompt-relevant code record receives one resolver policy.`,
      rationale: "Stored freshness, not startup wall-clock time, anchors scheduled reverification.",
    },
    applicability: {
      repository_id: repository.repository_id,
      paths: [`src/admission/${suffix}.ts`],
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
      anchor_refs: [{
        type: "path",
        value: `src/admission/${suffix}.ts`,
        digest: EVIDENCE_DIGEST,
      }],
    },
    evidence: [{
      evidence_ref_id: `evidence-admission-code-${suffix}`,
      type: "github_merge",
      digest: EVIDENCE_DIGEST,
      origin_id: `github:admission:${suffix}`,
      source_authority: "verified",
    }],
    evidenceSummary: { strength: "verified_merge", ref_count: 1 },
    freshness: { last_confirmed_at: LAST_VERIFIED_AT, expires_at: null },
    provenance: {
      extractor_version: "legacy-migration-admission-test.v1",
      migrated_v1_record: true,
    },
    now: LAST_VERIFIED_AT,
  });
  ensureMemoryV2EvidenceVerifiedTrust({
    recordId: record.record_id,
    recordVersion: record.record_version,
    orgId: context.orgA.id,
    projectId: context.projectA,
    evidenceVerifiedAt: LAST_VERIFIED_AT,
    now: ADMISSION_AT,
  });
  return { recordId: record.record_id, recordVersion: record.record_version, plane: "codebase" };
}

function seedHarness(label: string): SeededTarget {
  const suffix = randomUUID();
  const record = importActiveHarnessMemoryRecord({
    orgId: context.orgA.id,
    projectId: context.projectA,
    recordId: `mem-admission-harness-${suffix}`,
    kind: "test_strategy",
    content: {
      summary: `Inspect ${label} terminal state ${suffix}.`,
      details: `This migrated harness lesson proves bounded startup policy admission for ${label}.`,
      rationale: "Historical v1 data remains usable through its additive v2 companion.",
    },
    applicability: {
      harness_id: "example-harness-a",
      harness_version_range: "harness-shadow-v1",
      workflow_version_range: "code-change.v3",
      adapter_version_range: "example-harness-a-pim-adapter.v1",
      configuration_ids: [`admission-${suffix}`],
    },
    exceptions: [],
    compatibility: {
      harness_version_range: "harness-shadow-v1",
      workflow_version_range: "code-change.v3",
      adapter_version_range: "example-harness-a-pim-adapter.v1",
    },
    validation: {
      strategy: "stable_failure_fingerprint",
      failure_fingerprint: `admission:${label}:${suffix}`,
    },
    evidence: [{
      evidence_ref_id: `evidence-admission-harness-${suffix}`,
      type: "runtime_attestation",
      digest: EVIDENCE_DIGEST,
      origin_id: `example-harness-a:admission:${suffix}`,
      source_authority: "observed",
    }],
    evidenceSummary: { strength: "observed", ref_count: 1 },
    freshness: { last_confirmed_at: LAST_VERIFIED_AT, expires_at: null },
    provenance: {
      extractor_version: "legacy-migration-admission-test.v1",
      migrated_v1_record: true,
    },
    actorId: "reverification-admission-test",
    decisionRefs: [],
    reasonCode: "legacy_memory_imported",
    explanation: "A migrated harness record remains supported by additive v2 policy state.",
    now: LAST_VERIFIED_AT,
  });
  ensureMemoryV2EvidenceVerifiedTrust({
    recordId: record.recordId,
    recordVersion: record.recordVersion,
    orgId: context.orgA.id,
    projectId: context.projectA,
    evidenceVerifiedAt: LAST_VERIFIED_AT,
    now: ADMISSION_AT,
  });
  return { recordId: record.recordId, recordVersion: record.recordVersion, plane: "harness" };
}

function policyCount(target: SeededTarget): number {
  return Number((db.prepare(
    `SELECT COUNT(*) AS count FROM memory_v2_reverification_policies
     WHERE record_id = ? AND record_version = ?`,
  ).get(target.recordId, target.recordVersion) as { count: number }).count);
}

beforeAll(async () => {
  context = await createMemoryTestContext();
});

afterAll(async () => {
  if (context) await context.app.close();
});

beforeEach(() => {
  savedEnvironment = new Map(POLICY_ENV_NAMES.map((name) => [name, process.env[name]]));
  for (const name of POLICY_ENV_NAMES) delete process.env[name];
  process.env.MEMORY_V2_REVERIFICATION_ENABLED = "1";
});

afterEach(() => {
  for (const name of POLICY_ENV_NAMES) {
    const value = savedEnvironment.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe.sequential("memory v2 reverification policy admission", () => {
  it("uses explicit conservative defaults and rejects malformed operator overrides", () => {
    expect(memoryV2ReverificationEnabled({})).toBe(false);
    expect(memoryV2ReverificationEnabled({ MEMORY_V2_REVERIFICATION_ENABLED: "1" })).toBe(true);
    expect(memoryV2ReverificationAdmissionConfig({})).toEqual({
      intervalSeconds: 86_400,
      maxAgeSeconds: 604_800,
      maxAttempts: 5,
      maxAdmissionRecords: 10_000,
    });
    expect(() => memoryV2ReverificationAdmissionConfig({
      MEMORY_V2_REVERIFICATION_POLICY_INTERVAL_SECONDS: "59",
    })).toThrow(MemoryV2ReverificationAdmissionError);
    expect(() => memoryV2ReverificationAdmissionConfig({
      MEMORY_V2_REVERIFICATION_POLICY_INTERVAL_SECONDS: "3600",
      MEMORY_V2_REVERIFICATION_POLICY_MAX_AGE_SECONDS: "3599",
    })).toThrow(/must be at least/);
  });

  it("atomically enrolls evidence-verified code and harness rows from trust time and replays without revisions", () => {
    const code = seedCode("migrated-code");
    const harness = seedHarness("migrated-harness");
    const first = reconcileMemoryV2ReverificationAdmissions({
      now: ADMISSION_AT,
      createdBy: "migration-admission-test",
    });
    expect(first.missingRecordCount).toBeGreaterThanOrEqual(2);
    expect(first.admittedRecordCount).toBe(first.missingRecordCount);
    expect(first.codebaseAdmittedCount).toBeGreaterThanOrEqual(1);
    expect(first.harnessAdmittedCount).toBeGreaterThanOrEqual(1);
    const rows = db.prepare(
      `SELECT state.record_id, state.last_verified_at, state.next_reverify_at,
              state.status, state.influence_eligible,
              policy.resolver_type, policy.policy_revision, policy.created_by
       FROM memory_v2_reverification_state AS state
       JOIN memory_v2_reverification_policies AS policy
         ON policy.policy_id = state.policy_id
       WHERE state.record_id IN (?, ?)
       ORDER BY state.record_id`,
    ).all(code.recordId, harness.recordId) as unknown as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        record_id: code.recordId,
        last_verified_at: LAST_VERIFIED_AT,
        next_reverify_at: "2026-08-02T00:00:00.000Z",
        status: "fresh",
        influence_eligible: 1,
        resolver_type: "github",
        policy_revision: 1,
        created_by: "migration-admission-test",
      }),
      expect.objectContaining({
        record_id: harness.recordId,
        last_verified_at: LAST_VERIFIED_AT,
        next_reverify_at: "2026-08-02T00:00:00.000Z",
        status: "fresh",
        influence_eligible: 1,
        resolver_type: "runtime_attestation",
        policy_revision: 1,
        created_by: "migration-admission-test",
      }),
    ]));

    expect(ensureMemoryV2ReverificationAdmission({
      recordId: code.recordId,
      recordVersion: code.recordVersion,
      createdBy: "activation-replay-test",
      now: ADMISSION_AT,
    }).admitted).toBe(false);
    expect(ensureMemoryV2ReverificationAdmission({
      recordId: harness.recordId,
      recordVersion: harness.recordVersion,
      createdBy: "activation-replay-test",
      now: ADMISSION_AT,
    }).admitted).toBe(false);
    expect(reconcileMemoryV2ReverificationAdmissions({ now: ADMISSION_AT })).toMatchObject({
      missingRecordCount: 0,
      admittedRecordCount: 0,
    });
    expect(policyCount(code)).toBe(1);
    expect(policyCount(harness)).toBe(1);
  });

  it("never auto-enrolls a trusted legacy-cutover record when the worker is enabled", () => {
    const legacy = seedCode("legacy-cutover-not-enrolled");
    const binding = db.prepare(
      `SELECT trust.org_id, trust.project_id, trust.plane, trust.resource_row_id
       FROM memory_v2_record_trust AS trust
       WHERE trust.record_id = ? AND trust.record_version = ?`,
    ).get(legacy.recordId, legacy.recordVersion) as {
      org_id: string;
      project_id: string;
      plane: string;
      resource_row_id: string;
    };
    db.prepare(
      "DELETE FROM memory_v2_record_trust WHERE record_id = ? AND record_version = ?",
    ).run(legacy.recordId, legacy.recordVersion);
    db.prepare(
      `INSERT INTO memory_v2_record_trust (
         record_id, record_version, org_id, project_id, plane, resource_row_id,
         trust_status, trust_basis, cutover_decided_at, evidence_verified_at,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'trusted', 'legacy_cutover', ?, NULL, ?, ?)`,
    ).run(
      legacy.recordId,
      legacy.recordVersion,
      binding.org_id,
      binding.project_id,
      binding.plane,
      binding.resource_row_id,
      LAST_VERIFIED_AT,
      LAST_VERIFIED_AT,
      LAST_VERIFIED_AT,
    );

    expect(reconcileMemoryV2ReverificationAdmissions({ now: ADMISSION_AT })).toMatchObject({
      missingRecordCount: 0,
      admittedRecordCount: 0,
    });
    expect(policyCount(legacy)).toBe(0);
    expect(getMemoryV2RecordTrust(legacy.recordId, legacy.recordVersion)).toMatchObject({
      trustStatus: "trusted",
      trustBasis: "legacy_cutover",
      evidenceVerifiedAt: null,
    });
  });

  it("closes current v2 state and open jobs in the canonical external lifecycle transaction", () => {
    const target = seedCode("external-lifecycle");
    ensureMemoryV2ReverificationAdmission({
      recordId: target.recordId,
      recordVersion: target.recordVersion,
      createdBy: "external-lifecycle-test",
      now: ADMISSION_AT,
    });
    expect(scheduleDueMemoryV2Reverifications({
      now: ADMISSION_AT,
      maxJobs: 100,
      enabled: true,
    })).toBeGreaterThan(0);
    expect(db.prepare(
      `SELECT status FROM memory_v2_reverification_jobs
       WHERE record_id = ? AND record_version = ?`,
    ).get(target.recordId, target.recordVersion)).toEqual({ status: "pending" });

    transitionMemoryRecordStatus({
      orgId: context.orgA.id,
      projectId: context.projectA,
      recordId: target.recordId,
      toStatus: "revoked",
      actorId: "external-lifecycle-test",
      reasonCode: "external_authority_revoked",
      explanation: "An external canonical lifecycle path retired this exact active version.",
      expectedCurrentVersion: target.recordVersion,
      expectedCurrentStatus: "active",
      now: ADMISSION_AT,
      canonicalResult: true,
    });
    expect(db.prepare(
      `SELECT status, influence_eligible, last_error_code
       FROM memory_v2_reverification_state
       WHERE record_id = ? AND record_version = ?`,
    ).get(target.recordId, target.recordVersion)).toEqual({
      status: "withdrawn",
      influence_eligible: 0,
      last_error_code: "canonical_lifecycle_revoked",
    });
    expect(getMemoryV2RecordTrust(target.recordId, target.recordVersion)).toMatchObject({
      trustStatus: "untrusted",
      trustBasis: "evidence_verified",
    });
    expect(db.prepare(
      `SELECT status, lease_owner, lease_expires_at, last_error_code
       FROM memory_v2_reverification_jobs
       WHERE record_id = ? AND record_version = ?`,
    ).get(target.recordId, target.recordVersion)).toEqual({
      status: "dead_letter",
      lease_owner: null,
      lease_expires_at: null,
      last_error_code: "canonical_lifecycle_revoked",
    });
    expect(policyCount(target)).toBe(1);
    expect(reconcileMemoryV2Reverification()).toMatchObject({
      graphMismatchCount: 0,
      digestMismatchCount: 0,
      foreignKeyViolationCount: 0,
      ok: true,
    });
  });

  it("pre-counts the startup cap and rolls back the whole missing-record batch", () => {
    const code = seedCode("bounded-cap-code");
    const harness = seedHarness("bounded-cap-harness");
    process.env.MEMORY_V2_REVERIFICATION_ADMISSION_MAX_RECORDS = "1";
    expect(() => reconcileMemoryV2ReverificationAdmissions({ now: ADMISSION_AT }))
      .toThrow(/exceeding the configured cap/);
    expect(policyCount(code)).toBe(0);
    expect(policyCount(harness)).toBe(0);
    expect((db.prepare(
      `SELECT COUNT(*) AS count FROM memory_v2_reverification_state
       WHERE record_id IN (?, ?)`,
    ).get(code.recordId, harness.recordId) as { count: number }).count).toBe(0);
  });

  it("wires the concrete production provider into every live scheduler pass", () => {
    const source = readFileSync(new URL("../../index.ts", import.meta.url), "utf8");
    expect(source).toContain(
      'import { memoryV2ProductionReverificationProvider } from "./services/memory-v2-reverification-provider.js";',
    );
    expect(source).toContain("memoryV2ReverificationEnabled");
    expect(source).toMatch(
      /runMemoryV2ReverificationPass\(\{[\s\S]*?provider:\s*memoryV2ProductionReverificationProvider,[\s\S]*?\}\)/,
    );
  });
});
