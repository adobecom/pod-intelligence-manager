import {
  MEMORY_V2_OPERATION_SCOPE_RULES,
  type ImplementedMemoryV2Plane,
} from "../../services/memory-v2-constants.js";

function sqlStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function operationProjectionSql(plane: ImplementedMemoryV2Plane): string {
  let projectedRow = 0;
  return MEMORY_V2_OPERATION_SCOPE_RULES.flatMap((rule, operationIndex) => {
    const scope = rule.scopeByPlane[plane];
    if (scope === null) return [];
    const prefix = projectedRow++ === 0 ? "SELECT" : "UNION ALL SELECT";
    return [
      `${prefix} ${operationIndex + 1} AS operation_order, `
        + `${sqlStringLiteral(rule.operation)} AS operation\n`
        + `          WHERE EXISTS (SELECT 1 FROM json_each(token.scopes_json) `
        + `WHERE value = ${sqlStringLiteral(scope)})`,
    ];
  }).join("\n        ");
}

function operationScopesSql(plane: ImplementedMemoryV2Plane): string {
  const scopes = new Set<string>();
  for (const rule of MEMORY_V2_OPERATION_SCOPE_RULES) {
    const scope = rule.scopeByPlane[plane];
    if (scope !== null) scopes.add(scope);
  }
  return [...scopes].map(sqlStringLiteral).join(",");
}

const MEMORY_V2_OPERATION_SQL = MEMORY_V2_OPERATION_SCOPE_RULES
  .map((rule) => sqlStringLiteral(rule.operation))
  .join(",");
const CODEBASE_OPERATION_PROJECTION_SQL = operationProjectionSql("codebase");
const HARNESS_OPERATION_PROJECTION_SQL = operationProjectionSql("harness");
const CODEBASE_OPERATION_SCOPES_SQL = operationScopesSql("codebase");
const HARNESS_OPERATION_SCOPES_SQL = operationScopesSql("harness");

export const MEMORY_V2_RESOURCES_MIGRATION_SQL = `
  CREATE TABLE memory_v2_resources (
    resource_row_id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    plane TEXT NOT NULL CHECK (plane IN ('codebase','harness')),
    resource_type TEXT NOT NULL CHECK (resource_type IN ('repository','harness')),
    canonical_resource_id TEXT NOT NULL,
    display_label TEXT NOT NULL,
    provider TEXT,
    provider_resource_id TEXT,
    classification TEXT NOT NULL DEFAULT 'internal' CHECK (classification IN (
      'public','internal','confidential','restricted'
    )),
    retention_reference TEXT,
    source_authority TEXT NOT NULL CHECK (source_authority IN (
      'memory_repository_registry','memory_harness_principal_bindings'
    )),
    source_row_id TEXT NOT NULL,
    valid_from TEXT NOT NULL,
    valid_until TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (org_id, project_id, plane, resource_type, canonical_resource_id),
    UNIQUE (source_authority, source_row_id),
    CHECK (length(resource_row_id) BETWEEN 1 AND 512),
    CHECK (length(canonical_resource_id) BETWEEN 1 AND 512),
    CHECK (length(display_label) BETWEEN 1 AND 512),
    CHECK (
      (plane = 'codebase' AND resource_type = 'repository'
        AND provider IS NOT NULL AND provider_resource_id IS NOT NULL)
      OR
      (plane = 'harness' AND resource_type = 'harness'
        AND provider IS NULL AND provider_resource_id IS NULL)
    )
  );

  CREATE INDEX idx_memory_v2_resources_scope
    ON memory_v2_resources(
      org_id, project_id, plane, resource_type, canonical_resource_id, valid_until
    );

  CREATE TRIGGER memory_v2_resources_immutable_identity
    BEFORE UPDATE OF
      resource_row_id, org_id, plane, resource_type, provider, provider_resource_id,
      source_authority, source_row_id
    ON memory_v2_resources
    BEGIN SELECT RAISE(ABORT, 'memory v2 resource identity is immutable'); END;

  CREATE TABLE memory_v2_resource_aliases (
    alias_row_id TEXT PRIMARY KEY,
    resource_row_id TEXT NOT NULL REFERENCES memory_v2_resources(resource_row_id) ON DELETE CASCADE,
    org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    plane TEXT NOT NULL CHECK (plane IN ('codebase','harness')),
    resource_type TEXT NOT NULL CHECK (resource_type IN ('repository','harness')),
    alias_canonical_resource_id TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('rename','transfer','import')),
    source_alias_row_id TEXT NOT NULL,
    valid_from TEXT NOT NULL,
    valid_until TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (source_alias_row_id),
    CHECK (length(alias_canonical_resource_id) BETWEEN 1 AND 512),
    CHECK (
      (plane = 'codebase' AND resource_type = 'repository')
      OR (plane = 'harness' AND resource_type = 'harness')
    )
  );

  CREATE UNIQUE INDEX idx_memory_v2_resource_alias_active
    ON memory_v2_resource_aliases(
      org_id, project_id, plane, resource_type, alias_canonical_resource_id
    ) WHERE valid_until IS NULL;

  CREATE INDEX idx_memory_v2_resource_alias_lookup
    ON memory_v2_resource_aliases(
      org_id, project_id, plane, alias_canonical_resource_id, valid_until
    );

  CREATE TRIGGER memory_v2_resource_aliases_immutable_history
    BEFORE UPDATE OF
      alias_row_id, resource_row_id, org_id, plane, resource_type,
      alias_canonical_resource_id, reason, source_alias_row_id,
      valid_from, valid_until, created_at
    ON memory_v2_resource_aliases
    BEGIN SELECT RAISE(ABORT, 'memory v2 resource alias history is immutable'); END;

  CREATE TRIGGER memory_v2_resource_aliases_closed_project_immutable
    BEFORE UPDATE OF project_id ON memory_v2_resource_aliases
    WHEN OLD.valid_until IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'memory v2 closed alias project is immutable'); END;

  CREATE TRIGGER memory_v2_resource_aliases_validate_resource
    BEFORE INSERT ON memory_v2_resource_aliases
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM memory_v2_resources AS resource
        WHERE resource.resource_row_id = NEW.resource_row_id
          AND resource.org_id = NEW.org_id
          AND resource.plane = NEW.plane
          AND resource.resource_type = NEW.resource_type
          AND (resource.project_id = NEW.project_id OR NEW.valid_until IS NOT NULL)
      ) THEN RAISE(ABORT, 'memory v2 alias resource binding mismatch') END;
    END;

  CREATE TRIGGER memory_v2_resource_aliases_validate_update
    BEFORE UPDATE OF project_id ON memory_v2_resource_aliases
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM memory_v2_resources AS resource
        WHERE resource.resource_row_id = NEW.resource_row_id
          AND resource.org_id = NEW.org_id
          AND resource.plane = NEW.plane
          AND resource.resource_type = NEW.resource_type
          AND (resource.project_id = NEW.project_id OR NEW.valid_until IS NOT NULL)
      ) THEN RAISE(ABORT, 'memory v2 alias resource binding mismatch') END;
    END;

  CREATE TABLE memory_v2_service_token_resource_bindings (
    binding_id TEXT PRIMARY KEY,
    token_id TEXT NOT NULL REFERENCES service_tokens(token_id) ON DELETE CASCADE,
    service_principal_id TEXT NOT NULL REFERENCES service_principals(service_principal_id) ON DELETE CASCADE,
    org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    resource_row_id TEXT NOT NULL REFERENCES memory_v2_resources(resource_row_id) ON DELETE CASCADE,
    operations_json TEXT NOT NULL CHECK (
      json_valid(operations_json) AND json_type(operations_json) = 'array'
        AND json_array_length(operations_json) > 0
    ),
    source_binding_type TEXT NOT NULL CHECK (source_binding_type IN (
      'repository_token_binding','harness_principal_binding'
    )),
    source_binding_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (token_id, resource_row_id),
    UNIQUE (token_id, source_binding_type, source_binding_id)
  );

  CREATE INDEX idx_memory_v2_token_resource_bindings_token
    ON memory_v2_service_token_resource_bindings(
      token_id, service_principal_id, org_id, project_id, resource_row_id
    );

  CREATE INDEX idx_memory_v2_token_resource_bindings_principal
    ON memory_v2_service_token_resource_bindings(
      service_principal_id, org_id, project_id, resource_row_id
    );

  CREATE TRIGGER memory_v2_token_resource_bindings_no_update
    BEFORE UPDATE ON memory_v2_service_token_resource_bindings
    BEGIN SELECT RAISE(ABORT, 'memory v2 service-token resource bindings are immutable'); END;

  CREATE TRIGGER memory_v2_token_resource_bindings_validate
    BEFORE INSERT ON memory_v2_service_token_resource_bindings
    BEGIN
      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM json_each(NEW.operations_json)
        WHERE type <> 'text' OR value NOT IN (${MEMORY_V2_OPERATION_SQL})
      ) THEN RAISE(ABORT, 'memory v2 binding operation is unavailable') END;
      SELECT CASE WHEN (
        SELECT COUNT(DISTINCT value) FROM json_each(NEW.operations_json)
      ) <> json_array_length(NEW.operations_json)
      THEN RAISE(ABORT, 'memory v2 binding operations must be unique') END;
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM service_tokens AS token
        INNER JOIN service_principals AS principal
          ON principal.service_principal_id = token.service_principal_id
        INNER JOIN memory_v2_resources AS resource
          ON resource.resource_row_id = NEW.resource_row_id
        WHERE token.token_id = NEW.token_id
          AND token.service_principal_id = NEW.service_principal_id
          AND token.project_id = NEW.project_id
          AND principal.org_id = NEW.org_id
          AND resource.org_id = NEW.org_id
          AND resource.project_id = NEW.project_id
      ) THEN RAISE(ABORT, 'memory v2 token resource binding mismatch') END;
      SELECT CASE WHEN NOT (
        (
          NEW.source_binding_type = 'repository_token_binding'
          AND EXISTS (
            SELECT 1
            FROM memory_service_token_repository_bindings AS legacy
            INNER JOIN memory_v2_resources AS resource
              ON resource.resource_row_id = NEW.resource_row_id
            WHERE legacy.binding_id = NEW.source_binding_id
              AND legacy.token_id = NEW.token_id
              AND legacy.service_principal_id = NEW.service_principal_id
              AND legacy.org_id = NEW.org_id
              AND legacy.project_id = NEW.project_id
              AND resource.source_authority = 'memory_repository_registry'
              AND resource.source_row_id = legacy.repository_row_id
              AND resource.plane = 'codebase'
              AND resource.resource_type = 'repository'
          )
        )
        OR
        (
          NEW.source_binding_type = 'harness_principal_binding'
          AND EXISTS (
            SELECT 1
            FROM memory_harness_principal_bindings AS legacy
            INNER JOIN memory_v2_resources AS resource
              ON resource.resource_row_id = NEW.resource_row_id
            WHERE legacy.binding_id = NEW.source_binding_id
              AND legacy.service_principal_id = NEW.service_principal_id
              AND legacy.org_id = NEW.org_id
              AND legacy.project_id = NEW.project_id
              AND resource.source_authority = 'memory_harness_principal_bindings'
              AND resource.plane = 'harness'
              AND resource.resource_type = 'harness'
              AND resource.canonical_resource_id = legacy.harness_id
          )
        )
      ) THEN RAISE(ABORT, 'memory v2 token binding source authority mismatch') END;
    END;

  CREATE TABLE memory_v2_service_token_mcp_profiles (
    token_id TEXT PRIMARY KEY REFERENCES service_tokens(token_id) ON DELETE CASCADE,
    authentication_profile TEXT NOT NULL CHECK (
      authentication_profile = 'private_pim_service_token'
    ),
    audience TEXT NOT NULL CHECK (audience = 'urn:pim:audience:mcp-memory'),
    resource_indicator TEXT NOT NULL CHECK (
      resource_indicator = 'urn:pim:resource:mcp-memory'
    ),
    endpoint_path TEXT NOT NULL CHECK (endpoint_path = '/mcp/memory'),
    created_at TEXT NOT NULL
  );

  CREATE TRIGGER memory_v2_service_token_mcp_profiles_no_update
    BEFORE UPDATE ON memory_v2_service_token_mcp_profiles
    BEGIN SELECT RAISE(ABORT, 'memory v2 service-token MCP profiles are immutable'); END;

  INSERT INTO memory_v2_resources (
    resource_row_id, org_id, project_id, plane, resource_type,
    canonical_resource_id, display_label, provider, provider_resource_id,
    classification, retention_reference, source_authority, source_row_id,
    valid_from, valid_until, created_at, updated_at
  )
  SELECT
    'v2res_repository:' || repository_row_id,
    org_id,
    project_id,
    'codebase',
    'repository',
    repository_id,
    display_slug,
    provider,
    provider_repository_id,
    'internal',
    NULL,
    'memory_repository_registry',
    repository_row_id,
    valid_from,
    valid_until,
    created_at,
    updated_at
  FROM memory_repository_registry;

  INSERT INTO memory_v2_resources (
    resource_row_id, org_id, project_id, plane, resource_type,
    canonical_resource_id, display_label, provider, provider_resource_id,
    classification, retention_reference, source_authority, source_row_id,
    valid_from, valid_until, created_at, updated_at
  )
  SELECT
    'v2res_harness:' || lower(hex(randomblob(16))),
    org_id,
    project_id,
    'harness',
    'harness',
    harness_id,
    harness_id,
    NULL,
    NULL,
    'internal',
    NULL,
    'memory_harness_principal_bindings',
    'identity:' || hex(CAST(org_id AS BLOB)) || ':'
      || hex(CAST(project_id AS BLOB)) || ':' || hex(CAST(harness_id AS BLOB)),
    MIN(created_at),
    NULL,
    MIN(created_at),
    MIN(created_at)
  FROM memory_harness_principal_bindings
  GROUP BY org_id, project_id, harness_id;

  INSERT INTO memory_v2_resource_aliases (
    alias_row_id, resource_row_id, org_id, project_id, plane, resource_type,
    alias_canonical_resource_id, reason, source_alias_row_id,
    valid_from, valid_until, created_at
  )
  SELECT
    'v2alias_repository:' || alias.alias_id,
    resource.resource_row_id,
    alias.org_id,
    alias.project_id,
    'codebase',
    'repository',
    alias.alias_repository_id,
    alias.reason,
    alias.alias_id,
    alias.valid_from,
    alias.valid_until,
    alias.created_at
  FROM memory_repository_aliases AS alias
  INNER JOIN memory_v2_resources AS resource
    ON resource.source_authority = 'memory_repository_registry'
   AND resource.source_row_id = alias.repository_row_id;

  INSERT INTO memory_v2_service_token_resource_bindings (
    binding_id, token_id, service_principal_id, org_id, project_id,
    resource_row_id, operations_json, source_binding_type,
    source_binding_id, created_at
  )
  SELECT
    'v2bind_repository:' || legacy.binding_id,
    legacy.token_id,
    legacy.service_principal_id,
    legacy.org_id,
    legacy.project_id,
    resource.resource_row_id,
    (
      SELECT json_group_array(operation)
      FROM (
        ${CODEBASE_OPERATION_PROJECTION_SQL}
        ORDER BY operation_order
      )
    ),
    'repository_token_binding',
    legacy.binding_id,
    legacy.created_at
  FROM memory_service_token_repository_bindings AS legacy
  INNER JOIN service_tokens AS token ON token.token_id = legacy.token_id
  INNER JOIN memory_v2_resources AS resource
    ON resource.source_authority = 'memory_repository_registry'
   AND resource.source_row_id = legacy.repository_row_id
  WHERE json_valid(token.scopes_json)
    AND EXISTS (
      SELECT 1 FROM json_each(token.scopes_json)
      WHERE value IN (${CODEBASE_OPERATION_SCOPES_SQL})
    );

  INSERT INTO memory_v2_service_token_resource_bindings (
    binding_id, token_id, service_principal_id, org_id, project_id,
    resource_row_id, operations_json, source_binding_type,
    source_binding_id, created_at
  )
  SELECT
    'v2bind_harness:' || token.token_id || ':' || legacy.binding_id,
    token.token_id,
    legacy.service_principal_id,
    legacy.org_id,
    legacy.project_id,
    resource.resource_row_id,
    (
      SELECT json_group_array(operation)
      FROM (
        ${HARNESS_OPERATION_PROJECTION_SQL}
        ORDER BY operation_order
      )
    ),
    'harness_principal_binding',
    legacy.binding_id,
    legacy.created_at
  FROM memory_harness_principal_bindings AS legacy
  INNER JOIN service_tokens AS token
    ON token.service_principal_id = legacy.service_principal_id
   AND token.project_id = legacy.project_id
  INNER JOIN memory_v2_resources AS resource
    ON resource.org_id = legacy.org_id
   AND resource.project_id = legacy.project_id
   AND resource.plane = 'harness'
   AND resource.resource_type = 'harness'
   AND resource.canonical_resource_id = legacy.harness_id
  WHERE json_valid(token.scopes_json)
    AND EXISTS (
      SELECT 1 FROM json_each(token.scopes_json)
      WHERE value IN (${HARNESS_OPERATION_SCOPES_SQL})
    );
`;
