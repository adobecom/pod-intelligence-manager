export const MEMORY_FEEDBACK_REVIEW_MIGRATION_SQL = `
  ALTER TABLE memory_retrieval_packs
    ADD COLUMN consumer_run_id TEXT;

  ALTER TABLE memory_retrieval_packs
    ADD COLUMN request_base_sha TEXT;

  CREATE TABLE memory_candidate_decisions (
    decision_id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    candidate_id TEXT NOT NULL REFERENCES memory_candidates_v1(candidate_id),
    reviewer_principal_id TEXT NOT NULL,
    decision_revision INTEGER NOT NULL CHECK (decision_revision >= 1),
    decision TEXT NOT NULL CHECK (decision IN ('approve','reject')),
    reason_code TEXT NOT NULL,
    explanation TEXT,
    decision_digest TEXT NOT NULL,
    decision_json TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (candidate_id, reviewer_principal_id, decision_revision)
  );

  CREATE INDEX idx_memory_candidate_decisions_candidate
    ON memory_candidate_decisions(org_id, project_id, candidate_id, created_at DESC);
  CREATE TRIGGER memory_candidate_decisions_no_update
    BEFORE UPDATE ON memory_candidate_decisions
    BEGIN SELECT RAISE(ABORT, 'memory candidate decisions are append-only'); END;
  CREATE TRIGGER memory_candidate_decisions_no_delete
    BEFORE DELETE ON memory_candidate_decisions
    BEGIN SELECT RAISE(ABORT, 'memory candidate decisions are append-only'); END;

  ALTER TABLE memory_origins
    ADD COLUMN decision_id TEXT REFERENCES memory_candidate_decisions(decision_id);

  CREATE TABLE memory_review_signals (
    signal_id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    feedback_id TEXT NOT NULL REFERENCES memory_feedback(feedback_id),
    record_id TEXT NOT NULL,
    record_version INTEGER NOT NULL CHECK (record_version >= 1),
    signal_type TEXT NOT NULL CHECK (signal_type IN (
      'stale_review','harmful_review','checkout_anchor_revalidation'
    )),
    reason_code TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    UNIQUE (feedback_id, signal_type),
    FOREIGN KEY (record_id, record_version)
      REFERENCES memory_record_versions(record_id, record_version),
    CHECK (
      (status = 'open' AND resolved_at IS NULL)
      OR (status = 'resolved' AND resolved_at IS NOT NULL)
    )
  );

  CREATE INDEX idx_memory_review_signals_queue
    ON memory_review_signals(org_id, project_id, status, signal_type, created_at);

  UPDATE memory_records
  SET shadow_recall_eligible = 1
  WHERE current_status = 'active';
`;
