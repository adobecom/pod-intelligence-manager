export const MEMORY_OFFLINE_LEGACY_CUTOVER_MIGRATION_SQL = `
  CREATE TABLE memory_legacy_import_runs (
    import_run_id TEXT PRIMARY KEY,
    inventory_digest TEXT NOT NULL,
    resolution_digest TEXT NOT NULL,
    source_bundle_digest TEXT NOT NULL,
    source_item_count INTEGER NOT NULL CHECK (source_item_count >= 0),
    imported_count INTEGER NOT NULL CHECK (imported_count >= 0),
    pending_count INTEGER NOT NULL CHECK (pending_count >= 0),
    quarantined_count INTEGER NOT NULL CHECK (quarantined_count >= 0),
    deduplicated_count INTEGER NOT NULL CHECK (deduplicated_count >= 0),
    report_json TEXT NOT NULL CHECK (json_valid(report_json)),
    created_at TEXT NOT NULL,
    CHECK (length(import_run_id) > 0),
    CHECK (
      length(inventory_digest) = 71
      AND substr(inventory_digest, 1, 7) = 'sha256:'
      AND substr(inventory_digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    CHECK (
      length(resolution_digest) = 71
      AND substr(resolution_digest, 1, 7) = 'sha256:'
      AND substr(resolution_digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    CHECK (
      length(source_bundle_digest) = 71
      AND substr(source_bundle_digest, 1, 7) = 'sha256:'
      AND substr(source_bundle_digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    CHECK (
      imported_count + pending_count + quarantined_count + deduplicated_count
        = source_item_count
    )
  );

  CREATE TRIGGER memory_legacy_import_runs_no_update
    BEFORE UPDATE ON memory_legacy_import_runs
    BEGIN SELECT RAISE(ABORT, 'memory legacy import runs are append-only'); END;

  CREATE TRIGGER memory_legacy_import_runs_no_delete
    BEFORE DELETE ON memory_legacy_import_runs
    BEGIN SELECT RAISE(ABORT, 'memory legacy import runs are append-only'); END;

  CREATE TABLE memory_legacy_import_items (
    import_item_id TEXT PRIMARY KEY,
    import_run_id TEXT NOT NULL REFERENCES memory_legacy_import_runs(import_run_id),
    source_kind TEXT NOT NULL CHECK (source_kind IN (
      'graph_node','project_candidate','agent_candidate','project_evidence'
    )),
    source_key TEXT NOT NULL,
    legacy_id TEXT NOT NULL,
    legacy_node_id TEXT,
    org_id TEXT NOT NULL,
    project_id TEXT,
    plane TEXT CHECK (plane IS NULL OR plane IN ('codebase','harness','org')),
    graph_version INTEGER CHECK (graph_version IS NULL OR graph_version >= 0),
    snapshot_sha256 TEXT,
    content_digest TEXT NOT NULL,
    source_timestamp TEXT,
    source_payload_json TEXT NOT NULL CHECK (json_valid(source_payload_json)),
    source_provenance_json TEXT NOT NULL CHECK (json_valid(source_provenance_json)),
    mapped_payload_json TEXT CHECK (mapped_payload_json IS NULL OR json_valid(mapped_payload_json)),
    disposition TEXT NOT NULL CHECK (disposition IN (
      'active','pending_validation','quarantined','deduplicated'
    )),
    reason_code TEXT NOT NULL,
    canonical_record_id TEXT,
    canonical_record_version INTEGER CHECK (
      canonical_record_version IS NULL OR canonical_record_version >= 1
    ),
    duplicate_of_item_id TEXT REFERENCES memory_legacy_import_items(import_item_id),
    supersedes_legacy_id TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (source_kind, source_key),
    FOREIGN KEY (canonical_record_id, canonical_record_version)
      REFERENCES memory_record_versions(record_id, record_version),
    CHECK (length(import_item_id) > 0),
    CHECK (length(source_key) > 0),
    CHECK (length(legacy_id) > 0),
    CHECK (length(org_id) > 0),
    CHECK (project_id IS NULL OR length(project_id) > 0),
    CHECK (length(reason_code) > 0),
    CHECK (
      length(content_digest) = 71
      AND substr(content_digest, 1, 7) = 'sha256:'
      AND substr(content_digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    CHECK (
      (legacy_node_id IS NULL AND graph_version IS NULL AND snapshot_sha256 IS NULL)
      OR (
        legacy_node_id IS NOT NULL
        AND length(legacy_node_id) > 0
        AND graph_version IS NOT NULL
        AND snapshot_sha256 IS NOT NULL
        AND length(snapshot_sha256) = 71
        AND substr(snapshot_sha256, 1, 7) = 'sha256:'
        AND substr(snapshot_sha256, 8) NOT GLOB '*[^0-9a-f]*'
      )
    ),
    CHECK (source_kind <> 'graph_node' OR legacy_node_id IS NOT NULL),
    CHECK (
      (canonical_record_id IS NULL AND canonical_record_version IS NULL)
      OR (canonical_record_id IS NOT NULL AND canonical_record_version IS NOT NULL)
    ),
    CHECK (duplicate_of_item_id IS NULL OR duplicate_of_item_id <> import_item_id),
    CHECK (
      (
        disposition = 'active'
        AND plane IS NOT NULL
        AND legacy_node_id IS NOT NULL
        AND mapped_payload_json IS NOT NULL
        AND canonical_record_id IS NOT NULL
        AND canonical_record_version IS NOT NULL
        AND duplicate_of_item_id IS NULL
      )
      OR (
        disposition = 'pending_validation'
        AND plane IS NOT NULL
        AND mapped_payload_json IS NOT NULL
        AND canonical_record_id IS NULL
        AND canonical_record_version IS NULL
        AND duplicate_of_item_id IS NULL
      )
      OR (
        disposition = 'quarantined'
        AND canonical_record_id IS NULL
        AND canonical_record_version IS NULL
        AND duplicate_of_item_id IS NULL
      )
      OR (
        disposition = 'deduplicated'
        AND canonical_record_id IS NULL
        AND canonical_record_version IS NULL
        AND duplicate_of_item_id IS NOT NULL
      )
    )
  );

  CREATE INDEX idx_memory_legacy_import_items_run_disposition
    ON memory_legacy_import_items(import_run_id, disposition, source_kind);

  CREATE INDEX idx_memory_legacy_import_items_legacy_node
    ON memory_legacy_import_items(org_id, legacy_node_id)
    WHERE legacy_node_id IS NOT NULL;

  CREATE TRIGGER memory_legacy_import_items_duplicate_target
    BEFORE INSERT ON memory_legacy_import_items
    WHEN NEW.duplicate_of_item_id IS NOT NULL
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM memory_legacy_import_items AS target
        WHERE target.import_item_id = NEW.duplicate_of_item_id
          AND target.import_run_id = NEW.import_run_id
          AND target.disposition <> 'deduplicated'
      ) THEN RAISE(ABORT, 'duplicate import item must reference a non-duplicate item in the same run') END;
    END;

  CREATE TRIGGER memory_legacy_import_items_no_update
    BEFORE UPDATE ON memory_legacy_import_items
    BEGIN SELECT RAISE(ABORT, 'memory legacy import items are immutable'); END;

  CREATE TRIGGER memory_legacy_import_items_no_delete
    BEFORE DELETE ON memory_legacy_import_items
    BEGIN SELECT RAISE(ABORT, 'memory legacy import items are immutable'); END;

  CREATE TABLE memory_authority_transitions (
    transition_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL UNIQUE CHECK (revision >= 1),
    from_authority TEXT NOT NULL CHECK (from_authority IN (
      'legacy','migration_locked','canonical'
    )),
    to_authority TEXT NOT NULL CHECK (to_authority IN (
      'legacy','migration_locked','canonical'
    )),
    legacy_writes_frozen INTEGER NOT NULL CHECK (legacy_writes_frozen IN (0, 1)),
    import_run_id TEXT REFERENCES memory_legacy_import_runs(import_run_id),
    actor_id TEXT NOT NULL,
    reason_code TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    CHECK (length(transition_id) > 0),
    CHECK (length(actor_id) > 0),
    CHECK (length(reason_code) > 0),
    CHECK (
      (from_authority = 'legacy' AND to_authority = 'migration_locked')
      OR (from_authority = 'migration_locked' AND to_authority = 'canonical')
    ),
    CHECK (legacy_writes_frozen = 1)
  );

  CREATE TRIGGER memory_authority_transitions_validate_insert
    BEFORE INSERT ON memory_authority_transitions
    BEGIN
      SELECT CASE WHEN (
        SELECT to_authority
        FROM memory_authority_transitions
        ORDER BY revision DESC
        LIMIT 1
      ) = 'canonical'
      THEN RAISE(ABORT, 'canonical memory authority is terminal') END;

      SELECT CASE WHEN NEW.revision <> COALESCE(
        (SELECT MAX(revision) + 1 FROM memory_authority_transitions),
        1
      ) THEN RAISE(ABORT, 'memory authority revision must be contiguous') END;

      SELECT CASE WHEN NEW.from_authority <> COALESCE(
        (
          SELECT to_authority
          FROM memory_authority_transitions
          ORDER BY revision DESC
          LIMIT 1
        ),
        'legacy'
      ) THEN RAISE(ABORT, 'memory authority transition must start from current authority') END;

      SELECT CASE WHEN COALESCE(
        (
          SELECT legacy_writes_frozen
          FROM memory_authority_transitions
          ORDER BY revision DESC
          LIMIT 1
        ),
        0
      ) = 1 AND NEW.legacy_writes_frozen <> 1
      THEN RAISE(ABORT, 'legacy memory writes cannot be unfrozen') END;
    END;

  CREATE TRIGGER memory_authority_transitions_no_update
    BEFORE UPDATE ON memory_authority_transitions
    BEGIN SELECT RAISE(ABORT, 'memory authority transitions are append-only'); END;

  CREATE TRIGGER memory_authority_transitions_no_delete
    BEFORE DELETE ON memory_authority_transitions
    BEGIN SELECT RAISE(ABORT, 'memory authority transitions are append-only'); END;
`;
