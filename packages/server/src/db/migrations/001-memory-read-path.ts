export const MEMORY_READ_PATH_MIGRATION_SQL = `
  CREATE TABLE memory_repository_registry (
    repository_row_id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('github')),
    provider_repository_id TEXT NOT NULL,
    repository_id TEXT NOT NULL,
    display_slug TEXT NOT NULL,
    valid_from TEXT NOT NULL,
    valid_until TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (org_id, provider, provider_repository_id),
    UNIQUE (org_id, repository_id)
  );

  CREATE INDEX idx_memory_repository_registry_project
    ON memory_repository_registry(org_id, project_id, repository_id);

  CREATE TABLE memory_repository_aliases (
    alias_id TEXT PRIMARY KEY,
    repository_row_id TEXT NOT NULL REFERENCES memory_repository_registry(repository_row_id) ON DELETE CASCADE,
    org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    alias_repository_id TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('rename','transfer','import')),
    valid_from TEXT NOT NULL,
    valid_until TEXT,
    created_at TEXT NOT NULL
  );

  CREATE UNIQUE INDEX idx_memory_repository_alias_active
    ON memory_repository_aliases(org_id, alias_repository_id)
    WHERE valid_until IS NULL;
  CREATE INDEX idx_memory_repository_alias_lookup
    ON memory_repository_aliases(org_id, project_id, alias_repository_id, valid_until);

  CREATE TABLE memory_records (
    record_id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    repository_row_id TEXT NOT NULL REFERENCES memory_repository_registry(repository_row_id),
    plane TEXT NOT NULL CHECK (plane IN ('codebase','harness','org')),
    kind TEXT NOT NULL CHECK (kind IN ('decision','constraint','anti_pattern','test_strategy')),
    current_version INTEGER NOT NULL CHECK (current_version >= 1),
    current_status TEXT NOT NULL CHECK (current_status IN ('active','stale','superseded','revoked','expired')),
    claim_key TEXT NOT NULL,
    valid_from TEXT NOT NULL,
    valid_until TEXT,
    expires_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (org_id, project_id, claim_key)
  );

  CREATE INDEX idx_memory_records_current_scope
    ON memory_records(org_id, project_id, plane, repository_row_id, current_status);

  CREATE TABLE memory_record_versions (
    record_id TEXT NOT NULL REFERENCES memory_records(record_id) ON DELETE CASCADE,
    record_version INTEGER NOT NULL CHECK (record_version >= 1),
    content_json TEXT NOT NULL,
    applicability_json TEXT NOT NULL,
    exceptions_json TEXT NOT NULL,
    compatibility_json TEXT NOT NULL,
    validation_json TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    evidence_summary_json TEXT NOT NULL,
    freshness_json TEXT NOT NULL,
    provenance_json TEXT NOT NULL,
    embedding_json TEXT,
    content_digest TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (record_id, record_version)
  );

  CREATE TRIGGER memory_record_versions_no_update
    BEFORE UPDATE ON memory_record_versions
    BEGIN SELECT RAISE(ABORT, 'memory_record_versions is immutable'); END;
  CREATE TRIGGER memory_record_versions_no_delete
    BEFORE DELETE ON memory_record_versions
    BEGIN SELECT RAISE(ABORT, 'memory_record_versions is immutable'); END;

  CREATE TABLE memory_transitions (
    transition_id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    aggregate_type TEXT NOT NULL CHECK (aggregate_type IN ('candidate','record')),
    aggregate_id TEXT NOT NULL,
    from_status TEXT,
    to_status TEXT NOT NULL,
    actor_type TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    reason_code TEXT NOT NULL,
    explanation TEXT NOT NULL,
    evidence_refs_json TEXT NOT NULL,
    decision_refs_json TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    committed_at TEXT NOT NULL
  );

  CREATE INDEX idx_memory_transitions_aggregate
    ON memory_transitions(org_id, project_id, aggregate_type, aggregate_id, committed_at DESC);
  CREATE TRIGGER memory_transitions_no_update
    BEFORE UPDATE ON memory_transitions
    BEGIN SELECT RAISE(ABORT, 'memory_transitions is append-only'); END;
  CREATE TRIGGER memory_transitions_no_delete
    BEFORE DELETE ON memory_transitions
    BEGIN SELECT RAISE(ABORT, 'memory_transitions is append-only'); END;

  CREATE TABLE memory_retrieval_packs (
    retrieval_pack_id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    request_id TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    repository_row_id TEXT NOT NULL REFERENCES memory_repository_registry(repository_row_id),
    repository_id TEXT NOT NULL,
    plane TEXT NOT NULL,
    query TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    ranker_version TEXT NOT NULL,
    authorized_scope_json TEXT NOT NULL,
    token_count INTEGER NOT NULL CHECK (token_count >= 0),
    omitted_count INTEGER NOT NULL CHECK (omitted_count >= 0),
    response_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    UNIQUE (org_id, project_id, request_id)
  );

  CREATE INDEX idx_memory_retrieval_packs_scope
    ON memory_retrieval_packs(org_id, project_id, created_at DESC);

  CREATE TABLE memory_retrieval_pack_items (
    retrieval_pack_id TEXT NOT NULL REFERENCES memory_retrieval_packs(retrieval_pack_id) ON DELETE CASCADE,
    item_order INTEGER NOT NULL CHECK (item_order >= 0),
    record_id TEXT NOT NULL,
    record_version INTEGER NOT NULL,
    token_count INTEGER NOT NULL CHECK (token_count >= 0),
    rank_score REAL NOT NULL,
    match_reasons_json TEXT NOT NULL,
    PRIMARY KEY (retrieval_pack_id, item_order),
    UNIQUE (retrieval_pack_id, record_id, record_version),
    FOREIGN KEY (record_id, record_version)
      REFERENCES memory_record_versions(record_id, record_version)
  );

  CREATE TABLE memory_applicability_indexes (
    record_id TEXT NOT NULL,
    record_version INTEGER NOT NULL,
    selector_type TEXT NOT NULL CHECK (selector_type IN ('repository','base_sha','component','path','symbol','task_class')),
    selector_value TEXT NOT NULL,
    PRIMARY KEY (record_id, record_version, selector_type, selector_value),
    FOREIGN KEY (record_id, record_version)
      REFERENCES memory_record_versions(record_id, record_version) ON DELETE CASCADE
  );

  CREATE INDEX idx_memory_applicability_lookup
    ON memory_applicability_indexes(selector_type, selector_value, record_id, record_version);

  CREATE TABLE memory_idempotency_keys (
    org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    operation TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    response_resource_type TEXT NOT NULL,
    response_resource_id TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    PRIMARY KEY (org_id, project_id, operation, idempotency_key)
  );

  CREATE INDEX idx_memory_idempotency_expiry
    ON memory_idempotency_keys(expires_at);

  CREATE VIRTUAL TABLE memory_record_versions_fts USING fts5(
    record_key UNINDEXED,
    summary,
    details,
    selectors,
    tokenize = 'unicode61 remove_diacritics 2'
  );
`;
