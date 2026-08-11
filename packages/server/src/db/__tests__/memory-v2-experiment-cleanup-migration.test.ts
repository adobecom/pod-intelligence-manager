import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { runSchemaMigrations } from "../migrations.js";

const NOW = "2026-08-10T12:00:00.000Z";

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

    INSERT INTO orgs VALUES ('org-a');
    INSERT INTO projects VALUES ('project-a', 'org-a');
  `);
  runSchemaMigrations(database, { throughVersion: 17 });
  return database;
}

function schemaNames(database: DatabaseSync): string[] {
  return (database.prepare(`
    SELECT name FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as unknown as Array<{ name: string }>).map((row) => row.name);
}

describe("memory experiment cleanup migration", () => {
  it("removes only the two verified-empty experiment tables", () => {
    const database = fixture();
    const before = schemaNames(database);
    expect(before).toContain("memory_prompt_policies");
    expect(before).toContain("memory_release_gate_decisions");

    runSchemaMigrations(database, { throughVersion: 18 });

    expect(database.prepare(
      "SELECT version, name FROM schema_migrations WHERE version = 18",
    ).get()).toEqual({ version: 18, name: "memory_experiment_cleanup" });
    const after = schemaNames(database);
    const removed = before.filter((name) => !after.includes(name)).sort();
    expect(removed).toEqual([
      "idx_memory_release_gate_decisions_project",
      "memory_prompt_policies",
      "memory_release_gate_decisions",
      "memory_release_gate_decisions_no_delete",
      "memory_release_gate_decisions_no_update",
    ]);
    for (const preserved of [
      "memory_run_receipts",
      "memory_candidate_decisions",
      "memory_evidence_refs",
      "memory_outbox",
      "memory_erasure_requests",
      "memory_transitions",
      "memory_v2_record_trust",
      "memory_v2_reverification_state",
    ]) {
      expect(after).toContain(preserved);
    }
    expect(after.some((name) => name.startsWith("memory_v2_exposure"))).toBe(false);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    database.close();
  });

  it.each([
    {
      table: "memory_prompt_policies",
      insert: `
        INSERT INTO memory_prompt_policies (
          org_id, project_id, policy_revision, enabled, kill_switch,
          automatic_activation_enabled, canary_percentage,
          allowed_repository_ids_json, allowed_kinds_json,
          max_prompt_items, max_prompt_tokens, updated_by_principal_id,
          created_at, updated_at
        ) VALUES (
          'org-a', 'project-a', 1, 0, 1, 0, 0, '[]', '[]', 1, 1,
          'migration-test', '${NOW}', '${NOW}'
        )
      `,
    },
    {
      table: "memory_release_gate_decisions",
      insert: `
        INSERT INTO memory_release_gate_decisions (
          decision_id, org_id, project_id, stage, decision, status,
          metric_snapshot_json, dataset_digest, reasons_json, created_at
        ) VALUES (
          'decision-a', 'org-a', 'project-a', 'pre_canary', 'pause',
          'insufficient_data', '{}', 'sha256:test', '[]', '${NOW}'
        )
      `,
    },
  ])("refuses cleanup when $table is not empty and rolls the migration back", ({ table, insert }) => {
    const database = fixture();
    database.exec(insert);

    expect(() => runSchemaMigrations(database, { throughVersion: 18 }))
      .toThrow(new RegExp(`verified-empty ${table}`));

    expect(database.prepare(
      "SELECT 1 FROM schema_migrations WHERE version = 18",
    ).get()).toBeUndefined();
    expect(database.prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?",
    ).get(table)).toEqual({ 1: 1 });
    expect(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get())
      .toEqual({ count: 1 });
    database.close();
  });

  it("replays 018 without changing its immutable ledger", () => {
    const database = fixture();
    runSchemaMigrations(database, { throughVersion: 18 });
    const ledger = database.prepare(
      "SELECT version, name, checksum FROM schema_migrations WHERE version = 18",
    ).get();

    runSchemaMigrations(database, { throughVersion: 18 });

    expect(database.prepare(
      "SELECT version, name, checksum FROM schema_migrations WHERE version = 18",
    ).get()).toEqual(ledger);
    database.close();
  });
});
