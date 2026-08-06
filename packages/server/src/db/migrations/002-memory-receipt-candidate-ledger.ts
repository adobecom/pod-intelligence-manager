export const MEMORY_RECEIPT_CANDIDATE_LEDGER_MIGRATION_SQL = `
  CREATE TABLE memory_run_receipts (
    receipt_id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    producer_run_id TEXT NOT NULL,
    schema_major TEXT NOT NULL,
    idempotency_key TEXT,
    request_digest TEXT NOT NULL,
    receipt_json TEXT NOT NULL,
    response_json TEXT NOT NULL,
    producer_harness_id TEXT NOT NULL,
    repository_row_id TEXT REFERENCES memory_repository_registry(repository_row_id),
    repository_id TEXT,
    base_sha TEXT,
    outcome_status TEXT NOT NULL CHECK (outcome_status IN ('completed','failed','cancelled')),
    created_at TEXT NOT NULL,
    UNIQUE (org_id, project_id, schema_major, producer_run_id)
  );

  CREATE INDEX idx_memory_run_receipts_scope
    ON memory_run_receipts(org_id, project_id, created_at DESC);

  CREATE TABLE memory_evidence_manifests (
    evidence_manifest_row_id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    receipt_id TEXT NOT NULL REFERENCES memory_run_receipts(receipt_id) ON DELETE CASCADE,
    producer_manifest_id TEXT NOT NULL,
    manifest_digest TEXT NOT NULL,
    manifest_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (org_id, project_id, producer_manifest_id)
  );

  CREATE TABLE memory_evidence_refs (
    evidence_row_id TEXT PRIMARY KEY,
    evidence_manifest_row_id TEXT NOT NULL REFERENCES memory_evidence_manifests(evidence_manifest_row_id) ON DELETE CASCADE,
    producer_ref_id TEXT NOT NULL,
    type TEXT NOT NULL,
    uri TEXT NOT NULL,
    digest TEXT NOT NULL,
    origin_id TEXT NOT NULL,
    source_authority TEXT NOT NULL CHECK (source_authority IN ('observed','verified','authorized_review')),
    occurred_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (evidence_manifest_row_id, producer_ref_id)
  );

  CREATE TABLE memory_candidates_v1 (
    candidate_id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    receipt_id TEXT NOT NULL REFERENCES memory_run_receipts(receipt_id) ON DELETE CASCADE,
    repository_row_id TEXT REFERENCES memory_repository_registry(repository_row_id),
    producer_harness_id TEXT NOT NULL,
    client_candidate_id TEXT NOT NULL,
    candidate_digest TEXT NOT NULL,
    candidate_json TEXT NOT NULL,
    plane TEXT NOT NULL CHECK (plane IN ('codebase','harness','org')),
    kind TEXT NOT NULL CHECK (kind IN ('decision','constraint','anti_pattern','test_strategy')),
    current_status TEXT NOT NULL CHECK (current_status IN (
      'received','validating','pending_merge','pending_review','rejected','quarantined',
      'validation_failed','active','activation_failed'
    )),
    aggregate_version INTEGER NOT NULL CHECK (aggregate_version >= 1),
    activation_requirement TEXT NOT NULL CHECK (activation_requirement IN (
      'verified_merge','authorized_review','manual_policy_owner'
    )),
    blockers_json TEXT NOT NULL,
    evidence_manifest_row_id TEXT REFERENCES memory_evidence_manifests(evidence_manifest_row_id),
    active_record_id TEXT,
    active_record_version INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (org_id, project_id, producer_harness_id, client_candidate_id),
    CHECK (
      (active_record_id IS NULL AND active_record_version IS NULL)
      OR (active_record_id IS NOT NULL AND active_record_version >= 1)
    )
  );

  CREATE INDEX idx_memory_candidates_status
    ON memory_candidates_v1(org_id, project_id, current_status, updated_at DESC);

  CREATE TRIGGER memory_candidates_payload_immutable
    BEFORE UPDATE OF candidate_json, candidate_digest, client_candidate_id, producer_harness_id
    ON memory_candidates_v1
    BEGIN SELECT RAISE(ABORT, 'memory candidate input is immutable'); END;

  CREATE TABLE memory_receipt_candidates (
    receipt_id TEXT NOT NULL REFERENCES memory_run_receipts(receipt_id) ON DELETE CASCADE,
    candidate_id TEXT NOT NULL REFERENCES memory_candidates_v1(candidate_id),
    client_candidate_id TEXT NOT NULL,
    candidate_digest TEXT NOT NULL,
    PRIMARY KEY (receipt_id, candidate_id),
    UNIQUE (receipt_id, client_candidate_id)
  );

  CREATE TABLE memory_candidate_evidence (
    candidate_id TEXT NOT NULL REFERENCES memory_candidates_v1(candidate_id) ON DELETE CASCADE,
    evidence_row_id TEXT NOT NULL REFERENCES memory_evidence_refs(evidence_row_id),
    PRIMARY KEY (candidate_id, evidence_row_id)
  );

  CREATE TABLE memory_feedback (
    feedback_id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    receipt_id TEXT REFERENCES memory_run_receipts(receipt_id) ON DELETE CASCADE,
    producer_run_id TEXT NOT NULL,
    retrieval_pack_id TEXT NOT NULL REFERENCES memory_retrieval_packs(retrieval_pack_id),
    record_id TEXT NOT NULL,
    record_version INTEGER NOT NULL,
    feedback_stage TEXT NOT NULL CHECK (feedback_stage IN ('receipt','later')),
    feedback_revision INTEGER NOT NULL CHECK (feedback_revision >= 0),
    feedback_json TEXT NOT NULL,
    feedback_digest TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (
      org_id, project_id, producer_run_id, retrieval_pack_id,
      record_id, record_version, feedback_stage, feedback_revision
    ),
    FOREIGN KEY (record_id, record_version)
      REFERENCES memory_record_versions(record_id, record_version)
  );

  CREATE INDEX idx_memory_feedback_record
    ON memory_feedback(org_id, project_id, record_id, record_version, created_at DESC);
  CREATE TRIGGER memory_feedback_no_update
    BEFORE UPDATE ON memory_feedback
    BEGIN SELECT RAISE(ABORT, 'memory feedback is append-only'); END;
  CREATE TRIGGER memory_feedback_no_delete
    BEFORE DELETE ON memory_feedback
    BEGIN SELECT RAISE(ABORT, 'memory feedback is append-only'); END;

  CREATE TABLE memory_outbox (
    job_id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    job_type TEXT NOT NULL,
    aggregate_type TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    expected_version INTEGER NOT NULL CHECK (expected_version >= 1),
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','leased','completed','dead_letter')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),
    next_attempt_at TEXT NOT NULL,
    lease_owner TEXT,
    lease_expires_at TEXT,
    last_error_code TEXT,
    last_error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  );

  CREATE INDEX idx_memory_outbox_dispatch
    ON memory_outbox(status, next_attempt_at, lease_expires_at, created_at);

  CREATE TABLE memory_outbox_attempts (
    attempt_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES memory_outbox(job_id) ON DELETE CASCADE,
    attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
    worker_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    outcome TEXT CHECK (outcome IN ('completed','retry','dead_letter')),
    error_code TEXT,
    UNIQUE (job_id, attempt_number)
  );

  CREATE TABLE memory_dead_letters (
    dead_letter_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL UNIQUE REFERENCES memory_outbox(job_id),
    org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    job_type TEXT NOT NULL,
    aggregate_type TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    error_code TEXT NOT NULL,
    error_message TEXT NOT NULL,
    failed_at TEXT NOT NULL,
    replayed_at TEXT
  );
`;
