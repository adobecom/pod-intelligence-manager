export const MEMORY_SERVICE_REPOSITORY_BINDINGS_MIGRATION_SQL = `
  CREATE TABLE memory_service_token_repository_bindings (
    binding_id TEXT PRIMARY KEY,
    token_id TEXT NOT NULL REFERENCES service_tokens(token_id) ON DELETE CASCADE,
    service_principal_id TEXT NOT NULL REFERENCES service_principals(service_principal_id) ON DELETE CASCADE,
    org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    repository_row_id TEXT NOT NULL REFERENCES memory_repository_registry(repository_row_id),
    repository_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (token_id, repository_row_id),
    UNIQUE (service_principal_id, repository_row_id)
  );

  CREATE INDEX idx_memory_service_repository_bindings_token
    ON memory_service_token_repository_bindings(token_id, project_id, repository_row_id);
  CREATE INDEX idx_memory_service_repository_bindings_principal
    ON memory_service_token_repository_bindings(service_principal_id, project_id, repository_row_id);

  CREATE TRIGGER memory_service_repository_bindings_no_update
    BEFORE UPDATE ON memory_service_token_repository_bindings
    BEGIN SELECT RAISE(ABORT, 'memory service repository bindings are immutable'); END;

  CREATE TRIGGER memory_service_repository_bindings_no_delete
    BEFORE DELETE ON memory_service_token_repository_bindings
    BEGIN SELECT RAISE(ABORT, 'memory service repository bindings are immutable'); END;
`;
