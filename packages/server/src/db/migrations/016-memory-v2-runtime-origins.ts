export const MEMORY_V2_RUNTIME_ORIGINS_MIGRATION_SQL = `
  CREATE TABLE memory_v2_corroboration_domains (
    corroboration_domain_id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    plane TEXT NOT NULL CHECK (plane = 'harness'),
    resource_row_id TEXT NOT NULL REFERENCES memory_v2_resources(resource_row_id),
    producer_principal_id TEXT NOT NULL REFERENCES service_principals(service_principal_id),
    provider TEXT NOT NULL CHECK (provider = 'runtime_attestation'),
    provider_domain_key TEXT NOT NULL CHECK (length(provider_domain_key) BETWEEN 1 AND 256),
    domain_digest TEXT NOT NULL CHECK (
      length(domain_digest) = 71
      AND substr(domain_digest, 1, 7) = 'sha256:'
      AND substr(domain_digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    created_at TEXT NOT NULL,
    UNIQUE (
      org_id, project_id, plane, resource_row_id, producer_principal_id,
      provider, provider_domain_key
    )
  );

  CREATE INDEX idx_memory_v2_corroboration_domains_scope
    ON memory_v2_corroboration_domains(
      org_id, project_id, plane, resource_row_id, producer_principal_id
    );

  CREATE TRIGGER memory_v2_corroboration_domains_validate_binding
    BEFORE INSERT ON memory_v2_corroboration_domains
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM memory_v2_resources AS resource
        JOIN service_principals AS principal
          ON principal.service_principal_id = NEW.producer_principal_id
        JOIN memory_v2_scope_snapshots AS snapshot
          ON snapshot.org_id = NEW.org_id
         AND snapshot.project_id = NEW.project_id
         AND snapshot.plane = NEW.plane
         AND snapshot.resource_row_id = NEW.resource_row_id
         AND snapshot.producer_principal_id = NEW.producer_principal_id
        WHERE resource.resource_row_id = NEW.resource_row_id
          AND resource.org_id = NEW.org_id
          AND resource.project_id = NEW.project_id
          AND resource.plane = NEW.plane
          AND resource.resource_type = 'harness'
          AND principal.org_id = NEW.org_id
      ) THEN RAISE(ABORT, 'v2 corroboration domain binding mismatch') END;
    END;

  CREATE TRIGGER memory_v2_corroboration_domains_no_update
    BEFORE UPDATE ON memory_v2_corroboration_domains
    BEGIN SELECT RAISE(ABORT, 'v2 corroboration domains are immutable'); END;
  CREATE TRIGGER memory_v2_corroboration_domains_no_delete
    BEFORE DELETE ON memory_v2_corroboration_domains
    BEGIN SELECT RAISE(ABORT, 'v2 corroboration domains are immutable'); END;

  CREATE TABLE memory_v2_origins (
    origin_id TEXT PRIMARY KEY,
    corroboration_domain_id TEXT NOT NULL
      REFERENCES memory_v2_corroboration_domains(corroboration_domain_id),
    org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    plane TEXT NOT NULL CHECK (plane = 'harness'),
    resource_row_id TEXT NOT NULL REFERENCES memory_v2_resources(resource_row_id),
    producer_principal_id TEXT NOT NULL REFERENCES service_principals(service_principal_id),
    receipt_id TEXT NOT NULL REFERENCES memory_run_receipts(receipt_id),
    producer_run_id TEXT NOT NULL CHECK (length(producer_run_id) BETWEEN 1 AND 256),
    evidence_ref_id TEXT NOT NULL CHECK (length(evidence_ref_id) BETWEEN 1 AND 128),
    provider TEXT NOT NULL CHECK (provider = 'runtime_attestation'),
    provider_identity TEXT NOT NULL CHECK (length(provider_identity) BETWEEN 1 AND 256),
    submitted_provider_event_id TEXT NOT NULL
      CHECK (length(submitted_provider_event_id) BETWEEN 1 AND 128),
    provider_event_id TEXT NOT NULL CHECK (length(provider_event_id) BETWEEN 1 AND 256),
    immutable_digest TEXT NOT NULL CHECK (
      length(immutable_digest) = 71
      AND substr(immutable_digest, 1, 7) = 'sha256:'
      AND substr(immutable_digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    request_digest TEXT NOT NULL CHECK (
      length(request_digest) = 71
      AND substr(request_digest, 1, 7) = 'sha256:'
      AND substr(request_digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    request_json TEXT NOT NULL CHECK (
      json_valid(request_json) AND json_type(request_json) = 'object'
      AND length(request_json) <= 65536
    ),
    resolution_digest TEXT NOT NULL CHECK (
      length(resolution_digest) = 71
      AND substr(resolution_digest, 1, 7) = 'sha256:'
      AND substr(resolution_digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    resolution_json TEXT NOT NULL CHECK (
      json_valid(resolution_json) AND json_type(resolution_json) = 'object'
      AND length(resolution_json) <= 32768
    ),
    candidate_set_digest TEXT NOT NULL CHECK (
      length(candidate_set_digest) = 71
      AND substr(candidate_set_digest, 1, 7) = 'sha256:'
      AND substr(candidate_set_digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    candidate_ids_json TEXT NOT NULL CHECK (
      json_valid(candidate_ids_json) AND json_type(candidate_ids_json) = 'array'
      AND json_array_length(candidate_ids_json) BETWEEN 1 AND 64
      AND length(candidate_ids_json) <= 16384
    ),
    client_candidate_ids_json TEXT NOT NULL CHECK (
      json_valid(client_candidate_ids_json) AND json_type(client_candidate_ids_json) = 'array'
      AND json_array_length(client_candidate_ids_json) BETWEEN 1 AND 64
      AND length(client_candidate_ids_json) <= 16384
    ),
    derivation_parent_refs_json TEXT NOT NULL CHECK (
      json_valid(derivation_parent_refs_json)
      AND json_type(derivation_parent_refs_json) = 'array'
      AND json_array_length(derivation_parent_refs_json) <= 32
      AND length(derivation_parent_refs_json) <= 8192
    ),
    observation_type TEXT NOT NULL CHECK (observation_type IN (
      'root','retry','rerun','summary','tool_echo','derived'
    )),
    outcome_fingerprint TEXT NOT NULL CHECK (
      length(outcome_fingerprint) = 71
      AND substr(outcome_fingerprint, 1, 7) = 'sha256:'
      AND substr(outcome_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    outcome_json TEXT NOT NULL CHECK (
      json_valid(outcome_json) AND json_type(outcome_json) = 'object'
      AND length(outcome_json) <= 4096
    ),
    source_authority TEXT NOT NULL CHECK (source_authority IN ('observed','verified')),
    effective_root_origin_id TEXT REFERENCES memory_v2_origins(origin_id),
    root_set_digest TEXT NOT NULL CHECK (
      length(root_set_digest) = 71
      AND substr(root_set_digest, 1, 7) = 'sha256:'
      AND substr(root_set_digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    root_count INTEGER NOT NULL CHECK (root_count BETWEEN 1 AND 128),
    occurred_at TEXT NOT NULL,
    verified_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (org_id, provider, provider_identity, provider_event_id),
    UNIQUE (receipt_id, evidence_ref_id),
    CHECK (
      (root_count = 1 AND effective_root_origin_id IS NOT NULL)
      OR (root_count > 1 AND effective_root_origin_id IS NULL)
    )
  );

  CREATE INDEX idx_memory_v2_origins_domain_outcome
    ON memory_v2_origins(
      corroboration_domain_id, source_authority, outcome_fingerprint,
      producer_run_id, occurred_at, origin_id
    );
  CREATE INDEX idx_memory_v2_origins_scope
    ON memory_v2_origins(org_id, project_id, plane, resource_row_id, origin_id);
  CREATE INDEX idx_memory_v2_origins_receipt_ref
    ON memory_v2_origins(receipt_id, evidence_ref_id, origin_id);

  CREATE TRIGGER memory_v2_origins_validate_binding
    BEFORE INSERT ON memory_v2_origins
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM memory_v2_corroboration_domains AS domain
        JOIN memory_v2_scope_snapshots AS snapshot
          ON snapshot.receipt_id = NEW.receipt_id
        WHERE domain.corroboration_domain_id = NEW.corroboration_domain_id
          AND domain.org_id = NEW.org_id
          AND domain.project_id = NEW.project_id
          AND domain.plane = NEW.plane
          AND domain.resource_row_id = NEW.resource_row_id
          AND domain.producer_principal_id = NEW.producer_principal_id
          AND snapshot.org_id = NEW.org_id
          AND snapshot.project_id = NEW.project_id
          AND snapshot.plane = NEW.plane
          AND snapshot.resource_row_id = NEW.resource_row_id
          AND snapshot.producer_principal_id = NEW.producer_principal_id
          AND snapshot.producer_run_id = NEW.producer_run_id
      ) THEN RAISE(ABORT, 'v2 origin receipt/domain binding mismatch') END;
    END;

  CREATE TRIGGER memory_v2_origins_no_update
    BEFORE UPDATE ON memory_v2_origins
    BEGIN SELECT RAISE(ABORT, 'v2 origins are immutable'); END;
  CREATE TRIGGER memory_v2_origins_no_delete
    BEFORE DELETE ON memory_v2_origins
    BEGIN SELECT RAISE(ABORT, 'v2 origins are immutable'); END;

  CREATE TABLE memory_v2_origin_derivations (
    origin_id TEXT NOT NULL REFERENCES memory_v2_origins(origin_id),
    parent_origin_id TEXT NOT NULL REFERENCES memory_v2_origins(origin_id),
    parent_evidence_ref_id TEXT NOT NULL
      CHECK (length(parent_evidence_ref_id) BETWEEN 1 AND 128),
    corroboration_domain_id TEXT NOT NULL
      REFERENCES memory_v2_corroboration_domains(corroboration_domain_id),
    derivation_type TEXT NOT NULL CHECK (derivation_type IN (
      'retry','rerun','summary','tool_echo','derived'
    )),
    created_at TEXT NOT NULL,
    PRIMARY KEY (origin_id, parent_origin_id),
    UNIQUE (origin_id, parent_evidence_ref_id),
    CHECK (origin_id <> parent_origin_id)
  );

  CREATE INDEX idx_memory_v2_origin_derivations_parent
    ON memory_v2_origin_derivations(parent_origin_id, origin_id);

  CREATE TRIGGER memory_v2_origin_derivations_validate_binding
    BEFORE INSERT ON memory_v2_origin_derivations
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM memory_v2_origins AS child
        JOIN memory_v2_origins AS parent
          ON parent.origin_id = NEW.parent_origin_id
        WHERE child.origin_id = NEW.origin_id
          AND child.observation_type = NEW.derivation_type
          AND child.corroboration_domain_id = NEW.corroboration_domain_id
          AND parent.corroboration_domain_id = NEW.corroboration_domain_id
          AND child.org_id = parent.org_id
          AND child.project_id = parent.project_id
          AND child.resource_row_id = parent.resource_row_id
          AND child.producer_principal_id = parent.producer_principal_id
          AND child.receipt_id = parent.receipt_id
          AND parent.evidence_ref_id = NEW.parent_evidence_ref_id
          AND EXISTS (
            SELECT 1 FROM json_each(child.derivation_parent_refs_json)
            WHERE value = NEW.parent_evidence_ref_id
          )
      ) THEN RAISE(ABORT, 'v2 origin derivation binding mismatch') END;
    END;

  CREATE TRIGGER memory_v2_origin_derivations_no_update
    BEFORE UPDATE ON memory_v2_origin_derivations
    BEGIN SELECT RAISE(ABORT, 'v2 origin derivations are immutable'); END;
  CREATE TRIGGER memory_v2_origin_derivations_no_delete
    BEFORE DELETE ON memory_v2_origin_derivations
    BEGIN SELECT RAISE(ABORT, 'v2 origin derivations are immutable'); END;

  CREATE TABLE memory_v2_origin_roots (
    origin_id TEXT NOT NULL REFERENCES memory_v2_origins(origin_id),
    root_origin_id TEXT NOT NULL REFERENCES memory_v2_origins(origin_id),
    corroboration_domain_id TEXT NOT NULL
      REFERENCES memory_v2_corroboration_domains(corroboration_domain_id),
    created_at TEXT NOT NULL,
    PRIMARY KEY (origin_id, root_origin_id)
  );

  CREATE INDEX idx_memory_v2_origin_roots_root
    ON memory_v2_origin_roots(root_origin_id, origin_id);

  CREATE TRIGGER memory_v2_origin_roots_validate_binding
    BEFORE INSERT ON memory_v2_origin_roots
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM memory_v2_origins AS child
        JOIN memory_v2_origins AS root ON root.origin_id = NEW.root_origin_id
        WHERE child.origin_id = NEW.origin_id
          AND child.corroboration_domain_id = NEW.corroboration_domain_id
          AND root.corroboration_domain_id = NEW.corroboration_domain_id
          AND root.observation_type = 'root'
          AND child.org_id = root.org_id
          AND child.project_id = root.project_id
          AND child.resource_row_id = root.resource_row_id
          AND child.producer_principal_id = root.producer_principal_id
          AND child.receipt_id = root.receipt_id
      ) THEN RAISE(ABORT, 'v2 origin root binding mismatch') END;
    END;

  CREATE TRIGGER memory_v2_origin_roots_no_update
    BEFORE UPDATE ON memory_v2_origin_roots
    BEGIN SELECT RAISE(ABORT, 'v2 origin roots are immutable'); END;
  CREATE TRIGGER memory_v2_origin_roots_no_delete
    BEFORE DELETE ON memory_v2_origin_roots
    BEGIN SELECT RAISE(ABORT, 'v2 origin roots are immutable'); END;

  CREATE TABLE memory_v2_candidate_origins (
    candidate_id TEXT NOT NULL REFERENCES memory_candidates_v1(candidate_id),
    client_candidate_id TEXT NOT NULL CHECK (length(client_candidate_id) BETWEEN 1 AND 128),
    origin_id TEXT NOT NULL REFERENCES memory_v2_origins(origin_id),
    corroboration_domain_id TEXT NOT NULL
      REFERENCES memory_v2_corroboration_domains(corroboration_domain_id),
    org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    plane TEXT NOT NULL CHECK (plane = 'harness'),
    resource_row_id TEXT NOT NULL REFERENCES memory_v2_resources(resource_row_id),
    receipt_id TEXT NOT NULL REFERENCES memory_run_receipts(receipt_id),
    producer_run_id TEXT NOT NULL CHECK (length(producer_run_id) BETWEEN 1 AND 256),
    evidence_ref_id TEXT NOT NULL CHECK (length(evidence_ref_id) BETWEEN 1 AND 128),
    request_digest TEXT NOT NULL CHECK (
      length(request_digest) = 71
      AND substr(request_digest, 1, 7) = 'sha256:'
      AND substr(request_digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    linked_at TEXT NOT NULL,
    PRIMARY KEY (candidate_id, origin_id),
    UNIQUE (receipt_id, candidate_id, evidence_ref_id)
  );

  CREATE INDEX idx_memory_v2_candidate_origins_domain
    ON memory_v2_candidate_origins(candidate_id, corroboration_domain_id, producer_run_id);
  CREATE INDEX idx_memory_v2_candidate_origins_receipt_ref
    ON memory_v2_candidate_origins(receipt_id, evidence_ref_id, candidate_id);

  CREATE TRIGGER memory_v2_candidate_origins_validate_binding
    BEFORE INSERT ON memory_v2_candidate_origins
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM memory_v2_origins AS origin
        JOIN memory_candidates_v1 AS candidate
          ON candidate.candidate_id = NEW.candidate_id
        JOIN memory_v2_candidate_facets AS facet
          ON facet.candidate_id = candidate.candidate_id
        WHERE origin.origin_id = NEW.origin_id
          AND origin.corroboration_domain_id = NEW.corroboration_domain_id
          AND origin.org_id = NEW.org_id
          AND origin.project_id = NEW.project_id
          AND origin.plane = NEW.plane
          AND origin.resource_row_id = NEW.resource_row_id
          AND origin.receipt_id = NEW.receipt_id
          AND origin.producer_run_id = NEW.producer_run_id
          AND origin.evidence_ref_id = NEW.evidence_ref_id
          AND origin.request_digest = NEW.request_digest
          AND candidate.client_candidate_id = NEW.client_candidate_id
          AND candidate.receipt_id = NEW.receipt_id
          AND candidate.org_id = NEW.org_id
          AND candidate.project_id = NEW.project_id
          AND candidate.plane = NEW.plane
          AND facet.org_id = NEW.org_id
          AND facet.project_id = NEW.project_id
          AND facet.plane = NEW.plane
          AND facet.resource_row_id = NEW.resource_row_id
          AND facet.projection_status = 'mapped'
          AND EXISTS (
            SELECT 1 FROM json_each(origin.candidate_ids_json)
            WHERE value = NEW.candidate_id
          )
      ) THEN RAISE(ABORT, 'v2 candidate origin binding mismatch') END;
    END;

  CREATE TRIGGER memory_v2_candidate_origins_no_update
    BEFORE UPDATE ON memory_v2_candidate_origins
    BEGIN SELECT RAISE(ABORT, 'v2 candidate origins are immutable'); END;
  CREATE TRIGGER memory_v2_candidate_origins_no_delete
    BEFORE DELETE ON memory_v2_candidate_origins
    BEGIN SELECT RAISE(ABORT, 'v2 candidate origins are immutable'); END;

  CREATE TABLE memory_v2_review_signals (
    signal_id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    plane TEXT NOT NULL CHECK (plane = 'harness'),
    resource_row_id TEXT NOT NULL REFERENCES memory_v2_resources(resource_row_id),
    candidate_id TEXT NOT NULL REFERENCES memory_candidates_v1(candidate_id),
    first_corroboration_domain_id TEXT NOT NULL
      REFERENCES memory_v2_corroboration_domains(corroboration_domain_id),
    repeated_corroboration_domain_id TEXT NOT NULL
      REFERENCES memory_v2_corroboration_domains(corroboration_domain_id),
    first_origin_id TEXT NOT NULL REFERENCES memory_v2_origins(origin_id),
    repeated_origin_id TEXT NOT NULL REFERENCES memory_v2_origins(origin_id),
    first_producer_principal_id TEXT NOT NULL REFERENCES service_principals(service_principal_id),
    repeated_producer_principal_id TEXT NOT NULL REFERENCES service_principals(service_principal_id),
    first_producer_run_id TEXT NOT NULL CHECK (length(first_producer_run_id) BETWEEN 1 AND 256),
    repeated_producer_run_id TEXT NOT NULL CHECK (length(repeated_producer_run_id) BETWEEN 1 AND 256),
    outcome_fingerprint TEXT NOT NULL,
    signal_type TEXT NOT NULL CHECK (signal_type = 'repeated_runtime_outcome'),
    status TEXT NOT NULL CHECK (status IN ('open','resolved')),
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    resolution_actor_id TEXT,
    CHECK (first_origin_id <> repeated_origin_id),
    CHECK (first_corroboration_domain_id <> repeated_corroboration_domain_id),
    CHECK (first_producer_principal_id <> repeated_producer_principal_id),
    CHECK (first_producer_run_id <> repeated_producer_run_id),
    CHECK (
      (status = 'open' AND resolved_at IS NULL AND resolution_actor_id IS NULL)
      OR (status = 'resolved' AND resolved_at IS NOT NULL AND resolution_actor_id IS NOT NULL)
    )
  );

  CREATE UNIQUE INDEX idx_memory_v2_review_signals_open_outcome
    ON memory_v2_review_signals(
      org_id, project_id, resource_row_id, candidate_id,
      outcome_fingerprint, signal_type
    )
    WHERE status = 'open';
  CREATE INDEX idx_memory_v2_review_signals_queue
    ON memory_v2_review_signals(org_id, project_id, resource_row_id, status, created_at);

  CREATE TRIGGER memory_v2_review_signals_validate_independence
    BEFORE INSERT ON memory_v2_review_signals
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM memory_v2_origins AS first_origin
        JOIN memory_v2_origins AS repeated_origin
          ON repeated_origin.origin_id = NEW.repeated_origin_id
        JOIN memory_v2_candidate_origins AS candidate_origin
          ON candidate_origin.origin_id = repeated_origin.origin_id
         AND candidate_origin.candidate_id = NEW.candidate_id
        WHERE first_origin.origin_id = NEW.first_origin_id
          AND first_origin.org_id = NEW.org_id
          AND first_origin.project_id = NEW.project_id
          AND first_origin.resource_row_id = NEW.resource_row_id
          AND first_origin.source_authority = 'verified'
          AND first_origin.corroboration_domain_id = NEW.first_corroboration_domain_id
          AND first_origin.producer_principal_id = NEW.first_producer_principal_id
          AND first_origin.producer_run_id = NEW.first_producer_run_id
          AND first_origin.outcome_fingerprint = NEW.outcome_fingerprint
          AND repeated_origin.org_id = NEW.org_id
          AND repeated_origin.project_id = NEW.project_id
          AND repeated_origin.resource_row_id = NEW.resource_row_id
          AND repeated_origin.source_authority = 'verified'
          AND repeated_origin.corroboration_domain_id = NEW.repeated_corroboration_domain_id
          AND repeated_origin.producer_principal_id = NEW.repeated_producer_principal_id
          AND repeated_origin.producer_run_id = NEW.repeated_producer_run_id
          AND repeated_origin.outcome_fingerprint = NEW.outcome_fingerprint
      ) THEN RAISE(ABORT, 'v2 review signal independence mismatch') END;
    END;

  CREATE TRIGGER memory_v2_review_signals_immutable_fields
    BEFORE UPDATE OF
      signal_id, org_id, project_id, plane, resource_row_id, candidate_id,
      first_corroboration_domain_id, repeated_corroboration_domain_id,
      first_origin_id, repeated_origin_id, first_producer_principal_id,
      repeated_producer_principal_id, first_producer_run_id, repeated_producer_run_id,
      outcome_fingerprint, signal_type, created_at
    ON memory_v2_review_signals
    BEGIN SELECT RAISE(ABORT, 'v2 review signal evidence is immutable'); END;
  CREATE TRIGGER memory_v2_review_signals_no_delete
    BEFORE DELETE ON memory_v2_review_signals
    BEGIN SELECT RAISE(ABORT, 'v2 review signals cannot be deleted'); END;
`;
