/**
 * Destructive one-time project-search corpus scrub.
 *
 * Rewrites eligible evidence through the canonical redactor, removes rows that
 * cannot be normalized or admitted, discards derived candidates/index data,
 * rebuilds from sanitized sources, clears the live-search disk cache, and
 * compacts SQLite/WAL. External snapshots/backups are deliberately outside the
 * process boundary and must be rotated separately (see the runbook).
 */
import fs from "node:fs";
import path from "node:path";
import db, { withImmediateTransaction } from "../db/connection.js";
import { createTables } from "../db/schema.js";
import {
  normalizeProjectEvidence,
  ProjectEvidenceNormalizationError,
} from "../services/project-evidence-normalization.js";
import { reindexProjectSearch } from "../services/project-search-index.js";
import { retractProjectEvidenceKnowledgeNodes } from "../services/knowledge-graph.js";
import { purgeLocalGraphHistory } from "../services/graph-storage.js";

interface EvidenceRow {
  id: string;
  org_id: string;
  project_id: string;
  source: string;
  source_type: string;
  source_id: string;
  source_url: string | null;
  source_title: string;
  summary: string;
  body: string;
  author: string | null;
  metadata_json: string;
  source_instance: string;
  native_id: string | null;
  source_version: string | null;
  visibility: "project_visible" | "restricted" | "unknown" | null;
  visibility_version: string | null;
  source_updated_at: string | null;
  promoted_node_id: string | null;
}

function parseMetadata(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ProjectEvidenceNormalizationError("metadata_shape", "Evidence metadata must be an object");
  }
  return parsed as Record<string, unknown>;
}

function quarantineIdentifier(row: EvidenceRow, errorCode: string, now: string): void {
  // Normalize identifiers independently from the failed content/metadata. This
  // object is deliberately empty so no source payload enters quarantine.
  const identity = normalizeProjectEvidence({
    source: row.source,
    source_type: "scrub_identity",
    source_id: row.source_id,
    source_instance: row.source_instance,
    native_id: row.native_id ?? row.source_id,
    source_version: row.source_version ?? undefined,
    source_title: "",
    summary: "",
    body: "",
    metadata: {},
    visibility: "project_visible",
  });
  db.prepare(
    `INSERT INTO project_source_quarantine
       (org_id, project_id, source, source_instance, native_id, source_version, error_code,
        retry_count, first_seen_at, last_attempt_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(org_id, project_id, source, source_instance, native_id) DO UPDATE SET
       source_version = excluded.source_version,
       error_code = excluded.error_code,
       retry_count = project_source_quarantine.retry_count + 1,
       last_attempt_at = excluded.last_attempt_at`,
  ).run(
    row.org_id,
    row.project_id,
    row.source,
    identity.source_instance,
    identity.native_id,
    identity.source_version ?? null,
    errorCode.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80),
    now,
    now,
  );
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 24) throw new Error(`Node 24+ is required; current runtime is ${process.version}`);
  if (!process.argv.includes("--yes")) {
    throw new Error("Refusing destructive scrub without --yes. Read docs/PROJECT_SEARCH_SCRUB_RUNBOOK.md first.");
  }
  const projectFilter = argValue("--project");
  const admitLegacy = process.argv.includes("--admit-legacy-project-visible");
  createTables();
  db.exec("PRAGMA secure_delete = ON");

  const rows = db.prepare(
    `SELECT id, org_id, project_id, source, source_type, source_id, source_url, source_title, summary, body,
            author, metadata_json, source_instance, native_id, source_version, visibility, visibility_version,
            source_updated_at, promoted_node_id
     FROM project_evidence_items
     ${projectFilter ? "WHERE project_id = ?" : ""}
     ORDER BY org_id, project_id, id`,
  ).all(...(projectFilter ? [projectFilter] : [])) as unknown as EvidenceRow[];
  const projectRows = db.prepare(
    `SELECT org_id, project_id FROM projects
     WHERE org_id IS NOT NULL ${projectFilter ? "AND project_id = ?" : ""}`,
  ).all(...(projectFilter ? [projectFilter] : [])) as Array<{ org_id: string; project_id: string }>;
  const projects = new Map(
    projectRows.map((project) => [`${project.org_id}\0${project.project_id}`, project] as const),
  );
  let rewritten = 0;
  let quarantined = 0;
  let ineligible = 0;
  let kgNodesRetracted = 0;
  let graphSnapshotsRemoved = 0;
  const promotedByProject = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.promoted_node_id) continue;
    const key = `${row.org_id}\0${row.project_id}`;
    const values = promotedByProject.get(key) ?? new Set<string>();
    values.add(row.promoted_node_id);
    promotedByProject.set(key, values);
  }

  withImmediateTransaction(() => {
    const update = db.prepare(
      `UPDATE project_evidence_items SET
         source_type = ?, source_id = ?, source_url = ?, source_title = ?, summary = ?, body = ?, author = ?,
         metadata_json = ?, source_instance = ?, native_id = ?, source_version = ?, visibility = ?,
         visibility_version = ?, redaction_version = ?, normalized_content_hash = ?, source_updated_at = ?
       WHERE id = ? AND org_id = ? AND project_id = ?`,
    );
    const deleteEvidence = db.prepare(
      "DELETE FROM project_evidence_items WHERE id = ? AND org_id = ? AND project_id = ?",
    );
    const deleteCandidate = db.prepare("DELETE FROM project_memory_candidates WHERE evidence_item_id = ?");

    for (const row of rows) {
      projects.set(`${row.org_id}\0${row.project_id}`, { org_id: row.org_id, project_id: row.project_id });
      const visibility = row.visibility === "project_visible"
        ? "project_visible"
        : admitLegacy && (row.visibility === "unknown" || !row.visibility)
          ? "project_visible"
          : row.visibility ?? "unknown";
      if (visibility !== "project_visible") {
        deleteCandidate.run(row.id);
        deleteEvidence.run(row.id, row.org_id, row.project_id);
        ineligible++;
        continue;
      }

      try {
        const normalized = normalizeProjectEvidence({
          source: row.source,
          source_type: row.source_type,
          source_id: row.source_id,
          source_instance: row.source_instance,
          native_id: row.native_id ?? row.source_id,
          source_version: row.source_version ?? undefined,
          source_url: row.source_url ?? undefined,
          source_title: row.source_title,
          summary: row.summary,
          body: row.body,
          author: row.author ?? undefined,
          metadata: parseMetadata(row.metadata_json),
          visibility,
          visibility_version: row.visibility_version ?? "1",
          source_updated_at: row.source_updated_at ?? undefined,
        });
        update.run(
          normalized.source_type,
          normalized.source_id,
          normalized.source_url ?? null,
          normalized.source_title,
          normalized.summary,
          normalized.body,
          normalized.author ?? null,
          JSON.stringify(normalized.metadata),
          normalized.source_instance,
          normalized.native_id,
          normalized.source_version ?? null,
          normalized.visibility,
          normalized.visibility_version,
          normalized.redaction_version,
          normalized.normalized_content_hash,
          normalized.source_updated_at ?? null,
          row.id,
          row.org_id,
          row.project_id,
        );
        // Candidate summaries/details were derived before the canonical boundary.
        deleteCandidate.run(row.id);
        rewritten++;
      } catch (error) {
        const code = error instanceof ProjectEvidenceNormalizationError ? error.code : "rewrite_failed";
        quarantineIdentifier(row, code, new Date().toISOString());
        deleteCandidate.run(row.id);
        deleteEvidence.run(row.id, row.org_id, row.project_id);
        quarantined++;
      }
    }
  });

  for (const { org_id, project_id } of projects.values()) {
    const promoted = promotedByProject.get(`${org_id}\0${project_id}`);
    if (promoted) {
      kgNodesRetracted += retractProjectEvidenceKnowledgeNodes(org_id, project_id, [...promoted]).length;
    }
    await reindexProjectSearch(org_id, project_id, { embed: false });
  }
  for (const orgId of new Set([...projects.values()].map((project) => project.org_id))) {
    graphSnapshotsRemoved += purgeLocalGraphHistory(orgId);
  }

  const cacheDir = path.resolve(process.cwd(), ".data", "context-search-cache");
  if (path.basename(cacheDir) !== "context-search-cache") throw new Error("Unexpected context-search cache path");
  if (fs.existsSync(cacheDir)) fs.rmSync(cacheDir, { recursive: true, force: true });

  // Flush old WAL pages, compact the main database with secure_delete enabled,
  // then truncate any WAL pages produced by VACUUM.
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.exec("VACUUM");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");

  console.log(JSON.stringify({
    rewritten,
    quarantined,
    ineligible,
    kg_nodes_retracted: kgNodesRetracted,
    graph_snapshots_removed: graphSnapshotsRemoved,
    projects_rebuilt: projects.size,
    cache_cleared: true,
  }));
  console.warn("External database backups, volume snapshots, and replicas were not modified; rotate them per the deployment retention policy.");
}

main().catch((error) => {
  console.error(`[scrub-project-search] ${error instanceof Error ? error.message : "failed"}`);
  process.exitCode = 1;
});
