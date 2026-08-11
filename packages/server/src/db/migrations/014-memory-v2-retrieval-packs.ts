export const MEMORY_V2_RETRIEVAL_PACKS_MIGRATION_SQL = `
  CREATE TABLE memory_v2_retrieval_packs (
    retrieval_pack_id TEXT PRIMARY KEY,
    schema_version TEXT NOT NULL CHECK (
      schema_version = 'pim.memory-retrieval-pack.v2'
    ),
    org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    request_id TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    plane TEXT NOT NULL CHECK (plane IN ('codebase','harness')),
    resource_row_id TEXT NOT NULL REFERENCES memory_v2_resources(resource_row_id),
    resource_binding_json TEXT NOT NULL CHECK (
      json_valid(resource_binding_json)
      AND json_type(resource_binding_json) = 'object'
    ),
    scope_snapshot_digest TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    ranker_version TEXT NOT NULL,
    budget_json TEXT NOT NULL CHECK (
      json_valid(budget_json)
      AND json_type(budget_json) = 'object'
      AND json_type(budget_json, '$.max_tokens') = 'integer'
      AND json_extract(budget_json, '$.max_tokens') BETWEEN 1 AND 8000
      AND json_type(budget_json, '$.max_items') = 'integer'
      AND json_extract(budget_json, '$.max_items') BETWEEN 1 AND 32
    ),
    authorized_scopes_json TEXT NOT NULL CHECK (
      json_valid(authorized_scopes_json)
      AND json_type(authorized_scopes_json) = 'array'
      AND json_array_length(authorized_scopes_json) <= 32
    ),
    response_json TEXT NOT NULL CHECK (
      json_valid(response_json) AND json_type(response_json) = 'object'
    ),
    token_count INTEGER NOT NULL CHECK (token_count >= 0),
    omitted_count INTEGER NOT NULL CHECK (omitted_count >= 0),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    UNIQUE (org_id, project_id, request_id),
    CHECK (
      length(request_digest) = 71
      AND substr(request_digest, 1, 7) = 'sha256:'
      AND substr(request_digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    CHECK (
      length(scope_snapshot_digest) = 71
      AND substr(scope_snapshot_digest, 1, 7) = 'sha256:'
      AND substr(scope_snapshot_digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    CHECK (length(retrieval_pack_id) BETWEEN 1 AND 128),
    CHECK (length(request_id) BETWEEN 1 AND 128),
    CHECK (length(principal_id) BETWEEN 1 AND 128),
    CHECK (length(policy_version) BETWEEN 1 AND 128),
    CHECK (length(ranker_version) BETWEEN 1 AND 128),
    CHECK (expires_at > created_at)
  );

  CREATE INDEX idx_memory_v2_retrieval_packs_scope
    ON memory_v2_retrieval_packs(
      org_id, project_id, plane, resource_row_id, created_at DESC
    );

  CREATE TABLE memory_v2_retrieval_pack_items (
    retrieval_pack_id TEXT NOT NULL REFERENCES memory_v2_retrieval_packs(retrieval_pack_id),
    item_order INTEGER NOT NULL CHECK (item_order >= 0),
    record_id TEXT NOT NULL,
    record_version INTEGER NOT NULL CHECK (record_version >= 1),
    token_count INTEGER NOT NULL CHECK (token_count >= 0),
    rank_score REAL NOT NULL,
    match_reasons_json TEXT NOT NULL CHECK (
      json_valid(match_reasons_json) AND json_type(match_reasons_json) = 'array'
    ),
    PRIMARY KEY (retrieval_pack_id, item_order),
    UNIQUE (retrieval_pack_id, record_id, record_version),
    FOREIGN KEY (record_id, record_version)
      REFERENCES memory_record_versions(record_id, record_version)
  );

  CREATE INDEX idx_memory_v2_pack_items_record
    ON memory_v2_retrieval_pack_items(record_id, record_version, retrieval_pack_id);

  CREATE TRIGGER memory_v2_retrieval_packs_no_update
    BEFORE UPDATE ON memory_v2_retrieval_packs
    BEGIN SELECT RAISE(ABORT, 'memory v2 retrieval packs are immutable'); END;

  CREATE TRIGGER memory_v2_retrieval_packs_no_delete
    BEFORE DELETE ON memory_v2_retrieval_packs
    BEGIN SELECT RAISE(ABORT, 'memory v2 retrieval packs are immutable'); END;

  CREATE TRIGGER memory_v2_retrieval_pack_items_no_update
    BEFORE UPDATE ON memory_v2_retrieval_pack_items
    BEGIN SELECT RAISE(ABORT, 'memory v2 retrieval pack items are immutable'); END;

  CREATE TRIGGER memory_v2_retrieval_pack_items_no_delete
    BEFORE DELETE ON memory_v2_retrieval_pack_items
    BEGIN SELECT RAISE(ABORT, 'memory v2 retrieval pack items are immutable'); END;

  CREATE TRIGGER memory_v2_retrieval_packs_validate_binding
    BEFORE INSERT ON memory_v2_retrieval_packs
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM memory_v2_resources AS resource
        WHERE resource.resource_row_id = NEW.resource_row_id
          AND resource.org_id = NEW.org_id
          AND resource.project_id = NEW.project_id
          AND resource.plane = NEW.plane
          AND resource.valid_until IS NULL
      ) THEN RAISE(ABORT, 'memory v2 pack resource binding mismatch') END;

      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM memory_v2_resources AS resource
        WHERE resource.resource_row_id = NEW.resource_row_id
          AND json_extract(NEW.resource_binding_json, '$.resource_row_id') = resource.resource_row_id
          AND json_extract(NEW.resource_binding_json, '$.organization_id') = resource.org_id
          AND json_extract(NEW.resource_binding_json, '$.project_id') = resource.project_id
          AND json_extract(NEW.resource_binding_json, '$.plane') = resource.plane
          AND json_extract(NEW.resource_binding_json, '$.resource_type') = resource.resource_type
          AND json_extract(NEW.resource_binding_json, '$.canonical_resource_id')
            = resource.canonical_resource_id
          AND json_extract(NEW.resource_binding_json, '$.display_label') = resource.display_label
          AND json_extract(NEW.resource_binding_json, '$.provider') IS resource.provider
          AND json_extract(NEW.resource_binding_json, '$.provider_resource_id')
            IS resource.provider_resource_id
          AND json_type(NEW.resource_binding_json, '$.permitted_operations') = 'array'
          AND json_array_length(
            json_extract(NEW.resource_binding_json, '$.permitted_operations')
          ) <= 16
      ) THEN RAISE(ABORT, 'memory v2 pack binding snapshot mismatch') END;

      SELECT CASE WHEN EXISTS (
        SELECT 1
        FROM json_each(json_extract(NEW.resource_binding_json, '$.permitted_operations'))
        WHERE type <> 'text' OR value NOT IN (
          'search','detail','history','pack','receipt_write','candidate_read',
          'candidate_write','feedback_write','readiness','review','activation',
          'runtime_attestation_write'
        )
      ) THEN RAISE(ABORT, 'memory v2 pack binding operation is unavailable') END;
      SELECT CASE WHEN (
        SELECT COUNT(DISTINCT value)
        FROM json_each(json_extract(NEW.resource_binding_json, '$.permitted_operations'))
      ) <> json_array_length(
        json_extract(NEW.resource_binding_json, '$.permitted_operations')
      ) THEN RAISE(ABORT, 'memory v2 pack binding operations must be unique') END;

      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM json_each(NEW.authorized_scopes_json)
        WHERE type <> 'text' OR value NOT IN (
          'memory:search','memory:receipt:write','memory:candidate:read','memory:attest',
          'memory:feedback:write','memory:review',
          'memory:harness:search','memory:harness:receipt:write',
          'memory:harness:candidate:read','memory:harness:review'
        )
      ) THEN RAISE(ABORT, 'memory v2 pack authorized scope is unavailable') END;
      SELECT CASE WHEN (
        SELECT COUNT(DISTINCT value) FROM json_each(NEW.authorized_scopes_json)
      ) <> json_array_length(NEW.authorized_scopes_json)
      THEN RAISE(ABORT, 'memory v2 pack authorized scopes must be unique') END;
    END;

  CREATE TRIGGER memory_v2_retrieval_pack_items_validate_facet
    BEFORE INSERT ON memory_v2_retrieval_pack_items
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM memory_v2_retrieval_packs AS pack
        INNER JOIN memory_v2_record_facets AS facet
          ON facet.record_id = NEW.record_id
         AND facet.record_version = NEW.record_version
         AND facet.org_id = pack.org_id
         AND facet.project_id = pack.project_id
         AND facet.plane = pack.plane
         AND facet.resource_row_id = pack.resource_row_id
         AND facet.projection_status = 'mapped'
        WHERE pack.retrieval_pack_id = NEW.retrieval_pack_id
      ) THEN RAISE(ABORT, 'memory v2 pack item facet binding mismatch') END;
    END;
`;
