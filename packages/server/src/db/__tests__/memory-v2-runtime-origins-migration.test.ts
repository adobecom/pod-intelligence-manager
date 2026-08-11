import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { runSchemaMigrations } from "../migrations.js";

const NOW = "2026-08-10T12:00:00.000Z";
const DIGEST = `sha256:${"a".repeat(64)}`;

interface RuntimeOriginFixture {
  database: DatabaseSync;
  orgId: string;
  projectId: string;
  resourceRowId: string;
  otherResourceRowId: string;
  principalId: string;
  otherPrincipalId: string;
  tokenId: string;
  harnessBindingId: string;
}

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
  `);
  return database;
}

function runtimeOriginFixture(): RuntimeOriginFixture {
  const database = fixture();
  runSchemaMigrations(database, { throughVersion: 16 });
  const orgId = "org-a";
  const projectId = "project-a";
  const principalId = "principal-a";
  const otherPrincipalId = "principal-a-other";
  const tokenId = "token-a";
  const harnessBindingId = "harness-binding-a";
  const resourceRowId = "resource-harness-a";
  const otherResourceRowId = "resource-harness-b";

  database.prepare("INSERT INTO orgs (org_id) VALUES (?), (?)").run(orgId, "org-b");
  database.prepare(
    "INSERT INTO projects (project_id, org_id) VALUES (?, ?), (?, ?), (?, ?)",
  ).run(projectId, orgId, "project-a-other", orgId, "project-b", "org-b");
  database.prepare(
    `INSERT INTO service_principals (service_principal_id, org_id, disabled_at)
     VALUES (?, ?, NULL), (?, ?, NULL), (?, ?, NULL)`,
  ).run(principalId, orgId, otherPrincipalId, orgId, "principal-b", "org-b");
  database.prepare(
    `INSERT INTO service_tokens
       (token_id, service_principal_id, scopes_json, project_id)
     VALUES (?, ?, ?, ?)`,
  ).run(tokenId, principalId, JSON.stringify(["memory:harness:receipt:write"]), projectId);
  database.prepare(
    `INSERT INTO memory_harness_principal_bindings
       (binding_id, service_principal_id, org_id, project_id, harness_id, created_at)
     VALUES (?, ?, ?, ?, 'example-harness-a', ?),
            ('harness-binding-b', ?, ?, ?, 'example-harness-b', ?)`,
  ).run(
    harnessBindingId,
    principalId,
    orgId,
    projectId,
    NOW,
    principalId,
    orgId,
    projectId,
    NOW,
  );
  database.prepare(
    `INSERT INTO memory_v2_resources
       (resource_row_id, org_id, project_id, plane, resource_type,
        canonical_resource_id, display_label, provider, provider_resource_id,
        classification, retention_reference, source_authority, source_row_id,
        valid_from, valid_until, created_at, updated_at)
     VALUES (?, ?, ?, 'harness', 'harness', 'example-harness-a',
             'Example Harness A', NULL, NULL, 'internal', NULL,
             'memory_harness_principal_bindings', ?, ?, NULL, ?, ?),
            (?, ?, ?, 'harness', 'harness', 'example-harness-b',
             'Example Harness B', NULL, NULL, 'internal', NULL,
             'memory_harness_principal_bindings', 'harness-binding-b', ?, NULL, ?, ?)`,
  ).run(
    resourceRowId,
    orgId,
    projectId,
    harnessBindingId,
    NOW,
    NOW,
    NOW,
    otherResourceRowId,
    orgId,
    projectId,
    NOW,
    NOW,
    NOW,
  );
  database.prepare(
    `INSERT INTO memory_v2_service_token_resource_bindings
       (binding_id, token_id, service_principal_id, org_id, project_id,
        resource_row_id, operations_json, source_binding_type, source_binding_id, created_at)
     VALUES ('token-resource-binding-a', ?, ?, ?, ?, ?, ?,
             'harness_principal_binding', ?, ?)`,
  ).run(
    tokenId,
    principalId,
    orgId,
    projectId,
    resourceRowId,
    JSON.stringify(["receipt_write", "runtime_attestation_write"]),
    harnessBindingId,
    NOW,
  );

  const receiptId = "receipt-a";
  const producerRunId = "run-a";
  database.prepare(
    `INSERT INTO memory_run_receipts
       (receipt_id, org_id, project_id, producer_run_id, schema_major,
        idempotency_key, request_digest, receipt_json, response_json,
        producer_harness_id, repository_row_id, repository_id, base_sha,
        outcome_status, created_at)
     VALUES (?, ?, ?, ?, 'v1', 'idempotency-a', ?, '{}', '{}',
             'example-harness-a', NULL, NULL, NULL, 'completed', ?)`,
  ).run(receiptId, orgId, projectId, producerRunId, DIGEST, NOW);
  database.prepare(
    `INSERT INTO memory_v2_receipt_facets
       (receipt_id, org_id, project_id, plane, resource_row_id, facet_json, created_at)
     VALUES (?, ?, ?, 'harness', ?, '{}', ?)`,
  ).run(receiptId, orgId, projectId, resourceRowId, NOW);
  const scopeSnapshot = {
    schema_version: "pim.memory-scope-snapshot.harness.v2",
    plane: "harness",
    resource_binding: {
      resource_row_id: resourceRowId,
      organization_id: orgId,
      project_id: projectId,
      plane: "harness",
      resource_type: "harness",
      canonical_resource_id: "example-harness-a",
      provider: null,
      provider_resource_id: null,
      display_label: "Example Harness A",
      permitted_operations: ["receipt_write", "runtime_attestation_write"],
    },
    harness_id: "example-harness-a",
    harness_version: "harness-v1",
    workflow_version: "workflow-v1",
    adapter_version: "adapter-v1",
    configuration_id: "configuration-a",
    configuration_digest: DIGEST,
    scope_snapshot_digest: DIGEST,
  };
  const response = {
    schema_version: "pim.run-receipt-result.v2",
    receipt_id: receiptId,
    producer_run_id: producerRunId,
    request_digest: DIGEST,
    tenant: { organization_id: orgId, project_id: projectId },
    plane: "harness",
    resource_binding: scopeSnapshot.resource_binding,
    scope_snapshot_digest: DIGEST,
    status: "accepted",
    duplicate: false,
    candidate_results: [],
  };
  database.prepare(
    `INSERT INTO memory_v2_scope_snapshots
       (receipt_id, org_id, project_id, plane, resource_row_id,
        producer_principal_id, producer_run_id, request_digest, core_request_digest,
        scope_snapshot_json, scope_snapshot_digest, response_json, created_at)
     VALUES (?, ?, ?, 'harness', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    receiptId,
    orgId,
    projectId,
    resourceRowId,
    principalId,
    producerRunId,
    DIGEST,
    DIGEST,
    JSON.stringify(scopeSnapshot),
    DIGEST,
    JSON.stringify(response),
    NOW,
  );

  return {
    database,
    orgId,
    projectId,
    resourceRowId,
    otherResourceRowId,
    principalId,
    otherPrincipalId,
    tokenId,
    harnessBindingId,
  };
}

function insertCorroborationDomain(
  input: RuntimeOriginFixture,
  identity: Partial<{
    orgId: string;
    projectId: string;
    plane: string;
    resourceRowId: string;
    principalId: string;
  }> = {},
): void {
  input.database.prepare(
    `INSERT INTO memory_v2_corroboration_domains
       (corroboration_domain_id, org_id, project_id, plane, resource_row_id,
        producer_principal_id, provider, provider_domain_key, domain_digest, created_at)
     VALUES ('domain-a', ?, ?, ?, ?, ?, 'runtime_attestation',
             'provider-domain-a', ?, ?)`,
  ).run(
    identity.orgId ?? input.orgId,
    identity.projectId ?? input.projectId,
    identity.plane ?? "harness",
    identity.resourceRowId ?? input.resourceRowId,
    identity.principalId ?? input.principalId,
    DIGEST,
    NOW,
  );
}

describe("memory v2 runtime-origin migration", () => {
  it("keeps 016 absent through the prior ledger then registers its additive identity tables", () => {
    const database = fixture();
    runSchemaMigrations(database, { throughVersion: 15 });
    expect(database.prepare(
      "SELECT version, name FROM schema_migrations ORDER BY version DESC LIMIT 1",
    ).get()).toEqual({ version: 15, name: "memory_v2_scope_feedback" });
    expect(database.prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'memory_v2_origins'",
    ).get()).toBeUndefined();

    runSchemaMigrations(database, { throughVersion: 16 });
    expect(database.prepare(
      "SELECT version, name FROM schema_migrations ORDER BY version DESC LIMIT 1",
    ).get()).toEqual({ version: 16, name: "memory_v2_runtime_origins" });
    const tables = new Set((database.prepare(
      `SELECT name FROM sqlite_schema
       WHERE type = 'table' AND name LIKE 'memory_v2_%'`,
    ).all() as unknown as Array<{ name: string }>).map((row) => row.name));
    for (const table of [
      "memory_v2_corroboration_domains",
      "memory_v2_origins",
      "memory_v2_origin_derivations",
      "memory_v2_origin_roots",
      "memory_v2_candidate_origins",
      "memory_v2_review_signals",
    ]) expect(tables.has(table)).toBe(true);

    const originColumns = new Set((database.prepare(
      "PRAGMA table_info(memory_v2_origins)",
    ).all() as unknown as Array<{ name: string }>).map((row) => row.name));
    for (const column of [
      "receipt_id",
      "producer_run_id",
      "evidence_ref_id",
      "request_digest",
      "candidate_set_digest",
      "client_candidate_ids_json",
      "derivation_parent_refs_json",
      "effective_root_origin_id",
      "root_set_digest",
      "root_count",
    ]) expect(originColumns.has(column)).toBe(true);

    const signalColumns = new Set((database.prepare(
      "PRAGMA table_info(memory_v2_review_signals)",
    ).all() as unknown as Array<{ name: string }>).map((row) => row.name));
    for (const column of [
      "first_corroboration_domain_id",
      "repeated_corroboration_domain_id",
      "first_producer_principal_id",
      "repeated_producer_principal_id",
      "first_producer_run_id",
      "repeated_producer_run_id",
    ]) expect(signalColumns.has(column)).toBe(true);

    const immutableGuards = database.prepare(
      `SELECT COUNT(*) AS count FROM sqlite_schema
       WHERE type = 'trigger' AND name LIKE 'memory_v2_%_no_delete'`,
    ).get() as { count: number };
    expect(immutableGuards.count).toBeGreaterThanOrEqual(6);
    const corroborationGuard = database.prepare(
      `SELECT sql FROM sqlite_schema
       WHERE type = 'trigger' AND name = 'memory_v2_corroboration_domains_validate_binding'`,
    ).get() as { sql: string };
    expect(corroborationGuard.sql).toContain("memory_v2_scope_snapshots");
    expect(corroborationGuard.sql).not.toContain("disabled_at");
    expect(corroborationGuard.sql).not.toContain("memory_harness_principal_bindings");
    expect(corroborationGuard.sql).not.toContain("valid_until");
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();
  });

  it("replays 016 without changing its immutable migration ledger", () => {
    const database = fixture();
    runSchemaMigrations(database, { throughVersion: 16 });
    const before = database.prepare(
      "SELECT version, name, checksum FROM schema_migrations WHERE version = 16",
    ).get();
    runSchemaMigrations(database, { throughVersion: 16 });
    expect(database.prepare(
      "SELECT version, name, checksum FROM schema_migrations WHERE version = 16",
    ).get()).toEqual(before);
    database.close();
  });

  it.each([
    "disabled_principal",
    "removed_token",
    "removed_token_resource_binding",
    "removed_harness_binding",
    "retired_resource",
  ] as const)("preserves the request snapshot after %s", (mutation) => {
    const seeded = runtimeOriginFixture();
    if (mutation === "disabled_principal") {
      seeded.database.prepare(
        "UPDATE service_principals SET disabled_at = ? WHERE service_principal_id = ?",
      ).run(NOW, seeded.principalId);
    } else if (mutation === "removed_token") {
      seeded.database.prepare("DELETE FROM service_tokens WHERE token_id = ?").run(seeded.tokenId);
    } else if (mutation === "removed_token_resource_binding") {
      seeded.database.prepare(
        "DELETE FROM memory_v2_service_token_resource_bindings WHERE token_id = ?",
      ).run(seeded.tokenId);
    } else if (mutation === "removed_harness_binding") {
      seeded.database.exec("DROP TRIGGER memory_harness_principal_bindings_no_delete");
      seeded.database.prepare(
        "DELETE FROM memory_harness_principal_bindings WHERE binding_id = ?",
      ).run(seeded.harnessBindingId);
    } else {
      seeded.database.prepare(
        "UPDATE memory_v2_resources SET valid_until = ?, updated_at = ? WHERE resource_row_id = ?",
      ).run(NOW, NOW, seeded.resourceRowId);
    }

    expect(() => insertCorroborationDomain(seeded)).not.toThrow();
    expect(seeded.database.prepare(
      "SELECT producer_principal_id FROM memory_v2_corroboration_domains WHERE corroboration_domain_id = 'domain-a'",
    ).get()).toEqual({ producer_principal_id: seeded.principalId });
    expect(seeded.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    seeded.database.close();
  });

  it.each([
    ["organization", { orgId: "org-b" }],
    ["project", { projectId: "project-a-other" }],
    ["plane", { plane: "codebase" }],
    ["resource", { resourceRowId: "resource-harness-b" }],
    ["principal", { principalId: "principal-a-other" }],
  ] as const)("rejects a structurally wrong %s identity", (_label, identity) => {
    const seeded = runtimeOriginFixture();
    expect(() => insertCorroborationDomain(seeded, identity)).toThrow(
      /v2 corroboration domain binding mismatch/,
    );
    expect(seeded.database.prepare(
      "SELECT 1 FROM memory_v2_corroboration_domains WHERE corroboration_domain_id = 'domain-a'",
    ).get()).toBeUndefined();
    seeded.database.close();
  });
});
