import { randomUUID } from "node:crypto";
import db from "./connection.js";

export const ORG_CONFIG_ROW_KEY = "org_config";
export const ORG_TUNING_ROW_KEY = "org_tuning";

export function createTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      ims_user_id TEXT UNIQUE,
      email TEXT NOT NULL,
      display_name TEXT,
      is_service INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_login_at TEXT
    );

    CREATE TABLE IF NOT EXISTS orgs (
      org_id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      created_by_user_id TEXT NOT NULL REFERENCES users(user_id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memberships (
      org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(user_id),
      role TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
      created_at TEXT NOT NULL,
      PRIMARY KEY (org_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);

    CREATE TABLE IF NOT EXISTS service_principals (
      service_principal_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(user_id),
      org_id TEXT NOT NULL REFERENCES orgs(org_id),
      name TEXT NOT NULL,
      created_by_user_id TEXT NOT NULL REFERENCES users(user_id),
      created_at TEXT NOT NULL,
      disabled_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_service_principals_org ON service_principals(org_id);
    CREATE INDEX IF NOT EXISTS idx_service_principals_user ON service_principals(user_id);

    CREATE TABLE IF NOT EXISTS service_tokens (
      token_id TEXT PRIMARY KEY,
      service_principal_id TEXT NOT NULL REFERENCES service_principals(service_principal_id),
      token_prefix TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      scopes_json TEXT NOT NULL,
      project_id TEXT,
      pod_id TEXT,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      last_used_at TEXT,
      created_at TEXT NOT NULL,
      created_by_user_id TEXT NOT NULL REFERENCES users(user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_service_tokens_principal ON service_tokens(service_principal_id);
    CREATE INDEX IF NOT EXISTS idx_service_tokens_project ON service_tokens(project_id) WHERE project_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_service_tokens_pod ON service_tokens(pod_id) WHERE pod_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS org_invites (
      invite_id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','member')),
      invited_by_user_id TEXT NOT NULL REFERENCES users(user_id),
      created_at TEXT NOT NULL,
      accepted_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_org_invites_email ON org_invites(email) WHERE accepted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_org_invites_org ON org_invites(org_id);

    CREATE TABLE IF NOT EXISTS org_settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      project_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pods (
      pod_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sprint_start TEXT NOT NULL,
      sprint_end TEXT NOT NULL,
      day_number INTEGER NOT NULL,
      total_days INTEGER NOT NULL,
      conflict_pressure REAL NOT NULL DEFAULT 0.0,
      milestone_json TEXT NOT NULL,
      project_id TEXT REFERENCES projects(project_id)
    );

    CREATE TABLE IF NOT EXISTS pod_areas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pod_id TEXT NOT NULL REFERENCES pods(pod_id),
      scope TEXT NOT NULL,
      owner TEXT NOT NULL,
      status TEXT NOT NULL,
      last_activity TEXT
    );

    CREATE TABLE IF NOT EXISTS context_updates (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      pod_id TEXT NOT NULL REFERENCES pods(pod_id),
      type TEXT NOT NULL,
      scope TEXT NOT NULL,
      summary TEXT NOT NULL,
      details TEXT NOT NULL,
      retrieval_text TEXT,
      entity_refs_json TEXT NOT NULL DEFAULT '[]',
      artifacts_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL,
      quality_score REAL NOT NULL DEFAULT 0.0,
      quality_rationale TEXT,
      blocks_json TEXT NOT NULL DEFAULT '[]',
      blocked_by_json TEXT NOT NULL DEFAULT '[]',
      needs_input_from_json TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT 'manual',
      commit_sha TEXT,
      retracted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS conflicts (
      id TEXT PRIMARY KEY,
      pod_id TEXT NOT NULL REFERENCES pods(pod_id),
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      severity TEXT NOT NULL,
      summary TEXT NOT NULL,
      sides_json TEXT NOT NULL,
      master_analysis TEXT NOT NULL,
      impact_json TEXT NOT NULL DEFAULT '[]',
      resolved_by TEXT,
      resolution TEXT,
      resolution_date TEXT,
      escalation_level INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS pending_work (
      context_update_id TEXT PRIMARY KEY,
      conflict_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      presumes TEXT NOT NULL,
      rework_cost TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tunnels (
      tunnel_id TEXT PRIMARY KEY,
      pod_id TEXT NOT NULL REFERENCES pods(pod_id),
      dev_name TEXT NOT NULL,
      branch TEXT NOT NULL,
      url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      last_activity TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS org_pod_summaries (
      pod_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      day_number INTEGER NOT NULL,
      total_days INTEGER NOT NULL,
      conflict_pressure REAL NOT NULL,
      open_conflicts INTEGER NOT NULL,
      active_tunnels INTEGER NOT NULL,
      agent_count INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cross_pod_overlaps (
      id TEXT PRIMARY KEY,
      pod_a TEXT NOT NULL,
      pod_b TEXT NOT NULL,
      description TEXT NOT NULL,
      advisory TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS archived_pods (
      pod_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      completed_date TEXT NOT NULL,
      duration_days INTEGER NOT NULL,
      final_pressure REAL NOT NULL,
      extraction_completed INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS archived_projects (
      project_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL,
      anatomy_json TEXT NOT NULL,
      archived_date TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lint_findings (
      id TEXT PRIMARY KEY,
      pod_id TEXT NOT NULL REFERENCES pods(pod_id),
      timestamp TEXT NOT NULL,
      type TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info',
      summary TEXT NOT NULL,
      area TEXT,
      suggestion TEXT
    );

    CREATE TABLE IF NOT EXISTS living_docs (
      pod_id TEXT PRIMARY KEY,
      markdown TEXT NOT NULL,
      last_regenerated_at TEXT,
      regen_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS living_doc_views (
      pod_id TEXT NOT NULL REFERENCES pods(pod_id),
      viewer_id TEXT NOT NULL,
      last_viewed_at TEXT NOT NULL,
      view_count INTEGER NOT NULL DEFAULT 1,
      last_viewed_regen_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (pod_id, viewer_id)
    );

    CREATE TABLE IF NOT EXISTS knowledge_nodes (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      summary TEXT NOT NULL,
      details TEXT NOT NULL,
      source_pod_id TEXT NOT NULL,
      source_pod_name TEXT NOT NULL,
      domains_json TEXT NOT NULL DEFAULT '[]',
      confidence TEXT NOT NULL,
      confidence_score REAL NOT NULL,
      created_at TEXT NOT NULL,
      curated INTEGER NOT NULL DEFAULT 0,
      community_id TEXT,
      retrieval_text TEXT,
      entity_refs_json TEXT NOT NULL DEFAULT '[]',
      retention_score REAL NOT NULL DEFAULT 0.5,
      retrieval_tier TEXT NOT NULL DEFAULT 'hot',
      retrieval_count INTEGER NOT NULL DEFAULT 0,
      last_retrieved_at TEXT,
      embedding_json TEXT
    );

    CREATE TABLE IF NOT EXISTS project_context_updates (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(project_id),
      type TEXT NOT NULL,
      scope TEXT NOT NULL,
      summary TEXT NOT NULL,
      details TEXT NOT NULL,
      retrieval_text TEXT,
      entity_refs_json TEXT NOT NULL DEFAULT '[]',
      artifacts_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL,
      quality_score REAL NOT NULL DEFAULT 0.0,
      blocks_json TEXT NOT NULL DEFAULT '[]',
      blocked_by_json TEXT NOT NULL DEFAULT '[]',
      needs_input_from_json TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT 'manual',
      commit_sha TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_project_context_updates_project_time
      ON project_context_updates(project_id, timestamp DESC);

    CREATE TABLE IF NOT EXISTS project_evidence_items (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_url TEXT,
      source_title TEXT NOT NULL,
      summary TEXT NOT NULL,
      body TEXT NOT NULL,
      author TEXT,
      occurred_at TEXT NOT NULL,
      ingested_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      confidence_score REAL NOT NULL DEFAULT 0.0,
      promotable INTEGER NOT NULL DEFAULT 0,
      promoted_node_id TEXT,
      source_instance TEXT NOT NULL DEFAULT 'legacy',
      native_id TEXT,
      source_version TEXT,
      visibility TEXT NOT NULL DEFAULT 'unknown',
      visibility_version TEXT NOT NULL DEFAULT '1',
      redaction_version TEXT NOT NULL DEFAULT 'legacy',
      normalized_content_hash TEXT,
      source_updated_at TEXT,
      UNIQUE (org_id, project_id, source, source_id)
    );

    CREATE INDEX IF NOT EXISTS idx_project_evidence_project_time
      ON project_evidence_items(org_id, project_id, occurred_at DESC);

    CREATE TABLE IF NOT EXISTS project_memory_candidates (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
      evidence_item_id TEXT NOT NULL REFERENCES project_evidence_items(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      summary TEXT NOT NULL,
      details TEXT NOT NULL,
      domains_json TEXT NOT NULL DEFAULT '[]',
      confidence_score REAL NOT NULL DEFAULT 0.0,
      source TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','promoted','rejected')),
      created_at TEXT NOT NULL,
      reviewed_at TEXT,
      promoted_node_id TEXT,
      UNIQUE (org_id, project_id, evidence_item_id, summary)
    );

    CREATE INDEX IF NOT EXISTS idx_project_memory_candidates_project_status
      ON project_memory_candidates(org_id, project_id, status, created_at DESC);

    CREATE TABLE IF NOT EXISTS project_ingestion_cursors (
      org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      cursor_key TEXT NOT NULL,
      cursor_value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (org_id, project_id, source, cursor_key)
    );

    CREATE TABLE IF NOT EXISTS project_source_sync_state (
      org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      source_instance TEXT NOT NULL,
      last_attempt_at TEXT,
      last_success_at TEXT,
      last_reconciliation_at TEXT,
      lag_seconds INTEGER,
      indexed_count INTEGER NOT NULL DEFAULT 0,
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_error_code TEXT,
      last_error_message TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (org_id, project_id, source, source_instance)
    );

    CREATE TABLE IF NOT EXISTS project_source_quarantine (
      org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      source_instance TEXT NOT NULL,
      native_id TEXT NOT NULL,
      source_version TEXT,
      error_code TEXT NOT NULL,
      retry_count INTEGER NOT NULL DEFAULT 0,
      first_seen_at TEXT NOT NULL,
      last_attempt_at TEXT NOT NULL,
      PRIMARY KEY (org_id, project_id, source, source_instance, native_id)
    );

    -- Indexed Project Search: broad, current project-artifact index (distinct from the org KG).
    CREATE TABLE IF NOT EXISTS project_search_documents (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_url TEXT,
      title TEXT NOT NULL,
      author TEXT,
      status TEXT,
      occurred_at TEXT,
      ingested_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      permissions_json TEXT NOT NULL DEFAULT '{}',
      freshness_state TEXT NOT NULL DEFAULT 'fresh',
      source_instance TEXT NOT NULL DEFAULT 'legacy',
      native_id TEXT,
      source_version TEXT,
      visibility TEXT NOT NULL DEFAULT 'unknown',
      visibility_version TEXT NOT NULL DEFAULT '1',
      redaction_version TEXT NOT NULL DEFAULT 'legacy',
      normalized_content_hash TEXT,
      source_updated_at TEXT,
      graph_enabled INTEGER NOT NULL DEFAULT 1,
      UNIQUE (org_id, project_id, source, source_id)
    );

    CREATE INDEX IF NOT EXISTS idx_project_search_docs_scope
      ON project_search_documents(org_id, project_id, source, occurred_at DESC);

    CREATE TABLE IF NOT EXISTS project_search_chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES project_search_documents(id) ON DELETE CASCADE,
      org_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      chunk_kind TEXT NOT NULL,
      text TEXT NOT NULL,
      retrieval_text TEXT,
      embedding_json TEXT,
      embedding_model TEXT,
      embedding_text_hash TEXT,
      token_estimate INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_project_search_chunks_doc
      ON project_search_chunks(document_id);
    CREATE INDEX IF NOT EXISTS idx_project_search_chunks_scope
      ON project_search_chunks(org_id, project_id);

    CREATE TABLE IF NOT EXISTS project_search_entities (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
      entity_type TEXT NOT NULL,
      entity_key TEXT NOT NULL,
      label TEXT NOT NULL,
      aliases_json TEXT NOT NULL DEFAULT '[]',
      source_document_id TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      UNIQUE (org_id, project_id, entity_type, entity_key)
    );

    CREATE INDEX IF NOT EXISTS idx_project_search_entities_scope
      ON project_search_entities(org_id, project_id, entity_type);

    CREATE TABLE IF NOT EXISTS project_search_edges (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
      source_entity_id TEXT NOT NULL REFERENCES project_search_entities(id) ON DELETE CASCADE,
      target_entity_id TEXT NOT NULL REFERENCES project_search_entities(id) ON DELETE CASCADE,
      edge_type TEXT NOT NULL,
      evidence_document_id TEXT,
      confidence_score REAL NOT NULL DEFAULT 0.5,
      created_at TEXT NOT NULL,
      UNIQUE (org_id, project_id, source_entity_id, target_entity_id, edge_type)
    );

    CREATE INDEX IF NOT EXISTS idx_project_search_edges_src
      ON project_search_edges(org_id, project_id, source_entity_id);
    CREATE INDEX IF NOT EXISTS idx_project_search_edges_tgt
      ON project_search_edges(org_id, project_id, target_entity_id);

    CREATE TABLE IF NOT EXISTS ingestion_queue (
      id TEXT PRIMARY KEY,
      pod_id TEXT NOT NULL REFERENCES pods(pod_id),
      org_id TEXT,
      payload_json TEXT NOT NULL,
      queued_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
    );

    CREATE INDEX IF NOT EXISTS idx_ingestion_queue_pod_status
      ON ingestion_queue(pod_id, status);

    CREATE TABLE IF NOT EXISTS agent_sessions (
      session_id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
      project_id TEXT REFERENCES projects(project_id),
      pod_id TEXT REFERENCES pods(pod_id),
      scope TEXT,
      agent_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','ended')),
      goal TEXT,
      current_task TEXT,
      working_state_json TEXT NOT NULL DEFAULT '{}',
      compacted_summary TEXT,
      last_compacted_event_rowid INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      ended_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_agent_sessions_org_pod
      ON agent_sessions(org_id, pod_id, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_sessions_org_project
      ON agent_sessions(org_id, project_id, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_sessions_agent
      ON agent_sessions(org_id, agent_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS agent_runs (
      run_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
      org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
      project_id TEXT REFERENCES projects(project_id),
      pod_id TEXT REFERENCES pods(pod_id),
      scope TEXT,
      agent_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed','cancelled')),
      input_prompt TEXT,
      model TEXT,
      provider TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      token_input_count INTEGER NOT NULL DEFAULT 0,
      token_output_count INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0.0,
      error_message TEXT,
      final_output TEXT,
      context_update_id TEXT,
      compacted_summary TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_agent_runs_session_time
      ON agent_runs(session_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_org_status
      ON agent_runs(org_id, status, started_at DESC);

    CREATE TABLE IF NOT EXISTS agent_run_events (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES agent_runs(run_id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
      org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      summary TEXT,
      artifact_refs_json TEXT NOT NULL DEFAULT '[]',
      token_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE (run_id, seq)
    );

    CREATE INDEX IF NOT EXISTS idx_agent_run_events_run_seq
      ON agent_run_events(run_id, seq);
    CREATE INDEX IF NOT EXISTS idx_agent_run_events_session_time
      ON agent_run_events(session_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS agent_checkpoints (
      checkpoint_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
      run_id TEXT REFERENCES agent_runs(run_id) ON DELETE CASCADE,
      org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL DEFAULT '{}',
      summary TEXT,
      artifact_refs_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_checkpoints_session_seq
      ON agent_checkpoints(session_id, seq DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_checkpoints_run_seq
      ON agent_checkpoints(run_id, seq DESC);

    CREATE TABLE IF NOT EXISTS memory_candidates (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
      project_id TEXT REFERENCES projects(project_id),
      pod_id TEXT REFERENCES pods(pod_id),
      session_id TEXT REFERENCES agent_sessions(session_id) ON DELETE SET NULL,
      run_id TEXT REFERENCES agent_runs(run_id) ON DELETE SET NULL,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      type TEXT NOT NULL,
      summary TEXT NOT NULL,
      details TEXT NOT NULL,
      retrieval_text TEXT,
      entity_refs_json TEXT NOT NULL DEFAULT '[]',
      domains_json TEXT NOT NULL DEFAULT '[]',
      confidence_score REAL NOT NULL DEFAULT 0.0,
      evidence_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','promoted','rejected','auto_promoted')),
      promoted_node_id TEXT,
      created_at TEXT NOT NULL,
      reviewed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_memory_candidates_org_status
      ON memory_candidates(org_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_candidates_session
      ON memory_candidates(session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_candidates_project
      ON memory_candidates(org_id, project_id, status, created_at DESC);

    CREATE TABLE IF NOT EXISTS memory_entities (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
      entity_type TEXT NOT NULL,
      entity_key TEXT NOT NULL,
      label TEXT NOT NULL,
      aliases_json TEXT NOT NULL DEFAULT '[]',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (org_id, entity_type, entity_key)
    );

    CREATE INDEX IF NOT EXISTS idx_memory_entities_org_type
      ON memory_entities(org_id, entity_type, label);

    CREATE TABLE IF NOT EXISTS memory_relationships (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
      source_entity_id TEXT NOT NULL,
      target_entity_id TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      valid_from TEXT NOT NULL,
      valid_until TEXT,
      committed_at TEXT NOT NULL,
      source_update_refs_json TEXT NOT NULL DEFAULT '[]',
      artifact_refs_json TEXT NOT NULL DEFAULT '[]',
      reason TEXT,
      confidence_score REAL NOT NULL DEFAULT 0.7,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memory_relationships_current
      ON memory_relationships(org_id, source_entity_id, relation_type, valid_until);
    CREATE INDEX IF NOT EXISTS idx_memory_relationships_target
      ON memory_relationships(org_id, target_entity_id, relation_type, valid_from DESC);

    CREATE TABLE IF NOT EXISTS skill_catalog_sources (
      source_id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
      display_name TEXT NOT NULL,
      api_base_url TEXT NOT NULL,
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      default_ref TEXT NOT NULL,
      layout_rules_json TEXT NOT NULL,
      exclude_globs_json TEXT,
      credential_alias TEXT NOT NULL,
      webhook_secret_alias TEXT,
      webhook_secret_hash TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      sync_status TEXT NOT NULL DEFAULT 'pending',
      last_synced_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_catalog_source_repo
      ON skill_catalog_sources(org_id, api_base_url, owner, repo);
    CREATE INDEX IF NOT EXISTS idx_skill_catalog_sources_org
      ON skill_catalog_sources(org_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS skill_catalog_blobs (
      org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
      source_id TEXT NOT NULL REFERENCES skill_catalog_sources(source_id) ON DELETE CASCADE,
      blob_sha TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      description TEXT,
      content_hash TEXT NOT NULL,
      redacted_text TEXT,
      embedding_json TEXT,
      embedding_status TEXT NOT NULL DEFAULT 'pending',
      embedding_attempts INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT,
      matcher_version TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (source_id, blob_sha)
    );

    CREATE INDEX IF NOT EXISTS idx_skill_catalog_blobs_org_source
      ON skill_catalog_blobs(org_id, source_id);
    CREATE INDEX IF NOT EXISTS idx_skill_catalog_blobs_content
      ON skill_catalog_blobs(source_id, content_hash);

    CREATE TABLE IF NOT EXISTS skill_catalog_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
      source_id TEXT NOT NULL REFERENCES skill_catalog_sources(source_id) ON DELETE CASCADE,
      commit_sha TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('building','entries_ready','search_ready','failed')),
      is_default_ref INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE (source_id, commit_sha)
    );

    CREATE INDEX IF NOT EXISTS idx_skill_catalog_snapshots_ready
      ON skill_catalog_snapshots(source_id, state, created_at DESC);

    CREATE TABLE IF NOT EXISTS skill_catalog_entries (
      snapshot_id TEXT NOT NULL REFERENCES skill_catalog_snapshots(snapshot_id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      blob_sha TEXT NOT NULL,
      namespace TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, path)
    );

    CREATE INDEX IF NOT EXISTS idx_skill_entries_ns
      ON skill_catalog_entries(snapshot_id, namespace);
    CREATE INDEX IF NOT EXISTS idx_skill_entries_blob
      ON skill_catalog_entries(snapshot_id, blob_sha);
  `);

  // Migration guards for existing databases
  try { db.exec("ALTER TABLE skill_catalog_sources ADD COLUMN webhook_secret_alias TEXT"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE skill_catalog_snapshots ADD COLUMN is_default_ref INTEGER NOT NULL DEFAULT 0"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE skill_catalog_blobs ADD COLUMN embedding_attempts INTEGER NOT NULL DEFAULT 0"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE skill_catalog_blobs ADD COLUMN next_retry_at TEXT"); } catch { /* already exists */ }
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_skill_catalog_blobs_embedding_retry ON skill_catalog_blobs(embedding_status, next_retry_at, embedding_attempts)"); } catch { /* already exists */ }
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_skill_catalog_snapshots_default_ready ON skill_catalog_snapshots(source_id, is_default_ref DESC, state, created_at DESC)"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE users ADD COLUMN is_service INTEGER NOT NULL DEFAULT 0"); } catch { /* already exists */ }
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS service_principals (
        service_principal_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(user_id),
        org_id TEXT NOT NULL REFERENCES orgs(org_id),
        name TEXT NOT NULL,
        created_by_user_id TEXT NOT NULL REFERENCES users(user_id),
        created_at TEXT NOT NULL,
        disabled_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_service_principals_org ON service_principals(org_id);
      CREATE INDEX IF NOT EXISTS idx_service_principals_user ON service_principals(user_id);
      CREATE TABLE IF NOT EXISTS service_tokens (
        token_id TEXT PRIMARY KEY,
        service_principal_id TEXT NOT NULL REFERENCES service_principals(service_principal_id),
        token_prefix TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        project_id TEXT,
        pod_id TEXT,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        last_used_at TEXT,
        created_at TEXT NOT NULL,
        created_by_user_id TEXT NOT NULL REFERENCES users(user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_service_tokens_principal ON service_tokens(service_principal_id);
      CREATE INDEX IF NOT EXISTS idx_service_tokens_project ON service_tokens(project_id) WHERE project_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_service_tokens_pod ON service_tokens(pod_id) WHERE pod_id IS NOT NULL;
    `);
  } catch { /* already exists */ }
  try { db.exec("ALTER TABLE living_docs ADD COLUMN last_regenerated_at TEXT"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE living_docs ADD COLUMN regen_count INTEGER NOT NULL DEFAULT 0"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE context_updates ADD COLUMN quality_score REAL NOT NULL DEFAULT 0.0"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE context_updates ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE context_updates ADD COLUMN commit_sha TEXT"); } catch { /* already exists */ }
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_context_updates_commit_sha ON context_updates(commit_sha) WHERE commit_sha IS NOT NULL"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE context_updates ADD COLUMN quality_rationale TEXT"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE context_updates ADD COLUMN retracted_at TEXT"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE context_updates ADD COLUMN retrieval_text TEXT"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE context_updates ADD COLUMN entity_refs_json TEXT NOT NULL DEFAULT '[]'"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE project_context_updates ADD COLUMN retracted_at TEXT"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE project_context_updates ADD COLUMN retrieval_text TEXT"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE project_context_updates ADD COLUMN entity_refs_json TEXT NOT NULL DEFAULT '[]'"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE knowledge_nodes ADD COLUMN retrieval_text TEXT"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE knowledge_nodes ADD COLUMN entity_refs_json TEXT NOT NULL DEFAULT '[]'"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE knowledge_nodes ADD COLUMN retention_score REAL NOT NULL DEFAULT 0.5"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE knowledge_nodes ADD COLUMN retrieval_tier TEXT NOT NULL DEFAULT 'hot'"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE knowledge_nodes ADD COLUMN retrieval_count INTEGER NOT NULL DEFAULT 0"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE knowledge_nodes ADD COLUMN last_retrieved_at TEXT"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE agent_sessions ADD COLUMN last_compacted_event_rowid INTEGER NOT NULL DEFAULT 0"); } catch { /* already exists */ }

  // Safe project-evidence ingestion provenance. These ALTERs are required for
  // deployed databases because CREATE TABLE IF NOT EXISTS does not add columns.
  try { db.exec("ALTER TABLE project_evidence_items ADD COLUMN source_instance TEXT NOT NULL DEFAULT 'legacy'"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE project_evidence_items ADD COLUMN native_id TEXT"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE project_evidence_items ADD COLUMN source_version TEXT"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE project_evidence_items ADD COLUMN visibility TEXT NOT NULL DEFAULT 'unknown'"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE project_evidence_items ADD COLUMN visibility_version TEXT NOT NULL DEFAULT '1'"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE project_evidence_items ADD COLUMN redaction_version TEXT NOT NULL DEFAULT 'legacy'"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE project_evidence_items ADD COLUMN normalized_content_hash TEXT"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE project_evidence_items ADD COLUMN source_updated_at TEXT"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE project_search_documents ADD COLUMN source_instance TEXT NOT NULL DEFAULT 'legacy'"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE project_search_documents ADD COLUMN native_id TEXT"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE project_search_documents ADD COLUMN source_version TEXT"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE project_search_documents ADD COLUMN visibility TEXT NOT NULL DEFAULT 'unknown'"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE project_search_documents ADD COLUMN visibility_version TEXT NOT NULL DEFAULT '1'"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE project_search_documents ADD COLUMN redaction_version TEXT NOT NULL DEFAULT 'legacy'"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE project_search_documents ADD COLUMN normalized_content_hash TEXT"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE project_search_documents ADD COLUMN source_updated_at TEXT"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE project_search_documents ADD COLUMN graph_enabled INTEGER NOT NULL DEFAULT 1"); } catch { /* already exists */ }
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_project_evidence_source_identity ON project_evidence_items(org_id, project_id, source, source_instance, native_id)"); } catch { /* table repaired below */ }
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_project_search_docs_source_identity ON project_search_documents(org_id, project_id, source, source_instance, native_id)"); } catch { /* already exists */ }

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_source_sync_state (
        org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        source_instance TEXT NOT NULL,
        last_attempt_at TEXT,
        last_success_at TEXT,
        last_reconciliation_at TEXT,
        lag_seconds INTEGER,
        indexed_count INTEGER NOT NULL DEFAULT 0,
        retry_count INTEGER NOT NULL DEFAULT 0,
        last_error_code TEXT,
        last_error_message TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (org_id, project_id, source, source_instance)
      );
      CREATE TABLE IF NOT EXISTS project_source_quarantine (
        org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        source_instance TEXT NOT NULL,
        native_id TEXT NOT NULL,
        source_version TEXT,
        error_code TEXT NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        first_seen_at TEXT NOT NULL,
        last_attempt_at TEXT NOT NULL,
        PRIMARY KEY (org_id, project_id, source, source_instance, native_id)
      );
    `);
  } catch { /* already exists */ }

  // FTS5 lexical index for project search chunks. Guarded: if the SQLite build
  // lacks FTS5, the index service falls back to keyword scoring (isProjectSearchFtsAvailable()).
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS project_search_fts USING fts5(
        chunk_id UNINDEXED,
        document_id UNINDEXED,
        org_id UNINDEXED,
        project_id UNINDEXED,
        title,
        body,
        tokenize = 'porter unicode61'
      );
    `);
  } catch (err) {
    console.warn("[schema] FTS5 unavailable; project search will use keyword fallback:", (err as Error).message);
  }

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_sessions (
        session_id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
        project_id TEXT REFERENCES projects(project_id),
        pod_id TEXT REFERENCES pods(pod_id),
        scope TEXT,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','ended')),
        goal TEXT,
        current_task TEXT,
        working_state_json TEXT NOT NULL DEFAULT '{}',
        compacted_summary TEXT,
        last_compacted_event_rowid INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ended_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_agent_sessions_org_pod
        ON agent_sessions(org_id, pod_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_sessions_org_project
        ON agent_sessions(org_id, project_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_sessions_agent
        ON agent_sessions(org_id, agent_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS agent_runs (
        run_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
        org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
        project_id TEXT REFERENCES projects(project_id),
        pod_id TEXT REFERENCES pods(pod_id),
        scope TEXT,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed','cancelled')),
        input_prompt TEXT,
        model TEXT,
        provider TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        token_input_count INTEGER NOT NULL DEFAULT 0,
        token_output_count INTEGER NOT NULL DEFAULT 0,
        total_cost_usd REAL NOT NULL DEFAULT 0.0,
        error_message TEXT,
        final_output TEXT,
        context_update_id TEXT,
        compacted_summary TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_agent_runs_session_time
        ON agent_runs(session_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_runs_org_status
        ON agent_runs(org_id, status, started_at DESC);

      CREATE TABLE IF NOT EXISTS agent_run_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES agent_runs(run_id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
        org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        summary TEXT,
        artifact_refs_json TEXT NOT NULL DEFAULT '[]',
        token_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        UNIQUE (run_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_run_events_run_seq
        ON agent_run_events(run_id, seq);
      CREATE INDEX IF NOT EXISTS idx_agent_run_events_session_time
        ON agent_run_events(session_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS agent_checkpoints (
        checkpoint_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
        run_id TEXT REFERENCES agent_runs(run_id) ON DELETE CASCADE,
        org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL DEFAULT '{}',
        summary TEXT,
        artifact_refs_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_checkpoints_session_seq
        ON agent_checkpoints(session_id, seq DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_checkpoints_run_seq
        ON agent_checkpoints(run_id, seq DESC);

      CREATE TABLE IF NOT EXISTS memory_candidates (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
        project_id TEXT REFERENCES projects(project_id),
        pod_id TEXT REFERENCES pods(pod_id),
        session_id TEXT REFERENCES agent_sessions(session_id) ON DELETE SET NULL,
        run_id TEXT REFERENCES agent_runs(run_id) ON DELETE SET NULL,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        type TEXT NOT NULL,
        summary TEXT NOT NULL,
        details TEXT NOT NULL,
        retrieval_text TEXT,
        entity_refs_json TEXT NOT NULL DEFAULT '[]',
        domains_json TEXT NOT NULL DEFAULT '[]',
        confidence_score REAL NOT NULL DEFAULT 0.0,
        evidence_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','promoted','rejected','auto_promoted')),
        promoted_node_id TEXT,
        created_at TEXT NOT NULL,
        reviewed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_memory_candidates_org_status
        ON memory_candidates(org_id, status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_candidates_session
        ON memory_candidates(session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_candidates_project
        ON memory_candidates(org_id, project_id, status, created_at DESC);

      CREATE TABLE IF NOT EXISTS memory_entities (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
        entity_type TEXT NOT NULL,
        entity_key TEXT NOT NULL,
        label TEXT NOT NULL,
        aliases_json TEXT NOT NULL DEFAULT '[]',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (org_id, entity_type, entity_key)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_entities_org_type
        ON memory_entities(org_id, entity_type, label);

      CREATE TABLE IF NOT EXISTS memory_relationships (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
        source_entity_id TEXT NOT NULL,
        target_entity_id TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        valid_from TEXT NOT NULL,
        valid_until TEXT,
        committed_at TEXT NOT NULL,
        source_update_refs_json TEXT NOT NULL DEFAULT '[]',
        artifact_refs_json TEXT NOT NULL DEFAULT '[]',
        reason TEXT,
        confidence_score REAL NOT NULL DEFAULT 0.7,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_relationships_current
        ON memory_relationships(org_id, source_entity_id, relation_type, valid_until);
      CREATE INDEX IF NOT EXISTS idx_memory_relationships_target
        ON memory_relationships(org_id, target_entity_id, relation_type, valid_from DESC);
    `);
	  } catch { /* already exists */ }

  try {
    db.exec(`
      DELETE FROM memory_candidates
      WHERE id IN (
        SELECT id
        FROM (
          SELECT
            id,
            ROW_NUMBER() OVER (
              PARTITION BY org_id, source_type, source_id
              ORDER BY
                CASE status
                  WHEN 'promoted' THEN 0
                  WHEN 'auto_promoted' THEN 0
                  WHEN 'pending' THEN 1
                  ELSE 2
                END,
                created_at DESC,
                id ASC
            ) AS duplicate_rank
          FROM memory_candidates
        )
        WHERE duplicate_rank > 1
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_candidates_source_unique
        ON memory_candidates(org_id, source_type, source_id);
    `);
  } catch { /* already exists */ }

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_evidence_items (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_url TEXT,
        source_title TEXT NOT NULL,
        summary TEXT NOT NULL,
        body TEXT NOT NULL,
        author TEXT,
        occurred_at TEXT NOT NULL,
        ingested_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        confidence_score REAL NOT NULL DEFAULT 0.0,
        promotable INTEGER NOT NULL DEFAULT 0,
        promoted_node_id TEXT,
        source_instance TEXT NOT NULL DEFAULT 'legacy',
        native_id TEXT,
        source_version TEXT,
        visibility TEXT NOT NULL DEFAULT 'unknown',
        visibility_version TEXT NOT NULL DEFAULT '1',
        redaction_version TEXT NOT NULL DEFAULT 'legacy',
        normalized_content_hash TEXT,
        source_updated_at TEXT,
        UNIQUE (org_id, project_id, source, source_id)
      );
      CREATE INDEX IF NOT EXISTS idx_project_evidence_project_time
        ON project_evidence_items(org_id, project_id, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS idx_project_evidence_source_identity
        ON project_evidence_items(org_id, project_id, source, source_instance, native_id);
      CREATE TABLE IF NOT EXISTS project_memory_candidates (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
        evidence_item_id TEXT NOT NULL REFERENCES project_evidence_items(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        summary TEXT NOT NULL,
        details TEXT NOT NULL,
        domains_json TEXT NOT NULL DEFAULT '[]',
        confidence_score REAL NOT NULL DEFAULT 0.0,
        source TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','promoted','rejected')),
        created_at TEXT NOT NULL,
        reviewed_at TEXT,
        promoted_node_id TEXT,
        UNIQUE (org_id, project_id, evidence_item_id, summary)
      );
      CREATE INDEX IF NOT EXISTS idx_project_memory_candidates_project_status
        ON project_memory_candidates(org_id, project_id, status, created_at DESC);
      CREATE TABLE IF NOT EXISTS project_ingestion_cursors (
        org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        cursor_key TEXT NOT NULL,
        cursor_value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (org_id, project_id, source, cursor_key)
      );
    `);
  } catch { /* already exists */ }

  // Projects + pod membership (existing DBs) — projects table must exist before ALTER pods
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        project_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        created_at TEXT NOT NULL
      )
    `);
  } catch { /* already exists */ }
  try { db.exec("ALTER TABLE pods ADD COLUMN project_id TEXT REFERENCES projects(project_id)"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE projects ADD COLUMN resources_json TEXT"); } catch { /* already exists */ }
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS identity_cache (
        kind TEXT NOT NULL,
        value TEXT NOT NULL,
        email TEXT,
        slack_user_id TEXT,
        github_login TEXT,
        display_name TEXT,
        resolved_at TEXT NOT NULL,
        PRIMARY KEY (kind, value)
      )
    `);
  } catch { /* already exists */ }
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_context_updates (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(project_id),
        type TEXT NOT NULL,
        scope TEXT NOT NULL,
        summary TEXT NOT NULL,
        details TEXT NOT NULL,
        artifacts_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL,
        quality_score REAL NOT NULL DEFAULT 0.0,
        blocks_json TEXT NOT NULL DEFAULT '[]',
        blocked_by_json TEXT NOT NULL DEFAULT '[]',
        needs_input_from_json TEXT NOT NULL DEFAULT '[]',
        source TEXT NOT NULL DEFAULT 'manual',
        commit_sha TEXT
      )
    `);
  } catch { /* already exists */ }
  try {
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_project_context_updates_project_time ON project_context_updates(project_id, timestamp DESC)",
    );
  } catch { /* already exists */ }

  try {
    db.exec("ALTER TABLE projects ADD COLUMN anatomy_json TEXT");
  } catch { /* already exists */ }

  // Multi-tenant org FKs (nullable in Phase 1; seed backfills; Phase 2 enforces).
  try { db.exec("ALTER TABLE projects ADD COLUMN org_id TEXT REFERENCES orgs(org_id)"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE projects ADD COLUMN created_by_user_id TEXT REFERENCES users(user_id)"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE pods ADD COLUMN org_id TEXT REFERENCES orgs(org_id)"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE pods ADD COLUMN created_by_user_id TEXT REFERENCES users(user_id)"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE context_updates ADD COLUMN org_id TEXT REFERENCES orgs(org_id)"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE project_context_updates ADD COLUMN org_id TEXT REFERENCES orgs(org_id)"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE conflicts ADD COLUMN org_id TEXT REFERENCES orgs(org_id)"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE tunnels ADD COLUMN org_id TEXT REFERENCES orgs(org_id)"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE living_docs ADD COLUMN org_id TEXT REFERENCES orgs(org_id)"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE knowledge_nodes ADD COLUMN org_id TEXT REFERENCES orgs(org_id)"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE archived_pods ADD COLUMN org_id TEXT REFERENCES orgs(org_id)"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE archived_pods ADD COLUMN extraction_completed INTEGER NOT NULL DEFAULT 1"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE archived_projects ADD COLUMN org_id TEXT REFERENCES orgs(org_id)"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE org_pod_summaries ADD COLUMN org_id TEXT REFERENCES orgs(org_id)"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE cross_pod_overlaps ADD COLUMN org_id TEXT REFERENCES orgs(org_id)"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE lint_findings ADD COLUMN org_id TEXT REFERENCES orgs(org_id)"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE pending_work ADD COLUMN org_id TEXT REFERENCES orgs(org_id)"); } catch { /* already exists */ }

  // Slack thread continuity — store the ts of the initial conflict message so
  // escalations/resolutions reply in-thread instead of posting new top-level messages.
  try { db.exec("ALTER TABLE conflicts ADD COLUMN slack_message_ts TEXT"); } catch { /* already exists */ }

  // Tunnel share token — possession of the full URL (containing the token) grants
  // proxy access; lets external collaborators reach the preview without IMS auth.
  try { db.exec("ALTER TABLE tunnels ADD COLUMN share_token TEXT"); } catch { /* already exists */ }
  try {
    // Backfill tokens for any pre-existing tunnel rows so older clients don't 401.
    const rows = db.prepare("SELECT tunnel_id FROM tunnels WHERE share_token IS NULL").all() as { tunnel_id: string }[];
    if (rows.length > 0) {
      const update = db.prepare("UPDATE tunnels SET share_token = ? WHERE tunnel_id = ?");
      for (const row of rows) {
        update.run(randomUUID(), row.tunnel_id);
      }
    }
  } catch { /* tunnels table may not exist yet on brand-new DBs */ }

  try { db.exec("CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(org_id)"); } catch { /* already exists */ }
  try {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_project_org
        ON projects(project_id, org_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_catalog_sources_org_source
        ON skill_catalog_sources(org_id, source_id);

      CREATE TABLE IF NOT EXISTS skill_catalog_org_defaults (
        org_id TEXT PRIMARY KEY REFERENCES orgs(org_id) ON DELETE CASCADE,
        source_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (org_id, source_id)
          REFERENCES skill_catalog_sources(org_id, source_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS skill_catalog_project_overrides (
        project_id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id, org_id)
          REFERENCES projects(project_id, org_id) ON DELETE CASCADE,
        FOREIGN KEY (org_id, source_id)
          REFERENCES skill_catalog_sources(org_id, source_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_skill_catalog_project_overrides_org
        ON skill_catalog_project_overrides(org_id, project_id);
    `);
  } catch { /* already exists or legacy schema is still being migrated */ }
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_pods_org ON pods(org_id)"); } catch { /* already exists */ }
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_context_updates_org_time ON context_updates(org_id, timestamp DESC)"); } catch { /* already exists */ }
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_conflicts_org ON conflicts(org_id)"); } catch { /* already exists */ }
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_org ON knowledge_nodes(org_id)"); } catch { /* already exists */ }

  // Per-org settings: add org_id column; existing single-row entries get backfilled by seed.
  try { db.exec("ALTER TABLE org_settings ADD COLUMN org_id TEXT REFERENCES orgs(org_id)"); } catch { /* already exists */ }

  // Fix PRIMARY KEY: original schema had `key TEXT PRIMARY KEY` (single-column), which
  // causes UNIQUE conflicts when multiple orgs share the same key name. Recreate with
  // composite PK (org_id, key). SQLite can't ALTER a PK so we do the rename dance.
  try {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='org_settings'").get() as { sql: string } | undefined;
    if (row?.sql && /key\s+TEXT\s+PRIMARY\s+KEY/i.test(row.sql)) {
      db.exec(`
        CREATE TABLE org_settings_new (
          org_id TEXT NOT NULL REFERENCES orgs(org_id),
          key    TEXT NOT NULL,
          value_json TEXT NOT NULL,
          PRIMARY KEY (org_id, key)
        );
        INSERT INTO org_settings_new (org_id, key, value_json)
          SELECT org_id, key, value_json FROM org_settings WHERE org_id IS NOT NULL;
        DROP TABLE org_settings;
        ALTER TABLE org_settings_new RENAME TO org_settings;
      `);
    }
  } catch { /* already migrated */ }

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS archived_projects (
        project_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        created_at TEXT NOT NULL,
        anatomy_json TEXT NOT NULL,
        archived_date TEXT NOT NULL
      )
    `);
  } catch { /* already exists */ }

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ingestion_queue (
        id TEXT PRIMARY KEY,
        pod_id TEXT NOT NULL,
        org_id TEXT,
        payload_json TEXT NOT NULL,
        queued_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
      )
    `);
  } catch { /* already exists */ }
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_ingestion_queue_pod_status ON ingestion_queue(pod_id, status)");
  } catch { /* already exists */ }

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS org_tuning_history (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        org_id      TEXT NOT NULL REFERENCES orgs(org_id),
        adjusted_at TEXT NOT NULL,
        signal_name TEXT NOT NULL,
        signal_value REAL NOT NULL,
        parameter   TEXT NOT NULL,
        old_value   REAL NOT NULL,
        new_value   REAL NOT NULL,
        pods_analyzed INTEGER NOT NULL
      )
    `);
  } catch { /* already exists */ }
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_org_tuning_history_org ON org_tuning_history(org_id, adjusted_at DESC)");
  } catch { /* already exists */ }
}
