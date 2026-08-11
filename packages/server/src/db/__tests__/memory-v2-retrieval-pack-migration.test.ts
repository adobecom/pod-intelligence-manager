import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { runSchemaMigrations } from "../migrations.js";

const CREATED_AT = "2026-08-10T00:00:00.000Z";
const EXPIRES_AT = "2026-08-10T01:00:00.000Z";
const REQUEST_DIGEST = `sha256:${"a".repeat(64)}`;
const SCOPE_DIGEST = `sha256:${"b".repeat(64)}`;

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
      org_id TEXT NOT NULL REFERENCES orgs(org_id)
    );
    CREATE TABLE service_tokens (
      token_id TEXT PRIMARY KEY,
      service_principal_id TEXT NOT NULL REFERENCES service_principals(service_principal_id),
      scopes_json TEXT NOT NULL,
      project_id TEXT REFERENCES projects(project_id)
    );

    INSERT INTO orgs VALUES ('org-1');
    INSERT INTO projects VALUES ('project-1', 'org-1');
    INSERT INTO service_principals VALUES ('principal-1', 'org-1');
    INSERT INTO service_tokens VALUES (
      'token-1', 'principal-1', '["memory:search"]', 'project-1'
    );
  `);
  runSchemaMigrations(database, { throughVersion: 11 });
  database.exec(`
    INSERT INTO memory_repository_registry (
      repository_row_id, org_id, project_id, provider, provider_repository_id,
      repository_id, display_slug, valid_from, valid_until, created_at, updated_at
    ) VALUES
      ('repo-row-1', 'org-1', 'project-1', 'github', 'provider-repo-1',
       'github.com/acme/one', 'acme/one', '${CREATED_AT}', NULL, '${CREATED_AT}', '${CREATED_AT}'),
      ('repo-row-2', 'org-1', 'project-1', 'github', 'provider-repo-2',
       'github.com/acme/two', 'acme/two', '${CREATED_AT}', NULL, '${CREATED_AT}', '${CREATED_AT}');

    INSERT INTO memory_records (
      record_id, org_id, project_id, repository_row_id, harness_id, plane, kind,
      current_version, current_status, aggregate_version, shadow_recall_eligible,
      prompt_eligible, claim_key, valid_from, valid_until, expires_at, created_at, updated_at
    ) VALUES
      ('record-one', 'org-1', 'project-1', 'repo-row-1', NULL, 'codebase', 'constraint',
       1, 'active', 1, 1, 0, 'claim-one', '${CREATED_AT}', NULL, NULL, '${CREATED_AT}', '${CREATED_AT}'),
      ('record-two', 'org-1', 'project-1', 'repo-row-2', NULL, 'codebase', 'constraint',
       1, 'active', 1, 1, 0, 'claim-two', '${CREATED_AT}', NULL, NULL, '${CREATED_AT}', '${CREATED_AT}');

    INSERT INTO memory_record_versions (
      record_id, record_version, content_json, applicability_json, exceptions_json,
      compatibility_json, validation_json, evidence_json, evidence_summary_json,
      freshness_json, provenance_json, embedding_json, content_digest, recorded_at
    ) VALUES
      ('record-one', 1, '{}', '{}', '[]', '{}', '{}', '[]', '{}', '{}', '{}', NULL,
       'sha256:record-one', '${CREATED_AT}'),
      ('record-two', 1, '{}', '{}', '[]', '{}', '{}', '[]', '{}', '{}', '{}', NULL,
       'sha256:record-two', '${CREATED_AT}');
  `);
  runSchemaMigrations(database, { throughVersion: 14 });
  return database;
}

function binding(database: DatabaseSync, resourceRowId: string): Record<string, unknown> {
  const row = database.prepare(
    `SELECT resource_row_id, org_id, project_id, plane, resource_type,
            canonical_resource_id, provider, provider_resource_id, display_label
     FROM memory_v2_resources WHERE resource_row_id = ?`,
  ).get(resourceRowId) as Record<string, string | null>;
  return {
    resource_row_id: row.resource_row_id,
    organization_id: row.org_id,
    project_id: row.project_id,
    plane: row.plane,
    resource_type: row.resource_type,
    canonical_resource_id: row.canonical_resource_id,
    provider: row.provider,
    provider_resource_id: row.provider_resource_id,
    display_label: row.display_label,
    permitted_operations: ["search", "detail", "history", "pack"],
  };
}

function insertPack(
  database: DatabaseSync,
  input: {
    packId?: string;
    requestId?: string;
    resourceRowId?: string;
    resourceBinding?: unknown;
    authorizedScopes?: string[];
  } = {},
): void {
  const resourceRowId = input.resourceRowId ?? "v2res_repository:repo-row-1";
  database.prepare(
    `INSERT INTO memory_v2_retrieval_packs (
       retrieval_pack_id, schema_version, org_id, project_id, request_id, request_digest,
       principal_id, plane, resource_row_id, resource_binding_json, scope_snapshot_digest,
       policy_version, ranker_version, budget_json, authorized_scopes_json,
       response_json, token_count, omitted_count, created_at, expires_at
     ) VALUES (?, 'pim.memory-retrieval-pack.v2', 'org-1', 'project-1', ?, ?,
       'principal-1', 'codebase', ?, ?, ?, 'policy-v1', 'ranker-v1', ?, ?,
       ?, 12, 0, ?, ?)`,
  ).run(
    input.packId ?? "pack-one",
    input.requestId ?? "request-one",
    REQUEST_DIGEST,
    resourceRowId,
    JSON.stringify(input.resourceBinding ?? binding(database, resourceRowId)),
    SCOPE_DIGEST,
    JSON.stringify({ max_tokens: 800, max_items: 8 }),
    JSON.stringify(input.authorizedScopes ?? ["memory:search"]),
    JSON.stringify({
      schema_version: "pim.memory-search-result.v2",
      request_id: input.requestId ?? "request-one",
      retrieval_pack_id: input.packId ?? "pack-one",
      items: [],
    }),
    CREATED_AT,
    EXPIRES_AT,
  );
}

describe("memory v2 retrieval-pack migration", () => {
  it("registers only 014 and stores the exact immutable pack snapshot", () => {
    const database = fixture();
    expect(database.prepare(
      "SELECT version, name FROM schema_migrations ORDER BY version DESC LIMIT 1",
    ).get()).toEqual({ version: 14, name: "memory_v2_retrieval_packs" });
    expect(database.prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'memory_v2_scope_snapshots'",
    ).get()).toBeUndefined();
    const packColumns = (database.prepare(
      "SELECT name FROM pragma_table_info('memory_v2_retrieval_packs') ORDER BY cid",
    ).all() as unknown as Array<{ name: string }>).map((row) => row.name);
    const itemColumns = (database.prepare(
      "SELECT name FROM pragma_table_info('memory_v2_retrieval_pack_items') ORDER BY cid",
    ).all() as unknown as Array<{ name: string }>).map((row) => row.name);
    expect(packColumns).not.toContain("eligibility");
    expect(packColumns).not.toContain("exposure_snapshot_json");
    expect(itemColumns).not.toContain("prompt_eligible");
    expect(itemColumns).not.toContain("routing_eligible");

    insertPack(database);
    database.prepare(
      `INSERT INTO memory_v2_retrieval_pack_items (
         retrieval_pack_id, item_order, record_id, record_version, token_count,
         rank_score, match_reasons_json
       ) VALUES ('pack-one', 0, 'record-one', 1, 12, 1.0, '["selector:repository"]')`,
    ).run();

    const stored = database.prepare(
      `SELECT schema_version, resource_binding_json, scope_snapshot_digest, budget_json,
              authorized_scopes_json, response_json,
              policy_version, ranker_version, created_at, expires_at
       FROM memory_v2_retrieval_packs WHERE retrieval_pack_id = 'pack-one'`,
    ).get() as Record<string, unknown>;
    expect(stored).toEqual({
      schema_version: "pim.memory-retrieval-pack.v2",
      resource_binding_json: JSON.stringify(binding(database, "v2res_repository:repo-row-1")),
      scope_snapshot_digest: SCOPE_DIGEST,
      budget_json: JSON.stringify({ max_tokens: 800, max_items: 8 }),
      authorized_scopes_json: JSON.stringify(["memory:search"]),
      response_json: JSON.stringify({
        schema_version: "pim.memory-search-result.v2",
        request_id: "request-one",
        retrieval_pack_id: "pack-one",
        items: [],
      }),
      policy_version: "policy-v1",
      ranker_version: "ranker-v1",
      created_at: CREATED_AT,
      expires_at: EXPIRES_AT,
    });
    expect(() => database.prepare(
      "UPDATE memory_v2_retrieval_packs SET token_count = 0 WHERE retrieval_pack_id = 'pack-one'",
    ).run()).toThrow(/immutable/);
    expect(() => database.prepare(
      "DELETE FROM memory_v2_retrieval_pack_items WHERE retrieval_pack_id = 'pack-one'",
    ).run()).toThrow(/immutable/);
    expect(() => database.prepare(
      "DELETE FROM memory_v2_retrieval_packs WHERE retrieval_pack_id = 'pack-one'",
    ).run()).toThrow(/immutable/);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    database.close();
  });

  it("fails closed for missing scope, forged bindings, and cross-resource or facetless items", () => {
    const database = fixture();
    const forged = {
      ...binding(database, "v2res_repository:repo-row-1"),
      canonical_resource_id: "github.com/acme/forged",
    };
    expect(() => insertPack(database, {
      packId: "pack-forged",
      requestId: "request-forged",
      resourceBinding: forged,
    })).toThrow(/binding snapshot mismatch/);
    expect(() => insertPack(database, {
      packId: "pack-exposure-operation",
      requestId: "request-exposure-operation",
      resourceBinding: {
        ...binding(database, "v2res_repository:repo-row-1"),
        permitted_operations: ["search", "exposure_policy_read"],
      },
    })).toThrow(/operation is unavailable/);
    expect(() => insertPack(database, {
      packId: "pack-admin-scope",
      requestId: "request-admin-scope",
      authorizedScopes: ["memory:admin"],
    })).toThrow(/authorized scope is unavailable/);

    expect(() => database.prepare(
      `INSERT INTO memory_v2_retrieval_packs (
         retrieval_pack_id, schema_version, org_id, project_id, request_id, request_digest,
         principal_id, plane, resource_row_id, resource_binding_json, scope_snapshot_digest,
         policy_version, ranker_version, budget_json, authorized_scopes_json,
         response_json, token_count, omitted_count, created_at, expires_at
       ) VALUES ('pack-no-scope', 'pim.memory-retrieval-pack.v2', 'org-1', 'project-1',
         'request-no-scope', ?, 'principal-1', 'codebase', 'v2res_repository:repo-row-1', ?,
         NULL, 'policy-v1', 'ranker-v1', '{"max_tokens":800,"max_items":8}',
         '["memory:search"]', '{}', 0, 0, ?, ?)`,
    ).run(
      REQUEST_DIGEST,
      JSON.stringify(binding(database, "v2res_repository:repo-row-1")),
      CREATED_AT,
      EXPIRES_AT,
    )).toThrow(/NOT NULL/);

    insertPack(database);
    expect(() => database.prepare(
      `INSERT INTO memory_v2_retrieval_pack_items (
         retrieval_pack_id, item_order, record_id, record_version, token_count,
         rank_score, match_reasons_json
       ) VALUES ('pack-one', 0, 'record-two', 1, 1, 0.5, '[]')`,
    ).run()).toThrow(/facet binding mismatch/);

    database.prepare(
      "DELETE FROM memory_v2_record_facets WHERE record_id = 'record-one' AND record_version = 1",
    ).run();
    expect(() => database.prepare(
      `INSERT INTO memory_v2_retrieval_pack_items (
         retrieval_pack_id, item_order, record_id, record_version, token_count,
         rank_score, match_reasons_json
       ) VALUES ('pack-one', 0, 'record-one', 1, 1, 0.5, '[]')`,
    ).run()).toThrow(/facet binding mismatch/);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();
  });
});
