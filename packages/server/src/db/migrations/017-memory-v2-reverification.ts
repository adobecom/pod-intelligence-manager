export const MEMORY_V2_REVERIFICATION_MIGRATION_SQL = `
  CREATE TABLE memory_v2_record_trust (
    record_id TEXT NOT NULL,
    record_version INTEGER NOT NULL CHECK (record_version >= 1),
    org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    plane TEXT NOT NULL CHECK (plane IN ('codebase','harness')),
    resource_row_id TEXT NOT NULL REFERENCES memory_v2_resources(resource_row_id),
    trust_status TEXT NOT NULL CHECK (trust_status IN ('trusted','untrusted')),
    trust_basis TEXT NOT NULL CHECK (trust_basis IN ('legacy_cutover','evidence_verified')),
    cutover_decided_at TEXT,
    evidence_verified_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (record_id, record_version),
    FOREIGN KEY (record_id, record_version)
      REFERENCES memory_v2_record_facets(record_id, record_version) ON DELETE CASCADE,
    CHECK (
      (trust_basis = 'legacy_cutover'
        AND cutover_decided_at IS NOT NULL
        AND evidence_verified_at IS NULL)
      OR
      (trust_basis = 'evidence_verified'
        AND cutover_decided_at IS NULL
        AND evidence_verified_at IS NOT NULL)
    )
  );

  CREATE INDEX idx_memory_v2_record_trust_scope
    ON memory_v2_record_trust(
      org_id, project_id, plane, resource_row_id, trust_status, record_id, record_version
    );

  CREATE TRIGGER memory_v2_record_trust_validate_binding_insert
    BEFORE INSERT ON memory_v2_record_trust
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM memory_records AS record
        JOIN memory_v2_record_facets AS facet
          ON facet.record_id = NEW.record_id
         AND facet.record_version = NEW.record_version
        JOIN memory_v2_resources AS resource
          ON resource.resource_row_id = NEW.resource_row_id
        WHERE record.record_id = NEW.record_id
          AND record.org_id = NEW.org_id
          AND record.project_id = NEW.project_id
          AND record.plane = NEW.plane
          AND facet.org_id = NEW.org_id
          AND facet.project_id = NEW.project_id
          AND facet.plane = NEW.plane
          AND facet.resource_row_id = NEW.resource_row_id
          AND facet.projection_status = 'mapped'
          AND resource.org_id = NEW.org_id
          AND resource.project_id = NEW.project_id
          AND resource.plane = NEW.plane
      ) THEN RAISE(ABORT, 'v2 record trust binding mismatch') END;
    END;

  CREATE TRIGGER memory_v2_record_trust_validate_binding_update
    BEFORE UPDATE ON memory_v2_record_trust
    BEGIN
      SELECT CASE WHEN
        NEW.record_id <> OLD.record_id
        OR NEW.record_version <> OLD.record_version
        OR NEW.org_id <> OLD.org_id
        OR NEW.project_id <> OLD.project_id
        OR NEW.plane <> OLD.plane
        OR NEW.resource_row_id <> OLD.resource_row_id
        OR NEW.trust_basis <> OLD.trust_basis
        OR NEW.cutover_decided_at IS NOT OLD.cutover_decided_at
        OR NEW.evidence_verified_at IS NOT OLD.evidence_verified_at
        OR NEW.created_at <> OLD.created_at
      THEN RAISE(ABORT, 'v2 record trust identity is immutable') END;
    END;

  INSERT INTO memory_v2_record_trust (
    record_id, record_version, org_id, project_id, plane, resource_row_id,
    trust_status, trust_basis, cutover_decided_at, evidence_verified_at,
    created_at, updated_at
  )
  SELECT
    record.record_id,
    record.current_version,
    record.org_id,
    record.project_id,
    record.plane,
    facet.resource_row_id,
    'trusted',
    'legacy_cutover',
    (
      SELECT transition.occurred_at
      FROM memory_authority_transitions AS transition
      WHERE transition.to_authority = 'canonical'
      ORDER BY transition.revision DESC
      LIMIT 1
    ),
    NULL,
    (
      SELECT transition.occurred_at
      FROM memory_authority_transitions AS transition
      WHERE transition.to_authority = 'canonical'
      ORDER BY transition.revision DESC
      LIMIT 1
    ),
    (
      SELECT transition.occurred_at
      FROM memory_authority_transitions AS transition
      WHERE transition.to_authority = 'canonical'
      ORDER BY transition.revision DESC
      LIMIT 1
    )
  FROM memory_records AS record
  JOIN memory_v2_record_facets AS facet
    ON facet.record_id = record.record_id
   AND facet.record_version = record.current_version
  JOIN memory_v2_resources AS resource
    ON resource.resource_row_id = facet.resource_row_id
  WHERE record.current_status = 'active'
    AND record.plane IN ('codebase','harness')
    AND facet.org_id = record.org_id
    AND facet.project_id = record.project_id
    AND facet.plane = record.plane
    AND facet.projection_status = 'mapped'
    AND resource.org_id = record.org_id
    AND resource.project_id = record.project_id
    AND resource.plane = record.plane
    AND resource.valid_until IS NULL;

  CREATE TABLE memory_v2_reverification_policies (
    policy_id TEXT PRIMARY KEY,
    record_id TEXT NOT NULL,
    record_version INTEGER NOT NULL CHECK (record_version >= 1),
    org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    plane TEXT NOT NULL CHECK (plane IN ('codebase','harness')),
    resource_row_id TEXT NOT NULL REFERENCES memory_v2_resources(resource_row_id),
    resolver_type TEXT NOT NULL CHECK (resolver_type IN ('github','runtime_attestation')),
    policy_revision INTEGER NOT NULL CHECK (policy_revision >= 1),
    interval_seconds INTEGER NOT NULL CHECK (interval_seconds >= 60),
    max_age_seconds INTEGER NOT NULL CHECK (max_age_seconds >= interval_seconds),
    max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 64),
    active INTEGER NOT NULL CHECK (active IN (0, 1)),
    policy_digest TEXT NOT NULL CHECK (
      length(policy_digest) = 71
      AND substr(policy_digest, 1, 7) = 'sha256:'
      AND substr(policy_digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (record_id, record_version, policy_revision),
    FOREIGN KEY (record_id, record_version)
      REFERENCES memory_v2_record_facets(record_id, record_version)
  );

  CREATE INDEX idx_memory_v2_reverification_policies_record
    ON memory_v2_reverification_policies(record_id, record_version, policy_revision DESC);

  CREATE TRIGGER memory_v2_reverification_policies_validate_target
    BEFORE INSERT ON memory_v2_reverification_policies
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM memory_records AS record
        JOIN memory_v2_record_facets AS facet
          ON facet.record_id = record.record_id
         AND facet.record_version = record.current_version
        JOIN memory_v2_resources AS resource
          ON resource.resource_row_id = facet.resource_row_id
        WHERE record.record_id = NEW.record_id
          AND record.org_id = NEW.org_id
          AND record.project_id = NEW.project_id
          AND record.plane = NEW.plane
          AND record.current_version = NEW.record_version
          AND record.current_status = 'active'
          AND (
            (NEW.plane = 'codebase' AND NEW.resolver_type = 'github')
            OR (NEW.plane = 'harness' AND NEW.resolver_type = 'runtime_attestation')
          )
          AND facet.org_id = NEW.org_id
          AND facet.project_id = NEW.project_id
          AND facet.plane = NEW.plane
          AND facet.resource_row_id = NEW.resource_row_id
          AND facet.projection_status = 'mapped'
          AND resource.org_id = NEW.org_id
          AND resource.project_id = NEW.project_id
          AND resource.plane = NEW.plane
          AND resource.valid_until IS NULL
      ) THEN RAISE(ABORT, 'v2 reverification policy target mismatch') END;
    END;

  CREATE TRIGGER memory_v2_reverification_policies_no_update
    BEFORE UPDATE ON memory_v2_reverification_policies
    BEGIN SELECT RAISE(ABORT, 'v2 reverification policies are append-only'); END;
  CREATE TRIGGER memory_v2_reverification_policies_no_delete
    BEFORE DELETE ON memory_v2_reverification_policies
    BEGIN SELECT RAISE(ABORT, 'v2 reverification policies are append-only'); END;

  CREATE TABLE memory_v2_reverification_state (
    record_id TEXT NOT NULL,
    record_version INTEGER NOT NULL CHECK (record_version >= 1),
    org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    plane TEXT NOT NULL CHECK (plane IN ('codebase','harness')),
    resource_row_id TEXT NOT NULL REFERENCES memory_v2_resources(resource_row_id),
    policy_id TEXT NOT NULL REFERENCES memory_v2_reverification_policies(policy_id),
    policy_revision INTEGER NOT NULL CHECK (policy_revision >= 1),
    state_version INTEGER NOT NULL CHECK (state_version >= 1),
    status TEXT NOT NULL CHECK (status IN (
      'fresh','due','pending','contradicted','withdrawn','expired'
    )),
    influence_eligible INTEGER NOT NULL CHECK (influence_eligible IN (0, 1)),
    last_verified_at TEXT,
    next_reverify_at TEXT NOT NULL,
    last_attempt_at TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
    last_error_code TEXT,
    latest_decision_id TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (record_id, record_version),
    FOREIGN KEY (record_id, record_version)
      REFERENCES memory_v2_record_facets(record_id, record_version),
    CHECK (
      (status IN ('contradicted','withdrawn','expired')
        AND influence_eligible = 0)
      OR (status IN ('fresh','due','pending') AND influence_eligible = 1)
    )
  );

  CREATE INDEX idx_memory_v2_reverification_state_due
    ON memory_v2_reverification_state(status, next_reverify_at, record_id, record_version)
    WHERE status IN ('fresh','due','pending');
  CREATE INDEX idx_memory_v2_reverification_state_scope
    ON memory_v2_reverification_state(org_id, project_id, plane, resource_row_id, status);

  CREATE TRIGGER memory_v2_reverification_state_validate_binding_insert
    BEFORE INSERT ON memory_v2_reverification_state
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM memory_v2_reverification_policies AS policy
        JOIN memory_v2_record_facets AS facet
          ON facet.record_id = policy.record_id
         AND facet.record_version = policy.record_version
        WHERE policy.policy_id = NEW.policy_id
          AND policy.record_id = NEW.record_id
          AND policy.record_version = NEW.record_version
          AND policy.org_id = NEW.org_id
          AND policy.project_id = NEW.project_id
          AND policy.plane = NEW.plane
          AND policy.resource_row_id = NEW.resource_row_id
          AND policy.policy_revision = NEW.policy_revision
          AND facet.org_id = NEW.org_id
          AND facet.project_id = NEW.project_id
          AND facet.plane = NEW.plane
          AND facet.resource_row_id = NEW.resource_row_id
          AND facet.projection_status = 'mapped'
      ) THEN RAISE(ABORT, 'v2 reverification state binding mismatch') END;
    END;

  CREATE TRIGGER memory_v2_reverification_state_validate_binding_update
    BEFORE UPDATE ON memory_v2_reverification_state
    BEGIN
      SELECT CASE WHEN
        NEW.record_id <> OLD.record_id
        OR NEW.record_version <> OLD.record_version
        OR NEW.org_id <> OLD.org_id
        OR NEW.project_id <> OLD.project_id
        OR NEW.plane <> OLD.plane
        OR NEW.resource_row_id <> OLD.resource_row_id
        OR NEW.state_version <> OLD.state_version + 1
        OR NOT EXISTS (
          SELECT 1 FROM memory_v2_reverification_policies AS policy
          WHERE policy.policy_id = NEW.policy_id
            AND policy.record_id = NEW.record_id
            AND policy.record_version = NEW.record_version
            AND policy.org_id = NEW.org_id
            AND policy.project_id = NEW.project_id
            AND policy.plane = NEW.plane
            AND policy.resource_row_id = NEW.resource_row_id
            AND policy.policy_revision = NEW.policy_revision
        )
      THEN RAISE(ABORT, 'v2 reverification state update mismatch') END;
    END;

  CREATE TABLE memory_v2_reverification_decisions (
    decision_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES memory_v2_reverification_jobs(job_id),
    record_id TEXT NOT NULL,
    record_version INTEGER NOT NULL CHECK (record_version >= 1),
    org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    plane TEXT NOT NULL CHECK (plane IN ('codebase','harness')),
    resource_row_id TEXT NOT NULL REFERENCES memory_v2_resources(resource_row_id),
    policy_id TEXT NOT NULL REFERENCES memory_v2_reverification_policies(policy_id),
    policy_revision INTEGER NOT NULL CHECK (policy_revision >= 1),
    expected_state_version INTEGER NOT NULL CHECK (expected_state_version >= 1),
    committed_state_version INTEGER NOT NULL CHECK (
      committed_state_version = expected_state_version + 1
    ),
    from_status TEXT NOT NULL,
    to_status TEXT NOT NULL,
    provider_outcome TEXT NOT NULL CHECK (provider_outcome IN (
      'verified','contradicted','withdrawn','expired','unavailable'
    )),
    reason_code TEXT NOT NULL,
    evidence_digest TEXT CHECK (
      evidence_digest IS NULL OR (
        length(evidence_digest) = 71
        AND substr(evidence_digest, 1, 7) = 'sha256:'
        AND substr(evidence_digest, 8) NOT GLOB '*[^0-9a-f]*'
      )
    ),
    source_occurred_at TEXT,
    canonical_from_status TEXT NOT NULL CHECK (
      canonical_from_status IN ('active','stale','superseded','revoked','expired')
    ),
    canonical_to_status TEXT NOT NULL CHECK (
      canonical_to_status IN ('active','stale','superseded','revoked','expired')
    ),
    attempted_at TEXT NOT NULL,
    decided_at TEXT NOT NULL,
    decision_digest TEXT NOT NULL CHECK (
      length(decision_digest) = 71
      AND substr(decision_digest, 1, 7) = 'sha256:'
      AND substr(decision_digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    created_at TEXT NOT NULL,
    FOREIGN KEY (record_id, record_version)
      REFERENCES memory_v2_reverification_state(record_id, record_version)
  );

  CREATE INDEX idx_memory_v2_reverification_decisions_record
    ON memory_v2_reverification_decisions(record_id, record_version, created_at DESC);

  CREATE TRIGGER memory_v2_reverification_decisions_validate_binding
    BEFORE INSERT ON memory_v2_reverification_decisions
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM memory_v2_reverification_jobs AS job
        JOIN memory_v2_reverification_state AS state
          ON state.record_id = job.record_id
         AND state.record_version = job.record_version
        JOIN memory_v2_reverification_policies AS policy
          ON policy.policy_id = job.policy_id
        WHERE job.job_id = NEW.job_id
          AND job.record_id = NEW.record_id
          AND job.record_version = NEW.record_version
          AND job.org_id = NEW.org_id
          AND job.project_id = NEW.project_id
          AND job.plane = NEW.plane
          AND job.resource_row_id = NEW.resource_row_id
          AND job.policy_id = NEW.policy_id
          AND job.policy_revision = NEW.policy_revision
          AND job.expected_state_version = NEW.expected_state_version
          AND state.state_version = NEW.expected_state_version
          AND state.status = NEW.from_status
          AND policy.record_id = NEW.record_id
          AND policy.record_version = NEW.record_version
          AND policy.org_id = NEW.org_id
          AND policy.project_id = NEW.project_id
          AND policy.plane = NEW.plane
          AND policy.resource_row_id = NEW.resource_row_id
          AND policy.policy_revision = NEW.policy_revision
      ) THEN RAISE(ABORT, 'v2 reverification decision binding mismatch') END;
      SELECT CASE WHEN
        (NEW.provider_outcome = 'verified'
          AND (NEW.to_status <> 'fresh' OR NEW.canonical_to_status <> 'active'))
        OR (NEW.provider_outcome = 'contradicted'
          AND (NEW.to_status <> 'contradicted' OR NEW.canonical_to_status <> 'revoked'))
        OR (NEW.provider_outcome = 'withdrawn'
          AND (NEW.to_status <> 'withdrawn' OR NEW.canonical_to_status <> 'revoked'))
        OR (NEW.provider_outcome = 'expired'
          AND (NEW.to_status <> 'expired' OR NEW.canonical_to_status <> 'expired'))
        OR (NEW.provider_outcome = 'unavailable'
          AND (NEW.to_status <> 'pending' OR NEW.canonical_to_status <> 'active'))
        OR NEW.canonical_from_status <> 'active'
      THEN RAISE(ABORT, 'v2 reverification decision lifecycle mapping mismatch') END;
    END;

  CREATE TRIGGER memory_v2_reverification_decisions_no_update
    BEFORE UPDATE ON memory_v2_reverification_decisions
    BEGIN SELECT RAISE(ABORT, 'v2 reverification decisions are immutable'); END;
  CREATE TRIGGER memory_v2_reverification_decisions_no_delete
    BEFORE DELETE ON memory_v2_reverification_decisions
    BEGIN SELECT RAISE(ABORT, 'v2 reverification decisions are immutable'); END;

  CREATE TABLE memory_v2_reverification_jobs (
    job_id TEXT PRIMARY KEY,
    record_id TEXT NOT NULL,
    record_version INTEGER NOT NULL CHECK (record_version >= 1),
    org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    plane TEXT NOT NULL CHECK (plane IN ('codebase','harness')),
    resource_row_id TEXT NOT NULL REFERENCES memory_v2_resources(resource_row_id),
    policy_id TEXT NOT NULL REFERENCES memory_v2_reverification_policies(policy_id),
    policy_revision INTEGER NOT NULL CHECK (policy_revision >= 1),
    expected_state_version INTEGER NOT NULL CHECK (expected_state_version >= 1),
    scheduled_for TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','leased','completed','dead_letter')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 64),
    next_attempt_at TEXT NOT NULL,
    lease_owner TEXT,
    lease_expires_at TEXT,
    last_error_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    dead_lettered_at TEXT,
    UNIQUE (record_id, record_version, scheduled_for, expected_state_version),
    FOREIGN KEY (record_id, record_version)
      REFERENCES memory_v2_reverification_state(record_id, record_version),
    CHECK (
      (status = 'leased' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR (status <> 'leased' AND lease_owner IS NULL AND lease_expires_at IS NULL)
    ),
    CHECK (
      (status = 'completed' AND completed_at IS NOT NULL AND dead_lettered_at IS NULL)
      OR (status <> 'completed' AND completed_at IS NULL)
    ),
    CHECK (
      (status = 'dead_letter' AND dead_lettered_at IS NOT NULL
        AND completed_at IS NULL AND last_error_code IS NOT NULL)
      OR (status <> 'dead_letter' AND dead_lettered_at IS NULL)
    )
  );

  CREATE INDEX idx_memory_v2_reverification_jobs_dispatch
    ON memory_v2_reverification_jobs(status, next_attempt_at, lease_expires_at, created_at);

  CREATE TRIGGER memory_v2_reverification_jobs_validate_binding_insert
    BEFORE INSERT ON memory_v2_reverification_jobs
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM memory_v2_reverification_state AS state
        JOIN memory_v2_reverification_policies AS policy
          ON policy.policy_id = state.policy_id
        WHERE state.record_id = NEW.record_id
          AND state.record_version = NEW.record_version
          AND state.org_id = NEW.org_id
          AND state.project_id = NEW.project_id
          AND state.plane = NEW.plane
          AND state.resource_row_id = NEW.resource_row_id
          AND state.policy_id = NEW.policy_id
          AND state.policy_revision = NEW.policy_revision
          AND state.state_version = NEW.expected_state_version
          AND policy.policy_id = NEW.policy_id
          AND policy.policy_revision = NEW.policy_revision
          AND policy.active = 1
      ) THEN RAISE(ABORT, 'v2 reverification job binding mismatch') END;
    END;

  CREATE TRIGGER memory_v2_reverification_jobs_validate_binding_update
    BEFORE UPDATE ON memory_v2_reverification_jobs
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM memory_v2_reverification_state AS state
        WHERE state.record_id = NEW.record_id
          AND state.record_version = NEW.record_version
          AND state.org_id = NEW.org_id
          AND state.project_id = NEW.project_id
          AND state.plane = NEW.plane
          AND state.resource_row_id = NEW.resource_row_id
          AND state.policy_id = NEW.policy_id
          AND state.policy_revision = NEW.policy_revision
          AND state.state_version = NEW.expected_state_version
      ) THEN RAISE(ABORT, 'v2 reverification job state mismatch') END;
    END;

  CREATE TRIGGER memory_v2_reverification_jobs_identity_immutable
    BEFORE UPDATE OF
      job_id, record_id, record_version, org_id, project_id, plane,
      resource_row_id, policy_id, policy_revision, scheduled_for, max_attempts, created_at
    ON memory_v2_reverification_jobs
    BEGIN SELECT RAISE(ABORT, 'v2 reverification job identity is immutable'); END;

  CREATE TRIGGER memory_v2_reverification_jobs_validate_transition
    BEFORE UPDATE OF
      status, attempt_count, next_attempt_at, lease_owner, lease_expires_at,
      last_error_code, updated_at, completed_at, dead_lettered_at,
      expected_state_version
    ON memory_v2_reverification_jobs
    BEGIN
      SELECT CASE WHEN OLD.status IN ('completed','dead_letter')
        THEN RAISE(ABORT, 'v2 reverification terminal job is immutable') END;
      SELECT CASE WHEN NOT (
        (OLD.status = 'pending' AND NEW.status IN ('leased','dead_letter'))
        OR (OLD.status = 'leased' AND NEW.status IN (
          'leased','pending','completed','dead_letter'
        ))
      ) THEN RAISE(ABORT, 'v2 reverification job status transition mismatch') END;
      SELECT CASE WHEN
        NEW.attempt_count < OLD.attempt_count
        OR NEW.attempt_count > NEW.max_attempts
        OR (OLD.status = 'pending' AND NEW.status = 'leased'
          AND NEW.attempt_count <> OLD.attempt_count + 1)
        OR ((OLD.status <> 'pending' OR NEW.status <> 'leased')
          AND NEW.attempt_count <> OLD.attempt_count)
      THEN RAISE(ABORT, 'v2 reverification job attempt transition mismatch') END;
    END;

  CREATE TRIGGER memory_v2_reverification_jobs_no_delete
    BEFORE DELETE ON memory_v2_reverification_jobs
    BEGIN SELECT RAISE(ABORT, 'v2 reverification jobs cannot be deleted'); END;

  CREATE TABLE memory_v2_reverification_job_attempts (
    attempt_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES memory_v2_reverification_jobs(job_id),
    attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
    worker_id TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN (
      'verified','contradicted','withdrawn','expired','retry','dead_letter'
    )),
    error_code TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    UNIQUE (job_id, attempt_number)
  );

  CREATE TRIGGER memory_v2_reverification_job_attempts_no_update
    BEFORE UPDATE ON memory_v2_reverification_job_attempts
    BEGIN SELECT RAISE(ABORT, 'v2 reverification attempts are immutable'); END;
  CREATE TRIGGER memory_v2_reverification_job_attempts_no_delete
    BEFORE DELETE ON memory_v2_reverification_job_attempts
    BEGIN SELECT RAISE(ABORT, 'v2 reverification attempts are immutable'); END;
`;
