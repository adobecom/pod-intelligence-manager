import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import db from "./connection.js";
import { MEMORY_READ_PATH_MIGRATION_SQL } from "./migrations/001-memory-read-path.js";
import { MEMORY_RECEIPT_CANDIDATE_LEDGER_MIGRATION_SQL } from "./migrations/002-memory-receipt-candidate-ledger.js";
import { MEMORY_TRUST_PATH_MIGRATION_SQL } from "./migrations/003-memory-trust-path.js";
import { MEMORY_FEEDBACK_REVIEW_MIGRATION_SQL } from "./migrations/004-memory-feedback-review.js";
import { MEMORY_PROMPT_CANARY_MIGRATION_SQL } from "./migrations/005-memory-prompt-canary.js";
import { MEMORY_SERVICE_REPOSITORY_BINDINGS_MIGRATION_SQL } from "./migrations/006-memory-service-repository-bindings.js";
import { MEMORY_INBOX_RESULTS_MIGRATION_SQL } from "./migrations/007-memory-inbox-results.js";
import { MEMORY_HARNESS_SHADOW_MIGRATION_SQL } from "./migrations/008-memory-harness-shadow.js";
import { MEMORY_OFFLINE_LEGACY_CUTOVER_MIGRATION_SQL } from "./migrations/009-memory-offline-legacy-cutover.js";
import { MEMORY_RETENTION_ERASURE_MIGRATION_SQL } from "./migrations/010-memory-retention-erasure.js";
import { MEMORY_ATTESTATION_DIFF_PROOF_MIGRATION_SQL } from "./migrations/011-memory-attestation-diff-proof.js";
import { MEMORY_V2_RESOURCES_MIGRATION_SQL } from "./migrations/012-memory-v2-resources.js";
import { MEMORY_V2_FACETS_MIGRATION_SQL } from "./migrations/013-memory-v2-facets.js";
import { MEMORY_V2_RETRIEVAL_PACKS_MIGRATION_SQL } from "./migrations/014-memory-v2-retrieval-packs.js";
import { MEMORY_V2_SCOPE_FEEDBACK_MIGRATION_SQL } from "./migrations/015-memory-v2-scope-feedback.js";
import { MEMORY_V2_RUNTIME_ORIGINS_MIGRATION_SQL } from "./migrations/016-memory-v2-runtime-origins.js";
import { MEMORY_V2_REVERIFICATION_MIGRATION_SQL } from "./migrations/017-memory-v2-reverification.js";
import {
  assertMemoryExperimentCleanupPreconditions,
  MEMORY_EXPERIMENT_CLEANUP_MIGRATION_SQL,
} from "./migrations/018-memory-experiment-cleanup.js";

interface Migration {
  version: number;
  name: string;
  sql: string;
  requiresForeignKeysOff?: boolean;
  preflight?: (database: DatabaseSync) => void;
}

export const MEMORY_V2_OFFLINE_CUTOVER_CONFIRMATION_ENV =
  "PIM_MEMORY_V2_OFFLINE_CUTOVER_CONFIRMATION";
export const MEMORY_V2_OFFLINE_CUTOVER_CONFIRMATION =
  "apply-memory-v2-012-013";

function assertOfflineMemoryV2CutoverConfirmed(migration: Migration): void {
  if (process.env.NODE_ENV !== "production" || migration.version < 12 || migration.version > 13) {
    return;
  }
  if (process.env[MEMORY_V2_OFFLINE_CUTOVER_CONFIRMATION_ENV]
      === MEMORY_V2_OFFLINE_CUTOVER_CONFIRMATION) {
    return;
  }
  throw new Error(
    `Schema migration ${migration.version} requires the stopped-writer memory v2 offline cutover; `
      + `set ${MEMORY_V2_OFFLINE_CUTOVER_CONFIRMATION_ENV}=`
      + `${MEMORY_V2_OFFLINE_CUTOVER_CONFIRMATION} only for the confirmed one-shot cutover`,
  );
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "memory_read_path",
    sql: MEMORY_READ_PATH_MIGRATION_SQL,
  },
  {
    version: 2,
    name: "memory_receipt_candidate_ledger",
    sql: MEMORY_RECEIPT_CANDIDATE_LEDGER_MIGRATION_SQL,
  },
  {
    version: 3,
    name: "memory_trust_path",
    sql: MEMORY_TRUST_PATH_MIGRATION_SQL,
  },
  {
    version: 4,
    name: "memory_feedback_review",
    sql: MEMORY_FEEDBACK_REVIEW_MIGRATION_SQL,
  },
  {
    version: 5,
    name: "memory_prompt_canary",
    sql: MEMORY_PROMPT_CANARY_MIGRATION_SQL,
  },
  {
    version: 6,
    name: "memory_service_repository_bindings",
    sql: MEMORY_SERVICE_REPOSITORY_BINDINGS_MIGRATION_SQL,
  },
  {
    version: 7,
    name: "memory_inbox_results",
    sql: MEMORY_INBOX_RESULTS_MIGRATION_SQL,
  },
  {
    version: 8,
    name: "memory_harness_shadow",
    sql: MEMORY_HARNESS_SHADOW_MIGRATION_SQL,
    requiresForeignKeysOff: true,
  },
  {
    version: 9,
    name: "memory_offline_legacy_cutover",
    sql: MEMORY_OFFLINE_LEGACY_CUTOVER_MIGRATION_SQL,
  },
  {
    version: 10,
    name: "memory_retention_erasure",
    sql: MEMORY_RETENTION_ERASURE_MIGRATION_SQL,
  },
  {
    version: 11,
    name: "memory_attestation_diff_proof",
    sql: MEMORY_ATTESTATION_DIFF_PROOF_MIGRATION_SQL,
  },
  {
    version: 12,
    name: "memory_v2_resources",
    sql: MEMORY_V2_RESOURCES_MIGRATION_SQL,
  },
  {
    version: 13,
    name: "memory_v2_facets",
    sql: MEMORY_V2_FACETS_MIGRATION_SQL,
  },
  {
    version: 14,
    name: "memory_v2_retrieval_packs",
    sql: MEMORY_V2_RETRIEVAL_PACKS_MIGRATION_SQL,
  },
  {
    version: 15,
    name: "memory_v2_scope_feedback",
    sql: MEMORY_V2_SCOPE_FEEDBACK_MIGRATION_SQL,
  },
  {
    version: 16,
    name: "memory_v2_runtime_origins",
    sql: MEMORY_V2_RUNTIME_ORIGINS_MIGRATION_SQL,
  },
  {
    version: 17,
    name: "memory_v2_reverification",
    sql: MEMORY_V2_REVERIFICATION_MIGRATION_SQL,
  },
  {
    version: 18,
    name: "memory_experiment_cleanup",
    sql: MEMORY_EXPERIMENT_CLEANUP_MIGRATION_SQL,
    preflight: assertMemoryExperimentCleanupPreconditions,
  },
];

function checksum(migration: Migration): string {
  return createHash("sha256")
    .update(`${migration.version}\0${migration.name}\0${migration.sql}`, "utf8")
    .digest("hex");
}

export function runSchemaMigrations(
  database: DatabaseSync = db,
  options: { throughVersion?: number } = {},
): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  const findApplied = database.prepare(
    "SELECT version, name, checksum FROM schema_migrations WHERE version = ?",
  );
  const recordApplied = database.prepare(
    "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
  );

  for (const migration of MIGRATIONS) {
    if (options.throughVersion !== undefined && migration.version > options.throughVersion) continue;
    const expectedChecksum = checksum(migration);
    const applied = findApplied.get(migration.version) as
      | { version: number; name: string; checksum: string }
      | undefined;
    if (applied) {
      if (applied.name !== migration.name || applied.checksum !== expectedChecksum) {
        throw new Error(`Schema migration ${migration.version} does not match its recorded immutable checksum`);
      }
      continue;
    }

    // 012/013 backfill canonical memory authority. They may be replayed and
    // validated during normal production starts, but their first application
    // is an operator-confirmed, stopped-writer cutover only.
    assertOfflineMemoryV2CutoverConfirmed(migration);

    const foreignKeysRow = migration.requiresForeignKeysOff
      ? database.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }
      : null;
    let transactionStarted = false;
    try {
      if (migration.requiresForeignKeysOff) database.exec("PRAGMA foreign_keys = OFF");
      database.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      migration.preflight?.(database);
      database.exec(migration.sql);
      if (migration.requiresForeignKeysOff) {
        const violations = database.prepare("PRAGMA foreign_key_check").all();
        if (violations.length > 0) {
          throw new Error(`Schema migration ${migration.version} introduced foreign-key violations`);
        }
      }
      recordApplied.run(migration.version, migration.name, expectedChecksum, new Date().toISOString());
      database.exec("COMMIT");
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) database.exec("ROLLBACK");
      throw error;
    } finally {
      if (migration.requiresForeignKeysOff) {
        database.exec(`PRAGMA foreign_keys = ${foreignKeysRow?.foreign_keys === 1 ? "ON" : "OFF"}`);
      }
    }
  }
}

export function memorySchemaMigrationCount(): number {
  return MIGRATIONS.length;
}
