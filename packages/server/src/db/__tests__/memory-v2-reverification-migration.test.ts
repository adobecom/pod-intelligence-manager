import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { runSchemaMigrations } from "../migrations.js";

const NOW = "2026-08-10T12:00:00.000Z";
const LATER = "2026-08-10T12:01:00.000Z";
const LEASE_EXPIRES = "2026-08-10T12:02:00.000Z";
const CUTOVER_LOCKED_AT = "2026-08-10T11:58:00.000Z";
const CUTOVER_DECIDED_AT = "2026-08-10T11:59:00.000Z";
const DIGEST = `sha256:${"a".repeat(64)}`;

const REVERIFICATION_TABLES = [
  "memory_v2_record_trust",
  "memory_v2_reverification_policies",
  "memory_v2_reverification_state",
  "memory_v2_reverification_decisions",
  "memory_v2_reverification_jobs",
  "memory_v2_reverification_job_attempts",
] as const;

const MIGRATION_008_TABLES = [
  "memory_harness_principal_bindings",
  "memory_records",
  "memory_retrieval_packs",
  "memory_applicability_indexes",
] as const;

function fixture(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE orgs (org_id TEXT PRIMARY KEY);
    CREATE TABLE projects (
      project_id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES orgs(org_id)
    );
    CREATE TABLE service_principals (
      service_principal_id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES orgs(org_id),
      disabled_at TEXT
    );
    CREATE TABLE service_tokens (
      token_id TEXT PRIMARY KEY,
      service_principal_id TEXT NOT NULL REFERENCES service_principals(service_principal_id),
      scopes_json TEXT NOT NULL,
      project_id TEXT REFERENCES projects(project_id)
    );

    INSERT INTO orgs VALUES ('org-a'), ('org-b');
    INSERT INTO projects VALUES ('project-a', 'org-a'), ('project-b', 'org-b');
  `);
  return database;
}

function schemaSnapshot(database: DatabaseSync, tableNames: readonly string[]): unknown[] {
  const placeholders = tableNames.map(() => "?").join(", ");
  return database.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_schema
    WHERE tbl_name IN (${placeholders})
      AND sql IS NOT NULL
    ORDER BY type, name
  `).all(...tableNames);
}

function seedMappedRecord(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO memory_authority_transitions (
      transition_id, revision, from_authority, to_authority,
      legacy_writes_frozen, import_run_id, actor_id, reason_code, occurred_at
    ) VALUES
      ('authority-lock', 1, 'legacy', 'migration_locked', 1, NULL,
       'migration-test', 'offline_migration_started', '${CUTOVER_LOCKED_AT}'),
      ('authority-canonical', 2, 'migration_locked', 'canonical', 1, NULL,
       'migration-test', 'offline_migration_reconciled', '${CUTOVER_DECIDED_AT}');

    INSERT INTO memory_repository_registry (
      repository_row_id, org_id, project_id, provider, provider_repository_id,
      repository_id, display_slug, valid_from, valid_until, created_at, updated_at
    ) VALUES (
      'repo-row-a', 'org-a', 'project-a', 'github', 'provider-repo-a',
      'github.com/acme/repo-a', 'acme/repo-a', '${NOW}', NULL, '${NOW}', '${NOW}'
    );

    INSERT INTO memory_records (
      record_id, org_id, project_id, repository_row_id, harness_id, plane, kind,
      current_version, current_status, aggregate_version, shadow_recall_eligible,
      prompt_eligible, claim_key, valid_from, valid_until, expires_at, created_at, updated_at
    ) VALUES (
      'record-a', 'org-a', 'project-a', 'repo-row-a', NULL, 'codebase', 'decision',
      1, 'active', 1, 1, 1, 'claim-a', '${NOW}', NULL, NULL, '${NOW}', '${NOW}'
    );

    INSERT INTO memory_record_versions (
      record_id, record_version, content_json, applicability_json, exceptions_json,
      compatibility_json, validation_json, evidence_json, evidence_summary_json,
      freshness_json, provenance_json, embedding_json, content_digest, recorded_at
    ) VALUES (
      'record-a', 1, '{"summary":"migration 017"}',
      '{"repository_id":"github.com/acme/repo-a"}', '[]', '{}', '{}', '[]', '{}',
      '{}', '{}', NULL, '${DIGEST}', '${NOW}'
    );

    INSERT INTO memory_v2_resources (
      resource_row_id, org_id, project_id, plane, resource_type,
      canonical_resource_id, display_label, provider, provider_resource_id,
      classification, retention_reference, source_authority, source_row_id,
      valid_from, valid_until, created_at, updated_at
    ) VALUES (
      'resource-a', 'org-a', 'project-a', 'codebase', 'repository',
      'github.com/acme/repo-a', 'acme/repo-a', 'github', 'provider-repo-a',
      'internal', NULL, 'memory_repository_registry', 'repo-row-a',
      '${NOW}', NULL, '${NOW}', '${NOW}'
    );

    INSERT INTO memory_v2_record_facets (
      record_id, record_version, org_id, project_id, plane, resource_row_id,
      broad_kind, subtype, projection_status, facet_json, created_at
    ) VALUES (
      'record-a', 1, 'org-a', 'project-a', 'codebase', 'resource-a',
      'decision', NULL, 'mapped', '{"projection":"v2"}', '${NOW}'
    );
  `);
}

function seedReverificationGraph(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO memory_v2_reverification_policies (
      policy_id, record_id, record_version, org_id, project_id, plane,
      resource_row_id, resolver_type, policy_revision, interval_seconds,
      max_age_seconds, max_attempts, active, policy_digest, created_by, created_at
    ) VALUES (
      'policy-a', 'record-a', 1, 'org-a', 'project-a', 'codebase',
      'resource-a', 'github', 1, 60, 600, 3, 1,
      '${DIGEST}', 'migration-test', '${NOW}'
    );

    INSERT INTO memory_v2_reverification_state (
      record_id, record_version, org_id, project_id, plane, resource_row_id,
      policy_id, policy_revision, state_version, status, influence_eligible,
      last_verified_at, next_reverify_at, last_attempt_at, consecutive_failures,
      last_error_code, latest_decision_id, updated_at
    ) VALUES (
      'record-a', 1, 'org-a', 'project-a', 'codebase', 'resource-a',
      'policy-a', 1, 1, 'due', 1, '${NOW}', '${LATER}', NULL,
      0, NULL, NULL, '${NOW}'
    );

    INSERT INTO memory_v2_reverification_jobs (
      job_id, record_id, record_version, org_id, project_id, plane,
      resource_row_id, policy_id, policy_revision, expected_state_version,
      scheduled_for, status, attempt_count, max_attempts, next_attempt_at,
      lease_owner, lease_expires_at, last_error_code, created_at, updated_at,
      completed_at, dead_lettered_at
    ) VALUES (
      'job-a', 'record-a', 1, 'org-a', 'project-a', 'codebase',
      'resource-a', 'policy-a', 1, 1, '${LATER}', 'pending', 0, 3, '${LATER}',
      NULL, NULL, NULL, '${NOW}', '${NOW}', NULL, NULL
    );

    UPDATE memory_v2_reverification_jobs
    SET status = 'leased', attempt_count = 1, lease_owner = 'worker-a',
        lease_expires_at = '${LEASE_EXPIRES}', updated_at = '${LATER}'
    WHERE job_id = 'job-a';

    INSERT INTO memory_v2_reverification_decisions (
      decision_id, job_id, record_id, record_version, org_id, project_id, plane,
      resource_row_id, policy_id, policy_revision, expected_state_version,
      committed_state_version, from_status, to_status, provider_outcome,
      reason_code, evidence_digest, source_occurred_at, canonical_from_status,
      canonical_to_status, attempted_at, decided_at, decision_digest, created_at
    ) VALUES (
      'decision-a', 'job-a', 'record-a', 1, 'org-a', 'project-a', 'codebase',
      'resource-a', 'policy-a', 1, 1, 2, 'due', 'pending', 'unavailable',
      'provider_unavailable', NULL, NULL, 'active', 'active',
      '${LATER}', '${LATER}', '${DIGEST}', '${LATER}'
    );

    UPDATE memory_v2_reverification_state
    SET state_version = 2, status = 'pending', influence_eligible = 1,
        last_attempt_at = '${LATER}',
        consecutive_failures = 1, last_error_code = 'provider_unavailable',
        latest_decision_id = 'decision-a', updated_at = '${LATER}'
    WHERE record_id = 'record-a' AND record_version = 1;

    UPDATE memory_v2_reverification_jobs
    SET expected_state_version = 2, status = 'pending', lease_owner = NULL,
        lease_expires_at = NULL, next_attempt_at = '${LEASE_EXPIRES}',
        last_error_code = 'provider_unavailable', updated_at = '${LATER}'
    WHERE job_id = 'job-a';

    INSERT INTO memory_v2_reverification_job_attempts (
      attempt_id, job_id, attempt_number, worker_id, outcome,
      error_code, started_at, completed_at
    ) VALUES (
      'attempt-a', 'job-a', 1, 'worker-a', 'retry',
      'provider_unavailable', '${LATER}', '${LATER}'
    );
  `);
}

function insertPendingJob(
  database: DatabaseSync,
  jobId: string,
  scheduledFor: string,
): void {
  database.prepare(`
    INSERT INTO memory_v2_reverification_jobs (
      job_id, record_id, record_version, org_id, project_id, plane,
      resource_row_id, policy_id, policy_revision, expected_state_version,
      scheduled_for, status, attempt_count, max_attempts, next_attempt_at,
      lease_owner, lease_expires_at, last_error_code, created_at, updated_at,
      completed_at, dead_lettered_at
    ) VALUES (
      ?, 'record-a', 1, 'org-a', 'project-a', 'codebase',
      'resource-a', 'policy-a', 1, 2, ?, 'pending', 0, 3, ?,
      NULL, NULL, NULL, ?, ?, NULL, NULL
    )
  `).run(jobId, scheduledFor, scheduledFor, NOW, NOW);
}

function insertDecision(
  database: DatabaseSync,
  decisionId: string,
  providerOutcome: string,
  toStatus: string,
  canonicalToStatus: string,
): void {
  database.prepare(`
    INSERT INTO memory_v2_reverification_decisions (
      decision_id, job_id, record_id, record_version, org_id, project_id, plane,
      resource_row_id, policy_id, policy_revision, expected_state_version,
      committed_state_version, from_status, to_status, provider_outcome,
      reason_code, evidence_digest, source_occurred_at, canonical_from_status,
      canonical_to_status, attempted_at, decided_at, decision_digest, created_at
    ) VALUES (
      ?, 'job-a', 'record-a', 1, 'org-a', 'project-a', 'codebase',
      'resource-a', 'policy-a', 1, 2, 3, 'pending', ?, ?,
      'negative-test', NULL, NULL, 'active', ?, ?, ?, ?, ?
    )
  `).run(
    decisionId,
    toStatus,
    providerOutcome,
    canonicalToStatus,
    LATER,
    LATER,
    DIGEST,
    LATER,
  );
}

describe("memory v2 reverification migration", () => {
  it("adds only the six trust/reverification tables and leaves migration 008 schema objects byte-for-byte unchanged", () => {
    const database = fixture();
    runSchemaMigrations(database, { throughVersion: 16 });
    const migration008Before = schemaSnapshot(database, MIGRATION_008_TABLES);
    const tablesBefore = new Set((database.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table'",
    ).all() as unknown as Array<{ name: string }>).map((row) => row.name));

    runSchemaMigrations(database, { throughVersion: 17 });

    const tablesAfter = new Set((database.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table'",
    ).all() as unknown as Array<{ name: string }>).map((row) => row.name));
    const added = [...tablesAfter].filter((name) => !tablesBefore.has(name)).sort();
    expect(added).toEqual([...REVERIFICATION_TABLES].sort());
    expect(schemaSnapshot(database, MIGRATION_008_TABLES)).toEqual(migration008Before);
    expect(database.prepare(
      "SELECT version, name FROM schema_migrations WHERE version = 17",
    ).get()).toEqual({ version: 17, name: "memory_v2_reverification" });
    const policyColumns = (database.prepare(
      "SELECT name FROM pragma_table_info('memory_v2_reverification_policies') ORDER BY cid",
    ).all() as unknown as Array<{ name: string }>).map((row) => row.name);
    const stateColumns = (database.prepare(
      "SELECT name FROM pragma_table_info('memory_v2_reverification_state') ORDER BY cid",
    ).all() as unknown as Array<{ name: string }>).map((row) => row.name);
    expect(policyColumns).not.toContain("grace_failure_status");
    expect(policyColumns).not.toContain("grace_period_seconds");
    expect(stateColumns).not.toContain("pending_since");
    expect(stateColumns).not.toContain("grace_expires_at");
    const stateSchema = database.prepare(`
      SELECT sql FROM sqlite_schema
      WHERE type = 'table' AND name = 'memory_v2_reverification_state'
    `).get() as { sql: string };
    expect(stateSchema.sql).not.toContain("failed_closed");
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();
  });

  it("enforces scope/version integrity and immutable audit history", () => {
    const database = fixture();
    runSchemaMigrations(database, { throughVersion: 16 });
    seedMappedRecord(database);
    runSchemaMigrations(database, { throughVersion: 17 });
    expect(database.prepare(`
      SELECT trust_status, trust_basis, cutover_decided_at, evidence_verified_at,
             created_at, updated_at
      FROM memory_v2_record_trust
      WHERE record_id = 'record-a' AND record_version = 1
    `).get()).toEqual({
      trust_status: "trusted",
      trust_basis: "legacy_cutover",
      cutover_decided_at: CUTOVER_DECIDED_AT,
      evidence_verified_at: null,
      created_at: CUTOVER_DECIDED_AT,
      updated_at: CUTOVER_DECIDED_AT,
    });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM memory_v2_reverification_policies",
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM memory_v2_reverification_state",
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(`
      SELECT freshness_json, recorded_at FROM memory_record_versions
      WHERE record_id = 'record-a' AND record_version = 1
    `).get()).toEqual({ freshness_json: "{}", recorded_at: NOW });
    expect(() => database.exec(`
      UPDATE memory_v2_record_trust
      SET trust_basis = 'evidence_verified', cutover_decided_at = NULL,
          evidence_verified_at = '${NOW}', updated_at = '${NOW}'
      WHERE record_id = 'record-a' AND record_version = 1
    `)).toThrow(/trust identity is immutable/);
    seedReverificationGraph(database);

    expect(() => database.exec(
      "UPDATE memory_v2_reverification_policies SET active = 0 WHERE policy_id = 'policy-a'",
    )).toThrow(/append-only/);
    expect(() => database.exec(
      "DELETE FROM memory_v2_reverification_policies WHERE policy_id = 'policy-a'",
    )).toThrow(/append-only/);
    expect(() => database.exec(`
      UPDATE memory_v2_reverification_state
      SET state_version = 4, updated_at = '${LEASE_EXPIRES}'
      WHERE record_id = 'record-a' AND record_version = 1
    `)).toThrow(/state update mismatch/);
    expect(() => database.exec(`
      INSERT INTO memory_v2_reverification_jobs (
        job_id, record_id, record_version, org_id, project_id, plane,
        resource_row_id, policy_id, policy_revision, expected_state_version,
        scheduled_for, status, attempt_count, max_attempts, next_attempt_at,
        created_at, updated_at
      ) VALUES (
        'job-cross-scope', 'record-a', 1, 'org-b', 'project-b', 'codebase',
        'resource-a', 'policy-a', 1, 2, '${LEASE_EXPIRES}', 'pending', 0, 3,
        '${LEASE_EXPIRES}', '${LATER}', '${LATER}'
      )
    `)).toThrow(/job binding mismatch/);
    expect(() => database.exec(
      "UPDATE memory_v2_reverification_decisions SET reason_code = 'changed' WHERE decision_id = 'decision-a'",
    )).toThrow(/immutable/);
    expect(() => database.exec(
      "DELETE FROM memory_v2_reverification_decisions WHERE decision_id = 'decision-a'",
    )).toThrow(/immutable/);
    expect(() => database.exec(
      "UPDATE memory_v2_reverification_jobs SET record_id = 'other' WHERE job_id = 'job-a'",
    )).toThrow(/identity is immutable/);
    expect(() => database.exec(
      "DELETE FROM memory_v2_reverification_jobs WHERE job_id = 'job-a'",
    )).toThrow(/cannot be deleted/);
    expect(() => database.exec(
      "UPDATE memory_v2_reverification_job_attempts SET worker_id = 'other' WHERE attempt_id = 'attempt-a'",
    )).toThrow(/immutable/);
    expect(() => database.exec(
      "DELETE FROM memory_v2_reverification_job_attempts WHERE attempt_id = 'attempt-a'",
    )).toThrow(/immutable/);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();
  });

  it("rejects decision outcomes whose state or canonical lifecycle mapping is invalid", () => {
    const database = fixture();
    runSchemaMigrations(database, { throughVersion: 16 });
    seedMappedRecord(database);
    runSchemaMigrations(database, { throughVersion: 17 });
    seedReverificationGraph(database);

    expect(database.prepare(`
      SELECT status, influence_eligible, consecutive_failures, last_error_code
      FROM memory_v2_reverification_state
      WHERE record_id = 'record-a' AND record_version = 1
    `).get()).toEqual({
      status: "pending",
      influence_eligible: 1,
      consecutive_failures: 1,
      last_error_code: "provider_unavailable",
    });
    expect(() => database.exec(`
      UPDATE memory_v2_reverification_state
      SET state_version = 3, influence_eligible = 0, updated_at = '${LEASE_EXPIRES}'
      WHERE record_id = 'record-a' AND record_version = 1
    `)).toThrow(/CHECK constraint failed/);

    expect(() => insertDecision(
      database,
      "decision-verified-state-mismatch",
      "verified",
      "pending",
      "active",
    )).toThrow(/decision lifecycle mapping mismatch/);
    expect(() => insertDecision(
      database,
      "decision-verified-canonical-mismatch",
      "verified",
      "fresh",
      "stale",
    )).toThrow(/decision lifecycle mapping mismatch/);
    expect(() => insertDecision(
      database,
      "decision-unavailable-state-mismatch",
      "unavailable",
      "fresh",
      "active",
    )).toThrow(/decision lifecycle mapping mismatch/);
    expect(() => insertDecision(
      database,
      "decision-unavailable-canonical-mismatch",
      "unavailable",
      "pending",
      "stale",
    )).toThrow(/decision lifecycle mapping mismatch/);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM memory_v2_reverification_decisions",
    ).get()).toEqual({ count: 1 });
    database.close();
  });

  it("enforces monotonic attempts, terminal jobs, and terminal timestamp ownership", () => {
    const database = fixture();
    runSchemaMigrations(database, { throughVersion: 16 });
    seedMappedRecord(database);
    runSchemaMigrations(database, { throughVersion: 17 });
    seedReverificationGraph(database);

    insertPendingJob(database, "job-completed", "2026-08-10T12:03:00.000Z");
    database.exec(`
      UPDATE memory_v2_reverification_jobs
      SET status = 'leased', attempt_count = 1, lease_owner = 'worker-completed',
          lease_expires_at = '2026-08-10T12:04:00.000Z', updated_at = '${LATER}'
      WHERE job_id = 'job-completed';
      UPDATE memory_v2_reverification_jobs
      SET status = 'completed', lease_owner = NULL, lease_expires_at = NULL,
          completed_at = '2026-08-10T12:04:00.000Z', updated_at = '${LATER}'
      WHERE job_id = 'job-completed';
    `);
    expect(() => database.exec(`
      UPDATE memory_v2_reverification_jobs
      SET status = 'pending', completed_at = NULL, next_attempt_at = '${LATER}'
      WHERE job_id = 'job-completed'
    `)).toThrow(/terminal job is immutable/);

    insertPendingJob(database, "job-dead-letter", "2026-08-10T12:05:00.000Z");
    database.exec(`
      UPDATE memory_v2_reverification_jobs
      SET status = 'dead_letter', last_error_code = 'attempts_exhausted',
          dead_lettered_at = '2026-08-10T12:06:00.000Z', updated_at = '${LATER}'
      WHERE job_id = 'job-dead-letter'
    `);
    expect(() => database.exec(`
      UPDATE memory_v2_reverification_jobs
      SET status = 'pending', last_error_code = NULL, dead_lettered_at = NULL
      WHERE job_id = 'job-dead-letter'
    `)).toThrow(/terminal job is immutable/);

    insertPendingJob(database, "job-attempt-jump", "2026-08-10T12:07:00.000Z");
    expect(() => database.exec(`
      UPDATE memory_v2_reverification_jobs
      SET status = 'leased', attempt_count = 2, lease_owner = 'worker-jump',
          lease_expires_at = '2026-08-10T12:08:00.000Z', updated_at = '${LATER}'
      WHERE job_id = 'job-attempt-jump'
    `)).toThrow(/attempt transition mismatch/);

    insertPendingJob(database, "job-attempt-regress", "2026-08-10T12:09:00.000Z");
    database.exec(`
      UPDATE memory_v2_reverification_jobs
      SET status = 'leased', attempt_count = 1, lease_owner = 'worker-regress',
          lease_expires_at = '2026-08-10T12:10:00.000Z', updated_at = '${LATER}'
      WHERE job_id = 'job-attempt-regress'
    `);
    expect(() => database.exec(`
      UPDATE memory_v2_reverification_jobs
      SET status = 'pending', attempt_count = 0, lease_owner = NULL,
          lease_expires_at = NULL, next_attempt_at = '${LATER}'
      WHERE job_id = 'job-attempt-regress'
    `)).toThrow(/attempt transition mismatch/);

    insertPendingJob(database, "job-terminal-timestamp", "2026-08-10T12:11:00.000Z");
    database.exec(`
      UPDATE memory_v2_reverification_jobs
      SET status = 'leased', attempt_count = 1, lease_owner = 'worker-timestamp',
          lease_expires_at = '2026-08-10T12:12:00.000Z', updated_at = '${LATER}'
      WHERE job_id = 'job-terminal-timestamp'
    `);
    expect(() => database.exec(`
      UPDATE memory_v2_reverification_jobs
      SET completed_at = '2026-08-10T12:12:00.000Z'
      WHERE job_id = 'job-terminal-timestamp'
    `)).toThrow(/CHECK constraint failed/);
    expect(() => database.exec(`
      UPDATE memory_v2_reverification_jobs
      SET dead_lettered_at = '2026-08-10T12:12:00.000Z'
      WHERE job_id = 'job-terminal-timestamp'
    `)).toThrow(/CHECK constraint failed/);

    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();
  });

  it("replays 017 idempotently without changing its immutable ledger or schema", () => {
    const database = fixture();
    runSchemaMigrations(database, { throughVersion: 17 });
    const ledgerBefore = database.prepare(
      "SELECT version, name, checksum FROM schema_migrations WHERE version = 17",
    ).get();
    const schemaBefore = schemaSnapshot(database, REVERIFICATION_TABLES);

    runSchemaMigrations(database, { throughVersion: 17 });

    expect(database.prepare(
      "SELECT version, name, checksum FROM schema_migrations WHERE version = 17",
    ).get()).toEqual(ledgerBefore);
    expect(schemaSnapshot(database, REVERIFICATION_TABLES)).toEqual(schemaBefore);
    database.close();
  });
});
