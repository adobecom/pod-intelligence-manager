export const MEMORY_RETENTION_ERASURE_MIGRATION_SQL = `
  CREATE TABLE memory_retention_policy_versions (
    policy_version_id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(org_id),
    project_id TEXT REFERENCES projects(project_id),
    data_class TEXT NOT NULL CHECK (data_class IN (
      'retrieval_pack','receipt','evidence','candidate','record','feedback','security_log'
    )),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    retention_days INTEGER NOT NULL CHECK (retention_days BETWEEN 0 AND 36500),
    policy_digest TEXT NOT NULL,
    actor_digest TEXT NOT NULL,
    reason_code TEXT NOT NULL,
    effective_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    CHECK (length(policy_version_id) > 0),
    CHECK (length(reason_code) BETWEEN 1 AND 120),
    CHECK (
      length(policy_digest) = 71
      AND substr(policy_digest, 1, 7) = 'sha256:'
      AND substr(policy_digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    CHECK (
      length(actor_digest) = 71
      AND substr(actor_digest, 1, 7) = 'sha256:'
      AND substr(actor_digest, 8) NOT GLOB '*[^0-9a-f]*'
    )
  );

  CREATE UNIQUE INDEX idx_memory_retention_policy_revision
    ON memory_retention_policy_versions(
      org_id, ifnull(project_id, ''), data_class, revision
    );

  CREATE INDEX idx_memory_retention_policy_current
    ON memory_retention_policy_versions(
      org_id, project_id, data_class, revision DESC
    );

  CREATE TRIGGER memory_retention_policy_validate_insert
    BEFORE INSERT ON memory_retention_policy_versions
    BEGIN
      SELECT CASE WHEN NEW.revision <> COALESCE((
        SELECT MAX(revision) + 1
        FROM memory_retention_policy_versions
        WHERE org_id = NEW.org_id
          AND project_id IS NEW.project_id
          AND data_class = NEW.data_class
      ), 1) THEN RAISE(ABORT, 'memory retention policy revision must be contiguous') END;
    END;

  CREATE TRIGGER memory_retention_policy_no_update
    BEFORE UPDATE ON memory_retention_policy_versions
    BEGIN SELECT RAISE(ABORT, 'memory retention policies are append-only'); END;

  CREATE TRIGGER memory_retention_policy_no_delete
    BEFORE DELETE ON memory_retention_policy_versions
    BEGIN SELECT RAISE(ABORT, 'memory retention policies are append-only'); END;

  CREATE TABLE memory_legal_hold_events (
    event_id TEXT PRIMARY KEY,
    hold_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision IN (1, 2)),
    org_id TEXT NOT NULL REFERENCES orgs(org_id),
    project_id TEXT REFERENCES projects(project_id),
    data_class TEXT NOT NULL CHECK (data_class IN (
      'tenant','retrieval_pack','receipt','evidence','candidate','record','feedback','security_log'
    )),
    resource_id TEXT,
    action TEXT NOT NULL CHECK (action IN ('placed','released')),
    actor_digest TEXT NOT NULL,
    reason_code TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (hold_id, revision),
    CHECK (length(event_id) > 0),
    CHECK (length(hold_id) > 0),
    CHECK (length(reason_code) BETWEEN 1 AND 120),
    CHECK (
      (revision = 1 AND action = 'placed')
      OR (revision = 2 AND action = 'released')
    ),
    CHECK (
      length(actor_digest) = 71
      AND substr(actor_digest, 1, 7) = 'sha256:'
      AND substr(actor_digest, 8) NOT GLOB '*[^0-9a-f]*'
    )
  );

  CREATE INDEX idx_memory_legal_hold_scope
    ON memory_legal_hold_events(
      org_id, project_id, data_class, resource_id, hold_id, revision DESC
    );

  CREATE TRIGGER memory_legal_hold_validate_insert
    BEFORE INSERT ON memory_legal_hold_events
    BEGIN
      SELECT CASE WHEN NEW.revision <> COALESCE((
        SELECT MAX(revision) + 1
        FROM memory_legal_hold_events
        WHERE hold_id = NEW.hold_id
      ), 1) THEN RAISE(ABORT, 'memory legal hold revision must be contiguous') END;

      SELECT CASE WHEN EXISTS (
        SELECT 1
        FROM memory_legal_hold_events
        WHERE hold_id = NEW.hold_id
          AND (
            org_id <> NEW.org_id
            OR project_id IS NOT NEW.project_id
            OR data_class <> NEW.data_class
            OR resource_id IS NOT NEW.resource_id
          )
      ) THEN RAISE(ABORT, 'memory legal hold scope is immutable') END;
    END;

  CREATE TRIGGER memory_legal_hold_no_update
    BEFORE UPDATE ON memory_legal_hold_events
    BEGIN SELECT RAISE(ABORT, 'memory legal hold events are append-only'); END;

  CREATE TRIGGER memory_legal_hold_no_delete
    BEFORE DELETE ON memory_legal_hold_events
    BEGIN SELECT RAISE(ABORT, 'memory legal hold events are append-only'); END;

  CREATE TABLE memory_erasure_requests (
    request_id TEXT PRIMARY KEY,
    purpose TEXT NOT NULL CHECK (purpose IN ('retention','erasure')),
    scope_type TEXT NOT NULL CHECK (scope_type IN ('org','project','record')),
    org_id TEXT NOT NULL REFERENCES orgs(org_id),
    project_id TEXT REFERENCES projects(project_id),
    data_class TEXT NOT NULL CHECK (data_class IN (
      'tenant','retrieval_pack','receipt','evidence','candidate','record','feedback','security_log'
    )),
    record_id TEXT,
    requested_method TEXT NOT NULL CHECK (requested_method IN (
      'physical_delete','field_redaction','crypto_shred'
    )),
    effective_method TEXT NOT NULL CHECK (effective_method IN (
      'physical_delete','field_redaction'
    )),
    policy_version_id TEXT REFERENCES memory_retention_policy_versions(policy_version_id),
    cutoff_at TEXT,
    plan_digest TEXT NOT NULL,
    scope_snapshot_digest TEXT NOT NULL,
    target_count INTEGER NOT NULL CHECK (target_count >= 0),
    actor_digest TEXT NOT NULL,
    reason_code TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    backup_not_before TEXT NOT NULL,
    CHECK (length(request_id) > 0),
    CHECK (length(reason_code) BETWEEN 1 AND 120),
    CHECK (
      length(plan_digest) = 71
      AND substr(plan_digest, 1, 7) = 'sha256:'
      AND substr(plan_digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    CHECK (
      length(scope_snapshot_digest) = 71
      AND substr(scope_snapshot_digest, 1, 7) = 'sha256:'
      AND substr(scope_snapshot_digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    CHECK (
      length(actor_digest) = 71
      AND substr(actor_digest, 1, 7) = 'sha256:'
      AND substr(actor_digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    CHECK (
      (scope_type = 'org' AND project_id IS NULL AND record_id IS NULL)
      OR (scope_type = 'project' AND project_id IS NOT NULL AND record_id IS NULL)
      OR (
        scope_type = 'record'
        AND project_id IS NOT NULL
        AND data_class = 'record'
        AND record_id IS NOT NULL
      )
    ),
    CHECK (
      (purpose = 'retention' AND data_class <> 'tenant'
        AND policy_version_id IS NOT NULL AND cutoff_at IS NOT NULL)
      OR (purpose = 'erasure' AND policy_version_id IS NULL)
    )
  );

  CREATE TRIGGER memory_erasure_requests_no_update
    BEFORE UPDATE ON memory_erasure_requests
    BEGIN SELECT RAISE(ABORT, 'memory erasure requests are immutable'); END;

  CREATE TRIGGER memory_erasure_requests_no_delete
    BEFORE DELETE ON memory_erasure_requests
    BEGIN SELECT RAISE(ABORT, 'memory erasure requests are immutable'); END;

  CREATE TABLE memory_erasure_events (
    event_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL REFERENCES memory_erasure_requests(request_id),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    state TEXT NOT NULL CHECK (state IN (
      'primary_erased','pending_backup_expiry','pending_external_erasure'
    )),
    target_count INTEGER NOT NULL CHECK (target_count >= 0),
    actor_digest TEXT NOT NULL,
    reason_code TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    UNIQUE (request_id, revision),
    CHECK (length(event_id) > 0),
    CHECK (length(reason_code) BETWEEN 1 AND 120),
    CHECK (
      length(actor_digest) = 71
      AND substr(actor_digest, 1, 7) = 'sha256:'
      AND substr(actor_digest, 8) NOT GLOB '*[^0-9a-f]*'
    )
  );

  CREATE TRIGGER memory_erasure_events_validate_insert
    BEFORE INSERT ON memory_erasure_events
    BEGIN
      SELECT CASE WHEN NEW.revision <> COALESCE((
        SELECT MAX(revision) + 1
        FROM memory_erasure_events
        WHERE request_id = NEW.request_id
      ), 1) THEN RAISE(ABORT, 'memory erasure event revision must be contiguous') END;
    END;

  CREATE TRIGGER memory_erasure_events_no_update
    BEFORE UPDATE ON memory_erasure_events
    BEGIN SELECT RAISE(ABORT, 'memory erasure events are append-only'); END;

  CREATE TRIGGER memory_erasure_events_no_delete
    BEFORE DELETE ON memory_erasure_events
    BEGIN SELECT RAISE(ABORT, 'memory erasure events are append-only'); END;

  CREATE TABLE memory_erasure_tombstones (
    tombstone_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL REFERENCES memory_erasure_requests(request_id),
    resource_class TEXT NOT NULL CHECK (resource_class IN (
      'retrieval_pack','receipt','evidence','candidate','record','feedback',
      'security_log','attestation','decision','legacy_import'
    )),
    resource_id TEXT NOT NULL,
    content_digest TEXT NOT NULL,
    erasure_method TEXT NOT NULL CHECK (erasure_method IN (
      'physical_delete','field_redaction'
    )),
    actor_digest TEXT NOT NULL,
    reason_code TEXT NOT NULL,
    erased_at TEXT NOT NULL,
    UNIQUE (request_id, resource_class, resource_id),
    CHECK (length(tombstone_id) > 0),
    CHECK (length(resource_id) > 0),
    CHECK (length(reason_code) BETWEEN 1 AND 120),
    CHECK (
      length(content_digest) = 71
      AND substr(content_digest, 1, 7) = 'sha256:'
      AND substr(content_digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    CHECK (
      length(actor_digest) = 71
      AND substr(actor_digest, 1, 7) = 'sha256:'
      AND substr(actor_digest, 8) NOT GLOB '*[^0-9a-f]*'
    )
  );

  CREATE INDEX idx_memory_erasure_tombstones_resource
    ON memory_erasure_tombstones(resource_class, resource_id, erased_at);

  CREATE TRIGGER memory_erasure_tombstones_no_update
    BEFORE UPDATE ON memory_erasure_tombstones
    BEGIN SELECT RAISE(ABORT, 'memory erasure tombstones are immutable'); END;

  CREATE TRIGGER memory_erasure_tombstones_no_delete
    BEFORE DELETE ON memory_erasure_tombstones
    BEGIN SELECT RAISE(ABORT, 'memory erasure tombstones are immutable'); END;
`;
