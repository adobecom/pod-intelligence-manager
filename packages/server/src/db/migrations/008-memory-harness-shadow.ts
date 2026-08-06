export const MEMORY_HARNESS_SHADOW_MIGRATION_SQL = `
  CREATE TABLE memory_harness_principal_bindings (
    binding_id TEXT PRIMARY KEY,
    service_principal_id TEXT NOT NULL REFERENCES service_principals(service_principal_id) ON DELETE CASCADE,
    org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    harness_id TEXT NOT NULL CHECK (length(harness_id) BETWEEN 1 AND 64),
    created_at TEXT NOT NULL,
    UNIQUE (service_principal_id, project_id, harness_id)
  );

  CREATE INDEX idx_memory_harness_principal_bindings_scope
    ON memory_harness_principal_bindings(org_id, project_id, harness_id, service_principal_id);

  CREATE TRIGGER memory_harness_principal_bindings_no_update
    BEFORE UPDATE ON memory_harness_principal_bindings
    BEGIN SELECT RAISE(ABORT, 'memory harness principal bindings are immutable'); END;

  CREATE TRIGGER memory_harness_principal_bindings_no_delete
    BEFORE DELETE ON memory_harness_principal_bindings
    BEGIN SELECT RAISE(ABORT, 'memory harness principal bindings are immutable'); END;

  CREATE TABLE memory_records_v8 (
    record_id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    repository_row_id TEXT REFERENCES memory_repository_registry(repository_row_id),
    harness_id TEXT,
    plane TEXT NOT NULL CHECK (plane IN ('codebase','harness','org')),
    kind TEXT NOT NULL CHECK (kind IN ('decision','constraint','anti_pattern','test_strategy')),
    current_version INTEGER NOT NULL CHECK (current_version >= 1),
    current_status TEXT NOT NULL CHECK (current_status IN ('active','stale','superseded','revoked','expired')),
    aggregate_version INTEGER NOT NULL DEFAULT 1 CHECK (aggregate_version >= 1),
    shadow_recall_eligible INTEGER NOT NULL DEFAULT 1 CHECK (shadow_recall_eligible IN (0, 1)),
    prompt_eligible INTEGER NOT NULL DEFAULT 0 CHECK (prompt_eligible IN (0, 1)),
    claim_key TEXT NOT NULL,
    valid_from TEXT NOT NULL,
    valid_until TEXT,
    expires_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (org_id, project_id, claim_key),
    CHECK (
      (plane = 'codebase' AND repository_row_id IS NOT NULL AND harness_id IS NULL)
      OR (plane = 'harness' AND repository_row_id IS NULL AND harness_id IS NOT NULL)
      OR (plane = 'org' AND repository_row_id IS NULL AND harness_id IS NULL)
    ),
    CHECK (plane <> 'harness' OR prompt_eligible = 0)
  );

  INSERT INTO memory_records_v8 (
    record_id, org_id, project_id, repository_row_id, harness_id, plane, kind,
    current_version, current_status, aggregate_version, shadow_recall_eligible,
    prompt_eligible, claim_key, valid_from, valid_until, expires_at, created_at, updated_at
  )
  SELECT
    record_id, org_id, project_id, repository_row_id, NULL, plane, kind,
    current_version, current_status, aggregate_version, shadow_recall_eligible,
    prompt_eligible, claim_key, valid_from, valid_until, expires_at, created_at, updated_at
  FROM memory_records;

  DROP TABLE memory_records;
  ALTER TABLE memory_records_v8 RENAME TO memory_records;

  CREATE INDEX idx_memory_records_current_scope
    ON memory_records(
      org_id, project_id, plane, repository_row_id, harness_id, current_status
    );

  CREATE TABLE memory_retrieval_packs_v8 (
    retrieval_pack_id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    request_id TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    repository_row_id TEXT REFERENCES memory_repository_registry(repository_row_id),
    repository_id TEXT,
    harness_id TEXT,
    plane TEXT NOT NULL CHECK (plane IN ('codebase','harness')),
    query TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    ranker_version TEXT NOT NULL,
    authorized_scope_json TEXT NOT NULL,
    token_count INTEGER NOT NULL CHECK (token_count >= 0),
    omitted_count INTEGER NOT NULL CHECK (omitted_count >= 0),
    response_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumer_run_id TEXT,
    request_base_sha TEXT,
    prompt_eligible INTEGER NOT NULL DEFAULT 0 CHECK (prompt_eligible IN (0, 1)),
    evaluation_arm TEXT NOT NULL DEFAULT 'shadow' CHECK (evaluation_arm IN ('shadow','memory_off','memory_on')),
    prompt_policy_revision INTEGER NOT NULL DEFAULT 0 CHECK (prompt_policy_revision >= 0),
    prompt_policy_snapshot_json TEXT NOT NULL DEFAULT '{}',
    prompt_item_count INTEGER NOT NULL DEFAULT 0 CHECK (prompt_item_count >= 0),
    prompt_token_count INTEGER NOT NULL DEFAULT 0 CHECK (prompt_token_count >= 0),
    UNIQUE (org_id, project_id, request_id),
    CHECK (
      (plane = 'codebase' AND repository_row_id IS NOT NULL AND repository_id IS NOT NULL AND harness_id IS NULL)
      OR (plane = 'harness' AND repository_row_id IS NULL AND repository_id IS NULL AND harness_id IS NOT NULL)
    ),
    CHECK (
      plane <> 'harness'
      OR (prompt_eligible = 0 AND evaluation_arm = 'shadow'
          AND prompt_item_count = 0 AND prompt_token_count = 0)
    )
  );

  INSERT INTO memory_retrieval_packs_v8 (
    retrieval_pack_id, org_id, project_id, request_id, request_digest,
    repository_row_id, repository_id, harness_id, plane, query, policy_version,
    ranker_version, authorized_scope_json, token_count, omitted_count, response_json,
    created_at, expires_at, consumer_run_id, request_base_sha, prompt_eligible,
    evaluation_arm, prompt_policy_revision, prompt_policy_snapshot_json,
    prompt_item_count, prompt_token_count
  )
  SELECT
    retrieval_pack_id, org_id, project_id, request_id, request_digest,
    repository_row_id, repository_id, NULL, plane, query, policy_version,
    ranker_version, authorized_scope_json, token_count, omitted_count, response_json,
    created_at, expires_at, consumer_run_id, request_base_sha, prompt_eligible,
    evaluation_arm, prompt_policy_revision, prompt_policy_snapshot_json,
    prompt_item_count, prompt_token_count
  FROM memory_retrieval_packs;

  DROP TABLE memory_retrieval_packs;
  ALTER TABLE memory_retrieval_packs_v8 RENAME TO memory_retrieval_packs;

  CREATE INDEX idx_memory_retrieval_packs_scope
    ON memory_retrieval_packs(org_id, project_id, plane, created_at DESC);

  CREATE TABLE memory_applicability_indexes_v8 (
    record_id TEXT NOT NULL,
    record_version INTEGER NOT NULL,
    selector_type TEXT NOT NULL CHECK (selector_type IN (
      'repository','base_sha','component','path','symbol','task_class',
      'harness','harness_version','workflow_version','adapter_version',
      'configuration','model','tool'
    )),
    selector_value TEXT NOT NULL,
    PRIMARY KEY (record_id, record_version, selector_type, selector_value),
    FOREIGN KEY (record_id, record_version)
      REFERENCES memory_record_versions(record_id, record_version) ON DELETE CASCADE
  );

  INSERT INTO memory_applicability_indexes_v8 (
    record_id, record_version, selector_type, selector_value
  )
  SELECT record_id, record_version, selector_type, selector_value
  FROM memory_applicability_indexes;

  DROP TABLE memory_applicability_indexes;
  ALTER TABLE memory_applicability_indexes_v8 RENAME TO memory_applicability_indexes;

  CREATE INDEX idx_memory_applicability_lookup
    ON memory_applicability_indexes(selector_type, selector_value, record_id, record_version);
`;
