import db from "./connection.js";

export function createTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pods (
      pod_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sprint_start TEXT NOT NULL,
      sprint_end TEXT NOT NULL,
      day_number INTEGER NOT NULL,
      total_days INTEGER NOT NULL,
      conflict_pressure REAL NOT NULL DEFAULT 0.0,
      milestone_json TEXT NOT NULL
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
      blocks_json TEXT NOT NULL DEFAULT '[]',
      blocked_by_json TEXT NOT NULL DEFAULT '[]',
      needs_input_from_json TEXT NOT NULL DEFAULT '[]'
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
      markdown TEXT NOT NULL
    );
  `);
}
