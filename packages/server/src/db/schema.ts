import db from "./connection.js";

export const ORG_CONFIG_ROW_KEY = "org_config";

export function createTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      ims_user_id TEXT UNIQUE,
      email TEXT NOT NULL,
      display_name TEXT,
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
      artifacts_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL,
      quality_score REAL NOT NULL DEFAULT 0.0,
      quality_rationale TEXT,
      blocks_json TEXT NOT NULL DEFAULT '[]',
      blocked_by_json TEXT NOT NULL DEFAULT '[]',
      needs_input_from_json TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT 'manual',
      commit_sha TEXT
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
      final_pressure REAL NOT NULL
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
      community_id TEXT
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
  `);

  // Migration guards for existing databases
  try { db.exec("ALTER TABLE living_docs ADD COLUMN last_regenerated_at TEXT"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE living_docs ADD COLUMN regen_count INTEGER NOT NULL DEFAULT 0"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE context_updates ADD COLUMN quality_score REAL NOT NULL DEFAULT 0.0"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE context_updates ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE context_updates ADD COLUMN commit_sha TEXT"); } catch { /* already exists */ }
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_context_updates_commit_sha ON context_updates(commit_sha) WHERE commit_sha IS NOT NULL"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE context_updates ADD COLUMN quality_rationale TEXT"); } catch { /* already exists */ }

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
  try { db.exec("ALTER TABLE archived_projects ADD COLUMN org_id TEXT REFERENCES orgs(org_id)"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE org_pod_summaries ADD COLUMN org_id TEXT REFERENCES orgs(org_id)"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE cross_pod_overlaps ADD COLUMN org_id TEXT REFERENCES orgs(org_id)"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE lint_findings ADD COLUMN org_id TEXT REFERENCES orgs(org_id)"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE pending_work ADD COLUMN org_id TEXT REFERENCES orgs(org_id)"); } catch { /* already exists */ }

  try { db.exec("CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(org_id)"); } catch { /* already exists */ }
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

  // Org settings now keyed on (org_id, key); seed.ts installs the default row per org.
}
