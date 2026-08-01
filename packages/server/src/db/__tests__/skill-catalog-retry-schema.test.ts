import { afterAll, describe, expect, it, vi } from "vitest";

const { testDb } = vi.hoisted(() => {
  const { DatabaseSync } = require("node:sqlite");
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE skill_catalog_blobs (
      org_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      blob_sha TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      description TEXT,
      content_hash TEXT NOT NULL,
      redacted_text TEXT,
      embedding_json TEXT,
      embedding_status TEXT NOT NULL DEFAULT 'pending',
      matcher_version TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (source_id, blob_sha)
    )
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

describe("skill catalog embedding retry schema migration", () => {
  it("adds retry columns with backward-compatible defaults", () => {
    expect(() => createTables()).not.toThrow();
    expect(() => createTables()).not.toThrow();

    const columns = testDb
      .prepare("PRAGMA table_info(skill_catalog_blobs)")
      .all() as Array<{ name: string; notnull: number; dflt_value: string | null }>;
    expect(columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "embedding_attempts",
          notnull: 1,
          dflt_value: "0",
        }),
        expect.objectContaining({
          name: "next_retry_at",
          notnull: 0,
          dflt_value: null,
        }),
      ]),
    );

    testDb
      .prepare(
        `INSERT INTO skill_catalog_blobs
           (org_id, source_id, blob_sha, normalized_name, content_hash,
            embedding_status, matcher_version, created_at)
         VALUES ('org', 'source', 'blob', 'name', 'hash', 'failed', 'v1', 'now')`,
      )
      .run();
    expect(
      testDb
        .prepare(
          `SELECT embedding_attempts, next_retry_at
           FROM skill_catalog_blobs
           WHERE source_id = 'source' AND blob_sha = 'blob'`,
        )
        .get(),
    ).toEqual({
      embedding_attempts: 0,
      next_retry_at: null,
    });
  });
});
