import fs from "node:fs";
import db, { dbPath } from "../db/connection.js";
import {
  annotateProjectGraph,
  backfillProjectSearch,
  indexProjectKgNodes,
  purgeProjectSearch,
} from "./project-search-index.js";
import { isProjectSearchIndexingEnabled } from "./project-search-control.js";

interface RecoveryLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

interface ProjectRef {
  org_id: string;
  project_id: string;
}

export interface ProjectSearchRecoveryResult {
  requested: boolean;
  projects_total: number;
  projects_rebuilt: number;
  failed_projects: ProjectRef[];
  marker_removed: boolean;
}

export function projectSearchRebuildMarkerPath(databasePath = dbPath): string {
  return `${databasePath}.project-search-rebuild-required`;
}

/**
 * Reconstructs the derived project-search tables for projects whose indexing
 * has been explicitly started after a portable core restore.
 *
 * This deliberately performs no connector calls and creates no embeddings, so
 * disaster recovery is bounded by local SQLite/KG work and cannot burst GitHub,
 * Jira, or Bedrock. The normal refresh job incrementally adds embeddings after
 * startup. Lexical and graph search are available immediately after this pass.
 *
 * A failure in one project leaves the marker in place for the next process start
 * but does not make the rest of PIM unavailable; every successful project remains
 * searchable and the scheduled refresh can continue repairing configured ones.
 */
export async function rebuildProjectSearchAfterCoreRestore(
  log: RecoveryLogger,
  markerPath = projectSearchRebuildMarkerPath(),
): Promise<ProjectSearchRecoveryResult> {
  if (!fs.existsSync(markerPath)) {
    return {
      requested: false,
      projects_total: 0,
      projects_rebuilt: 0,
      failed_projects: [],
      marker_removed: false,
    };
  }

  const projects = db
    .prepare(
      `SELECT org_id, project_id
       FROM projects
       WHERE org_id IS NOT NULL
       ORDER BY org_id, project_id`,
    )
    .all() as unknown as ProjectRef[];
  const enabledProjects = projects.filter(({ org_id, project_id }) =>
    isProjectSearchIndexingEnabled(org_id, project_id));

  log.info(
    { msg: "Project search recovery started", project_count: enabledProjects.length },
    "Rebuilding derived project search after core restore",
  );

  let rebuilt = 0;
  const failedProjects: ProjectRef[] = [];
  for (const project of enabledProjects) {
    try {
      // A prior process may have stopped midway through recovery. Purging each
      // project first makes retries deterministic while leaving source evidence
      // and project/org knowledge-graph nodes untouched.
      purgeProjectSearch(project.org_id, project.project_id);
      const indexed = backfillProjectSearch(project.org_id, project.project_id);
      const kg = indexProjectKgNodes(project.org_id, project.project_id);
      const graph = annotateProjectGraph(project.org_id, project.project_id);
      if (!indexed.complete) {
        failedProjects.push(project);
        log.warn({
          msg: "Project search recovery partial; rebuild marker retained",
          ...project,
          documents: indexed.documents,
          chunks: indexed.chunks,
          failed_rows: indexed.failed_rows,
          failures: indexed.failures,
          kg_indexed: kg.indexed,
          graph_annotated: graph.annotated,
        });
        continue;
      }
      rebuilt++;
      log.info({
        msg: "Project search recovered",
        ...project,
        documents: indexed.documents,
        chunks: indexed.chunks,
        kg_indexed: kg.indexed,
        graph_annotated: graph.annotated,
      });
    } catch (error) {
      failedProjects.push(project);
      log.error(
        {
          msg: "Project search recovery failed",
          ...project,
          error: "project_recovery_stage_failed",
        },
        "Project search recovery failed; rebuild marker retained",
      );
    }
  }

  let markerRemoved = false;
  if (failedProjects.length === 0) {
    try {
      fs.unlinkSync(markerPath);
      markerRemoved = true;
      log.info({
        msg: "Project search recovery completed",
        project_count: enabledProjects.length,
      });
    } catch (error) {
      log.error(
        {
          msg: "Project search recovery marker removal failed",
          error: error instanceof Error ? error.message : "unknown",
        },
        "Derived search is rebuilt, but its recovery marker could not be removed",
      );
    }
  } else {
    log.warn({
      msg: "Project search recovery incomplete; marker retained",
      projects_rebuilt: rebuilt,
      projects_failed: failedProjects.length,
    });
  }

  return {
    requested: true,
    projects_total: enabledProjects.length,
    projects_rebuilt: rebuilt,
    failed_projects: failedProjects,
    marker_removed: markerRemoved,
  };
}
