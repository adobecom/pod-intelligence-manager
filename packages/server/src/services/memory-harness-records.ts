import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  canonicalJsonSha256,
  type CompatibilityV1,
  type EvidenceHandleV1,
  type EvidenceSummaryV1,
  type FreshnessV1,
  type HarnessApplicabilityV1,
  type MemoryContentV1,
  type ValidationV1,
} from "@pim/shared";
import db, { withImmediateTransaction } from "../db/connection.js";
import {
  assertMemoryStructure,
  type ThinV1MemoryKind,
} from "./memory-structural-validator.js";
import {
  assertMemoryV2StoredRecordFacet,
  insertMemoryV2RecordFacet,
  type MemoryV2HarnessSubtype,
} from "./memory-v2-canonical-writes.js";
import {
  projectMemoryV2HarnessResource,
  resolveMemoryV2HarnessResourceRowId,
} from "./memory-v2-resources.js";

type HarnessRecordStatus = "active" | "stale" | "superseded" | "revoked" | "expired";

interface HarnessRecordRow {
  record_id: string;
  org_id: string;
  project_id: string;
  harness_id: string;
  plane: "harness";
  kind: ThinV1MemoryKind;
  current_version: number;
  current_status: HarnessRecordStatus;
  claim_key: string;
  valid_from: string;
  valid_until: string | null;
  expires_at: string | null;
}

interface HarnessVersionRow {
  record_id: string;
  record_version: number;
  content_json: string;
  applicability_json: string;
  exceptions_json: string;
  compatibility_json: string;
  validation_json: string;
  evidence_json: string;
  evidence_summary_json: string;
  freshness_json: string;
  provenance_json: string;
  embedding_json: string | null;
  content_digest: string;
  recorded_at: string;
}

interface HarnessTransitionRow {
  transition_id: string;
  from_status: string | null;
  to_status: string;
  reason_code: string;
  committed_at: string;
}

export interface HarnessMemoryRecord {
  recordId: string;
  recordVersion: number;
  orgId: string;
  projectId: string;
  harnessId: string;
  kind: ThinV1MemoryKind;
  status: HarnessRecordStatus;
  content: MemoryContentV1;
  applicability: HarnessApplicabilityV1;
  exceptions: string[];
  compatibility: CompatibilityV1;
  validation: ValidationV1;
  evidence: EvidenceHandleV1[];
  evidenceSummary: EvidenceSummaryV1;
  freshness: FreshnessV1;
  provenance: Record<string, unknown>;
  recordedAt: string;
  contentDigest: string;
  transitionSummary: {
    transition_id: string;
    from_status: string | null;
    to_status: string;
    reason_code: string;
    committed_at: string;
  } | null;
}

export interface ImportActiveHarnessMemoryRecordInput {
  orgId: string;
  projectId: string;
  recordId: string;
  kind: ThinV1MemoryKind;
  /** Exact native-v2 subtype; migrated v1 callers intentionally omit it. */
  subtype?: MemoryV2HarnessSubtype;
  /** Exact native-v2 configuration selectors; migrated v1 callers omit them. */
  configurationDigests?: string[];
  content: MemoryContentV1;
  applicability: HarnessApplicabilityV1;
  exceptions: string[];
  compatibility: CompatibilityV1;
  validation: ValidationV1;
  evidence: EvidenceHandleV1[];
  evidenceSummary: EvidenceSummaryV1;
  freshness: FreshnessV1;
  provenance: Record<string, unknown>;
  actorId: string;
  decisionRefs: string[];
  reasonCode: string;
  explanation: string;
  now?: string;
}

export class MemoryHarnessRecordConflictError extends Error {
  readonly statusCode = 409;
  readonly code = "idempotency_conflict";

  constructor(message: string) {
    super(message);
    this.name = "MemoryHarnessRecordConflictError";
  }
}

function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

function assertRequestedNativeSubtype(input: {
  recordId: string;
  recordVersion: number;
  subtype: MemoryV2HarnessSubtype | undefined;
}): void {
  if (!input.subtype) return;
  const facet = db.prepare(
    `SELECT subtype, projection_status FROM memory_v2_record_facets
     WHERE record_id = ? AND record_version = ? AND plane = 'harness'`,
  ).get(input.recordId, input.recordVersion) as {
    subtype: string | null;
    projection_status: string;
  } | undefined;
  if (!facet || facet.projection_status !== "mapped" || facet.subtype !== input.subtype) {
    throw new MemoryHarnessRecordConflictError(
      "An existing harness claim does not preserve the requested native v2 subtype",
    );
  }
}

function normalizedList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].sort();
}

function selectors(applicability: HarnessApplicabilityV1): Array<[string, string]> {
  const values: Array<[string, string]> = [["harness", applicability.harness_id]];
  if (applicability.harness_version_range) values.push(["harness_version", applicability.harness_version_range]);
  if (applicability.workflow_version_range) values.push(["workflow_version", applicability.workflow_version_range]);
  if (applicability.adapter_version_range) values.push(["adapter_version", applicability.adapter_version_range]);
  for (const value of applicability.configuration_ids ?? []) values.push(["configuration", value]);
  for (const value of applicability.model_ids ?? []) values.push(["model", value]);
  for (const value of applicability.tool_ids ?? []) values.push(["tool", value]);
  return values;
}

function normalizeText(value: string, lowerCase = false): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  return lowerCase ? normalized.toLowerCase() : normalized;
}

export function canonicalHarnessMemoryClaimKey(
  input: Pick<ImportActiveHarnessMemoryRecordInput,
    "kind" | "subtype" | "content" | "applicability" | "configurationDigests" | "provenance">,
): string {
  const configurationIds = normalizedList(input.applicability.configuration_ids);
  const configurationDigests = normalizedList(input.configurationDigests);
  const modelIds = normalizedList(input.applicability.model_ids);
  const toolIds = normalizedList(input.applicability.tool_ids);
  return canonicalJsonSha256({
    schema_version: "pim.memory-harness-record.v1",
    plane: "harness",
    kind: input.kind,
    ...(input.subtype ? { subtype: input.subtype } : {}),
    content: {
      summary: normalizeText(input.content.summary, true),
      details: normalizeText(input.content.details),
      rationale: normalizeText(input.content.rationale),
    },
    applicability: {
      harness_id: input.applicability.harness_id,
      ...(input.applicability.harness_version_range
        ? { harness_version_range: input.applicability.harness_version_range }
        : {}),
      ...(input.applicability.workflow_version_range
        ? { workflow_version_range: input.applicability.workflow_version_range }
        : {}),
      ...(input.applicability.adapter_version_range
        ? { adapter_version_range: input.applicability.adapter_version_range }
        : {}),
      ...(configurationIds.length ? { configuration_ids: configurationIds } : {}),
      ...(configurationDigests.length ? { configuration_digests: configurationDigests } : {}),
      ...(modelIds.length ? { model_ids: modelIds } : {}),
      ...(toolIds.length ? { tool_ids: toolIds } : {}),
    },
    extractor_version: typeof input.provenance.extractor_version === "string"
      ? input.provenance.extractor_version
      : "unknown",
  });
}

function harnessTransition(
  orgId: string,
  projectId: string,
  recordId: string,
  database: DatabaseSync,
): HarnessTransitionRow | null {
  return (database.prepare(
    `SELECT transition_id, from_status, to_status, reason_code, committed_at
     FROM memory_transitions
     WHERE org_id = ? AND project_id = ?
       AND aggregate_type = 'record' AND aggregate_id = ?
     ORDER BY committed_at DESC, rowid DESC LIMIT 1`,
  ).get(orgId, projectId, recordId) as HarnessTransitionRow | undefined) ?? null;
}

function toHarnessRecord(
  record: HarnessRecordRow,
  version: HarnessVersionRow,
  database: DatabaseSync,
): HarnessMemoryRecord {
  const transition = harnessTransition(record.org_id, record.project_id, record.record_id, database);
  return {
    recordId: record.record_id,
    recordVersion: version.record_version,
    orgId: record.org_id,
    projectId: record.project_id,
    harnessId: record.harness_id,
    kind: record.kind,
    status: record.current_status,
    content: parseJson(version.content_json),
    applicability: parseJson(version.applicability_json),
    exceptions: parseJson(version.exceptions_json),
    compatibility: parseJson(version.compatibility_json),
    validation: parseJson(version.validation_json),
    evidence: parseJson(version.evidence_json),
    evidenceSummary: parseJson(version.evidence_summary_json),
    freshness: parseJson(version.freshness_json),
    provenance: parseJson(version.provenance_json),
    recordedAt: version.recorded_at,
    contentDigest: version.content_digest,
    transitionSummary: transition ? {
      transition_id: transition.transition_id,
      from_status: transition.from_status,
      to_status: transition.to_status,
      reason_code: transition.reason_code,
      committed_at: transition.committed_at,
    } : null,
  };
}

export function getHarnessMemoryRecord(input: {
  orgId: string;
  projectId: string;
  harnessId: string;
  recordId: string;
  recordVersion?: number;
}, database: DatabaseSync = db): HarnessMemoryRecord | null {
  const record = database.prepare(
    `SELECT * FROM memory_records
     WHERE org_id = ? AND project_id = ? AND harness_id = ?
       AND plane = 'harness' AND record_id = ?`,
  ).get(input.orgId, input.projectId, input.harnessId, input.recordId) as unknown as HarnessRecordRow | undefined;
  if (!record) return null;
  const version = database.prepare(
    "SELECT * FROM memory_record_versions WHERE record_id = ? AND record_version = ?",
  ).get(input.recordId, input.recordVersion ?? record.current_version) as unknown as HarnessVersionRow | undefined;
  return version ? toHarnessRecord(record, version, database) : null;
}

export function findActiveHarnessMemoryRecordByClaim(input: {
  orgId: string;
  projectId: string;
  kind: ThinV1MemoryKind;
  subtype?: MemoryV2HarnessSubtype;
  content: MemoryContentV1;
  applicability: HarnessApplicabilityV1;
  configurationDigests?: string[];
  extractorVersion: string;
}): HarnessMemoryRecord | null {
  const key = canonicalHarnessMemoryClaimKey({
    kind: input.kind,
    subtype: input.subtype,
    content: input.content,
    applicability: input.applicability,
    configurationDigests: input.configurationDigests,
    provenance: { extractor_version: input.extractorVersion },
  });
  const row = db.prepare(
    `SELECT record_id FROM memory_records
     WHERE org_id = ? AND project_id = ? AND plane = 'harness'
       AND harness_id = ? AND claim_key = ? AND current_status = 'active'`,
  ).get(
    input.orgId,
    input.projectId,
    input.applicability.harness_id,
    key,
  ) as { record_id: string } | undefined;
  return row ? getHarnessMemoryRecord({
    orgId: input.orgId,
    projectId: input.projectId,
    harnessId: input.applicability.harness_id,
    recordId: row.record_id,
  }) : null;
}

export function importActiveHarnessMemoryRecord(
  input: ImportActiveHarnessMemoryRecordInput,
): HarnessMemoryRecord {
  assertMemoryStructure({
    plane: "harness",
    kind: input.kind,
    content: input.content,
    applicability: input.applicability,
    validation: input.validation,
    exceptions: input.exceptions,
  });
  if (input.evidence.length === 0 || input.evidenceSummary.ref_count !== input.evidence.length) {
    throw new MemoryHarnessRecordConflictError("Active harness records require complete evidence");
  }
  if (Object.keys(input.provenance).length === 0) {
    throw new MemoryHarnessRecordConflictError("Active harness records require provenance");
  }
  const now = input.now ?? new Date().toISOString();
  const expiresAt = input.freshness.expires_at ?? null;
  if (!Number.isFinite(Date.parse(input.freshness.last_confirmed_at))
      || (expiresAt !== null && !Number.isFinite(Date.parse(expiresAt)))) {
    throw new MemoryHarnessRecordConflictError("Harness record freshness timestamps are invalid");
  }
  const key = canonicalHarnessMemoryClaimKey(input);
  const contentDigest = canonicalJsonSha256({
    content: input.content,
    applicability: input.applicability,
    exceptions: input.exceptions,
    compatibility: input.compatibility,
    validation: input.validation,
    evidence: input.evidence,
    evidence_summary: input.evidenceSummary,
    freshness: input.freshness,
    provenance: input.provenance,
  });

  return withImmediateTransaction(() => {
    const existing = db.prepare(
      `SELECT record.*, version.content_digest
       FROM memory_records record
       INNER JOIN memory_record_versions version
         ON version.record_id = record.record_id AND version.record_version = record.current_version
       WHERE record.record_id = ?`,
    ).get(input.recordId) as unknown as (HarnessRecordRow & { content_digest: string }) | undefined;
    if (existing) {
      if (existing.plane !== "harness" || existing.org_id !== input.orgId
          || existing.project_id !== input.projectId || existing.harness_id !== input.applicability.harness_id
          || existing.content_digest !== contentDigest) {
        throw new MemoryHarnessRecordConflictError("Record ID is assigned to different immutable content");
      }
      assertMemoryV2StoredRecordFacet({
        recordId: input.recordId,
        recordVersion: existing.current_version,
      });
      assertRequestedNativeSubtype({
        recordId: input.recordId,
        recordVersion: existing.current_version,
        subtype: input.subtype,
      });
      return getHarnessMemoryRecord({
        orgId: input.orgId,
        projectId: input.projectId,
        harnessId: input.applicability.harness_id,
        recordId: input.recordId,
      })!;
    }
    const duplicate = db.prepare(
      `SELECT record_id, current_status, harness_id FROM memory_records
       WHERE org_id = ? AND project_id = ? AND plane = 'harness' AND claim_key = ?`,
    ).get(input.orgId, input.projectId, key) as {
      record_id: string;
      current_status: HarnessRecordStatus;
      harness_id: string;
    } | undefined;
    if (duplicate) {
      if (duplicate.current_status !== "active"
          || duplicate.harness_id !== input.applicability.harness_id) {
        throw new MemoryHarnessRecordConflictError(
          "A non-active canonical harness claim cannot be reused",
        );
      }
      assertMemoryV2StoredRecordFacet({ recordId: duplicate.record_id });
      const duplicateVersion = db.prepare(
        "SELECT current_version FROM memory_records WHERE record_id = ?",
      ).get(duplicate.record_id) as { current_version: number };
      assertRequestedNativeSubtype({
        recordId: duplicate.record_id,
        recordVersion: duplicateVersion.current_version,
        subtype: input.subtype,
      });
      return getHarnessMemoryRecord({
        orgId: input.orgId,
        projectId: input.projectId,
        harnessId: input.applicability.harness_id,
        recordId: duplicate.record_id,
      })!;
    }

    const resource = projectMemoryV2HarnessResource({
      orgId: input.orgId,
      projectId: input.projectId,
      harnessId: input.applicability.harness_id,
    });
    db.prepare(
      `INSERT INTO memory_records
         (record_id, org_id, project_id, repository_row_id, harness_id, plane, kind,
          current_version, current_status, aggregate_version,
          claim_key, valid_from, valid_until, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, 'harness', ?, 1, 'active', 1, ?, ?, NULL, ?, ?, ?)`,
    ).run(
      input.recordId,
      input.orgId,
      input.projectId,
      input.applicability.harness_id,
      input.kind,
      key,
      input.freshness.last_confirmed_at,
      expiresAt,
      now,
      now,
    );
    db.prepare(
      `INSERT INTO memory_record_versions
         (record_id, record_version, content_json, applicability_json, exceptions_json,
          compatibility_json, validation_json, evidence_json, evidence_summary_json,
          freshness_json, provenance_json, embedding_json, content_digest, recorded_at)
       VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).run(
      input.recordId,
      JSON.stringify(input.content),
      JSON.stringify(input.applicability),
      JSON.stringify(input.exceptions),
      JSON.stringify(input.compatibility),
      JSON.stringify(input.validation),
      JSON.stringify(input.evidence),
      JSON.stringify(input.evidenceSummary),
      JSON.stringify(input.freshness),
      JSON.stringify(input.provenance),
      contentDigest,
      now,
    );
    insertMemoryV2RecordFacet({
      recordId: input.recordId,
      recordVersion: 1,
      orgId: input.orgId,
      projectId: input.projectId,
      plane: "harness",
      resourceRowId: resolveMemoryV2HarnessResourceRowId({
        orgId: input.orgId,
        projectId: input.projectId,
        harnessId: input.applicability.harness_id,
      }) ?? resource.resourceRowId,
      broadKind: input.kind,
      subtype: input.subtype,
      now,
    });
    db.prepare(
      `INSERT INTO memory_transitions
         (transition_id, org_id, project_id, aggregate_type, aggregate_id, from_status,
          to_status, actor_type, actor_id, reason_code, explanation, evidence_refs_json,
          decision_refs_json, policy_version, occurred_at, committed_at)
       VALUES (?, ?, ?, 'record', ?, NULL, 'active', 'reviewer', ?, ?, ?, ?, ?,
               'memory-harness-v1', ?, ?)`,
    ).run(
      `transition_${randomUUID()}`,
      input.orgId,
      input.projectId,
      input.recordId,
      input.actorId,
      input.reasonCode,
      input.explanation.slice(0, 1000),
      JSON.stringify(input.evidence.map((item) => item.evidence_ref_id)),
      JSON.stringify(input.decisionRefs),
      now,
      now,
    );
    const insertSelector = db.prepare(
      `INSERT INTO memory_applicability_indexes
         (record_id, record_version, selector_type, selector_value)
       VALUES (?, 1, ?, ?)`,
    );
    for (const [type, value] of selectors(input.applicability)) {
      insertSelector.run(input.recordId, type, value);
    }
    db.prepare(
      "INSERT INTO memory_record_versions_fts (record_key, summary, details, selectors) VALUES (?, ?, ?, ?)",
    ).run(
      `${input.recordId}:1`,
      input.content.summary,
      input.content.details,
      selectors(input.applicability).map(([, value]) => value).join(" "),
    );
    return getHarnessMemoryRecord({
      orgId: input.orgId,
      projectId: input.projectId,
      harnessId: input.applicability.harness_id,
      recordId: input.recordId,
    })!;
  });
}

export function listCurrentHarnessMemoryRecords(input: {
  orgId: string;
  projectId: string;
  harnessId: string;
  now: string;
}): HarnessMemoryRecord[] {
  const rows = db.prepare(
    `SELECT record_id FROM memory_records
     WHERE org_id = ? AND project_id = ? AND plane = 'harness' AND harness_id = ?
       AND current_status = 'active'
       AND valid_from <= ?
       AND (valid_until IS NULL OR valid_until > ?)
       AND (expires_at IS NULL OR expires_at > ?)
     ORDER BY record_id`,
  ).all(input.orgId, input.projectId, input.harnessId, input.now, input.now, input.now) as unknown as Array<{ record_id: string }>;
  return rows.map((row) => getHarnessMemoryRecord({
    orgId: input.orgId,
    projectId: input.projectId,
    harnessId: input.harnessId,
    recordId: row.record_id,
  })!);
}
