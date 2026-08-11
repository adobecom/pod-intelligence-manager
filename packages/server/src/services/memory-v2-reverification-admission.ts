import db, { withImmediateTransaction } from "../db/connection.js";
import {
  createMemoryV2ReverificationPolicy,
  memoryV2ReverificationEnabled,
  type MemoryV2Plane,
  type MemoryV2ResolverType,
  type MemoryV2ReverificationPolicy,
} from "./memory-v2-reverification.js";

/**
 * Conservative initial-release policy. These are admission defaults, not
 * inferred properties of stored evidence, and operators may override them
 * only through the strictly validated environment variables below.
 */
export const MEMORY_V2_REVERIFICATION_POLICY_DEFAULTS = Object.freeze({
  intervalSeconds: 24 * 60 * 60,
  maxAgeSeconds: 7 * 24 * 60 * 60,
  maxAttempts: 5,
  maxAdmissionRecords: 10_000,
});

const POLICY_ENV = Object.freeze({
  intervalSeconds: "MEMORY_V2_REVERIFICATION_POLICY_INTERVAL_SECONDS",
  maxAgeSeconds: "MEMORY_V2_REVERIFICATION_POLICY_MAX_AGE_SECONDS",
  maxAttempts: "MEMORY_V2_REVERIFICATION_POLICY_MAX_ATTEMPTS",
  maxAdmissionRecords: "MEMORY_V2_REVERIFICATION_ADMISSION_MAX_RECORDS",
});

export interface MemoryV2ReverificationAdmissionConfig {
  intervalSeconds: number;
  maxAgeSeconds: number;
  maxAttempts: number;
  maxAdmissionRecords: number;
}

export interface MemoryV2ReverificationAdmissionResult {
  recordId: string;
  recordVersion: number;
  plane: MemoryV2Plane;
  resourceRowId: string;
  resolverType: MemoryV2ResolverType;
  policyId: string;
  policyRevision: number;
  policyDigest: string;
  nextReverifyAt: string;
  admitted: boolean;
}

export interface MemoryV2ReverificationAdmissionReconciliation {
  eligibleRecordCount: number;
  missingRecordCount: number;
  alreadyCoveredRecordCount: number;
  admittedRecordCount: number;
  codebaseAdmittedCount: number;
  harnessAdmittedCount: number;
  maxAdmissionRecords: number;
}

export class MemoryV2ReverificationAdmissionError extends Error {
  readonly code = "reverification_admission_invalid";

  constructor(message: string) {
    super(message);
    this.name = "MemoryV2ReverificationAdmissionError";
  }
}

interface AdmissionTargetRow {
  record_id: string;
  record_version: number;
  org_id: string;
  project_id: string;
  plane: MemoryV2Plane;
  resource_row_id: string;
  evidence_verified_at: string;
}

interface ExistingAdmissionRow {
  state_org_id: string;
  state_project_id: string;
  state_plane: MemoryV2Plane;
  state_resource_row_id: string;
  status: string;
  influence_eligible: number;
  policy_id: string | null;
  policy_revision: number;
  policy_digest: string | null;
  next_reverify_at: string;
  policy_record_id: string | null;
  policy_record_version: number | null;
  policy_org_id: string | null;
  policy_project_id: string | null;
  policy_plane: MemoryV2Plane | null;
  policy_resource_row_id: string | null;
  resolver_type: MemoryV2ResolverType | null;
  active: number | null;
}

const ADMISSION_TARGET_SQL = `
  SELECT record.record_id, record.current_version AS record_version,
         record.org_id, record.project_id, record.plane,
         facet.resource_row_id,
         trust.evidence_verified_at
  FROM memory_records AS record
  JOIN memory_v2_record_facets AS facet
    ON facet.record_id = record.record_id
   AND facet.record_version = record.current_version
  JOIN memory_v2_resources AS resource
    ON resource.resource_row_id = facet.resource_row_id
  JOIN memory_v2_record_trust AS trust
    ON trust.record_id = record.record_id
   AND trust.record_version = record.current_version
  WHERE record.record_id = ? AND record.current_version = ?
    AND record.current_status = 'active'
    AND record.plane IN ('codebase','harness')
    AND facet.org_id = record.org_id
    AND facet.project_id = record.project_id
    AND facet.plane = record.plane
    AND facet.projection_status = 'mapped'
    AND resource.org_id = record.org_id
    AND resource.project_id = record.project_id
    AND resource.plane = record.plane
    AND resource.valid_until IS NULL
    AND trust.org_id = record.org_id
    AND trust.project_id = record.project_id
    AND trust.plane = record.plane
    AND trust.resource_row_id = facet.resource_row_id
    AND trust.trust_status = 'trusted'
    AND trust.trust_basis = 'evidence_verified'
`;

const ELIGIBLE_RECORD_PREDICATE = `
  record.current_status = 'active'
  AND record.plane IN ('codebase','harness')
  AND trust.org_id = record.org_id
  AND trust.project_id = record.project_id
  AND trust.plane = record.plane
  AND trust.resource_row_id = facet.resource_row_id
  AND trust.trust_status = 'trusted'
  AND trust.trust_basis = 'evidence_verified'
`;

const MISSING_ADMISSION_PREDICATE = `
  NOT EXISTS (
    SELECT 1
    FROM memory_v2_reverification_state AS state
    WHERE state.record_id = record.record_id
      AND state.record_version = record.current_version
  )
`;

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function parseBoundedInteger(input: {
  env: NodeJS.ProcessEnv;
  name: string;
  fallback: number;
  minimum: number;
  maximum: number;
}): number {
  const raw = input.env[input.name];
  if (raw === undefined || raw.trim() === "") return input.fallback;
  if (!/^[0-9]+$/.test(raw.trim())) {
    throw new MemoryV2ReverificationAdmissionError(`${input.name} must be an integer`);
  }
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < input.minimum || value > input.maximum) {
    throw new MemoryV2ReverificationAdmissionError(
      `${input.name} must be between ${input.minimum} and ${input.maximum}`,
    );
  }
  return value;
}

export function memoryV2ReverificationAdmissionConfig(
  env: NodeJS.ProcessEnv = process.env,
): MemoryV2ReverificationAdmissionConfig {
  const intervalSeconds = parseBoundedInteger({
    env,
    name: POLICY_ENV.intervalSeconds,
    fallback: MEMORY_V2_REVERIFICATION_POLICY_DEFAULTS.intervalSeconds,
    minimum: 60,
    maximum: 31 * 24 * 60 * 60,
  });
  const maxAgeSeconds = parseBoundedInteger({
    env,
    name: POLICY_ENV.maxAgeSeconds,
    fallback: MEMORY_V2_REVERIFICATION_POLICY_DEFAULTS.maxAgeSeconds,
    minimum: 60,
    maximum: 365 * 24 * 60 * 60,
  });
  if (maxAgeSeconds < intervalSeconds) {
    throw new MemoryV2ReverificationAdmissionError(
      `${POLICY_ENV.maxAgeSeconds} must be at least ${POLICY_ENV.intervalSeconds}`,
    );
  }
  const maxAttempts = parseBoundedInteger({
    env,
    name: POLICY_ENV.maxAttempts,
    fallback: MEMORY_V2_REVERIFICATION_POLICY_DEFAULTS.maxAttempts,
    minimum: 1,
    maximum: 64,
  });
  const maxAdmissionRecords = parseBoundedInteger({
    env,
    name: POLICY_ENV.maxAdmissionRecords,
    fallback: MEMORY_V2_REVERIFICATION_POLICY_DEFAULTS.maxAdmissionRecords,
    minimum: 1,
    maximum: 1_000_000,
  });
  return {
    intervalSeconds,
    maxAgeSeconds,
    maxAttempts,
    maxAdmissionRecords,
  };
}

function resolverForPlane(plane: MemoryV2Plane): MemoryV2ResolverType {
  return plane === "codebase" ? "github" : "runtime_attestation";
}

function targetForAdmission(recordId: string, recordVersion: number): AdmissionTargetRow {
  const target = db.prepare(ADMISSION_TARGET_SQL).get(
    recordId,
    recordVersion,
  ) as unknown as AdmissionTargetRow | undefined;
  if (!target) {
    throw new MemoryV2ReverificationAdmissionError(
      "Reverification admission requires an exact current active mapped record",
    );
  }
  return target;
}

function storedLastVerifiedAt(target: AdmissionTargetRow, now: string): string {
  if (!validTimestamp(target.evidence_verified_at)) {
    throw new MemoryV2ReverificationAdmissionError(
      "Record trust has no valid evidence_verified_at",
    );
  }
  if (Date.parse(target.evidence_verified_at) > Date.parse(now)) {
    throw new MemoryV2ReverificationAdmissionError(
      "Record evidence verification cannot be newer than policy admission",
    );
  }
  return target.evidence_verified_at;
}

function existingAdmission(target: AdmissionTargetRow): ExistingAdmissionRow | null {
  return (db.prepare(
    `SELECT state.org_id AS state_org_id,
            state.project_id AS state_project_id,
            state.plane AS state_plane,
            state.resource_row_id AS state_resource_row_id,
            state.status, state.influence_eligible,
            state.policy_id, state.policy_revision, state.next_reverify_at,
            policy.policy_digest,
            policy.record_id AS policy_record_id,
            policy.record_version AS policy_record_version,
            policy.org_id AS policy_org_id,
            policy.project_id AS policy_project_id,
            policy.plane AS policy_plane,
            policy.resource_row_id AS policy_resource_row_id,
            policy.resolver_type, policy.active
     FROM memory_v2_reverification_state AS state
     LEFT JOIN memory_v2_reverification_policies AS policy
       ON policy.policy_id = state.policy_id
     WHERE state.record_id = ? AND state.record_version = ?`,
  ).get(
    target.record_id,
    target.record_version,
  ) as unknown as ExistingAdmissionRow | undefined) ?? null;
}

function validatedExistingAdmission(
  target: AdmissionTargetRow,
  existing: ExistingAdmissionRow,
): MemoryV2ReverificationAdmissionResult {
  const resolverType = resolverForPlane(target.plane);
  const openStatus = existing.status === "fresh"
    || existing.status === "due"
    || existing.status === "pending";
  const validInfluence = existing.influence_eligible === 1;
  if (existing.state_org_id !== target.org_id
      || existing.state_project_id !== target.project_id
      || existing.state_plane !== target.plane
      || existing.state_resource_row_id !== target.resource_row_id
      || existing.policy_record_id !== target.record_id
      || existing.policy_record_version !== target.record_version
      || existing.policy_org_id !== target.org_id
      || existing.policy_project_id !== target.project_id
      || existing.policy_plane !== target.plane
      || existing.policy_resource_row_id !== target.resource_row_id
      || existing.resolver_type !== resolverType
      || existing.active !== 1
      || !existing.policy_id
      || !existing.policy_digest
      || !openStatus
      || !validInfluence
      || !validTimestamp(existing.next_reverify_at)) {
    throw new MemoryV2ReverificationAdmissionError(
      "Existing reverification admission does not match the current active record",
    );
  }
  return {
    recordId: target.record_id,
    recordVersion: target.record_version,
    plane: target.plane,
    resourceRowId: target.resource_row_id,
    resolverType,
    policyId: existing.policy_id,
    policyRevision: existing.policy_revision,
    policyDigest: existing.policy_digest,
    nextReverifyAt: existing.next_reverify_at,
    admitted: false,
  };
}

function createAdmission(input: {
  target: AdmissionTargetRow;
  config: MemoryV2ReverificationAdmissionConfig;
  createdBy: string;
  now: string;
}): MemoryV2ReverificationAdmissionResult {
  const previousPolicyCount = Number((db.prepare(
    `SELECT COUNT(*) AS count
     FROM memory_v2_reverification_policies
     WHERE record_id = ? AND record_version = ?`,
  ).get(input.target.record_id, input.target.record_version) as { count: number }).count);
  if (previousPolicyCount !== 0) {
    throw new MemoryV2ReverificationAdmissionError(
      "A reverification policy exists without its exact state companion",
    );
  }
  const resolverType = resolverForPlane(input.target.plane);
  const policy: MemoryV2ReverificationPolicy = createMemoryV2ReverificationPolicy({
    recordId: input.target.record_id,
    recordVersion: input.target.record_version,
    orgId: input.target.org_id,
    projectId: input.target.project_id,
    plane: input.target.plane,
    resourceRowId: input.target.resource_row_id,
    resolverType,
    intervalSeconds: input.config.intervalSeconds,
    maxAgeSeconds: input.config.maxAgeSeconds,
    maxAttempts: input.config.maxAttempts,
    createdBy: input.createdBy,
    lastVerifiedAt: storedLastVerifiedAt(input.target, input.now),
    now: input.now,
  });
  return {
    recordId: input.target.record_id,
    recordVersion: input.target.record_version,
    plane: input.target.plane,
    resourceRowId: input.target.resource_row_id,
    resolverType,
    ...policy,
    admitted: true,
  };
}

function ensureAdmissionInTransaction(input: {
  recordId: string;
  recordVersion: number;
  createdBy: string;
  now: string;
  config: MemoryV2ReverificationAdmissionConfig;
}): MemoryV2ReverificationAdmissionResult {
  const target = targetForAdmission(input.recordId, input.recordVersion);
  const existing = existingAdmission(target);
  return existing
    ? validatedExistingAdmission(target, existing)
    : createAdmission({
        target,
        config: input.config,
        createdBy: input.createdBy,
        now: input.now,
      });
}

export function ensureMemoryV2ReverificationAdmission(input: {
  recordId: string;
  recordVersion: number;
  createdBy: string;
  now?: string;
}): MemoryV2ReverificationAdmissionResult {
  if (!memoryV2ReverificationEnabled()) {
    throw new MemoryV2ReverificationAdmissionError("Reverification is disabled");
  }
  const now = input.now ?? new Date().toISOString();
  if (!validTimestamp(now)) {
    throw new MemoryV2ReverificationAdmissionError("Admission time is invalid");
  }
  const createdBy = input.createdBy.trim();
  if (!createdBy || createdBy.length > 128) {
    throw new MemoryV2ReverificationAdmissionError("Admission actor is invalid");
  }
  const config = memoryV2ReverificationAdmissionConfig();
  return withImmediateTransaction(() => ensureAdmissionInTransaction({
    recordId: input.recordId,
    recordVersion: input.recordVersion,
    createdBy,
    now,
    config,
  }));
}

/**
 * Admits only exact current records in the two Slice-6 scopes. The pre-count,
 * cap check, target read, and all missing policy/state writes share one
 * immediate transaction: an oversized or malformed migration changes nothing.
 */
export function reconcileMemoryV2ReverificationAdmissions(input: {
  now?: string;
  createdBy?: string;
} = {}): MemoryV2ReverificationAdmissionReconciliation {
  const now = input.now ?? new Date().toISOString();
  if (!validTimestamp(now)) {
    throw new MemoryV2ReverificationAdmissionError("Admission reconciliation time is invalid");
  }
  const createdBy = (input.createdBy ?? "memory-v2-startup-admission").trim();
  if (!createdBy || createdBy.length > 128) {
    throw new MemoryV2ReverificationAdmissionError("Admission reconciliation actor is invalid");
  }
  if (!memoryV2ReverificationEnabled()) {
    return {
      eligibleRecordCount: 0,
      missingRecordCount: 0,
      alreadyCoveredRecordCount: 0,
      admittedRecordCount: 0,
      codebaseAdmittedCount: 0,
      harnessAdmittedCount: 0,
      maxAdmissionRecords: MEMORY_V2_REVERIFICATION_POLICY_DEFAULTS.maxAdmissionRecords,
    };
  }
  const config = memoryV2ReverificationAdmissionConfig();
  return withImmediateTransaction(() => {
    const eligibleRecordCount = Number((db.prepare(
      `SELECT COUNT(*) AS count
       FROM memory_records AS record
       JOIN memory_v2_record_facets AS facet
         ON facet.record_id = record.record_id
        AND facet.record_version = record.current_version
       JOIN memory_v2_resources AS resource
         ON resource.resource_row_id = facet.resource_row_id
       JOIN memory_v2_record_trust AS trust
         ON trust.record_id = record.record_id
        AND trust.record_version = record.current_version
       WHERE ${ELIGIBLE_RECORD_PREDICATE}
         AND facet.org_id = record.org_id
         AND facet.project_id = record.project_id
         AND facet.plane = record.plane
         AND facet.projection_status = 'mapped'
         AND resource.org_id = record.org_id
         AND resource.project_id = record.project_id
         AND resource.plane = record.plane
         AND resource.valid_until IS NULL`,
    ).get() as { count: number }).count);
    const missingRecordCount = Number((db.prepare(
      `SELECT COUNT(*) AS count
       FROM memory_records AS record
       JOIN memory_v2_record_facets AS facet
         ON facet.record_id = record.record_id
        AND facet.record_version = record.current_version
       JOIN memory_v2_resources AS resource
         ON resource.resource_row_id = facet.resource_row_id
       JOIN memory_v2_record_trust AS trust
         ON trust.record_id = record.record_id
        AND trust.record_version = record.current_version
       WHERE ${ELIGIBLE_RECORD_PREDICATE}
         AND facet.org_id = record.org_id
         AND facet.project_id = record.project_id
         AND facet.plane = record.plane
         AND facet.projection_status = 'mapped'
         AND resource.org_id = record.org_id
         AND resource.project_id = record.project_id
         AND resource.plane = record.plane
         AND resource.valid_until IS NULL
         AND ${MISSING_ADMISSION_PREDICATE}`,
    ).get() as { count: number }).count);
    if (missingRecordCount > config.maxAdmissionRecords) {
      throw new MemoryV2ReverificationAdmissionError(
        `Reverification admission requires ${missingRecordCount} records, exceeding the configured cap of ${config.maxAdmissionRecords}`,
      );
    }
    const targets = db.prepare(
      `SELECT record.record_id, record.current_version AS record_version
       FROM memory_records AS record
       JOIN memory_v2_record_facets AS facet
         ON facet.record_id = record.record_id
        AND facet.record_version = record.current_version
       JOIN memory_v2_resources AS resource
         ON resource.resource_row_id = facet.resource_row_id
       JOIN memory_v2_record_trust AS trust
         ON trust.record_id = record.record_id
        AND trust.record_version = record.current_version
       WHERE ${ELIGIBLE_RECORD_PREDICATE}
         AND facet.org_id = record.org_id
         AND facet.project_id = record.project_id
         AND facet.plane = record.plane
         AND facet.projection_status = 'mapped'
         AND resource.org_id = record.org_id
         AND resource.project_id = record.project_id
         AND resource.plane = record.plane
         AND resource.valid_until IS NULL
       ORDER BY record.org_id, record.project_id, record.plane,
                record.record_id, record.current_version`,
    ).all() as unknown as Array<{ record_id: string; record_version: number }>;
    let codebaseAdmittedCount = 0;
    let harnessAdmittedCount = 0;
    let alreadyCoveredRecordCount = 0;
    let admittedRecordCount = 0;
    for (const target of targets) {
      const admission = ensureAdmissionInTransaction({
        recordId: target.record_id,
        recordVersion: target.record_version,
        createdBy,
        now,
        config,
      });
      if (admission.admitted) {
        admittedRecordCount += 1;
        if (admission.plane === "codebase") codebaseAdmittedCount += 1;
        else harnessAdmittedCount += 1;
      } else {
        alreadyCoveredRecordCount += 1;
      }
    }
    if (admittedRecordCount !== missingRecordCount
        || alreadyCoveredRecordCount + admittedRecordCount !== eligibleRecordCount) {
      throw new MemoryV2ReverificationAdmissionError(
        "Admission target set changed while startup reconciliation held the write transaction",
      );
    }
    return {
      eligibleRecordCount,
      missingRecordCount,
      alreadyCoveredRecordCount,
      admittedRecordCount,
      codebaseAdmittedCount,
      harnessAdmittedCount,
      maxAdmissionRecords: config.maxAdmissionRecords,
    };
  });
}
