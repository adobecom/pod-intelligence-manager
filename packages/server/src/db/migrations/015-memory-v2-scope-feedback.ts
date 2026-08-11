export const MEMORY_V2_SCOPE_FEEDBACK_MIGRATION_SQL = `
  CREATE TABLE memory_v2_scope_snapshots (
    receipt_id TEXT PRIMARY KEY REFERENCES memory_run_receipts(receipt_id),
    org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    plane TEXT NOT NULL CHECK (plane IN ('codebase','harness')),
    resource_row_id TEXT NOT NULL REFERENCES memory_v2_resources(resource_row_id),
    producer_principal_id TEXT NOT NULL,
    producer_run_id TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    core_request_digest TEXT NOT NULL,
    scope_snapshot_json TEXT NOT NULL CHECK (
      json_valid(scope_snapshot_json)
      AND json_type(scope_snapshot_json) = 'object'
      AND length(scope_snapshot_json) <= 65536
    ),
    scope_snapshot_digest TEXT NOT NULL,
    response_json TEXT NOT NULL CHECK (
      json_valid(response_json)
      AND json_type(response_json) = 'object'
      AND length(response_json) <= 524288
    ),
    created_at TEXT NOT NULL,
    UNIQUE (org_id, project_id, producer_run_id),
    CHECK (length(receipt_id) BETWEEN 1 AND 128),
    CHECK (length(resource_row_id) BETWEEN 1 AND 512),
    CHECK (length(producer_principal_id) BETWEEN 1 AND 128),
    CHECK (length(producer_run_id) BETWEEN 1 AND 256),
    CHECK (
      length(request_digest) = 71
      AND substr(request_digest, 1, 7) = 'sha256:'
      AND substr(request_digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    CHECK (
      length(core_request_digest) = 71
      AND substr(core_request_digest, 1, 7) = 'sha256:'
      AND substr(core_request_digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    CHECK (
      length(scope_snapshot_digest) = 71
      AND substr(scope_snapshot_digest, 1, 7) = 'sha256:'
      AND substr(scope_snapshot_digest, 8) NOT GLOB '*[^0-9a-f]*'
    )
  );

  CREATE INDEX idx_memory_v2_scope_snapshots_resource
    ON memory_v2_scope_snapshots(
      org_id, project_id, plane, resource_row_id, created_at DESC
    );

  CREATE TRIGGER memory_v2_scope_snapshots_validate_binding
    BEFORE INSERT ON memory_v2_scope_snapshots
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM memory_run_receipts AS receipt
        INNER JOIN memory_v2_receipt_facets AS facet
          ON facet.receipt_id = receipt.receipt_id
        INNER JOIN memory_v2_resources AS resource
          ON resource.resource_row_id = facet.resource_row_id
        WHERE receipt.receipt_id = NEW.receipt_id
          AND receipt.org_id = NEW.org_id
          AND receipt.project_id = NEW.project_id
          AND receipt.producer_run_id = NEW.producer_run_id
          AND receipt.request_digest = NEW.core_request_digest
          AND receipt.created_at = NEW.created_at
          AND facet.org_id = NEW.org_id
          AND facet.project_id = NEW.project_id
          AND facet.plane = NEW.plane
          AND facet.resource_row_id = NEW.resource_row_id
          AND facet.created_at = NEW.created_at
          AND resource.org_id = NEW.org_id
          AND resource.project_id = NEW.project_id
          AND resource.plane = NEW.plane
          AND resource.valid_until IS NULL
      ) THEN RAISE(ABORT, 'memory v2 snapshot receipt binding mismatch') END;

      SELECT CASE WHEN json_extract(NEW.scope_snapshot_json, '$.plane') <> NEW.plane
        OR json_extract(NEW.scope_snapshot_json, '$.scope_snapshot_digest')
          <> NEW.scope_snapshot_digest
        OR json_type(NEW.scope_snapshot_json, '$.resource_binding') <> 'object'
        OR json_extract(NEW.scope_snapshot_json, '$.resource_binding.resource_row_id')
          <> NEW.resource_row_id
        OR json_extract(NEW.scope_snapshot_json, '$.resource_binding.organization_id')
          <> NEW.org_id
        OR json_extract(NEW.scope_snapshot_json, '$.resource_binding.project_id')
          <> NEW.project_id
        OR json_extract(NEW.scope_snapshot_json, '$.resource_binding.plane') <> NEW.plane
      THEN RAISE(ABORT, 'memory v2 scope snapshot identity mismatch') END;

      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM memory_v2_resources AS resource
        WHERE resource.resource_row_id = NEW.resource_row_id
          AND json_extract(NEW.scope_snapshot_json, '$.resource_binding.resource_type')
            = resource.resource_type
          AND json_extract(NEW.scope_snapshot_json, '$.resource_binding.canonical_resource_id')
            = resource.canonical_resource_id
          AND json_extract(NEW.scope_snapshot_json, '$.resource_binding.display_label')
            = resource.display_label
          AND json_extract(NEW.scope_snapshot_json, '$.resource_binding.provider')
            IS resource.provider
          AND json_extract(NEW.scope_snapshot_json, '$.resource_binding.provider_resource_id')
            IS resource.provider_resource_id
          AND json_type(
            NEW.scope_snapshot_json,
            '$.resource_binding.permitted_operations'
          ) = 'array'
          AND json_array_length(json_extract(
            NEW.scope_snapshot_json,
            '$.resource_binding.permitted_operations'
          )) BETWEEN 1 AND 16
      ) THEN RAISE(ABORT, 'memory v2 scope snapshot resource mismatch') END;

      SELECT CASE WHEN EXISTS (
        SELECT 1
        FROM json_each(json_extract(
          NEW.scope_snapshot_json,
          '$.resource_binding.permitted_operations'
        ))
        WHERE type <> 'text' OR value NOT IN (
          'search','detail','history','pack','receipt_write','candidate_read',
          'candidate_write','feedback_write','readiness','review','activation',
          'runtime_attestation_write'
        )
      ) THEN RAISE(ABORT, 'memory v2 scope snapshot operation is unavailable') END;
      SELECT CASE WHEN (
        SELECT COUNT(DISTINCT value)
        FROM json_each(json_extract(
          NEW.scope_snapshot_json,
          '$.resource_binding.permitted_operations'
        ))
      ) <> json_array_length(json_extract(
        NEW.scope_snapshot_json,
        '$.resource_binding.permitted_operations'
      )) THEN RAISE(ABORT, 'memory v2 scope snapshot operations must be unique') END;

      SELECT CASE WHEN NEW.plane = 'codebase' AND NOT EXISTS (
        SELECT 1
        FROM memory_run_receipts AS receipt
        INNER JOIN memory_v2_resources AS resource
          ON resource.resource_row_id = NEW.resource_row_id
        WHERE receipt.receipt_id = NEW.receipt_id
          AND resource.resource_type = 'repository'
          AND resource.source_authority = 'memory_repository_registry'
          AND receipt.repository_row_id = resource.source_row_id
          AND receipt.repository_id = resource.canonical_resource_id
          AND receipt.repository_id = json_extract(
            NEW.scope_snapshot_json,
            '$.repository_id'
          )
          AND receipt.base_sha = json_extract(NEW.scope_snapshot_json, '$.base_sha')
          AND json_extract(NEW.scope_snapshot_json, '$.schema_version')
            = 'pim.memory-scope-snapshot.codebase.v2'
          AND (SELECT COUNT(*) FROM json_each(NEW.scope_snapshot_json)) = 6
          AND length(json_extract(NEW.scope_snapshot_json, '$.base_sha')) IN (40, 64)
          AND json_extract(NEW.scope_snapshot_json, '$.base_sha')
            NOT GLOB '*[^0-9a-f]*'
      ) THEN RAISE(ABORT, 'memory v2 codebase scope snapshot mismatch') END;

      SELECT CASE WHEN NEW.plane = 'harness' AND NOT EXISTS (
        SELECT 1
        FROM memory_run_receipts AS receipt
        INNER JOIN memory_v2_resources AS resource
          ON resource.resource_row_id = NEW.resource_row_id
        WHERE receipt.receipt_id = NEW.receipt_id
          AND receipt.repository_row_id IS NULL
          AND receipt.repository_id IS NULL
          AND receipt.base_sha IS NULL
          AND resource.resource_type = 'harness'
          AND resource.source_authority = 'memory_harness_principal_bindings'
          AND receipt.producer_harness_id = resource.canonical_resource_id
          AND receipt.producer_harness_id = json_extract(
            NEW.scope_snapshot_json,
            '$.harness_id'
          )
          AND json_extract(NEW.scope_snapshot_json, '$.schema_version')
            = 'pim.memory-scope-snapshot.harness.v2'
          AND (SELECT COUNT(*) FROM json_each(NEW.scope_snapshot_json)) = 10
          AND length(json_extract(NEW.scope_snapshot_json, '$.harness_version'))
            BETWEEN 1 AND 128
          AND length(json_extract(NEW.scope_snapshot_json, '$.workflow_version'))
            BETWEEN 1 AND 128
          AND length(json_extract(NEW.scope_snapshot_json, '$.adapter_version'))
            BETWEEN 1 AND 128
          AND length(json_extract(NEW.scope_snapshot_json, '$.configuration_id'))
            BETWEEN 1 AND 128
          AND length(json_extract(NEW.scope_snapshot_json, '$.configuration_digest')) = 71
          AND substr(json_extract(
            NEW.scope_snapshot_json,
            '$.configuration_digest'
          ), 1, 7) = 'sha256:'
          AND substr(json_extract(
            NEW.scope_snapshot_json,
            '$.configuration_digest'
          ), 8) NOT GLOB '*[^0-9a-f]*'
      ) THEN RAISE(ABORT, 'memory v2 harness scope snapshot mismatch') END;

      SELECT CASE WHEN json_extract(NEW.response_json, '$.schema_version')
          <> 'pim.run-receipt-result.v2'
        OR json_extract(NEW.response_json, '$.receipt_id') <> NEW.receipt_id
        OR json_extract(NEW.response_json, '$.producer_run_id') <> NEW.producer_run_id
        OR json_extract(NEW.response_json, '$.request_digest') <> NEW.request_digest
        OR json_extract(NEW.response_json, '$.plane') <> NEW.plane
        OR json_extract(NEW.response_json, '$.resource_binding.resource_row_id')
          <> NEW.resource_row_id
        OR json_extract(NEW.response_json, '$.scope_snapshot_digest')
          <> NEW.scope_snapshot_digest
        OR json_type(NEW.response_json, '$.candidate_results') <> 'array'
        OR json_array_length(json_extract(NEW.response_json, '$.candidate_results')) > 64
      THEN RAISE(ABORT, 'memory v2 scope snapshot response mismatch') END;
    END;

  CREATE TRIGGER memory_v2_scope_snapshots_no_update
    BEFORE UPDATE ON memory_v2_scope_snapshots
    BEGIN SELECT RAISE(ABORT, 'memory v2 scope snapshots are immutable'); END;

  CREATE TRIGGER memory_v2_scope_snapshots_no_delete
    BEFORE DELETE ON memory_v2_scope_snapshots
    BEGIN SELECT RAISE(ABORT, 'memory v2 scope snapshots are immutable'); END;

  CREATE TABLE memory_v2_feedback_bindings (
    feedback_id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    receipt_id TEXT NOT NULL REFERENCES memory_run_receipts(receipt_id),
    producer_principal_id TEXT NOT NULL,
    producer_run_id TEXT NOT NULL,
    feedback_stage TEXT NOT NULL CHECK (feedback_stage IN ('receipt','later')),
    feedback_revision INTEGER NOT NULL CHECK (feedback_revision >= 0),
    retrieval_pack_id TEXT NOT NULL REFERENCES memory_v2_retrieval_packs(retrieval_pack_id),
    record_id TEXT NOT NULL,
    record_version INTEGER NOT NULL CHECK (record_version >= 1),
    plane TEXT NOT NULL CHECK (plane IN ('codebase','harness')),
    resource_row_id TEXT NOT NULL REFERENCES memory_v2_resources(resource_row_id),
    scope_snapshot_digest TEXT NOT NULL,
    feedback_json TEXT NOT NULL CHECK (
      json_valid(feedback_json)
      AND json_type(feedback_json) = 'object'
      AND length(feedback_json) <= 65536
    ),
    feedback_digest TEXT NOT NULL,
    response_json TEXT NOT NULL CHECK (
      json_valid(response_json)
      AND json_type(response_json) = 'object'
      AND length(response_json) <= 131072
    ),
    created_at TEXT NOT NULL,
    UNIQUE (
      org_id, project_id, producer_run_id, retrieval_pack_id,
      record_id, record_version, feedback_stage, feedback_revision
    ),
    FOREIGN KEY (retrieval_pack_id, record_id, record_version)
      REFERENCES memory_v2_retrieval_pack_items(
        retrieval_pack_id, record_id, record_version
      ),
    CHECK (length(feedback_id) BETWEEN 1 AND 128),
    CHECK (length(receipt_id) BETWEEN 1 AND 128),
    CHECK (length(producer_principal_id) BETWEEN 1 AND 128),
    CHECK (length(producer_run_id) BETWEEN 1 AND 256),
    CHECK (length(retrieval_pack_id) BETWEEN 1 AND 128),
    CHECK (length(record_id) BETWEEN 1 AND 512),
    CHECK (length(resource_row_id) BETWEEN 1 AND 512),
    CHECK (
      (feedback_stage = 'receipt' AND feedback_revision = 0)
      OR (feedback_stage = 'later' AND feedback_revision >= 1)
    ),
    CHECK (
      length(scope_snapshot_digest) = 71
      AND substr(scope_snapshot_digest, 1, 7) = 'sha256:'
      AND substr(scope_snapshot_digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    CHECK (
      length(feedback_digest) = 71
      AND substr(feedback_digest, 1, 7) = 'sha256:'
      AND substr(feedback_digest, 8) NOT GLOB '*[^0-9a-f]*'
    )
  );

  CREATE INDEX idx_memory_v2_feedback_bindings_record
    ON memory_v2_feedback_bindings(
      org_id, project_id, plane, resource_row_id, record_id, record_version, created_at DESC
    );

  CREATE INDEX idx_memory_v2_feedback_bindings_receipt
    ON memory_v2_feedback_bindings(receipt_id, retrieval_pack_id, created_at);

  CREATE TRIGGER memory_v2_feedback_bindings_validate_pack
    BEFORE INSERT ON memory_v2_feedback_bindings
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM memory_v2_retrieval_packs AS pack
        INNER JOIN memory_v2_retrieval_pack_items AS item
          ON item.retrieval_pack_id = pack.retrieval_pack_id
        INNER JOIN memory_v2_resources AS resource
          ON resource.resource_row_id = pack.resource_row_id
        WHERE pack.retrieval_pack_id = NEW.retrieval_pack_id
          AND pack.org_id = NEW.org_id
          AND pack.project_id = NEW.project_id
          AND pack.principal_id = NEW.producer_principal_id
          AND pack.plane = NEW.plane
          AND pack.resource_row_id = NEW.resource_row_id
          AND pack.scope_snapshot_digest = NEW.scope_snapshot_digest
          AND item.record_id = NEW.record_id
          AND item.record_version = NEW.record_version
          AND resource.org_id = NEW.org_id
          AND resource.project_id = NEW.project_id
          AND resource.plane = NEW.plane
      ) THEN RAISE(ABORT, 'memory v2 feedback pack binding mismatch') END;

      SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM memory_v2_scope_snapshots AS snapshot
        INNER JOIN memory_run_receipts AS receipt
          ON receipt.receipt_id = snapshot.receipt_id
        WHERE snapshot.receipt_id = NEW.receipt_id
          AND snapshot.org_id = NEW.org_id
          AND snapshot.project_id = NEW.project_id
          AND snapshot.producer_principal_id = NEW.producer_principal_id
          AND snapshot.producer_run_id = NEW.producer_run_id
          AND snapshot.plane = NEW.plane
          AND snapshot.resource_row_id = NEW.resource_row_id
          AND receipt.org_id = NEW.org_id
          AND receipt.project_id = NEW.project_id
          AND receipt.producer_run_id = NEW.producer_run_id
      ) THEN RAISE(ABORT, 'memory v2 feedback receipt binding mismatch') END;

      SELECT CASE WHEN NEW.feedback_stage = 'later' AND (
        json_extract(NEW.feedback_json, '$.schema_version')
          <> 'pim.memory-feedback.v2'
        OR json_extract(NEW.feedback_json, '$.feedback_revision')
          <> NEW.feedback_revision
        OR json_extract(NEW.feedback_json, '$.retrieval_pack_id')
          <> NEW.retrieval_pack_id
        OR json_extract(NEW.feedback_json, '$.record_id') <> NEW.record_id
        OR json_extract(NEW.feedback_json, '$.record_version') <> NEW.record_version
        OR json_extract(NEW.feedback_json, '$.producer_run_id') <> NEW.producer_run_id
        OR json_extract(NEW.feedback_json, '$.plane') <> NEW.plane
        OR json_extract(NEW.feedback_json, '$.resource_row_id') <> NEW.resource_row_id
        OR json_extract(NEW.feedback_json, '$.scope_snapshot_digest')
          <> NEW.scope_snapshot_digest
        OR json_extract(NEW.feedback_json, '$.disposition') NOT IN (
          'helpful','harmful','stale','conflicting','not_used'
        )
        OR length(json_extract(NEW.feedback_json, '$.reason_code')) NOT BETWEEN 1 AND 128
        OR json_type(NEW.feedback_json, '$.outcome_evidence_refs') <> 'array'
        OR json_array_length(json_extract(
          NEW.feedback_json,
          '$.outcome_evidence_refs'
        )) > 128
        OR length(json_extract(NEW.feedback_json, '$.event_time')) NOT BETWEEN 1 AND 64
        OR (SELECT COUNT(*) FROM json_each(NEW.feedback_json)) <> 13
      ) THEN RAISE(ABORT, 'memory v2 later feedback payload mismatch') END;

      SELECT CASE WHEN NEW.feedback_stage = 'receipt' AND (
        json_extract(NEW.feedback_json, '$.retrieval_pack_id')
          <> NEW.retrieval_pack_id
        OR json_extract(NEW.feedback_json, '$.scope_snapshot_digest')
          <> NEW.scope_snapshot_digest
        OR json_extract(NEW.feedback_json, '$.record_id') <> NEW.record_id
        OR json_extract(NEW.feedback_json, '$.record_version') <> NEW.record_version
        OR json_extract(NEW.feedback_json, '$.disposition') NOT IN (
          'helpful','harmful','stale','conflicting','not_used','unknown'
        )
        OR length(json_extract(NEW.feedback_json, '$.reason_code')) NOT BETWEEN 1 AND 128
        OR (SELECT COUNT(*) FROM json_each(NEW.feedback_json)) <> 6
      ) THEN RAISE(ABORT, 'memory v2 receipt feedback payload mismatch') END;

      SELECT CASE WHEN NEW.feedback_stage = 'later' AND EXISTS (
        SELECT 1 FROM json_each(json_extract(
          NEW.feedback_json,
          '$.outcome_evidence_refs'
        ))
        WHERE type <> 'text' OR length(value) NOT BETWEEN 1 AND 128
      ) THEN RAISE(ABORT, 'memory v2 feedback evidence reference is invalid') END;
      SELECT CASE WHEN NEW.feedback_stage = 'later' AND (
        SELECT COUNT(DISTINCT value) FROM json_each(json_extract(
          NEW.feedback_json,
          '$.outcome_evidence_refs'
        ))
      ) <> json_array_length(json_extract(
        NEW.feedback_json,
        '$.outcome_evidence_refs'
      )) THEN RAISE(ABORT, 'memory v2 feedback evidence references must be unique') END;

      SELECT CASE WHEN NEW.feedback_stage = 'later' AND (
        json_extract(NEW.response_json, '$.schema_version')
          <> 'pim.memory-feedback-result.v2'
        OR json_extract(NEW.response_json, '$.feedback_id') <> NEW.feedback_id
        OR json_extract(NEW.response_json, '$.feedback_revision')
          <> NEW.feedback_revision
        OR json_extract(NEW.response_json, '$.tenant.organization_id') <> NEW.org_id
        OR json_extract(NEW.response_json, '$.tenant.project_id') <> NEW.project_id
        OR json_extract(NEW.response_json, '$.plane') <> NEW.plane
        OR json_extract(NEW.response_json, '$.resource_binding.resource_row_id')
          <> NEW.resource_row_id
        OR json_extract(NEW.response_json, '$.duplicate') <> 0
        OR json_type(NEW.response_json, '$.review_signal_ids') <> 'array'
        OR json_array_length(json_extract(
          NEW.response_json,
          '$.review_signal_ids'
        )) > 2
      ) THEN RAISE(ABORT, 'memory v2 later feedback response mismatch') END;

      SELECT CASE WHEN NEW.feedback_stage = 'receipt' AND NOT EXISTS (
        SELECT 1 FROM memory_v2_scope_snapshots AS snapshot
        WHERE snapshot.receipt_id = NEW.receipt_id
          AND snapshot.response_json = NEW.response_json
          AND json_extract(NEW.response_json, '$.schema_version')
            = 'pim.run-receipt-result.v2'
          AND json_extract(NEW.response_json, '$.receipt_id') = NEW.receipt_id
          AND json_extract(NEW.response_json, '$.producer_run_id') = NEW.producer_run_id
          AND json_extract(NEW.response_json, '$.plane') = NEW.plane
          AND json_extract(NEW.response_json, '$.resource_binding.resource_row_id')
            = NEW.resource_row_id
      ) THEN RAISE(ABORT, 'memory v2 receipt feedback response mismatch') END;
    END;

  CREATE TRIGGER memory_v2_feedback_bindings_no_update
    BEFORE UPDATE ON memory_v2_feedback_bindings
    BEGIN SELECT RAISE(ABORT, 'memory v2 feedback is append-only'); END;

  CREATE TRIGGER memory_v2_feedback_bindings_no_delete
    BEFORE DELETE ON memory_v2_feedback_bindings
    BEGIN SELECT RAISE(ABORT, 'memory v2 feedback is append-only'); END;

  CREATE TABLE memory_v2_feedback_review_signals (
    signal_id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    feedback_id TEXT NOT NULL REFERENCES memory_v2_feedback_bindings(feedback_id),
    record_id TEXT NOT NULL,
    record_version INTEGER NOT NULL CHECK (record_version >= 1),
    signal_type TEXT NOT NULL CHECK (signal_type IN (
      'stale_review','harmful_review','checkout_anchor_revalidation'
    )),
    reason_code TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
    outbox_job_id TEXT NOT NULL UNIQUE REFERENCES memory_outbox(job_id),
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    UNIQUE (feedback_id, signal_type),
    FOREIGN KEY (record_id, record_version)
      REFERENCES memory_record_versions(record_id, record_version),
    CHECK (length(signal_id) BETWEEN 1 AND 128),
    CHECK (length(feedback_id) BETWEEN 1 AND 128),
    CHECK (length(reason_code) BETWEEN 1 AND 128),
    CHECK (
      (status = 'open' AND resolved_at IS NULL)
      OR (status = 'resolved' AND resolved_at IS NOT NULL)
    )
  );

  CREATE INDEX idx_memory_v2_feedback_review_signals_queue
    ON memory_v2_feedback_review_signals(
      org_id, project_id, status, signal_type, created_at
    );

  CREATE TRIGGER memory_v2_feedback_review_signals_validate
    BEFORE INSERT ON memory_v2_feedback_review_signals
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM memory_v2_feedback_bindings AS feedback
        INNER JOIN memory_outbox AS job ON job.job_id = NEW.outbox_job_id
        WHERE feedback.feedback_id = NEW.feedback_id
          AND feedback.org_id = NEW.org_id
          AND feedback.project_id = NEW.project_id
          AND feedback.record_id = NEW.record_id
          AND feedback.record_version = NEW.record_version
          AND json_extract(feedback.feedback_json, '$.reason_code') = NEW.reason_code
          AND (
            (NEW.signal_type = 'harmful_review'
              AND json_extract(feedback.feedback_json, '$.disposition') = 'harmful')
            OR (NEW.signal_type IN ('stale_review','checkout_anchor_revalidation')
              AND json_extract(feedback.feedback_json, '$.disposition') = 'stale')
          )
          AND (
            (NEW.signal_type IN ('harmful_review','stale_review')
              AND job.job_type = 'review_notification')
            OR (NEW.signal_type = 'checkout_anchor_revalidation'
              AND job.job_type = 'record_revalidation')
          )
          AND job.org_id = NEW.org_id
          AND job.project_id = NEW.project_id
          AND job.aggregate_type = 'record'
          AND job.aggregate_id = NEW.record_id
          AND json_valid(job.payload_json)
          AND json_extract(job.payload_json, '$.feedback_source')
            = 'memory_v2_feedback_bindings'
          AND json_extract(job.payload_json, '$.feedback_id') = NEW.feedback_id
          AND json_extract(job.payload_json, '$.signal_id') = NEW.signal_id
      ) THEN RAISE(ABORT, 'memory v2 feedback review outbox mismatch') END;
    END;

  CREATE TRIGGER memory_v2_feedback_review_signals_immutable_fields
    BEFORE UPDATE OF
      signal_id, org_id, project_id, feedback_id, record_id, record_version,
      signal_type, reason_code, outbox_job_id, created_at
    ON memory_v2_feedback_review_signals
    BEGIN SELECT RAISE(ABORT, 'memory v2 feedback review evidence is immutable'); END;

  CREATE TRIGGER memory_v2_feedback_review_signals_no_delete
    BEFORE DELETE ON memory_v2_feedback_review_signals
    BEGIN SELECT RAISE(ABORT, 'memory v2 feedback review signals cannot be deleted'); END;
`;
