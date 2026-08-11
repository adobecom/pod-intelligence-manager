import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { memorySchemaMigrationCount, runSchemaMigrations } from "../migrations.js";

const SHA256_A = `sha256:${"a".repeat(64)}`;
const SHA256_B = `sha256:${"b".repeat(64)}`;
const SHA256_C = `sha256:${"c".repeat(64)}`;

function migrationDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE orgs (org_id TEXT PRIMARY KEY);
    CREATE TABLE projects (project_id TEXT PRIMARY KEY);
    CREATE TABLE service_principals (
      service_principal_id TEXT PRIMARY KEY,
      org_id TEXT
    );
    CREATE TABLE service_tokens (
      token_id TEXT PRIMARY KEY,
      service_principal_id TEXT,
      scopes_json TEXT NOT NULL DEFAULT '[]',
      project_id TEXT
    );
  `);
  return database;
}

describe("numbered memory schema migrations", () => {
  it("records an immutable migration exactly once and fails on checksum drift", () => {
    const database = migrationDatabase();
    database.exec("PRAGMA foreign_keys = ON");
    runSchemaMigrations(database);
    runSchemaMigrations(database);
    const rows = database.prepare("SELECT version, name, checksum FROM schema_migrations").all() as unknown[];
    expect(memorySchemaMigrationCount()).toBe(18);
    expect(rows).toHaveLength(memorySchemaMigrationCount());
    expect(rows[0]).toMatchObject({ version: 1, name: "memory_read_path" });
    expect(rows[1]).toMatchObject({ version: 2, name: "memory_receipt_candidate_ledger" });
    expect(rows[2]).toMatchObject({ version: 3, name: "memory_trust_path" });
    expect(rows[3]).toMatchObject({ version: 4, name: "memory_feedback_review" });
    expect(rows[4]).toMatchObject({ version: 5, name: "memory_prompt_canary" });
    expect(rows[5]).toMatchObject({ version: 6, name: "memory_service_repository_bindings" });
    expect(rows[6]).toMatchObject({ version: 7, name: "memory_inbox_results" });
    expect(rows[7]).toMatchObject({ version: 8, name: "memory_harness_shadow" });
    expect(rows[8]).toMatchObject({ version: 9, name: "memory_offline_legacy_cutover" });
    expect(rows[9]).toMatchObject({ version: 10, name: "memory_retention_erasure" });
    expect(rows[10]).toMatchObject({ version: 11, name: "memory_attestation_diff_proof" });
    expect(rows[11]).toMatchObject({ version: 12, name: "memory_v2_resources" });
    expect(rows[12]).toMatchObject({ version: 13, name: "memory_v2_facets" });
    expect(rows[13]).toMatchObject({ version: 14, name: "memory_v2_retrieval_packs" });
    expect(rows[14]).toMatchObject({ version: 15, name: "memory_v2_scope_feedback" });
    expect(rows[15]).toMatchObject({ version: 16, name: "memory_v2_runtime_origins" });
    expect(rows[16]).toMatchObject({ version: 17, name: "memory_v2_reverification" });
    expect(rows[17]).toMatchObject({ version: 18, name: "memory_experiment_cleanup" });
    expect(database.prepare(
      "SELECT name FROM pragma_table_info('memory_attestations') WHERE name = 'authoritative_diff_digest'",
    ).get()).toEqual({ name: "authoritative_diff_digest" });
    for (const row of rows as Array<{ checksum: string }>) {
      expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
    }
    database.prepare("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 1").run();
    expect(() => runSchemaMigrations(database)).toThrow(/immutable checksum/);
    database.close();
  });

  it("installs append-only retention, legal-hold, erasure, and tombstone controls", () => {
    const database = migrationDatabase();
    runSchemaMigrations(database);
    const names = new Set((database.prepare(
      `SELECT name FROM sqlite_schema
       WHERE type = 'table' AND name LIKE 'memory_%'`,
    ).all() as unknown as Array<{ name: string }>).map((row) => row.name));
    for (const table of [
      "memory_retention_policy_versions",
      "memory_legal_hold_events",
      "memory_erasure_requests",
      "memory_erasure_events",
      "memory_erasure_tombstones",
    ]) expect(names.has(table)).toBe(true);

    database.exec("PRAGMA foreign_keys = OFF");
    const digest = `sha256:${"a".repeat(64)}`;
    database.prepare(
      `INSERT INTO memory_retention_policy_versions
         (policy_version_id, org_id, project_id, data_class, revision, retention_days,
          policy_digest, actor_digest, reason_code, effective_at, created_at)
       VALUES ('policy-1', 'org-1', NULL, 'record', 1, 30, ?, ?, 'retention',
               '2026-08-03T00:00:00.000Z', '2026-08-03T00:00:00.000Z')`,
    ).run(digest, digest);
    expect(() => database.prepare(
      "UPDATE memory_retention_policy_versions SET retention_days = 31 WHERE policy_version_id = 'policy-1'",
    ).run()).toThrow(/append-only/);
    expect(() => database.prepare(
      `INSERT INTO memory_retention_policy_versions
         (policy_version_id, org_id, project_id, data_class, revision, retention_days,
          policy_digest, actor_digest, reason_code, effective_at, created_at)
       VALUES ('policy-3', 'org-1', NULL, 'record', 3, 30, ?, ?, 'retention',
               '2026-08-03T00:00:00.000Z', '2026-08-03T00:00:00.000Z')`,
    ).run(digest, digest)).toThrow(/contiguous/);
    database.close();
  });

  it("installs the receipt, candidate, evidence, feedback, and durable outbox ledger", () => {
    const database = migrationDatabase();
    runSchemaMigrations(database);
    const expected = [
      "memory_run_receipts",
      "memory_candidates_v1",
      "memory_evidence_manifests",
      "memory_evidence_refs",
      "memory_candidate_evidence",
      "memory_feedback",
      "memory_outbox",
      "memory_outbox_attempts",
      "memory_dead_letters",
    ];
    const rows = database.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name LIKE 'memory_%'`,
    ).all() as unknown as Array<{ name: string }>;
    const names = new Set(rows.map((row) => row.name));
    for (const table of expected) expect(names.has(table)).toBe(true);
    database.close();
  });

  it("enforces append-only lifecycle transitions in storage", () => {
    const database = migrationDatabase();
    runSchemaMigrations(database);
    database.exec("PRAGMA foreign_keys = OFF");
    database.prepare(
      `INSERT INTO memory_transitions
         (transition_id, org_id, project_id, aggregate_type, aggregate_id, from_status,
          to_status, actor_type, actor_id, reason_code, explanation, evidence_refs_json,
          decision_refs_json, policy_version, occurred_at, committed_at)
       VALUES ('transition-1', 'org-1', 'project-1', 'record', 'record-1', NULL,
               'active', 'system', 'seed', 'seeded', 'seeded', '[]', '[]',
               'policy-v1', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')`,
    ).run();
    expect(() => database.prepare(
      "UPDATE memory_transitions SET to_status = 'revoked' WHERE transition_id = 'transition-1'",
    ).run()).toThrow(/append-only/);
    expect(() => database.prepare(
      "DELETE FROM memory_transitions WHERE transition_id = 'transition-1'",
    ).run()).toThrow(/append-only/);
    database.prepare(
      `INSERT INTO memory_record_versions
         (record_id, record_version, content_json, applicability_json, exceptions_json,
          compatibility_json, validation_json, evidence_json, evidence_summary_json,
          freshness_json, provenance_json, embedding_json, content_digest, recorded_at)
       VALUES ('record-1', 1, '{}', '{}', '[]', '{}', '{}', '[]', '{}', '{}',
               '{}', NULL, 'sha256:test', '2026-08-01T00:00:00Z')`,
    ).run();
    expect(() => database.prepare(
      "UPDATE memory_record_versions SET content_json = '{\"changed\":true}' WHERE record_id = 'record-1'",
    ).run()).toThrow(/immutable/);
    database.close();
  });

  it("installs the trusted provider inbox, attestation, origin, and reconciliation schema", () => {
    const database = migrationDatabase();
    runSchemaMigrations(database);
    const expected = [
      "memory_attestations",
      "memory_origins",
      "memory_inbox",
      "memory_provider_cursors",
      "memory_activation_claims",
      "memory_record_supersessions",
    ];
    const rows = database.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name LIKE 'memory_%'`,
    ).all() as unknown as Array<{ name: string }>;
    const names = new Set(rows.map((row) => row.name));
    for (const table of expected) expect(names.has(table)).toBe(true);

    const recordColumns = database.prepare("PRAGMA table_info(memory_records)").all() as unknown as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    expect(recordColumns.find((column) => column.name === "aggregate_version")).toMatchObject({
      notnull: 1,
      dflt_value: "1",
    });
    expect(recordColumns.find((column) => column.name === "shadow_recall_eligible")).toMatchObject({
      notnull: 1,
      dflt_value: "1",
    });
    const inboxColumns = database.prepare("PRAGMA table_info(memory_inbox)").all() as unknown as Array<{
      name: string;
    }>;
    expect(inboxColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "response_json",
      "last_replayed_at",
    ]));
    database.close();
  });

  it("deduplicates provider deliveries and enforces durable inbox state", () => {
    const database = migrationDatabase();
    runSchemaMigrations(database);
    database.exec("PRAGMA foreign_keys = OFF");
    const insert = database.prepare(
      `INSERT INTO memory_inbox
         (inbox_event_id, org_id, project_id, repository_row_id, provider,
          provider_delivery_id, event_type, payload_digest, payload_json, status,
          next_attempt_at, occurred_at, received_at, updated_at)
       VALUES (?, 'org-1', 'project-1', 'repository-1', 'github', ?, 'github_merge',
               'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
               ?, ?, '2026-08-03T00:00:00Z', '2026-08-03T00:00:00Z',
               '2026-08-03T00:00:00Z', '2026-08-03T00:00:00Z')`,
    );
    insert.run("inbox-1", "delivery-1", "{\"delivery\":1}", "pending");
    expect(() => insert.run(
      "inbox-2",
      "delivery-1",
      "{\"delivery\":1}",
      "pending",
    )).toThrow(/UNIQUE/);
    expect(() => database.prepare(
      "UPDATE memory_inbox SET payload_json = '{\"changed\":true}' WHERE inbox_event_id = 'inbox-1'",
    ).run()).toThrow(/immutable/);
    database.prepare(
      `UPDATE memory_inbox SET response_json =
       '{"schema_version":"pim.memory-attestation-result.v1","accepted":true,"duplicate":false,"inbox_event_id":"inbox-1","status":"unmatched","candidate_ids":[],"record_ids":[]}'
       WHERE inbox_event_id = 'inbox-1'`,
    ).run();
    expect(() => database.prepare(
      "UPDATE memory_inbox SET response_json = '{}' WHERE inbox_event_id = 'inbox-1'",
    ).run()).toThrow(/immutable/);
    expect(() => insert.run(
      "inbox-3",
      "delivery-3",
      "{\"delivery\":3}",
      "leased",
    )).toThrow(/CHECK/);
    expect(() => insert.run(
      "inbox-4",
      "delivery-4",
      "{\"delivery\":4}",
      "dead_letter",
    )).toThrow(/CHECK/);
    database.close();
  });

  it("keeps trusted origins unique and activation relationships version-pinned", () => {
    const database = migrationDatabase();
    runSchemaMigrations(database);
    database.exec("PRAGMA foreign_keys = OFF");
    database.prepare(
      `INSERT INTO memory_origins
         (origin_row_id, org_id, project_id, origin_key, source_type, source_identity,
          immutable_digest, source_authority, created_at)
       VALUES ('origin-1', 'org-1', 'project-1', 'github:repo:pr-1:merge',
               'github_attestation', 'delivery-1',
               'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
               'verified', '2026-08-03T00:00:00Z')`,
    ).run();
    expect(() => database.prepare(
      `INSERT INTO memory_origins
         (origin_row_id, org_id, project_id, origin_key, source_type, source_identity,
          immutable_digest, source_authority, created_at)
       VALUES ('origin-2', 'org-1', 'project-1', 'github:repo:pr-1:merge',
               'github_attestation', 'delivery-2',
               'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
               'verified', '2026-08-03T00:00:01Z')`,
    ).run()).toThrow(/UNIQUE/);
    expect(() => database.prepare(
      "UPDATE memory_origins SET source_identity = 'changed' WHERE origin_row_id = 'origin-1'",
    ).run()).toThrow(/immutable/);

    database.prepare(
      `INSERT INTO memory_activation_claims
         (org_id, project_id, repository_row_id, plane, conflict_key,
          aggregate_version, created_at, updated_at)
       VALUES ('org-1', 'project-1', 'repository-1', 'codebase', 'claim-1', 1,
               '2026-08-03T00:00:00Z', '2026-08-03T00:00:00Z')`,
    ).run();
    expect(() => database.prepare(
      `INSERT INTO memory_activation_claims
         (org_id, project_id, repository_row_id, plane, conflict_key,
          aggregate_version, created_at, updated_at)
       VALUES ('org-1', 'project-1', 'repository-1', 'codebase', 'claim-1', 1,
               '2026-08-03T00:00:01Z', '2026-08-03T00:00:01Z')`,
    ).run()).toThrow(/UNIQUE/);
    expect(() => database.prepare(
      `INSERT INTO memory_record_supersessions
         (supersession_id, org_id, project_id, predecessor_record_id,
          predecessor_record_version, successor_record_id, successor_record_version,
          transition_id, created_at)
       VALUES ('supersession-self', 'org-1', 'project-1', 'record-1', 1,
               'record-1', 1, 'transition-1', '2026-08-03T00:00:00Z')`,
    ).run()).toThrow(/CHECK/);
    database.close();
  });

  it("installs append-only review decisions and stale/harmful review queues", () => {
    const database = migrationDatabase();
    runSchemaMigrations(database);
    const names = new Set((database.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'memory_%'`,
    ).all() as unknown as Array<{ name: string }>).map((row) => row.name));
    expect(names.has("memory_candidate_decisions")).toBe(true);
    expect(names.has("memory_review_signals")).toBe(true);

    database.exec("PRAGMA foreign_keys = OFF");
    database.prepare(
      `INSERT INTO memory_candidate_decisions
         (decision_id, org_id, project_id, candidate_id, reviewer_principal_id,
          decision_revision, decision, reason_code, explanation, decision_digest,
          decision_json, response_json, created_at)
       VALUES ('decision-1', 'org-1', 'project-1', 'candidate-1', 'reviewer-1',
               1, 'approve', 'reviewed', NULL, 'sha256:test', '{}', '{}',
               '2026-08-03T00:00:00Z')`,
    ).run();
    expect(() => database.prepare(
      "UPDATE memory_candidate_decisions SET decision = 'reject' WHERE decision_id = 'decision-1'",
    ).run()).toThrow(/append-only/);
    database.close();
  });

  it("retains immutable legacy columns while removing the empty experiment tables", () => {
    const database = migrationDatabase();
    runSchemaMigrations(database);
    const recordColumns = database.prepare("PRAGMA table_info(memory_records)").all() as unknown as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    expect(recordColumns.find((column) => column.name === "prompt_eligible")).toMatchObject({
      notnull: 1,
      dflt_value: "0",
    });
    const packColumns = database.prepare("PRAGMA table_info(memory_retrieval_packs)").all() as unknown as Array<{
      name: string;
      dflt_value: string | null;
    }>;
    expect(packColumns.find((column) => column.name === "evaluation_arm")?.dflt_value).toBe("'shadow'");
    expect(packColumns.find((column) => column.name === "prompt_item_count")?.dflt_value).toBe("0");

    expect(database.prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'memory_prompt_policies'",
    ).get()).toBeUndefined();
    expect(database.prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'memory_release_gate_decisions'",
    ).get()).toBeUndefined();
    database.close();
  });

  it("installs immutable service-token repository bindings without widening legacy tokens", () => {
    const database = migrationDatabase();
    runSchemaMigrations(database);
    expect(database.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name = 'memory_service_token_repository_bindings'`,
    ).get()).toBeDefined();
    database.exec("PRAGMA foreign_keys = OFF");
    database.prepare(
      `INSERT INTO memory_service_token_repository_bindings
         (binding_id, token_id, service_principal_id, org_id, project_id,
          repository_row_id, repository_id, created_at)
       VALUES ('binding-1', 'token-1', 'principal-1', 'org-1', 'project-1',
               'repository-1', 'github.com/acme/checkout', '2026-08-03T00:00:00Z')`,
    ).run();
    expect(() => database.prepare(
      `UPDATE memory_service_token_repository_bindings
       SET repository_id = 'github.com/acme/other' WHERE binding_id = 'binding-1'`,
    ).run()).toThrow(/immutable/);
    database.close();
  });

  it("rebuilds canonical record and pack tables without losing version-pinned dependents", () => {
    const database = migrationDatabase();
    database.exec(`
      PRAGMA foreign_keys = ON;
      INSERT INTO orgs VALUES ('org-1');
      INSERT INTO projects VALUES ('project-1');
    `);
    runSchemaMigrations(database, { throughVersion: 7 });
    database.exec(`
      INSERT INTO memory_repository_registry
        (repository_row_id, org_id, project_id, provider, provider_repository_id,
         repository_id, display_slug, valid_from, valid_until, created_at, updated_at)
      VALUES ('repo-row-1', 'org-1', 'project-1', 'github', 'provider-1',
              'github.com/acme/repo', 'Acme/Repo', '2026-08-01T00:00:00Z', NULL,
              '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');

      INSERT INTO memory_records
        (record_id, org_id, project_id, repository_row_id, plane, kind, current_version,
         current_status, aggregate_version, shadow_recall_eligible, prompt_eligible,
         claim_key, valid_from, valid_until, expires_at, created_at, updated_at)
      VALUES
        ('record-1', 'org-1', 'project-1', 'repo-row-1', 'codebase', 'constraint', 1,
         'active', 1, 1, 0, 'claim-1', '2026-08-01T00:00:00Z', NULL, NULL,
         '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z'),
        ('record-2', 'org-1', 'project-1', 'repo-row-1', 'codebase', 'constraint', 1,
         'active', 1, 1, 0, 'claim-2', '2026-08-01T00:00:00Z', NULL, NULL,
         '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');

      INSERT INTO memory_record_versions
        (record_id, record_version, content_json, applicability_json, exceptions_json,
         compatibility_json, validation_json, evidence_json, evidence_summary_json,
         freshness_json, provenance_json, embedding_json, content_digest, recorded_at)
      VALUES
        ('record-1', 1, '{"summary":"one"}', '{"repository_id":"github.com/acme/repo"}',
         '[]', '{}', '{}', '[]', '{}', '{}', '{}', NULL, 'sha256:one', '2026-08-01T00:00:00Z'),
        ('record-2', 1, '{"summary":"two"}', '{"repository_id":"github.com/acme/repo"}',
         '[]', '{}', '{}', '[]', '{}', '{}', '{}', NULL, 'sha256:two', '2026-08-01T00:00:00Z');

      INSERT INTO memory_applicability_indexes
        (record_id, record_version, selector_type, selector_value)
      VALUES ('record-1', 1, 'repository', 'github.com/acme/repo');
      INSERT INTO memory_record_versions_fts (record_key, summary, details, selectors)
      VALUES ('record-1:1', 'one', 'preserved details', 'github.com/acme/repo');

      INSERT INTO memory_retrieval_packs
        (retrieval_pack_id, org_id, project_id, request_id, request_digest,
         repository_row_id, repository_id, plane, query, policy_version, ranker_version,
         authorized_scope_json, token_count, omitted_count, response_json, created_at,
         expires_at, consumer_run_id, request_base_sha, prompt_eligible, evaluation_arm,
         prompt_policy_revision, prompt_policy_snapshot_json, prompt_item_count,
         prompt_token_count)
      VALUES ('pack-1', 'org-1', 'project-1', 'request-1', 'sha256:request',
              'repo-row-1', 'github.com/acme/repo', 'codebase', 'preserve', 'policy-v1',
              'ranker-v1', '{}', 12, 0, '{}', '2026-08-01T00:00:00Z',
              '2026-08-01T01:00:00Z', 'run-1', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              0, 'shadow', 0, '{}', 0, 0);
      INSERT INTO memory_retrieval_pack_items
        (retrieval_pack_id, item_order, record_id, record_version, token_count,
         rank_score, match_reasons_json, prompt_eligible)
      VALUES ('pack-1', 0, 'record-1', 1, 12, 1.0, '[]', 0);
      INSERT INTO memory_feedback
        (feedback_id, org_id, project_id, receipt_id, producer_run_id, retrieval_pack_id,
         record_id, record_version, feedback_stage, feedback_revision, feedback_json,
         feedback_digest, created_at)
      VALUES ('feedback-1', 'org-1', 'project-1', NULL, 'run-1', 'pack-1',
              'record-1', 1, 'later', 1, '{}', 'sha256:feedback', '2026-08-01T00:00:00Z');
      INSERT INTO memory_activation_claims
        (org_id, project_id, repository_row_id, plane, conflict_key, aggregate_version,
         current_candidate_id, current_record_id, current_record_version, created_at, updated_at)
      VALUES ('org-1', 'project-1', 'repo-row-1', 'codebase', 'conflict-1', 1,
              NULL, 'record-1', 1, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');
      INSERT INTO memory_transitions
        (transition_id, org_id, project_id, aggregate_type, aggregate_id, from_status,
         to_status, actor_type, actor_id, reason_code, explanation, evidence_refs_json,
         decision_refs_json, policy_version, occurred_at, committed_at)
      VALUES ('transition-1', 'org-1', 'project-1', 'record', 'record-2', NULL,
              'active', 'system', 'fixture', 'preserved', 'preserved transition', '[]', '[]',
              'policy-v1', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');
      INSERT INTO memory_record_supersessions
        (supersession_id, org_id, project_id, predecessor_record_id,
         predecessor_record_version, successor_record_id, successor_record_version,
         candidate_id, attestation_row_id, transition_id, created_at)
      VALUES ('supersession-1', 'org-1', 'project-1', 'record-1', 1, 'record-2', 1,
              NULL, NULL, 'transition-1', '2026-08-01T00:00:00Z');
    `);

    runSchemaMigrations(database, { throughVersion: 9 });
    database.exec(`
      INSERT INTO memory_authority_transitions (
        transition_id, revision, from_authority, to_authority,
        legacy_writes_frozen, import_run_id, actor_id, reason_code, occurred_at
      ) VALUES
        ('rebuild-authority-lock', 1, 'legacy', 'migration_locked', 1, NULL,
         'migration-test', 'offline_migration_started', '2026-08-02T23:59:58Z'),
        ('rebuild-authority-canonical', 2, 'migration_locked', 'canonical', 1, NULL,
         'migration-test', 'offline_migration_reconciled', '2026-08-02T23:59:59Z');
    `);
    runSchemaMigrations(database);

    expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare(
      "SELECT record_id, repository_row_id, harness_id, plane FROM memory_records ORDER BY record_id",
    ).all()).toEqual([
      { record_id: "record-1", repository_row_id: "repo-row-1", harness_id: null, plane: "codebase" },
      { record_id: "record-2", repository_row_id: "repo-row-1", harness_id: null, plane: "codebase" },
    ]);
    expect(database.prepare(
      "SELECT retrieval_pack_id, repository_id, harness_id, plane, token_count FROM memory_retrieval_packs",
    ).get()).toEqual({
      retrieval_pack_id: "pack-1",
      repository_id: "github.com/acme/repo",
      harness_id: null,
      plane: "codebase",
      token_count: 12,
    });
    for (const [table, expectedCount] of [
      ["memory_record_versions", 2],
      ["memory_retrieval_pack_items", 1],
      ["memory_feedback", 1],
      ["memory_activation_claims", 1],
      ["memory_record_supersessions", 1],
    ] as const) {
      expect(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get())
        .toMatchObject({ count: expectedCount });
    }
    expect(database.prepare(
      "SELECT summary, details FROM memory_record_versions_fts WHERE record_key = 'record-1:1'",
    ).get()).toEqual({ summary: "one", details: "preserved details" });
    expect(database.prepare("SELECT version, name FROM schema_migrations WHERE version = 8").get())
      .toEqual({ version: 8, name: "memory_harness_shadow" });
    database.close();
  });

  it("installs an immutable, fully reconciled legacy import ledger", () => {
    const database = migrationDatabase();
    runSchemaMigrations(database);
    const legacyTables = database.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name IN (
         'memory_legacy_import_runs',
         'memory_legacy_import_items',
         'memory_authority_transitions'
       ) ORDER BY name`,
    ).all() as Array<{ name: string }>;
    expect(legacyTables.map((row) => row.name)).toEqual([
      "memory_authority_transitions",
      "memory_legacy_import_items",
      "memory_legacy_import_runs",
    ]);
    const itemForeignKeys = database.prepare(
      "PRAGMA foreign_key_list(memory_legacy_import_items)",
    ).all() as Array<{ from: string }>;
    expect(itemForeignKeys.some((foreignKey) =>
      foreignKey.from === "org_id" || foreignKey.from === "project_id"))
      .toBe(false);
    database.exec("PRAGMA foreign_keys = OFF");

    const insertRun = database.prepare(
      `INSERT INTO memory_legacy_import_runs
         (import_run_id, inventory_digest, resolution_digest, source_bundle_digest,
          source_item_count, imported_count, pending_count, quarantined_count,
          deduplicated_count, report_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-08-03T00:00:00Z')`,
    );
    insertRun.run("import-1", SHA256_A, SHA256_B, SHA256_C, 4, 1, 1, 1, 1, "{}");
    expect(() => insertRun.run(
      "import-bad-counts",
      SHA256_A,
      SHA256_B,
      SHA256_C,
      2,
      1,
      1,
      1,
      0,
      "{}",
    )).toThrow(/CHECK/);
    expect(() => insertRun.run(
      "import-bad-digest",
      "sha256:not-a-digest",
      SHA256_B,
      SHA256_C,
      0,
      0,
      0,
      0,
      0,
      "{}",
    )).toThrow(/CHECK/);

    const insertItem = database.prepare(
      `INSERT INTO memory_legacy_import_items
         (import_item_id, import_run_id, source_kind, source_key, legacy_id,
          legacy_node_id, org_id, project_id, plane, graph_version, snapshot_sha256,
          content_digest, source_timestamp, source_payload_json, source_provenance_json,
          mapped_payload_json, disposition, reason_code, canonical_record_id,
          canonical_record_version, duplicate_of_item_id, supersedes_legacy_id, created_at)
       VALUES (?, 'import-1', ?, ?, ?, ?, 'org-1', ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL,
               '2026-08-03T00:00:00Z')`,
    );
    insertItem.run(
      "item-active",
      "graph_node",
      "graph_node:node-1",
      "node-1",
      "node-1",
      "project-1",
      "codebase",
      7,
      SHA256_B,
      SHA256_A,
      "{}",
      "{}",
      "{}",
      "active",
      "validated_active_import",
      "record-1",
      1,
      null,
    );
    insertItem.run(
      "item-pending",
      "project_candidate",
      "project_candidate:candidate-1",
      "candidate-1",
      null,
      "project-1",
      "codebase",
      null,
      null,
      SHA256_A,
      "{}",
      "{}",
      "{}",
      "pending_validation",
      "awaiting_validation",
      null,
      null,
      null,
    );
    insertItem.run(
      "item-quarantined",
      "project_candidate",
      "project_candidate:candidate-2",
      "candidate-2",
      null,
      "project-1",
      null,
      null,
      null,
      SHA256_B,
      "{}",
      "{}",
      null,
      "quarantined",
      "promoted_without_node",
      null,
      null,
      null,
    );
    insertItem.run(
      "item-duplicate",
      "project_evidence",
      "project_evidence:evidence-1",
      "evidence-1",
      null,
      "project-1",
      null,
      null,
      null,
      SHA256_C,
      "{}",
      "{}",
      null,
      "deduplicated",
      "same_content",
      null,
      null,
      "item-pending",
    );

    expect(database.prepare(
      `SELECT disposition, COUNT(*) AS count
       FROM memory_legacy_import_items
       GROUP BY disposition ORDER BY disposition`,
    ).all()).toEqual([
      { disposition: "active", count: 1 },
      { disposition: "deduplicated", count: 1 },
      { disposition: "pending_validation", count: 1 },
      { disposition: "quarantined", count: 1 },
    ]);
    expect(() => insertItem.run(
      "item-invalid-active",
      "agent_candidate",
      "agent_candidate:candidate-3",
      "candidate-3",
      null,
      "project-1",
      "harness",
      null,
      null,
      SHA256_A,
      "{}",
      "{}",
      "{}",
      "active",
      "invalid_active",
      "record-2",
      1,
      null,
    )).toThrow(/CHECK/);
    expect(() => insertItem.run(
      "item-invalid-duplicate",
      "agent_candidate",
      "agent_candidate:candidate-4",
      "candidate-4",
      null,
      "project-1",
      null,
      null,
      null,
      SHA256_A,
      "{}",
      "{}",
      null,
      "deduplicated",
      "missing_duplicate_target",
      null,
      null,
      "missing-item",
    )).toThrow(/same run/);
    expect(() => database.prepare(
      "UPDATE memory_legacy_import_items SET reason_code = 'changed' WHERE import_item_id = 'item-pending'",
    ).run()).toThrow(/immutable/);
    expect(() => database.prepare(
      "DELETE FROM memory_legacy_import_items WHERE import_item_id = 'item-pending'",
    ).run()).toThrow(/immutable/);
    expect(() => database.prepare(
      "UPDATE memory_legacy_import_runs SET report_json = '{}' WHERE import_run_id = 'import-1'",
    ).run()).toThrow(/append-only/);
    expect(() => database.prepare(
      "DELETE FROM memory_legacy_import_runs WHERE import_run_id = 'import-1'",
    ).run()).toThrow(/append-only/);
    database.close();
  });

  it("makes the legacy write freeze monotonic and canonical authority terminal", () => {
    const database = migrationDatabase();
    runSchemaMigrations(database);

    const insertTransition = database.prepare(
      `INSERT INTO memory_authority_transitions
         (transition_id, revision, from_authority, to_authority,
          legacy_writes_frozen, import_run_id, actor_id, reason_code, occurred_at)
       VALUES (?, ?, ?, ?, ?, NULL, 'migration-tool', ?, '2026-08-03T00:00:00Z')`,
    );
    insertTransition.run(
      "authority-1",
      1,
      "legacy",
      "migration_locked",
      1,
      "offline_migration_started",
    );
    expect(() => insertTransition.run(
      "authority-skipped-revision",
      3,
      "migration_locked",
      "canonical",
      1,
      "bad_revision",
    )).toThrow(/contiguous/);
    expect(() => insertTransition.run(
      "authority-wrong-from",
      2,
      "legacy",
      "migration_locked",
      1,
      "stale_authority",
    )).toThrow(/current authority/);
    expect(() => insertTransition.run(
      "authority-unfreeze",
      2,
      "migration_locked",
      "canonical",
      0,
      "unfreeze",
    )).toThrow(/CHECK|unfrozen/);

    insertTransition.run(
      "authority-2",
      2,
      "migration_locked",
      "canonical",
      1,
      "offline_migration_reconciled",
    );
    expect(() => insertTransition.run(
      "authority-rollback",
      3,
      "canonical",
      "legacy",
      0,
      "rollback",
    )).toThrow(/terminal/);
    expect(() => database.prepare(
      "UPDATE memory_authority_transitions SET to_authority = 'legacy' WHERE revision = 2",
    ).run()).toThrow(/append-only/);
    expect(() => database.prepare(
      "DELETE FROM memory_authority_transitions WHERE revision = 2",
    ).run()).toThrow(/append-only/);
    expect(database.prepare(
      `SELECT revision, from_authority, to_authority, legacy_writes_frozen
       FROM memory_authority_transitions ORDER BY revision`,
    ).all()).toEqual([
      {
        revision: 1,
        from_authority: "legacy",
        to_authority: "migration_locked",
        legacy_writes_frozen: 1,
      },
      {
        revision: 2,
        from_authority: "migration_locked",
        to_authority: "canonical",
        legacy_writes_frozen: 1,
      },
    ]);
    database.close();
  });
});
