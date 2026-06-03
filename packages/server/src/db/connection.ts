import { DatabaseSync } from "node:sqlite";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const dbPath = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(path.resolve(__dirname, "../../../../.data"), "pim.db");

const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new DatabaseSync(dbPath);

db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
// Without this, write collisions throw SQLITE_BUSY immediately (default 0ms).
// 5s retry window absorbs normal write contention under concurrent load.
db.exec("PRAGMA busy_timeout = 5000");

type NonPromise<T> = T extends PromiseLike<unknown> ? never : T;

let savepointSeq = 0;

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && "then" in value && typeof (value as { then?: unknown }).then === "function";
}

function runSyncTransaction<T>(beginSql: string, fn: () => T): T {
  const nested = db.isTransaction;
  const savepoint = nested ? `pim_tx_${++savepointSeq}` : "";
  let settled = false;

  db.exec(nested ? `SAVEPOINT ${savepoint}` : beginSql);
  try {
    const result = fn();
    if (isPromiseLike(result)) {
      if (nested) {
        db.exec(`ROLLBACK TO ${savepoint}`);
        db.exec(`RELEASE ${savepoint}`);
      } else {
        db.exec("ROLLBACK");
      }
      settled = true;
      throw new TypeError("Database transaction callbacks must be synchronous");
    }
    db.exec(nested ? `RELEASE ${savepoint}` : "COMMIT");
    settled = true;
    return result;
  } catch (e) {
    if (!settled) {
      if (nested) {
        db.exec(`ROLLBACK TO ${savepoint}`);
        db.exec(`RELEASE ${savepoint}`);
      } else {
        db.exec("ROLLBACK");
      }
    }
    throw e;
  }
}

export function withTransaction<T>(fn: () => NonPromise<T>): NonPromise<T> {
  return runSyncTransaction("BEGIN", fn) as NonPromise<T>;
}

export function withImmediateTransaction<T>(fn: () => NonPromise<T>): NonPromise<T> {
  return runSyncTransaction("BEGIN IMMEDIATE", fn) as NonPromise<T>;
}

export default db;
