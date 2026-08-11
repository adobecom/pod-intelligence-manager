export const MEMORY_V2_FACETS_MIGRATION_SQL = `
  CREATE TABLE memory_v2_record_facets (
    record_id TEXT NOT NULL,
    record_version INTEGER NOT NULL CHECK (record_version >= 1),
    org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    plane TEXT NOT NULL CHECK (plane IN ('codebase','harness')),
    resource_row_id TEXT NOT NULL REFERENCES memory_v2_resources(resource_row_id) ON DELETE CASCADE,
    broad_kind TEXT NOT NULL CHECK (broad_kind IN (
      'decision','constraint','anti_pattern','test_strategy'
    )),
    subtype TEXT CHECK (subtype IS NULL OR subtype IN (
      'workflow_strategy','failure_pattern','verification_sequence',
      'tool_constraint','escalation_requirement'
    )),
    projection_status TEXT NOT NULL CHECK (projection_status IN ('mapped','unmappable')),
    facet_json TEXT NOT NULL CHECK (json_valid(facet_json)),
    created_at TEXT NOT NULL,
    PRIMARY KEY (record_id, record_version),
    FOREIGN KEY (record_id, record_version)
      REFERENCES memory_record_versions(record_id, record_version) ON DELETE CASCADE,
    CHECK (
      (plane = 'codebase' AND subtype IS NULL AND projection_status = 'mapped')
      OR
      (plane = 'harness' AND (
        (projection_status = 'unmappable' AND subtype IS NULL)
        OR
        (projection_status = 'mapped' AND (
          (subtype = 'workflow_strategy' AND broad_kind = 'decision')
          OR (subtype = 'failure_pattern' AND broad_kind = 'anti_pattern')
          OR (subtype = 'verification_sequence' AND broad_kind = 'test_strategy')
          OR (subtype IN ('tool_constraint','escalation_requirement') AND broad_kind = 'constraint')
        ))
      ))
    )
  );

  CREATE INDEX idx_memory_v2_record_facets_scope
    ON memory_v2_record_facets(
      org_id, project_id, plane, resource_row_id, projection_status, record_id, record_version
    );

  CREATE TABLE memory_v2_candidate_facets (
    candidate_id TEXT PRIMARY KEY REFERENCES memory_candidates_v1(candidate_id) ON DELETE CASCADE,
    org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    plane TEXT NOT NULL CHECK (plane IN ('codebase','harness')),
    resource_row_id TEXT NOT NULL REFERENCES memory_v2_resources(resource_row_id) ON DELETE CASCADE,
    broad_kind TEXT NOT NULL CHECK (broad_kind IN (
      'decision','constraint','anti_pattern','test_strategy'
    )),
    subtype TEXT CHECK (subtype IS NULL OR subtype IN (
      'workflow_strategy','failure_pattern','verification_sequence',
      'tool_constraint','escalation_requirement'
    )),
    projection_status TEXT NOT NULL CHECK (projection_status IN ('mapped','unmappable')),
    facet_json TEXT NOT NULL CHECK (json_valid(facet_json)),
    created_at TEXT NOT NULL,
    CHECK (
      (plane = 'codebase' AND subtype IS NULL AND projection_status = 'mapped')
      OR
      (plane = 'harness' AND (
        (projection_status = 'unmappable' AND subtype IS NULL)
        OR
        (projection_status = 'mapped' AND (
          (subtype = 'workflow_strategy' AND broad_kind = 'decision')
          OR (subtype = 'failure_pattern' AND broad_kind = 'anti_pattern')
          OR (subtype = 'verification_sequence' AND broad_kind = 'test_strategy')
          OR (subtype IN ('tool_constraint','escalation_requirement') AND broad_kind = 'constraint')
        ))
      ))
    )
  );

  CREATE INDEX idx_memory_v2_candidate_facets_scope
    ON memory_v2_candidate_facets(
      org_id, project_id, plane, resource_row_id, projection_status, candidate_id
    );

  CREATE TABLE memory_v2_receipt_facets (
    receipt_id TEXT PRIMARY KEY REFERENCES memory_run_receipts(receipt_id) ON DELETE CASCADE,
    org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    plane TEXT NOT NULL CHECK (plane IN ('codebase','harness')),
    resource_row_id TEXT NOT NULL REFERENCES memory_v2_resources(resource_row_id) ON DELETE CASCADE,
    facet_json TEXT NOT NULL CHECK (json_valid(facet_json)),
    created_at TEXT NOT NULL
  );

  CREATE INDEX idx_memory_v2_receipt_facets_scope
    ON memory_v2_receipt_facets(org_id, project_id, plane, resource_row_id, created_at DESC);

  CREATE TABLE memory_v2_feedback_facets (
    feedback_id TEXT PRIMARY KEY REFERENCES memory_feedback(feedback_id) ON DELETE CASCADE,
    org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    plane TEXT NOT NULL CHECK (plane IN ('codebase','harness')),
    resource_row_id TEXT NOT NULL REFERENCES memory_v2_resources(resource_row_id) ON DELETE CASCADE,
    facet_json TEXT NOT NULL CHECK (json_valid(facet_json)),
    created_at TEXT NOT NULL
  );

  CREATE INDEX idx_memory_v2_feedback_facets_scope
    ON memory_v2_feedback_facets(org_id, project_id, plane, resource_row_id, created_at DESC);

  CREATE TABLE memory_v2_facet_quarantine (
    quarantine_row_id TEXT PRIMARY KEY,
    aggregate_type TEXT NOT NULL CHECK (aggregate_type IN (
      'record','candidate','receipt','feedback'
    )),
    aggregate_id TEXT NOT NULL CHECK (length(aggregate_id) BETWEEN 1 AND 512),
    aggregate_version INTEGER NOT NULL CHECK (aggregate_version >= 0),
    org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    source_plane TEXT NOT NULL CHECK (source_plane IN (
      'codebase','harness','org','unknown'
    )),
    reason_code TEXT NOT NULL CHECK (reason_code IN (
      'unsupported_plane','resource_missing','resource_ambiguous',
      'plane_ambiguous','subtype_ambiguous','authority_mismatch'
    )),
    source_digest TEXT NOT NULL CHECK (length(source_digest) BETWEEN 1 AND 512),
    created_at TEXT NOT NULL,
    UNIQUE (aggregate_type, aggregate_id, aggregate_version),
    CHECK (
      (aggregate_type = 'record' AND aggregate_version >= 1)
      OR (aggregate_type <> 'record' AND aggregate_version = 0)
    )
  );

  CREATE INDEX idx_memory_v2_facet_quarantine_scope
    ON memory_v2_facet_quarantine(
      org_id, project_id, aggregate_type, source_plane, reason_code, aggregate_id
    );

  CREATE TRIGGER memory_v2_record_facets_no_update
    BEFORE UPDATE ON memory_v2_record_facets
    BEGIN SELECT RAISE(ABORT, 'memory v2 record facets are immutable'); END;
  CREATE TRIGGER memory_v2_candidate_facets_no_update
    BEFORE UPDATE ON memory_v2_candidate_facets
    BEGIN SELECT RAISE(ABORT, 'memory v2 candidate facets are immutable'); END;
  CREATE TRIGGER memory_v2_receipt_facets_no_update
    BEFORE UPDATE ON memory_v2_receipt_facets
    BEGIN SELECT RAISE(ABORT, 'memory v2 receipt facets are immutable'); END;
  CREATE TRIGGER memory_v2_feedback_facets_no_update
    BEFORE UPDATE ON memory_v2_feedback_facets
    BEGIN SELECT RAISE(ABORT, 'memory v2 feedback facets are immutable'); END;

  CREATE TRIGGER memory_v2_facet_quarantine_no_update
    BEFORE UPDATE ON memory_v2_facet_quarantine
    BEGIN SELECT RAISE(ABORT, 'memory v2 facet quarantine is append-only'); END;
  CREATE TRIGGER memory_v2_facet_quarantine_no_delete
    BEFORE DELETE ON memory_v2_facet_quarantine
    BEGIN SELECT RAISE(ABORT, 'memory v2 facet quarantine is append-only'); END;

  CREATE TRIGGER memory_v2_record_facets_validate_resource
    BEFORE INSERT ON memory_v2_record_facets
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM memory_v2_resources AS resource
        WHERE resource.resource_row_id = NEW.resource_row_id
          AND resource.org_id = NEW.org_id
          AND resource.project_id = NEW.project_id
          AND resource.plane = NEW.plane
      ) THEN RAISE(ABORT, 'memory v2 record facet resource binding mismatch') END;
    END;
  CREATE TRIGGER memory_v2_candidate_facets_validate_resource
    BEFORE INSERT ON memory_v2_candidate_facets
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM memory_v2_resources AS resource
        WHERE resource.resource_row_id = NEW.resource_row_id
          AND resource.org_id = NEW.org_id
          AND resource.project_id = NEW.project_id
          AND resource.plane = NEW.plane
      ) THEN RAISE(ABORT, 'memory v2 candidate facet resource binding mismatch') END;
    END;
  CREATE TRIGGER memory_v2_receipt_facets_validate_resource
    BEFORE INSERT ON memory_v2_receipt_facets
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM memory_v2_resources AS resource
        WHERE resource.resource_row_id = NEW.resource_row_id
          AND resource.org_id = NEW.org_id
          AND resource.project_id = NEW.project_id
          AND resource.plane = NEW.plane
      ) THEN RAISE(ABORT, 'memory v2 receipt facet resource binding mismatch') END;
    END;
  CREATE TRIGGER memory_v2_feedback_facets_validate_resource
    BEFORE INSERT ON memory_v2_feedback_facets
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM memory_v2_resources AS resource
        WHERE resource.resource_row_id = NEW.resource_row_id
          AND resource.org_id = NEW.org_id
          AND resource.project_id = NEW.project_id
          AND resource.plane = NEW.plane
      ) THEN RAISE(ABORT, 'memory v2 feedback facet resource binding mismatch') END;
    END;

  INSERT INTO memory_v2_record_facets (
    record_id, record_version, org_id, project_id, plane, resource_row_id,
    broad_kind, subtype, projection_status, facet_json, created_at
  )
  SELECT
    record.record_id,
    version.record_version,
    record.org_id,
    record.project_id,
    record.plane,
    resource.resource_row_id,
    record.kind,
    CASE
      WHEN record.plane = 'harness' AND record.kind = 'decision' THEN 'workflow_strategy'
      WHEN record.plane = 'harness' AND record.kind = 'anti_pattern' THEN 'failure_pattern'
      WHEN record.plane = 'harness' AND record.kind = 'test_strategy' THEN 'verification_sequence'
      ELSE NULL
    END,
    'mapped',
    json_object(
      'projection', 'v1',
      'source_plane', record.plane,
      'projection_reason', 'lossless'
    ),
    version.recorded_at
  FROM memory_records AS record
  INNER JOIN memory_record_versions AS version ON version.record_id = record.record_id
  INNER JOIN memory_v2_resources AS resource
    ON resource.org_id = record.org_id
   AND resource.project_id = record.project_id
   AND (
     (record.plane = 'codebase'
       AND resource.plane = 'codebase'
       AND resource.source_authority = 'memory_repository_registry'
       AND resource.source_row_id = record.repository_row_id)
     OR
     (record.plane = 'harness'
       AND resource.plane = 'harness'
       AND resource.canonical_resource_id = record.harness_id)
   )
  WHERE record.plane IN ('codebase','harness')
    AND NOT (record.plane = 'harness' AND record.kind = 'constraint')
    AND (
      record.plane <> 'harness'
      OR (
        json_valid(version.applicability_json)
        AND json_extract(version.applicability_json, '$.harness_id') = record.harness_id
      )
    );

  INSERT INTO memory_v2_facet_quarantine (
    quarantine_row_id, aggregate_type, aggregate_id, aggregate_version,
    org_id, project_id, source_plane, reason_code, source_digest, created_at
  )
  SELECT
    'v2facetq:' || lower(hex(randomblob(16))),
    'record',
    record.record_id,
    version.record_version,
    record.org_id,
    record.project_id,
    CASE WHEN record.plane IN ('codebase','harness','org') THEN record.plane ELSE 'unknown' END,
    CASE
      WHEN record.plane = 'org' THEN 'unsupported_plane'
      WHEN record.plane = 'harness' AND record.kind = 'constraint'
        THEN 'subtype_ambiguous'
      WHEN record.plane = 'harness' AND (
        NOT json_valid(version.applicability_json)
        OR json_extract(version.applicability_json, '$.harness_id') IS NOT record.harness_id
      ) THEN 'authority_mismatch'
      ELSE 'resource_missing'
    END,
    substr(COALESCE(NULLIF(version.content_digest, ''), 'unavailable'), 1, 512),
    version.recorded_at
  FROM memory_records AS record
  INNER JOIN memory_record_versions AS version ON version.record_id = record.record_id
  WHERE NOT EXISTS (
    SELECT 1 FROM memory_v2_record_facets AS facet
    WHERE facet.record_id = record.record_id
      AND facet.record_version = version.record_version
  );

  INSERT INTO memory_v2_candidate_facets (
    candidate_id, org_id, project_id, plane, resource_row_id,
    broad_kind, subtype, projection_status, facet_json, created_at
  )
  SELECT
    candidate.candidate_id,
    candidate.org_id,
    candidate.project_id,
    candidate.plane,
    resource.resource_row_id,
    candidate.kind,
    CASE
      WHEN candidate.plane = 'harness' AND candidate.kind = 'decision' THEN 'workflow_strategy'
      WHEN candidate.plane = 'harness' AND candidate.kind = 'anti_pattern' THEN 'failure_pattern'
      WHEN candidate.plane = 'harness' AND candidate.kind = 'test_strategy' THEN 'verification_sequence'
      ELSE NULL
    END,
    'mapped',
    json_object('projection', 'v1', 'source_plane', candidate.plane),
    candidate.created_at
  FROM memory_candidates_v1 AS candidate
  INNER JOIN memory_v2_resources AS resource
    ON resource.org_id = candidate.org_id
   AND resource.project_id = candidate.project_id
   AND (
     (candidate.plane = 'codebase'
       AND resource.plane = 'codebase'
       AND resource.source_authority = 'memory_repository_registry'
       AND resource.source_row_id = candidate.repository_row_id)
     OR
     (candidate.plane = 'harness'
       AND resource.plane = 'harness'
       AND resource.canonical_resource_id = CASE
         WHEN json_valid(candidate.candidate_json)
           THEN json_extract(candidate.candidate_json, '$.applicability.harness_id')
         ELSE NULL
       END)
   )
  WHERE candidate.plane IN ('codebase','harness')
    AND NOT (candidate.plane = 'harness' AND candidate.kind = 'constraint')
    AND (
      candidate.plane <> 'harness'
      OR (
        json_valid(candidate.candidate_json)
        AND json_extract(candidate.candidate_json, '$.applicability.harness_id')
          = candidate.producer_harness_id
      )
    );

  INSERT INTO memory_v2_facet_quarantine (
    quarantine_row_id, aggregate_type, aggregate_id, aggregate_version,
    org_id, project_id, source_plane, reason_code, source_digest, created_at
  )
  SELECT
    'v2facetq:' || lower(hex(randomblob(16))),
    'candidate',
    candidate.candidate_id,
    0,
    candidate.org_id,
    candidate.project_id,
    CASE WHEN candidate.plane IN ('codebase','harness','org') THEN candidate.plane ELSE 'unknown' END,
    CASE
      WHEN candidate.plane = 'org' THEN 'unsupported_plane'
      WHEN candidate.plane = 'harness' AND candidate.kind = 'constraint'
        THEN 'subtype_ambiguous'
      WHEN candidate.plane = 'harness'
        AND json_valid(candidate.candidate_json)
        AND json_extract(candidate.candidate_json, '$.applicability.harness_id') IS NOT NULL
        AND json_extract(candidate.candidate_json, '$.applicability.harness_id')
          <> candidate.producer_harness_id
        THEN 'authority_mismatch'
      ELSE 'resource_missing'
    END,
    substr(COALESCE(NULLIF(candidate.candidate_digest, ''), 'unavailable'), 1, 512),
    candidate.created_at
  FROM memory_candidates_v1 AS candidate
  WHERE NOT EXISTS (
    SELECT 1 FROM memory_v2_candidate_facets AS facet
    WHERE facet.candidate_id = candidate.candidate_id
  );

  INSERT INTO memory_v2_receipt_facets (
    receipt_id, org_id, project_id, plane, resource_row_id, facet_json, created_at
  )
  SELECT
    receipt.receipt_id,
    receipt.org_id,
    receipt.project_id,
    'codebase',
    resource.resource_row_id,
    json_object('projection', 'v1', 'producer_run_id', receipt.producer_run_id),
    receipt.created_at
  FROM memory_run_receipts AS receipt
  INNER JOIN memory_v2_resources AS resource
    ON resource.source_authority = 'memory_repository_registry'
   AND resource.source_row_id = receipt.repository_row_id
   AND resource.org_id = receipt.org_id
   AND resource.project_id = receipt.project_id
  WHERE receipt.repository_row_id IS NOT NULL;

  INSERT INTO memory_v2_receipt_facets (
    receipt_id, org_id, project_id, plane, resource_row_id, facet_json, created_at
  )
  SELECT
    receipt.receipt_id,
    receipt.org_id,
    receipt.project_id,
    'harness',
    resource.resource_row_id,
    json_object('projection', 'v1', 'producer_run_id', receipt.producer_run_id),
    receipt.created_at
  FROM memory_run_receipts AS receipt
  INNER JOIN memory_v2_resources AS resource
    ON resource.org_id = receipt.org_id
   AND resource.project_id = receipt.project_id
   AND resource.plane = 'harness'
   AND resource.canonical_resource_id = receipt.producer_harness_id
  WHERE receipt.repository_row_id IS NULL
    AND EXISTS (
      SELECT 1 FROM memory_candidates_v1 AS candidate
      WHERE candidate.receipt_id = receipt.receipt_id AND candidate.plane = 'harness'
    )
    AND NOT EXISTS (
      SELECT 1 FROM memory_candidates_v1 AS candidate
      WHERE candidate.receipt_id = receipt.receipt_id AND candidate.plane <> 'harness'
    );

  INSERT INTO memory_v2_facet_quarantine (
    quarantine_row_id, aggregate_type, aggregate_id, aggregate_version,
    org_id, project_id, source_plane, reason_code, source_digest, created_at
  )
  SELECT
    'v2facetq:' || lower(hex(randomblob(16))),
    'receipt',
    receipt.receipt_id,
    0,
    receipt.org_id,
    receipt.project_id,
    CASE
      WHEN receipt.repository_row_id IS NOT NULL THEN 'codebase'
      WHEN EXISTS (
        SELECT 1 FROM memory_candidates_v1 AS candidate
        WHERE candidate.receipt_id = receipt.receipt_id
      ) AND NOT EXISTS (
        SELECT 1 FROM memory_candidates_v1 AS candidate
        WHERE candidate.receipt_id = receipt.receipt_id AND candidate.plane <> 'harness'
      ) THEN 'harness'
      WHEN EXISTS (
        SELECT 1 FROM memory_candidates_v1 AS candidate
        WHERE candidate.receipt_id = receipt.receipt_id
      ) AND NOT EXISTS (
        SELECT 1 FROM memory_candidates_v1 AS candidate
        WHERE candidate.receipt_id = receipt.receipt_id AND candidate.plane <> 'org'
      ) THEN 'org'
      ELSE 'unknown'
    END,
    CASE
      WHEN receipt.repository_row_id IS NOT NULL THEN 'resource_missing'
      WHEN EXISTS (
        SELECT 1 FROM memory_candidates_v1 AS candidate
        WHERE candidate.receipt_id = receipt.receipt_id
      ) AND NOT EXISTS (
        SELECT 1 FROM memory_candidates_v1 AS candidate
        WHERE candidate.receipt_id = receipt.receipt_id AND candidate.plane <> 'harness'
      ) THEN 'resource_missing'
      WHEN EXISTS (
        SELECT 1 FROM memory_candidates_v1 AS candidate
        WHERE candidate.receipt_id = receipt.receipt_id
      ) AND NOT EXISTS (
        SELECT 1 FROM memory_candidates_v1 AS candidate
        WHERE candidate.receipt_id = receipt.receipt_id AND candidate.plane <> 'org'
      ) THEN 'unsupported_plane'
      ELSE 'plane_ambiguous'
    END,
    substr(COALESCE(NULLIF(receipt.request_digest, ''), 'unavailable'), 1, 512),
    receipt.created_at
  FROM memory_run_receipts AS receipt
  WHERE NOT EXISTS (
    SELECT 1 FROM memory_v2_receipt_facets AS facet
    WHERE facet.receipt_id = receipt.receipt_id
  );

  INSERT INTO memory_v2_feedback_facets (
    feedback_id, org_id, project_id, plane, resource_row_id, facet_json, created_at
  )
  SELECT
    feedback.feedback_id,
    feedback.org_id,
    feedback.project_id,
    pack.plane,
    resource.resource_row_id,
    json_object('projection', 'v1', 'retrieval_pack_id', feedback.retrieval_pack_id),
    feedback.created_at
  FROM memory_feedback AS feedback
  INNER JOIN memory_retrieval_packs AS pack
    ON pack.retrieval_pack_id = feedback.retrieval_pack_id
  INNER JOIN memory_v2_resources AS resource
    ON resource.org_id = feedback.org_id
   AND resource.project_id = feedback.project_id
   AND (
     (pack.plane = 'codebase'
       AND resource.plane = 'codebase'
       AND resource.source_authority = 'memory_repository_registry'
       AND resource.source_row_id = pack.repository_row_id)
     OR
     (pack.plane = 'harness'
       AND resource.plane = 'harness'
       AND resource.canonical_resource_id = pack.harness_id)
   )
  WHERE pack.plane IN ('codebase','harness');

  INSERT INTO memory_v2_facet_quarantine (
    quarantine_row_id, aggregate_type, aggregate_id, aggregate_version,
    org_id, project_id, source_plane, reason_code, source_digest, created_at
  )
  SELECT
    'v2facetq:' || lower(hex(randomblob(16))),
    'feedback',
    feedback.feedback_id,
    0,
    feedback.org_id,
    feedback.project_id,
    CASE WHEN pack.plane IN ('codebase','harness') THEN pack.plane ELSE 'unknown' END,
    CASE WHEN pack.plane IN ('codebase','harness')
      THEN 'resource_missing' ELSE 'plane_ambiguous' END,
    substr(COALESCE(NULLIF(feedback.feedback_digest, ''), 'unavailable'), 1, 512),
    feedback.created_at
  FROM memory_feedback AS feedback
  LEFT JOIN memory_retrieval_packs AS pack
    ON pack.retrieval_pack_id = feedback.retrieval_pack_id
  WHERE NOT EXISTS (
    SELECT 1 FROM memory_v2_feedback_facets AS facet
    WHERE facet.feedback_id = feedback.feedback_id
  );
`;
