import { afterAll, describe, expect, it, vi } from "vitest";

const { testDb } = vi.hoisted(() => {
  const { DatabaseSync } = require("node:sqlite");
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = OFF");
  database.exec(`
    CREATE TABLE users (
      user_id TEXT PRIMARY KEY,
      ims_user_id TEXT UNIQUE,
      email TEXT NOT NULL,
      display_name TEXT,
      is_service INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_login_at TEXT
    );
    CREATE TABLE orgs (
      org_id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      created_by_user_id TEXT NOT NULL REFERENCES users(user_id),
      created_at TEXT NOT NULL
    );
    CREATE TABLE projects (
      project_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL
    );
    INSERT INTO users
      (user_id, ims_user_id, email, display_name, is_service, created_at, last_login_at)
    VALUES ('user-1', NULL, 'user-1@example.test', 'Fixture owner', 0, '2026-01-01', NULL);
    INSERT INTO orgs (org_id, slug, name, created_by_user_id, created_at)
    VALUES ('org-1', 'org-1', 'Fixture org', 'user-1', '2026-01-01');
    INSERT INTO projects (project_id, name, description, created_at)
    VALUES ('project-1', 'Fixture project', NULL, '2026-01-01');

    CREATE TABLE project_evidence_items (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_url TEXT,
      source_title TEXT NOT NULL,
      summary TEXT NOT NULL,
      body TEXT NOT NULL,
      author TEXT,
      occurred_at TEXT NOT NULL,
      ingested_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      confidence_score REAL NOT NULL DEFAULT 0.0,
      promotable INTEGER NOT NULL DEFAULT 0,
      promoted_node_id TEXT,
      UNIQUE (org_id, project_id, source, source_id)
    );

    CREATE TABLE project_search_documents (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_url TEXT,
      title TEXT NOT NULL,
      author TEXT,
      status TEXT,
      occurred_at TEXT,
      ingested_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      permissions_json TEXT NOT NULL DEFAULT '{}',
      freshness_state TEXT NOT NULL DEFAULT 'fresh',
      UNIQUE (org_id, project_id, source, source_id)
    );

    INSERT INTO project_evidence_items
      (id, org_id, project_id, source, source_type, source_id, source_title,
       summary, body, occurred_at, ingested_at)
    VALUES
      ('evidence-1', 'org-1', 'project-1', 'manual', 'note', 'legacy-evidence',
       'Legacy evidence', 'Legacy summary', 'Legacy body', '2026-01-01', '2026-01-01');

    INSERT INTO project_search_documents
      (id, org_id, project_id, source, source_type, source_id, title,
       ingested_at, updated_at, content_hash)
    VALUES
      ('document-1', 'org-1', 'project-1', 'manual', 'note', 'legacy-document',
       'Legacy document', '2026-01-01', '2026-01-01', 'legacy-hash');
  `);
  return { testDb: database };
});

vi.mock("../connection.js", () => ({
  default: testDb,
}));

import { createTables } from "../schema.js";

afterAll(() => {
  testDb.close();
});

describe("project search provenance schema migration", () => {
  it("upgrades main-era tables before creating source identity indexes", () => {
    expect(() => createTables()).not.toThrow();
    expect(() => createTables()).not.toThrow();

    for (const table of ["project_evidence_items", "project_search_documents"]) {
      const columns = testDb.prepare(`PRAGMA table_info(${table})`).all()
        .map((column: { name: string }) => column.name);
      expect(columns).toEqual(expect.arrayContaining(["source_instance", "native_id"]));
    }

    expect(testDb.prepare("PRAGMA index_list(project_evidence_items)").all()
      .map((index: { name: string }) => index.name))
      .toContain("idx_project_evidence_source_identity");
    expect(testDb.prepare("PRAGMA index_list(project_search_documents)").all()
      .map((index: { name: string }) => index.name))
      .toContain("idx_project_search_docs_source_identity");

    expect(testDb.prepare(
      "SELECT source_instance, native_id FROM project_evidence_items WHERE id = 'evidence-1'",
    ).get()).toEqual({ source_instance: "legacy", native_id: null });
    expect(testDb.prepare(
      "SELECT source_instance, native_id FROM project_search_documents WHERE id = 'document-1'",
    ).get()).toEqual({ source_instance: "legacy", native_id: null });
  });
});
