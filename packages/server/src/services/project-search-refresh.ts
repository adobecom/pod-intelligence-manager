/**
 * project-search-refresh.ts
 *
 * Scheduled incremental refresh for the project search index.
 *
 * Mechanism:
 *   1. Enumerate every project with at least one configured connector. Newly
 *      configured projects must be eligible before they have any evidence.
 *   2. For each project, in order:
 *        a. pollProjectSources    — live API delta pull → project_evidence_items (cursor-based)
 *        b. backfillProjectSearch — fold DB rows → index (content-hash dedup, cheap for no-ops)
 *        c. indexProjectKgNodes   — persist project-relevant KG nodes as kg-typed docs (Phase C)
 *        d. embedProjectSearchChunks — embed new/changed chunks only
 *        e. annotateProjectGraph  — refresh hub/community metadata
 *        f. record last_refresh watermark in project_ingestion_cursors
 *   3. Projects are processed sequentially with per-project jitter so N projects
 *      spread across the 6 h window instead of firing in a burst.
 *
 * Single-process assumption: the deploy is single-EC2. If multiple processes ever
 * run this job, the cursor-based pull path makes a duplicate run wasteful (re-fetches
 * the same evidence) but not corrupting (indexProjectDocument is idempotent via
 * content-hash upsert).
 */

import db from "../db/connection.js";
import { pollProjectSources } from "./project-memory.js";
import {
  annotateProjectGraph,
  backfillProjectSearch,
  embedProjectSearchChunks,
  indexProjectKgNodes,
} from "./project-search-index.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ProjectRef {
  org_id: string;
  project_id: string;
}

export interface RefreshResult {
  org_id: string;
  project_id: string;
  ok: boolean;
  error?: string;
  /** ms elapsed */
  duration_ms: number;
  poll_ingested?: number;
  index_documents?: number;
  index_chunks?: number;
  chunks_embedded?: number;
  source_errors?: Array<{ source: string; error: string }>;
}

// ── Enumerator ───────────────────────────────────────────────────────────────

/**
 * Returns every project that has at least one concrete connector binding.
 * `windowDays` remains in the signature for API compatibility; freshness is a
 * connector concern, not an admission requirement for the scheduler.
 */
export function listActiveProjectsForRefresh(windowDays = 30): ProjectRef[] {
  void windowDays;
  const rows = db
    .prepare(
      `SELECT p.org_id, p.project_id, p.resources_json
       FROM projects p
       WHERE p.resources_json IS NOT NULL
         AND p.org_id IS NOT NULL`,
    )
    .all() as unknown as Array<ProjectRef & { resources_json: string }>;

  const configured = (raw: string): boolean => {
    try {
      const value = JSON.parse(raw) as Record<string, unknown>;
      for (const source of ["jira", "github", "slack", "confluence", "git"]) {
        const config = value[source];
        if (!config || typeof config !== "object") continue;
        for (const entry of Object.values(config as Record<string, unknown>)) {
          if (Array.isArray(entry) && entry.length > 0) return true;
          if (typeof entry === "string" && entry.trim()) return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  };

  return rows
    .filter((row) => configured(row.resources_json))
    .map(({ org_id, project_id }) => ({ org_id, project_id }));
}

// ── Watermark helpers ────────────────────────────────────────────────────────

const REFRESH_SOURCE = "project_search";
const REFRESH_CURSOR_KEY = "last_refresh";

/** Returns the ISO timestamp of the last successful refresh for a project, or null. */
export function getLastRefreshAt(orgId: string, projectId: string): string | null {
  const row = db
    .prepare(
      `SELECT cursor_value FROM project_ingestion_cursors
       WHERE org_id = ? AND project_id = ? AND source = ? AND cursor_key = ?`,
    )
    .get(orgId, projectId, REFRESH_SOURCE, REFRESH_CURSOR_KEY) as { cursor_value: string } | undefined;
  return row?.cursor_value ?? null;
}

/** Records the current time as the last successful refresh watermark. */
function setLastRefreshAt(orgId: string, projectId: string): void {
  db.prepare(
    `INSERT INTO project_ingestion_cursors (org_id, project_id, source, cursor_key, cursor_value, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(org_id, project_id, source, cursor_key) DO UPDATE SET
       cursor_value = excluded.cursor_value,
       updated_at = excluded.updated_at`,
  ).run(orgId, projectId, REFRESH_SOURCE, REFRESH_CURSOR_KEY, new Date().toISOString(), new Date().toISOString());
}

// ── Per-project orchestrator ─────────────────────────────────────────────────

/**
 * Runs one full incremental refresh cycle for a single project.
 *
 * Safe to call any time — all underlying operations are idempotent:
 *   - pollProjectSources advances only its per-source cursor (no duplicate ingestion)
 *   - backfillProjectSearch uses content-hash dedup (no-op for unchanged docs)
 *   - embedProjectSearchChunks skips already-embedded chunks
 *   - annotateProjectGraph is a full recompute (fast on small graphs)
 */
export async function refreshProjectSearch(orgId: string, projectId: string): Promise<RefreshResult> {
  const t0 = Date.now();
  try {
    // Step 1: live delta pull → project_evidence_items (cursor-incremental per source)
    const pollResult = await pollProjectSources(orgId, projectId);
    const pollIngested = pollResult?.results.reduce((s, r) => s + (r.ingested ?? 0), 0) ?? 0;
    const sourceErrors = (pollResult?.results ?? [])
      .filter((result) => !!result.missing)
      .map((result) => ({ source: result.source, error: "source_refresh_failed" }));

    // Step 2: fold DB rows → project search index (content-hash dedup)
    const backfillResult = backfillProjectSearch(orgId, projectId);

    // Step 3: index project-relevant KG nodes as kg-typed search documents
    // (pull model — reads whatever the KG's own synthesis cycle has produced)
    indexProjectKgNodes(orgId, projectId);

    // Step 4: embed new/changed chunks (skips already-embedded via hash gate)
    const chunksEmbedded = await embedProjectSearchChunks(orgId, projectId);

    // Step 5: refresh hub/community annotations + entity graph
    annotateProjectGraph(orgId, projectId);

    // Step 6: advance the aggregate watermark only when every configured
    // source succeeded. Source-specific attempts/successes are tracked by the
    // connector state and must not be hidden by a partial refresh.
    if (sourceErrors.length === 0) setLastRefreshAt(orgId, projectId);

    return {
      org_id: orgId,
      project_id: projectId,
      ok: sourceErrors.length === 0,
      ...(sourceErrors.length > 0
        ? { error: `Source refresh failed: ${sourceErrors.map((item) => item.source).join(", ")}`, source_errors: sourceErrors }
        : {}),
      duration_ms: Date.now() - t0,
      poll_ingested: pollIngested,
      index_documents: backfillResult.documents,
      index_chunks: backfillResult.chunks,
      chunks_embedded: chunksEmbedded,
    };
  } catch {
    return {
      org_id: orgId,
      project_id: projectId,
      ok: false,
      error: "project_refresh_failed",
      duration_ms: Date.now() - t0,
    };
  }
}

// Resource mutations can happen faster than a connector round-trip. Coalesce
// immediate refresh requests per project while preserving a retry after the
// current run settles.
interface ScheduledRefresh {
  rerunRequested: boolean;
}

const scheduledRefreshes = new Map<string, ScheduledRefresh>();

export function scheduleProjectSearchRefresh(orgId: string, projectId: string): void {
  const key = `${orgId}\0${projectId}`;
  const existing = scheduledRefreshes.get(key);
  if (existing) {
    // A resource mutation that lands during connector I/O must not be lost.
    // Coalesce any number of overlapping requests into one trailing refresh.
    existing.rerunRequested = true;
    return;
  }
  const scheduled: ScheduledRefresh = { rerunRequested: false };
  void Promise.resolve()
    .then(() => refreshProjectSearch(orgId, projectId))
      .catch(() => ({
        org_id: orgId,
        project_id: projectId,
        ok: false,
        error: "project_refresh_failed",
        duration_ms: 0,
      }))
      .finally(() => {
        scheduledRefreshes.delete(key);
        if (scheduled.rerunRequested) scheduleProjectSearchRefresh(orgId, projectId);
      });
  scheduledRefreshes.set(key, scheduled);
}

// ── Scheduler entry point ────────────────────────────────────────────────────

/**
 * Runs one scheduler tick: enumerate active projects and refresh each with jitter.
 *
 * Projects are processed sequentially; a per-project delay of
 * `intervalMs / count` (capped at 60 s) spreads the API load across the full
 * window so N projects don't all flush simultaneously.
 *
 * @param intervalMs  The full scheduler interval (used to compute jitter).
 * @param log         Logger with .info/.warn/.error matching the Fastify log interface.
 */
export async function runProjectSearchRefreshTick(
  intervalMs: number,
  log: { info: (obj: unknown, msg?: string) => void; warn: (obj: unknown, msg?: string) => void; error: (obj: unknown, msg?: string) => void },
  windowDays = 30,
): Promise<void> {
  const projects = listActiveProjectsForRefresh(windowDays);
  if (projects.length === 0) {
    log.info({ msg: "Project search refresh: no active configured projects, skipping" });
    return;
  }

  // Jitter: spread projects evenly across the interval, capped at 60 s per project.
  const jitterMs = Math.min(Math.floor(intervalMs / projects.length), 60_000);

  log.info({
    msg: "Project search refresh tick started",
    project_count: projects.length,
    jitter_ms: jitterMs,
  });

  for (const { org_id, project_id } of projects) {
    // Stagger before each project (not after) so the first project also waits a
    // small fraction of the window rather than firing at the exact tick boundary.
    if (jitterMs > 0) {
      await new Promise((r) => setTimeout(r, jitterMs));
    }

    const r = await refreshProjectSearch(org_id, project_id);

    if (r.ok) {
      log.info({
        msg: "Project search refreshed",
        org_id,
        project_id,
        duration_ms: r.duration_ms,
        poll_ingested: r.poll_ingested,
        index_documents: r.index_documents,
        chunks_embedded: r.chunks_embedded,
      });
    } else {
      log.warn({
        msg: "Project search refresh failed",
        org_id,
        project_id,
        error: r.error,
        duration_ms: r.duration_ms,
      });
    }
  }

  log.info({ msg: "Project search refresh tick completed", project_count: projects.length });
}
