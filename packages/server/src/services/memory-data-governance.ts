import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { canonicalJsonSha256 } from "@pim/shared";
import db from "../db/connection.js";

export const MEMORY_RETENTION_DATA_CLASSES = [
  "retrieval_pack",
  "receipt",
  "evidence",
  "candidate",
  "record",
  "feedback",
  "security_log",
] as const;

export type MemoryRetentionDataClass = typeof MEMORY_RETENTION_DATA_CLASSES[number];
export type MemoryGovernanceDataClass = MemoryRetentionDataClass | "tenant";
export type MemoryErasureMethod = "physical_delete" | "field_redaction" | "crypto_shred";

type ScopeType = "org" | "project" | "record";
type TargetAction = "physical_delete" | "field_redaction";

export interface MemoryRetentionPolicyVersion {
  policyVersionId: string;
  orgId: string;
  projectId: string | null;
  dataClass: MemoryRetentionDataClass;
  revision: number;
  retentionDays: number;
  policyDigest: string;
  actorDigest: string;
  reasonCode: string;
  effectiveAt: string;
  createdAt: string;
}

export interface MemoryLegalHold {
  holdId: string;
  orgId: string;
  projectId: string | null;
  dataClass: MemoryGovernanceDataClass;
  resourceId: string | null;
  placedAt: string;
}

export interface MemoryErasureTarget {
  resource_class:
    | "retrieval_pack"
    | "receipt"
    | "evidence"
    | "candidate"
    | "record"
    | "feedback"
    | "security_log"
    | "attestation"
    | "decision"
    | "legacy_import";
  resource_id: string;
  content_digest: string;
  action: TargetAction;
}

export interface MemoryExternalErasureObligation {
  kind: "backup_expiry" | "security_log_retention" | "legacy_graph_and_object_versions";
  state: "pending";
  not_before?: string;
}

export interface MemoryErasurePlan {
  schema_version: "pim.memory-erasure-plan.v1";
  request_id: string;
  purpose: "retention" | "erasure";
  scope_type: ScopeType;
  org_id: string;
  project_id: string | null;
  data_class: MemoryGovernanceDataClass;
  record_id: string | null;
  requested_method: MemoryErasureMethod;
  effective_method: Exclude<MemoryErasureMethod, "crypto_shred">;
  policy_version_id: string | null;
  policy_revision: number | null;
  policy_digest: string | null;
  cutoff_at: string | null;
  planned_at: string;
  backup_not_before: string;
  actor_digest: string;
  reason_code: string;
  scope_snapshot_digest: string;
  targets: MemoryErasureTarget[];
  external_obligations: MemoryExternalErasureObligation[];
  warnings: string[];
  plan_digest: string;
}

export interface MemoryErasureApplyResult {
  requestId: string;
  planDigest: string;
  targetCount: number;
  state: "pending_backup_expiry" | "pending_external_erasure";
  backupNotBefore: string;
}

export class MemoryDataGovernanceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MemoryDataGovernanceError";
  }
}

interface GovernanceScope {
  orgId: string;
  projectId?: string;
}

interface RetentionPolicyRow {
  policy_version_id: string;
  org_id: string;
  project_id: string | null;
  data_class: MemoryRetentionDataClass;
  revision: number;
  retention_days: number;
  policy_digest: string;
  actor_digest: string;
  reason_code: string;
  effective_at: string;
  created_at: string;
}

interface TriggerRow {
  name: string;
  sql: string;
}

const TERMINAL_CANDIDATE_STATUSES = [
  "rejected",
  "quarantined",
  "validation_failed",
  "activation_failed",
] as const;

const GOVERNED_TABLES = [
  "memory_v2_reverification_policies",
  "memory_v2_reverification_state",
  "memory_v2_reverification_decisions",
  "memory_v2_reverification_jobs",
  "memory_v2_reverification_job_attempts",
  "memory_v2_resources",
  "memory_v2_resource_aliases",
  "memory_v2_service_token_resource_bindings",
  "memory_v2_service_token_mcp_profiles",
  "memory_v2_record_facets",
  "memory_v2_candidate_facets",
  "memory_v2_receipt_facets",
  "memory_v2_feedback_facets",
  "memory_v2_facet_quarantine",
  "memory_v2_retrieval_packs",
  "memory_v2_retrieval_pack_items",
  "memory_v2_scope_snapshots",
  "memory_v2_feedback_bindings",
  "memory_v2_feedback_review_signals",
  "memory_v2_corroboration_domains",
  "memory_v2_origins",
  "memory_v2_origin_derivations",
  "memory_v2_origin_roots",
  "memory_v2_candidate_origins",
  "memory_v2_review_signals",
  "memory_repository_registry",
  "memory_repository_aliases",
  "memory_records",
  "memory_record_versions",
  "memory_transitions",
  "memory_retrieval_packs",
  "memory_retrieval_pack_items",
  "memory_applicability_indexes",
  "memory_idempotency_keys",
  "memory_run_receipts",
  "memory_evidence_manifests",
  "memory_evidence_refs",
  "memory_candidates_v1",
  "memory_receipt_candidates",
  "memory_candidate_evidence",
  "memory_feedback",
  "memory_outbox",
  "memory_outbox_attempts",
  "memory_dead_letters",
  "memory_attestations",
  "memory_origins",
  "memory_inbox",
  "memory_provider_cursors",
  "memory_activation_claims",
  "memory_record_supersessions",
  "memory_candidate_decisions",
  "memory_review_signals",
  "memory_service_token_repository_bindings",
  "memory_harness_principal_bindings",
  "memory_legacy_import_items",
  "memory_candidates",
  "project_memory_candidates",
  "project_evidence_items",
  "memory_entities",
  "memory_relationships",
] as const;

const V2_FEEDBACK_TARGET_PREFIX = "memory_v2_feedback_bindings:";
const V2_RUNTIME_EVIDENCE_TARGET_PREFIX = "memory_v2_runtime_receipt:";

function requireNonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new MemoryDataGovernanceError("input_invalid", `${label} must be non-empty`);
  return normalized;
}

function requireReasonCode(value: string): string {
  const reason = requireNonEmpty(value, "reasonCode");
  if (reason.length > 120 || !/^[A-Za-z0-9_.:-]+$/.test(reason)) {
    throw new MemoryDataGovernanceError(
      "input_invalid",
      "reasonCode must contain at most 120 letters, digits, dots, colons, underscores, or hyphens",
    );
  }
  return reason;
}

function iso(value: string | undefined, label: string): string {
  const date = value ? new Date(value) : new Date();
  if (!Number.isFinite(date.getTime())) {
    throw new MemoryDataGovernanceError("input_invalid", `${label} must be an ISO timestamp`);
  }
  return date.toISOString();
}

function actorDigest(actorId: string): string {
  return canonicalJsonSha256({ actor_id: requireNonEmpty(actorId, "actorId") });
}

function tableExists(database: DatabaseSync, table: string): boolean {
  return Boolean(database.prepare(
    "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?",
  ).get(table));
}

function assertScopeExists(database: DatabaseSync, scope: GovernanceScope): void {
  if (!database.prepare("SELECT 1 FROM orgs WHERE org_id = ?").get(scope.orgId)) {
    throw new MemoryDataGovernanceError("scope_not_found", `Organization not found: ${scope.orgId}`);
  }
  if (scope.projectId && !database.prepare(
    "SELECT 1 FROM projects WHERE project_id = ? AND org_id = ?",
  ).get(scope.projectId, scope.orgId)) {
    throw new MemoryDataGovernanceError("scope_not_found", `Project not found in organization: ${scope.projectId}`);
  }
}

function assertCanonicalAuthority(database: DatabaseSync): void {
  const row = database.prepare(
    `SELECT to_authority, legacy_writes_frozen, revision
     FROM memory_authority_transitions
     ORDER BY revision DESC LIMIT 1`,
  ).get() as { to_authority: string; legacy_writes_frozen: number; revision: number } | undefined;
  if (!row || row.to_authority !== "canonical" || row.legacy_writes_frozen !== 1) {
    throw new MemoryDataGovernanceError(
      "canonical_authority_required",
      "Retention and erasure require canonical authority with legacy writes frozen",
    );
  }
}

function mapPolicy(row: RetentionPolicyRow): MemoryRetentionPolicyVersion {
  return {
    policyVersionId: row.policy_version_id,
    orgId: row.org_id,
    projectId: row.project_id,
    dataClass: row.data_class,
    revision: row.revision,
    retentionDays: row.retention_days,
    policyDigest: row.policy_digest,
    actorDigest: row.actor_digest,
    reasonCode: row.reason_code,
    effectiveAt: row.effective_at,
    createdAt: row.created_at,
  };
}

export function createMemoryRetentionPolicyVersion(input: {
  orgId: string;
  projectId?: string;
  dataClass: MemoryRetentionDataClass;
  retentionDays: number;
  actorId: string;
  reasonCode: string;
  effectiveAt?: string;
  now?: string;
  policyVersionId?: string;
}, database: DatabaseSync = db): MemoryRetentionPolicyVersion {
  const scope = {
    orgId: requireNonEmpty(input.orgId, "orgId"),
    projectId: input.projectId ? requireNonEmpty(input.projectId, "projectId") : undefined,
  };
  assertScopeExists(database, scope);
  if (!MEMORY_RETENTION_DATA_CLASSES.includes(input.dataClass)) {
    throw new MemoryDataGovernanceError("input_invalid", `Unsupported data class: ${input.dataClass}`);
  }
  if (!Number.isInteger(input.retentionDays) || input.retentionDays < 0 || input.retentionDays > 36500) {
    throw new MemoryDataGovernanceError("input_invalid", "retentionDays must be an integer from 0 to 36500");
  }
  const reasonCode = requireReasonCode(input.reasonCode);
  const createdAt = iso(input.now, "now");
  const effectiveAt = iso(input.effectiveAt ?? createdAt, "effectiveAt");
  const actor = actorDigest(input.actorId);
  const row = database.prepare(
    `SELECT COALESCE(MAX(revision), 0) AS revision
     FROM memory_retention_policy_versions
     WHERE org_id = ? AND project_id IS ? AND data_class = ?`,
  ).get(scope.orgId, scope.projectId ?? null, input.dataClass) as { revision: number };
  const revision = Number(row.revision) + 1;
  const policyVersionId = input.policyVersionId ?? `memret_${randomUUID()}`;
  const policyDigest = canonicalJsonSha256({
    org_id: scope.orgId,
    project_id: scope.projectId ?? null,
    data_class: input.dataClass,
    revision,
    retention_days: input.retentionDays,
    actor_digest: actor,
    reason_code: reasonCode,
    effective_at: effectiveAt,
  });
  database.prepare(
    `INSERT INTO memory_retention_policy_versions
       (policy_version_id, org_id, project_id, data_class, revision, retention_days,
        policy_digest, actor_digest, reason_code, effective_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    policyVersionId,
    scope.orgId,
    scope.projectId ?? null,
    input.dataClass,
    revision,
    input.retentionDays,
    policyDigest,
    actor,
    reasonCode,
    effectiveAt,
    createdAt,
  );
  return mapPolicy({
    policy_version_id: policyVersionId,
    org_id: scope.orgId,
    project_id: scope.projectId ?? null,
    data_class: input.dataClass,
    revision,
    retention_days: input.retentionDays,
    policy_digest: policyDigest,
    actor_digest: actor,
    reason_code: reasonCode,
    effective_at: effectiveAt,
    created_at: createdAt,
  });
}

export function getCurrentMemoryRetentionPolicy(input: {
  orgId: string;
  projectId?: string;
  dataClass: MemoryRetentionDataClass;
  at?: string;
}, database: DatabaseSync = db): MemoryRetentionPolicyVersion | null {
  const at = iso(input.at, "at");
  const row = database.prepare(
    `SELECT policy_version_id, org_id, project_id, data_class, revision, retention_days,
            policy_digest, actor_digest, reason_code, effective_at, created_at
     FROM memory_retention_policy_versions
     WHERE org_id = ? AND data_class = ? AND effective_at <= ?
       AND (project_id IS ? OR project_id IS NULL)
     ORDER BY CASE WHEN project_id IS ? THEN 0 ELSE 1 END, revision DESC
     LIMIT 1`,
  ).get(
    input.orgId,
    input.dataClass,
    at,
    input.projectId ?? null,
    input.projectId ?? null,
  ) as RetentionPolicyRow | undefined;
  return row ? mapPolicy(row) : null;
}

export function placeMemoryLegalHold(input: {
  orgId: string;
  projectId?: string;
  dataClass: MemoryGovernanceDataClass;
  resourceId?: string;
  actorId: string;
  reasonCode: string;
  now?: string;
  holdId?: string;
}, database: DatabaseSync = db): MemoryLegalHold {
  const scope = {
    orgId: requireNonEmpty(input.orgId, "orgId"),
    projectId: input.projectId ? requireNonEmpty(input.projectId, "projectId") : undefined,
  };
  assertScopeExists(database, scope);
  const holdId = input.holdId ?? `memhold_${randomUUID()}`;
  const occurredAt = iso(input.now, "now");
  database.prepare(
    `INSERT INTO memory_legal_hold_events
       (event_id, hold_id, revision, org_id, project_id, data_class, resource_id,
        action, actor_digest, reason_code, occurred_at, created_at)
     VALUES (?, ?, 1, ?, ?, ?, ?, 'placed', ?, ?, ?, ?)`,
  ).run(
    `memholdevent_${randomUUID()}`,
    holdId,
    scope.orgId,
    scope.projectId ?? null,
    input.dataClass,
    input.resourceId ? requireNonEmpty(input.resourceId, "resourceId") : null,
    actorDigest(input.actorId),
    requireReasonCode(input.reasonCode),
    occurredAt,
    occurredAt,
  );
  return {
    holdId,
    orgId: scope.orgId,
    projectId: scope.projectId ?? null,
    dataClass: input.dataClass,
    resourceId: input.resourceId ?? null,
    placedAt: occurredAt,
  };
}

export function releaseMemoryLegalHold(input: {
  holdId: string;
  actorId: string;
  reasonCode: string;
  now?: string;
}, database: DatabaseSync = db): void {
  const holdId = requireNonEmpty(input.holdId, "holdId");
  const placed = database.prepare(
    `SELECT org_id, project_id, data_class, resource_id
     FROM memory_legal_hold_events
     WHERE hold_id = ? AND revision = 1`,
  ).get(holdId) as {
    org_id: string;
    project_id: string | null;
    data_class: MemoryGovernanceDataClass;
    resource_id: string | null;
  } | undefined;
  if (!placed) throw new MemoryDataGovernanceError("hold_not_found", `Legal hold not found: ${holdId}`);
  if (database.prepare(
    "SELECT 1 FROM memory_legal_hold_events WHERE hold_id = ? AND revision = 2",
  ).get(holdId)) {
    throw new MemoryDataGovernanceError("hold_released", `Legal hold is already released: ${holdId}`);
  }
  const occurredAt = iso(input.now, "now");
  database.prepare(
    `INSERT INTO memory_legal_hold_events
       (event_id, hold_id, revision, org_id, project_id, data_class, resource_id,
        action, actor_digest, reason_code, occurred_at, created_at)
     VALUES (?, ?, 2, ?, ?, ?, ?, 'released', ?, ?, ?, ?)`,
  ).run(
    `memholdevent_${randomUUID()}`,
    holdId,
    placed.org_id,
    placed.project_id,
    placed.data_class,
    placed.resource_id,
    actorDigest(input.actorId),
    requireReasonCode(input.reasonCode),
    occurredAt,
    occurredAt,
  );
}

function activeLegalHolds(database: DatabaseSync, orgId: string): MemoryLegalHold[] {
  const rows = database.prepare(
    `SELECT placed.hold_id, placed.org_id, placed.project_id, placed.data_class,
            placed.resource_id, placed.occurred_at
     FROM memory_legal_hold_events AS placed
     WHERE placed.org_id = ? AND placed.revision = 1
       AND NOT EXISTS (
         SELECT 1 FROM memory_legal_hold_events AS released
         WHERE released.hold_id = placed.hold_id AND released.revision = 2
       )
     ORDER BY placed.hold_id`,
  ).all(orgId) as unknown as Array<{
    hold_id: string;
    org_id: string;
    project_id: string | null;
    data_class: MemoryGovernanceDataClass;
    resource_id: string | null;
    occurred_at: string;
  }>;
  return rows.map((row) => ({
    holdId: row.hold_id,
    orgId: row.org_id,
    projectId: row.project_id,
    dataClass: row.data_class,
    resourceId: row.resource_id,
    placedAt: row.occurred_at,
  }));
}

function targetKey(target: MemoryErasureTarget): string {
  return `${target.resource_class}\0${target.resource_id}`;
}

function sortTargets(targets: MemoryErasureTarget[]): MemoryErasureTarget[] {
  const unique = new Map<string, MemoryErasureTarget>();
  for (const target of targets) unique.set(targetKey(target), target);
  return [...unique.values()].sort((a, b) => targetKey(a).localeCompare(targetKey(b)));
}

function scopedWhere(alias: string, scope: GovernanceScope): { sql: string; params: string[] } {
  return scope.projectId
    ? { sql: `${alias}.org_id = ? AND ${alias}.project_id = ?`, params: [scope.orgId, scope.projectId] }
    : { sql: `${alias}.org_id = ?`, params: [scope.orgId] };
}

function allRows(
  database: DatabaseSync,
  sql: string,
  params: string[] = [],
): Array<Record<string, unknown>> {
  return database.prepare(sql).all(...params) as unknown as Array<Record<string, unknown>>;
}

function digestRows(rows: Array<Record<string, unknown>>): string {
  const digests = rows.map((row) => canonicalJsonSha256(row)).sort();
  return canonicalJsonSha256(digests);
}

function target(
  resourceClass: MemoryErasureTarget["resource_class"],
  resourceId: string,
  value: unknown,
  action: TargetAction,
): MemoryErasureTarget {
  return {
    resource_class: resourceClass,
    resource_id: resourceId,
    content_digest: canonicalJsonSha256(value),
    action,
  };
}

function reverificationRowsForRecords(
  database: DatabaseSync,
  recordIds: readonly string[],
): Record<string, unknown> {
  if (recordIds.length === 0
      || !tableExists(database, "memory_v2_reverification_policies")) return {};
  const marks = placeholders(recordIds);
  const jobs = allRows(
    database,
    `SELECT * FROM memory_v2_reverification_jobs
     WHERE record_id IN (${marks})
     ORDER BY record_id, record_version, scheduled_for, job_id`,
    [...recordIds],
  );
  const jobIds = jobs.map((row) => String(row.job_id));
  return {
    policies: allRows(
      database,
      `SELECT * FROM memory_v2_reverification_policies
       WHERE record_id IN (${marks})
       ORDER BY record_id, record_version, policy_revision, policy_id`,
      [...recordIds],
    ),
    state: allRows(
      database,
      `SELECT * FROM memory_v2_reverification_state
       WHERE record_id IN (${marks})
       ORDER BY record_id, record_version`,
      [...recordIds],
    ),
    decisions: allRows(
      database,
      `SELECT * FROM memory_v2_reverification_decisions
       WHERE record_id IN (${marks})
       ORDER BY record_id, record_version, created_at, decision_id`,
      [...recordIds],
    ),
    jobs,
    attempts: jobIds.length === 0
      ? []
      : allRows(
        database,
        `SELECT * FROM memory_v2_reverification_job_attempts
         WHERE job_id IN (${placeholders(jobIds)})
         ORDER BY job_id, attempt_number, attempt_id`,
        jobIds,
      ),
  };
}

function v2PackTarget(
  database: DatabaseSync,
  pack: Record<string, unknown>,
): MemoryErasureTarget {
  const packId = String(pack.retrieval_pack_id);
  const items = allRows(
    database,
    `SELECT * FROM memory_v2_retrieval_pack_items
     WHERE retrieval_pack_id = ? ORDER BY item_order`,
    [packId],
  );
  const idempotencyClaims = allRows(
    database,
    `SELECT * FROM memory_idempotency_keys
     WHERE operation = 'memory_search_v2' AND response_resource_id = ?
     ORDER BY org_id, project_id, idempotency_key`,
    [packId],
  );
  return target(
    "retrieval_pack",
    packId,
    { pack, items, idempotency_claims: idempotencyClaims },
    "field_redaction",
  );
}

function v2FeedbackTarget(
  database: DatabaseSync,
  feedback: Record<string, unknown>,
): MemoryErasureTarget {
  const feedbackId = String(feedback.feedback_id);
  const reviewSignals = tableExists(database, "memory_v2_feedback_review_signals")
    ? allRows(
      database,
      `SELECT * FROM memory_v2_feedback_review_signals
       WHERE feedback_id = ? ORDER BY signal_id`,
      [feedbackId],
    )
    : [];
  const jobIds = reviewSignals.map((row) => String(row.outbox_job_id));
  const jobs = jobIds.length > 0
    ? allRows(
      database,
      `SELECT * FROM memory_outbox
       WHERE job_id IN (${jobIds.map(() => "?").join(",")}) ORDER BY job_id`,
      jobIds,
    )
    : [];
  const attempts = jobIds.length > 0
    ? allRows(
      database,
      `SELECT * FROM memory_outbox_attempts
       WHERE job_id IN (${jobIds.map(() => "?").join(",")})
       ORDER BY job_id, attempt_number`,
      jobIds,
    )
    : [];
  const deadLetters = jobIds.length > 0
    ? allRows(
      database,
      `SELECT * FROM memory_dead_letters
       WHERE job_id IN (${jobIds.map(() => "?").join(",")}) ORDER BY job_id`,
      jobIds,
    )
    : [];
  const idempotencyClaims = allRows(
    database,
    `SELECT * FROM memory_idempotency_keys
     WHERE operation = 'memory_feedback_v2' AND response_resource_id = ?
     ORDER BY org_id, project_id, idempotency_key`,
    [feedbackId],
  );
  return target(
    "feedback",
    `${V2_FEEDBACK_TARGET_PREFIX}${feedbackId}`,
    {
      feedback,
      review_signals: reviewSignals,
      outbox_jobs: jobs,
      outbox_attempts: attempts,
      dead_letters: deadLetters,
      idempotency_claims: idempotencyClaims,
    },
    "physical_delete",
  );
}

function runtimeReceiptEvidenceRows(
  database: DatabaseSync,
  receiptId: string,
): Record<string, unknown> {
  if (!tableExists(database, "memory_v2_origins")) return {};
  const origins = allRows(
    database,
    "SELECT * FROM memory_v2_origins WHERE receipt_id = ? ORDER BY origin_id",
    [receiptId],
  );
  const originIds = origins.map((row) => String(row.origin_id));
  if (originIds.length === 0) return {};
  const marks = placeholders(originIds);
  const domainIds = [...new Set(
    origins.map((row) => String(row.corroboration_domain_id)),
  )].sort();
  const domainMarks = placeholders(domainIds);
  return {
    corroboration_domains: allRows(
      database,
      `SELECT * FROM memory_v2_corroboration_domains
       WHERE corroboration_domain_id IN (${domainMarks})
       ORDER BY corroboration_domain_id`,
      domainIds,
    ),
    origins,
    derivations: allRows(
      database,
      `SELECT * FROM memory_v2_origin_derivations
       WHERE origin_id IN (${marks}) ORDER BY origin_id, parent_origin_id`,
      originIds,
    ),
    roots: allRows(
      database,
      `SELECT * FROM memory_v2_origin_roots
       WHERE origin_id IN (${marks}) ORDER BY origin_id, root_origin_id`,
      originIds,
    ),
    candidate_links: allRows(
      database,
      `SELECT * FROM memory_v2_candidate_origins
       WHERE origin_id IN (${marks}) ORDER BY origin_id, candidate_id`,
      originIds,
    ),
    review_signals: allRows(
      database,
      `SELECT * FROM memory_v2_review_signals
       WHERE first_origin_id IN (${marks}) OR repeated_origin_id IN (${marks})
       ORDER BY signal_id`,
      [...originIds, ...originIds],
    ),
  };
}

function runtimeEvidenceTarget(
  database: DatabaseSync,
  receiptId: string,
): MemoryErasureTarget {
  return target(
    "evidence",
    `${V2_RUNTIME_EVIDENCE_TARGET_PREFIX}${receiptId}`,
    runtimeReceiptEvidenceRows(database, receiptId),
    "physical_delete",
  );
}

function legacyFeedbackTarget(
  database: DatabaseSync,
  feedback: Record<string, unknown>,
): MemoryErasureTarget {
  const feedbackId = String(feedback.feedback_id);
  const reviewSignals = allRows(
    database,
    "SELECT * FROM memory_review_signals WHERE feedback_id = ? ORDER BY signal_id",
    [feedbackId],
  );
  const jobs = allRows(
    database,
    `SELECT * FROM memory_outbox
     WHERE json_valid(payload_json)
       AND json_extract(payload_json, '$.feedback_id') = ?
       AND (
         json_extract(payload_json, '$.feedback_source') IS NULL
         OR json_extract(payload_json, '$.feedback_source') = 'memory_feedback'
       )
     ORDER BY job_id`,
    [feedbackId],
  );
  const jobIds = jobs.map((row) => String(row.job_id));
  const attempts = jobIds.length > 0
    ? allRows(
      database,
      `SELECT * FROM memory_outbox_attempts
       WHERE job_id IN (${jobIds.map(() => "?").join(",")})
       ORDER BY job_id, attempt_number`,
      jobIds,
    )
    : [];
  const deadLetters = jobIds.length > 0
    ? allRows(
      database,
      `SELECT * FROM memory_dead_letters
       WHERE job_id IN (${jobIds.map(() => "?").join(",")}) ORDER BY job_id`,
      jobIds,
    )
    : [];
  return target(
    "feedback",
    feedbackId,
    {
      feedback,
      review_signals: reviewSignals,
      outbox_jobs: jobs,
      outbox_attempts: attempts,
      dead_letters: deadLetters,
    },
    "physical_delete",
  );
}

function recordTargets(
  database: DatabaseSync,
  scope: GovernanceScope,
  options: { cutoffAt?: string; recordId?: string } = {},
): MemoryErasureTarget[] {
  const where = scopedWhere("record", scope);
  const extra: string[] = [];
  const params = [...where.params];
  if (options.recordId) {
    extra.push("record.record_id = ?");
    params.push(options.recordId);
  }
  if (options.cutoffAt) {
    extra.push("record.current_status IN ('stale','superseded','revoked','expired')");
    extra.push("record.updated_at <= ?");
    params.push(options.cutoffAt);
  }
  const rows = allRows(
    database,
    `SELECT record.* FROM memory_records AS record
     WHERE ${where.sql}${extra.length ? ` AND ${extra.join(" AND ")}` : ""}
     ORDER BY record.record_id`,
    params,
  );
  const roots = rows.map((row) => {
    const recordId = String(row.record_id);
    const versions = allRows(
      database,
      "SELECT * FROM memory_record_versions WHERE record_id = ? ORDER BY record_version",
      [recordId],
    );
    return target(
      "record",
      recordId,
      {
        record: row,
        versions,
        reverification: reverificationRowsForRecords(database, [recordId]),
      },
      "physical_delete",
    );
  });
  const recordIds = roots.map((entry) => entry.resource_id);
  if (recordIds.length === 0) return roots;
  const marks = placeholders(recordIds);
  const candidates = allRows(
    database,
    `SELECT * FROM memory_candidates_v1 WHERE active_record_id IN (${marks})`,
    recordIds,
  );
  const candidateIds = candidates.map((row) => String(row.candidate_id));
  const collateral: MemoryErasureTarget[] = candidates.map((row) =>
    target("candidate", String(row.candidate_id), row, "physical_delete"));
  collateral.push(...candidateClosureAuditTargets(database, candidateIds));
  for (const row of allRows(
    database,
    `SELECT DISTINCT pack.* FROM memory_retrieval_packs AS pack
     JOIN memory_retrieval_pack_items AS item
       ON item.retrieval_pack_id = pack.retrieval_pack_id
     WHERE item.record_id IN (${marks})`,
    recordIds,
  )) collateral.push(target("retrieval_pack", String(row.retrieval_pack_id), row, "field_redaction"));
  if (tableExists(database, "memory_v2_retrieval_pack_items")) {
    for (const row of allRows(
      database,
      `SELECT DISTINCT pack.* FROM memory_v2_retrieval_packs AS pack
       JOIN memory_v2_retrieval_pack_items AS item
         ON item.retrieval_pack_id = pack.retrieval_pack_id
       WHERE item.record_id IN (${marks})`,
      recordIds,
    )) collateral.push(v2PackTarget(database, row));
  }
  for (const row of allRows(
    database,
    `SELECT * FROM memory_feedback WHERE record_id IN (${marks})`,
    recordIds,
  )) collateral.push(legacyFeedbackTarget(database, row));
  if (tableExists(database, "memory_v2_feedback_bindings")) {
    for (const row of allRows(
      database,
      `SELECT * FROM memory_v2_feedback_bindings WHERE record_id IN (${marks})`,
      recordIds,
    )) collateral.push(v2FeedbackTarget(database, row));
  }
  if (tableExists(database, "memory_legacy_import_items")) {
    for (const row of legacyImportRowsForRecords(database, recordIds)) {
      collateral.push(target("legacy_import", String(row.import_item_id), row, "field_redaction"));
    }
  }
  return sortTargets([...roots, ...collateral]);
}

function legacyImportRowsForRecords(
  database: DatabaseSync,
  recordIds: readonly string[],
): Array<Record<string, unknown>> {
  if (recordIds.length === 0 || !tableExists(database, "memory_legacy_import_items")) return [];
  const marks = placeholders(recordIds);
  return allRows(
    database,
    `WITH RECURSIVE selected(import_item_id) AS (
       SELECT import_item_id
       FROM memory_legacy_import_items
       WHERE canonical_record_id IN (${marks})
       UNION
       SELECT child.import_item_id
       FROM memory_legacy_import_items AS child
       JOIN selected AS parent ON child.duplicate_of_item_id = parent.import_item_id
     )
     SELECT item.*
     FROM memory_legacy_import_items AS item
     JOIN selected ON selected.import_item_id = item.import_item_id
     ORDER BY item.import_item_id`,
    [...recordIds],
  );
}

function legacyImportRowsForPendingCandidateLineage(
  database: DatabaseSync,
  keyColumn: "candidate_id" | "receipt_id",
  ids: readonly string[],
): Array<Record<string, unknown>> {
  if (ids.length === 0 || !tableExists(database, "memory_legacy_import_items")) return [];
  const marks = placeholders(ids);
  const tombstoneFilter = tableExists(database, "memory_erasure_tombstones")
    ? `WHERE NOT EXISTS (
         SELECT 1 FROM memory_erasure_tombstones AS tombstone
         WHERE tombstone.resource_class = 'legacy_import'
           AND tombstone.resource_id = item.import_item_id
       )`
    : "";
  return allRows(
    database,
    `WITH RECURSIVE selected(import_item_id) AS (
       SELECT item.import_item_id
       FROM memory_legacy_import_items AS item
       JOIN memory_candidates_v1 AS candidate
         ON candidate.client_candidate_id = item.import_item_id
        AND candidate.org_id = item.org_id
        AND candidate.project_id IS item.project_id
       WHERE candidate.${keyColumn} IN (${marks})
         AND candidate.producer_harness_id = 'pim-legacy-migration'
         AND json_extract(
           candidate.candidate_json,
           '$.extensions.legacy_import_item_id'
         ) = item.import_item_id
       UNION
       SELECT child.import_item_id
       FROM memory_legacy_import_items AS child
       JOIN selected AS parent ON child.duplicate_of_item_id = parent.import_item_id
     )
     SELECT item.*
     FROM memory_legacy_import_items AS item
     JOIN selected ON selected.import_item_id = item.import_item_id
     ${tombstoneFilter}
     ORDER BY item.import_item_id`,
    [...ids],
  );
}

function candidateClosureAuditTargets(
  database: DatabaseSync,
  candidateIds: readonly string[],
): MemoryErasureTarget[] {
  if (candidateIds.length === 0) return [];
  const marks = placeholders(candidateIds);
  const targets: MemoryErasureTarget[] = [];
  for (const row of allRows(
    database,
    `SELECT DISTINCT receipt.* FROM memory_run_receipts AS receipt
     JOIN memory_receipt_candidates AS link ON link.receipt_id = receipt.receipt_id
     WHERE link.candidate_id IN (${marks})
       AND NOT EXISTS (
         SELECT 1
         FROM memory_receipt_candidates AS surviving_link
         JOIN memory_candidates_v1 AS surviving_candidate
           ON surviving_candidate.candidate_id = surviving_link.candidate_id
         WHERE surviving_link.receipt_id = receipt.receipt_id
           AND surviving_link.candidate_id NOT IN (${marks})
           AND surviving_candidate.current_status NOT IN ('rejected','quarantined')
       )`,
    [...candidateIds, ...candidateIds],
  )) targets.push(target("receipt", String(row.receipt_id), row, "field_redaction"));
  for (const row of allRows(
    database,
    `SELECT * FROM memory_candidate_decisions WHERE candidate_id IN (${marks})`,
    [...candidateIds],
  )) targets.push(target("decision", String(row.decision_id), row, "physical_delete"));
  return sortTargets(targets);
}

function candidateTargets(
  database: DatabaseSync,
  scope: GovernanceScope,
  cutoffAt?: string,
): MemoryErasureTarget[] {
  const where = scopedWhere("candidate", scope);
  const params = [...where.params];
  let cutoffSql = "";
  if (cutoffAt) {
    cutoffSql = ` AND candidate.current_status IN (${TERMINAL_CANDIDATE_STATUSES.map(() => "?").join(",")})
      AND candidate.updated_at <= ?`;
    params.push(...TERMINAL_CANDIDATE_STATUSES, cutoffAt);
  }
  const rows = allRows(
    database,
    `SELECT candidate.* FROM memory_candidates_v1 AS candidate
     WHERE ${where.sql}${cutoffSql} ORDER BY candidate.candidate_id`,
    params,
  );
  const roots = rows.map((row) =>
    target("candidate", String(row.candidate_id), row, "physical_delete"));
  const candidateIds = roots.map((entry) => entry.resource_id);
  return sortTargets([
    ...roots,
    ...candidateClosureAuditTargets(database, candidateIds),
    ...legacyImportRowsForPendingCandidateLineage(database, "candidate_id", candidateIds)
      .map((row) => target(
        "legacy_import",
        String(row.import_item_id),
        row,
        "field_redaction",
      )),
  ]);
}

function feedbackTargets(
  database: DatabaseSync,
  scope: GovernanceScope,
  cutoffAt?: string,
): MemoryErasureTarget[] {
  const where = scopedWhere("feedback", scope);
  const params = [...where.params];
  const cutoffSql = cutoffAt ? " AND feedback.created_at <= ?" : "";
  if (cutoffAt) params.push(cutoffAt);
  const targets = allRows(
    database,
    `SELECT feedback.* FROM memory_feedback AS feedback
     WHERE ${where.sql}${cutoffSql} ORDER BY feedback.feedback_id`,
    params,
  ).map((row) => legacyFeedbackTarget(database, row));
  if (tableExists(database, "memory_v2_feedback_bindings")) {
    const v2Where = scopedWhere("feedback", scope);
    const v2Params = [...v2Where.params];
    const v2CutoffSql = cutoffAt ? " AND feedback.created_at <= ?" : "";
    if (cutoffAt) v2Params.push(cutoffAt);
    for (const row of allRows(
      database,
      `SELECT feedback.* FROM memory_v2_feedback_bindings AS feedback
       WHERE ${v2Where.sql}${v2CutoffSql} ORDER BY feedback.feedback_id`,
      v2Params,
    )) targets.push(v2FeedbackTarget(database, row));
  }
  return sortTargets(targets);
}

function packTargets(
  database: DatabaseSync,
  scope: GovernanceScope,
  cutoffAt?: string,
  plannedAt?: string,
): MemoryErasureTarget[] {
  const where = scopedWhere("pack", scope);
  const params = [...where.params];
  let cutoffSql = "";
  if (cutoffAt) {
    cutoffSql = " AND pack.created_at <= ? AND pack.expires_at <= ?";
    params.push(cutoffAt, plannedAt ?? cutoffAt);
  }
  const targets = allRows(
    database,
    `SELECT pack.* FROM memory_retrieval_packs AS pack
     WHERE ${where.sql}${cutoffSql}
       AND NOT EXISTS (
         SELECT 1 FROM memory_erasure_tombstones AS tombstone
         WHERE tombstone.resource_class = 'retrieval_pack'
           AND tombstone.resource_id = pack.retrieval_pack_id
       )
     ORDER BY pack.retrieval_pack_id`,
    params,
  ).map((row) => target(
    "retrieval_pack",
    String(row.retrieval_pack_id),
    row,
    "field_redaction",
  ));
  if (tableExists(database, "memory_v2_retrieval_packs")) {
    const v2Where = scopedWhere("pack", scope);
    const v2Params = [...v2Where.params];
    let v2CutoffSql = "";
    if (cutoffAt) {
      v2CutoffSql = " AND pack.created_at <= ? AND pack.expires_at <= ?";
      v2Params.push(cutoffAt, plannedAt ?? cutoffAt);
    }
    for (const row of allRows(
      database,
      `SELECT pack.* FROM memory_v2_retrieval_packs AS pack
       WHERE ${v2Where.sql}${v2CutoffSql}
         AND NOT EXISTS (
           SELECT 1 FROM memory_erasure_tombstones AS tombstone
           WHERE tombstone.resource_class = 'retrieval_pack'
             AND tombstone.resource_id = pack.retrieval_pack_id
         )
       ORDER BY pack.retrieval_pack_id`,
      v2Params,
    )) targets.push(v2PackTarget(database, row));
  }
  return sortTargets(targets);
}

function receiptTargets(
  database: DatabaseSync,
  scope: GovernanceScope,
  cutoffAt?: string,
): MemoryErasureTarget[] {
  const where = scopedWhere("receipt", scope);
  const params = [...where.params];
  const cutoffSql = cutoffAt ? ` AND receipt.created_at <= ?
    AND NOT EXISTS (
      SELECT 1
      FROM memory_candidates_v1 AS candidate
      WHERE candidate.receipt_id = receipt.receipt_id
        AND candidate.current_status NOT IN ('rejected','quarantined')
    )` : "";
  if (cutoffAt) params.push(cutoffAt);
  const rows = allRows(
    database,
    `SELECT receipt.* FROM memory_run_receipts AS receipt
     WHERE ${where.sql}${cutoffSql}
       AND NOT EXISTS (
         SELECT 1 FROM memory_erasure_tombstones AS tombstone
         WHERE tombstone.resource_class = 'receipt'
           AND tombstone.resource_id = receipt.receipt_id
       )
     ORDER BY receipt.receipt_id`,
    params,
  );
  const roots = rows.map((row) => {
    const receiptId = String(row.receipt_id);
    const scopeSnapshot = tableExists(database, "memory_v2_scope_snapshots")
      ? allRows(
        database,
        "SELECT * FROM memory_v2_scope_snapshots WHERE receipt_id = ?",
        [receiptId],
      )
      : [];
    const receiptFeedback = tableExists(database, "memory_v2_feedback_bindings")
      ? allRows(
        database,
        `SELECT * FROM memory_v2_feedback_bindings
         WHERE receipt_id = ? AND feedback_stage = 'receipt' ORDER BY feedback_id`,
        [receiptId],
      )
      : [];
    const runtimeEvidence = runtimeReceiptEvidenceRows(database, receiptId);
    const value = scopeSnapshot.length > 0
        || receiptFeedback.length > 0
        || Object.keys(runtimeEvidence).length > 0
      ? {
          receipt: row,
          scope_snapshot: scopeSnapshot,
          receipt_feedback: receiptFeedback,
          runtime_evidence: runtimeEvidence,
        }
      : row;
    return target("receipt", receiptId, value, "field_redaction");
  });
  return sortTargets([
    ...roots,
    ...legacyImportRowsForPendingCandidateLineage(
      database,
      "receipt_id",
      roots.map((entry) => entry.resource_id),
    ).map((row) => target(
      "legacy_import",
      String(row.import_item_id),
      row,
      "field_redaction",
    )),
  ]);
}

function evidenceTargets(
  database: DatabaseSync,
  scope: GovernanceScope,
  cutoffAt?: string,
): MemoryErasureTarget[] {
  const where = scopedWhere("manifest", scope);
  const params = [...where.params];
  let cutoffSql = "";
  if (cutoffAt) {
    cutoffSql = ` AND manifest.created_at <= ?
      AND NOT EXISTS (
        SELECT 1
        FROM memory_candidates_v1 AS candidate
        WHERE candidate.evidence_manifest_row_id = manifest.evidence_manifest_row_id
          AND candidate.current_status NOT IN ('rejected','quarantined','validation_failed','activation_failed')
      )`;
    params.push(cutoffAt);
  }
  const manifests = allRows(
    database,
    `SELECT manifest.* FROM memory_evidence_manifests AS manifest
     WHERE ${where.sql}${cutoffSql}
       AND NOT EXISTS (
         SELECT 1 FROM memory_erasure_tombstones AS tombstone
         WHERE tombstone.resource_class = 'evidence'
           AND tombstone.resource_id = manifest.evidence_manifest_row_id
       )
     ORDER BY manifest.evidence_manifest_row_id`,
    params,
  );
  const targets = manifests.map((manifest) => {
    const refs = allRows(
      database,
      `SELECT * FROM memory_evidence_refs
       WHERE evidence_manifest_row_id = ? ORDER BY evidence_row_id`,
      [String(manifest.evidence_manifest_row_id)],
    );
    return target(
      "evidence",
      String(manifest.evidence_manifest_row_id),
      { manifest, refs },
      "field_redaction",
    );
  });
  if (tableExists(database, "memory_v2_origins")) {
    const runtimeWhere = scopedWhere("origin", scope);
    const runtimeParams = [...runtimeWhere.params];
    const receipts = database.prepare(
      `SELECT origin.receipt_id, MAX(origin.created_at) AS newest_at
       FROM memory_v2_origins AS origin
       WHERE ${runtimeWhere.sql}
         AND NOT EXISTS (
           SELECT 1
           FROM memory_v2_candidate_origins AS link
           JOIN memory_candidates_v1 AS candidate
             ON candidate.candidate_id = link.candidate_id
           WHERE link.receipt_id = origin.receipt_id
             AND candidate.current_status NOT IN (
               'rejected','quarantined','validation_failed','activation_failed'
             )
         )
       GROUP BY origin.receipt_id
       ${cutoffAt ? "HAVING MAX(origin.created_at) <= ?" : ""}
       ORDER BY origin.receipt_id`,
    ).all(...runtimeParams, ...(cutoffAt ? [cutoffAt] : [])) as unknown as Array<{
      receipt_id: string;
    }>;
    for (const receipt of receipts) {
      targets.push(runtimeEvidenceTarget(database, receipt.receipt_id));
    }
  }
  return targets;
}

function tenantAuditTargets(database: DatabaseSync, scope: GovernanceScope): MemoryErasureTarget[] {
  const targets = [
    ...recordTargets(database, scope),
    ...candidateTargets(database, scope),
    ...feedbackTargets(database, scope),
    ...packTargets(database, scope),
    ...receiptTargets(database, scope),
    ...evidenceTargets(database, scope),
  ];
  for (const [table, alias, idColumn, resourceClass] of [
    ["memory_attestations", "attestation", "attestation_row_id", "attestation"],
    ["memory_candidate_decisions", "decision", "decision_id", "decision"],
    ["memory_legacy_import_items", "legacy", "import_item_id", "legacy_import"],
  ] as const) {
    if (!tableExists(database, table)) continue;
    const where = scopedWhere(alias, scope);
    const rows = allRows(
      database,
      `SELECT ${alias}.* FROM ${table} AS ${alias}
       WHERE ${where.sql} ORDER BY ${alias}.${idColumn}`,
      where.params,
    );
    for (const row of rows) {
      targets.push(target(
        resourceClass,
        String(row[idColumn]),
        row,
        resourceClass === "legacy_import" ? "field_redaction" : "physical_delete",
      ));
    }
  }
  return sortTargets(targets);
}

function directScopeRows(
  database: DatabaseSync,
  table: string,
  scope: GovernanceScope,
): Array<Record<string, unknown>> {
  if (!tableExists(database, table)) return [];
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has("org_id")) return [];
  if (scope.projectId && !names.has("project_id")) return [];
  const condition = scope.projectId ? "org_id = ? AND project_id = ?" : "org_id = ?";
  const params = scope.projectId ? [scope.orgId, scope.projectId] : [scope.orgId];
  return allRows(database, `SELECT * FROM ${table} WHERE ${condition}`, params);
}

function tenantScopeSnapshotDigest(database: DatabaseSync, scope: GovernanceScope): string {
  const snapshots: Array<{ table: string; digest: string }> = [];
  for (const table of GOVERNED_TABLES) {
    const rows = directScopeRows(database, table, scope);
    if (rows.length > 0) snapshots.push({ table, digest: digestRows(rows) });
  }
  const childQueries: Array<[string, string, string[]]> = [];
  const scopeParams = scope.projectId ? [scope.orgId, scope.projectId] : [scope.orgId];
  const direct = (alias: string) => scope.projectId
    ? `${alias}.org_id = ? AND ${alias}.project_id = ?`
    : `${alias}.org_id = ?`;
  childQueries.push(
    ["memory_record_versions", `SELECT child.* FROM memory_record_versions child
      JOIN memory_records parent ON parent.record_id = child.record_id WHERE ${direct("parent")}`, scopeParams],
    ["memory_retrieval_pack_items", `SELECT child.* FROM memory_retrieval_pack_items child
      JOIN memory_retrieval_packs parent ON parent.retrieval_pack_id = child.retrieval_pack_id
      WHERE ${direct("parent")}`, scopeParams],
    ["memory_v2_retrieval_pack_items", `SELECT child.* FROM memory_v2_retrieval_pack_items child
      JOIN memory_v2_retrieval_packs parent ON parent.retrieval_pack_id = child.retrieval_pack_id
      WHERE ${direct("parent")}`, scopeParams],
    ["memory_evidence_refs", `SELECT child.* FROM memory_evidence_refs child
      JOIN memory_evidence_manifests parent
        ON parent.evidence_manifest_row_id = child.evidence_manifest_row_id
      WHERE ${direct("parent")}`, scopeParams],
    ["memory_receipt_candidates", `SELECT child.* FROM memory_receipt_candidates child
      JOIN memory_run_receipts parent ON parent.receipt_id = child.receipt_id WHERE ${direct("parent")}`, scopeParams],
    ["memory_candidate_evidence", `SELECT child.* FROM memory_candidate_evidence child
      JOIN memory_candidates_v1 parent ON parent.candidate_id = child.candidate_id WHERE ${direct("parent")}`, scopeParams],
    ["memory_outbox_attempts", `SELECT child.* FROM memory_outbox_attempts child
      JOIN memory_outbox parent ON parent.job_id = child.job_id WHERE ${direct("parent")}`, scopeParams],
    ["memory_v2_reverification_job_attempts", `SELECT child.*
      FROM memory_v2_reverification_job_attempts child
      JOIN memory_v2_reverification_jobs parent ON parent.job_id = child.job_id
      WHERE ${direct("parent")}`, scopeParams],
  );
  for (const [table, sql, params] of childQueries) {
    if (!tableExists(database, table)) continue;
    const rows = allRows(database, sql, params);
    if (rows.length > 0) snapshots.push({ table, digest: digestRows(rows) });
  }
  snapshots.sort((a, b) => a.table.localeCompare(b.table));
  return canonicalJsonSha256(snapshots);
}

function classTargets(
  database: DatabaseSync,
  scope: GovernanceScope,
  dataClass: MemoryRetentionDataClass,
  cutoffAt: string,
  plannedAt: string,
): MemoryErasureTarget[] {
  switch (dataClass) {
    case "retrieval_pack": return packTargets(database, scope, cutoffAt, plannedAt);
    case "receipt": return receiptTargets(database, scope, cutoffAt);
    case "evidence": return evidenceTargets(database, scope, cutoffAt);
    case "candidate": return candidateTargets(database, scope, cutoffAt);
    case "record": return recordTargets(database, scope, { cutoffAt });
    case "feedback": return feedbackTargets(database, scope, cutoffAt);
    case "security_log": return [];
  }
}

function finalizePlan(input: Omit<MemoryErasurePlan, "plan_digest">): MemoryErasurePlan {
  return { ...input, plan_digest: canonicalJsonSha256(input) };
}

function backupNotBefore(plannedAt: string, retentionDays: number): string {
  if (!Number.isInteger(retentionDays) || retentionDays < 0 || retentionDays > 36500) {
    throw new MemoryDataGovernanceError("input_invalid", "backupRetentionDays is invalid");
  }
  return new Date(new Date(plannedAt).getTime() + retentionDays * 86_400_000).toISOString();
}

function retentionEffectiveMethod(dataClass: MemoryRetentionDataClass): TargetAction {
  return ["retrieval_pack", "receipt", "evidence", "security_log"].includes(dataClass)
    ? "field_redaction"
    : "physical_delete";
}

export function planMemoryRetention(input: {
  orgId: string;
  projectId?: string;
  dataClass: MemoryRetentionDataClass;
  actorId: string;
  reasonCode: string;
  now?: string;
  requestId?: string;
  backupRetentionDays?: number;
}, database: DatabaseSync = db): MemoryErasurePlan {
  const scope = {
    orgId: requireNonEmpty(input.orgId, "orgId"),
    projectId: input.projectId ? requireNonEmpty(input.projectId, "projectId") : undefined,
  };
  assertScopeExists(database, scope);
  assertCanonicalAuthority(database);
  const plannedAt = iso(input.now, "now");
  const policy = getCurrentMemoryRetentionPolicy({
    orgId: scope.orgId,
    projectId: scope.projectId,
    dataClass: input.dataClass,
    at: plannedAt,
  }, database);
  if (!policy) {
    throw new MemoryDataGovernanceError(
      "retention_policy_required",
      `No effective ${input.dataClass} retention policy exists for the requested scope`,
    );
  }
  const cutoffAt = new Date(
    new Date(plannedAt).getTime() - policy.retentionDays * 86_400_000,
  ).toISOString();
  const targets = sortTargets(classTargets(database, scope, input.dataClass, cutoffAt, plannedAt));
  const externalObligations: MemoryExternalErasureObligation[] = [{
    kind: "backup_expiry",
    state: "pending",
    not_before: backupNotBefore(plannedAt, input.backupRetentionDays ?? 91),
  }];
  if (input.dataClass === "security_log") {
    externalObligations.push({ kind: "security_log_retention", state: "pending" });
  }
  return finalizePlan({
    schema_version: "pim.memory-erasure-plan.v1",
    request_id: input.requestId ?? `memerase_${randomUUID()}`,
    purpose: "retention",
    scope_type: scope.projectId ? "project" : "org",
    org_id: scope.orgId,
    project_id: scope.projectId ?? null,
    data_class: input.dataClass,
    record_id: null,
    requested_method: retentionEffectiveMethod(input.dataClass),
    effective_method: retentionEffectiveMethod(input.dataClass),
    policy_version_id: policy.policyVersionId,
    policy_revision: policy.revision,
    policy_digest: policy.policyDigest,
    cutoff_at: cutoffAt,
    planned_at: plannedAt,
    backup_not_before: externalObligations[0]!.not_before!,
    actor_digest: actorDigest(input.actorId),
    reason_code: requireReasonCode(input.reasonCode),
    scope_snapshot_digest: canonicalJsonSha256(targets),
    targets,
    external_obligations: externalObligations,
    warnings: input.dataClass === "security_log"
      ? ["security_logs_are_external_and_remain_pending_until_log_retention_is_verified"]
      : [],
  });
}

export function planMemoryErasure(input: {
  orgId: string;
  projectId?: string;
  dataClass: "tenant" | "record";
  recordId?: string;
  method: MemoryErasureMethod;
  actorId: string;
  reasonCode: string;
  now?: string;
  requestId?: string;
  backupRetentionDays?: number;
}, database: DatabaseSync = db): MemoryErasurePlan {
  const scope = {
    orgId: requireNonEmpty(input.orgId, "orgId"),
    projectId: input.projectId ? requireNonEmpty(input.projectId, "projectId") : undefined,
  };
  assertScopeExists(database, scope);
  assertCanonicalAuthority(database);
  if (input.method === "crypto_shred") {
    throw new MemoryDataGovernanceError(
      "crypto_shred_unavailable",
      "Per-tenant cryptographic deletion is unavailable for shared plaintext SQLite and shared backups",
    );
  }
  if (input.dataClass === "tenant" && input.method !== "physical_delete") {
    throw new MemoryDataGovernanceError(
      "method_unsupported",
      "Tenant erasure supports physical_delete only",
    );
  }
  if (input.dataClass === "record" && (!scope.projectId || !input.recordId)) {
    throw new MemoryDataGovernanceError(
      "input_invalid",
      "Record erasure requires projectId and recordId",
    );
  }
  const plannedAt = iso(input.now, "now");
  const targets = input.dataClass === "tenant"
    ? tenantAuditTargets(database, scope)
    : recordTargets(database, scope, { recordId: requireNonEmpty(input.recordId!, "recordId") });
  if (input.dataClass === "record" && targets.length === 0) {
    throw new MemoryDataGovernanceError("record_not_found", `Record not found in scope: ${input.recordId}`);
  }
  const effectiveMethod: TargetAction = "physical_delete";
  const notBefore = backupNotBefore(plannedAt, input.backupRetentionDays ?? 91);
  const warnings = input.method === "field_redaction"
    ? ["immutable_record_field_redaction_escalates_to_whole_record_physical_erasure"]
    : [];
  if (input.dataClass === "tenant") {
    warnings.push("legacy_graph_s3_versions_and_recovery_copies_require_external_expiry_or_purge");
  }
  return finalizePlan({
    schema_version: "pim.memory-erasure-plan.v1",
    request_id: input.requestId ?? `memerase_${randomUUID()}`,
    purpose: "erasure",
    scope_type: input.dataClass === "record" ? "record" : scope.projectId ? "project" : "org",
    org_id: scope.orgId,
    project_id: scope.projectId ?? null,
    data_class: input.dataClass,
    record_id: input.dataClass === "record" ? input.recordId! : null,
    requested_method: input.method,
    effective_method: effectiveMethod,
    policy_version_id: null,
    policy_revision: null,
    policy_digest: null,
    cutoff_at: null,
    planned_at: plannedAt,
    backup_not_before: notBefore,
    actor_digest: actorDigest(input.actorId),
    reason_code: requireReasonCode(input.reasonCode),
    scope_snapshot_digest: input.dataClass === "tenant"
      ? tenantScopeSnapshotDigest(database, scope)
      : canonicalJsonSha256(targets),
    targets: sortTargets(targets),
    external_obligations: [
      { kind: "backup_expiry", state: "pending", not_before: notBefore },
      ...(input.dataClass === "tenant"
        ? [{ kind: "legacy_graph_and_object_versions", state: "pending" } as const]
        : []),
    ],
    warnings,
  });
}

function assertPlanSelfDigest(plan: MemoryErasurePlan): void {
  const { plan_digest: supplied, ...body } = plan;
  if (canonicalJsonSha256(body) !== supplied) {
    throw new MemoryDataGovernanceError("plan_digest_invalid", "Erasure plan digest does not match its body");
  }
}

function assertPlanStillCurrent(
  plan: MemoryErasurePlan,
  database: DatabaseSync,
  appliedAt: string,
): void {
  const scope = { orgId: plan.org_id, projectId: plan.project_id ?? undefined };
  let targets: MemoryErasureTarget[];
  let snapshot: string;
  if (plan.purpose === "retention") {
    const dataClass = plan.data_class as MemoryRetentionDataClass;
    const policy = getCurrentMemoryRetentionPolicy({
      orgId: plan.org_id,
      projectId: plan.project_id ?? undefined,
      dataClass,
      at: appliedAt,
    }, database);
    if (!policy
        || policy.policyVersionId !== plan.policy_version_id
        || policy.revision !== plan.policy_revision
        || policy.policyDigest !== plan.policy_digest) {
      throw new MemoryDataGovernanceError("plan_stale", "The retention policy changed after this plan was built");
    }
    const expectedCutoff = new Date(
      new Date(plan.planned_at).getTime() - policy.retentionDays * 86_400_000,
    ).toISOString();
    if (expectedCutoff !== plan.cutoff_at) {
      throw new MemoryDataGovernanceError("plan_stale", "The retention cutoff no longer matches its policy");
    }
    targets = sortTargets(classTargets(database, scope, dataClass, expectedCutoff, plan.planned_at));
    snapshot = canonicalJsonSha256(targets);
  } else if (plan.data_class === "tenant") {
    targets = tenantAuditTargets(database, scope);
    snapshot = tenantScopeSnapshotDigest(database, scope);
  } else {
    targets = recordTargets(database, scope, { recordId: plan.record_id ?? undefined });
    snapshot = canonicalJsonSha256(targets);
  }
  if (canonicalJsonSha256(targets) !== canonicalJsonSha256(plan.targets)
      || snapshot !== plan.scope_snapshot_digest) {
    throw new MemoryDataGovernanceError(
      "plan_stale",
      "Governed data changed after this plan was built; create and review a new plan",
    );
  }
}

function assertNoApplicableLegalHold(plan: MemoryErasurePlan, database: DatabaseSync): void {
  const targetKeys = new Set(plan.targets.map(targetKey));
  const targetClasses = new Set(plan.targets.map((entry) => entry.resource_class));
  const blocking = activeLegalHolds(database, plan.org_id).filter((hold) => {
    if (plan.project_id) {
      if (hold.projectId && hold.projectId !== plan.project_id) return false;
    }
    // An org-wide erasure includes every project, so any project hold in the org applies.
    if (hold.dataClass === "tenant" || plan.data_class === "tenant") return true;
    if (!hold.resourceId) {
      return hold.dataClass === plan.data_class || targetClasses.has(hold.dataClass);
    }
    return targetKeys.has(`${hold.dataClass}\0${hold.resourceId}`);
  });
  if (blocking.length > 0) {
    throw new MemoryDataGovernanceError(
      "legal_hold_active",
      `Erasure is blocked by active legal hold ${blocking[0]!.holdId}`,
    );
  }
}

function triggerGuards(database: DatabaseSync): TriggerRow[] {
  const existingTables = GOVERNED_TABLES.filter((table) => tableExists(database, table));
  if (existingTables.length === 0) return [];
  const placeholders = existingTables.map(() => "?").join(",");
  return database.prepare(
    `SELECT name, sql FROM sqlite_schema
     WHERE type = 'trigger' AND tbl_name IN (${placeholders}) AND sql IS NOT NULL
     ORDER BY name`,
  ).all(...existingTables) as unknown as TriggerRow[];
}

function suspendTriggerGuards(database: DatabaseSync): TriggerRow[] {
  const guards = triggerGuards(database);
  for (const guard of guards) {
    if (!/^[A-Za-z0-9_]+$/.test(guard.name)) {
      throw new MemoryDataGovernanceError("guard_invalid", `Unsafe trigger name: ${guard.name}`);
    }
    database.exec(`DROP TRIGGER ${guard.name}`);
  }
  return guards;
}

function restoreTriggerGuards(database: DatabaseSync, guards: TriggerRow[]): void {
  for (const guard of guards) database.exec(guard.sql);
  const restored = new Map(triggerGuards(database).map((guard) => [guard.name, guard.sql]));
  for (const guard of guards) {
    if (restored.get(guard.name) !== guard.sql) {
      throw new MemoryDataGovernanceError("guard_restore_failed", `Trigger was not restored: ${guard.name}`);
    }
  }
}

function placeholders(values: readonly string[]): string {
  return values.map(() => "?").join(",");
}

function idsForClass(plan: MemoryErasurePlan, resourceClass: MemoryErasureTarget["resource_class"]): string[] {
  return plan.targets
    .filter((entry) => entry.resource_class === resourceClass)
    .map((entry) => entry.resource_id);
}

function redactPacks(database: DatabaseSync, packIds: readonly string[]): void {
  if (packIds.length === 0) return;
  const marks = placeholders(packIds);
  if (tableExists(database, "memory_v2_retrieval_pack_items")) {
    if (tableExists(database, "memory_v2_feedback_bindings")) {
      database.prepare(
        `UPDATE memory_v2_retrieval_pack_items
         SET token_count = 0, rank_score = 0, match_reasons_json = '[]'
         WHERE retrieval_pack_id IN (${marks})
           AND EXISTS (
             SELECT 1 FROM memory_v2_feedback_bindings AS feedback
             WHERE feedback.retrieval_pack_id
               = memory_v2_retrieval_pack_items.retrieval_pack_id
               AND feedback.record_id = memory_v2_retrieval_pack_items.record_id
               AND feedback.record_version = memory_v2_retrieval_pack_items.record_version
           )`,
      ).run(...packIds);
      database.prepare(
        `DELETE FROM memory_v2_retrieval_pack_items
         WHERE retrieval_pack_id IN (${marks})
           AND NOT EXISTS (
             SELECT 1 FROM memory_v2_feedback_bindings AS feedback
             WHERE feedback.retrieval_pack_id
               = memory_v2_retrieval_pack_items.retrieval_pack_id
               AND feedback.record_id = memory_v2_retrieval_pack_items.record_id
               AND feedback.record_version = memory_v2_retrieval_pack_items.record_version
           )`,
      ).run(...packIds);
    } else {
      database.prepare(
        `DELETE FROM memory_v2_retrieval_pack_items
         WHERE retrieval_pack_id IN (${marks})`,
      ).run(...packIds);
    }
    database.prepare(
      `UPDATE memory_v2_retrieval_packs
       SET response_json = '{}', token_count = 0, omitted_count = 0
       WHERE retrieval_pack_id IN (${marks})`,
    ).run(...packIds);
    // V2 replay reads its idempotency response independently from the pack body,
    // so erase that copy in the same exclusive transaction as the pack.
    database.prepare(
      `UPDATE memory_idempotency_keys SET response_json = '{}'
       WHERE operation = 'memory_search_v2'
         AND response_resource_id IN (${marks})`,
    ).run(...packIds);
  }
  database.prepare(
    `DELETE FROM memory_retrieval_pack_items WHERE retrieval_pack_id IN (${marks})`,
  ).run(...packIds);
  database.prepare(
    `UPDATE memory_retrieval_packs
     SET query = '[ERASED]', authorized_scope_json = '{}', response_json = '{}',
         prompt_policy_snapshot_json = '{}', consumer_run_id = NULL, request_base_sha = NULL,
         token_count = 0, omitted_count = 0, prompt_item_count = 0, prompt_token_count = 0
     WHERE retrieval_pack_id IN (${marks})`,
  ).run(...packIds);
  database.prepare(
    `UPDATE memory_idempotency_keys SET response_json = '{}'
     WHERE response_resource_id IN (${marks})`,
  ).run(...packIds);
}

function deleteRuntimeOriginsForReceipts(
  database: DatabaseSync,
  receiptIds: readonly string[],
): void {
  if (receiptIds.length === 0 || !tableExists(database, "memory_v2_origins")) return;
  const receiptMarks = placeholders(receiptIds);
  const rows = database.prepare(
    `SELECT origin_id, corroboration_domain_id
     FROM memory_v2_origins WHERE receipt_id IN (${receiptMarks})`,
  ).all(...receiptIds) as unknown as Array<{
    origin_id: string;
    corroboration_domain_id: string;
  }>;
  const originIds = rows.map((row) => row.origin_id);
  if (originIds.length === 0) return;
  const originMarks = placeholders(originIds);
  database.prepare(
    `DELETE FROM memory_v2_review_signals
     WHERE first_origin_id IN (${originMarks}) OR repeated_origin_id IN (${originMarks})`,
  ).run(...originIds, ...originIds);
  database.prepare(
    `DELETE FROM memory_v2_candidate_origins WHERE origin_id IN (${originMarks})`,
  ).run(...originIds);
  database.prepare(
    `DELETE FROM memory_v2_origin_roots WHERE origin_id IN (${originMarks})`,
  ).run(...originIds);
  database.prepare(
    `DELETE FROM memory_v2_origin_derivations
     WHERE origin_id IN (${originMarks}) OR parent_origin_id IN (${originMarks})`,
  ).run(...originIds, ...originIds);
  database.prepare(
    `DELETE FROM memory_v2_origins WHERE origin_id IN (${originMarks})`,
  ).run(...originIds);
  const domainIds = [...new Set(rows.map((row) => row.corroboration_domain_id))].sort();
  if (domainIds.length > 0) {
    const domainMarks = placeholders(domainIds);
    database.prepare(
      `DELETE FROM memory_v2_corroboration_domains
       WHERE corroboration_domain_id IN (${domainMarks})
         AND NOT EXISTS (
           SELECT 1 FROM memory_v2_origins AS origin
           WHERE origin.corroboration_domain_id
             = memory_v2_corroboration_domains.corroboration_domain_id
         )`,
    ).run(...domainIds);
  }
}

function deleteRuntimeCandidateLinks(
  database: DatabaseSync,
  candidateIds: readonly string[],
): void {
  if (candidateIds.length === 0 || !tableExists(database, "memory_v2_candidate_origins")) return;
  const marks = placeholders(candidateIds);
  database.prepare(
    `DELETE FROM memory_v2_review_signals WHERE candidate_id IN (${marks})`,
  ).run(...candidateIds);
  database.prepare(
    `DELETE FROM memory_v2_candidate_origins WHERE candidate_id IN (${marks})`,
  ).run(...candidateIds);
}

function redactReceipts(database: DatabaseSync, receiptIds: readonly string[]): void {
  if (receiptIds.length === 0) return;
  const marks = placeholders(receiptIds);
  deleteRuntimeOriginsForReceipts(database, receiptIds);
  if (tableExists(database, "memory_v2_receipt_facets")) {
    database.prepare(
      `UPDATE memory_v2_receipt_facets SET facet_json = '{"erased":true}'
       WHERE receipt_id IN (${marks})`,
    ).run(...receiptIds);
  }
  if (tableExists(database, "memory_v2_scope_snapshots")) {
    database.prepare(
      `UPDATE memory_v2_scope_snapshots
       SET scope_snapshot_json = '{}', response_json = '{}'
       WHERE receipt_id IN (${marks})`,
    ).run(...receiptIds);
  }
  if (tableExists(database, "memory_v2_feedback_bindings")) {
    database.prepare(
      `UPDATE memory_v2_feedback_bindings SET response_json = '{}'
       WHERE feedback_stage = 'receipt' AND receipt_id IN (${marks})`,
    ).run(...receiptIds);
  }
  database.prepare(
    `UPDATE memory_run_receipts
     SET receipt_json = '{}', response_json = '{}', base_sha = NULL
     WHERE receipt_id IN (${marks})`,
  ).run(...receiptIds);
  database.prepare(
    `UPDATE memory_idempotency_keys SET response_json = '{}'
     WHERE response_resource_id IN (${marks})`,
  ).run(...receiptIds);
}

function redactEvidence(database: DatabaseSync, manifestIds: readonly string[]): void {
  if (manifestIds.length === 0) return;
  const runtimeReceiptIds = manifestIds
    .filter((id) => id.startsWith(V2_RUNTIME_EVIDENCE_TARGET_PREFIX))
    .map((id) => id.slice(V2_RUNTIME_EVIDENCE_TARGET_PREFIX.length));
  deleteRuntimeOriginsForReceipts(database, runtimeReceiptIds);
  const legacyManifestIds = manifestIds
    .filter((id) => !id.startsWith(V2_RUNTIME_EVIDENCE_TARGET_PREFIX));
  if (legacyManifestIds.length === 0) return;
  const marks = placeholders(legacyManifestIds);
  const evidenceRows = database.prepare(
    `SELECT evidence_row_id FROM memory_evidence_refs
     WHERE evidence_manifest_row_id IN (${marks})`,
  ).all(...legacyManifestIds) as unknown as Array<{ evidence_row_id: string }>;
  const evidenceIds = evidenceRows.map((row) => row.evidence_row_id);
  if (evidenceIds.length > 0) {
    const evidenceMarks = placeholders(evidenceIds);
    database.prepare(
      `UPDATE memory_origins
       SET origin_key = 'erased:' || origin_row_id,
           source_identity = 'erased:' || origin_row_id
       WHERE evidence_row_id IN (${evidenceMarks})`,
    ).run(...evidenceIds);
    database.prepare(
      `UPDATE memory_evidence_refs
       SET uri = 'pim-erased:' || evidence_row_id,
           origin_id = 'erased:' || evidence_row_id
       WHERE evidence_row_id IN (${evidenceMarks})`,
    ).run(...evidenceIds);
  }
  database.prepare(
    `UPDATE memory_evidence_manifests SET manifest_json = '{}'
     WHERE evidence_manifest_row_id IN (${marks})`,
  ).run(...legacyManifestIds);
}

function deleteOutboxForAggregates(
  database: DatabaseSync,
  aggregateType: "candidate" | "record",
  ids: readonly string[],
): void {
  if (ids.length === 0) return;
  const marks = placeholders(ids);
  const jobs = database.prepare(
    `SELECT job_id FROM memory_outbox
     WHERE aggregate_type = ? AND aggregate_id IN (${marks})`,
  ).all(aggregateType, ...ids) as unknown as Array<{ job_id: string }>;
  deleteOutboxJobs(database, jobs.map((row) => row.job_id));
}

function deleteOutboxJobs(database: DatabaseSync, jobIds: readonly string[]): void {
  if (jobIds.length === 0) return;
  const jobMarks = placeholders(jobIds);
  database.prepare(`DELETE FROM memory_dead_letters WHERE job_id IN (${jobMarks})`).run(...jobIds);
  database.prepare(`DELETE FROM memory_outbox_attempts WHERE job_id IN (${jobMarks})`).run(...jobIds);
  database.prepare(`DELETE FROM memory_outbox WHERE job_id IN (${jobMarks})`).run(...jobIds);
}

function deleteFeedback(database: DatabaseSync, targetIds: readonly string[]): void {
  const legacyIds = targetIds.filter((id) => !id.startsWith(V2_FEEDBACK_TARGET_PREFIX));
  const v2Ids = targetIds
    .filter((id) => id.startsWith(V2_FEEDBACK_TARGET_PREFIX))
    .map((id) => id.slice(V2_FEEDBACK_TARGET_PREFIX.length));
  if (v2Ids.length > 0 && tableExists(database, "memory_v2_feedback_bindings")) {
    const v2Marks = placeholders(v2Ids);
    const signalRows = tableExists(database, "memory_v2_feedback_review_signals")
      ? database.prepare(
        `SELECT outbox_job_id FROM memory_v2_feedback_review_signals
         WHERE feedback_id IN (${v2Marks})`,
      ).all(...v2Ids) as unknown as Array<{ outbox_job_id: string }>
      : [];
    const jobIds = signalRows.map((row) => row.outbox_job_id);
    if (tableExists(database, "memory_v2_feedback_review_signals")) {
      database.prepare(
        `DELETE FROM memory_v2_feedback_review_signals
         WHERE feedback_id IN (${v2Marks})`,
      ).run(...v2Ids);
    }
    deleteOutboxJobs(database, jobIds);
    database.prepare(
      `DELETE FROM memory_idempotency_keys
       WHERE operation = 'memory_feedback_v2'
         AND response_resource_id IN (${v2Marks})`,
    ).run(...v2Ids);
    database.prepare(
      `DELETE FROM memory_v2_feedback_bindings WHERE feedback_id IN (${v2Marks})`,
    ).run(...v2Ids);
  }
  if (legacyIds.length === 0) return;
  const marks = placeholders(legacyIds);
  const legacyJobRows = database.prepare(
    `SELECT job_id FROM memory_outbox
     WHERE json_valid(payload_json)
       AND json_extract(payload_json, '$.feedback_id') IN (${marks})
       AND (
         json_extract(payload_json, '$.feedback_source') IS NULL
         OR json_extract(payload_json, '$.feedback_source') = 'memory_feedback'
       )`,
  ).all(...legacyIds) as unknown as Array<{ job_id: string }>;
  if (tableExists(database, "memory_v2_feedback_facets")) {
    database.prepare(
      `DELETE FROM memory_v2_feedback_facets WHERE feedback_id IN (${marks})`,
    ).run(...legacyIds);
  }
  database.prepare(`DELETE FROM memory_review_signals WHERE feedback_id IN (${marks})`).run(...legacyIds);
  deleteOutboxJobs(database, legacyJobRows.map((row) => row.job_id));
  database.prepare(`DELETE FROM memory_feedback WHERE feedback_id IN (${marks})`).run(...legacyIds);
}

function deleteCandidateClosure(database: DatabaseSync, candidateIds: readonly string[]): void {
  if (candidateIds.length === 0) return;
  const marks = placeholders(candidateIds);
  deleteRuntimeCandidateLinks(database, candidateIds);
  const receiptRows = database.prepare(
    `SELECT DISTINCT receipt_id FROM memory_receipt_candidates
     WHERE candidate_id IN (${marks})
       AND NOT EXISTS (
         SELECT 1
         FROM memory_receipt_candidates AS surviving_link
         JOIN memory_candidates_v1 AS surviving_candidate
           ON surviving_candidate.candidate_id = surviving_link.candidate_id
         WHERE surviving_link.receipt_id = memory_receipt_candidates.receipt_id
           AND surviving_link.candidate_id NOT IN (${marks})
           AND surviving_candidate.current_status NOT IN ('rejected','quarantined')
       )`,
  ).all(...candidateIds, ...candidateIds) as unknown as Array<{ receipt_id: string }>;
  const decisionRows = database.prepare(
    `SELECT decision_id FROM memory_candidate_decisions WHERE candidate_id IN (${marks})`,
  ).all(...candidateIds) as unknown as Array<{ decision_id: string }>;
  const decisionIds = decisionRows.map((row) => row.decision_id);
  if (decisionIds.length > 0) {
    const decisionMarks = placeholders(decisionIds);
    database.prepare(`DELETE FROM memory_origins WHERE decision_id IN (${decisionMarks})`).run(...decisionIds);
    database.prepare(`DELETE FROM memory_candidate_decisions WHERE decision_id IN (${decisionMarks})`).run(...decisionIds);
  }
  database.prepare(
    `UPDATE memory_activation_claims SET current_candidate_id = NULL
     WHERE current_candidate_id IN (${marks})`,
  ).run(...candidateIds);
  database.prepare(`DELETE FROM memory_record_supersessions WHERE candidate_id IN (${marks})`).run(...candidateIds);
  deleteOutboxForAggregates(database, "candidate", candidateIds);
  database.prepare(
    `DELETE FROM memory_transitions
     WHERE aggregate_type = 'candidate' AND aggregate_id IN (${marks})`,
  ).run(...candidateIds);
  database.prepare(`DELETE FROM memory_candidate_evidence WHERE candidate_id IN (${marks})`).run(...candidateIds);
  database.prepare(`DELETE FROM memory_receipt_candidates WHERE candidate_id IN (${marks})`).run(...candidateIds);
  if (tableExists(database, "memory_v2_candidate_facets")) {
    database.prepare(
      `DELETE FROM memory_v2_candidate_facets WHERE candidate_id IN (${marks})`,
    ).run(...candidateIds);
  }
  if (tableExists(database, "memory_v2_facet_quarantine")) {
    database.prepare(
      `DELETE FROM memory_v2_facet_quarantine
       WHERE aggregate_type = 'candidate' AND aggregate_id IN (${marks})`,
    ).run(...candidateIds);
  }
  database.prepare(`DELETE FROM memory_candidates_v1 WHERE candidate_id IN (${marks})`).run(...candidateIds);
  redactReceipts(database, receiptRows.map((row) => row.receipt_id));
}

function redactLegacyImportItems(database: DatabaseSync, importItemIds: readonly string[]): void {
  if (importItemIds.length === 0) return;
  const marks = placeholders(importItemIds);
  database.prepare(
    `UPDATE memory_legacy_import_items
     SET source_payload_json = '{}', source_provenance_json = '{}', mapped_payload_json = NULL,
         disposition = 'quarantined', reason_code = 'erased_by_policy',
         canonical_record_id = NULL, canonical_record_version = NULL,
         duplicate_of_item_id = NULL
     WHERE import_item_id IN (${marks})`,
  ).run(...importItemIds);
}

function redactLegacyItemsForRecords(database: DatabaseSync, recordIds: readonly string[]): void {
  redactLegacyImportItems(
    database,
    legacyImportRowsForRecords(database, recordIds)
      .map((row) => String(row.import_item_id)),
  );
}

function deleteReverificationForRecords(
  database: DatabaseSync,
  recordIds: readonly string[],
): void {
  if (recordIds.length === 0
      || !tableExists(database, "memory_v2_reverification_policies")) return;
  const marks = placeholders(recordIds);
  const jobs = database.prepare(
    `SELECT job_id FROM memory_v2_reverification_jobs
     WHERE record_id IN (${marks})`,
  ).all(...recordIds) as unknown as Array<{ job_id: string }>;
  const jobIds = jobs.map((row) => row.job_id);
  if (jobIds.length > 0) {
    const jobMarks = placeholders(jobIds);
    database.prepare(
      `DELETE FROM memory_v2_reverification_job_attempts
       WHERE job_id IN (${jobMarks})`,
    ).run(...jobIds);
  }
  database.prepare(
    `DELETE FROM memory_v2_reverification_decisions
     WHERE record_id IN (${marks})`,
  ).run(...recordIds);
  database.prepare(
    `DELETE FROM memory_v2_reverification_jobs
     WHERE record_id IN (${marks})`,
  ).run(...recordIds);
  database.prepare(
    `DELETE FROM memory_v2_reverification_state
     WHERE record_id IN (${marks})`,
  ).run(...recordIds);
  database.prepare(
    `DELETE FROM memory_v2_reverification_policies
     WHERE record_id IN (${marks})`,
  ).run(...recordIds);
}

function deleteScopedReverification(database: DatabaseSync, scope: GovernanceScope): void {
  if (!tableExists(database, "memory_v2_reverification_policies")) return;
  const condition = directScopeCondition(scope);
  const jobs = database.prepare(
    `SELECT job_id FROM memory_v2_reverification_jobs WHERE ${condition.sql}`,
  ).all(...condition.params) as unknown as Array<{ job_id: string }>;
  const jobIds = jobs.map((row) => row.job_id);
  if (jobIds.length > 0) {
    database.prepare(
      `DELETE FROM memory_v2_reverification_job_attempts
       WHERE job_id IN (${placeholders(jobIds)})`,
    ).run(...jobIds);
  }
  deleteScopedDirect(database, "memory_v2_reverification_decisions", scope);
  deleteScopedDirect(database, "memory_v2_reverification_jobs", scope);
  deleteScopedDirect(database, "memory_v2_reverification_state", scope);
  deleteScopedDirect(database, "memory_v2_reverification_policies", scope);
}

function deleteRecordClosure(database: DatabaseSync, recordIds: readonly string[]): void {
  if (recordIds.length === 0) return;
  const marks = placeholders(recordIds);
  const candidateRows = database.prepare(
    `SELECT candidate_id FROM memory_candidates_v1 WHERE active_record_id IN (${marks})`,
  ).all(...recordIds) as unknown as Array<{ candidate_id: string }>;
  const packRows = database.prepare(
    `SELECT DISTINCT retrieval_pack_id FROM memory_retrieval_pack_items
     WHERE record_id IN (${marks})`,
  ).all(...recordIds) as unknown as Array<{ retrieval_pack_id: string }>;
  const v2PackRows = tableExists(database, "memory_v2_retrieval_pack_items")
    ? database.prepare(
      `SELECT DISTINCT retrieval_pack_id FROM memory_v2_retrieval_pack_items
       WHERE record_id IN (${marks})`,
    ).all(...recordIds) as unknown as Array<{ retrieval_pack_id: string }>
    : [];
  const feedbackRows = database.prepare(
    `SELECT feedback_id FROM memory_feedback WHERE record_id IN (${marks})`,
  ).all(...recordIds) as unknown as Array<{ feedback_id: string }>;
  const v2FeedbackRows = tableExists(database, "memory_v2_feedback_bindings")
    ? database.prepare(
      `SELECT feedback_id FROM memory_v2_feedback_bindings
       WHERE record_id IN (${marks})`,
    ).all(...recordIds) as unknown as Array<{ feedback_id: string }>
    : [];
  deleteFeedback(database, [
    ...feedbackRows.map((row) => row.feedback_id),
    ...v2FeedbackRows.map((row) => `${V2_FEEDBACK_TARGET_PREFIX}${row.feedback_id}`),
  ]);
  redactPacks(database, [
    ...packRows.map((row) => row.retrieval_pack_id),
    ...v2PackRows.map((row) => row.retrieval_pack_id),
  ]);
  deleteCandidateClosure(database, candidateRows.map((row) => row.candidate_id));
  redactLegacyItemsForRecords(database, recordIds);
  deleteOutboxForAggregates(database, "record", recordIds);
  database.prepare(
    `UPDATE memory_activation_claims
     SET current_candidate_id = NULL, current_record_id = NULL, current_record_version = NULL
     WHERE current_record_id IN (${marks})`,
  ).run(...recordIds);
  database.prepare(
    `DELETE FROM memory_record_supersessions
     WHERE predecessor_record_id IN (${marks}) OR successor_record_id IN (${marks})`,
  ).run(...recordIds, ...recordIds);
  database.prepare(
    `DELETE FROM memory_transitions
     WHERE aggregate_type = 'record' AND aggregate_id IN (${marks})`,
  ).run(...recordIds);
  database.prepare(`DELETE FROM memory_applicability_indexes WHERE record_id IN (${marks})`).run(...recordIds);
  const versionRows = database.prepare(
    `SELECT record_id, record_version FROM memory_record_versions WHERE record_id IN (${marks})`,
  ).all(...recordIds) as unknown as Array<{ record_id: string; record_version: number }>;
  const deleteFts = database.prepare("DELETE FROM memory_record_versions_fts WHERE record_key = ?");
  for (const version of versionRows) deleteFts.run(`${version.record_id}:${version.record_version}`);
  deleteReverificationForRecords(database, recordIds);
  if (tableExists(database, "memory_v2_record_facets")) {
    database.prepare(
      `DELETE FROM memory_v2_record_facets WHERE record_id IN (${marks})`,
    ).run(...recordIds);
  }
  if (tableExists(database, "memory_v2_facet_quarantine")) {
    database.prepare(
      `DELETE FROM memory_v2_facet_quarantine
       WHERE aggregate_type = 'record' AND aggregate_id IN (${marks})`,
    ).run(...recordIds);
  }
  database.prepare(`DELETE FROM memory_record_versions WHERE record_id IN (${marks})`).run(...recordIds);
  database.prepare(`DELETE FROM memory_records WHERE record_id IN (${marks})`).run(...recordIds);
}

function directScopeCondition(scope: GovernanceScope): { sql: string; params: string[] } {
  return scope.projectId
    ? { sql: "org_id = ? AND project_id = ?", params: [scope.orgId, scope.projectId] }
    : { sql: "org_id = ?", params: [scope.orgId] };
}

function deleteScopedDirect(database: DatabaseSync, table: string, scope: GovernanceScope): void {
  if (!tableExists(database, table)) return;
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has("org_id") || (scope.projectId && !names.has("project_id"))) return;
  const condition = directScopeCondition(scope);
  database.prepare(`DELETE FROM ${table} WHERE ${condition.sql}`).run(...condition.params);
}

function redactScopedLegacyItems(database: DatabaseSync, scope: GovernanceScope): void {
  if (!tableExists(database, "memory_legacy_import_items")) return;
  const condition = directScopeCondition(scope);
  database.prepare(
    `UPDATE memory_legacy_import_items
     SET source_payload_json = '{}', source_provenance_json = '{}', mapped_payload_json = NULL,
         disposition = 'quarantined', reason_code = 'erased_by_policy',
         canonical_record_id = NULL, canonical_record_version = NULL,
         duplicate_of_item_id = NULL
     WHERE ${condition.sql}`,
  ).run(...condition.params);
}

function deleteTenantScope(database: DatabaseSync, scope: GovernanceScope): void {
  const condition = directScopeCondition(scope);
  const recordRows = database.prepare(
    `SELECT record_id FROM memory_records WHERE ${condition.sql}`,
  ).all(...condition.params) as unknown as Array<{ record_id: string }>;
  const recordIds = recordRows.map((row) => row.record_id);
  redactScopedLegacyItems(database, scope);
  deleteRecordClosure(database, recordIds);

  const candidateRows = database.prepare(
    `SELECT candidate_id FROM memory_candidates_v1 WHERE ${condition.sql}`,
  ).all(...condition.params) as unknown as Array<{ candidate_id: string }>;
  deleteCandidateClosure(database, candidateRows.map((row) => row.candidate_id));

  deleteFeedback(
    database,
    feedbackTargets(database, scope).map((entry) => entry.resource_id),
  );

  if (tableExists(database, "memory_v2_origins")) {
    const runtimeReceiptRows = database.prepare(
      `SELECT DISTINCT receipt_id FROM memory_v2_origins WHERE ${condition.sql}`,
    ).all(...condition.params) as unknown as Array<{ receipt_id: string }>;
    deleteRuntimeOriginsForReceipts(
      database,
      runtimeReceiptRows.map((row) => row.receipt_id),
    );
  }

  // Origins must go before their evidence, attestation, and decision parents.
  deleteScopedDirect(database, "memory_v2_review_signals", scope);
  deleteScopedDirect(database, "memory_v2_candidate_origins", scope);
  deleteScopedDirect(database, "memory_v2_origins", scope);
  deleteScopedDirect(database, "memory_v2_corroboration_domains", scope);
  deleteScopedDirect(database, "memory_origins", scope);
  deleteScopedDirect(database, "memory_review_signals", scope);
  deleteScopedDirect(database, "memory_v2_feedback_review_signals", scope);
  deleteScopedDirect(database, "memory_v2_feedback_bindings", scope);
  deleteScopedDirect(database, "memory_candidate_decisions", scope);
  deleteScopedDirect(database, "memory_record_supersessions", scope);
  deleteScopedDirect(database, "memory_activation_claims", scope);
  deleteScopedDirect(database, "memory_transitions", scope);

  if (tableExists(database, "memory_v2_retrieval_packs")) {
    const v2PackRows = database.prepare(
      `SELECT retrieval_pack_id FROM memory_v2_retrieval_packs WHERE ${condition.sql}`,
    ).all(...condition.params) as unknown as Array<{ retrieval_pack_id: string }>;
    const v2PackIds = v2PackRows.map((row) => row.retrieval_pack_id);
    if (v2PackIds.length > 0) {
      const marks = placeholders(v2PackIds);
      database.prepare(
        `DELETE FROM memory_v2_retrieval_pack_items WHERE retrieval_pack_id IN (${marks})`,
      ).run(...v2PackIds);
    }
    deleteScopedDirect(database, "memory_v2_retrieval_packs", scope);
  }

  const packRows = database.prepare(
    `SELECT retrieval_pack_id FROM memory_retrieval_packs WHERE ${condition.sql}`,
  ).all(...condition.params) as unknown as Array<{ retrieval_pack_id: string }>;
  const packIds = packRows.map((row) => row.retrieval_pack_id);
  if (packIds.length > 0) {
    const marks = placeholders(packIds);
    database.prepare(`DELETE FROM memory_retrieval_pack_items WHERE retrieval_pack_id IN (${marks})`).run(...packIds);
  }
  deleteScopedDirect(database, "memory_retrieval_packs", scope);

  // Any records created after the initial list would make the plan stale before
  // this point; these deletes are defensive and still remain scope-bound.
  if (recordIds.length > 0) {
    const marks = placeholders(recordIds);
    database.prepare(`DELETE FROM memory_applicability_indexes WHERE record_id IN (${marks})`).run(...recordIds);
    database.prepare(`DELETE FROM memory_record_versions WHERE record_id IN (${marks})`).run(...recordIds);
  }
  deleteScopedDirect(database, "memory_records", scope);

  const receiptRows = database.prepare(
    `SELECT receipt_id FROM memory_run_receipts WHERE ${condition.sql}`,
  ).all(...condition.params) as unknown as Array<{ receipt_id: string }>;
  const receiptIds = receiptRows.map((row) => row.receipt_id);
  if (receiptIds.length > 0) {
    const marks = placeholders(receiptIds);
    database.prepare(`DELETE FROM memory_receipt_candidates WHERE receipt_id IN (${marks})`).run(...receiptIds);
  }
  const manifestRows = database.prepare(
    `SELECT evidence_manifest_row_id FROM memory_evidence_manifests WHERE ${condition.sql}`,
  ).all(...condition.params) as unknown as Array<{ evidence_manifest_row_id: string }>;
  const manifestIds = manifestRows.map((row) => row.evidence_manifest_row_id);
  if (manifestIds.length > 0) {
    const marks = placeholders(manifestIds);
    database.prepare(
      `DELETE FROM memory_evidence_refs WHERE evidence_manifest_row_id IN (${marks})`,
    ).run(...manifestIds);
  }
  deleteScopedDirect(database, "memory_candidates_v1", scope);
  deleteScopedDirect(database, "memory_evidence_manifests", scope);
  deleteScopedDirect(database, "memory_v2_scope_snapshots", scope);
  deleteScopedDirect(database, "memory_run_receipts", scope);

  const jobRows = database.prepare(
    `SELECT job_id FROM memory_outbox WHERE ${condition.sql}`,
  ).all(...condition.params) as unknown as Array<{ job_id: string }>;
  const jobIds = jobRows.map((row) => row.job_id);
  if (jobIds.length > 0) {
    const marks = placeholders(jobIds);
    database.prepare(`DELETE FROM memory_dead_letters WHERE job_id IN (${marks})`).run(...jobIds);
    database.prepare(`DELETE FROM memory_outbox_attempts WHERE job_id IN (${marks})`).run(...jobIds);
  }
  deleteScopedDirect(database, "memory_dead_letters", scope);
  deleteScopedDirect(database, "memory_outbox", scope);

  deleteScopedDirect(database, "memory_attestations", scope);
  deleteScopedDirect(database, "memory_inbox", scope);
  deleteScopedDirect(database, "memory_provider_cursors", scope);
  // Record closure normally removes every row. Keep a scope-qualified defensive
  // sweep before facets/resources so a partially migrated tenant cannot strand
  // a reverification child or cross-delete an identically named legacy job.
  deleteScopedReverification(database, scope);
  deleteScopedDirect(database, "memory_v2_feedback_facets", scope);
  deleteScopedDirect(database, "memory_v2_facet_quarantine", scope);
  deleteScopedDirect(database, "memory_v2_receipt_facets", scope);
  deleteScopedDirect(database, "memory_v2_candidate_facets", scope);
  deleteScopedDirect(database, "memory_v2_record_facets", scope);
  deleteScopedDirect(database, "memory_v2_service_token_resource_bindings", scope);
  deleteScopedDirect(database, "memory_v2_resource_aliases", scope);
  deleteScopedDirect(database, "memory_v2_resources", scope);
  deleteScopedDirect(database, "memory_service_token_repository_bindings", scope);
  deleteScopedDirect(database, "memory_harness_principal_bindings", scope);
  deleteScopedDirect(database, "memory_repository_aliases", scope);
  deleteScopedDirect(database, "memory_repository_registry", scope);
  deleteScopedDirect(database, "memory_idempotency_keys", scope);

  if (tableExists(database, "project_memory_candidates")) {
    deleteScopedDirect(database, "project_memory_candidates", scope);
  }
  if (tableExists(database, "project_evidence_items")) {
    deleteScopedDirect(database, "project_evidence_items", scope);
  }
  if (tableExists(database, "memory_candidates")) {
    deleteScopedDirect(database, "memory_candidates", scope);
  }
  // These legacy entity tables have no project binding. Only an org-wide
  // tenant erasure may remove them without crossing a project boundary.
  if (!scope.projectId) {
    deleteScopedDirect(database, "memory_relationships", scope);
    deleteScopedDirect(database, "memory_entities", scope);
  }
}

function insertErasureAudit(database: DatabaseSync, plan: MemoryErasurePlan): void {
  database.prepare(
    `INSERT INTO memory_erasure_requests
       (request_id, purpose, scope_type, org_id, project_id, data_class, record_id,
        requested_method, effective_method, policy_version_id, cutoff_at, plan_digest,
        scope_snapshot_digest, target_count, actor_digest, reason_code, requested_at,
        backup_not_before)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    plan.request_id,
    plan.purpose,
    plan.scope_type,
    plan.org_id,
    plan.project_id,
    plan.data_class,
    plan.record_id,
    plan.requested_method,
    plan.effective_method,
    plan.policy_version_id,
    plan.cutoff_at,
    plan.plan_digest,
    plan.scope_snapshot_digest,
    plan.targets.length,
    plan.actor_digest,
    plan.reason_code,
    plan.planned_at,
    plan.backup_not_before,
  );
  const insert = database.prepare(
    `INSERT INTO memory_erasure_tombstones
       (tombstone_id, request_id, resource_class, resource_id, content_digest,
        erasure_method, actor_digest, reason_code, erased_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const entry of plan.targets) {
    insert.run(
      `memtomb_${randomUUID()}`,
      plan.request_id,
      entry.resource_class,
      entry.resource_id,
      entry.content_digest,
      entry.action,
      plan.actor_digest,
      plan.reason_code,
      plan.planned_at,
    );
  }
}

function insertErasureEvent(
  database: DatabaseSync,
  plan: MemoryErasurePlan,
  revision: number,
  state: "primary_erased" | "pending_backup_expiry" | "pending_external_erasure",
): void {
  database.prepare(
    `INSERT INTO memory_erasure_events
       (event_id, request_id, revision, state, target_count, actor_digest,
        reason_code, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `memeraseevent_${randomUUID()}`,
    plan.request_id,
    revision,
    state,
    plan.targets.length,
    plan.actor_digest,
    plan.reason_code,
    plan.planned_at,
  );
}

function applyTargets(database: DatabaseSync, plan: MemoryErasurePlan): void {
  if (plan.data_class === "tenant") {
    deleteTenantScope(database, { orgId: plan.org_id, projectId: plan.project_id ?? undefined });
    return;
  }
  switch (plan.data_class) {
    case "retrieval_pack":
      redactPacks(database, idsForClass(plan, "retrieval_pack"));
      return;
    case "receipt":
      redactReceipts(database, idsForClass(plan, "receipt"));
      redactLegacyImportItems(database, idsForClass(plan, "legacy_import"));
      return;
    case "evidence":
      redactEvidence(database, idsForClass(plan, "evidence"));
      return;
    case "candidate":
      deleteCandidateClosure(database, idsForClass(plan, "candidate"));
      redactLegacyImportItems(database, idsForClass(plan, "legacy_import"));
      return;
    case "record":
      deleteRecordClosure(database, idsForClass(plan, "record"));
      return;
    case "feedback":
      deleteFeedback(database, idsForClass(plan, "feedback"));
      return;
    case "security_log":
      return;
  }
}

export function applyMemoryErasurePlan(input: {
  plan: MemoryErasurePlan;
  expectedPlanDigest: string;
  downtimeConfirmed: boolean;
  compact?: boolean;
  now?: string;
}, database: DatabaseSync = db): MemoryErasureApplyResult {
  if (!input.downtimeConfirmed) {
    throw new MemoryDataGovernanceError(
      "downtime_confirmation_required",
      "Stop PIM and explicitly confirm downtime before applying erasure",
    );
  }
  if (input.expectedPlanDigest !== input.plan.plan_digest) {
    throw new MemoryDataGovernanceError("plan_digest_mismatch", "Expected plan digest does not match the plan");
  }
  if (input.plan.requested_method === "crypto_shred") {
    throw new MemoryDataGovernanceError("crypto_shred_unavailable", "Cryptographic deletion is unavailable");
  }
  assertPlanSelfDigest(input.plan);
  if (database.isTransaction) {
    throw new MemoryDataGovernanceError("exclusive_transaction_required", "Erasure cannot run inside another transaction");
  }

  database.exec("PRAGMA secure_delete = ON");
  const appliedAt = iso(input.now, "now");
  let committed = false;
  database.exec("BEGIN EXCLUSIVE");
  try {
    assertCanonicalAuthority(database);
    assertPlanStillCurrent(input.plan, database, appliedAt);
    assertNoApplicableLegalHold(input.plan, database);
    insertErasureAudit(database, input.plan);

    if (input.plan.data_class === "security_log") {
      insertErasureEvent(database, input.plan, 1, "pending_external_erasure");
    } else {
      const guards = suspendTriggerGuards(database);
      applyTargets(database, input.plan);
      restoreTriggerGuards(database, guards);
      const foreignKeyIssues = database.prepare("PRAGMA foreign_key_check").all();
      if (foreignKeyIssues.length > 0) {
        throw new MemoryDataGovernanceError("foreign_key_violation", "Erasure introduced foreign-key violations");
      }
      insertErasureEvent(database, input.plan, 1, "primary_erased");
      insertErasureEvent(database, input.plan, 2, "pending_backup_expiry");
    }
    database.exec("COMMIT");
    committed = true;
  } catch (error) {
    if (!committed) database.exec("ROLLBACK");
    throw error;
  }

  if (input.compact !== false) {
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    database.exec("VACUUM");
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }
  return {
    requestId: input.plan.request_id,
    planDigest: input.plan.plan_digest,
    targetCount: input.plan.targets.length,
    state: input.plan.data_class === "security_log"
      ? "pending_external_erasure"
      : "pending_backup_expiry",
    backupNotBefore: input.plan.backup_not_before,
  };
}
