import db, { withImmediateTransaction } from "../db/connection.js";

export type MemoryV2TrustBasis = "legacy_cutover" | "evidence_verified";
export type MemoryV2TrustStatus = "trusted" | "untrusted";

export interface MemoryV2RecordTrust {
  recordId: string;
  recordVersion: number;
  orgId: string;
  projectId: string;
  plane: "codebase" | "harness";
  resourceRowId: string;
  trustStatus: MemoryV2TrustStatus;
  trustBasis: MemoryV2TrustBasis;
  cutoverDecidedAt: string | null;
  evidenceVerifiedAt: string | null;
}

interface TrustRow {
  record_id: string;
  record_version: number;
  org_id: string;
  project_id: string;
  plane: "codebase" | "harness";
  resource_row_id: string;
  trust_status: MemoryV2TrustStatus;
  trust_basis: MemoryV2TrustBasis;
  cutover_decided_at: string | null;
  evidence_verified_at: string | null;
}

interface TrustTargetRow {
  record_id: string;
  record_version: number;
  org_id: string;
  project_id: string;
  plane: "codebase" | "harness";
  resource_row_id: string;
}

export class MemoryV2TrustError extends Error {
  constructor(
    message: string,
    readonly code: "schema_invalid" | "resource_binding_mismatch" | "transition_invalid",
  ) {
    super(message);
    this.name = "MemoryV2TrustError";
  }
}

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function projectTrust(row: TrustRow): MemoryV2RecordTrust {
  return {
    recordId: row.record_id,
    recordVersion: row.record_version,
    orgId: row.org_id,
    projectId: row.project_id,
    plane: row.plane,
    resourceRowId: row.resource_row_id,
    trustStatus: row.trust_status,
    trustBasis: row.trust_basis,
    cutoverDecidedAt: row.cutover_decided_at,
    evidenceVerifiedAt: row.evidence_verified_at,
  };
}

export function getMemoryV2RecordTrust(
  recordId: string,
  recordVersion: number,
): MemoryV2RecordTrust | null {
  const row = db.prepare(
    `SELECT record_id, record_version, org_id, project_id, plane, resource_row_id,
            trust_status, trust_basis, cutover_decided_at, evidence_verified_at
     FROM memory_v2_record_trust
     WHERE record_id = ? AND record_version = ?`,
  ).get(recordId, recordVersion) as TrustRow | undefined;
  return row ? projectTrust(row) : null;
}

/**
 * Records the actual evidence decision behind a newly activated record. An
 * existing legacy-cutover row is deliberately left on its original basis: a
 * later claim converging on that record is not a new verification of its
 * historical source evidence.
 */
export function ensureMemoryV2EvidenceVerifiedTrust(input: {
  recordId: string;
  recordVersion: number;
  orgId: string;
  projectId: string;
  evidenceVerifiedAt: string;
  now?: string;
}): MemoryV2RecordTrust {
  const now = input.now ?? new Date().toISOString();
  if (!Number.isSafeInteger(input.recordVersion) || input.recordVersion < 1
      || !validTimestamp(input.evidenceVerifiedAt) || !validTimestamp(now)
      || Date.parse(input.evidenceVerifiedAt) > Date.parse(now)) {
    throw new MemoryV2TrustError("Evidence verification time is invalid", "schema_invalid");
  }
  return withImmediateTransaction(() => {
    const target = db.prepare(
      `SELECT record.record_id, record.current_version AS record_version,
              record.org_id, record.project_id, record.plane, facet.resource_row_id
       FROM memory_records AS record
       JOIN memory_v2_record_facets AS facet
         ON facet.record_id = record.record_id
        AND facet.record_version = record.current_version
       JOIN memory_v2_resources AS resource
         ON resource.resource_row_id = facet.resource_row_id
       WHERE record.record_id = ? AND record.current_version = ?
         AND record.org_id = ? AND record.project_id = ?
         AND record.current_status = 'active'
         AND record.plane IN ('codebase','harness')
         AND facet.org_id = record.org_id
         AND facet.project_id = record.project_id
         AND facet.plane = record.plane
         AND facet.projection_status = 'mapped'
         AND resource.org_id = record.org_id
         AND resource.project_id = record.project_id
         AND resource.plane = record.plane
         AND resource.valid_until IS NULL`,
    ).get(
      input.recordId,
      input.recordVersion,
      input.orgId,
      input.projectId,
    ) as TrustTargetRow | undefined;
    if (!target) {
      throw new MemoryV2TrustError(
        "Evidence trust requires an exact current active mapped record",
        "resource_binding_mismatch",
      );
    }
    const existing = getMemoryV2RecordTrust(input.recordId, input.recordVersion);
    if (existing) {
      if (existing.orgId !== target.org_id
          || existing.projectId !== target.project_id
          || existing.plane !== target.plane
          || existing.resourceRowId !== target.resource_row_id) {
        throw new MemoryV2TrustError(
          "Stored record trust does not match the current resource",
          "resource_binding_mismatch",
        );
      }
      if (existing.trustStatus !== "trusted") {
        throw new MemoryV2TrustError(
          "An untrusted record cannot be reactivated implicitly",
          "transition_invalid",
        );
      }
      return existing;
    }
    db.prepare(
      `INSERT INTO memory_v2_record_trust (
         record_id, record_version, org_id, project_id, plane, resource_row_id,
         trust_status, trust_basis, cutover_decided_at, evidence_verified_at,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'trusted', 'evidence_verified', NULL, ?, ?, ?)`,
    ).run(
      target.record_id,
      target.record_version,
      target.org_id,
      target.project_id,
      target.plane,
      target.resource_row_id,
      input.evidenceVerifiedAt,
      now,
      now,
    );
    return getMemoryV2RecordTrust(input.recordId, input.recordVersion)!;
  });
}

export function memoryV2RecordIsEligible(input: {
  recordId: string;
  recordVersion: number;
  orgId: string;
  projectId: string;
  plane: "codebase" | "harness";
  resourceRowId: string;
  now: string;
}): boolean {
  if (!validTimestamp(input.now)) return false;
  return Boolean(db.prepare(
    `SELECT 1
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
       AND record.org_id = ? AND record.project_id = ? AND record.plane = ?
       AND facet.resource_row_id = ?
       AND record.current_status = 'active'
       AND record.valid_from <= ?
       AND (record.valid_until IS NULL OR record.valid_until > ?)
       AND (record.expires_at IS NULL OR record.expires_at > ?)
       AND facet.org_id = record.org_id AND facet.project_id = record.project_id
       AND facet.plane = record.plane AND facet.projection_status = 'mapped'
       AND resource.org_id = record.org_id AND resource.project_id = record.project_id
       AND resource.plane = record.plane AND resource.valid_until IS NULL
       AND trust.org_id = record.org_id AND trust.project_id = record.project_id
       AND trust.plane = record.plane AND trust.resource_row_id = facet.resource_row_id
       AND trust.trust_status = 'trusted'`,
  ).get(
    input.recordId,
    input.recordVersion,
    input.orgId,
    input.projectId,
    input.plane,
    input.resourceRowId,
    input.now,
    input.now,
    input.now,
  ));
}

export function markMemoryV2RecordUntrusted(input: {
  recordId: string;
  recordVersion: number;
  now: string;
}): void {
  if (!validTimestamp(input.now)) {
    throw new MemoryV2TrustError("Trust transition time is invalid", "schema_invalid");
  }
  db.prepare(
    `UPDATE memory_v2_record_trust
     SET trust_status = 'untrusted', updated_at = ?
     WHERE record_id = ? AND record_version = ? AND trust_status = 'trusted'`,
  ).run(input.now, input.recordId, input.recordVersion);
}
