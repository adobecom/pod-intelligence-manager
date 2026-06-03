import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpDir: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pim-db-"));
  vi.stubEnv("DB_PATH", path.join(tmpDir, "test.db"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

describe("database transaction helpers", () => {
  it("uses savepoints for nested immediate transactions", async () => {
    const { default: db, withTransaction, withImmediateTransaction } = await import("../connection.js");
    db.exec("CREATE TABLE tx_test (id TEXT PRIMARY KEY, value TEXT NOT NULL)");

    withTransaction(() => {
      db.prepare("INSERT INTO tx_test (id, value) VALUES (?, ?)").run("outer", "ok");
      withImmediateTransaction(() => {
        db.prepare("INSERT INTO tx_test (id, value) VALUES (?, ?)").run("inner", "ok");
      });
    });

    const rows = db.prepare("SELECT id FROM tx_test ORDER BY id").all() as Array<{ id: string }>;
    expect(rows.map((row) => row.id)).toEqual(["inner", "outer"]);
    db.close();
  });

  it("rejects async transaction callbacks before committing", async () => {
    const { default: db, withImmediateTransaction } = await import("../connection.js");
    db.exec("CREATE TABLE tx_async_test (id TEXT PRIMARY KEY)");

    const asyncCallback = (async () => {
      db.prepare("INSERT INTO tx_async_test (id) VALUES (?)").run("should-rollback");
    }) as unknown as () => never;

    expect(() => withImmediateTransaction(asyncCallback)).toThrow("Database transaction callbacks must be synchronous");

    const rowCount = db.prepare("SELECT COUNT(*) AS count FROM tx_async_test").get() as { count: number };
    expect(rowCount.count).toBe(0);
    db.close();
  });
});
