import { DEFAULT_ORG_CONFIG } from "@pim/shared";
import db from "./connection.js";

export const ORG_CONFIG_ROW_KEY = "org_config";

export function createTables() {
  db.exec(`
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

  db.prepare("INSERT OR IGNORE INTO org_settings (key, value_json) VALUES (?, ?)").run(
    ORG_CONFIG_ROW_KEY,
    JSON.stringify(DEFAULT_ORG_CONFIG),
  );
}
