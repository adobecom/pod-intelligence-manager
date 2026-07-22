import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import db, { withTransaction } from "../db/connection.js";
import type {
  ProjectEvidenceSource,
  ProjectSourceChange,
  ProjectSourceHealthSource,
  ProjectSourceSyncState,
} from "@pim/shared";
import { recordProjectEvidence } from "./project-memory.js";
import { isProjectSearchFtsAvailable } from "./project-search-index.js";
import {
  normalizeProjectEvidence,
  ProjectEvidenceNormalizationError,
  redactProjectUrl,
} from "./project-evidence-normalization.js";
import { redactSecrets } from "./secret-scan.js";
import { retractProjectEvidenceKnowledgeNodes } from "./knowledge-graph.js";

export type SourceChange = ProjectSourceChange;

export interface ApplySourceChangesResult {
  upserted: number;
  deleted: number;
  quarantined: number;
}

export interface ProjectEvidenceSourcePurgeResult {
  evidence_deleted: number;
  documents_deleted: number;
  cursors_deleted: number;
  sync_states_deleted: number;
  quarantine_deleted: number;
}

export interface ProjectSourceSyncSuccessInput {
  lag_seconds?: number;
  indexed_count?: number;
  attempted_at?: string;
  succeeded_at?: string;
}

function clearDerivedContextSearchCache(): void {
  try {
    const cacheDir = path.resolve(process.cwd(), ".data", "context-search-cache");
    if (path.basename(cacheDir) !== "context-search-cache") return;
    if (fs.existsSync(cacheDir)) fs.rmSync(cacheDir, { recursive: true, force: true });
  } catch {
    // Search cache is derived and best-effort. The database purge remains the
    // authoritative security boundary, while indexed project reads are uncached.
  }
}

function canonicalIdentity(change: Pick<SourceChange, "source" | "source_instance" | "native_id" | "source_version">): {
  sourceInstance: string;
  nativeId: string;
  sourceId: string;
  sourceVersion?: string;
} {
  const normalized = normalizeProjectEvidence({
    source: change.source,
    source_type: "source_change_identity",
    source_id: change.native_id,
    source_instance: change.source_instance,
    native_id: change.native_id,
    source_version: change.source_version,
    source_title: "",
    summary: "",
    body: "",
    metadata: {},
    visibility: "project_visible",
  });
  return {
    sourceInstance: normalized.source_instance,
    nativeId: normalized.native_id,
    sourceId: `${normalized.source_instance}::${normalized.native_id}`,
    ...(normalized.source_version ? { sourceVersion: normalized.source_version } : {}),
  };
}

/** Stable persisted identity used by connector-produced evidence. */
export function projectSourceId(
  source: ProjectEvidenceSource,
  sourceInstance: string,
  nativeId: string,
): string {
  return canonicalIdentity({ source, source_instance: sourceInstance, native_id: nativeId }).sourceId;
}

function indexSourceFor(source: ProjectEvidenceSource | ProjectSourceHealthSource): string {
  return source === "commit" ? "git" : source;
}

function evidenceSourcesFor(source: ProjectEvidenceSource | ProjectSourceHealthSource): string[] {
  return source === "git" ? ["commit"] : [source];
}

function deleteFtsDocument(documentId: string): void {
  if (isProjectSearchFtsAvailable()) {
    db.prepare("DELETE FROM project_search_fts WHERE document_id = ?").run(documentId);
  }
}

function deleteGraphForDocuments(documentIds: string[]): void {
  const deleteEdges = db.prepare("DELETE FROM project_search_edges WHERE evidence_document_id = ?");
  const deleteEntities = db.prepare("DELETE FROM project_search_entities WHERE source_document_id = ?");
  for (const documentId of documentIds) {
    deleteEdges.run(documentId);
    deleteEntities.run(documentId);
  }
  db.prepare(
    `DELETE FROM project_search_entities
     WHERE source_document_id IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM project_search_edges e
         WHERE e.source_entity_id = project_search_entities.id
            OR e.target_entity_id = project_search_entities.id
       )`,
  ).run();
}

function deleteEvidenceIdentity(change: SourceChange): number {
  const identity = canonicalIdentity(change);
  return withTransaction(() => {
    const promotedRows = db.prepare(
      `SELECT DISTINCT promoted_node_id FROM project_evidence_items
       WHERE org_id = ? AND project_id = ? AND source = ?
         AND (source_id = ? OR (source_instance = ? AND native_id = ?))
         AND promoted_node_id IS NOT NULL`,
    ).all(
      change.org_id,
      change.project_id,
      change.source,
      identity.sourceId,
      identity.sourceInstance,
      identity.nativeId,
    ) as Array<{ promoted_node_id: string }>;
    const retractedNodeIds = retractProjectEvidenceKnowledgeNodes(
      change.org_id,
      change.project_id,
      promotedRows.map((row) => row.promoted_node_id),
    );
    if (retractedNodeIds.length > 0) {
      const kgDocuments = db.prepare(
        `SELECT id FROM project_search_documents
         WHERE org_id = ? AND project_id = ? AND source = 'kg'
           AND source_id IN (${retractedNodeIds.map(() => "?").join(", ")})`,
      ).all(change.org_id, change.project_id, ...retractedNodeIds) as Array<{ id: string }>;
      for (const { id } of kgDocuments) deleteFtsDocument(id);
      deleteGraphForDocuments(kgDocuments.map((row) => row.id));
      db.prepare(
        `DELETE FROM project_search_documents
         WHERE org_id = ? AND project_id = ? AND source = 'kg'
           AND source_id IN (${retractedNodeIds.map(() => "?").join(", ")})`,
      ).run(change.org_id, change.project_id, ...retractedNodeIds);
    }
    const indexSource = indexSourceFor(change.source);
    const documents = db.prepare(
      `SELECT id FROM project_search_documents
       WHERE org_id = ? AND project_id = ? AND source = ?
         AND (source_id = ? OR (source_instance = ? AND native_id = ?))`,
    ).all(
      change.org_id,
      change.project_id,
      indexSource,
      identity.sourceId,
      identity.sourceInstance,
      identity.nativeId,
    ) as Array<{ id: string }>;
    for (const { id } of documents) deleteFtsDocument(id);
    deleteGraphForDocuments(documents.map((row) => row.id));
    db.prepare(
      `DELETE FROM project_search_documents
       WHERE org_id = ? AND project_id = ? AND source = ?
         AND (source_id = ? OR (source_instance = ? AND native_id = ?))`,
    ).run(
      change.org_id,
      change.project_id,
      indexSource,
      identity.sourceId,
      identity.sourceInstance,
      identity.nativeId,
    );
    const result = db.prepare(
      `DELETE FROM project_evidence_items
       WHERE org_id = ? AND project_id = ? AND source = ?
         AND (source_id = ? OR (source_instance = ? AND native_id = ?))`,
    ).run(
      change.org_id,
      change.project_id,
      change.source,
      identity.sourceId,
      identity.sourceInstance,
      identity.nativeId,
    );
    db.prepare(
      `DELETE FROM project_source_quarantine
       WHERE org_id = ? AND project_id = ? AND source = ? AND source_instance = ? AND native_id = ?`,
    ).run(change.org_id, change.project_id, change.source, identity.sourceInstance, identity.nativeId);
    return Number(result.changes);
  });
}

/** Targeted lifecycle deletion for a known native item, used when an internal
 * project update is retracted and by connector-specific recovery paths. */
export function purgeProjectEvidenceIdentity(
  orgId: string,
  projectId: string,
  source: ProjectEvidenceSource,
  sourceInstance: string,
  nativeId: string,
): number {
  return deleteEvidenceIdentity({
    kind: "delete",
    org_id: orgId,
    project_id: projectId,
    source,
    source_instance: sourceInstance,
    native_id: nativeId,
    visibility: "project_visible",
  });
}

function quarantineChange(change: SourceChange, errorCode: string): void {
  const identity = canonicalIdentity(change);
  const now = new Date().toISOString();
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
    change.org_id,
    change.project_id,
    change.source,
    identity.sourceInstance,
    identity.nativeId,
    identity.sourceVersion ?? null,
    errorCode,
    now,
    now,
  );
}

function clearQuarantine(change: SourceChange): void {
  const identity = canonicalIdentity(change);
  db.prepare(
    `DELETE FROM project_source_quarantine
     WHERE org_id = ? AND project_id = ? AND source = ? AND source_instance = ? AND native_id = ?`,
  ).run(change.org_id, change.project_id, change.source, identity.sourceInstance, identity.nativeId);
}

export async function applySourceChanges(changes: readonly SourceChange[]): Promise<ApplySourceChangesResult>;
export async function applySourceChanges(
  orgId: string,
  projectId: string,
  changes: readonly SourceChange[],
): Promise<ApplySourceChangesResult>;
export async function applySourceChanges(
  arg1: string | readonly SourceChange[],
  arg2?: string,
  arg3?: readonly SourceChange[],
): Promise<ApplySourceChangesResult> {
  const changes = typeof arg1 === "string" ? (arg3 ?? []) : arg1;
  const expectedOrgId = typeof arg1 === "string" ? arg1 : undefined;
  const expectedProjectId = typeof arg1 === "string" ? arg2 : undefined;
  const result: ApplySourceChangesResult = { upserted: 0, deleted: 0, quarantined: 0 };

  for (const change of changes) {
    if ((expectedOrgId && change.org_id !== expectedOrgId) || (expectedProjectId && change.project_id !== expectedProjectId)) {
      throw new Error("SourceChange scope does not match applySourceChanges scope");
    }
    if (change.kind === "delete" || change.visibility !== "project_visible") {
      result.deleted += deleteEvidenceIdentity(change);
      continue;
    }

    const identity = canonicalIdentity(change);
    try {
      await recordProjectEvidence({
        org_id: change.org_id,
        project_id: change.project_id,
        source: change.source,
        source_type: change.evidence.source_type,
        source_id: identity.sourceId,
        source_instance: identity.sourceInstance,
        native_id: identity.nativeId,
        source_version: change.source_version,
        source_url: change.evidence.source_url,
        source_title: change.evidence.source_title,
        summary: change.evidence.summary,
        body: change.evidence.body,
        author: change.evidence.author,
        occurred_at: change.occurred_at,
        source_updated_at: change.updated_at,
        metadata: change.evidence.metadata,
        confidence_score: change.evidence.confidence_score,
        promotable: change.evidence.promotable,
        visibility: change.visibility,
        visibility_version: change.visibility_version,
      });
      clearQuarantine(change);
      result.upserted++;
    } catch (error) {
      if (!(error instanceof ProjectEvidenceNormalizationError)) throw error;
      quarantineChange(change, error.code);
      result.quarantined++;
    }
  }
  return result;
}

/** Conservative binding-change cleanup. It intentionally purges the entire
 * source and lets the remaining bindings repopulate it, avoiding ambiguous
 * legacy rows that predate binding provenance. */
export function purgeProjectEvidenceSource(
  orgId: string,
  projectId: string,
  source: ProjectEvidenceSource | ProjectSourceHealthSource,
): ProjectEvidenceSourcePurgeResult {
  return withTransaction(() => {
    const indexSource = indexSourceFor(source);
    const evidenceSources = evidenceSourcesFor(source);
    const evidenceSourcePlaceholders = evidenceSources.map(() => "?").join(", ");
    const promotedRows = db.prepare(
      `SELECT DISTINCT promoted_node_id FROM project_evidence_items
       WHERE org_id = ? AND project_id = ? AND source IN (${evidenceSourcePlaceholders})
         AND promoted_node_id IS NOT NULL`,
    ).all(orgId, projectId, ...evidenceSources) as Array<{ promoted_node_id: string }>;
    const retractedNodeIds = retractProjectEvidenceKnowledgeNodes(
      orgId,
      projectId,
      promotedRows.map((row) => row.promoted_node_id),
    );
    const documents = db.prepare(
      "SELECT id FROM project_search_documents WHERE org_id = ? AND project_id = ? AND source = ?",
    ).all(orgId, projectId, indexSource) as Array<{ id: string }>;
    for (const { id } of documents) deleteFtsDocument(id);
    deleteGraphForDocuments(documents.map((row) => row.id));
    let documentsDeleted = Number(db.prepare(
      "DELETE FROM project_search_documents WHERE org_id = ? AND project_id = ? AND source = ?",
    ).run(orgId, projectId, indexSource).changes);

    if (retractedNodeIds.length > 0) {
      const kgDocuments = db.prepare(
        `SELECT id FROM project_search_documents
         WHERE org_id = ? AND project_id = ? AND source = 'kg'
           AND source_id IN (${retractedNodeIds.map(() => "?").join(", ")})`,
      ).all(orgId, projectId, ...retractedNodeIds) as Array<{ id: string }>;
      for (const { id } of kgDocuments) deleteFtsDocument(id);
      deleteGraphForDocuments(kgDocuments.map((row) => row.id));
      documentsDeleted += Number(db.prepare(
        `DELETE FROM project_search_documents
         WHERE org_id = ? AND project_id = ? AND source = 'kg'
           AND source_id IN (${retractedNodeIds.map(() => "?").join(", ")})`,
      ).run(orgId, projectId, ...retractedNodeIds).changes);
    }

    let evidenceDeleted = 0;
    let cursorsDeleted = 0;
    let syncStatesDeleted = 0;
    let quarantineDeleted = 0;
    for (const evidenceSource of evidenceSources) {
      evidenceDeleted += Number(db.prepare(
        "DELETE FROM project_evidence_items WHERE org_id = ? AND project_id = ? AND source = ?",
      ).run(orgId, projectId, evidenceSource).changes);
      cursorsDeleted += Number(db.prepare(
        "DELETE FROM project_ingestion_cursors WHERE org_id = ? AND project_id = ? AND source = ?",
      ).run(orgId, projectId, evidenceSource).changes);
      syncStatesDeleted += Number(db.prepare(
        "DELETE FROM project_source_sync_state WHERE org_id = ? AND project_id = ? AND source = ?",
      ).run(orgId, projectId, evidenceSource).changes);
      quarantineDeleted += Number(db.prepare(
        "DELETE FROM project_source_quarantine WHERE org_id = ? AND project_id = ? AND source = ?",
      ).run(orgId, projectId, evidenceSource).changes);
    }
    if (!evidenceSources.includes(indexSource)) {
      cursorsDeleted += Number(db.prepare(
        "DELETE FROM project_ingestion_cursors WHERE org_id = ? AND project_id = ? AND source = ?",
      ).run(orgId, projectId, indexSource).changes);
      syncStatesDeleted += Number(db.prepare(
        "DELETE FROM project_source_sync_state WHERE org_id = ? AND project_id = ? AND source = ?",
      ).run(orgId, projectId, indexSource).changes);
      quarantineDeleted += Number(db.prepare(
        "DELETE FROM project_source_quarantine WHERE org_id = ? AND project_id = ? AND source = ?",
      ).run(orgId, projectId, indexSource).changes);
    }

    clearDerivedContextSearchCache();

    return {
      evidence_deleted: evidenceDeleted,
      documents_deleted: documentsDeleted,
      cursors_deleted: cursorsDeleted,
      sync_states_deleted: syncStatesDeleted,
      quarantine_deleted: quarantineDeleted,
    };
  });
}

function syncSourceInstance(sourceInstance: string): string {
  const findings = new Set<string>();
  const value = /^[a-z][a-z0-9+.-]*:\/\//i.test(sourceInstance)
    ? redactProjectUrl(sourceInstance, findings)
    : redactSecrets(sourceInstance.trim()).text;
  return value || "default";
}

function syncRow(row: Record<string, unknown>): ProjectSourceSyncState {
  return {
    org_id: String(row.org_id),
    project_id: String(row.project_id),
    source: row.source as ProjectSourceHealthSource,
    source_instance: String(row.source_instance),
    ...(row.last_attempt_at ? { last_attempt_at: String(row.last_attempt_at) } : {}),
    ...(row.last_success_at ? { last_success_at: String(row.last_success_at) } : {}),
    ...(row.last_reconciliation_at ? { last_reconciliation_at: String(row.last_reconciliation_at) } : {}),
    ...(typeof row.lag_seconds === "number" ? { lag_seconds: row.lag_seconds } : {}),
    indexed_count: Number(row.indexed_count),
    retry_count: Number(row.retry_count),
    ...(row.last_error_code ? { last_error_code: String(row.last_error_code) } : {}),
    ...(row.last_error_message ? { last_error_message: String(row.last_error_message) } : {}),
    updated_at: String(row.updated_at),
  };
}

export function getProjectSourceSyncState(
  orgId: string,
  projectId: string,
  source: ProjectSourceHealthSource,
  sourceInstance: string,
): ProjectSourceSyncState | null {
  const row = db.prepare(
    `SELECT * FROM project_source_sync_state
     WHERE org_id = ? AND project_id = ? AND source = ? AND source_instance = ?`,
  ).get(orgId, projectId, source, syncSourceInstance(sourceInstance)) as Record<string, unknown> | undefined;
  return row ? syncRow(row) : null;
}

export function listProjectSourceSyncStates(orgId: string, projectId: string): ProjectSourceSyncState[] {
  return (db.prepare(
    `SELECT * FROM project_source_sync_state
     WHERE org_id = ? AND project_id = ? ORDER BY source, source_instance`,
  ).all(orgId, projectId) as Array<Record<string, unknown>>).map(syncRow);
}

function ensureSyncState(
  orgId: string,
  projectId: string,
  source: ProjectSourceHealthSource,
  sourceInstance: string,
  now: string,
): string {
  const instance = syncSourceInstance(sourceInstance);
  db.prepare(
    `INSERT INTO project_source_sync_state
       (org_id, project_id, source, source_instance, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(org_id, project_id, source, source_instance) DO NOTHING`,
  ).run(orgId, projectId, source, instance, now);
  return instance;
}

export function recordProjectSourceSyncAttempt(
  orgId: string,
  projectId: string,
  source: ProjectSourceHealthSource,
  sourceInstance: string,
  attemptedAt = new Date().toISOString(),
): void {
  const instance = ensureSyncState(orgId, projectId, source, sourceInstance, attemptedAt);
  db.prepare(
    `UPDATE project_source_sync_state SET last_attempt_at = ?, updated_at = ?
     WHERE org_id = ? AND project_id = ? AND source = ? AND source_instance = ?`,
  ).run(attemptedAt, attemptedAt, orgId, projectId, source, instance);
}

export function recordProjectSourceSyncSuccess(
  orgId: string,
  projectId: string,
  source: ProjectSourceHealthSource,
  sourceInstance: string,
  input: ProjectSourceSyncSuccessInput = {},
): void {
  const succeededAt = input.succeeded_at ?? new Date().toISOString();
  const attemptedAt = input.attempted_at ?? succeededAt;
  const instance = ensureSyncState(orgId, projectId, source, sourceInstance, succeededAt);
  db.prepare(
    `UPDATE project_source_sync_state SET
       last_attempt_at = ?, last_success_at = ?, lag_seconds = COALESCE(?, lag_seconds),
       indexed_count = COALESCE(?, indexed_count), retry_count = 0,
       last_error_code = NULL, last_error_message = NULL, updated_at = ?
     WHERE org_id = ? AND project_id = ? AND source = ? AND source_instance = ?`,
  ).run(
    attemptedAt,
    succeededAt,
    input.lag_seconds ?? null,
    input.indexed_count ?? null,
    succeededAt,
    orgId,
    projectId,
    source,
    instance,
  );
}

function sanitizedErrorCode(code: string): string {
  const trimmed = code.trim();
  return /^[A-Za-z0-9_.-]{1,80}$/.test(trimmed) ? trimmed : "sync_error";
}

function sanitizedErrorMessage(message: string): string {
  const singleLine = message.replace(/\s+/g, " ").trim().slice(0, 400);
  return redactSecrets(singleLine).text.replace(/https?:\/\/[^\s]+/gi, (url) => redactProjectUrl(url));
}

export function recordProjectSourceSyncFailure(
  orgId: string,
  projectId: string,
  source: ProjectSourceHealthSource,
  sourceInstance: string,
  errorCode: string,
  errorMessage: string,
  attemptedAt = new Date().toISOString(),
): void {
  const instance = ensureSyncState(orgId, projectId, source, sourceInstance, attemptedAt);
  db.prepare(
    `UPDATE project_source_sync_state SET
       last_attempt_at = ?, retry_count = retry_count + 1,
       last_error_code = ?, last_error_message = ?, updated_at = ?
     WHERE org_id = ? AND project_id = ? AND source = ? AND source_instance = ?`,
  ).run(
    attemptedAt,
    sanitizedErrorCode(errorCode),
    sanitizedErrorMessage(errorMessage),
    attemptedAt,
    orgId,
    projectId,
    source,
    instance,
  );
}

export function recordProjectSourceReconciliation(
  orgId: string,
  projectId: string,
  source: ProjectSourceHealthSource,
  sourceInstance: string,
  reconciledAt = new Date().toISOString(),
): void {
  const instance = ensureSyncState(orgId, projectId, source, sourceInstance, reconciledAt);
  db.prepare(
    `UPDATE project_source_sync_state SET last_reconciliation_at = ?, updated_at = ?
     WHERE org_id = ? AND project_id = ? AND source = ? AND source_instance = ?`,
  ).run(reconciledAt, reconciledAt, orgId, projectId, source, instance);
}

/** Stable opaque id for quarantine/debug references without storing content. */
export function sourceChangeReference(change: SourceChange): string {
  const identity = canonicalIdentity(change);
  return crypto.createHash("sha256").update(`${change.source}\0${identity.sourceId}`).digest("hex");
}
