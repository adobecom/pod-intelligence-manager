import { randomUUID } from "node:crypto";
import {
  canonicalJsonSha256,
  parseMemoryContractV2,
  type MemoryReadinessV2,
  type ResourceBindingV2,
} from "@pim/shared";
import db, { withImmediateTransaction } from "../db/connection.js";
import { recordMemoryMetric } from "./memory-metrics.js";
import {
  MemoryRecordConflictError,
  transitionMemoryRecordStatus,
} from "./memory-records.js";
import { markMemoryV2RecordUntrusted } from "./memory-v2-trust.js";

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

export type MemoryV2Plane = "codebase" | "harness";
export type MemoryV2ResolverType = "github" | "runtime_attestation";
export type MemoryV2ReverificationStatus =
  | "fresh"
  | "due"
  | "pending"
  | "contradicted"
  | "withdrawn"
  | "expired";

export interface MemoryV2ReverificationPolicyInput {
  recordId: string;
  recordVersion: number;
  orgId: string;
  projectId: string;
  plane: MemoryV2Plane;
  resourceRowId: string;
  resolverType: MemoryV2ResolverType;
  intervalSeconds: number;
  maxAgeSeconds: number;
  maxAttempts: number;
  active?: boolean;
  createdBy: string;
  lastVerifiedAt: string;
  now?: string;
}

export interface MemoryV2ReverificationPolicy {
  policyId: string;
  policyRevision: number;
  policyDigest: string;
  nextReverifyAt: string;
}

export type MemoryV2ReverificationProviderResult =
  | {
      outcome: "verified";
      verifiedAt: string;
      evidenceDigest: string;
      sourceOccurredAt?: string;
    }
  | {
      outcome: "contradicted" | "withdrawn" | "expired";
      evidenceDigest: string;
      sourceOccurredAt: string;
      reasonCode: string;
    }
  | {
      outcome: "unavailable";
      errorCode: string;
    };

export interface MemoryV2ReverificationProviderContext {
  recordId: string;
  recordVersion: number;
  orgId: string;
  projectId: string;
  plane: MemoryV2Plane;
  resourceRowId: string;
  resolverType: MemoryV2ResolverType;
  policyRevision: number;
  attemptNumber: number;
  attemptedAt: string;
}

export type MemoryV2ReverificationProvider = (
  context: MemoryV2ReverificationProviderContext,
) => Promise<MemoryV2ReverificationProviderResult>;

export interface MemoryV2ReverificationPassResult {
  enabled: boolean;
  scheduled: number;
  claimed: number;
  verified: number;
  retired: number;
  pending: number;
  deadLettered: number;
}

export interface MemoryV2ReverificationHealth {
  recordId: string;
  recordVersion: number;
  status: MemoryV2ReverificationStatus | "missing";
  influenceEligible: boolean;
  healthy: boolean;
  policyRevision: number | null;
  lastVerifiedAt: string | null;
  nextReverifyAt: string | null;
  latestDecisionId: string | null;
}

export class MemoryV2ReverificationError extends Error {
  constructor(
    message: string,
    readonly code:
      | "schema_invalid"
      | "resource_binding_mismatch"
      | "idempotency_conflict"
      | "transition_invalid",
  ) {
    super(message);
    this.name = "MemoryV2ReverificationError";
  }
}

interface PolicyRow {
  policy_id: string;
  record_id: string;
  record_version: number;
  org_id: string;
  project_id: string;
  plane: MemoryV2Plane;
  resource_row_id: string;
  resolver_type: MemoryV2ResolverType;
  policy_revision: number;
  interval_seconds: number;
  max_age_seconds: number;
  max_attempts: number;
  active: number;
  policy_digest: string;
}

interface StateRow {
  record_id: string;
  record_version: number;
  org_id: string;
  project_id: string;
  plane: MemoryV2Plane;
  resource_row_id: string;
  policy_id: string;
  policy_revision: number;
  state_version: number;
  status: MemoryV2ReverificationStatus;
  influence_eligible: number;
  last_verified_at: string | null;
  next_reverify_at: string;
  last_attempt_at: string | null;
  consecutive_failures: number;
  last_error_code: string | null;
  latest_decision_id: string | null;
  updated_at: string;
}

interface JobRow {
  job_id: string;
  record_id: string;
  record_version: number;
  org_id: string;
  project_id: string;
  plane: MemoryV2Plane;
  resource_row_id: string;
  policy_id: string;
  policy_revision: number;
  expected_state_version: number;
  scheduled_for: string;
  status: "pending" | "leased" | "completed" | "dead_letter";
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  updated_at: string;
}

interface ClaimedJob extends JobRow {
  attemptedAt: string;
  recoveredExpiredLease: boolean;
}

interface CanonicalRecordRow {
  record_id: string;
  current_version: number;
  current_status: "active" | "stale" | "superseded" | "revoked" | "expired";
  plane: MemoryV2Plane;
  org_id: string;
  project_id: string;
  expires_at: string | null;
}

export type MemoryV2ReverificationCommitStage =
  | "after_decision"
  | "after_lifecycle"
  | "after_state"
  | "after_job"
  | "after_attempt";

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function assertPositiveInteger(value: number, minimum: number, maximum = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new MemoryV2ReverificationError("Reverification policy bounds are invalid", "schema_invalid");
  }
}

function addSeconds(timestamp: string, seconds: number): string {
  return new Date(Date.parse(timestamp) + seconds * 1_000).toISOString();
}

function earlierTimestamp(left: string, right: string): string {
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

export function memoryV2ReverificationEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.MEMORY_V2_REVERIFICATION_ENABLED?.trim() === "1";
}

function canonicalRecord(input: Pick<MemoryV2ReverificationPolicyInput,
  "recordId" | "recordVersion" | "orgId" | "projectId" | "plane">): CanonicalRecordRow | null {
  return (db.prepare(
    `SELECT record_id, current_version, current_status, plane, org_id, project_id, expires_at
     FROM memory_records
     WHERE record_id = ? AND current_version = ? AND org_id = ? AND project_id = ?
       AND plane = ?`,
  ).get(
    input.recordId,
    input.recordVersion,
    input.orgId,
    input.projectId,
    input.plane,
  ) as CanonicalRecordRow | undefined) ?? null;
}

function assertFacet(input: Pick<MemoryV2ReverificationPolicyInput,
  "recordId" | "recordVersion" | "orgId" | "projectId" | "plane" | "resourceRowId">): void {
  const facet = db.prepare(
    `SELECT 1
     FROM memory_records AS record
     JOIN memory_v2_record_facets AS facet
       ON facet.record_id = record.record_id
      AND facet.record_version = record.current_version
     JOIN memory_v2_resources AS resource
       ON resource.resource_row_id = facet.resource_row_id
     WHERE record.record_id = ? AND record.current_version = ?
       AND record.org_id = ? AND record.project_id = ? AND record.plane = ?
       AND record.current_status = 'active'
       AND facet.org_id = record.org_id AND facet.project_id = record.project_id
       AND facet.plane = record.plane AND facet.resource_row_id = ?
       AND facet.projection_status = 'mapped'
       AND resource.org_id = record.org_id AND resource.project_id = record.project_id
       AND resource.plane = record.plane AND resource.valid_until IS NULL`,
  ).get(
    input.recordId,
    input.recordVersion,
    input.orgId,
    input.projectId,
    input.plane,
    input.resourceRowId,
  );
  if (!facet) {
    throw new MemoryV2ReverificationError(
      "Reverification policy target does not match a reconciled v2 record facet",
      "resource_binding_mismatch",
    );
  }
}

function latestPolicy(recordId: string, recordVersion: number): PolicyRow | null {
  return (db.prepare(
    `SELECT * FROM memory_v2_reverification_policies
     WHERE record_id = ? AND record_version = ?
     ORDER BY policy_revision DESC LIMIT 1`,
  ).get(recordId, recordVersion) as unknown as PolicyRow | undefined) ?? null;
}

export function createMemoryV2ReverificationPolicy(
  input: MemoryV2ReverificationPolicyInput,
): MemoryV2ReverificationPolicy {
  assertPositiveInteger(input.recordVersion, 1);
  assertPositiveInteger(input.intervalSeconds, 60);
  assertPositiveInteger(input.maxAgeSeconds, input.intervalSeconds);
  assertPositiveInteger(input.maxAttempts, 1, 64);
  if ((input.plane === "codebase" && input.resolverType !== "github")
      || (input.plane === "harness" && input.resolverType !== "runtime_attestation")) {
    throw new MemoryV2ReverificationError(
      "Reverification resolver does not match the target plane",
      "schema_invalid",
    );
  }
  if (!validTimestamp(input.lastVerifiedAt)) {
    throw new MemoryV2ReverificationError("lastVerifiedAt is invalid", "schema_invalid");
  }
  const now = input.now ?? new Date().toISOString();
  if (!validTimestamp(now)) {
    throw new MemoryV2ReverificationError("now is invalid", "schema_invalid");
  }
  if (Date.parse(input.lastVerifiedAt) > Date.parse(now)) {
    throw new MemoryV2ReverificationError("lastVerifiedAt cannot be in the future", "schema_invalid");
  }
  assertFacet(input);
  const targetRecord = canonicalRecord(input);
  if (!targetRecord || targetRecord.current_status !== "active") {
    throw new MemoryV2ReverificationError(
      "Reverification policy target is not the current active record version",
      "resource_binding_mismatch",
    );
  }

  return withImmediateTransaction(() => {
    const previous = latestPolicy(input.recordId, input.recordVersion);
    const revision = (previous?.policy_revision ?? 0) + 1;
    const active = input.active !== false;
    const policyBody = {
      schema_version: "pim.memory-v2-reverification-policy.v1",
      record_id: input.recordId,
      record_version: input.recordVersion,
      org_id: input.orgId,
      project_id: input.projectId,
      plane: input.plane,
      resource_row_id: input.resourceRowId,
      resolver_type: input.resolverType,
      policy_revision: revision,
      interval_seconds: input.intervalSeconds,
      max_age_seconds: input.maxAgeSeconds,
      max_attempts: input.maxAttempts,
      active,
    };
    const policyDigest = canonicalJsonSha256(policyBody);
    const policyId = `reverify_policy_${policyDigest.slice("sha256:".length, 47)}`;
    db.prepare(
      `INSERT INTO memory_v2_reverification_policies
         (policy_id, record_id, record_version, org_id, project_id, plane,
          resource_row_id, resolver_type, policy_revision, interval_seconds,
          max_age_seconds, max_attempts, active,
          policy_digest, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      policyId,
      input.recordId,
      input.recordVersion,
      input.orgId,
      input.projectId,
      input.plane,
      input.resourceRowId,
      input.resolverType,
      revision,
      input.intervalSeconds,
      input.maxAgeSeconds,
      input.maxAttempts,
      active ? 1 : 0,
      policyDigest,
      input.createdBy,
      now,
    );
    let nextReverifyAt = addSeconds(input.lastVerifiedAt, input.intervalSeconds);
    if (targetRecord.expires_at) {
      nextReverifyAt = earlierTimestamp(nextReverifyAt, targetRecord.expires_at);
    }
    const existing = db.prepare(
      `SELECT state_version, policy_id, last_verified_at, status, influence_eligible
       FROM memory_v2_reverification_state
       WHERE record_id = ? AND record_version = ?`,
    ).get(input.recordId, input.recordVersion) as {
      state_version: number;
      policy_id: string;
      last_verified_at: string | null;
      status: MemoryV2ReverificationStatus;
      influence_eligible: number;
    } | undefined;
    if (!existing) {
      db.prepare(
        `INSERT INTO memory_v2_reverification_state
           (record_id, record_version, org_id, project_id, plane, resource_row_id,
            policy_id, policy_revision, state_version, status, influence_eligible,
            last_verified_at, next_reverify_at, last_attempt_at,
            consecutive_failures, last_error_code,
            latest_decision_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'fresh', 1, ?, ?, NULL,
                 0, NULL, NULL, ?)`,
      ).run(
        input.recordId,
        input.recordVersion,
        input.orgId,
        input.projectId,
        input.plane,
        input.resourceRowId,
        policyId,
        revision,
        input.lastVerifiedAt,
        nextReverifyAt,
        now,
      );
    } else {
      db.prepare(
        `UPDATE memory_v2_reverification_jobs
         SET status = 'dead_letter', lease_owner = NULL, lease_expires_at = NULL,
             last_error_code = 'reverification_policy_superseded',
             dead_lettered_at = ?, updated_at = ?
         WHERE record_id = ? AND record_version = ?
           AND policy_id = ? AND status IN ('pending','leased')`,
      ).run(
        now,
        now,
        input.recordId,
        input.recordVersion,
        existing.policy_id,
      );
      let revisedNextAt = addSeconds(
        existing.last_verified_at ?? input.lastVerifiedAt,
        input.intervalSeconds,
      );
      if (targetRecord.expires_at) {
        revisedNextAt = earlierTimestamp(revisedNextAt, targetRecord.expires_at);
      }
      nextReverifyAt = revisedNextAt;
      const updated = db.prepare(
        `UPDATE memory_v2_reverification_state
         SET policy_id = ?, policy_revision = ?, state_version = state_version + 1,
             next_reverify_at = ?,
             updated_at = ?
         WHERE record_id = ? AND record_version = ? AND state_version = ?`,
      ).run(
        policyId,
        revision,
        revisedNextAt,
        now,
        input.recordId,
        input.recordVersion,
        existing.state_version,
      );
      if (updated.changes !== 1) {
        throw new MemoryV2ReverificationError(
          "Reverification state changed during policy admission",
          "idempotency_conflict",
        );
      }
    }
    return { policyId, policyRevision: revision, policyDigest, nextReverifyAt };
  });
}

function deterministicJobId(input: {
  recordId: string;
  recordVersion: number;
  policyRevision: number;
  expectedStateVersion: number;
  scheduledFor: string;
}): string {
  const digest = canonicalJsonSha256({
    record_id: input.recordId,
    record_version: input.recordVersion,
    policy_revision: input.policyRevision,
    expected_state_version: input.expectedStateVersion,
    scheduled_for: input.scheduledFor,
  });
  return `reverify_job_${digest.slice("sha256:".length, 47)}`;
}

export function scheduleDueMemoryV2Reverifications(input: {
  now?: string;
  maxJobs?: number;
  enabled?: boolean;
} = {}): number {
  if (!(input.enabled ?? memoryV2ReverificationEnabled())) return 0;
  const now = input.now ?? new Date().toISOString();
  if (!validTimestamp(now)) {
    throw new MemoryV2ReverificationError("now is invalid", "schema_invalid");
  }
  if (input.maxJobs !== undefined && !Number.isSafeInteger(input.maxJobs)) {
    throw new MemoryV2ReverificationError("maxJobs is invalid", "schema_invalid");
  }
  const maxJobs = Math.max(0, Math.min(input.maxJobs ?? 256, 1_000));
  return withImmediateTransaction(() => {
    const due = db.prepare(
      `SELECT state.*, policy.max_attempts,
              CASE
                WHEN record.expires_at IS NOT NULL
                 AND record.expires_at < state.next_reverify_at
                  THEN record.expires_at
                ELSE state.next_reverify_at
              END AS effective_due_at
       FROM memory_v2_reverification_state state
       INNER JOIN memory_v2_reverification_policies policy
         ON policy.policy_id = state.policy_id AND policy.active = 1
       INNER JOIN memory_records record
         ON record.record_id = state.record_id
        AND record.current_version = state.record_version
        AND record.current_status = 'active'
        AND record.org_id = state.org_id
        AND record.project_id = state.project_id
        AND record.plane = state.plane
       INNER JOIN memory_v2_record_facets facet
         ON facet.record_id = state.record_id
        AND facet.record_version = state.record_version
        AND facet.org_id = state.org_id
        AND facet.project_id = state.project_id
        AND facet.plane = state.plane
        AND facet.resource_row_id = state.resource_row_id
        AND facet.projection_status = 'mapped'
       INNER JOIN memory_v2_resources resource
         ON resource.resource_row_id = state.resource_row_id
        AND resource.org_id = state.org_id
        AND resource.project_id = state.project_id
        AND resource.plane = state.plane
        AND resource.valid_until IS NULL
       INNER JOIN memory_v2_record_trust trust
         ON trust.record_id = state.record_id
        AND trust.record_version = state.record_version
        AND trust.org_id = state.org_id
        AND trust.project_id = state.project_id
        AND trust.plane = state.plane
        AND trust.resource_row_id = state.resource_row_id
        AND trust.trust_status = 'trusted'
        AND trust.trust_basis = 'evidence_verified'
       WHERE state.status IN ('fresh','due','pending')
         AND (state.next_reverify_at <= ?
           OR (record.expires_at IS NOT NULL AND record.expires_at <= ?))
         AND NOT EXISTS (
           SELECT 1 FROM memory_v2_reverification_jobs job
           WHERE job.record_id = state.record_id
             AND job.record_version = state.record_version
             AND job.status IN ('pending','leased')
         )
       ORDER BY effective_due_at, state.record_id
       LIMIT ?`,
    ).all(now, now, maxJobs) as unknown as Array<StateRow & {
      max_attempts: number;
      effective_due_at: string;
    }>;
    const insert = db.prepare(
      `INSERT OR IGNORE INTO memory_v2_reverification_jobs
         (job_id, record_id, record_version, org_id, project_id, plane,
          resource_row_id, policy_id, policy_revision, expected_state_version,
          scheduled_for, status,
          attempt_count, max_attempts, next_attempt_at, lease_owner,
          lease_expires_at, last_error_code, created_at, updated_at,
          completed_at, dead_lettered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, NULL, NULL,
               NULL, ?, ?, NULL, NULL)`,
    );
    let scheduled = 0;
    const scheduledByPlane: Record<MemoryV2Plane, number> = {
      codebase: 0,
      harness: 0,
    };
    for (const row of due) {
      let expectedStateVersion = row.state_version;
      if (row.status === "fresh") {
        const dueUpdate = db.prepare(
          `UPDATE memory_v2_reverification_state
           SET status = 'due',
               next_reverify_at = CASE
                 WHEN next_reverify_at > ? THEN ? ELSE next_reverify_at END,
               state_version = state_version + 1, updated_at = ?
           WHERE record_id = ? AND record_version = ? AND state_version = ?
             AND status = 'fresh'`,
        ).run(
          row.effective_due_at,
          row.effective_due_at,
          now,
          row.record_id,
          row.record_version,
          row.state_version,
        );
        if (dueUpdate.changes !== 1) {
          throw new MemoryV2ReverificationError(
            "Reverification state changed during scheduling",
            "idempotency_conflict",
          );
        }
        expectedStateVersion += 1;
      }
      const result = insert.run(
        deterministicJobId({
          recordId: row.record_id,
          recordVersion: row.record_version,
          policyRevision: row.policy_revision,
          expectedStateVersion,
          scheduledFor: row.effective_due_at,
        }),
        row.record_id,
        row.record_version,
        row.org_id,
        row.project_id,
        row.plane,
        row.resource_row_id,
        row.policy_id,
        row.policy_revision,
        expectedStateVersion,
        row.effective_due_at,
        row.max_attempts,
        now,
        now,
        now,
      );
      if (result.changes === 1) {
        scheduled += 1;
        scheduledByPlane[row.plane] += 1;
      } else if (row.status === "fresh") {
        throw new MemoryV2ReverificationError(
          "Reverification job identity conflicted during scheduling",
          "idempotency_conflict",
        );
      }
    }
    for (const plane of ["codebase", "harness"] as const) {
      if (scheduledByPlane[plane] === 0) continue;
      recordMemoryMetric({
        name: "ReverificationDue",
        value: scheduledByPlane[plane],
        unit: "Count",
        dimensions: { plane },
        fields: { generated_at: now },
      });
    }
    return scheduled;
  });
}

function claimJob(input: { workerId: string; now: string; leaseMs: number }): ClaimedJob | null {
  return withImmediateTransaction(() => {
    const row = db.prepare(
      `SELECT * FROM memory_v2_reverification_jobs
       WHERE (status = 'pending' AND next_attempt_at <= ?)
          OR (status = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
       ORDER BY next_attempt_at, created_at, job_id LIMIT 1`,
    ).get(input.now, input.now) as unknown as JobRow | undefined;
    if (!row) return null;
    const recoveredExpiredLease = row.status === "leased";
    const leaseExpiresAt = new Date(Date.parse(input.now) + input.leaseMs).toISOString();
    const claimed = db.prepare(
      `UPDATE memory_v2_reverification_jobs
       SET status = 'leased',
           attempt_count = CASE
             WHEN status = 'pending' THEN attempt_count + 1
             ELSE attempt_count
           END,
           lease_owner = ?, lease_expires_at = ?, updated_at = ?
       WHERE job_id = ? AND (
         (status = 'pending' AND next_attempt_at <= ?)
         OR (status = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
       )`,
    ).run(
      input.workerId,
      leaseExpiresAt,
      input.now,
      row.job_id,
      input.now,
      input.now,
    );
    if (claimed.changes !== 1) return null;
    return {
      ...row,
      status: "leased",
      attempt_count: row.attempt_count + (row.status === "pending" ? 1 : 0),
      lease_owner: input.workerId,
      lease_expires_at: leaseExpiresAt,
      updated_at: input.now,
      attemptedAt: recoveredExpiredLease ? row.updated_at : input.now,
      recoveredExpiredLease,
    };
  });
}

async function unavailableProvider(): Promise<MemoryV2ReverificationProviderResult> {
  return { outcome: "unavailable", errorCode: "reverification_provider_unconfigured" };
}

async function resolveProviderWithinLease(
  providerCall: Promise<MemoryV2ReverificationProviderResult>,
  timeoutMs: number,
): Promise<MemoryV2ReverificationProviderResult> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      providerCall,
      new Promise<MemoryV2ReverificationProviderResult>((resolve) => {
        timer = setTimeout(() => resolve({
          outcome: "unavailable",
          errorCode: "reverification_provider_timeout",
        }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function safeErrorCode(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9_.:-]/g, "_");
  return (normalized || "reverification_provider_unavailable").slice(0, 128);
}

function normalizeProviderResult(
  result: MemoryV2ReverificationProviderResult,
  now: string,
): MemoryV2ReverificationProviderResult {
  const raw = result as unknown as Record<string, unknown> | null;
  const outcome = raw?.outcome;
  if (!raw || !["verified", "contradicted", "withdrawn", "expired", "unavailable"]
    .includes(String(outcome))) {
    return { outcome: "unavailable", errorCode: "reverification_provider_result_invalid" };
  }
  if (outcome === "unavailable") {
    return {
      outcome: "unavailable",
      errorCode: typeof raw.errorCode === "string"
        ? safeErrorCode(raw.errorCode)
        : "reverification_provider_result_invalid",
    };
  }
  if (typeof raw.evidenceDigest !== "string" || !SHA256_PATTERN.test(raw.evidenceDigest)) {
    return { outcome: "unavailable", errorCode: "reverification_evidence_digest_invalid" };
  }
  if (outcome === "verified") {
    if (typeof raw.verifiedAt !== "string"
        || !validTimestamp(raw.verifiedAt)
        || Date.parse(raw.verifiedAt) > Date.parse(now)) {
      return { outcome: "unavailable", errorCode: "reverification_verified_at_invalid" };
    }
    if (raw.sourceOccurredAt !== undefined
        && (typeof raw.sourceOccurredAt !== "string"
          || !validTimestamp(raw.sourceOccurredAt)
          || Date.parse(raw.sourceOccurredAt) > Date.parse(now))) {
      return { outcome: "unavailable", errorCode: "reverification_source_time_invalid" };
    }
    return {
      outcome: "verified",
      verifiedAt: raw.verifiedAt,
      evidenceDigest: raw.evidenceDigest,
      ...(typeof raw.sourceOccurredAt === "string"
        ? { sourceOccurredAt: raw.sourceOccurredAt }
        : {}),
    };
  }
  if (typeof raw.sourceOccurredAt !== "string"
      || !validTimestamp(raw.sourceOccurredAt)
      || Date.parse(raw.sourceOccurredAt) > Date.parse(now)
      || typeof raw.reasonCode !== "string"
      || !raw.reasonCode.trim()) {
    return { outcome: "unavailable", errorCode: "reverification_provider_result_invalid" };
  }
  return {
    outcome: outcome as "contradicted" | "withdrawn" | "expired",
    evidenceDigest: raw.evidenceDigest,
    sourceOccurredAt: raw.sourceOccurredAt,
    reasonCode: safeErrorCode(raw.reasonCode),
  };
}

function insertAttempt(input: {
  job: JobRow;
  workerId: string;
  outcome: "verified" | "contradicted" | "withdrawn" | "expired" | "retry" | "dead_letter";
  errorCode: string | null;
  startedAt: string;
  now: string;
}): void {
  const inserted = db.prepare(
    `INSERT INTO memory_v2_reverification_job_attempts
       (attempt_id, job_id, attempt_number, worker_id, outcome, error_code,
        started_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `reverify_attempt_${randomUUID()}`,
    input.job.job_id,
    input.job.attempt_count,
    input.workerId,
    input.outcome,
    input.errorCode,
    input.startedAt,
    input.now,
  );
  if (inserted.changes !== 1) {
    throw new MemoryV2ReverificationError(
      "Reverification attempt could not be committed",
      "idempotency_conflict",
    );
  }
}

function recordDecision(input: {
  job: JobRow;
  policy: PolicyRow;
  state: StateRow;
  toStatus: MemoryV2ReverificationStatus;
  providerOutcome: "verified" | "contradicted" | "withdrawn" | "expired" | "unavailable";
  reasonCode: string;
  evidenceDigest: string | null;
  sourceOccurredAt: string | null;
  canonicalToStatus: "active" | "stale" | "revoked" | "expired";
  attemptedAt: string;
  now: string;
}): string {
  const decisionBody = {
    schema_version: "pim.memory-v2-reverification-decision.v1",
    job_id: input.job.job_id,
    record_id: input.job.record_id,
    record_version: input.job.record_version,
    policy_revision: input.policy.policy_revision,
    attempt_number: input.job.attempt_count,
    expected_state_version: input.state.state_version,
    committed_state_version: input.state.state_version + 1,
    from_status: input.state.status,
    to_status: input.toStatus,
    provider_outcome: input.providerOutcome,
    reason_code: input.reasonCode,
    evidence_digest: input.evidenceDigest,
    source_occurred_at: input.sourceOccurredAt,
    canonical_from_status: "active",
    canonical_to_status: input.canonicalToStatus,
    attempted_at: input.attemptedAt,
  };
  const decisionDigest = canonicalJsonSha256(decisionBody);
  const decisionId = `reverify_decision_${decisionDigest.slice("sha256:".length, 47)}`;
  const inserted = db.prepare(
    `INSERT INTO memory_v2_reverification_decisions
       (decision_id, job_id, record_id, record_version, org_id, project_id,
        plane, resource_row_id, policy_id, policy_revision,
        expected_state_version, committed_state_version, from_status,
        to_status, provider_outcome, reason_code, evidence_digest,
        source_occurred_at, canonical_from_status, canonical_to_status,
        attempted_at, decided_at, decision_digest, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    decisionId,
    input.job.job_id,
    input.job.record_id,
    input.job.record_version,
    input.job.org_id,
    input.job.project_id,
    input.job.plane,
    input.job.resource_row_id,
    input.job.policy_id,
    input.job.policy_revision,
    input.state.state_version,
    input.state.state_version + 1,
    input.state.status,
    input.toStatus,
    input.providerOutcome,
    input.reasonCode,
    input.evidenceDigest,
    input.sourceOccurredAt,
    "active",
    input.canonicalToStatus,
    input.attemptedAt,
    input.now,
    decisionDigest,
    input.now,
  );
  if (inserted.changes !== 1) {
    throw new MemoryV2ReverificationError(
      "Reverification decision could not be committed",
      "idempotency_conflict",
    );
  }
  return decisionId;
}

interface FinalizeResult {
  outcome: "verified" | "retired" | "pending";
  jobDeadLettered: boolean;
  withdrawalLagSeconds: number | null;
}

function finalizeJob(input: {
  job: JobRow;
  workerId: string;
  attemptedAt: string;
  now: string;
  providerResult: MemoryV2ReverificationProviderResult;
  beforeCommit?: (stage: MemoryV2ReverificationCommitStage) => void;
}): FinalizeResult {
  try {
    return withImmediateTransaction(() => {
      const currentJob = db.prepare(
        "SELECT * FROM memory_v2_reverification_jobs WHERE job_id = ?",
      ).get(input.job.job_id) as unknown as JobRow | undefined;
      const state = db.prepare(
        `SELECT * FROM memory_v2_reverification_state
         WHERE record_id = ? AND record_version = ?`,
      ).get(input.job.record_id, input.job.record_version) as unknown as StateRow | undefined;
      const policy = db.prepare(
        "SELECT * FROM memory_v2_reverification_policies WHERE policy_id = ?",
      ).get(input.job.policy_id) as unknown as PolicyRow | undefined;
      const record = canonicalRecord({
        recordId: input.job.record_id,
        recordVersion: input.job.record_version,
        orgId: input.job.org_id,
        projectId: input.job.project_id,
        plane: input.job.plane,
      });
      if (!currentJob || currentJob.status !== "leased"
          || currentJob.lease_owner !== input.workerId
          || !currentJob.lease_expires_at
          || Date.parse(currentJob.lease_expires_at) <= Date.parse(input.now)
          || currentJob.attempt_count !== input.job.attempt_count
          || currentJob.expected_state_version !== input.job.expected_state_version
          || !state || state.state_version !== input.job.expected_state_version
          || state.policy_id !== input.job.policy_id
          || state.policy_revision !== input.job.policy_revision
          || !policy || policy.policy_id !== state.policy_id || policy.active !== 1
          || !record || record.current_status !== "active") {
        throw new MemoryV2ReverificationError(
          "Reverification job no longer matches current canonical state",
          "transition_invalid",
        );
      }
      assertFacet({
        recordId: input.job.record_id,
        recordVersion: input.job.record_version,
        orgId: input.job.org_id,
        projectId: input.job.project_id,
        plane: input.job.plane,
        resourceRowId: input.job.resource_row_id,
      });

      let providerResult = input.providerResult;
      if (record.expires_at && Date.parse(record.expires_at) <= Date.parse(input.now)) {
        providerResult = {
          outcome: "expired",
          evidenceDigest: canonicalJsonSha256({
            record_id: record.record_id,
            record_version: record.current_version,
            expires_at: record.expires_at,
          }),
          sourceOccurredAt: record.expires_at,
          reasonCode: "canonical_effective_time_expired",
        };
      } else if (providerResult.outcome === "verified" && state.last_verified_at
          && Date.parse(providerResult.verifiedAt) < Date.parse(state.last_verified_at)) {
        providerResult = {
          outcome: "unavailable",
          errorCode: "reverification_verified_at_regressed",
        };
      }

      const failureCount = state.consecutive_failures + 1;
      const attemptsExhausted = input.job.attempt_count >= input.job.max_attempts;
      const backoffSeconds = Math.min(60, 2 ** Math.max(0, input.job.attempt_count - 1));
      const nextAttemptAt = addSeconds(input.now, backoffSeconds);

      let stateStatus: MemoryV2ReverificationStatus;
      let influenceEligible: number;
      let lastVerifiedAt = state.last_verified_at;
      let nextReverifyAt: string;
      let consecutiveFailures = 0;
      let lastErrorCode: string | null = null;
      let providerOutcome: "verified" | "contradicted" | "withdrawn" | "expired" | "unavailable";
      let reasonCode: string;
      let evidenceDigest: string | null = null;
      let sourceOccurredAt: string | null = null;
      let canonicalToStatus: "active" | "stale" | "revoked" | "expired" = "active";
      let jobStatus: "pending" | "completed" | "dead_letter" = "completed";
      let attemptOutcome: "verified" | "contradicted" | "withdrawn" | "expired" | "retry" | "dead_letter";
      let jobErrorCode: string | null = null;
      let resultOutcome: FinalizeResult["outcome"];

      if (providerResult.outcome === "verified") {
        stateStatus = "fresh";
        influenceEligible = 1;
        lastVerifiedAt = providerResult.verifiedAt;
        nextReverifyAt = addSeconds(providerResult.verifiedAt, policy.interval_seconds);
        if (record.expires_at) {
          nextReverifyAt = earlierTimestamp(nextReverifyAt, record.expires_at);
        }
        providerOutcome = "verified";
        reasonCode = "authoritative_evidence_verified";
        evidenceDigest = providerResult.evidenceDigest;
        sourceOccurredAt = providerResult.sourceOccurredAt ?? null;
        attemptOutcome = "verified";
        resultOutcome = "verified";
      } else if (providerResult.outcome !== "unavailable") {
        stateStatus = providerResult.outcome;
        influenceEligible = 0;
        nextReverifyAt = input.now;
        providerOutcome = providerResult.outcome;
        reasonCode = providerResult.reasonCode;
        evidenceDigest = providerResult.evidenceDigest;
        sourceOccurredAt = providerResult.sourceOccurredAt;
        canonicalToStatus = providerResult.outcome === "expired" ? "expired" : "revoked";
        attemptOutcome = providerResult.outcome;
        resultOutcome = "retired";
      } else {
        stateStatus = "pending";
        influenceEligible = 1;
        nextReverifyAt = nextAttemptAt;
        consecutiveFailures = failureCount;
        lastErrorCode = providerResult.errorCode;
        providerOutcome = "unavailable";
        reasonCode = providerResult.errorCode;
        canonicalToStatus = "active";
        jobStatus = attemptsExhausted ? "dead_letter" : "pending";
        attemptOutcome = jobStatus === "dead_letter" ? "dead_letter" : "retry";
        jobErrorCode = providerResult.errorCode;
        resultOutcome = "pending";
      }

      const decisionId = recordDecision({
        job: input.job,
        policy,
        state,
        toStatus: stateStatus,
        providerOutcome,
        reasonCode,
        evidenceDigest,
        sourceOccurredAt,
        canonicalToStatus,
        attemptedAt: input.attemptedAt,
        now: input.now,
      });
      input.beforeCommit?.("after_decision");

      if (canonicalToStatus !== "active") {
        markMemoryV2RecordUntrusted({
          recordId: input.job.record_id,
          recordVersion: input.job.record_version,
          now: input.now,
        });
        const transitioned = transitionMemoryRecordStatus({
          orgId: input.job.org_id,
          projectId: input.job.project_id,
          recordId: input.job.record_id,
          toStatus: canonicalToStatus,
          actorId: input.workerId,
          reasonCode,
          explanation: "Canonical memory retired by the scheduled reverification policy.",
          expectedCurrentVersion: input.job.record_version,
          expectedCurrentStatus: "active",
          decisionRefs: [decisionId],
          policyVersion: `memory-v2-reverification:${policy.policy_revision}`,
          now: input.now,
          canonicalResult: true,
        });
        if (!transitioned || transitioned.toStatus !== canonicalToStatus) {
          throw new MemoryV2ReverificationError(
            "Canonical memory lifecycle transition did not commit",
            "transition_invalid",
          );
        }
      }
      input.beforeCommit?.("after_lifecycle");

      const stateUpdated = db.prepare(
        `UPDATE memory_v2_reverification_state
         SET state_version = state_version + 1, status = ?, influence_eligible = ?,
             last_verified_at = ?, next_reverify_at = ?, last_attempt_at = ?,
             consecutive_failures = ?,
             last_error_code = ?, latest_decision_id = ?, updated_at = ?
         WHERE record_id = ? AND record_version = ? AND state_version = ?
           AND policy_id = ? AND policy_revision = ?`,
      ).run(
        stateStatus,
        influenceEligible,
        lastVerifiedAt,
        nextReverifyAt,
        input.now,
        consecutiveFailures,
        lastErrorCode,
        decisionId,
        input.now,
        state.record_id,
        state.record_version,
        state.state_version,
        state.policy_id,
        state.policy_revision,
      );
      if (stateUpdated.changes !== 1) {
        throw new MemoryV2ReverificationError(
          "Reverification state changed before commit",
          "idempotency_conflict",
        );
      }
      input.beforeCommit?.("after_state");

      const completedAt = jobStatus === "completed" ? input.now : null;
      const deadLetteredAt = jobStatus === "dead_letter" ? input.now : null;
      const jobUpdated = db.prepare(
        `UPDATE memory_v2_reverification_jobs
         SET expected_state_version = ?, status = ?, lease_owner = NULL,
             lease_expires_at = NULL, next_attempt_at = ?, last_error_code = ?,
             completed_at = ?, dead_lettered_at = ?, updated_at = ?
         WHERE job_id = ? AND status = 'leased' AND lease_owner = ?
           AND attempt_count = ? AND expected_state_version = ?`,
      ).run(
        state.state_version + 1,
        jobStatus,
        nextReverifyAt,
        jobErrorCode,
        completedAt,
        deadLetteredAt,
        input.now,
        input.job.job_id,
        input.workerId,
        input.job.attempt_count,
        input.job.expected_state_version,
      );
      if (jobUpdated.changes !== 1) {
        throw new MemoryV2ReverificationError(
          "Reverification lease changed before commit",
          "idempotency_conflict",
        );
      }
      input.beforeCommit?.("after_job");
      insertAttempt({
        job: input.job,
        workerId: input.workerId,
        outcome: attemptOutcome,
        errorCode: jobErrorCode,
        startedAt: input.attemptedAt,
        now: input.now,
      });
      input.beforeCommit?.("after_attempt");

      return {
        outcome: resultOutcome,
        jobDeadLettered: jobStatus === "dead_letter",
        withdrawalLagSeconds: providerResult.outcome === "withdrawn"
          ? Math.max(0, Math.floor(
            (Date.parse(input.now) - Date.parse(providerResult.sourceOccurredAt)) / 1_000,
          ))
          : null,
      };
    });
  } catch (error) {
    if (error instanceof MemoryV2ReverificationError) throw error;
    if (error instanceof MemoryRecordConflictError) {
      throw new MemoryV2ReverificationError(error.message, "transition_invalid");
    }
    throw error;
  }
}

function emitAttemptMetric(job: JobRow): void {
  recordMemoryMetric({
    name: "ReverificationAttempt",
    value: 1,
    unit: "Count",
    dimensions: { plane: job.plane },
    fields: {
      org_id: job.org_id,
      project_id: job.project_id,
      resource_row_id: job.resource_row_id,
      record_id: job.record_id,
    },
  });
}

export async function runMemoryV2ReverificationPass(input: {
  now?: string;
  workerId?: string;
  maxJobs?: number;
  leaseMs?: number;
  enabled?: boolean;
  provider?: MemoryV2ReverificationProvider;
  beforeCommit?: (stage: MemoryV2ReverificationCommitStage) => void;
} = {}): Promise<MemoryV2ReverificationPassResult> {
  const enabled = input.enabled ?? memoryV2ReverificationEnabled();
  const result: MemoryV2ReverificationPassResult = {
    enabled,
    scheduled: 0,
    claimed: 0,
    verified: 0,
    retired: 0,
    pending: 0,
    deadLettered: 0,
  };
  if (!enabled) return result;
  const scheduleNow = input.now ?? new Date().toISOString();
  if (!validTimestamp(scheduleNow)) {
    throw new MemoryV2ReverificationError("now is invalid", "schema_invalid");
  }
  if (input.maxJobs !== undefined && !Number.isSafeInteger(input.maxJobs)) {
    throw new MemoryV2ReverificationError("maxJobs is invalid", "schema_invalid");
  }
  if (input.leaseMs !== undefined && !Number.isSafeInteger(input.leaseMs)) {
    throw new MemoryV2ReverificationError("leaseMs is invalid", "schema_invalid");
  }
  const maxJobs = Math.max(0, Math.min(input.maxJobs ?? 32, 256));
  const workerId = (input.workerId?.trim() || `memory-v2-reverification-${randomUUID()}`)
    .slice(0, 128);
  const leaseMs = Math.max(1_000, Math.min(input.leaseMs ?? 30_000, 300_000));
  const provider = input.provider ?? unavailableProvider;
  result.scheduled = scheduleDueMemoryV2Reverifications({
    now: scheduleNow,
    maxJobs,
    enabled,
  });

  for (let index = 0; index < maxJobs; index += 1) {
    const attemptNow = input.now ?? new Date().toISOString();
    const job = claimJob({ workerId, now: attemptNow, leaseMs });
    if (!job) break;
    result.claimed += 1;
    if (!job.recoveredExpiredLease) emitAttemptMetric(job);
    const policy = db.prepare(
      "SELECT * FROM memory_v2_reverification_policies WHERE policy_id = ?",
    ).get(job.policy_id) as unknown as PolicyRow;
    let providerResult: MemoryV2ReverificationProviderResult;
    if (job.recoveredExpiredLease) {
      providerResult = {
        outcome: "unavailable",
        errorCode: "reverification_lease_expired",
      };
    } else {
      try {
        providerResult = normalizeProviderResult(await resolveProviderWithinLease(provider({
          recordId: job.record_id,
          recordVersion: job.record_version,
          orgId: job.org_id,
          projectId: job.project_id,
          plane: job.plane,
          resourceRowId: job.resource_row_id,
          resolverType: policy.resolver_type,
          policyRevision: job.policy_revision,
          attemptNumber: job.attempt_count,
          attemptedAt: job.attemptedAt,
        }), Math.max(100, Math.min(10_000, Math.floor(leaseMs / 2)))),
        input.now ?? new Date().toISOString());
      } catch {
        providerResult = { outcome: "unavailable", errorCode: "reverification_provider_unavailable" };
      }
    }
    const finalized = finalizeJob({
      job,
      workerId,
      attemptedAt: job.attemptedAt,
      now: input.now ?? new Date().toISOString(),
      providerResult,
      beforeCommit: input.beforeCommit,
    });
    if (finalized.outcome === "verified") result.verified += 1;
    else if (finalized.outcome === "retired") result.retired += 1;
    else result.pending += 1;
    if (finalized.jobDeadLettered) result.deadLettered += 1;
    recordMemoryMetric({
      name: finalized.outcome === "verified"
        ? "ReverificationSuccess"
        : "ReverificationFailure",
      value: 1,
      unit: "Count",
      dimensions: {
        plane: job.plane,
        outcome: finalized.jobDeadLettered ? "dead_letter" : finalized.outcome,
      },
      fields: { record_id: job.record_id, resource_row_id: job.resource_row_id },
    });
    if (finalized.jobDeadLettered) {
      recordMemoryMetric({
        name: "ReverificationDeadLetter",
        value: 1,
        unit: "Count",
        dimensions: { plane: job.plane, outcome: finalized.outcome },
        fields: { record_id: job.record_id, resource_row_id: job.resource_row_id },
      });
    }
    if (finalized.withdrawalLagSeconds !== null) {
      recordMemoryMetric({
        name: "SourceWithdrawalLagSeconds",
        value: finalized.withdrawalLagSeconds,
        unit: "Seconds",
        dimensions: { plane: job.plane, outcome: "withdrawn" },
        fields: { record_id: job.record_id, resource_row_id: job.resource_row_id },
      });
    }
  }
  return result;
}

export function getMemoryV2ReverificationHealth(input: {
  recordId: string;
  recordVersion: number;
  now?: string;
  reverificationEnabled?: boolean;
}): MemoryV2ReverificationHealth {
  const now = input.now ?? new Date().toISOString();
  if (!validTimestamp(now)) {
    throw new MemoryV2ReverificationError("now is invalid", "schema_invalid");
  }
  const row = db.prepare(
    `SELECT trust.trust_status, trust.trust_basis,
            state.status, state.influence_eligible, state.policy_revision,
            state.last_verified_at, state.next_reverify_at, state.latest_decision_id,
            policy.max_age_seconds,
            policy.active AS policy_active, record.current_status, record.expires_at
     FROM memory_v2_record_trust AS trust
     JOIN memory_records AS record
       ON record.record_id = trust.record_id
      AND record.current_version = trust.record_version
     LEFT JOIN memory_v2_reverification_state AS state
       ON state.record_id = trust.record_id
      AND state.record_version = trust.record_version
     LEFT JOIN memory_v2_reverification_policies AS policy
       ON policy.policy_id = state.policy_id
     WHERE trust.record_id = ? AND trust.record_version = ?`,
  ).get(input.recordId, input.recordVersion) as {
    trust_status: "trusted" | "untrusted";
    trust_basis: "legacy_cutover" | "evidence_verified";
    status: MemoryV2ReverificationStatus | null;
    influence_eligible: number | null;
    policy_revision: number | null;
    last_verified_at: string | null;
    next_reverify_at: string | null;
    latest_decision_id: string | null;
    max_age_seconds: number | null;
    policy_active: number | null;
    current_status: string;
    expires_at: string | null;
  } | undefined;
  if (!row) {
    return {
      recordId: input.recordId,
      recordVersion: input.recordVersion,
      status: "missing",
      influenceEligible: false,
      healthy: false,
      policyRevision: null,
      lastVerifiedAt: null,
      nextReverifyAt: null,
      latestDecisionId: null,
    };
  }
  const enabled = input.reverificationEnabled ?? memoryV2ReverificationEnabled();
  const currentlyEligible = row.trust_status === "trusted"
    && row.current_status === "active"
    && (!row.expires_at || Date.parse(row.expires_at) > Date.parse(now));
  if (row.trust_basis === "legacy_cutover" || !enabled) {
    return {
      recordId: input.recordId,
      recordVersion: input.recordVersion,
      status: currentlyEligible ? "fresh" : row.status ?? "missing",
      influenceEligible: currentlyEligible,
      healthy: currentlyEligible,
      policyRevision: row.policy_revision,
      lastVerifiedAt: row.trust_basis === "legacy_cutover" ? null : row.last_verified_at,
      nextReverifyAt: row.next_reverify_at,
      latestDecisionId: row.latest_decision_id,
    };
  }
  if (!row.status || !row.next_reverify_at || row.max_age_seconds === null) {
    return {
      recordId: input.recordId,
      recordVersion: input.recordVersion,
      status: "missing",
      influenceEligible: currentlyEligible,
      healthy: false,
      policyRevision: null,
      lastVerifiedAt: null,
      nextReverifyAt: null,
      latestDecisionId: null,
    };
  }
  const effectiveNextReverifyAt = row.expires_at
    ? earlierTimestamp(row.next_reverify_at, row.expires_at)
    : row.next_reverify_at;
  const dynamicallyDue = row.status === "fresh" && (
    Date.parse(effectiveNextReverifyAt) <= Date.parse(now)
    || row.last_verified_at === null
    || Date.parse(addSeconds(row.last_verified_at, row.max_age_seconds)) <= Date.parse(now)
  );
  const status = dynamicallyDue ? "due" : row.status;
  const healthy = currentlyEligible
    && status === "fresh"
    && row.influence_eligible === 1
    && row.last_verified_at !== null
    && row.policy_active === 1
    && Date.parse(effectiveNextReverifyAt) > Date.parse(now);
  return {
    recordId: input.recordId,
    recordVersion: input.recordVersion,
    status,
    influenceEligible: currentlyEligible,
    healthy,
    policyRevision: row.policy_revision,
    lastVerifiedAt: row.last_verified_at,
    nextReverifyAt: effectiveNextReverifyAt,
    latestDecisionId: row.latest_decision_id,
  };
}

interface ReadinessRecordRow {
  trust_status: "trusted" | "untrusted" | null;
  trust_basis: "legacy_cutover" | "evidence_verified" | null;
  status: MemoryV2ReverificationStatus | null;
  influence_eligible: number | null;
  last_verified_at: string | null;
  next_reverify_at: string | null;
  max_age_seconds: number | null;
  policy_active: number | null;
  expires_at: string | null;
}

/**
 * Produces the bounded resource-level readiness view consumed by both HTTP and
 * restricted MCP. It deliberately exposes counts and timestamps only; jobs,
 * provider evidence, decision bodies, and identities stay private.
 */
export function getMemoryV2Readiness(input: {
  orgId: string;
  projectId: string;
  plane: MemoryV2Plane;
  resourceBinding: ResourceBindingV2;
  checkedAt?: string;
  reverificationEnabled?: boolean;
}): MemoryReadinessV2 {
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  if (!validTimestamp(checkedAt)) {
    throw new MemoryV2ReverificationError("checkedAt is invalid", "schema_invalid");
  }
  const expectedResourceType = input.plane === "codebase" ? "repository" : "harness";
  if (input.resourceBinding.organization_id !== input.orgId
      || input.resourceBinding.project_id !== input.projectId
      || input.resourceBinding.plane !== input.plane
      || input.resourceBinding.resource_type !== expectedResourceType
      || !input.resourceBinding.permitted_operations.includes("readiness")) {
    throw new MemoryV2ReverificationError(
      "Readiness resource binding does not match the requested scope",
      "resource_binding_mismatch",
    );
  }

  const records = db.prepare(
    `SELECT trust.trust_status, trust.trust_basis,
            state.status, state.influence_eligible, state.last_verified_at,
            state.next_reverify_at, policy.max_age_seconds,
            policy.active AS policy_active, record.expires_at
     FROM memory_records AS record
     JOIN memory_v2_record_facets AS facet
       ON facet.record_id = record.record_id
      AND facet.record_version = record.current_version
      AND facet.org_id = record.org_id
      AND facet.project_id = record.project_id
      AND facet.plane = record.plane
      AND facet.projection_status = 'mapped'
     LEFT JOIN memory_v2_record_trust AS trust
       ON trust.record_id = record.record_id
      AND trust.record_version = record.current_version
      AND trust.org_id = record.org_id
      AND trust.project_id = record.project_id
      AND trust.plane = record.plane
      AND trust.resource_row_id = facet.resource_row_id
     LEFT JOIN memory_v2_reverification_state AS state
       ON state.record_id = record.record_id
      AND state.record_version = record.current_version
     LEFT JOIN memory_v2_reverification_policies AS policy
       ON policy.policy_id = state.policy_id
     WHERE record.org_id = ? AND record.project_id = ? AND record.plane = ?
       AND facet.resource_row_id = ? AND record.current_status = 'active'
       AND record.valid_from <= ?
       AND (record.valid_until IS NULL OR record.valid_until > ?)
       AND (record.expires_at IS NULL OR record.expires_at > ?)`,
  ).all(
    input.orgId,
    input.projectId,
    input.plane,
    input.resourceBinding.resource_row_id,
    checkedAt,
    checkedAt,
    checkedAt,
  ) as unknown as ReadinessRecordRow[];

  let freshCount = 0;
  let dueCount = 0;
  let pendingCount = 0;
  let unavailableCount = 0;
  let inactivePolicyCount = 0;
  let oldestDueAt: string | null = null;
  const reverificationEnabled = input.reverificationEnabled
    ?? memoryV2ReverificationEnabled();
  for (const record of records) {
    if (record.trust_status !== "trusted" || record.trust_basis === null) {
      unavailableCount += 1;
      continue;
    }
    if (record.trust_basis === "legacy_cutover" || !reverificationEnabled) {
      freshCount += 1;
      continue;
    }
    if (!record.status || record.influence_eligible !== 1
        || !record.next_reverify_at || record.max_age_seconds === null) {
      unavailableCount += 1;
      continue;
    }
    if (record.policy_active !== 1) inactivePolicyCount += 1;
    const maxAgeAt = record.last_verified_at
      ? addSeconds(record.last_verified_at, record.max_age_seconds)
      : record.next_reverify_at;
    const effectiveNextAt = record.expires_at
      ? earlierTimestamp(record.next_reverify_at, record.expires_at)
      : record.next_reverify_at;
    const dynamicallyDue = record.status === "fresh" && (
      record.policy_active !== 1
      || Date.parse(effectiveNextAt) <= Date.parse(checkedAt)
      || Date.parse(maxAgeAt) <= Date.parse(checkedAt)
    );
    if (record.status === "pending") {
      pendingCount += 1;
    } else if (record.status === "due" || dynamicallyDue) {
      dueCount += 1;
      const dueAt = earlierTimestamp(effectiveNextAt, maxAgeAt);
      oldestDueAt = oldestDueAt === null ? dueAt : earlierTimestamp(oldestDueAt, dueAt);
    } else if (record.status === "fresh") {
      freshCount += 1;
    } else {
      unavailableCount += 1;
    }
  }

  const deadLetters = db.prepare(
    `SELECT COUNT(*) AS count, MIN(job.dead_lettered_at) AS oldest
     FROM memory_v2_reverification_jobs AS job
     JOIN memory_v2_reverification_state AS state
       ON state.record_id = job.record_id
      AND state.record_version = job.record_version
      AND state.policy_id = job.policy_id
      AND state.policy_revision = job.policy_revision
      AND state.state_version = job.expected_state_version
     JOIN memory_records AS record
       ON record.record_id = state.record_id
      AND record.current_version = state.record_version
      AND record.current_status = 'active'
     WHERE job.org_id = ? AND job.project_id = ? AND job.plane = ?
       AND job.resource_row_id = ? AND job.status = 'dead_letter'`,
  ).get(
    input.orgId,
    input.projectId,
    input.plane,
    input.resourceBinding.resource_row_id,
  ) as { count: number; oldest: string | null };
  const lastSuccess = db.prepare(
    `SELECT MAX(decided_at) AS last_success_at
     FROM memory_v2_reverification_decisions
     WHERE org_id = ? AND project_id = ? AND plane = ? AND resource_row_id = ?
       AND provider_outcome = 'verified'`,
  ).get(
    input.orgId,
    input.projectId,
    input.plane,
    input.resourceBinding.resource_row_id,
  ) as { last_success_at: string | null };

  const degraded = unavailableCount > 0 || (reverificationEnabled && (
    dueCount > 0
    || pendingCount > 0
    || deadLetters.count > 0
    || inactivePolicyCount > 0
  ));
  return parseMemoryContractV2("MemoryReadinessV2", {
    schema_version: "pim.memory-readiness.v2",
    tenant: { organization_id: input.orgId, project_id: input.projectId },
    plane: input.plane,
    resource_binding: input.resourceBinding,
    status: degraded ? "degraded" : "healthy",
    reverification_supported: true,
    worker_status: reverificationEnabled ? "running" : "disabled",
    fresh_count: freshCount,
    due_count: dueCount,
    pending_count: pendingCount,
    dead_letter_count: deadLetters.count,
    oldest_due_at: oldestDueAt,
    oldest_dead_letter_at: deadLetters.oldest,
    last_success_at: lastSuccess.last_success_at,
    checked_at: checkedAt,
  });
}
