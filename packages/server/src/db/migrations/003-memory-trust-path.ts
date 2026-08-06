export const MEMORY_TRUST_PATH_MIGRATION_SQL = `
  ALTER TABLE memory_records
    ADD COLUMN aggregate_version INTEGER NOT NULL DEFAULT 1 CHECK (aggregate_version >= 1);

  ALTER TABLE memory_records
    ADD COLUMN shadow_recall_eligible INTEGER NOT NULL DEFAULT 1
      CHECK (shadow_recall_eligible IN (0, 1));

  CREATE TABLE memory_attestations (
    attestation_row_id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    repository_row_id TEXT NOT NULL REFERENCES memory_repository_registry(repository_row_id),
    provider TEXT NOT NULL CHECK (provider IN ('github','ci')),
    provider_delivery_id TEXT NOT NULL,
    provider_event_id TEXT NOT NULL,
    producer_attestation_id TEXT NOT NULL,
    attestation_type TEXT NOT NULL CHECK (attestation_type IN (
      'github_merge','github_revert','ci_gate','authorized_review'
    )),
    payload_digest TEXT NOT NULL,
    attestation_json TEXT NOT NULL,
    provider_pull_request_id TEXT,
    base_sha TEXT,
    head_sha TEXT,
    merge_sha TEXT,
    manifest_digest TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    verified_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (org_id, provider, provider_delivery_id),
    UNIQUE (org_id, provider, provider_event_id),
    UNIQUE (org_id, project_id, producer_attestation_id)
  );

  CREATE INDEX idx_memory_attestations_correlation
    ON memory_attestations(
      org_id, project_id, repository_row_id, provider_pull_request_id,
      head_sha, manifest_digest, occurred_at
    );

  CREATE TRIGGER memory_attestations_no_update
    BEFORE UPDATE ON memory_attestations
    BEGIN SELECT RAISE(ABORT, 'memory attestations are append-only'); END;
  CREATE TRIGGER memory_attestations_no_delete
    BEFORE DELETE ON memory_attestations
    BEGIN SELECT RAISE(ABORT, 'memory attestations are append-only'); END;

  CREATE TABLE memory_origins (
    origin_row_id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    origin_key TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK (source_type IN (
      'evidence_ref','github_attestation','ci_attestation','authorized_review'
    )),
    source_identity TEXT NOT NULL,
    immutable_digest TEXT NOT NULL,
    source_authority TEXT NOT NULL CHECK (source_authority IN (
      'observed','verified','authorized_review'
    )),
    evidence_row_id TEXT REFERENCES memory_evidence_refs(evidence_row_id),
    attestation_row_id TEXT REFERENCES memory_attestations(attestation_row_id),
    created_at TEXT NOT NULL,
    UNIQUE (org_id, project_id, origin_key),
    UNIQUE (org_id, project_id, source_type, source_identity, immutable_digest)
  );

  CREATE INDEX idx_memory_origins_attestation
    ON memory_origins(attestation_row_id);
  CREATE INDEX idx_memory_origins_evidence
    ON memory_origins(evidence_row_id);

  CREATE TRIGGER memory_origins_no_update
    BEFORE UPDATE ON memory_origins
    BEGIN SELECT RAISE(ABORT, 'memory origins are immutable'); END;
  CREATE TRIGGER memory_origins_no_delete
    BEFORE DELETE ON memory_origins
    BEGIN SELECT RAISE(ABORT, 'memory origins are immutable'); END;

  CREATE TABLE memory_inbox (
    inbox_event_id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    repository_row_id TEXT NOT NULL REFERENCES memory_repository_registry(repository_row_id),
    provider TEXT NOT NULL CHECK (provider IN ('github','ci')),
    provider_delivery_id TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN (
      'github_merge','github_revert','ci_gate'
    )),
    payload_digest TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    source_cursor TEXT,
    status TEXT NOT NULL CHECK (status IN (
      'pending','leased','unmatched','completed','dead_letter'
    )),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    max_attempts INTEGER NOT NULL DEFAULT 8 CHECK (max_attempts >= 1),
    attempt_history_json TEXT NOT NULL DEFAULT '[]',
    next_attempt_at TEXT NOT NULL,
    lease_owner TEXT,
    lease_expires_at TEXT,
    last_error_code TEXT,
    last_error_message TEXT,
    occurred_at TEXT NOT NULL,
    received_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    processed_at TEXT,
    dead_lettered_at TEXT,
    UNIQUE (provider, provider_delivery_id),
    CHECK (
      (status = 'leased' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR (status <> 'leased' AND lease_owner IS NULL AND lease_expires_at IS NULL)
    ),
    CHECK (
      (status = 'completed' AND processed_at IS NOT NULL)
      OR status <> 'completed'
    ),
    CHECK (
      (status = 'dead_letter' AND dead_lettered_at IS NOT NULL AND last_error_code IS NOT NULL)
      OR status <> 'dead_letter'
    )
  );

  CREATE INDEX idx_memory_inbox_dispatch
    ON memory_inbox(status, next_attempt_at, lease_expires_at, received_at);
  CREATE INDEX idx_memory_inbox_correlation
    ON memory_inbox(
      org_id, project_id, repository_row_id, event_type, occurred_at
    );

  CREATE TRIGGER memory_inbox_payload_immutable
    BEFORE UPDATE OF
      org_id, project_id, repository_row_id, provider, provider_delivery_id,
      event_type, payload_digest, payload_json, occurred_at, received_at
    ON memory_inbox
    BEGIN SELECT RAISE(ABORT, 'memory inbox provider payload is immutable'); END;

  CREATE TABLE memory_provider_cursors (
    cursor_id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    repository_row_id TEXT NOT NULL REFERENCES memory_repository_registry(repository_row_id),
    provider TEXT NOT NULL CHECK (provider IN ('github','ci')),
    stream_name TEXT NOT NULL,
    cursor_value TEXT,
    aggregate_version INTEGER NOT NULL DEFAULT 1 CHECK (aggregate_version >= 1),
    last_attempted_sync_at TEXT,
    last_successful_sync_at TEXT,
    last_error_code TEXT,
    last_error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (org_id, project_id, repository_row_id, provider, stream_name)
  );

  CREATE INDEX idx_memory_provider_cursors_sync
    ON memory_provider_cursors(provider, last_successful_sync_at, updated_at);

  CREATE TABLE memory_activation_claims (
    org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    repository_row_id TEXT NOT NULL REFERENCES memory_repository_registry(repository_row_id),
    plane TEXT NOT NULL CHECK (plane IN ('codebase')),
    conflict_key TEXT NOT NULL,
    aggregate_version INTEGER NOT NULL CHECK (aggregate_version >= 1),
    current_candidate_id TEXT REFERENCES memory_candidates_v1(candidate_id),
    current_record_id TEXT,
    current_record_version INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (org_id, project_id, repository_row_id, plane, conflict_key),
    FOREIGN KEY (current_record_id, current_record_version)
      REFERENCES memory_record_versions(record_id, record_version),
    CHECK (
      (current_record_id IS NULL AND current_record_version IS NULL)
      OR (current_record_id IS NOT NULL AND current_record_version >= 1)
    )
  );

  CREATE INDEX idx_memory_activation_claims_record
    ON memory_activation_claims(current_record_id, current_record_version);

  CREATE TABLE memory_record_supersessions (
    supersession_id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    predecessor_record_id TEXT NOT NULL,
    predecessor_record_version INTEGER NOT NULL CHECK (predecessor_record_version >= 1),
    successor_record_id TEXT NOT NULL,
    successor_record_version INTEGER NOT NULL CHECK (successor_record_version >= 1),
    candidate_id TEXT REFERENCES memory_candidates_v1(candidate_id),
    attestation_row_id TEXT REFERENCES memory_attestations(attestation_row_id),
    transition_id TEXT NOT NULL REFERENCES memory_transitions(transition_id),
    created_at TEXT NOT NULL,
    UNIQUE (predecessor_record_id, predecessor_record_version),
    UNIQUE (successor_record_id, successor_record_version),
    FOREIGN KEY (predecessor_record_id, predecessor_record_version)
      REFERENCES memory_record_versions(record_id, record_version),
    FOREIGN KEY (successor_record_id, successor_record_version)
      REFERENCES memory_record_versions(record_id, record_version),
    CHECK (
      predecessor_record_id <> successor_record_id
      OR predecessor_record_version <> successor_record_version
    )
  );
`;
