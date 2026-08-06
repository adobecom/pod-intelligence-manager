export const MEMORY_PROMPT_CANARY_MIGRATION_SQL = `
  ALTER TABLE memory_records
    ADD COLUMN prompt_eligible INTEGER NOT NULL DEFAULT 0
      CHECK (prompt_eligible IN (0, 1));

  ALTER TABLE memory_retrieval_packs
    ADD COLUMN prompt_eligible INTEGER NOT NULL DEFAULT 0
      CHECK (prompt_eligible IN (0, 1));

  ALTER TABLE memory_retrieval_packs
    ADD COLUMN evaluation_arm TEXT NOT NULL DEFAULT 'shadow'
      CHECK (evaluation_arm IN ('shadow','memory_off','memory_on'));

  ALTER TABLE memory_retrieval_packs
    ADD COLUMN prompt_policy_revision INTEGER NOT NULL DEFAULT 0
      CHECK (prompt_policy_revision >= 0);

  ALTER TABLE memory_retrieval_packs
    ADD COLUMN prompt_policy_snapshot_json TEXT NOT NULL DEFAULT '{}';

  ALTER TABLE memory_retrieval_packs
    ADD COLUMN prompt_item_count INTEGER NOT NULL DEFAULT 0
      CHECK (prompt_item_count >= 0);

  ALTER TABLE memory_retrieval_packs
    ADD COLUMN prompt_token_count INTEGER NOT NULL DEFAULT 0
      CHECK (prompt_token_count >= 0);

  ALTER TABLE memory_retrieval_pack_items
    ADD COLUMN prompt_eligible INTEGER NOT NULL DEFAULT 0
      CHECK (prompt_eligible IN (0, 1));

  CREATE TABLE memory_prompt_policies (
    org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    policy_revision INTEGER NOT NULL CHECK (policy_revision >= 1),
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    kill_switch INTEGER NOT NULL CHECK (kill_switch IN (0, 1)),
    automatic_activation_enabled INTEGER NOT NULL DEFAULT 0
      CHECK (automatic_activation_enabled IN (0, 1)),
    canary_percentage INTEGER NOT NULL CHECK (
      canary_percentage >= 0 AND canary_percentage <= 100
    ),
    allowed_repository_ids_json TEXT NOT NULL,
    allowed_kinds_json TEXT NOT NULL,
    max_prompt_items INTEGER NOT NULL CHECK (
      max_prompt_items >= 1 AND max_prompt_items <= 3
    ),
    max_prompt_tokens INTEGER NOT NULL CHECK (
      max_prompt_tokens >= 1 AND max_prompt_tokens <= 1200
    ),
    updated_by_principal_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (org_id, project_id),
    CHECK (json_valid(allowed_repository_ids_json)),
    CHECK (json_valid(allowed_kinds_json))
  );

  CREATE TABLE memory_release_gate_decisions (
    decision_id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    stage TEXT NOT NULL CHECK (stage IN ('pre_canary','expansion')),
    decision TEXT NOT NULL CHECK (decision IN ('continue','pause')),
    status TEXT NOT NULL CHECK (status IN ('pass','fail','insufficient_data')),
    metric_snapshot_json TEXT NOT NULL,
    dataset_digest TEXT NOT NULL,
    reasons_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    CHECK (json_valid(metric_snapshot_json)),
    CHECK (json_valid(reasons_json))
  );

  CREATE INDEX idx_memory_release_gate_decisions_project
    ON memory_release_gate_decisions(org_id, project_id, stage, created_at DESC);

  CREATE TRIGGER memory_release_gate_decisions_no_update
    BEFORE UPDATE ON memory_release_gate_decisions
    BEGIN SELECT RAISE(ABORT, 'memory release gate decisions are append-only'); END;

  CREATE TRIGGER memory_release_gate_decisions_no_delete
    BEFORE DELETE ON memory_release_gate_decisions
    BEGIN SELECT RAISE(ABORT, 'memory release gate decisions are append-only'); END;
`;
