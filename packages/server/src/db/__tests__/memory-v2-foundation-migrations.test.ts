import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  MEMORY_V2_OFFLINE_CUTOVER_CONFIRMATION,
  MEMORY_V2_OFFLINE_CUTOVER_CONFIRMATION_ENV,
  runSchemaMigrations,
} from "../migrations.js";
import {
  memoryV2OperationsForScopes,
  type ImplementedMemoryV2Plane,
} from "../../services/memory-v2-constants.js";

const NOW = "2026-08-09T00:00:00.000Z";
const LATER = "2026-08-10T00:00:00.000Z";

const OPERATION_PROJECTION_CASES = [
  { plane: "codebase", sourceBindingType: "repository_token_binding", scope: "memory:search" },
  { plane: "codebase", sourceBindingType: "repository_token_binding", scope: "memory:receipt:write" },
  { plane: "codebase", sourceBindingType: "repository_token_binding", scope: "memory:candidate:read" },
  { plane: "codebase", sourceBindingType: "repository_token_binding", scope: "memory:attest" },
  { plane: "codebase", sourceBindingType: "repository_token_binding", scope: "memory:feedback:write" },
  { plane: "codebase", sourceBindingType: "repository_token_binding", scope: "memory:review" },
  { plane: "harness", sourceBindingType: "harness_principal_binding", scope: "memory:harness:search" },
  { plane: "harness", sourceBindingType: "harness_principal_binding", scope: "memory:harness:receipt:write" },
  { plane: "harness", sourceBindingType: "harness_principal_binding", scope: "memory:harness:candidate:read" },
  { plane: "harness", sourceBindingType: "harness_principal_binding", scope: "memory:harness:review" },
] as const satisfies ReadonlyArray<{
  plane: ImplementedMemoryV2Plane;
  sourceBindingType: "repository_token_binding" | "harness_principal_binding";
  scope: string;
}>;

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function rows(database: DatabaseSync, sql: string): unknown[] {
  return database.prepare(sql).all() as unknown[];
}

function count(database: DatabaseSync, table: string): number {
  return Number((database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
}

function v1SchemaDigest(database: DatabaseSync): string {
  return sha256(rows(database, `
    SELECT type, name, tbl_name, sql
    FROM sqlite_schema
    WHERE tbl_name IN (
      'memory_repository_registry','memory_repository_aliases',
      'memory_service_token_repository_bindings','memory_harness_principal_bindings',
      'memory_records','memory_record_versions','memory_candidates_v1',
      'memory_run_receipts','memory_feedback','memory_retrieval_packs'
    )
    ORDER BY type, name
  `));
}

function createThroughVersion11Fixture(): DatabaseSync {
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
      org_id TEXT NOT NULL REFERENCES orgs(org_id)
    );
    CREATE TABLE service_tokens (
      token_id TEXT PRIMARY KEY,
      service_principal_id TEXT NOT NULL REFERENCES service_principals(service_principal_id),
      scopes_json TEXT NOT NULL,
      project_id TEXT
    );

    INSERT INTO orgs VALUES ('org-1');
    INSERT INTO projects VALUES
      ('project-1', 'org-1'),
      ('project-old', 'org-1'),
      ('project-destination', 'org-1');
    INSERT INTO service_principals VALUES ('principal-1', 'org-1');
    INSERT INTO service_tokens VALUES (
      'token-1',
      'principal-1',
      '["memory:search","memory:receipt:write","memory:candidate:read",'
        || '"memory:attest","memory:feedback:write","memory:review","memory:admin",'
        || '"memory:harness:search","memory:harness:receipt:write",'
        || '"memory:harness:candidate:read","memory:harness:review"]',
      'project-1'
    );
  `);
  runSchemaMigrations(database, { throughVersion: 11 });

  database.exec(`
    INSERT INTO memory_repository_registry (
      repository_row_id, org_id, project_id, provider, provider_repository_id,
      repository_id, display_slug, valid_from, valid_until, created_at, updated_at
    ) VALUES (
      'repo-row-1', 'org-1', 'project-1', 'github', 'provider-repo-1',
      'github.com/acme/repo', 'acme/repo', '${NOW}', NULL, '${NOW}', '${NOW}'
    );

    INSERT INTO memory_repository_aliases (
      alias_id, repository_row_id, org_id, project_id, alias_repository_id,
      reason, valid_from, valid_until, created_at
    ) VALUES
      ('alias-rename', 'repo-row-1', 'org-1', 'project-1',
       'github.com/acme/old-name', 'rename', '${NOW}', NULL, '${NOW}'),
      ('alias-transfer-history', 'repo-row-1', 'org-1', 'project-old',
       'github.com/acme/pre-transfer', 'transfer', '${NOW}', '${LATER}', '${NOW}');

    INSERT INTO memory_service_token_repository_bindings (
      binding_id, token_id, service_principal_id, org_id, project_id,
      repository_row_id, repository_id, created_at
    ) VALUES (
      'repository-binding-1', 'token-1', 'principal-1', 'org-1', 'project-1',
      'repo-row-1', 'github.com/acme/old-name', '${NOW}'
    );

    INSERT INTO memory_harness_principal_bindings (
      binding_id, service_principal_id, org_id, project_id, harness_id, created_at
    ) VALUES (
      'harness-binding-1', 'principal-1', 'org-1', 'project-1', 'example-harness-a', '${NOW}'
    );

    INSERT INTO memory_records (
      record_id, org_id, project_id, repository_row_id, harness_id, plane, kind,
      current_version, current_status, aggregate_version, shadow_recall_eligible,
      prompt_eligible, claim_key, valid_from, valid_until, expires_at, created_at, updated_at
    ) VALUES
      ('record-code', 'org-1', 'project-1', 'repo-row-1', NULL, 'codebase', 'decision',
       2, 'active', 1, 1, 0, 'claim-code', '${NOW}', NULL, NULL, '${NOW}', '${NOW}'),
      ('record-harness', 'org-1', 'project-1', NULL, 'example-harness-a', 'harness', 'decision',
       1, 'active', 1, 1, 0, 'claim-harness', '${NOW}', NULL, NULL, '${NOW}', '${NOW}'),
      ('record-harness-constraint', 'org-1', 'project-1', NULL, 'example-harness-a', 'harness', 'constraint',
       1, 'active', 1, 1, 0, 'claim-harness-constraint', '${NOW}', NULL, NULL, '${NOW}', '${NOW}'),
      ('record-orphan', 'org-1', 'project-1', NULL, 'ghost', 'harness', 'decision',
       1, 'active', 1, 1, 0, 'claim-orphan', '${NOW}', NULL, NULL, '${NOW}', '${NOW}'),
      ('record-org', 'org-1', 'project-1', NULL, NULL, 'org', 'constraint',
       1, 'active', 1, 1, 0, 'claim-org', '${NOW}', NULL, NULL, '${NOW}', '${NOW}');

    INSERT INTO memory_record_versions (
      record_id, record_version, content_json, applicability_json, exceptions_json,
      compatibility_json, validation_json, evidence_json, evidence_summary_json,
      freshness_json, provenance_json, embedding_json, content_digest, recorded_at
    ) VALUES
      ('record-code', 1, '{}', '{"repository_id":"github.com/acme/repo"}', '[]', '{}', '{}', '[]', '{}', '{}', '{}', NULL, 'sha256:record-code-1', '${NOW}'),
      ('record-code', 2, '{}', '{"repository_id":"github.com/acme/repo"}', '[]', '{}', '{}', '[]', '{}', '{}', '{}', NULL, 'sha256:record-code-2', '${LATER}'),
      ('record-harness', 1, '{}', '{"harness_id":"example-harness-a"}', '[]', '{}', '{}', '[]', '{}', '{}', '{}', NULL, 'sha256:record-harness', '${NOW}'),
      ('record-harness-constraint', 1, '{}', '{"harness_id":"example-harness-a"}', '[]', '{}', '{}', '[]', '{}', '{}', '{}', NULL, 'sha256:record-harness-constraint', '${NOW}'),
      ('record-orphan', 1, '{}', '{"harness_id":"ghost"}', '[]', '{}', '{}', '[]', '{}', '{}', '{}', NULL, 'sha256:record-orphan', '${NOW}'),
      ('record-org', 1, '{}', '{"audience":["org"]}', '[]', '{}', '{}', '[]', '{}', '{}', '{}', NULL, 'sha256:record-org', '${NOW}');

    INSERT INTO memory_run_receipts (
      receipt_id, org_id, project_id, producer_run_id, schema_major, idempotency_key,
      request_digest, receipt_json, response_json, producer_harness_id,
      repository_row_id, repository_id, base_sha, outcome_status, created_at
    ) VALUES
      ('receipt-code', 'org-1', 'project-1', 'run-code', '1', NULL, 'sha256:receipt-code', '{}', '{}', 'example-harness-a', 'repo-row-1', 'github.com/acme/repo', 'abc', 'completed', '${NOW}'),
      ('receipt-harness', 'org-1', 'project-1', 'run-harness', '1', NULL, 'sha256:receipt-harness', '{}', '{}', 'example-harness-a', NULL, NULL, NULL, 'completed', '${NOW}'),
      ('receipt-orphan', 'org-1', 'project-1', 'run-orphan', '1', NULL, 'sha256:receipt-orphan', '{}', '{}', 'ghost', NULL, NULL, NULL, 'completed', '${NOW}'),
      ('receipt-empty', 'org-1', 'project-1', 'run-empty', '1', NULL, 'sha256:receipt-empty', '{}', '{}', 'example-harness-a', NULL, NULL, NULL, 'completed', '${NOW}'),
      ('receipt-org', 'org-1', 'project-1', 'run-org', '1', NULL, 'sha256:receipt-org', '{}', '{}', 'example-harness-a', NULL, NULL, NULL, 'completed', '${NOW}');

    INSERT INTO memory_candidates_v1 (
      candidate_id, org_id, project_id, receipt_id, repository_row_id,
      producer_harness_id, client_candidate_id, candidate_digest, candidate_json,
      plane, kind, current_status, aggregate_version, activation_requirement,
      blockers_json, evidence_manifest_row_id, active_record_id, active_record_version,
      created_at, updated_at
    ) VALUES
      ('candidate-code', 'org-1', 'project-1', 'receipt-code', 'repo-row-1', 'example-harness-a',
       'client-code', 'sha256:candidate-code', '{"applicability":{"repository_id":"github.com/acme/repo"}}',
       'codebase', 'decision', 'active', 1, 'verified_merge', '[]', NULL,
       'record-code', 2, '${NOW}', '${NOW}'),
      ('candidate-harness', 'org-1', 'project-1', 'receipt-harness', NULL, 'example-harness-a',
       'client-harness', 'sha256:candidate-harness', '{"applicability":{"harness_id":"example-harness-a"}}',
       'harness', 'constraint', 'received', 1, 'authorized_review', '[]', NULL, NULL, NULL, '${NOW}', '${NOW}'),
      ('candidate-orphan', 'org-1', 'project-1', 'receipt-orphan', NULL, 'ghost',
       'client-orphan', 'sha256:candidate-orphan', '{"applicability":{"harness_id":"ghost"}}',
       'harness', 'decision', 'received', 1, 'authorized_review', '[]', NULL, NULL, NULL, '${NOW}', '${NOW}'),
      ('candidate-org', 'org-1', 'project-1', 'receipt-org', NULL, 'example-harness-a',
       'client-org', 'sha256:candidate-org', '{"applicability":{"audience":["org"]}}',
       'org', 'constraint', 'received', 1, 'manual_policy_owner', '[]', NULL, NULL, NULL, '${NOW}', '${NOW}');

    INSERT INTO memory_activation_claims (
      org_id, project_id, repository_row_id, plane, conflict_key,
      aggregate_version, current_candidate_id, current_record_id,
      current_record_version, created_at, updated_at
    ) VALUES (
      'org-1', 'project-1', 'repo-row-1', 'codebase', 'active-code-claim',
      1, 'candidate-code', 'record-code', 2, '${NOW}', '${NOW}'
    );

    INSERT INTO memory_receipt_candidates (
      receipt_id, candidate_id, client_candidate_id, candidate_digest
    ) VALUES
      ('receipt-code', 'candidate-code', 'client-code', 'sha256:candidate-code'),
      ('receipt-harness', 'candidate-harness', 'client-harness', 'sha256:candidate-harness'),
      ('receipt-orphan', 'candidate-orphan', 'client-orphan', 'sha256:candidate-orphan'),
      ('receipt-org', 'candidate-org', 'client-org', 'sha256:candidate-org');

    INSERT INTO memory_retrieval_packs (
      retrieval_pack_id, org_id, project_id, request_id, request_digest,
      repository_row_id, repository_id, harness_id, plane, query, policy_version,
      ranker_version, authorized_scope_json, token_count, omitted_count, response_json,
      created_at, expires_at
    ) VALUES
      ('pack-code', 'org-1', 'project-1', 'request-code', 'sha256:pack-code',
       'repo-row-1', 'github.com/acme/repo', NULL, 'codebase', 'code', 'policy-v1',
       'ranker-v1', '{}', 1, 0, '{}', '${NOW}', '${LATER}'),
      ('pack-harness', 'org-1', 'project-1', 'request-harness', 'sha256:pack-harness',
       NULL, NULL, 'example-harness-a', 'harness', 'harness', 'policy-v1',
       'ranker-v1', '{}', 1, 0, '{}', '${NOW}', '${LATER}'),
      ('pack-orphan', 'org-1', 'project-1', 'request-orphan', 'sha256:pack-orphan',
       NULL, NULL, 'ghost', 'harness', 'orphan', 'policy-v1',
       'ranker-v1', '{}', 1, 0, '{}', '${NOW}', '${LATER}');

    INSERT INTO memory_feedback (
      feedback_id, org_id, project_id, receipt_id, producer_run_id, retrieval_pack_id,
      record_id, record_version, feedback_stage, feedback_revision, feedback_json,
      feedback_digest, created_at
    ) VALUES
      ('feedback-code', 'org-1', 'project-1', NULL, 'feedback-run-code', 'pack-code',
       'record-code', 2, 'later', 1, '{}', 'sha256:feedback-code', '${NOW}'),
      ('feedback-harness', 'org-1', 'project-1', NULL, 'feedback-run-harness', 'pack-harness',
       'record-harness', 1, 'later', 1, '{}', 'sha256:feedback-harness', '${NOW}'),
      ('feedback-orphan', 'org-1', 'project-1', NULL, 'feedback-run-orphan', 'pack-orphan',
       'record-orphan', 1, 'later', 1, '{}', 'sha256:feedback-orphan', '${NOW}');

    INSERT INTO memory_authority_transitions (
      transition_id, revision, from_authority, to_authority,
      legacy_writes_frozen, import_run_id, actor_id, reason_code, occurred_at
    ) VALUES
      ('authority-lock', 1, 'legacy', 'migration_locked', 1, NULL,
       'migration-test', 'offline_migration_started', '${NOW}'),
      ('authority-canonical', 2, 'migration_locked', 'canonical', 1, NULL,
       'migration-test', 'offline_migration_reconciled', '${LATER}');
  `);
  return database;
}

function projectedIdentityDigest(database: DatabaseSync, aggregateType: string): string {
  const facetTable = {
    record: "memory_v2_record_facets",
    candidate: "memory_v2_candidate_facets",
    receipt: "memory_v2_receipt_facets",
    feedback: "memory_v2_feedback_facets",
  }[aggregateType]!;
  const facetIdentity = aggregateType === "record"
    ? "record_id AS aggregate_id, record_version AS aggregate_version"
    : `${aggregateType}_id AS aggregate_id, 0 AS aggregate_version`;
  return sha256(rows(database, `
    SELECT aggregate_id, aggregate_version FROM (
      SELECT ${facetIdentity} FROM ${facetTable}
      UNION ALL
      SELECT aggregate_id, aggregate_version
      FROM memory_v2_facet_quarantine
      WHERE aggregate_type = '${aggregateType}'
    ) ORDER BY aggregate_id, aggregate_version
  `));
}

describe("memory v2 foundation migrations", () => {
  it("requires an explicit one-shot confirmation only for first application in production", () => {
    const database = createThroughVersion11Fixture();
    const previousNodeEnv = process.env.NODE_ENV;
    const previousConfirmation = process.env[MEMORY_V2_OFFLINE_CUTOVER_CONFIRMATION_ENV];
    try {
      process.env.NODE_ENV = "production";
      delete process.env[MEMORY_V2_OFFLINE_CUTOVER_CONFIRMATION_ENV];
      expect(() => runSchemaMigrations(database)).toThrow(/stopped-writer memory v2 offline cutover/);
      expect(count(database, "schema_migrations")).toBe(11);
      expect(database.prepare(
        "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'memory_v2_resources'",
      ).get()).toBeUndefined();

      process.env[MEMORY_V2_OFFLINE_CUTOVER_CONFIRMATION_ENV] = "yes";
      expect(() => runSchemaMigrations(database)).toThrow(/stopped-writer memory v2 offline cutover/);
      expect(count(database, "schema_migrations")).toBe(11);

      process.env[MEMORY_V2_OFFLINE_CUTOVER_CONFIRMATION_ENV]
        = MEMORY_V2_OFFLINE_CUTOVER_CONFIRMATION;
      runSchemaMigrations(database, { throughVersion: 12 });
      expect(count(database, "schema_migrations")).toBe(12);

      delete process.env[MEMORY_V2_OFFLINE_CUTOVER_CONFIRMATION_ENV];
      expect(() => runSchemaMigrations(database)).toThrow(/stopped-writer memory v2 offline cutover/);
      expect(count(database, "schema_migrations")).toBe(12);

      process.env[MEMORY_V2_OFFLINE_CUTOVER_CONFIRMATION_ENV]
        = MEMORY_V2_OFFLINE_CUTOVER_CONFIRMATION;
      runSchemaMigrations(database);
      expect(count(database, "schema_migrations")).toBe(18);

      delete process.env[MEMORY_V2_OFFLINE_CUTOVER_CONFIRMATION_ENV];
      expect(() => runSchemaMigrations(database)).not.toThrow();
      expect(count(database, "schema_migrations")).toBe(18);
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousConfirmation === undefined) {
        delete process.env[MEMORY_V2_OFFLINE_CUTOVER_CONFIRMATION_ENV];
      } else {
        process.env[MEMORY_V2_OFFLINE_CUTOVER_CONFIRMATION_ENV] = previousConfirmation;
      }
      database.close();
    }
  });

  it("backfills a pre-rename token binding through immutable repository-row authority", () => {
    const database = createThroughVersion11Fixture();
    expect(database.prepare(`
      SELECT binding.repository_row_id, binding.repository_id AS bound_repository_id,
             repository.repository_id AS current_repository_id
      FROM memory_service_token_repository_bindings AS binding
      INNER JOIN memory_repository_registry AS repository
        ON repository.repository_row_id = binding.repository_row_id
      WHERE binding.binding_id = 'repository-binding-1'
    `).get()).toEqual({
      repository_row_id: "repo-row-1",
      bound_repository_id: "github.com/acme/old-name",
      current_repository_id: "github.com/acme/repo",
    });

    runSchemaMigrations(database, { throughVersion: 12 });

    expect(database.prepare(`
      SELECT binding.source_binding_id, resource.source_row_id,
             resource.canonical_resource_id
      FROM memory_v2_service_token_resource_bindings AS binding
      INNER JOIN memory_v2_resources AS resource
        ON resource.resource_row_id = binding.resource_row_id
      WHERE binding.binding_id = 'v2bind_repository:repository-binding-1'
    `).get()).toEqual({
      source_binding_id: "repository-binding-1",
      source_row_id: "repo-row-1",
      canonical_resource_id: "github.com/acme/repo",
    });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();
  });

  it.each(OPERATION_PROJECTION_CASES)(
    "keeps migration 012 and runtime operation parity for $plane scope $scope",
    ({ plane, sourceBindingType, scope }) => {
      const database = createThroughVersion11Fixture();
      database.prepare(
        "UPDATE service_tokens SET scopes_json = ? WHERE token_id = 'token-1'",
      ).run(JSON.stringify([scope]));

      runSchemaMigrations(database, { throughVersion: 12 });

      const projected = database.prepare(
        `SELECT operations_json FROM memory_v2_service_token_resource_bindings
         WHERE source_binding_type = ?`,
      ).get(sourceBindingType) as { operations_json: string } | undefined;
      expect(projected).toBeDefined();
      expect(JSON.parse(projected!.operations_json))
        .toEqual(memoryV2OperationsForScopes(plane, [scope]));
      expect(count(database, "memory_v2_service_token_resource_bindings")).toBe(1);
      database.close();
    },
  );

  it("opens only 012 then 013 and reconciles every resource and facet identity", () => {
    const database = createThroughVersion11Fixture();
    const v1Digest = v1SchemaDigest(database);

    runSchemaMigrations(database, { throughVersion: 12 });

    expect(rows(database, "SELECT version, name FROM schema_migrations ORDER BY version DESC LIMIT 2"))
      .toEqual([
        { version: 12, name: "memory_v2_resources" },
        { version: 11, name: "memory_attestation_diff_proof" },
      ]);
    expect(database.prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'memory_v2_record_facets'",
    ).get()).toBeUndefined();
    expect(count(database, "memory_v2_resources")).toBe(2);
    expect(count(database, "memory_v2_resource_aliases")).toBe(2);
    expect(count(database, "memory_v2_service_token_resource_bindings")).toBe(2);
    expect(count(database, "memory_v2_service_token_mcp_profiles")).toBe(0);
    expect(v1SchemaDigest(database)).toBe(v1Digest);

    const repositorySource = rows(database, `
      SELECT org_id, project_id, repository_id AS canonical_resource_id,
             repository_row_id AS source_row_id, valid_until
      FROM memory_repository_registry ORDER BY repository_row_id
    `);
    const repositoryProjection = rows(database, `
      SELECT org_id, project_id, canonical_resource_id, source_row_id, valid_until
      FROM memory_v2_resources
      WHERE source_authority = 'memory_repository_registry' ORDER BY source_row_id
    `);
    expect(sha256(repositoryProjection)).toBe(sha256(repositorySource));

    const harness = database.prepare(`
      SELECT resource_row_id, org_id, project_id, canonical_resource_id, source_row_id
      FROM memory_v2_resources WHERE source_authority = 'memory_harness_principal_bindings'
    `).get() as Record<string, string>;
    expect(harness.resource_row_id).toMatch(/^v2res_harness:[0-9a-f]{32}$/);
    expect(harness).toMatchObject({
      org_id: "org-1",
      project_id: "project-1",
      canonical_resource_id: "example-harness-a",
    });
    expect(harness.source_row_id).toContain("identity:");

    const operations = rows(database, `
      SELECT source_binding_type, operations_json
      FROM memory_v2_service_token_resource_bindings ORDER BY source_binding_type
    `) as Array<{ source_binding_type: string; operations_json: string }>;
    const tokenScopes = JSON.parse((database.prepare(
      "SELECT scopes_json FROM service_tokens WHERE token_id = 'token-1'",
    ).get() as { scopes_json: string }).scopes_json) as string[];
    const operationsBySource = Object.fromEntries(operations.map((entry) => [
      entry.source_binding_type,
      JSON.parse(entry.operations_json) as string[],
    ]));
    expect(operationsBySource.harness_principal_binding)
      .toEqual(memoryV2OperationsForScopes("harness", tokenScopes));
    expect(operationsBySource.repository_token_binding)
      .toEqual(memoryV2OperationsForScopes("codebase", tokenScopes));
    expect(operations.map((entry) => entry.operations_json).join(" "))
      .not.toMatch(/\b(?:attest|admin)\b/);

    expect(rows(database, `
      SELECT alias_canonical_resource_id, project_id, valid_until
      FROM memory_v2_resource_aliases ORDER BY alias_canonical_resource_id
    `)).toEqual([
      {
        alias_canonical_resource_id: "github.com/acme/old-name",
        project_id: "project-1",
        valid_until: null,
      },
      {
        alias_canonical_resource_id: "github.com/acme/pre-transfer",
        project_id: "project-old",
        valid_until: LATER,
      },
    ]);

    runSchemaMigrations(database, { throughVersion: 13 });

    for (const table of [
      "memory_v2_record_facets",
      "memory_v2_candidate_facets",
      "memory_v2_receipt_facets",
      "memory_v2_feedback_facets",
      "memory_v2_facet_quarantine",
    ]) expect(database.prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?",
    ).get(table)).toBeDefined();
    for (const unopened of [
      "memory_v2_retrieval_packs",
      "memory_v2_scope_snapshots",
      "memory_v2_feedback_bindings",
    ]) expect(database.prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?",
    ).get(unopened)).toBeUndefined();
    expect(v1SchemaDigest(database)).toBe(v1Digest);

    expect(count(database, "memory_v2_record_facets")).toBe(3);
    expect(count(database, "memory_v2_candidate_facets")).toBe(1);
    expect(count(database, "memory_v2_receipt_facets")).toBe(2);
    expect(count(database, "memory_v2_feedback_facets")).toBe(2);
    expect(count(database, "memory_v2_facet_quarantine")).toBe(10);

    const sourceDigests = {
      record: sha256(rows(database, `
        SELECT record.record_id AS aggregate_id, version.record_version AS aggregate_version
        FROM memory_records AS record
        INNER JOIN memory_record_versions AS version ON version.record_id = record.record_id
        ORDER BY aggregate_id, aggregate_version
      `)),
      candidate: sha256(rows(database,
        "SELECT candidate_id AS aggregate_id, 0 AS aggregate_version FROM memory_candidates_v1 ORDER BY aggregate_id")),
      receipt: sha256(rows(database,
        "SELECT receipt_id AS aggregate_id, 0 AS aggregate_version FROM memory_run_receipts ORDER BY aggregate_id")),
      feedback: sha256(rows(database,
        "SELECT feedback_id AS aggregate_id, 0 AS aggregate_version FROM memory_feedback ORDER BY aggregate_id")),
    };
    for (const aggregateType of Object.keys(sourceDigests) as Array<keyof typeof sourceDigests>) {
      expect(projectedIdentityDigest(database, aggregateType)).toBe(sourceDigests[aggregateType]);
    }

    expect(database.prepare(`
      SELECT subtype, projection_status FROM memory_v2_record_facets
      WHERE record_id = 'record-harness'
    `).get()).toEqual({ subtype: "workflow_strategy", projection_status: "mapped" });
    expect(database.prepare(`
      SELECT 1 FROM memory_v2_record_facets
      WHERE record_id = 'record-harness-constraint'
    `).get()).toBeUndefined();
    expect(database.prepare(`
      SELECT 1 FROM memory_v2_candidate_facets
      WHERE candidate_id = 'candidate-harness'
    `).get()).toBeUndefined();
    expect(rows(database, `
      SELECT aggregate_type, aggregate_id, source_plane, reason_code
      FROM memory_v2_facet_quarantine ORDER BY aggregate_type, aggregate_id
    `)).toEqual(expect.arrayContaining([
      {
        aggregate_type: "record",
        aggregate_id: "record-harness-constraint",
        source_plane: "harness",
        reason_code: "subtype_ambiguous",
      },
      {
        aggregate_type: "candidate",
        aggregate_id: "candidate-harness",
        source_plane: "harness",
        reason_code: "subtype_ambiguous",
      },
      {
        aggregate_type: "record",
        aggregate_id: "record-orphan",
        source_plane: "harness",
        reason_code: "resource_missing",
      },
      {
        aggregate_type: "record",
        aggregate_id: "record-org",
        source_plane: "org",
        reason_code: "unsupported_plane",
      },
      {
        aggregate_type: "receipt",
        aggregate_id: "receipt-empty",
        source_plane: "unknown",
        reason_code: "plane_ambiguous",
      },
    ]));
    expect(database.prepare(`
      SELECT facet.record_version
      FROM memory_records AS record
      INNER JOIN memory_v2_record_facets AS facet
        ON facet.record_id = record.record_id AND facet.record_version = record.current_version
      WHERE record.record_id = 'record-code'
    `).get()).toEqual({ record_version: 2 });
    expect(database.prepare(`
      SELECT candidate.candidate_id, candidate.current_status,
             candidate.active_record_id, candidate.active_record_version,
             candidate_facet.resource_row_id AS candidate_resource_row_id,
             record.record_id, record.current_status AS record_status,
             version.record_version,
             record_facet.resource_row_id AS record_resource_row_id
      FROM memory_activation_claims AS claim
      INNER JOIN memory_candidates_v1 AS candidate
        ON candidate.candidate_id = claim.current_candidate_id
       AND candidate.active_record_id = claim.current_record_id
       AND candidate.active_record_version = claim.current_record_version
      INNER JOIN memory_v2_candidate_facets AS candidate_facet
        ON candidate_facet.candidate_id = candidate.candidate_id
      INNER JOIN memory_records AS record
        ON record.record_id = claim.current_record_id
       AND record.current_version = claim.current_record_version
      INNER JOIN memory_record_versions AS version
        ON version.record_id = claim.current_record_id
       AND version.record_version = claim.current_record_version
      INNER JOIN memory_v2_record_facets AS record_facet
        ON record_facet.record_id = version.record_id
       AND record_facet.record_version = version.record_version
      WHERE claim.current_candidate_id IS NOT NULL
        AND claim.current_record_id IS NOT NULL
        AND candidate.current_status = 'active'
        AND record.current_status = 'active'
        AND candidate_facet.resource_row_id = record_facet.resource_row_id
    `).get()).toEqual({
      candidate_id: "candidate-code",
      current_status: "active",
      active_record_id: "record-code",
      active_record_version: 2,
      candidate_resource_row_id: "v2res_repository:repo-row-1",
      record_id: "record-code",
      record_status: "active",
      record_version: 2,
      record_resource_row_id: "v2res_repository:repo-row-1",
    });
    expect(database.prepare(`
      SELECT COUNT(*) AS count
      FROM memory_activation_claims AS claim
      LEFT JOIN memory_candidates_v1 AS candidate
        ON candidate.candidate_id = claim.current_candidate_id
       AND candidate.active_record_id = claim.current_record_id
       AND candidate.active_record_version = claim.current_record_version
       AND candidate.current_status = 'active'
      LEFT JOIN memory_v2_candidate_facets AS candidate_facet
        ON candidate_facet.candidate_id = candidate.candidate_id
      LEFT JOIN memory_records AS record
        ON record.record_id = claim.current_record_id
       AND record.current_version = claim.current_record_version
       AND record.current_status = 'active'
      LEFT JOIN memory_record_versions AS version
        ON version.record_id = claim.current_record_id
       AND version.record_version = claim.current_record_version
      LEFT JOIN memory_v2_record_facets AS record_facet
        ON record_facet.record_id = version.record_id
       AND record_facet.record_version = version.record_version
      WHERE claim.current_candidate_id IS NOT NULL
        AND claim.current_record_id IS NOT NULL
        AND (
          candidate.candidate_id IS NULL
          OR candidate_facet.candidate_id IS NULL
          OR record.record_id IS NULL
          OR version.record_id IS NULL
          OR record_facet.record_id IS NULL
          OR candidate_facet.resource_row_id <> record_facet.resource_row_id
        )
    `).get()).toEqual({ count: 0 });

    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    const ledgerBeforeReplay = rows(database,
      "SELECT version, name, checksum FROM schema_migrations ORDER BY version");
    expect(ledgerBeforeReplay).toHaveLength(13);
    for (const row of ledgerBeforeReplay as Array<{ checksum: string }>) {
      expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
    }
    runSchemaMigrations(database, { throughVersion: 13 });
    expect(rows(database, "SELECT version, name, checksum FROM schema_migrations ORDER BY version"))
      .toEqual(ledgerBeforeReplay);

    runSchemaMigrations(database);
    expect(rows(database, "SELECT version, name FROM schema_migrations ORDER BY version DESC LIMIT 1"))
      .toEqual([{ version: 18, name: "memory_experiment_cleanup" }]);
    expect(database.prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'memory_v2_retrieval_packs'",
    ).get()).toBeDefined();
    database.close();
  });

  it("quarantines a lossless harness kind when version applicability disagrees with authority", () => {
    const database = createThroughVersion11Fixture();
    database.exec(`
      INSERT INTO memory_records (
        record_id, org_id, project_id, repository_row_id, harness_id, plane, kind,
        current_version, current_status, aggregate_version, shadow_recall_eligible,
        prompt_eligible, claim_key, valid_from, valid_until, expires_at, created_at, updated_at
      ) VALUES (
        'record-harness-authority-mismatch', 'org-1', 'project-1', NULL, 'example-harness-a',
        'harness', 'anti_pattern', 1, 'active', 1, 1, 0,
        'claim-harness-authority-mismatch', '${NOW}', NULL, NULL, '${NOW}', '${NOW}'
      );
      INSERT INTO memory_record_versions (
        record_id, record_version, content_json, applicability_json, exceptions_json,
        compatibility_json, validation_json, evidence_json, evidence_summary_json,
        freshness_json, provenance_json, embedding_json, content_digest, recorded_at
      ) VALUES (
        'record-harness-authority-mismatch', 1, '{}', '{"harness_id":"example-harness-b"}',
        '[]', '{}', '{}', '[]', '{}', '{}', '{}', NULL,
        'sha256:record-harness-authority-mismatch', '${NOW}'
      );
    `);

    runSchemaMigrations(database, { throughVersion: 13 });

    expect(database.prepare(
      `SELECT 1 FROM memory_v2_record_facets
       WHERE record_id = 'record-harness-authority-mismatch' AND record_version = 1`,
    ).get()).toBeUndefined();
    expect(database.prepare(
      `SELECT source_plane, reason_code
       FROM memory_v2_facet_quarantine
       WHERE aggregate_type = 'record'
         AND aggregate_id = 'record-harness-authority-mismatch'
         AND aggregate_version = 1`,
    ).get()).toEqual({
      source_plane: "harness",
      reason_code: "authority_mismatch",
    });
    expect(database.prepare(
      `SELECT subtype, projection_status FROM memory_v2_record_facets
       WHERE record_id = 'record-harness' AND record_version = 1`,
    ).get()).toEqual({ subtype: "workflow_strategy", projection_status: "mapped" });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();
  });

  it("keeps private MCP eligibility opt-in and permits only erasure-safe companion deletion", () => {
    const database = createThroughVersion11Fixture();
    runSchemaMigrations(database);

    expect(count(database, "memory_v2_service_token_mcp_profiles")).toBe(0);

    database.exec(`
      INSERT INTO service_principals VALUES ('principal-forged', 'org-1');
      INSERT INTO service_tokens VALUES (
        'token-forged', 'principal-forged', '["memory:search"]', 'project-1'
      );
    `);
    const repositoryResourceForForgery = database.prepare(`
      SELECT resource_row_id FROM memory_v2_resources
      WHERE source_authority = 'memory_repository_registry' AND source_row_id = 'repo-row-1'
    `).get() as { resource_row_id: string };
    expect(() => database.prepare(`
      INSERT INTO memory_v2_service_token_resource_bindings (
        binding_id, token_id, service_principal_id, org_id, project_id,
        resource_row_id, operations_json, source_binding_type,
        source_binding_id, created_at
      ) VALUES (
        'forged-v2-binding', 'token-forged', 'principal-forged', 'org-1', 'project-1',
        ?, '["search"]', 'repository_token_binding', 'missing-source-binding', '${NOW}'
      )
    `).run(repositoryResourceForForgery.resource_row_id)).toThrow(/source authority mismatch/);

    expect(() => database.prepare(`
      INSERT INTO memory_v2_service_token_mcp_profiles (
        token_id, authentication_profile, audience, resource_indicator, endpoint_path, created_at
      ) VALUES (
        'token-1', 'private_pim_service_token', 'wrong-audience',
        'urn:pim:resource:mcp-memory', '/mcp/memory', '${NOW}'
      )
    `).run()).toThrow(/CHECK/);
    database.prepare(`
      INSERT INTO memory_v2_service_token_mcp_profiles (
        token_id, authentication_profile, audience, resource_indicator, endpoint_path, created_at
      ) VALUES (
        'token-1', 'private_pim_service_token', 'urn:pim:audience:mcp-memory',
        'urn:pim:resource:mcp-memory', '/mcp/memory', '${NOW}'
      )
    `).run();
    expect(() => database.prepare(`
      UPDATE memory_v2_service_token_mcp_profiles SET created_at = '${LATER}'
      WHERE token_id = 'token-1'
    `).run()).toThrow(/immutable/);
    database.prepare(
      "DELETE FROM memory_v2_service_token_mcp_profiles WHERE token_id = 'token-1'",
    ).run();
    expect(count(database, "memory_v2_service_token_mcp_profiles")).toBe(0);

    const repositoryResource = database.prepare(`
      SELECT resource_row_id FROM memory_v2_resources
      WHERE source_authority = 'memory_repository_registry' AND source_row_id = 'repo-row-1'
    `).get() as { resource_row_id: string };
    expect(() => database.prepare(`
      INSERT INTO memory_v2_resource_aliases (
        alias_row_id, resource_row_id, org_id, project_id, plane, resource_type,
        alias_canonical_resource_id, reason, source_alias_row_id,
        valid_from, valid_until, created_at
      ) VALUES (
        'invalid-active-alias', ?, 'org-1', 'project-old', 'codebase', 'repository',
        'github.com/acme/invalid-active', 'rename', 'invalid-active-alias',
        '${NOW}', NULL, '${NOW}'
      )
    `).run(repositoryResource.resource_row_id)).toThrow(/binding mismatch/);

    database.exec(`
      UPDATE memory_repository_registry
      SET project_id = 'project-destination', updated_at = '${LATER}'
      WHERE repository_row_id = 'repo-row-1';
      UPDATE memory_v2_resources
      SET project_id = 'project-destination', updated_at = '${LATER}'
      WHERE resource_row_id = '${repositoryResource.resource_row_id}';
      UPDATE memory_v2_resource_aliases
      SET project_id = 'project-destination'
      WHERE resource_row_id = '${repositoryResource.resource_row_id}'
        AND valid_until IS NULL;
    `);
    expect(database.prepare(`
      SELECT resource.resource_row_id
      FROM memory_v2_resource_aliases AS alias
      INNER JOIN memory_v2_resources AS resource
        ON resource.resource_row_id = alias.resource_row_id
       AND resource.project_id = alias.project_id
      WHERE alias.org_id = 'org-1' AND alias.project_id = 'project-destination'
        AND alias.alias_canonical_resource_id = 'github.com/acme/old-name'
        AND alias.valid_until IS NULL
    `).get()).toEqual({ resource_row_id: repositoryResource.resource_row_id });
    expect(database.prepare(`
      SELECT 1 FROM memory_v2_resource_aliases
      WHERE org_id = 'org-1' AND project_id = 'project-1'
        AND alias_canonical_resource_id = 'github.com/acme/old-name'
        AND valid_until IS NULL
    `).get()).toBeUndefined();
    expect(database.prepare(`
      SELECT project_id FROM memory_v2_resource_aliases
      WHERE alias_canonical_resource_id = 'github.com/acme/pre-transfer'
    `).get()).toEqual({ project_id: "project-old" });

    const harnessResource = database.prepare(`
      SELECT resource_row_id FROM memory_v2_resources
      WHERE plane = 'harness' AND canonical_resource_id = 'example-harness-a'
    `).get() as { resource_row_id: string };
    expect(count(database, "memory_v2_record_facets")).toBeGreaterThan(0);
    database.prepare("DELETE FROM memory_v2_resources WHERE resource_row_id = ?")
      .run(harnessResource.resource_row_id);
    for (const table of [
      "memory_v2_service_token_resource_bindings",
      "memory_v2_record_facets",
      "memory_v2_record_trust",
      "memory_v2_candidate_facets",
      "memory_v2_receipt_facets",
      "memory_v2_feedback_facets",
    ]) expect(database.prepare(
      `SELECT COUNT(*) AS count FROM ${table} WHERE resource_row_id = ?`,
    ).get(harnessResource.resource_row_id)).toEqual({ count: 0 });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    database.close();
  });
});
