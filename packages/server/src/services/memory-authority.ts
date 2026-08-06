import db from "../db/connection.js";

export type MemoryAuthority = "legacy" | "migration_locked" | "canonical";

export interface MemoryAuthorityState {
  authority: MemoryAuthority;
  legacyWritesFrozen: boolean;
  revision: number;
}

const DEFAULT_AUTHORITY_STATE: MemoryAuthorityState = {
  authority: "legacy",
  legacyWritesFrozen: false,
  revision: 0,
};

interface AuthorityTransitionRow {
  revision: number;
  to_authority: MemoryAuthority;
  legacy_writes_frozen: number;
}

function tableExists(table: string): boolean {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table));
}

export function getMemoryAuthorityState(): MemoryAuthorityState {
  if (!tableExists("memory_authority_transitions")) return { ...DEFAULT_AUTHORITY_STATE };
  const row = db.prepare(
    `SELECT revision, to_authority, legacy_writes_frozen
     FROM memory_authority_transitions
     ORDER BY revision DESC
     LIMIT 1`,
  ).get() as AuthorityTransitionRow | undefined;
  if (!row) return { ...DEFAULT_AUTHORITY_STATE };
  return {
    authority: row.to_authority,
    legacyWritesFrozen: row.legacy_writes_frozen === 1,
    revision: row.revision,
  };
}

export function legacyMemoryWritesFrozen(): boolean {
  return getMemoryAuthorityState().legacyWritesFrozen;
}

export class LegacyMemoryAuthorityFrozenError extends Error {
  readonly code = "legacy_authority_frozen";
  readonly statusCode = 409;

  constructor(readonly operation: string) {
    super(`Legacy memory authority is frozen; ${operation} cannot mutate it`);
    this.name = "LegacyMemoryAuthorityFrozenError";
  }
}

export class CanonicalMemoryAuthorityRequiredError extends Error {
  readonly code = "canonical_authority_required";

  constructor(readonly state: MemoryAuthorityState) {
    super(
      `Canonical memory authority is required; found ${state.authority} at revision ${state.revision}`,
    );
    this.name = "CanonicalMemoryAuthorityRequiredError";
  }
}

export function assertLegacyMemoryWritable(operation: string): void {
  if (legacyMemoryWritesFrozen()) {
    throw new LegacyMemoryAuthorityFrozenError(operation);
  }
}

export function assertCanonicalMemoryAuthorityRequired(required =
  process.env.PIM_MEMORY_REQUIRE_CANONICAL_AUTHORITY === "1"): MemoryAuthorityState {
  const state = getMemoryAuthorityState();
  if (required && (state.authority !== "canonical" || !state.legacyWritesFrozen)) {
    throw new CanonicalMemoryAuthorityRequiredError(state);
  }
  return state;
}

function installCandidateBarriers(table: "memory_candidates" | "project_memory_candidates"): void {
  if (!tableExists(table)) return;
  const prefix = `${table}_legacy_authority`;
  const frozen = `COALESCE((
    SELECT legacy_writes_frozen
    FROM memory_authority_transitions
    ORDER BY revision DESC
    LIMIT 1
  ), 0) = 1`;
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS ${prefix}_no_insert
      BEFORE INSERT ON ${table}
      WHEN ${frozen}
      BEGIN SELECT RAISE(ABORT, 'legacy_authority_frozen'); END;

    CREATE TRIGGER IF NOT EXISTS ${prefix}_no_update
      BEFORE UPDATE ON ${table}
      WHEN ${frozen}
      BEGIN SELECT RAISE(ABORT, 'legacy_authority_frozen'); END;

    CREATE TRIGGER IF NOT EXISTS ${prefix}_no_delete
      BEFORE DELETE ON ${table}
      WHEN ${frozen}
      BEGIN SELECT RAISE(ABORT, 'legacy_authority_frozen'); END;
  `);
}

export function installLegacySqlWriteBarriers(): void {
  if (!tableExists("memory_authority_transitions")) return;
  installCandidateBarriers("memory_candidates");
  installCandidateBarriers("project_memory_candidates");

  if (!tableExists("project_evidence_items")) return;
  const frozen = `COALESCE((
    SELECT legacy_writes_frozen
    FROM memory_authority_transitions
    ORDER BY revision DESC
    LIMIT 1
  ), 0) = 1`;
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS project_evidence_items_legacy_authority_no_promoted_insert
      BEFORE INSERT ON project_evidence_items
      WHEN ${frozen} AND NEW.promoted_node_id IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'legacy_authority_frozen'); END;

    CREATE TRIGGER IF NOT EXISTS project_evidence_items_legacy_authority_no_promoted_update
      BEFORE UPDATE OF promoted_node_id ON project_evidence_items
      WHEN ${frozen}
        AND NEW.promoted_node_id IS NOT OLD.promoted_node_id
      BEGIN SELECT RAISE(ABORT, 'legacy_authority_frozen'); END;
  `);
}
