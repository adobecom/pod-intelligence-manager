import { DatabaseSync } from "node:sqlite";
import {
  canonicalJsonSha256,
  parseMemoryContractV2,
} from "@pim/shared";
import { describe, expect, it } from "vitest";
import { runSchemaMigrations } from "../../db/migrations.js";
import {
  MEMORY_RETENTION_DATA_CLASSES,
  applyMemoryErasurePlan,
  createMemoryRetentionPolicyVersion,
  placeMemoryLegalHold,
  planMemoryErasure,
  planMemoryRetention,
  releaseMemoryLegalHold,
} from "../memory-data-governance.js";
import { reconcileMemoryV2CanonicalWrites } from "../memory-v2-startup-reconciliation.js";
import { reconcileMemoryV2HarnessReadFacets } from "../memory-v2-harness-facets.js";

const NOW = "2026-08-03T12:00:00.000Z";
const OLD = "2026-06-01T00:00:00.000Z";
const FRESH = "2026-07-20T00:00:00.000Z";
const SHA = `sha256:${"a".repeat(64)}`;

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE orgs (org_id TEXT PRIMARY KEY);
    CREATE TABLE projects (
      project_id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES orgs(org_id)
    );
    CREATE TABLE service_principals (
      service_principal_id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES orgs(org_id)
    );
    CREATE TABLE service_tokens (
      token_id TEXT PRIMARY KEY,
      service_principal_id TEXT NOT NULL REFERENCES service_principals(service_principal_id),
      project_id TEXT REFERENCES projects(project_id),
      scopes_json TEXT NOT NULL
    );
  `);
  runSchemaMigrations(db);
  db.exec(`
    INSERT INTO orgs VALUES ('org-a'), ('org-b');
    INSERT INTO projects VALUES
      ('project-a1', 'org-a'),
      ('project-a2', 'org-a'),
      ('project-b1', 'org-b');
  `);
  db.prepare(
    `INSERT INTO memory_legacy_import_runs
       (import_run_id, inventory_digest, resolution_digest, source_bundle_digest,
        source_item_count, imported_count, pending_count, quarantined_count,
        deduplicated_count, report_json, created_at)
     VALUES ('cutover', ?, ?, ?, 0, 0, 0, 0, 0, '{}', ?)`,
  ).run(SHA, SHA, SHA, NOW);
  db.prepare(
    `INSERT INTO memory_authority_transitions
       (transition_id, revision, from_authority, to_authority, legacy_writes_frozen,
        import_run_id, actor_id, reason_code, occurred_at)
     VALUES ('authority-1', 1, 'legacy', 'migration_locked', 1,
             'cutover', 'test', 'cutover_started', ?),
            ('authority-2', 2, 'migration_locked', 'canonical', 1,
             'cutover', 'test', 'cutover_complete', ?)`,
  ).run(NOW, NOW);
  return db;
}

function seedRepository(db: DatabaseSync, orgId: string, projectId: string): string {
  const id = `repo-${projectId}`;
  db.prepare(
    `INSERT INTO memory_repository_registry
       (repository_row_id, org_id, project_id, provider, provider_repository_id,
        repository_id, display_slug, valid_from, created_at, updated_at)
     VALUES (?, ?, ?, 'github', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    orgId,
    projectId,
    `provider-${projectId}`,
    `github.com/acme/${projectId}`,
    `Acme/${projectId}`,
    OLD,
    OLD,
    OLD,
  );
  return id;
}

function seedRecord(db: DatabaseSync, input: {
  recordId: string;
  orgId: string;
  projectId: string;
  repositoryRowId: string;
  status: "active" | "revoked" | "expired";
  updatedAt: string;
  secret?: string;
}): void {
  db.prepare(
    `INSERT INTO memory_records
       (record_id, org_id, project_id, repository_row_id, harness_id, plane, kind,
        current_version, current_status, aggregate_version, shadow_recall_eligible,
        prompt_eligible, claim_key, valid_from, valid_until, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, 'codebase', 'constraint', 1, ?, 1, 1, 0, ?, ?, NULL, NULL, ?, ?)`,
  ).run(
    input.recordId,
    input.orgId,
    input.projectId,
    input.repositoryRowId,
    input.status,
    `claim-${input.recordId}`,
    input.updatedAt,
    input.updatedAt,
    input.updatedAt,
  );
  const content = {
    summary: input.secret ?? `summary-${input.recordId}`,
    details: `details-${input.recordId}`,
    rationale: `rationale-${input.recordId}`,
  };
  db.prepare(
    `INSERT INTO memory_record_versions
       (record_id, record_version, content_json, applicability_json, exceptions_json,
        compatibility_json, validation_json, evidence_json, evidence_summary_json,
        freshness_json, provenance_json, embedding_json, content_digest, recorded_at)
     VALUES (?, 1, ?, '{}', '[]', '{}', '{}', '[]', '{}', '{}', '{}', NULL, ?, ?)`,
  ).run(input.recordId, JSON.stringify(content), canonicalJsonSha256(content), input.updatedAt);
}

function seedV2RecordCompanion(
  db: DatabaseSync,
  input: { recordId: string; repositoryRowId: string },
): void {
  const resourceRowId = `v2res_repository:${input.repositoryRowId}`;
  db.prepare(
    `INSERT OR IGNORE INTO memory_v2_resources
       (resource_row_id, org_id, project_id, plane, resource_type,
        canonical_resource_id, display_label, provider, provider_resource_id,
        classification, retention_reference, source_authority, source_row_id,
        valid_from, valid_until, created_at, updated_at)
     SELECT ?, org_id, project_id, 'codebase', 'repository', repository_id,
            display_slug, provider, provider_repository_id, 'internal', NULL,
            'memory_repository_registry', repository_row_id, valid_from, valid_until,
            created_at, updated_at
     FROM memory_repository_registry WHERE repository_row_id = ?`,
  ).run(resourceRowId, input.repositoryRowId);
  db.prepare(
    `INSERT INTO memory_v2_record_facets
       (record_id, record_version, org_id, project_id, plane, resource_row_id,
        broad_kind, subtype, projection_status, facet_json, created_at)
     SELECT record.record_id, version.record_version, record.org_id, record.project_id,
            record.plane, ?, record.kind, NULL, 'mapped', '{"projection":"v2-test"}',
            version.recorded_at
     FROM memory_records AS record
     INNER JOIN memory_record_versions AS version ON version.record_id = record.record_id
     WHERE record.record_id = ? AND version.record_version = 1`,
  ).run(resourceRowId, input.recordId);
}

function seedReverificationGraph(db: DatabaseSync, input: {
  recordId: string;
  repositoryRowId: string;
  idSuffix: string;
  jobId?: string;
}): {
  attemptId: string;
  decisionId: string;
  jobId: string;
  policyId: string;
} {
  const scope = db.prepare(
    `SELECT org_id, project_id, plane FROM memory_records WHERE record_id = ?`,
  ).get(input.recordId) as {
    org_id: string;
    project_id: string;
    plane: "codebase";
  };
  const resourceRowId = `v2res_repository:${input.repositoryRowId}`;
  const policyId = `reverify-policy-${input.idSuffix}`;
  const jobId = input.jobId ?? `reverify-job-${input.idSuffix}`;
  const decisionId = `reverify-decision-${input.idSuffix}`;
  const attemptId = `reverify-attempt-${input.idSuffix}`;
  db.prepare(
    `INSERT INTO memory_v2_reverification_policies
       (policy_id, record_id, record_version, org_id, project_id, plane,
        resource_row_id, resolver_type, policy_revision, interval_seconds,
        max_age_seconds, max_attempts, active, policy_digest, created_by, created_at)
     VALUES (?, ?, 1, ?, ?, ?, ?, 'github', 1, 60, 300, 3,
             1, ?, 'governance-test', ?)`,
  ).run(
    policyId,
    input.recordId,
    scope.org_id,
    scope.project_id,
    scope.plane,
    resourceRowId,
    SHA,
    OLD,
  );
  db.prepare(
    `INSERT INTO memory_v2_reverification_state
       (record_id, record_version, org_id, project_id, plane, resource_row_id,
        policy_id, policy_revision, state_version, status, influence_eligible,
        last_verified_at, next_reverify_at, last_attempt_at,
        consecutive_failures, last_error_code,
        latest_decision_id, updated_at)
     VALUES (?, 1, ?, ?, ?, ?, ?, 1, 1, 'due', 1, ?, ?, NULL,
             0, NULL, NULL, ?)`,
  ).run(
    input.recordId,
    scope.org_id,
    scope.project_id,
    scope.plane,
    resourceRowId,
    policyId,
    OLD,
    OLD,
    OLD,
  );
  db.prepare(
    `INSERT INTO memory_v2_reverification_jobs
       (job_id, record_id, record_version, org_id, project_id, plane,
        resource_row_id, policy_id, policy_revision, expected_state_version,
        scheduled_for, status, attempt_count, max_attempts, next_attempt_at,
        lease_owner, lease_expires_at, last_error_code, created_at, updated_at,
        completed_at, dead_lettered_at)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, 1, 1, ?, 'pending', 1, 3, ?,
             NULL, NULL, 'provider_unavailable', ?, ?, NULL, NULL)`,
  ).run(
    jobId,
    input.recordId,
    scope.org_id,
    scope.project_id,
    scope.plane,
    resourceRowId,
    policyId,
    OLD,
    OLD,
    OLD,
    OLD,
  );
  db.prepare(
    `INSERT INTO memory_v2_reverification_decisions
       (decision_id, job_id, record_id, record_version, org_id, project_id,
        plane, resource_row_id, policy_id, policy_revision,
        expected_state_version, committed_state_version, from_status, to_status,
        provider_outcome, reason_code, evidence_digest, source_occurred_at,
        canonical_from_status, canonical_to_status, attempted_at, decided_at,
        decision_digest, created_at)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, 1, 1, 2, 'due', 'pending',
             'unavailable', 'provider_unavailable', NULL, NULL,
             'active', 'active', ?, ?, ?, ?)`,
  ).run(
    decisionId,
    jobId,
    input.recordId,
    scope.org_id,
    scope.project_id,
    scope.plane,
    resourceRowId,
    policyId,
    OLD,
    OLD,
    SHA,
    OLD,
  );
  db.prepare(
    `INSERT INTO memory_v2_reverification_job_attempts
       (attempt_id, job_id, attempt_number, worker_id, outcome, error_code,
        started_at, completed_at)
     VALUES (?, ?, 1, 'governance-worker', 'retry', 'provider_unavailable', ?, ?)`,
  ).run(attemptId, jobId, OLD, OLD);
  db.prepare(
    `UPDATE memory_v2_reverification_state
     SET state_version = 2, status = 'pending', next_reverify_at = ?,
         last_attempt_at = ?,
         consecutive_failures = 1, last_error_code = 'provider_unavailable',
         latest_decision_id = ?, updated_at = ?
     WHERE record_id = ? AND record_version = 1`,
  ).run(
    OLD,
    OLD,
    decisionId,
    OLD,
    input.recordId,
  );
  return { attemptId, decisionId, jobId, policyId };
}

function storedV2ResourceBinding(db: DatabaseSync, resourceRowId: string): Record<string, unknown> {
  const resource = db.prepare(
    `SELECT resource.resource_row_id, resource.org_id, resource.project_id, resource.plane,
            resource.resource_type, resource.canonical_resource_id, resource.provider,
            resource.provider_resource_id, resource.display_label
     FROM memory_v2_resources AS resource
     WHERE resource.resource_row_id = ?`,
  ).get(resourceRowId) as Record<string, string | null>;
  return {
    resource_row_id: resource.resource_row_id,
    organization_id: resource.org_id,
    project_id: resource.project_id,
    plane: resource.plane,
    resource_type: resource.resource_type,
    canonical_resource_id: resource.canonical_resource_id,
    provider: resource.provider,
    provider_resource_id: resource.provider_resource_id,
    display_label: resource.display_label,
    permitted_operations: ["search", "detail", "history", "pack"],
  };
}

function seedV2Pack(db: DatabaseSync, input: {
  packId: string;
  recordId: string;
  repositoryRowId: string;
  createdAt?: string;
  expiresAt?: string;
  secret?: string;
  scopeDigest?: string;
}): void {
  const resourceRowId = `v2res_repository:${input.repositoryRowId}`;
  const resourceBinding = storedV2ResourceBinding(db, resourceRowId);
  const resource = db.prepare(
    "SELECT org_id, project_id, resource_row_id FROM memory_v2_resources WHERE resource_row_id = ?",
  ).get(resourceRowId) as { org_id: string; project_id: string; resource_row_id: string };
  const createdAt = input.createdAt ?? OLD;
  const expiresAt = input.expiresAt ?? "2026-06-02T00:00:00.000Z";
  const requestId = `request-${input.packId}`;
  const requestDigest = canonicalJsonSha256({ request_id: requestId });
  const responseJson = JSON.stringify({ secret: input.secret ?? `secret-${input.packId}` });
  db.prepare(
    `INSERT INTO memory_v2_retrieval_packs
       (retrieval_pack_id, schema_version, org_id, project_id, request_id, request_digest,
        principal_id, plane, resource_row_id, resource_binding_json, scope_snapshot_digest,
        policy_version, ranker_version, budget_json, authorized_scopes_json,
        response_json, token_count, omitted_count, created_at, expires_at)
     VALUES (?, 'pim.memory-retrieval-pack.v2', ?, ?, ?, ?, 'principal-test', 'codebase',
             ?, ?, ?, 'policy-v1', 'ranker-v1', '{"max_tokens":800,"max_items":8}',
             '["memory:search"]', ?, 10, 0, ?, ?)`,
  ).run(
    input.packId,
    resource.org_id,
    resource.project_id,
    requestId,
    requestDigest,
    resource.resource_row_id,
    JSON.stringify(resourceBinding),
    input.scopeDigest ?? canonicalJsonSha256({ resource_row_id: resource.resource_row_id, base_sha: SHA }),
    responseJson,
    createdAt,
    expiresAt,
  );
  db.prepare(
    `INSERT INTO memory_v2_retrieval_pack_items
       (retrieval_pack_id, item_order, record_id, record_version, token_count,
        rank_score, match_reasons_json)
     VALUES (?, 0, ?, 1, 10, 1.0, '["selector:repository"]')`,
  ).run(input.packId, input.recordId);
  db.prepare(
    `INSERT INTO memory_idempotency_keys
       (org_id, project_id, operation, idempotency_key, request_digest,
        response_resource_type, response_resource_id, response_json, created_at, expires_at)
     VALUES (?, ?, 'memory_search_v2', ?, ?, 'memory_v2_retrieval_pack', ?, ?, ?, ?)`,
  ).run(
    resource.org_id,
    resource.project_id,
    requestId,
    requestDigest,
    input.packId,
    responseJson,
    createdAt,
    expiresAt,
  );
}

function seedHarnessV2Pack(db: DatabaseSync, input: {
  packId: string;
}): { requestId: string; responseJson: string } {
  const principalId = `principal-${input.packId}`;
  const harnessId = "example-harness-a";
  const resourceRowId = `v2res-harness-${input.packId}`;
  const requestId = `request-${input.packId}`;
  const createdAt = OLD;
  const expiresAt = "2026-06-01T00:15:00.000Z";

  db.prepare(
    "INSERT INTO service_principals (service_principal_id, org_id) VALUES (?, 'org-a')",
  ).run(principalId);
  db.prepare(
    `INSERT INTO memory_harness_principal_bindings
       (binding_id, service_principal_id, org_id, project_id, harness_id, created_at)
     VALUES (?, ?, 'org-a', 'project-a1', ?, ?)`,
  ).run(`binding-${input.packId}`, principalId, harnessId, createdAt);
  db.prepare(
    `INSERT INTO memory_v2_resources
       (resource_row_id, org_id, project_id, plane, resource_type,
        canonical_resource_id, display_label, provider, provider_resource_id,
        classification, retention_reference, source_authority, source_row_id,
        valid_from, valid_until, created_at, updated_at)
     VALUES (?, 'org-a', 'project-a1', 'harness', 'harness', ?, ?, NULL, NULL,
             'internal', NULL, 'memory_harness_principal_bindings', ?, ?, NULL, ?, ?)`,
  ).run(
    resourceRowId,
    harnessId,
    harnessId,
    "identity:6F72672D61:70726F6A6563742D6131:666965737461",
    createdAt,
    createdAt,
    createdAt,
  );
  const resourceBinding = storedV2ResourceBinding(db, resourceRowId);
  const scopeSnapshotDigest = canonicalJsonSha256({
    plane: "harness",
    resource_binding: resourceBinding,
    harness_id: harnessId,
  });
  const resultInput = {
    schema_version: "pim.memory-search-result.v2",
    request_id: requestId,
    retrieval_pack_id: input.packId,
    tenant: { organization_id: "org-a", project_id: "project-a1" },
    plane: "harness",
    resource_binding: resourceBinding,
    scope_snapshot_digest: scopeSnapshotDigest,
    policy_version: "retrieval-harness-shadow-v1",
    ranker_version: "lexical-harness-shadow-v1",
    token_count: 0,
    items: [],
    omitted_count: 0,
    expires_at: expiresAt,
  };
  const result = parseMemoryContractV2("MemorySearchResultV2", resultInput);
  const responseJson = JSON.stringify(result);
  const requestDigest = canonicalJsonSha256({
    request_id: requestId,
    plane: "harness",
    resource_row_id: resourceRowId,
  });
  db.prepare(
    `INSERT INTO memory_v2_retrieval_packs
       (retrieval_pack_id, schema_version, org_id, project_id, request_id, request_digest,
        principal_id, plane, resource_row_id, resource_binding_json, scope_snapshot_digest,
        policy_version, ranker_version, budget_json, authorized_scopes_json,
        response_json, token_count, omitted_count, created_at, expires_at)
     VALUES (?, 'pim.memory-retrieval-pack.v2', 'org-a', 'project-a1', ?, ?, ?, 'harness',
             ?, ?, ?, 'retrieval-harness-shadow-v1', 'lexical-harness-shadow-v1',
             '{"max_tokens":800,"max_items":8}', '["memory:harness:search"]',
             ?, 0, 0, ?, ?)`,
  ).run(
    input.packId,
    requestId,
    requestDigest,
    principalId,
    resourceRowId,
    JSON.stringify(resourceBinding),
    scopeSnapshotDigest,
    responseJson,
    createdAt,
    expiresAt,
  );
  db.prepare(
    `INSERT INTO memory_idempotency_keys
       (org_id, project_id, operation, idempotency_key, request_digest,
        response_resource_type, response_resource_id, response_json, created_at, expires_at)
     VALUES ('org-a', 'project-a1', 'memory_search_v2', ?, ?,
             'memory_v2_retrieval_pack', ?, ?, ?, '2026-07-01T00:00:00.000Z')`,
  ).run(requestId, requestDigest, input.packId, responseJson, createdAt);
  return { requestId, responseJson };
}

function seedFeedbackReviewOutbox(db: DatabaseSync, input: {
  jobId: string;
  recordId: string;
  payload: Record<string, unknown>;
  jobType?: "review_notification" | "record_revalidation";
}): void {
  db.prepare(
    `INSERT INTO memory_outbox (
       job_id, org_id, project_id, job_type, aggregate_type, aggregate_id,
       expected_version, payload_json, status, attempt_count, max_attempts,
       next_attempt_at, lease_owner, lease_expires_at, last_error_code,
       last_error_message, created_at, updated_at, completed_at
     ) VALUES (?, 'org-a', 'project-a1', ?, 'record', ?, 1, ?, 'pending', 0, 5,
       ?, NULL, NULL, NULL, NULL, ?, ?, NULL)`,
  ).run(
    input.jobId,
    input.jobType ?? "review_notification",
    input.recordId,
    JSON.stringify(input.payload),
    OLD,
    OLD,
    OLD,
  );
}

function seedReceiptCandidate(db: DatabaseSync, input: {
  receiptId: string;
  candidateId: string;
  repositoryRowId?: string;
  plane: "codebase" | "harness";
  status: "received" | "validating" | "pending_merge" | "pending_review" | "rejected" | "quarantined" | "validation_failed" | "active" | "activation_failed";
}): Record<string, unknown> {
  const receipt = {
    producer: { harness_id: input.plane === "harness" ? "side" : "example-harness-a" },
    repository: {
      provider_pull_request_id: `pr-${input.receiptId}`,
      pr_head_sha: `head-${input.receiptId}`,
      candidate_tree_sha: `head-${input.receiptId}`,
    },
    outcome: { status: "completed", failure_fingerprint: `failure-${input.receiptId}` },
  };
  db.prepare(
    `INSERT INTO memory_run_receipts
       (receipt_id, org_id, project_id, producer_run_id, schema_major, request_digest,
        receipt_json, response_json, producer_harness_id, repository_row_id,
        repository_id, base_sha, outcome_status, created_at)
     VALUES (?, 'org-a', 'project-a1', ?, '1', ?, ?, '{}', ?, ?, ?, ?, 'completed', ?)`,
  ).run(
    input.receiptId,
    `run-${input.receiptId}`,
    SHA,
    JSON.stringify(receipt),
    input.plane === "harness" ? "side" : "example-harness-a",
    input.repositoryRowId ?? null,
    input.repositoryRowId ? "github.com/acme/project-a1" : null,
    input.repositoryRowId ? SHA : null,
    OLD,
  );
  db.prepare(
    `INSERT INTO memory_candidates_v1
       (candidate_id, org_id, project_id, receipt_id, repository_row_id,
        producer_harness_id, client_candidate_id, candidate_digest, candidate_json,
        plane, kind, current_status, aggregate_version, activation_requirement,
        blockers_json, evidence_manifest_row_id, active_record_id, active_record_version,
        created_at, updated_at)
     VALUES (?, 'org-a', 'project-a1', ?, ?, ?, ?, ?, '{}', ?, 'constraint', ?, 1, ?,
             '[]', NULL, NULL, NULL, ?, ?)`,
  ).run(
    input.candidateId,
    input.receiptId,
    input.repositoryRowId ?? null,
    input.plane === "harness" ? "side" : "example-harness-a",
    `client-${input.candidateId}`,
    SHA,
    input.plane,
    input.status,
    input.status === "pending_review" || input.plane === "harness"
      ? "authorized_review"
      : "verified_merge",
    OLD,
    OLD,
  );
  db.prepare(
    `INSERT INTO memory_receipt_candidates
       (receipt_id, candidate_id, client_candidate_id, candidate_digest)
     VALUES (?, ?, ?, ?)`,
  ).run(input.receiptId, input.candidateId, `client-${input.candidateId}`, SHA);
  return receipt;
}

function count(db: DatabaseSync, sql: string, ...params: string[]): number {
  return Number((db.prepare(sql).get(...params) as { count: number }).count);
}

describe("offline memory data governance", () => {
  it("uses effective per-class policies and erases only retention-eligible records", () => {
    const db = database();
    const repoA = seedRepository(db, "org-a", "project-a1");
    const repoB = seedRepository(db, "org-b", "project-b1");
    seedRecord(db, {
      recordId: "old-revoked",
      orgId: "org-a",
      projectId: "project-a1",
      repositoryRowId: repoA,
      status: "revoked",
      updatedAt: OLD,
      secret: "secret-old-record-content",
    });
    seedV2RecordCompanion(db, {
      recordId: "old-revoked",
      repositoryRowId: repoA,
    });
    seedRecord(db, {
      recordId: "fresh-revoked",
      orgId: "org-a",
      projectId: "project-a1",
      repositoryRowId: repoA,
      status: "revoked",
      updatedAt: FRESH,
    });
    seedRecord(db, {
      recordId: "old-active",
      orgId: "org-a",
      projectId: "project-a1",
      repositoryRowId: repoA,
      status: "active",
      updatedAt: OLD,
    });
    seedRecord(db, {
      recordId: "other-tenant",
      orgId: "org-b",
      projectId: "project-b1",
      repositoryRowId: repoB,
      status: "revoked",
      updatedAt: OLD,
    });

    const policies = new Map<string, string>();
    for (const dataClass of MEMORY_RETENTION_DATA_CLASSES) {
      const policy = createMemoryRetentionPolicyVersion({
        orgId: "org-a",
        projectId: "project-a1",
        dataClass,
        retentionDays: 30,
        actorId: "privacy-admin",
        reasonCode: `retain_${dataClass}`,
        now: NOW,
      }, db);
      policies.set(dataClass, policy.policyVersionId);
      const classPlan = planMemoryRetention({
        orgId: "org-a",
        projectId: "project-a1",
        dataClass,
        actorId: "privacy-admin",
        reasonCode: `apply_${dataClass}`,
        now: NOW,
        requestId: `plan-${dataClass}`,
      }, db);
      expect(classPlan.policy_version_id).toBe(policy.policyVersionId);
      expect(classPlan.policy_revision).toBe(1);
    }

    const plan = planMemoryRetention({
      orgId: "org-a",
      projectId: "project-a1",
      dataClass: "record",
      actorId: "privacy-admin",
      reasonCode: "apply_record_retention",
      now: NOW,
      requestId: "record-retention",
    }, db);
    expect(plan.policy_version_id).toBe(policies.get("record"));
    expect(plan.cutoff_at).toBe("2026-07-04T12:00:00.000Z");
    expect(plan.targets.filter((entry) => entry.resource_class === "record")
      .map((entry) => entry.resource_id)).toEqual(["old-revoked"]);

    const result = applyMemoryErasurePlan({
      plan,
      expectedPlanDigest: plan.plan_digest,
      downtimeConfirmed: true,
      compact: false,
    }, db);
    expect(result.state).toBe("pending_backup_expiry");
    expect(db.prepare("SELECT record_id FROM memory_records ORDER BY record_id").all())
      .toEqual([
        { record_id: "fresh-revoked" },
        { record_id: "old-active" },
        { record_id: "other-tenant" },
      ]);
    expect(count(
      db,
      "SELECT COUNT(*) AS count FROM memory_v2_record_facets WHERE record_id = ?",
      "old-revoked",
    )).toBe(0);
    expect(count(
      db,
      "SELECT COUNT(*) AS count FROM memory_v2_resources WHERE resource_row_id = ?",
      `v2res_repository:${repoA}`,
    )).toBe(1);
    const tombstone = db.prepare(
      `SELECT resource_id, content_digest, actor_digest, reason_code
       FROM memory_erasure_tombstones WHERE resource_class = 'record'`,
    ).get() as Record<string, string>;
    expect(tombstone.resource_id).toBe("old-revoked");
    expect(JSON.stringify(tombstone)).not.toContain("secret-old-record-content");
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(() => db.prepare(
      "UPDATE memory_record_versions SET content_json = '{}' WHERE record_id = 'old-active'",
    ).run()).toThrow(/immutable/);
    db.close();
  });

  it("preserves old receipts needed for delayed merge, revert, and review correlation", () => {
    const db = database();
    const repositoryRowId = seedRepository(db, "org-a", "project-a1");
    const protectedCases = [
      { suffix: "pending-merge", plane: "codebase", status: "pending_merge" },
      { suffix: "pending-review", plane: "codebase", status: "pending_review" },
      { suffix: "active", plane: "codebase", status: "active" },
      { suffix: "harness-review", plane: "harness", status: "pending_review" },
      { suffix: "retry-validation", plane: "codebase", status: "validation_failed" },
    ] as const;
    const originalReceipts = new Map<string, Record<string, unknown>>();
    for (const item of protectedCases) {
      const receiptId = `receipt-${item.suffix}`;
      originalReceipts.set(receiptId, seedReceiptCandidate(db, {
        receiptId,
        candidateId: `candidate-${item.suffix}`,
        repositoryRowId: item.plane === "codebase" ? repositoryRowId : undefined,
        plane: item.plane,
        status: item.status,
      }));
    }
    for (const status of ["rejected", "quarantined"] as const) {
      seedReceiptCandidate(db, {
        receiptId: `receipt-${status}`,
        candidateId: `candidate-${status}`,
        repositoryRowId,
        plane: "codebase",
        status,
      });
    }
    createMemoryRetentionPolicyVersion({
      orgId: "org-a",
      projectId: "project-a1",
      dataClass: "receipt",
      retentionDays: 30,
      actorId: "privacy-admin",
      reasonCode: "receipt_retention",
      now: NOW,
    }, db);
    const plan = planMemoryRetention({
      orgId: "org-a",
      projectId: "project-a1",
      dataClass: "receipt",
      actorId: "privacy-admin",
      reasonCode: "apply_receipt_retention",
      now: NOW,
    }, db);
    expect(plan.targets.map((entry) => entry.resource_id)).toEqual([
      "receipt-quarantined",
      "receipt-rejected",
    ]);
    applyMemoryErasurePlan({
      plan,
      expectedPlanDigest: plan.plan_digest,
      downtimeConfirmed: true,
      compact: false,
      now: NOW,
    }, db);

    for (const [receiptId, original] of originalReceipts) {
      const stored = db.prepare(
        "SELECT receipt_json, base_sha FROM memory_run_receipts WHERE receipt_id = ?",
      ).get(receiptId) as { receipt_json: string; base_sha: string | null };
      expect(JSON.parse(stored.receipt_json)).toEqual(original);
      if (receiptId !== "receipt-harness-review") expect(stored.base_sha).toBe(SHA);
    }
    expect(db.prepare(
      `SELECT candidate.current_status, receipt.receipt_id
       FROM memory_candidates_v1 AS candidate
       JOIN memory_run_receipts AS receipt ON receipt.receipt_id = candidate.receipt_id
       WHERE candidate.current_status IN ('pending_merge','active')
         AND json_extract(receipt.receipt_json, '$.repository.provider_pull_request_id') IS NOT NULL
       ORDER BY candidate.current_status`,
    ).all()).toEqual([
      { current_status: "active", receipt_id: "receipt-active" },
      { current_status: "pending_merge", receipt_id: "receipt-pending-merge" },
    ]);
    expect(db.prepare(
      `SELECT receipt.receipt_id
       FROM memory_candidates_v1 AS candidate
       JOIN memory_run_receipts AS receipt ON receipt.receipt_id = candidate.receipt_id
       WHERE candidate.current_status = 'pending_review'
         AND json_extract(receipt.receipt_json, '$.producer.harness_id') IS NOT NULL
       ORDER BY receipt.receipt_id`,
    ).all()).toEqual([
      { receipt_id: "receipt-harness-review" },
      { receipt_id: "receipt-pending-review" },
    ]);
    expect(db.prepare(
      `SELECT receipt_id, receipt_json, base_sha FROM memory_run_receipts
       WHERE receipt_id IN ('receipt-rejected','receipt-quarantined') ORDER BY receipt_id`,
    ).all()).toEqual([
      { receipt_id: "receipt-quarantined", receipt_json: "{}", base_sha: null },
      { receipt_id: "receipt-rejected", receipt_json: "{}", base_sha: null },
    ]);
    db.close();
  });

  it("keeps shared receipt correlation when candidate retention closes only one candidate", () => {
    const db = database();
    const repositoryRowId = seedRepository(db, "org-a", "project-a1");
    const protectedReceipts = new Map<string, Record<string, unknown>>();

    const addSurvivingCandidate = (input: {
      receiptId: string;
      candidateId: string;
      plane: "codebase" | "harness";
      status: "pending_merge" | "pending_review" | "active" | "quarantined";
      updatedAt?: string;
    }): void => {
      db.prepare(
        `INSERT INTO memory_candidates_v1
           (candidate_id, org_id, project_id, receipt_id, repository_row_id,
            producer_harness_id, client_candidate_id, candidate_digest, candidate_json,
            plane, kind, current_status, aggregate_version, activation_requirement,
            blockers_json, evidence_manifest_row_id, active_record_id, active_record_version,
            created_at, updated_at)
         VALUES (?, 'org-a', 'project-a1', ?, ?, ?, ?, ?, '{}', ?, 'constraint', ?, 1, ?,
                 '[]', NULL, NULL, NULL, ?, ?)`,
      ).run(
        input.candidateId,
        input.receiptId,
        input.plane === "codebase" ? repositoryRowId : null,
        input.plane === "harness" ? "side" : "example-harness-a",
        `client-${input.candidateId}`,
        SHA,
        input.plane,
        input.status,
        input.plane === "harness" ? "authorized_review" : "verified_merge",
        input.updatedAt ?? OLD,
        input.updatedAt ?? OLD,
      );
      db.prepare(
        `INSERT INTO memory_receipt_candidates
           (receipt_id, candidate_id, client_candidate_id, candidate_digest)
         VALUES (?, ?, ?, ?)`,
      ).run(input.receiptId, input.candidateId, `client-${input.candidateId}`, SHA);
    };

    for (const item of [
      { suffix: "pending-merge", plane: "codebase", status: "pending_merge" },
      { suffix: "active", plane: "codebase", status: "active" },
      { suffix: "harness-review", plane: "harness", status: "pending_review" },
    ] as const) {
      const receiptId = `receipt-shared-${item.suffix}`;
      protectedReceipts.set(receiptId, seedReceiptCandidate(db, {
        receiptId,
        candidateId: `candidate-closed-${item.suffix}`,
        repositoryRowId: item.plane === "codebase" ? repositoryRowId : undefined,
        plane: item.plane,
        status: "rejected",
      }));
      addSurvivingCandidate({
        receiptId,
        candidateId: `candidate-surviving-${item.suffix}`,
        plane: item.plane,
        status: item.status,
      });
    }

    seedReceiptCandidate(db, {
      receiptId: "receipt-shared-closed-only",
      candidateId: "candidate-closed-control",
      repositoryRowId,
      plane: "codebase",
      status: "rejected",
    });
    addSurvivingCandidate({
      receiptId: "receipt-shared-closed-only",
      candidateId: "candidate-fresh-quarantined-control",
      plane: "codebase",
      status: "quarantined",
      updatedAt: FRESH,
    });

    createMemoryRetentionPolicyVersion({
      orgId: "org-a",
      projectId: "project-a1",
      dataClass: "candidate",
      retentionDays: 30,
      actorId: "privacy-admin",
      reasonCode: "candidate_retention",
      now: NOW,
    }, db);
    const plan = planMemoryRetention({
      orgId: "org-a",
      projectId: "project-a1",
      dataClass: "candidate",
      actorId: "privacy-admin",
      reasonCode: "apply_candidate_retention",
      now: NOW,
    }, db);

    expect(plan.targets.filter((entry) => entry.resource_class === "receipt")
      .map((entry) => entry.resource_id)).toEqual(["receipt-shared-closed-only"]);
    applyMemoryErasurePlan({
      plan,
      expectedPlanDigest: plan.plan_digest,
      downtimeConfirmed: true,
      compact: false,
      now: NOW,
    }, db);

    for (const [receiptId, originalReceipt] of protectedReceipts) {
      const row = db.prepare(
        `SELECT receipt_json, base_sha
         FROM memory_run_receipts WHERE receipt_id = ?`,
      ).get(receiptId) as { receipt_json: string; base_sha: string | null };
      expect(JSON.parse(row.receipt_json)).toEqual(originalReceipt);
      if (receiptId !== "receipt-shared-harness-review") expect(row.base_sha).toBe(SHA);
      expect(count(
        db,
        `SELECT COUNT(*) AS count FROM memory_erasure_tombstones
         WHERE resource_class = 'receipt' AND resource_id = ?`,
        receiptId,
      )).toBe(0);
    }
    expect(db.prepare(
      `SELECT candidate.current_status,
              json_extract(receipt.receipt_json, '$.repository.provider_pull_request_id') AS pull_request_id
       FROM memory_candidates_v1 AS candidate
       JOIN memory_run_receipts AS receipt ON receipt.receipt_id = candidate.receipt_id
       WHERE candidate.current_status IN ('pending_merge','active')
       ORDER BY candidate.current_status`,
    ).all()).toEqual([
      { current_status: "active", pull_request_id: "pr-receipt-shared-active" },
      { current_status: "pending_merge", pull_request_id: "pr-receipt-shared-pending-merge" },
    ]);
    expect(db.prepare(
      `SELECT candidate.current_status,
              json_extract(receipt.receipt_json, '$.producer.harness_id') AS harness_id
       FROM memory_candidates_v1 AS candidate
       JOIN memory_run_receipts AS receipt ON receipt.receipt_id = candidate.receipt_id
       WHERE candidate.candidate_id = 'candidate-surviving-harness-review'`,
    ).get()).toEqual({ current_status: "pending_review", harness_id: "side" });
    expect(db.prepare(
      `SELECT receipt_json, base_sha FROM memory_run_receipts
       WHERE receipt_id = 'receipt-shared-closed-only'`,
    ).get()).toEqual({ receipt_json: "{}", base_sha: null });
    expect(count(
      db,
      `SELECT COUNT(*) AS count FROM memory_erasure_tombstones
       WHERE resource_class = 'receipt' AND resource_id = 'receipt-shared-closed-only'`,
    )).toBe(1);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });

  it("applies policy cutoffs for packs, receipts, evidence, candidates, feedback, and external logs", () => {
    const db = database();
    const repo = seedRepository(db, "org-a", "project-a1");
    seedRecord(db, {
      recordId: "active-for-feedback",
      orgId: "org-a",
      projectId: "project-a1",
      repositoryRowId: repo,
      status: "active",
      updatedAt: OLD,
    });
    seedV2RecordCompanion(db, {
      recordId: "active-for-feedback",
      repositoryRowId: repo,
    });
    seedV2Pack(db, {
      packId: "pack-old",
      recordId: "active-for-feedback",
      repositoryRowId: repo,
      secret: "secret-v2-pack-response",
    });
    db.prepare(
      `INSERT INTO memory_retrieval_packs
         (retrieval_pack_id, org_id, project_id, request_id, request_digest,
          repository_row_id, repository_id, harness_id, plane, query, policy_version,
          ranker_version, authorized_scope_json, token_count, omitted_count, response_json,
          created_at, expires_at, prompt_eligible, evaluation_arm, prompt_policy_revision,
          prompt_policy_snapshot_json, prompt_item_count, prompt_token_count)
       VALUES ('pack-old', 'org-a', 'project-a1', 'request-old', ?, ?,
               'github.com/acme/project-a1', NULL, 'codebase', 'secret pack query',
               'policy-v1', 'ranker-v1', '{"secret":"scope"}', 10, 0,
               '{"secret":"response"}', ?, ?, 0, 'shadow', 0, '{"secret":"policy"}', 0, 0)`,
    ).run(SHA, repo, OLD, OLD);
    db.prepare(
      `INSERT INTO memory_retrieval_pack_items
         (retrieval_pack_id, item_order, record_id, record_version, token_count,
          rank_score, match_reasons_json, prompt_eligible)
       VALUES ('pack-old', 0, 'active-for-feedback', 1, 10, 1.0, '["secret match"]', 0)`,
    ).run();
    db.prepare(
      `INSERT INTO memory_run_receipts
         (receipt_id, org_id, project_id, producer_run_id, schema_major, request_digest,
          receipt_json, response_json, producer_harness_id, repository_row_id,
          repository_id, outcome_status, created_at)
       VALUES ('receipt-old', 'org-a', 'project-a1', 'run-old', '1', ?,
               '{"secret":"receipt"}', '{"secret":"receipt response"}', 'example-harness-a', ?,
               'github.com/acme/project-a1', 'completed', ?)`,
    ).run(SHA, repo, OLD);
    db.prepare(
      `INSERT INTO memory_evidence_manifests
         (evidence_manifest_row_id, org_id, project_id, receipt_id,
          producer_manifest_id, manifest_digest, manifest_json, created_at)
       VALUES ('manifest-old', 'org-a', 'project-a1', 'receipt-old',
               'producer-manifest-old', ?, '{"secret":"manifest"}', ?)`,
    ).run(SHA, OLD);
    db.prepare(
      `INSERT INTO memory_evidence_refs
         (evidence_row_id, evidence_manifest_row_id, producer_ref_id, type, uri, digest,
          origin_id, source_authority, occurred_at, created_at)
       VALUES ('evidence-old', 'manifest-old', 'ref-old', 'git_diff',
               'https://example.invalid/secret.diff', ?, 'secret-origin', 'observed', ?, ?)`,
    ).run(SHA, OLD, OLD);
    db.prepare(
      `INSERT INTO memory_candidates_v1
         (candidate_id, org_id, project_id, receipt_id, repository_row_id,
          producer_harness_id, client_candidate_id, candidate_digest, candidate_json,
          plane, kind, current_status, aggregate_version, activation_requirement,
          blockers_json, evidence_manifest_row_id, created_at, updated_at)
       VALUES ('candidate-old', 'org-a', 'project-a1', 'receipt-old', ?, 'example-harness-a',
               'client-old', ?, '{"secret":"candidate"}', 'codebase', 'constraint',
               'rejected', 1, 'verified_merge', '[]', 'manifest-old', ?, ?)`,
    ).run(repo, SHA, OLD, OLD);
    db.prepare(
      `INSERT INTO memory_receipt_candidates
         (receipt_id, candidate_id, client_candidate_id, candidate_digest)
       VALUES ('receipt-old', 'candidate-old', 'client-old', ?)`,
    ).run(SHA);
    db.prepare(
      `INSERT INTO memory_feedback
         (feedback_id, org_id, project_id, receipt_id, producer_run_id,
          retrieval_pack_id, record_id, record_version, feedback_stage,
          feedback_revision, feedback_json, feedback_digest, created_at)
       VALUES ('feedback-old', 'org-a', 'project-a1', 'receipt-old', 'run-old',
               'pack-old', 'active-for-feedback', 1, 'later', 1,
               '{"secret":"feedback"}', ?, ?)`,
    ).run(SHA, OLD);
    const v2ClaimBefore = db.prepare(
      `SELECT request_digest, response_resource_type, response_resource_id, response_json
       FROM memory_idempotency_keys
       WHERE operation = 'memory_search_v2' AND idempotency_key = 'request-pack-old'`,
    ).get() as Record<string, string>;
    expect(v2ClaimBefore).toMatchObject({
      response_resource_type: "memory_v2_retrieval_pack",
      response_resource_id: "pack-old",
      response_json: '{"secret":"secret-v2-pack-response"}',
    });

    for (const dataClass of MEMORY_RETENTION_DATA_CLASSES) {
      createMemoryRetentionPolicyVersion({
        orgId: "org-a",
        projectId: "project-a1",
        dataClass,
        retentionDays: 30,
        actorId: "privacy-admin",
        reasonCode: `retain_${dataClass}`,
        now: NOW,
      }, db);
    }

    for (const dataClass of ["retrieval_pack", "receipt", "evidence", "candidate", "feedback"] as const) {
      const plan = planMemoryRetention({
        orgId: "org-a",
        projectId: "project-a1",
        dataClass,
        actorId: "privacy-admin",
        reasonCode: `apply_${dataClass}`,
        now: NOW,
      }, db);
      expect(plan.targets.some((entry) => entry.resource_class === dataClass)).toBe(true);
      applyMemoryErasurePlan({
        plan,
        expectedPlanDigest: plan.plan_digest,
        downtimeConfirmed: true,
        compact: false,
      }, db);
    }
    expect(db.prepare(
      "SELECT query, response_json, authorized_scope_json FROM memory_retrieval_packs WHERE retrieval_pack_id = 'pack-old'",
    ).get()).toEqual({ query: "[ERASED]", response_json: "{}", authorized_scope_json: "{}" });
    expect(db.prepare(
      `SELECT response_json, token_count, omitted_count
       FROM memory_v2_retrieval_packs WHERE retrieval_pack_id = 'pack-old'`,
    ).get()).toEqual({
      response_json: "{}",
      token_count: 0,
      omitted_count: 0,
    });
    expect(count(
      db,
      "SELECT COUNT(*) AS count FROM memory_v2_retrieval_pack_items WHERE retrieval_pack_id = ?",
      "pack-old",
    )).toBe(0);
    expect(db.prepare(
      `SELECT request_digest, response_resource_type, response_resource_id, response_json
       FROM memory_idempotency_keys
       WHERE operation = 'memory_search_v2' AND idempotency_key = 'request-pack-old'`,
    ).get()).toEqual({
      request_digest: v2ClaimBefore.request_digest,
      response_resource_type: "memory_v2_retrieval_pack",
      response_resource_id: "pack-old",
      response_json: "{}",
    });
    expect(() => db.prepare(
      "UPDATE memory_v2_retrieval_packs SET token_count = 1 WHERE retrieval_pack_id = 'pack-old'",
    ).run()).toThrow(/immutable/);
    expect(db.prepare(
      "SELECT receipt_json, response_json FROM memory_run_receipts WHERE receipt_id = 'receipt-old'",
    ).get()).toEqual({ receipt_json: "{}", response_json: "{}" });
    expect(db.prepare(
      "SELECT manifest_json FROM memory_evidence_manifests WHERE evidence_manifest_row_id = 'manifest-old'",
    ).get()).toEqual({ manifest_json: "{}" });
    expect(count(db, "SELECT COUNT(*) AS count FROM memory_candidates_v1 WHERE candidate_id = 'candidate-old'")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS count FROM memory_feedback WHERE feedback_id = 'feedback-old'")).toBe(0);

    const logPlan = planMemoryRetention({
      orgId: "org-a",
      projectId: "project-a1",
      dataClass: "security_log",
      actorId: "privacy-admin",
      reasonCode: "apply_security_logs",
      now: NOW,
    }, db);
    const logResult = applyMemoryErasurePlan({
      plan: logPlan,
      expectedPlanDigest: logPlan.plan_digest,
      downtimeConfirmed: true,
      compact: false,
    }, db);
    expect(logResult.state).toBe("pending_external_erasure");
    expect(db.prepare(
      "SELECT state FROM memory_erasure_events WHERE request_id = ?",
    ).get(logPlan.request_id)).toEqual({ state: "pending_external_erasure" });
    db.close();
  });

  it("governs harness v2 packs and their shared replay claim as one retained target", () => {
    const db = database();
    const seeded = seedHarnessV2Pack(db, {
      packId: "harness-pack-old",
    });
    createMemoryRetentionPolicyVersion({
      orgId: "org-a",
      projectId: "project-a1",
      dataClass: "retrieval_pack",
      retentionDays: 0,
      actorId: "privacy-admin",
      reasonCode: "retain_expired_harness_v2_pack",
      now: NOW,
    }, db);

    const reviewedPlan = planMemoryRetention({
      orgId: "org-a",
      projectId: "project-a1",
      dataClass: "retrieval_pack",
      actorId: "privacy-admin",
      reasonCode: "apply_expired_harness_v2_pack",
      now: NOW,
    }, db);
    expect(reviewedPlan.targets).toContainEqual(expect.objectContaining({
      resource_class: "retrieval_pack",
      resource_id: "harness-pack-old",
    }));

    db.prepare(
      `UPDATE memory_idempotency_keys SET response_json = '{"changed_after_review":true}'
       WHERE operation = 'memory_search_v2' AND idempotency_key = ?`,
    ).run(seeded.requestId);
    expect(() => applyMemoryErasurePlan({
      plan: reviewedPlan,
      expectedPlanDigest: reviewedPlan.plan_digest,
      downtimeConfirmed: true,
      compact: false,
      now: NOW,
    }, db)).toThrow(expect.objectContaining({ code: "plan_stale" }));
    expect(count(db, "SELECT COUNT(*) AS count FROM memory_erasure_requests")).toBe(0);

    db.prepare(
      `UPDATE memory_idempotency_keys SET response_json = ?
       WHERE operation = 'memory_search_v2' AND idempotency_key = ?`,
    ).run(seeded.responseJson, seeded.requestId);
    const currentPlan = planMemoryRetention({
      orgId: "org-a",
      projectId: "project-a1",
      dataClass: "retrieval_pack",
      actorId: "privacy-admin",
      reasonCode: "apply_expired_harness_v2_pack_after_review",
      now: NOW,
    }, db);
    applyMemoryErasurePlan({
      plan: currentPlan,
      expectedPlanDigest: currentPlan.plan_digest,
      downtimeConfirmed: true,
      compact: false,
      now: NOW,
    }, db);

    const storedPack = db.prepare(
      `SELECT plane, response_json, token_count, omitted_count
       FROM memory_v2_retrieval_packs WHERE retrieval_pack_id = 'harness-pack-old'`,
    ).get() as Record<string, string | number>;
    expect(storedPack).toEqual({
      plane: "harness",
      response_json: "{}",
      token_count: 0,
      omitted_count: 0,
    });
    expect(count(
      db,
      `SELECT COUNT(*) AS count FROM memory_v2_retrieval_pack_items
       WHERE retrieval_pack_id = 'harness-pack-old'`,
    )).toBe(0);
    const storedClaim = db.prepare(
      `SELECT request_digest, response_resource_type, response_resource_id, response_json
       FROM memory_idempotency_keys
       WHERE operation = 'memory_search_v2' AND idempotency_key = ?`,
    ).get(seeded.requestId) as Record<string, string>;
    expect(storedClaim).toMatchObject({
      response_resource_type: "memory_v2_retrieval_pack",
      response_resource_id: "harness-pack-old",
      response_json: "{}",
    });
    expect(() => parseMemoryContractV2(
      "MemorySearchResultV2",
      JSON.parse(String(storedPack.response_json)),
    )).toThrow();
    expect(() => parseMemoryContractV2(
      "MemorySearchResultV2",
      JSON.parse(storedClaim.response_json),
    )).toThrow();
    db.close();
  });

  it("rejects stale plans without writing audit rows", () => {
    const db = database();
    const repo = seedRepository(db, "org-a", "project-a1");
    seedRecord(db, {
      recordId: "record-stale",
      orgId: "org-a",
      projectId: "project-a1",
      repositoryRowId: repo,
      status: "revoked",
      updatedAt: OLD,
    });
    const plan = planMemoryErasure({
      orgId: "org-a",
      projectId: "project-a1",
      dataClass: "record",
      recordId: "record-stale",
      method: "physical_delete",
      actorId: "privacy-admin",
      reasonCode: "legal_erasure",
      now: NOW,
    }, db);
    db.prepare(
      "UPDATE memory_records SET updated_at = ? WHERE record_id = 'record-stale'",
    ).run("2026-08-03T12:00:01.000Z");
    expect(() => applyMemoryErasurePlan({
      plan,
      expectedPlanDigest: plan.plan_digest,
      downtimeConfirmed: true,
      compact: false,
    }, db)).toThrowError(expect.objectContaining({ code: "plan_stale" }));
    expect(count(db, "SELECT COUNT(*) AS count FROM memory_erasure_requests")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS count FROM memory_records WHERE record_id = 'record-stale'")).toBe(1);
    db.close();
  });

  it("rejects a plan when a newer policy becomes effective after planning", () => {
    const db = database();
    createMemoryRetentionPolicyVersion({
      orgId: "org-a",
      projectId: "project-a1",
      dataClass: "receipt",
      retentionDays: 30,
      actorId: "privacy-admin",
      reasonCode: "receipt_policy_v1",
      now: NOW,
    }, db);
    const plan = planMemoryRetention({
      orgId: "org-a",
      projectId: "project-a1",
      dataClass: "receipt",
      actorId: "privacy-admin",
      reasonCode: "planned_under_v1",
      now: NOW,
    }, db);
    createMemoryRetentionPolicyVersion({
      orgId: "org-a",
      projectId: "project-a1",
      dataClass: "receipt",
      retentionDays: 60,
      actorId: "privacy-admin",
      reasonCode: "receipt_policy_v2",
      effectiveAt: "2026-08-03T12:05:00.000Z",
      now: "2026-08-03T12:01:00.000Z",
    }, db);
    expect(() => applyMemoryErasurePlan({
      plan,
      expectedPlanDigest: plan.plan_digest,
      downtimeConfirmed: true,
      compact: false,
      now: "2026-08-03T12:06:00.000Z",
    }, db)).toThrowError(expect.objectContaining({ code: "plan_stale" }));
    expect(count(db, "SELECT COUNT(*) AS count FROM memory_erasure_requests")).toBe(0);
    db.close();
  });

  it("blocks an exact record hold until the append-only release event exists", () => {
    const db = database();
    const repo = seedRepository(db, "org-a", "project-a1");
    seedRecord(db, {
      recordId: "record-held",
      orgId: "org-a",
      projectId: "project-a1",
      repositoryRowId: repo,
      status: "revoked",
      updatedAt: OLD,
    });
    const plan = planMemoryErasure({
      orgId: "org-a",
      projectId: "project-a1",
      dataClass: "record",
      recordId: "record-held",
      method: "field_redaction",
      actorId: "privacy-admin",
      reasonCode: "field_erasure",
      now: NOW,
    }, db);
    expect(plan.effective_method).toBe("physical_delete");
    const hold = placeMemoryLegalHold({
      orgId: "org-a",
      projectId: "project-a1",
      dataClass: "record",
      resourceId: "record-held",
      actorId: "legal",
      reasonCode: "litigation",
      now: NOW,
    }, db);
    expect(() => applyMemoryErasurePlan({
      plan,
      expectedPlanDigest: plan.plan_digest,
      downtimeConfirmed: true,
      compact: false,
    }, db)).toThrowError(expect.objectContaining({ code: "legal_hold_active" }));
    releaseMemoryLegalHold({
      holdId: hold.holdId,
      actorId: "legal",
      reasonCode: "matter_closed",
      now: "2026-08-03T12:01:00.000Z",
    }, db);
    applyMemoryErasurePlan({
      plan,
      expectedPlanDigest: plan.plan_digest,
      downtimeConfirmed: true,
      compact: false,
    }, db);
    expect(count(db, "SELECT COUNT(*) AS count FROM memory_records WHERE record_id = 'record-held'")).toBe(0);
    db.close();
  });

  it("blocks exact and class-wide holds on collateral receipt targets", () => {
    const db = database();
    const repositoryRowId = seedRepository(db, "org-a", "project-a1");
    seedReceiptCandidate(db, {
      receiptId: "receipt-collateral-held",
      candidateId: "candidate-retention-root",
      repositoryRowId,
      plane: "codebase",
      status: "rejected",
    });
    createMemoryRetentionPolicyVersion({
      orgId: "org-a",
      projectId: "project-a1",
      dataClass: "candidate",
      retentionDays: 30,
      actorId: "privacy-admin",
      reasonCode: "candidate_retention",
      now: NOW,
    }, db);
    const plan = planMemoryRetention({
      orgId: "org-a",
      projectId: "project-a1",
      dataClass: "candidate",
      actorId: "privacy-admin",
      reasonCode: "apply_candidate_retention",
      now: NOW,
    }, db);
    expect(plan.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ resource_class: "candidate", resource_id: "candidate-retention-root" }),
      expect.objectContaining({ resource_class: "receipt", resource_id: "receipt-collateral-held" }),
    ]));

    const exactHold = placeMemoryLegalHold({
      orgId: "org-a",
      projectId: "project-a1",
      dataClass: "receipt",
      resourceId: "receipt-collateral-held",
      actorId: "legal",
      reasonCode: "receipt_evidence_hold",
      now: NOW,
    }, db);
    expect(() => applyMemoryErasurePlan({
      plan,
      expectedPlanDigest: plan.plan_digest,
      downtimeConfirmed: true,
      compact: false,
      now: NOW,
    }, db)).toThrowError(expect.objectContaining({ code: "legal_hold_active" }));
    expect(count(db, "SELECT COUNT(*) AS count FROM memory_erasure_requests")).toBe(0);
    releaseMemoryLegalHold({
      holdId: exactHold.holdId,
      actorId: "legal",
      reasonCode: "exact_hold_released",
      now: "2026-08-03T12:01:00.000Z",
    }, db);

    const classHold = placeMemoryLegalHold({
      orgId: "org-a",
      projectId: "project-a1",
      dataClass: "receipt",
      actorId: "legal",
      reasonCode: "receipt_class_hold",
      now: "2026-08-03T12:02:00.000Z",
    }, db);
    expect(() => applyMemoryErasurePlan({
      plan,
      expectedPlanDigest: plan.plan_digest,
      downtimeConfirmed: true,
      compact: false,
      now: NOW,
    }, db)).toThrowError(expect.objectContaining({ code: "legal_hold_active" }));
    releaseMemoryLegalHold({
      holdId: classHold.holdId,
      actorId: "legal",
      reasonCode: "class_hold_released",
      now: "2026-08-03T12:03:00.000Z",
    }, db);

    placeMemoryLegalHold({
      orgId: "org-a",
      projectId: "project-a1",
      dataClass: "candidate",
      resourceId: "receipt-collateral-held",
      actorId: "legal",
      reasonCode: "same_id_other_class",
      now: "2026-08-03T12:04:00.000Z",
    }, db);
    applyMemoryErasurePlan({
      plan,
      expectedPlanDigest: plan.plan_digest,
      downtimeConfirmed: true,
      compact: false,
      now: NOW,
    }, db);
    expect(count(db, "SELECT COUNT(*) AS count FROM memory_candidates_v1")).toBe(0);
    expect(db.prepare(
      "SELECT receipt_json FROM memory_run_receipts WHERE receipt_id = 'receipt-collateral-held'",
    ).get()).toEqual({ receipt_json: "{}" });
    db.close();
  });

  it("governs legacy and canonical-v2 feedback independently and keeps redaction startup-safe", () => {
    const db = database();
    const repositoryRowId = seedRepository(db, "org-a", "project-a1");
    seedRecord(db, {
      recordId: "feedback-ledger-record",
      orgId: "org-a",
      projectId: "project-a1",
      repositoryRowId,
      status: "active",
      updatedAt: OLD,
    });
    seedV2RecordCompanion(db, {
      recordId: "feedback-ledger-record",
      repositoryRowId,
    });
    const resourceRowId = `v2res_repository:${repositoryRowId}`;
    const resourceBinding = storedV2ResourceBinding(db, resourceRowId);
    const baseSha = "a".repeat(40);
    const scopeBody = {
      schema_version: "pim.memory-scope-snapshot.codebase.v2",
      plane: "codebase",
      resource_binding: resourceBinding,
      repository_id: "github.com/acme/project-a1",
      base_sha: baseSha,
    };
    const scopeDigest = canonicalJsonSha256(scopeBody);
    seedV2Pack(db, {
      packId: "v2-feedback-pack",
      recordId: "feedback-ledger-record",
      repositoryRowId,
      scopeDigest,
      createdAt: OLD,
      expiresAt: "2026-06-02T00:00:00.000Z",
    });
    db.prepare(
      `INSERT INTO memory_retrieval_packs (
         retrieval_pack_id, org_id, project_id, request_id, request_digest,
         repository_row_id, repository_id, harness_id, plane, query, policy_version,
         ranker_version, authorized_scope_json, token_count, omitted_count, response_json,
         created_at, expires_at, prompt_eligible, evaluation_arm, prompt_policy_revision,
         prompt_policy_snapshot_json, prompt_item_count, prompt_token_count
       ) VALUES (
         'legacy-feedback-pack', 'org-a', 'project-a1', 'legacy-feedback-request', ?, ?,
         'github.com/acme/project-a1', NULL, 'codebase', 'legacy query', 'policy-v1',
         'ranker-v1', '{}', 1, 0, '{}', ?, ?, 0, 'shadow', 0, '{}', 0, 0
       )`,
    ).run(SHA, repositoryRowId, OLD, "2026-06-02T00:00:00.000Z");
    db.prepare(
      `INSERT INTO memory_retrieval_pack_items (
         retrieval_pack_id, item_order, record_id, record_version, token_count,
         rank_score, match_reasons_json, prompt_eligible
       ) VALUES (
         'legacy-feedback-pack', 0, 'feedback-ledger-record', 1, 1, 1.0, '[]', 0
       )`,
    ).run();

    const coreRequestDigest = canonicalJsonSha256({ projected: "v1-receipt" });
    const v2RequestDigest = canonicalJsonSha256({ request: "v2-receipt" });
    const receiptResponse = {
      schema_version: "pim.run-receipt-result.v2",
      receipt_id: "feedback-ledger-receipt",
      producer_run_id: "feedback-ledger-run",
      request_digest: v2RequestDigest,
      tenant: { organization_id: "org-a", project_id: "project-a1" },
      plane: "codebase",
      resource_binding: resourceBinding,
      scope_snapshot_digest: scopeDigest,
      status: "accepted",
      duplicate: false,
      candidate_results: [],
    };
    db.prepare(
      `INSERT INTO memory_run_receipts (
         receipt_id, org_id, project_id, producer_run_id, schema_major, idempotency_key,
         request_digest, receipt_json, response_json, producer_harness_id,
         repository_row_id, repository_id, base_sha, outcome_status, created_at
       ) VALUES (
         'feedback-ledger-receipt', 'org-a', 'project-a1', 'feedback-ledger-run',
         'pim.run-receipt.v1', 'feedback-ledger-key', ?, '{}', '{}', 'example-harness-a', ?,
         'github.com/acme/project-a1', ?, 'completed', ?
       )`,
    ).run(coreRequestDigest, repositoryRowId, baseSha, OLD);
    db.prepare(
      `INSERT INTO memory_v2_receipt_facets (
         receipt_id, org_id, project_id, plane, resource_row_id, facet_json, created_at
       ) VALUES (
         'feedback-ledger-receipt', 'org-a', 'project-a1', 'codebase', ?,
         '{"projection":"v2"}', ?
       )`,
    ).run(resourceRowId, OLD);
    db.prepare(
      `INSERT INTO memory_v2_scope_snapshots (
         receipt_id, org_id, project_id, plane, resource_row_id, producer_principal_id,
         producer_run_id, request_digest, core_request_digest, scope_snapshot_json,
         scope_snapshot_digest, response_json, created_at
       ) VALUES (
         'feedback-ledger-receipt', 'org-a', 'project-a1', 'codebase', ?,
         'principal-test', 'feedback-ledger-run', ?, ?, ?, ?, ?, ?
       )`,
    ).run(
      resourceRowId,
      v2RequestDigest,
      coreRequestDigest,
      JSON.stringify({ ...scopeBody, scope_snapshot_digest: scopeDigest }),
      scopeDigest,
      JSON.stringify(receiptResponse),
      OLD,
    );
    db.prepare(
      `INSERT INTO memory_idempotency_keys (
         org_id, project_id, operation, idempotency_key, request_digest,
         response_resource_type, response_resource_id, response_json, created_at, expires_at
       ) VALUES (
         'org-a', 'project-a1', 'memory_run_receipt_v2', 'feedback-ledger-key', ?,
         'memory_v2_scope_snapshot', 'feedback-ledger-receipt', ?, ?, ?
       )`,
    ).run(v2RequestDigest, JSON.stringify(receiptResponse), OLD, FRESH);

    db.prepare(
      `INSERT INTO memory_feedback (
         feedback_id, org_id, project_id, receipt_id, producer_run_id,
         retrieval_pack_id, record_id, record_version, feedback_stage,
         feedback_revision, feedback_json, feedback_digest, created_at
       ) VALUES (
         'feedback-collision', 'org-a', 'project-a1', 'feedback-ledger-receipt',
         'feedback-ledger-run', 'legacy-feedback-pack', 'feedback-ledger-record', 1,
         'later', 1, '{"source":"migrated-v1","disposition":"harmful"}', ?, ?
       )`,
    ).run(canonicalJsonSha256({ source: "migrated-v1" }), OLD);
    db.prepare(
      `INSERT INTO memory_v2_feedback_facets (
         feedback_id, org_id, project_id, plane, resource_row_id, facet_json, created_at
       ) VALUES (
         'feedback-collision', 'org-a', 'project-a1', 'codebase', ?,
         '{"projection":"migrated-v1"}', ?
       )`,
    ).run(resourceRowId, OLD);
    db.prepare(
      `INSERT INTO memory_review_signals (
         signal_id, org_id, project_id, feedback_id, record_id, record_version,
         signal_type, reason_code, status, created_at, resolved_at
       ) VALUES (
         'legacy-feedback-signal', 'org-a', 'project-a1', 'feedback-collision',
         'feedback-ledger-record', 1, 'harmful_review', 'legacy.harmful', 'open', ?, NULL
       )`,
    ).run(OLD);
    seedFeedbackReviewOutbox(db, {
      jobId: "legacy-feedback-job",
      recordId: "feedback-ledger-record",
      payload: {
        feedback_source: "memory_feedback",
        feedback_id: "feedback-collision",
        signal_id: "legacy-feedback-signal",
      },
    });

    const laterFeedback = {
      schema_version: "pim.memory-feedback.v2",
      feedback_revision: 1,
      retrieval_pack_id: "v2-feedback-pack",
      record_id: "feedback-ledger-record",
      record_version: 1,
      producer_run_id: "feedback-ledger-run",
      plane: "codebase",
      resource_row_id: resourceRowId,
      scope_snapshot_digest: scopeDigest,
      disposition: "harmful",
      reason_code: "v2.harmful",
      outcome_evidence_refs: [],
      event_time: OLD,
    };
    const laterFeedbackDigest = canonicalJsonSha256(laterFeedback);
    const laterResponse = {
      schema_version: "pim.memory-feedback-result.v2",
      feedback_id: "feedback-collision",
      feedback_revision: 1,
      tenant: { organization_id: "org-a", project_id: "project-a1" },
      plane: "codebase",
      resource_binding: resourceBinding,
      duplicate: false,
      review_signal_ids: ["v2-feedback-signal"],
    };
    db.prepare(
      `INSERT INTO memory_v2_feedback_bindings (
         feedback_id, org_id, project_id, receipt_id, producer_principal_id,
         producer_run_id, feedback_stage, feedback_revision, retrieval_pack_id,
         record_id, record_version, plane, resource_row_id, scope_snapshot_digest,
         feedback_json, feedback_digest, response_json, created_at
       ) VALUES (
         'feedback-collision', 'org-a', 'project-a1', 'feedback-ledger-receipt',
         'principal-test', 'feedback-ledger-run', 'later', 1, 'v2-feedback-pack',
         'feedback-ledger-record', 1, 'codebase', ?, ?, ?, ?, ?, ?
       )`,
    ).run(
      resourceRowId,
      scopeDigest,
      JSON.stringify(laterFeedback),
      laterFeedbackDigest,
      JSON.stringify(laterResponse),
      OLD,
    );
    const receiptFeedback = {
      retrieval_pack_id: "v2-feedback-pack",
      scope_snapshot_digest: scopeDigest,
      record_id: "feedback-ledger-record",
      record_version: 1,
      disposition: "helpful",
      reason_code: "v2.receipt.helpful",
    };
    db.prepare(
      `INSERT INTO memory_v2_feedback_bindings (
         feedback_id, org_id, project_id, receipt_id, producer_principal_id,
         producer_run_id, feedback_stage, feedback_revision, retrieval_pack_id,
         record_id, record_version, plane, resource_row_id, scope_snapshot_digest,
         feedback_json, feedback_digest, response_json, created_at
       ) VALUES (
         'v2-receipt-feedback', 'org-a', 'project-a1', 'feedback-ledger-receipt',
         'principal-test', 'feedback-ledger-run', 'receipt', 0, 'v2-feedback-pack',
         'feedback-ledger-record', 1, 'codebase', ?, ?, ?, ?, ?, ?
       )`,
    ).run(
      resourceRowId,
      scopeDigest,
      JSON.stringify(receiptFeedback),
      canonicalJsonSha256(receiptFeedback),
      JSON.stringify(receiptResponse),
      OLD,
    );
    seedFeedbackReviewOutbox(db, {
      jobId: "v2-feedback-job",
      recordId: "feedback-ledger-record",
      payload: {
        feedback_source: "memory_v2_feedback_bindings",
        feedback_id: "feedback-collision",
        signal_id: "v2-feedback-signal",
      },
    });
    db.prepare(
      `INSERT INTO memory_v2_feedback_review_signals (
         signal_id, org_id, project_id, feedback_id, record_id, record_version,
         signal_type, reason_code, status, outbox_job_id, created_at, resolved_at
       ) VALUES (
         'v2-feedback-signal', 'org-a', 'project-a1', 'feedback-collision',
         'feedback-ledger-record', 1, 'harmful_review', 'v2.harmful', 'open',
         'v2-feedback-job', ?, NULL
       )`,
    ).run(OLD);
    db.prepare(
      `INSERT INTO memory_idempotency_keys (
         org_id, project_id, operation, idempotency_key, request_digest,
         response_resource_type, response_resource_id, response_json, created_at, expires_at
       ) VALUES (
         'org-a', 'project-a1', 'memory_feedback_v2', 'v2-feedback-key', ?,
         'memory_v2_feedback_binding', 'feedback-collision', ?, ?, ?
       )`,
    ).run(laterFeedbackDigest, JSON.stringify(laterResponse), OLD, FRESH);

    expect(count(db, "SELECT COUNT(*) AS count FROM memory_feedback WHERE feedback_id = 'feedback-collision'"))
      .toBe(1);
    expect(count(db, "SELECT COUNT(*) AS count FROM memory_v2_feedback_facets WHERE feedback_id = 'feedback-collision'"))
      .toBe(1);
    expect(count(db, "SELECT COUNT(*) AS count FROM memory_review_signals WHERE feedback_id = 'feedback-collision'"))
      .toBe(1);
    expect(count(db, "SELECT COUNT(*) AS count FROM memory_v2_feedback_bindings"))
      .toBe(2);
    expect(reconcileMemoryV2CanonicalWrites(db)).toMatchObject({
      feedbackBindingCount: 2,
      reviewSignalCount: 1,
      mismatchCount: 0,
      ok: true,
    });

    for (const dataClass of ["retrieval_pack", "receipt", "feedback"] as const) {
      createMemoryRetentionPolicyVersion({
        orgId: "org-a",
        projectId: "project-a1",
        dataClass,
        retentionDays: 0,
        actorId: "privacy-admin",
        reasonCode: `retain_${dataClass}`,
        now: NOW,
      }, db);
    }

    const packPlan = planMemoryRetention({
      orgId: "org-a",
      projectId: "project-a1",
      dataClass: "retrieval_pack",
      actorId: "privacy-admin",
      reasonCode: "redact_packs",
      now: NOW,
    }, db);
    applyMemoryErasurePlan({
      plan: packPlan,
      expectedPlanDigest: packPlan.plan_digest,
      downtimeConfirmed: true,
      compact: false,
    }, db);
    expect(count(db, `SELECT COUNT(*) AS count FROM memory_v2_retrieval_pack_items
      WHERE retrieval_pack_id = 'v2-feedback-pack'`)).toBe(1);
    expect(reconcileMemoryV2CanonicalWrites(db).ok).toBe(true);

    const receiptPlan = planMemoryRetention({
      orgId: "org-a",
      projectId: "project-a1",
      dataClass: "receipt",
      actorId: "privacy-admin",
      reasonCode: "redact_receipt",
      now: NOW,
    }, db);
    applyMemoryErasurePlan({
      plan: receiptPlan,
      expectedPlanDigest: receiptPlan.plan_digest,
      downtimeConfirmed: true,
      compact: false,
    }, db);
    expect(db.prepare(
      `SELECT scope_snapshot_json, response_json
       FROM memory_v2_scope_snapshots WHERE receipt_id = 'feedback-ledger-receipt'`,
    ).get()).toEqual({ scope_snapshot_json: "{}", response_json: "{}" });
    expect(db.prepare(
      `SELECT response_json FROM memory_v2_feedback_bindings
       WHERE feedback_id = 'v2-receipt-feedback'`,
    ).get()).toEqual({ response_json: "{}" });
    expect(reconcileMemoryV2CanonicalWrites(db).ok).toBe(true);

    const feedbackPlan = planMemoryRetention({
      orgId: "org-a",
      projectId: "project-a1",
      dataClass: "feedback",
      actorId: "privacy-admin",
      reasonCode: "erase_feedback",
      now: NOW,
    }, db);
    expect(feedbackPlan.targets.filter((entry) => entry.resource_class === "feedback")
      .map((entry) => entry.resource_id)).toEqual([
      "feedback-collision",
      "memory_v2_feedback_bindings:feedback-collision",
      "memory_v2_feedback_bindings:v2-receipt-feedback",
    ]);
    applyMemoryErasurePlan({
      plan: feedbackPlan,
      expectedPlanDigest: feedbackPlan.plan_digest,
      downtimeConfirmed: true,
      compact: false,
    }, db);
    expect(count(db, "SELECT COUNT(*) AS count FROM memory_feedback")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS count FROM memory_v2_feedback_facets")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS count FROM memory_review_signals")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS count FROM memory_v2_feedback_bindings")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS count FROM memory_v2_feedback_review_signals")).toBe(0);
    expect(count(db, `SELECT COUNT(*) AS count FROM memory_outbox
      WHERE job_id IN ('legacy-feedback-job','v2-feedback-job')`)).toBe(0);
    expect(db.prepare(
      `SELECT resource_id FROM memory_erasure_tombstones
       WHERE resource_class = 'feedback' ORDER BY resource_id`,
    ).all()).toEqual([
      { resource_id: "feedback-collision" },
      { resource_id: "memory_v2_feedback_bindings:feedback-collision" },
      { resource_id: "memory_v2_feedback_bindings:v2-receipt-feedback" },
    ]);
    expect(reconcileMemoryV2CanonicalWrites(db)).toMatchObject({
      scopeSnapshotCount: 1,
      feedbackBindingCount: 0,
      mismatchCount: 0,
      ok: true,
    });

    const tenantPlan = planMemoryErasure({
      orgId: "org-a",
      projectId: "project-a1",
      dataClass: "tenant",
      method: "physical_delete",
      actorId: "privacy-admin",
      reasonCode: "erase_tenant",
      now: "2026-08-03T13:00:00.000Z",
    }, db);
    applyMemoryErasurePlan({
      plan: tenantPlan,
      expectedPlanDigest: tenantPlan.plan_digest,
      downtimeConfirmed: true,
      compact: false,
    }, db);
    expect(reconcileMemoryV2CanonicalWrites(db)).toMatchObject({
      scopeSnapshotCount: 0,
      feedbackBindingCount: 0,
      mismatchCount: 0,
      ok: true,
    });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });

  it("governs the complete reverification closure with stale-plan and trigger-restoration safety", () => {
    const db = database();
    const targetRepo = seedRepository(db, "org-a", "project-a1");
    seedRecord(db, {
      recordId: "reverify-record-target",
      orgId: "org-a",
      projectId: "project-a1",
      repositoryRowId: targetRepo,
      status: "active",
      updatedAt: OLD,
    });
    seedV2RecordCompanion(db, {
      recordId: "reverify-record-target",
      repositoryRowId: targetRepo,
    });
    const targetGraph = seedReverificationGraph(db, {
      recordId: "reverify-record-target",
      repositoryRowId: targetRepo,
      idSuffix: "target",
      jobId: "shared-cross-source-job-id",
    });
    db.prepare(
      `UPDATE memory_records
       SET current_status = 'revoked', aggregate_version = aggregate_version + 1,
           updated_at = ? WHERE record_id = 'reverify-record-target'`,
    ).run(OLD);

    const survivorRepo = seedRepository(db, "org-b", "project-b1");
    seedRecord(db, {
      recordId: "reverify-record-survivor",
      orgId: "org-b",
      projectId: "project-b1",
      repositoryRowId: survivorRepo,
      status: "active",
      updatedAt: OLD,
    });
    seedV2RecordCompanion(db, {
      recordId: "reverify-record-survivor",
      repositoryRowId: survivorRepo,
    });
    const survivorGraph = seedReverificationGraph(db, {
      recordId: "reverify-record-survivor",
      repositoryRowId: survivorRepo,
      idSuffix: "survivor",
    });
    seedFeedbackReviewOutbox(db, {
      jobId: targetGraph.jobId,
      recordId: "unrelated-legacy-record",
      payload: { source: "legacy-outbox-with-colliding-id" },
    });

    createMemoryRetentionPolicyVersion({
      orgId: "org-a",
      projectId: "project-a1",
      dataClass: "record",
      retentionDays: 0,
      actorId: "privacy-admin",
      reasonCode: "retain_retired_reverification_record",
      now: NOW,
    }, db);
    const reviewedPlan = planMemoryRetention({
      orgId: "org-a",
      projectId: "project-a1",
      dataClass: "record",
      actorId: "privacy-admin",
      reasonCode: "erase_retired_reverification_record",
      now: NOW,
    }, db);
    expect(reviewedPlan.targets).toContainEqual(expect.objectContaining({
      resource_class: "record",
      resource_id: "reverify-record-target",
    }));

    db.prepare(
      `INSERT INTO memory_v2_reverification_job_attempts
         (attempt_id, job_id, attempt_number, worker_id, outcome, error_code,
          started_at, completed_at)
       VALUES ('reverify-attempt-target-2', ?, 2, 'governance-worker-2',
               'retry', 'provider_still_unavailable', ?, ?)`,
    ).run(targetGraph.jobId, FRESH, FRESH);
    expect(() => applyMemoryErasurePlan({
      plan: reviewedPlan,
      expectedPlanDigest: reviewedPlan.plan_digest,
      downtimeConfirmed: true,
      compact: false,
      now: NOW,
    }, db)).toThrow(expect.objectContaining({ code: "plan_stale" }));
    expect(count(db, "SELECT COUNT(*) AS count FROM memory_erasure_requests")).toBe(0);

    const currentPlan = planMemoryRetention({
      orgId: "org-a",
      projectId: "project-a1",
      dataClass: "record",
      actorId: "privacy-admin",
      reasonCode: "erase_retired_reverification_record_after_review",
      now: NOW,
    }, db);
    const currentRecordTarget = currentPlan.targets.find((entry) => (
      entry.resource_class === "record" && entry.resource_id === "reverify-record-target"
    ));
    expect(currentRecordTarget).toBeDefined();
    applyMemoryErasurePlan({
      plan: currentPlan,
      expectedPlanDigest: currentPlan.plan_digest,
      downtimeConfirmed: true,
      compact: false,
      now: NOW,
    }, db);

    for (const table of [
      "memory_v2_reverification_job_attempts",
      "memory_v2_reverification_decisions",
      "memory_v2_reverification_jobs",
      "memory_v2_reverification_state",
      "memory_v2_reverification_policies",
    ]) {
      const key = table === "memory_v2_reverification_job_attempts" ? "job_id" : "record_id";
      const value = key === "job_id" ? targetGraph.jobId : "reverify-record-target";
      expect(count(db, `SELECT COUNT(*) AS count FROM ${table} WHERE ${key} = ?`, value)).toBe(0);
    }
    expect(count(
      db,
      "SELECT COUNT(*) AS count FROM memory_outbox WHERE job_id = ?",
      targetGraph.jobId,
    )).toBe(1);
    expect(db.prepare(
      `SELECT content_digest FROM memory_erasure_tombstones
       WHERE resource_class = 'record' AND resource_id = 'reverify-record-target'`,
    ).get()).toEqual({ content_digest: currentRecordTarget!.content_digest });

    expect(count(
      db,
      "SELECT COUNT(*) AS count FROM memory_v2_reverification_policies WHERE record_id = ?",
      "reverify-record-survivor",
    )).toBe(1);
    expect(count(
      db,
      "SELECT COUNT(*) AS count FROM memory_v2_reverification_state WHERE record_id = ?",
      "reverify-record-survivor",
    )).toBe(1);
    expect(count(
      db,
      "SELECT COUNT(*) AS count FROM memory_v2_reverification_decisions WHERE record_id = ?",
      "reverify-record-survivor",
    )).toBe(1);
    expect(count(
      db,
      "SELECT COUNT(*) AS count FROM memory_v2_reverification_jobs WHERE record_id = ?",
      "reverify-record-survivor",
    )).toBe(1);
    expect(count(
      db,
      "SELECT COUNT(*) AS count FROM memory_v2_reverification_job_attempts WHERE job_id = ?",
      survivorGraph.jobId,
    )).toBe(1);
    expect(() => db.prepare(
      "DELETE FROM memory_v2_reverification_policies WHERE policy_id = ?",
    ).run(survivorGraph.policyId)).toThrow(/append-only/);
    expect(() => db.prepare(
      "DELETE FROM memory_v2_reverification_decisions WHERE decision_id = ?",
    ).run(survivorGraph.decisionId)).toThrow(/immutable/);
    expect(() => db.prepare(
      "DELETE FROM memory_v2_reverification_jobs WHERE job_id = ?",
    ).run(survivorGraph.jobId)).toThrow(/cannot be deleted/);
    expect(() => db.prepare(
      "DELETE FROM memory_v2_reverification_job_attempts WHERE attempt_id = ?",
    ).run(survivorGraph.attemptId)).toThrow(/immutable/);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });

  it("supports project and org-wide tenant erasure without crossing tenant boundaries", () => {
    const db = database();
    const repoA1 = seedRepository(db, "org-a", "project-a1");
    const repoA2 = seedRepository(db, "org-a", "project-a2");
    const repoB1 = seedRepository(db, "org-b", "project-b1");
    seedRecord(db, {
      recordId: "record-a1",
      orgId: "org-a",
      projectId: "project-a1",
      repositoryRowId: repoA1,
      status: "active",
      updatedAt: OLD,
    });
    seedRecord(db, {
      recordId: "record-a2",
      orgId: "org-a",
      projectId: "project-a2",
      repositoryRowId: repoA2,
      status: "active",
      updatedAt: OLD,
    });
    seedRecord(db, {
      recordId: "record-b1",
      orgId: "org-b",
      projectId: "project-b1",
      repositoryRowId: repoB1,
      status: "active",
      updatedAt: OLD,
    });
    const reverifyGraphs = new Map<string, ReturnType<typeof seedReverificationGraph>>();
    for (const [recordId, repositoryRowId, packId] of [
      ["record-a1", repoA1, "v2-pack-a1"],
      ["record-a2", repoA2, "v2-pack-a2"],
      ["record-b1", repoB1, "v2-pack-b1"],
    ] as const) {
      seedV2RecordCompanion(db, { recordId, repositoryRowId });
      seedV2Pack(db, { packId, recordId, repositoryRowId });
      reverifyGraphs.set(recordId, seedReverificationGraph(db, {
        recordId,
        repositoryRowId,
        idSuffix: recordId,
      }));
    }
    const untouchedPackB = db.prepare(
      `SELECT resource_binding_json, response_json
       FROM memory_v2_retrieval_packs WHERE retrieval_pack_id = 'v2-pack-b1'`,
    ).get();

    const projectPlan = planMemoryErasure({
      orgId: "org-a",
      projectId: "project-a1",
      dataClass: "tenant",
      method: "physical_delete",
      actorId: "privacy-admin",
      reasonCode: "project_deleted",
      now: NOW,
    }, db);
    applyMemoryErasurePlan({
      plan: projectPlan,
      expectedPlanDigest: projectPlan.plan_digest,
      downtimeConfirmed: true,
      compact: false,
    }, db);
    expect(db.prepare("SELECT record_id FROM memory_records ORDER BY record_id").all())
      .toEqual([{ record_id: "record-a2" }, { record_id: "record-b1" }]);
    expect(db.prepare(
      "SELECT retrieval_pack_id FROM memory_v2_retrieval_packs ORDER BY retrieval_pack_id",
    ).all()).toEqual([
      { retrieval_pack_id: "v2-pack-a2" },
      { retrieval_pack_id: "v2-pack-b1" },
    ]);
    for (const table of [
      "memory_v2_reverification_policies",
      "memory_v2_reverification_state",
      "memory_v2_reverification_decisions",
      "memory_v2_reverification_jobs",
    ]) {
      expect(db.prepare(
        `SELECT record_id FROM ${table} ORDER BY record_id`,
      ).all()).toEqual([
        { record_id: "record-a2" },
        { record_id: "record-b1" },
      ]);
    }
    expect(db.prepare(
      `SELECT parent.record_id
       FROM memory_v2_reverification_job_attempts AS child
       JOIN memory_v2_reverification_jobs AS parent ON parent.job_id = child.job_id
       ORDER BY parent.record_id`,
    ).all()).toEqual([
      { record_id: "record-a2" },
      { record_id: "record-b1" },
    ]);
    const orgPlan = planMemoryErasure({
      orgId: "org-a",
      dataClass: "tenant",
      method: "physical_delete",
      actorId: "privacy-admin",
      reasonCode: "tenant_deleted",
      now: "2026-08-03T13:00:00.000Z",
    }, db);
    applyMemoryErasurePlan({
      plan: orgPlan,
      expectedPlanDigest: orgPlan.plan_digest,
      downtimeConfirmed: true,
      compact: false,
    }, db);
    expect(db.prepare("SELECT record_id, org_id FROM memory_records").all())
      .toEqual([{ record_id: "record-b1", org_id: "org-b" }]);
    expect(db.prepare(
      `SELECT resource_binding_json, response_json
       FROM memory_v2_retrieval_packs WHERE retrieval_pack_id = 'v2-pack-b1'`,
    ).get()).toEqual(untouchedPackB);
    expect(db.prepare(
      "SELECT retrieval_pack_id FROM memory_v2_retrieval_packs ORDER BY retrieval_pack_id",
    ).all()).toEqual([{ retrieval_pack_id: "v2-pack-b1" }]);
    for (const table of [
      "memory_v2_reverification_policies",
      "memory_v2_reverification_state",
      "memory_v2_reverification_decisions",
      "memory_v2_reverification_jobs",
    ]) {
      expect(db.prepare(
        `SELECT record_id FROM ${table} ORDER BY record_id`,
      ).all()).toEqual([{ record_id: "record-b1" }]);
    }
    expect(db.prepare(
      `SELECT parent.record_id
       FROM memory_v2_reverification_job_attempts AS child
       JOIN memory_v2_reverification_jobs AS parent ON parent.job_id = child.job_id
       ORDER BY parent.record_id`,
    ).all()).toEqual([{ record_id: "record-b1" }]);
    expect(() => db.prepare(
      "DELETE FROM memory_v2_retrieval_packs WHERE retrieval_pack_id = 'v2-pack-b1'",
    ).run()).toThrow(/immutable/);
    expect(count(db, "SELECT COUNT(*) AS count FROM memory_repository_registry WHERE org_id = 'org-a'")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS count FROM memory_repository_registry WHERE org_id = 'org-b'")).toBe(1);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });

  it("fails crypto-shred closed and rolls back a failed physical erase with guards intact", () => {
    const db = database();
    const repo = seedRepository(db, "org-a", "project-a1");
    seedRecord(db, {
      recordId: "record-protected",
      orgId: "org-a",
      projectId: "project-a1",
      repositoryRowId: repo,
      status: "revoked",
      updatedAt: OLD,
    });
    expect(() => planMemoryErasure({
      orgId: "org-a",
      projectId: "project-a1",
      dataClass: "record",
      recordId: "record-protected",
      method: "crypto_shred",
      actorId: "privacy-admin",
      reasonCode: "crypto_requested",
      now: NOW,
    }, db)).toThrowError(expect.objectContaining({ code: "crypto_shred_unavailable" }));

    const plan = planMemoryErasure({
      orgId: "org-a",
      projectId: "project-a1",
      dataClass: "record",
      recordId: "record-protected",
      method: "physical_delete",
      actorId: "privacy-admin",
      reasonCode: "legal_erasure",
      now: NOW,
    }, db);
    db.exec(`
      CREATE TABLE external_record_reference (
        record_id TEXT PRIMARY KEY REFERENCES memory_records(record_id)
      );
      INSERT INTO external_record_reference VALUES ('record-protected');
    `);
    expect(() => applyMemoryErasurePlan({
      plan,
      expectedPlanDigest: plan.plan_digest,
      downtimeConfirmed: true,
      compact: false,
    }, db)).toThrow();
    expect(count(db, "SELECT COUNT(*) AS count FROM memory_erasure_requests")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS count FROM memory_records WHERE record_id = 'record-protected'")).toBe(1);
    expect(() => db.prepare(
      "UPDATE memory_record_versions SET content_json = '{}' WHERE record_id = 'record-protected'",
    ).run()).toThrow(/immutable/);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });

  it("erases subtype-ambiguous harness quarantine with its record and restores empty readiness", () => {
    const db = database();
    db.exec(`
      INSERT INTO service_principals VALUES ('harness-principal', 'org-a');
      INSERT INTO memory_harness_principal_bindings (
        binding_id, service_principal_id, org_id, project_id, harness_id, created_at
      ) VALUES (
        'harness-binding', 'harness-principal', 'org-a', 'project-a1', 'example-harness-a', '${OLD}'
      );
      INSERT INTO memory_v2_resources (
        resource_row_id, org_id, project_id, plane, resource_type,
        canonical_resource_id, display_label, provider, provider_resource_id,
        classification, retention_reference, source_authority, source_row_id,
        valid_from, valid_until, created_at, updated_at
      ) VALUES (
        'v2res-harness-example-harness-a', 'org-a', 'project-a1', 'harness', 'harness',
        'example-harness-a', 'example-harness-a', NULL, NULL, 'internal', NULL,
        'memory_harness_principal_bindings',
        'identity:6F72672D61:70726F6A6563742D6131:666965737461',
        '${OLD}', NULL, '${OLD}', '${OLD}'
      );
      INSERT INTO memory_records (
        record_id, org_id, project_id, repository_row_id, harness_id, plane, kind,
        current_version, current_status, aggregate_version, shadow_recall_eligible,
        prompt_eligible, claim_key, valid_from, valid_until, expires_at, created_at, updated_at
      ) VALUES (
        'harness-ambiguous-record', 'org-a', 'project-a1', NULL, 'example-harness-a',
        'harness', 'constraint', 1, 'revoked', 1, 1, 0,
        'harness-ambiguous-claim', '${OLD}', NULL, NULL, '${OLD}', '${OLD}'
      );
      INSERT INTO memory_record_versions (
        record_id, record_version, content_json, applicability_json, exceptions_json,
        compatibility_json, validation_json, evidence_json, evidence_summary_json,
        freshness_json, provenance_json, embedding_json, content_digest, recorded_at
      ) VALUES (
        'harness-ambiguous-record', 1,
        '{"summary":"Ambiguous harness constraint","details":"Ambiguous legacy harness constraint details.","rationale":"The broad kind has two possible v2 subtypes."}',
        '{"harness_id":"example-harness-a","harness_version_range":"*"}', '[]', '{}',
        '{"strategy":"stable_failure_fingerprint","failure_fingerprint":"ambiguous"}',
        '[]', '{}', '{}', '{}', NULL, '${SHA}', '${OLD}'
      );
      INSERT INTO memory_v2_facet_quarantine (
        quarantine_row_id, aggregate_type, aggregate_id, aggregate_version,
        org_id, project_id, source_plane, reason_code, source_digest, created_at
      ) VALUES (
        'v2facetq:harness-ambiguous-record', 'record', 'harness-ambiguous-record', 1,
        'org-a', 'project-a1', 'harness', 'subtype_ambiguous', '${SHA}', '${OLD}'
      );
    `);

    expect(reconcileMemoryV2HarnessReadFacets({ now: NOW }, db)).toMatchObject({
      sourceRecordVersionCount: 1,
      mappedRecordVersionCount: 0,
      quarantinedRecordVersionCount: 1,
      ambiguousRecordVersionCount: 1,
      emptyBackfill: false,
      ok: true,
    });

    const plan = planMemoryErasure({
      orgId: "org-a",
      projectId: "project-a1",
      dataClass: "record",
      recordId: "harness-ambiguous-record",
      method: "physical_delete",
      actorId: "privacy-admin",
      reasonCode: "erase_ambiguous_harness_record",
      now: NOW,
    }, db);
    applyMemoryErasurePlan({
      plan,
      expectedPlanDigest: plan.plan_digest,
      downtimeConfirmed: true,
      compact: false,
    }, db);

    expect(count(
      db,
      `SELECT COUNT(*) AS count FROM memory_v2_facet_quarantine
       WHERE aggregate_type = 'record' AND aggregate_id = 'harness-ambiguous-record'`,
    )).toBe(0);
    expect(reconcileMemoryV2HarnessReadFacets({ now: NOW }, db)).toMatchObject({
      sourceRecordVersionCount: 0,
      mappedRecordVersionCount: 0,
      quarantinedRecordVersionCount: 0,
      mismatchCount: 0,
      emptyBackfill: true,
      ok: true,
    });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });
});
