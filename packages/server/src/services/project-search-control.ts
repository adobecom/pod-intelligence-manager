import db from "../db/connection.js";

const CONTROL_SOURCE = "project_search";
const INDEXING_ENABLED_KEY = "indexing_enabled";

/**
 * Project-search indexing is opt-in per project. The environment override is
 * reserved for operators who deliberately want to start every configured
 * project at once.
 */
export function isProjectSearchIndexingEnabled(orgId: string, projectId: string): boolean {
  if (process.env.PROJECT_SEARCH_INDEXING_ENABLED === "1") return true;

  const row = db
    .prepare(
      `SELECT 1
       FROM project_ingestion_cursors
       WHERE org_id = ? AND project_id = ? AND source = ? AND cursor_key = ? AND cursor_value = '1'`,
    )
    .get(orgId, projectId, CONTROL_SOURCE, INDEXING_ENABLED_KEY);
  return Boolean(row);
}

/** Mark one project as started. Reindexing is the explicit start action. */
export function enableProjectSearchIndexing(orgId: string, projectId: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO project_ingestion_cursors
       (org_id, project_id, source, cursor_key, cursor_value, updated_at)
     VALUES (?, ?, ?, ?, '1', ?)
     ON CONFLICT(org_id, project_id, source, cursor_key) DO UPDATE SET
       cursor_value = '1',
       updated_at = excluded.updated_at`,
  ).run(orgId, projectId, CONTROL_SOURCE, INDEXING_ENABLED_KEY, now);
}
