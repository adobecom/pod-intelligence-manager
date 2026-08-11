import { randomUUID } from "node:crypto";
import {
  canonicalJsonSha256,
  parseMemoryContract,
  type CodebaseApplicabilityV1,
  type CompatibilityV1,
  type EvidenceHandleV1,
  type EvidenceSummaryV1,
  type FreshnessV1,
  type MemoryContentV1,
  type MemoryRecordHistoryV1,
  type MemoryRecordV1,
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
} from "./memory-v2-canonical-writes.js";
import {
  memoryV2RepositoryResourceRowId,
  projectMemoryV2RepositoryResource,
} from "./memory-v2-resources.js";
import { markMemoryV2RecordUntrusted } from "./memory-v2-trust.js";

export type RecordStatus = "active" | "stale" | "superseded" | "revoked" | "expired";

interface RecordRow {
  record_id: string;
  org_id: string;
  project_id: string;
  repository_row_id: string;
  plane: "codebase";
  kind: ThinV1MemoryKind;
  current_version: number;
  current_status: RecordStatus;
  aggregate_version: number;
  claim_key: string;
  valid_from: string;
  valid_until: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

interface VersionRow {
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

interface CanonicalLifecycleRecordRow extends Omit<RecordRow, "repository_row_id" | "plane"> {
  repository_row_id: string | null;
  harness_id: string | null;
  plane: "codebase" | "harness";
}

interface TransitionRow {
  transition_id: string;
  from_status: string | null;
  to_status: string;
  reason_code: string;
  committed_at: string;
}

export interface ImportActiveMemoryRecordInput {
  orgId: string;
  projectId: string;
  repositoryRowId: string;
  recordId?: string;
  kind: ThinV1MemoryKind;
  content: MemoryContentV1;
  applicability: CodebaseApplicabilityV1;
  exceptions: string[];
  compatibility: CompatibilityV1;
  validation: ValidationV1;
  evidence: EvidenceHandleV1[];
  evidenceSummary: EvidenceSummaryV1;
  freshness: FreshnessV1;
  provenance: Record<string, unknown>;
  embedding?: number[] | null;
  validFrom?: string;
  expiresAt?: string | null;
  actorId?: string;
  actorType?: string;
  decisionRefs?: string[];
  reasonCode?: string;
  transitionExplanation?: string;
  now?: string;
}

export class MemoryRecordConflictError extends Error {
  readonly statusCode = 409;
  readonly code = "idempotency_conflict";

  constructor(message: string) {
    super(message);
    this.name = "MemoryRecordConflictError";
  }
}

interface HistoryRecordRow {
  record_id: string;
  org_id: string;
  project_id: string;
  kind: ThinV1MemoryKind;
  current_version: number;
  current_status: RecordStatus;
  repository_id: string;
}

interface HistoryTransitionRow {
  transition_id: string;
  from_status: string | null;
  to_status: string;
  actor_type: string;
  actor_id: string;
  reason_code: string;
  explanation: string;
  evidence_refs_json: string;
  decision_refs_json: string;
  policy_version: string;
  occurred_at: string;
  committed_at: string;
}

interface ReplacementRow {
  record_id: string;
  record_version: number;
  kind: ThinV1MemoryKind;
  current_status: RecordStatus;
  content_json: string;
  transition_id: string;
  reason_code: string;
  explanation: string;
  created_at: string;
}

function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

function historyReplacement(row: ReplacementRow | undefined): MemoryRecordHistoryV1["replaces"] {
  if (!row) return null;
  const content = parseJson<MemoryContentV1>(row.content_json);
  return {
    record_id: row.record_id,
    record_version: row.record_version,
    kind: row.kind,
    summary: content.summary,
    lifecycle: { status: row.current_status },
    transition_id: row.transition_id,
    reason_code: row.reason_code,
    explanation: row.explanation,
    created_at: row.created_at,
  };
}

export function getMemoryRecordHistory(
  orgId: string,
  projectId: string,
  recordId: string,
): MemoryRecordHistoryV1 | null {
  const record = db.prepare(
    `SELECT record.record_id, record.org_id, record.project_id, record.kind,
            record.current_version, record.current_status, registry.repository_id
     FROM memory_records AS record
     INNER JOIN memory_repository_registry AS registry
       ON registry.repository_row_id = record.repository_row_id
     WHERE record.org_id = ? AND record.project_id = ? AND record.record_id = ?
       AND record.plane = 'codebase'`,
  ).get(orgId, projectId, recordId) as unknown as HistoryRecordRow | undefined;
  if (!record) return null;
  const versions = db.prepare(
    `SELECT record_version, content_json, applicability_json, exceptions_json,
            compatibility_json, validation_json, evidence_json,
            evidence_summary_json, freshness_json, recorded_at
     FROM memory_record_versions
     WHERE record_id = ? ORDER BY record_version`,
  ).all(recordId) as unknown as VersionRow[];
  const transitions = db.prepare(
    `SELECT transition_id, from_status, to_status, actor_type, actor_id,
            reason_code, explanation, evidence_refs_json, decision_refs_json,
            policy_version, occurred_at, committed_at
     FROM memory_transitions
     WHERE org_id = ? AND project_id = ? AND aggregate_type = 'record' AND aggregate_id = ?
     ORDER BY committed_at, transition_id`,
  ).all(orgId, projectId, recordId) as unknown as HistoryTransitionRow[];
  const replaces = db.prepare(
    `SELECT predecessor.record_id, link.predecessor_record_version AS record_version,
            predecessor.kind, predecessor.current_status, version.content_json,
            transition.transition_id, transition.reason_code, transition.explanation,
            link.created_at
     FROM memory_record_supersessions AS link
     INNER JOIN memory_records AS predecessor
       ON predecessor.record_id = link.predecessor_record_id
     INNER JOIN memory_record_versions AS version
       ON version.record_id = link.predecessor_record_id
      AND version.record_version = link.predecessor_record_version
     INNER JOIN memory_transitions AS transition
       ON transition.transition_id = link.transition_id
     WHERE link.org_id = ? AND link.project_id = ? AND link.successor_record_id = ?
     ORDER BY link.created_at DESC LIMIT 1`,
  ).get(orgId, projectId, recordId) as unknown as ReplacementRow | undefined;
  const replacedBy = db.prepare(
    `SELECT successor.record_id, link.successor_record_version AS record_version,
            successor.kind, successor.current_status, version.content_json,
            transition.transition_id, transition.reason_code, transition.explanation,
            link.created_at
     FROM memory_record_supersessions AS link
     INNER JOIN memory_records AS successor
       ON successor.record_id = link.successor_record_id
     INNER JOIN memory_record_versions AS version
       ON version.record_id = link.successor_record_id
      AND version.record_version = link.successor_record_version
     INNER JOIN memory_transitions AS transition
       ON transition.transition_id = link.transition_id
     WHERE link.org_id = ? AND link.project_id = ? AND link.predecessor_record_id = ?
     ORDER BY link.created_at DESC LIMIT 1`,
  ).get(orgId, projectId, recordId) as unknown as ReplacementRow | undefined;
  return parseMemoryContract("MemoryRecordHistoryV1", {
    schema_version: "pim.memory-record-history.v1",
    record_id: record.record_id,
    tenant: { project_id: record.project_id },
    plane: "codebase",
    kind: record.kind,
    repository_id: record.repository_id,
    current_version: record.current_version,
    lifecycle: { status: record.current_status },
    versions: versions.map((version) => ({
      record_version: version.record_version,
      content: parseJson(version.content_json),
      applicability: parseJson(version.applicability_json),
      exceptions: parseJson(version.exceptions_json),
      compatibility: parseJson(version.compatibility_json),
      validation: parseJson(version.validation_json),
      evidence: parseJson(version.evidence_json),
      evidence_summary: parseJson(version.evidence_summary_json),
      freshness: parseJson(version.freshness_json),
      recorded_at: version.recorded_at,
    })),
    transitions: transitions.map((transition) => ({
      transition_id: transition.transition_id,
      from_status: transition.from_status,
      to_status: transition.to_status,
      actor_type: transition.actor_type,
      actor_id: transition.actor_id,
      reason_code: transition.reason_code,
      explanation: transition.explanation,
      evidence_refs: parseJson(transition.evidence_refs_json),
      decision_refs: parseJson(transition.decision_refs_json),
      policy_version: transition.policy_version,
      occurred_at: transition.occurred_at,
      committed_at: transition.committed_at,
    })),
    replaces: historyReplacement(replaces),
    replaced_by: historyReplacement(replacedBy),
  });
}

function normalizedCodebaseApplicability(applicability: CodebaseApplicabilityV1): Record<string, unknown> {
  const normalizeList = (values: string[] | undefined) => values
    ? [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort()
    : undefined;
  const components = normalizeList(applicability.components);
  const paths = normalizeList(applicability.paths);
  const symbols = normalizeList(applicability.symbols);
  const taskClasses = normalizeList(applicability.task_classes);
  return {
    repository_id: applicability.repository_id,
    ...(applicability.base_sha ? { base_sha: applicability.base_sha } : {}),
    ...(components?.length ? { components } : {}),
    ...(paths?.length ? { paths } : {}),
    ...(symbols?.length ? { symbols } : {}),
    ...(taskClasses?.length ? { task_classes: taskClasses } : {}),
  };
}

export function canonicalMemoryClaimKey(
  input: Pick<ImportActiveMemoryRecordInput, "kind" | "content" | "applicability" | "provenance">,
): string {
  return canonicalJsonSha256({
    schema_version: "pim.memory-record.v1",
    plane: "codebase",
    kind: input.kind,
    content: {
      summary: input.content.summary.trim().replace(/\s+/g, " ").toLowerCase(),
      details: input.content.details.trim().replace(/\s+/g, " "),
      rationale: input.content.rationale.trim().replace(/\s+/g, " "),
    },
    applicability: normalizedCodebaseApplicability(input.applicability),
    extractor_version: typeof input.provenance.extractor_version === "string"
      ? input.provenance.extractor_version
      : "unknown",
  });
}

export function canonicalMemoryConflictKey(input: {
  kind: ThinV1MemoryKind;
  applicability: CodebaseApplicabilityV1;
}): string {
  const { base_sha: _baseSha, ...applicabilityIdentity } = normalizedCodebaseApplicability(
    input.applicability,
  );
  return canonicalJsonSha256({
    plane: "codebase",
    kind: input.kind,
    // base_sha pins retrieval validity to a checkout, but does not define the
    // durable constraint identity used to serialize later successors.
    applicability: applicabilityIdentity,
  });
}

function applicabilitySelectors(applicability: CodebaseApplicabilityV1): Array<[string, string]> {
  const selectors: Array<[string, string]> = [["repository", applicability.repository_id]];
  if (applicability.base_sha) selectors.push(["base_sha", applicability.base_sha]);
  for (const value of applicability.components ?? []) selectors.push(["component", value]);
  for (const value of applicability.paths ?? []) selectors.push(["path", value]);
  for (const value of applicability.symbols ?? []) selectors.push(["symbol", value]);
  for (const value of applicability.task_classes ?? []) selectors.push(["task_class", value]);
  return selectors;
}

function transitionFor(orgId: string, projectId: string, recordId: string): TransitionRow | null {
  return (db.prepare(
    `SELECT transition_id, from_status, to_status, reason_code, committed_at
     FROM memory_transitions
     WHERE org_id = ? AND project_id = ? AND aggregate_type = 'record' AND aggregate_id = ?
     ORDER BY committed_at DESC, rowid DESC LIMIT 1`,
  ).get(orgId, projectId, recordId) as TransitionRow | undefined) ?? null;
}

function rowToDetail(record: RecordRow, version: VersionRow): MemoryRecordV1 {
  const transition = transitionFor(record.org_id, record.project_id, record.record_id);
  if (!transition) throw new Error(`Memory record ${record.record_id} has no lifecycle transition`);
  return parseMemoryContract("MemoryRecordV1", {
    schema_version: "pim.memory-record.v1",
    record_id: record.record_id,
    record_version: version.record_version,
    tenant: { project_id: record.project_id },
    plane: "codebase",
    kind: record.kind,
    content: parseJson(version.content_json),
    applicability: parseJson(version.applicability_json),
    exceptions: parseJson(version.exceptions_json),
    compatibility: parseJson(version.compatibility_json),
    validation: parseJson(version.validation_json),
    evidence: parseJson(version.evidence_json),
    evidence_summary: parseJson(version.evidence_summary_json),
    freshness: parseJson(version.freshness_json),
    lifecycle: { status: record.current_status },
    transition_summary: {
      transition_id: transition.transition_id,
      from_status: transition.from_status,
      to_status: transition.to_status,
      reason_code: transition.reason_code,
      committed_at: transition.committed_at,
    },
    recorded_at: version.recorded_at,
  });
}

export function importActiveMemoryRecord(input: ImportActiveMemoryRecordInput): MemoryRecordV1 {
  assertMemoryStructure({
    plane: "codebase",
    kind: input.kind,
    content: input.content,
    applicability: input.applicability,
    validation: input.validation,
    exceptions: input.exceptions,
  });
  if (input.evidence.length === 0 || input.evidenceSummary.ref_count !== input.evidence.length) {
    throw new MemoryRecordConflictError("Active records require complete, counted provenance evidence");
  }
  if (Object.keys(input.provenance).length === 0) {
    throw new MemoryRecordConflictError("Active records require producer and extraction provenance");
  }
  const repository = db.prepare(
    `SELECT repository_id FROM memory_repository_registry
     WHERE repository_row_id = ? AND org_id = ? AND project_id = ? AND valid_until IS NULL`,
  ).get(input.repositoryRowId, input.orgId, input.projectId) as { repository_id: string } | undefined;
  if (!repository || repository.repository_id !== input.applicability.repository_id) {
    throw new MemoryRecordConflictError("Record applicability does not match its canonical repository binding");
  }

  const now = input.now ?? new Date().toISOString();
  const validFrom = input.validFrom ?? now;
  const expiresAt = input.expiresAt !== undefined
    ? input.expiresAt
    : input.freshness.expires_at ?? null;
  if (!Number.isFinite(Date.parse(validFrom))) {
    throw new MemoryRecordConflictError("Record valid_from must be a valid timestamp");
  }
  if (expiresAt !== null && !Number.isFinite(Date.parse(expiresAt))) {
    throw new MemoryRecordConflictError("Record expires_at must be a valid timestamp");
  }
  const recordId = input.recordId ?? `mem_${randomUUID()}`;
  const transitionId = `transition_${randomUUID()}`;
  const claimKey = canonicalMemoryClaimKey(input);
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
    const existingById = db.prepare(
      `SELECT record.*, version.content_digest
       FROM memory_records record
       INNER JOIN memory_record_versions version
         ON version.record_id = record.record_id AND version.record_version = record.current_version
       WHERE record.record_id = ?`,
    ).get(recordId) as unknown as (RecordRow & { content_digest: string }) | undefined;
    if (existingById) {
      if (existingById.org_id !== input.orgId || existingById.project_id !== input.projectId || existingById.content_digest !== contentDigest) {
        throw new MemoryRecordConflictError("Record ID is already assigned to different immutable content");
      }
      assertMemoryV2StoredRecordFacet({
        recordId,
        recordVersion: existingById.current_version,
      });
      return getMemoryRecord(input.orgId, input.projectId, recordId, existingById.current_version)!;
    }
    const duplicate = db.prepare(
      `SELECT record_id, current_status FROM memory_records
       WHERE org_id = ? AND project_id = ? AND claim_key = ?`,
    ).get(input.orgId, input.projectId, claimKey) as {
      record_id: string;
      current_status: RecordStatus;
    } | undefined;
    if (duplicate) {
      if (duplicate.current_status !== "active") {
        throw new MemoryRecordConflictError(
          "Canonical claim exists only in inactive history and requires explicit revalidation",
        );
      }
      assertMemoryV2StoredRecordFacet({ recordId: duplicate.record_id });
      return getMemoryRecord(input.orgId, input.projectId, duplicate.record_id)!;
    }

    // A fresh legacy/offline authority row may predate the v2 projection. Create
    // its exact resource in this same transaction; replay paths above only
    // verify existing companions and never repair them.
    projectMemoryV2RepositoryResource(input.repositoryRowId);
    db.prepare(
      `INSERT INTO memory_records
         (record_id, org_id, project_id, repository_row_id, plane, kind, current_version,
          current_status, claim_key, valid_from, valid_until, expires_at,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, 'codebase', ?, 1, 'active', ?, ?, NULL, ?, ?, ?)`,
    ).run(
      recordId,
      input.orgId,
      input.projectId,
      input.repositoryRowId,
      input.kind,
      claimKey,
      validFrom,
      expiresAt,
      now,
      now,
    );
    db.prepare(
      `INSERT INTO memory_record_versions
         (record_id, record_version, content_json, applicability_json, exceptions_json,
          compatibility_json, validation_json, evidence_json, evidence_summary_json,
          freshness_json, provenance_json, embedding_json, content_digest, recorded_at)
       VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      recordId,
      JSON.stringify(input.content),
      JSON.stringify(input.applicability),
      JSON.stringify(input.exceptions),
      JSON.stringify(input.compatibility),
      JSON.stringify(input.validation),
      JSON.stringify(input.evidence),
      JSON.stringify(input.evidenceSummary),
      JSON.stringify(input.freshness),
      JSON.stringify(input.provenance),
      input.embedding ? JSON.stringify(input.embedding) : null,
      contentDigest,
      now,
    );
    insertMemoryV2RecordFacet({
      recordId,
      recordVersion: 1,
      orgId: input.orgId,
      projectId: input.projectId,
      plane: "codebase",
      resourceRowId: memoryV2RepositoryResourceRowId(input.repositoryRowId),
      broadKind: input.kind,
      now,
    });
    db.prepare(
      `INSERT INTO memory_transitions
         (transition_id, org_id, project_id, aggregate_type, aggregate_id, from_status,
          to_status, actor_type, actor_id, reason_code, explanation, evidence_refs_json,
          decision_refs_json, policy_version, occurred_at, committed_at)
       VALUES (?, ?, ?, 'record', ?, NULL, 'active', ?, ?, ?, ?, ?, ?,
               'memory-activation-structural-v1', ?, ?)`,
    ).run(
      transitionId,
      input.orgId,
      input.projectId,
      recordId,
      input.actorType ?? "system",
      input.actorId ?? "memory-seed-import",
      input.reasonCode ?? "seed_fixture_imported",
      input.transitionExplanation
        ?? "Record passed the canonical structural validator and provenance-completeness gate.",
      JSON.stringify(input.evidence.map((item) => item.evidence_ref_id)),
      JSON.stringify(input.decisionRefs ?? []),
      now,
      now,
    );
    const insertSelector = db.prepare(
      `INSERT INTO memory_applicability_indexes
         (record_id, record_version, selector_type, selector_value)
       VALUES (?, 1, ?, ?)`,
    );
    for (const [type, value] of applicabilitySelectors(input.applicability)) {
      insertSelector.run(recordId, type, value);
    }
    db.prepare(
      "INSERT INTO memory_record_versions_fts (record_key, summary, details, selectors) VALUES (?, ?, ?, ?)",
    ).run(
      `${recordId}:1`,
      input.content.summary,
      input.content.details,
      applicabilitySelectors(input.applicability).map(([, value]) => value).join(" "),
    );
    return getMemoryRecord(input.orgId, input.projectId, recordId, 1)!;
  });
}

export function getMemoryRecord(
  orgId: string,
  projectId: string,
  recordId: string,
  version?: number,
): MemoryRecordV1 | null {
  const record = db.prepare(
    "SELECT * FROM memory_records WHERE org_id = ? AND project_id = ? AND record_id = ?",
  ).get(orgId, projectId, recordId) as unknown as RecordRow | undefined;
  if (!record) return null;
  const requestedVersion = version ?? record.current_version;
  const row = db.prepare(
    "SELECT * FROM memory_record_versions WHERE record_id = ? AND record_version = ?",
  ).get(recordId, requestedVersion) as unknown as VersionRow | undefined;
  return row ? rowToDetail(record, row) : null;
}

const ALLOWED_RECORD_TRANSITIONS: Record<RecordStatus, RecordStatus[]> = {
  active: ["stale", "superseded", "revoked", "expired"],
  stale: [],
  superseded: [],
  revoked: [],
  expired: [],
};

function reverificationWorkerOwnsStateTransition(policyVersion: string | undefined): boolean {
  return /^memory-v2-reverification:[1-9][0-9]*$/.test(policyVersion ?? "");
}

/**
 * Canonical lifecycle remains the only writer of memory_records.current_status.
 * When another lifecycle path retires the exact active version, close only its
 * mutable v2 reverification companion and any open jobs in this same database
 * transaction. Scheduled reverification bypasses this hook because its worker
 * commits the immutable decision and richer outcome state immediately after
 * the canonical transition in the encompassing transaction.
 */
function closeMemoryV2ReverificationForCanonicalTransition(input: {
  recordId: string;
  recordVersion: number;
  toStatus: Exclude<RecordStatus, "active">;
  now: string;
}): void {
  markMemoryV2RecordUntrusted({
    recordId: input.recordId,
    recordVersion: input.recordVersion,
    now: input.now,
  });
  const state = db.prepare(
    `SELECT state_version, policy_id, policy_revision
     FROM memory_v2_reverification_state
     WHERE record_id = ? AND record_version = ?`,
  ).get(input.recordId, input.recordVersion) as {
    state_version: number;
    policy_id: string;
    policy_revision: number;
  } | undefined;
  if (!state) return;
  const marker = `canonical_lifecycle_${input.toStatus}`;
  const nextStateVersion = state.state_version + 1;
  const terminalStateStatus = input.toStatus === "expired" ? "expired" : "withdrawn";
  const stateUpdated = db.prepare(
    `UPDATE memory_v2_reverification_state
     SET state_version = ?, status = ?, influence_eligible = 0,
         next_reverify_at = ?, last_error_code = ?, updated_at = ?
     WHERE record_id = ? AND record_version = ? AND state_version = ?
       AND policy_id = ? AND policy_revision = ?`,
  ).run(
    nextStateVersion,
    terminalStateStatus,
    input.now,
    marker,
    input.now,
    input.recordId,
    input.recordVersion,
    state.state_version,
    state.policy_id,
    state.policy_revision,
  );
  if (stateUpdated.changes !== 1) {
    throw new MemoryRecordConflictError(
      "Reverification state changed during canonical lifecycle transition",
    );
  }
  db.prepare(
    `UPDATE memory_v2_reverification_jobs
     SET expected_state_version = ?, status = 'dead_letter',
         lease_owner = NULL, lease_expires_at = NULL,
         next_attempt_at = ?, last_error_code = ?,
         updated_at = ?, dead_lettered_at = ?
     WHERE record_id = ? AND record_version = ?
       AND policy_id = ? AND policy_revision = ?
       AND status IN ('pending','leased')`,
  ).run(
    nextStateVersion,
    input.now,
    marker,
    input.now,
    input.now,
    input.recordId,
    input.recordVersion,
    state.policy_id,
    state.policy_revision,
  );
}

export interface TransitionMemoryRecordStatusInput {
  orgId: string;
  projectId: string;
  recordId: string;
  toStatus: Exclude<RecordStatus, "active">;
  actorId: string;
  reasonCode: string;
  explanation: string;
  expectedCurrentVersion?: number;
  expectedCurrentStatus?: RecordStatus;
  decisionRefs?: readonly string[];
  policyVersion?: string;
  now?: string;
}

export interface MemoryRecordStatusTransition {
  recordId: string;
  recordVersion: number;
  plane: "codebase" | "harness";
  fromStatus: RecordStatus;
  toStatus: Exclude<RecordStatus, "active">;
  aggregateVersion: number;
  transitionId: string;
  committedAt: string;
}

export function transitionMemoryRecordStatus(
  input: TransitionMemoryRecordStatusInput & { canonicalResult: true },
): MemoryRecordStatusTransition | null;
export function transitionMemoryRecordStatus(
  input: TransitionMemoryRecordStatusInput & { canonicalResult?: false },
): MemoryRecordV1 | null;
export function transitionMemoryRecordStatus(
  input: TransitionMemoryRecordStatusInput & { canonicalResult?: boolean },
): MemoryRecordV1 | MemoryRecordStatusTransition | null {
  const now = input.now ?? new Date().toISOString();
  return withImmediateTransaction(() => {
    const record = db.prepare(
      "SELECT * FROM memory_records WHERE org_id = ? AND project_id = ? AND record_id = ?",
    ).get(input.orgId, input.projectId, input.recordId) as unknown as
      | CanonicalLifecycleRecordRow
      | undefined;
    if (!record) return null;
    if (input.expectedCurrentVersion !== undefined
        && record.current_version !== input.expectedCurrentVersion) {
      throw new MemoryRecordConflictError("Record current version changed before lifecycle transition");
    }
    if (input.expectedCurrentStatus !== undefined
        && record.current_status !== input.expectedCurrentStatus) {
      throw new MemoryRecordConflictError("Record current status changed before lifecycle transition");
    }
    const currentTransition = transitionFor(record.org_id, record.project_id, record.record_id);
    if (record.current_status === input.toStatus) {
      if (input.canonicalResult) {
        if (!currentTransition) {
          throw new MemoryRecordConflictError("Record lifecycle transition history is missing");
        }
        return {
          recordId: record.record_id,
          recordVersion: record.current_version,
          plane: record.plane,
          fromStatus: input.toStatus,
          toStatus: input.toStatus,
          aggregateVersion: record.aggregate_version,
          transitionId: currentTransition.transition_id,
          committedAt: currentTransition.committed_at,
        };
      }
      if (record.plane !== "codebase") {
        throw new MemoryRecordConflictError(
          "Harness lifecycle transitions require the canonical transition result",
        );
      }
      return getMemoryRecord(input.orgId, input.projectId, input.recordId);
    }
    if (!ALLOWED_RECORD_TRANSITIONS[record.current_status].includes(input.toStatus)) {
      throw new MemoryRecordConflictError(`Invalid record transition ${record.current_status} -> ${input.toStatus}`);
    }
    const transitionId = `transition_${randomUUID()}`;
    const updated = db.prepare(
      `UPDATE memory_records
       SET current_status = ?, valid_until = ?, updated_at = ?,
           aggregate_version = aggregate_version + 1
       WHERE record_id = ? AND current_version = ?
         AND current_status = ? AND aggregate_version = ?`,
    ).run(
      input.toStatus,
      now,
      now,
      record.record_id,
      record.current_version,
      record.current_status,
      record.aggregate_version,
    );
    if (updated.changes !== 1) {
      throw new MemoryRecordConflictError("Record lifecycle version changed concurrently");
    }
    db.prepare(
      `INSERT INTO memory_transitions
         (transition_id, org_id, project_id, aggregate_type, aggregate_id, from_status,
          to_status, actor_type, actor_id, reason_code, explanation, evidence_refs_json,
          decision_refs_json, policy_version, occurred_at, committed_at)
       VALUES (?, ?, ?, 'record', ?, ?, ?, 'system', ?, ?, ?, '[]', ?,
               ?, ?, ?)`,
    ).run(
      transitionId,
      input.orgId,
      input.projectId,
      input.recordId,
      record.current_status,
      input.toStatus,
      input.actorId,
      input.reasonCode,
      input.explanation.slice(0, 1000),
      JSON.stringify(input.decisionRefs ?? []),
      input.policyVersion ?? "memory-lifecycle-v1",
      now,
      now,
    );
    if (!reverificationWorkerOwnsStateTransition(input.policyVersion)) {
      closeMemoryV2ReverificationForCanonicalTransition({
        recordId: record.record_id,
        recordVersion: record.current_version,
        toStatus: input.toStatus,
        now,
      });
    }
    if (input.canonicalResult) {
      return {
        recordId: record.record_id,
        recordVersion: record.current_version,
        plane: record.plane,
        fromStatus: record.current_status,
        toStatus: input.toStatus,
        aggregateVersion: record.aggregate_version + 1,
        transitionId,
        committedAt: now,
      };
    }
    if (record.plane !== "codebase") {
      throw new MemoryRecordConflictError(
        "Harness lifecycle transitions require the canonical transition result",
      );
    }
    return getMemoryRecord(input.orgId, input.projectId, input.recordId)!;
  });
}

export interface SearchableMemoryRecord {
  record: RecordRow;
  version: VersionRow;
  detail: MemoryRecordV1;
}

export function listAuthorizedCurrentMemoryRecords(input: {
  orgId: string;
  projectId: string;
  repositoryRowId: string;
  now: string;
}): SearchableMemoryRecord[] {
  const rows = db.prepare(
    `SELECT record.*, version.record_id AS version_record_id, version.record_version,
            version.content_json, version.applicability_json, version.exceptions_json,
            version.compatibility_json, version.validation_json, version.evidence_json,
            version.evidence_summary_json, version.freshness_json, version.provenance_json,
            version.embedding_json, version.content_digest, version.recorded_at
     FROM memory_records record
     INNER JOIN memory_record_versions version
       ON version.record_id = record.record_id AND version.record_version = record.current_version
     WHERE record.org_id = ? AND record.project_id = ? AND record.plane = 'codebase'
       AND record.repository_row_id = ? AND record.current_status = 'active'
       AND record.valid_from <= ?
       AND (record.valid_until IS NULL OR record.valid_until > ?)
       AND (record.expires_at IS NULL OR record.expires_at > ?)
     ORDER BY record.record_id`,
  ).all(input.orgId, input.projectId, input.repositoryRowId, input.now, input.now, input.now) as unknown as Array<RecordRow & VersionRow & { version_record_id: string }>;
  return rows.map((row) => {
    const record: RecordRow = row;
    const version: VersionRow = { ...row, record_id: row.version_record_id };
    return { record, version, detail: rowToDetail(record, version) };
  });
}
