export const MEMORY_INBOX_RESULTS_MIGRATION_SQL = `
  ALTER TABLE memory_inbox
    ADD COLUMN response_json TEXT
      CHECK (response_json IS NULL OR json_valid(response_json));

  ALTER TABLE memory_inbox
    ADD COLUMN last_replayed_at TEXT;

  CREATE INDEX idx_memory_inbox_dead_letters
    ON memory_inbox(org_id, project_id, repository_row_id, dead_lettered_at)
    WHERE status = 'dead_letter';

  CREATE TRIGGER memory_inbox_response_immutable
    BEFORE UPDATE OF response_json ON memory_inbox
    WHEN OLD.response_json IS NOT NULL AND NEW.response_json IS NOT OLD.response_json
    BEGIN SELECT RAISE(ABORT, 'memory inbox response is immutable'); END;
`;
