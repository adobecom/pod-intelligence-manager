import type { DatabaseSync } from "node:sqlite";

const EXPERIMENT_TABLES = [
  "memory_prompt_policies",
  "memory_release_gate_decisions",
] as const;

/** Run inside migration 018's BEGIN IMMEDIATE transaction before dropping either table. */
export function assertMemoryExperimentCleanupPreconditions(database: DatabaseSync): void {
  for (const table of EXPERIMENT_TABLES) {
    const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      count: number;
    };
    if (row.count !== 0) {
      throw new Error(
        `Schema migration 18 requires verified-empty ${table}; found ${row.count} row(s)`,
      );
    }
  }
}

export const MEMORY_EXPERIMENT_CLEANUP_MIGRATION_SQL = `
  DROP TRIGGER IF EXISTS memory_release_gate_decisions_no_update;
  DROP TRIGGER IF EXISTS memory_release_gate_decisions_no_delete;
  DROP INDEX IF EXISTS idx_memory_release_gate_decisions_project;
  DROP TABLE memory_release_gate_decisions;
  DROP TABLE memory_prompt_policies;
`;
