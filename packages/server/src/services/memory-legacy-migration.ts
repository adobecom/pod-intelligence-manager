import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  canonicalJsonSha256,
  canonicalizeJson,
  memoryContractIssues,
  parseMemoryContract,
  type CodebaseApplicabilityV1,
  type CompatibilityV1,
  type EvidenceHandleV1,
  type EvidenceSummaryV1,
  type FreshnessV1,
  type HarnessApplicabilityV1,
  type MemoryCandidateV1,
  type MemoryContentV1,
  type OrgApplicabilityV1,
  type ValidationV1,
} from "@pim/shared";
import db, { dbPath, withImmediateTransaction } from "../db/connection.js";
import { getMemoryAuthorityState, installLegacySqlWriteBarriers } from "./memory-authority.js";
import {
  canonicalHarnessMemoryClaimKey,
  importActiveHarnessMemoryRecord,
} from "./memory-harness-records.js";
import {
  canonicalMemoryClaimKey,
  importActiveMemoryRecord,
} from "./memory-records.js";
import { deriveActivationRequirement } from "./memory-candidates.js";
import type { LegacyGraphInventoryReport } from "./legacy-graph-inventory.js";
import {
  memoryStructuralIssues,
  type MemoryPlane,
  type ThinV1MemoryKind,
} from "./memory-structural-validator.js";

export type MemoryLegacySourceKind =
  | "graph_node"
  | "project_candidate"
  | "agent_candidate"
  | "project_evidence";
export type MemoryLegacyDisposition =
  | "active"
  | "pending_validation"
  | "quarantined"
  | "deduplicated";

export interface MemoryLegacyCanonicalMapping {
  org_id: string;
  project_id: string;
  plane: MemoryPlane;
  kind: ThinV1MemoryKind;
  content: MemoryContentV1;
  applicability: CodebaseApplicabilityV1 | HarnessApplicabilityV1 | OrgApplicabilityV1;
  validation: ValidationV1;
  exceptions: string[];
  compatibility: CompatibilityV1;
  evidence: EvidenceHandleV1[];
  evidence_summary: EvidenceSummaryV1;
  freshness: FreshnessV1;
  provenance: Record<string, unknown>;
}

export interface MemoryLegacySourceResolution {
  source_kind: MemoryLegacySourceKind;
  source_key: string;
  source_payload_digest: string;
  disposition: "active" | "pending_validation" | "quarantined";
  reason_code: string;
  mapping?: MemoryLegacyCanonicalMapping;
}

export interface MemoryLegacyResolutionManifest {
  schema_version: "pim.memory-legacy-resolution-manifest.v1";
  source_database_sha256: string;
  resolutions: MemoryLegacySourceResolution[];
}

export interface MemoryLegacyMigrationInput {
  graphRoots: string[];
  inventoryReport: unknown;
  resolutionManifest: unknown;
  actorId?: string;
  now?: string;
}

export interface MemoryLegacyResolutionTemplateInput {
  graphRoots: string[];
  inventoryReport: unknown;
}

export interface MemoryLegacyMigrationReportItem {
  import_item_id: string;
  source_kind: MemoryLegacySourceKind;
  source_key: string;
  legacy_id: string;
  disposition: MemoryLegacyDisposition;
  reason_code: string;
  canonical_record_id?: string;
  canonical_record_version?: number;
  duplicate_of_item_id?: string;
}

export interface MemoryLegacyMigrationReport {
  schema_version: "pim.memory-legacy-migration-report.v1";
  import_run_id: string;
  inventory_digest: string;
  resolution_digest: string;
  source_bundle_digest: string;
  source_item_count: number;
  imported_count: number;
  pending_count: number;
  quarantined_count: number;
  deduplicated_count: number;
  authority: "migration_locked" | "canonical";
  items: MemoryLegacyMigrationReportItem[];
  created_at: string;
}

export interface MemoryLegacyDualReadItem {
  logical_memory_key: string;
  org_id: string;
  project_id: string;
  plane: MemoryPlane;
  canonical_record_id: string;
  canonical_record_version: number;
  legacy_import_item_ids: string[];
  selected_authority: "canonical";
}

export interface MemoryLegacyDualReadReport {
  schema_version: "pim.memory-legacy-dual-read-report.v1";
  import_run_id: string;
  legacy_projection_count: number;
  canonical_projection_count: number;
  combined_projection_count: number;
  returned_count: number;
  deduplicated_count: number;
  suppressed_inactive_legacy_count: number;
  items: MemoryLegacyDualReadItem[];
}

interface LoadedSource {
  sourceKind: MemoryLegacySourceKind;
  sourceKey: string;
  legacyId: string;
  legacyNodeId: string | null;
  orgId: string;
  projectId: string | null;
  graphVersion: number | null;
  snapshotSha256: string | null;
  contentDigest: string;
  semanticDigest: string;
  sourceTimestamp: string | null;
  payload: Record<string, unknown>;
  provenance: Record<string, unknown>;
  supersedesLegacyId: string | null;
  forcedReason: string | null;
}

interface PlannedItem extends LoadedSource {
  importItemId: string;
  plane: MemoryPlane | null;
  mapping: MemoryLegacyCanonicalMapping | null;
  disposition: MemoryLegacyDisposition;
  reasonCode: string;
  canonicalRecordId: string | null;
  canonicalRecordVersion: number | null;
  reuseExistingCanonical: boolean;
  duplicateOfItemId: string | null;
}

export interface MemoryLegacyMigrationPlan extends MemoryLegacyMigrationReport {
  authority: "migration_locked";
  planned_items: PlannedItem[];
}

export class MemoryLegacyMigrationInputError extends Error {
  readonly code = "migration_input_invalid";
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "MemoryLegacyMigrationInputError";
  }
}

export class MemoryLegacyMigrationConflictError extends Error {
  readonly code = "idempotency_conflict";
  readonly statusCode = 409;
  constructor(message: string) {
    super(message);
    this.name = "MemoryLegacyMigrationConflictError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function sha256File(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function jsonSafeValue(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { __legacy_blob_base64: Buffer.from(value).toString("base64") };
  }
  if (typeof value === "bigint") return { __legacy_bigint: value.toString() };
  if (Array.isArray(value)) return value.map(jsonSafeValue);
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafeValue(item)]));
  }
  return value;
}

function safeRecord(value: Record<string, unknown>): Record<string, unknown> {
  return jsonSafeValue(value) as Record<string, unknown>;
}

function assertDigest(value: unknown, field: string, prefixed = true): asserts value is string {
  const pattern = prefixed ? /^sha256:[0-9a-f]{64}$/ : /^[0-9a-f]{64}$/;
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new MemoryLegacyMigrationInputError(`${field} must be a lowercase SHA-256 digest`);
  }
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) {
    throw new MemoryLegacyMigrationInputError(`${field} contains unknown fields: ${extras.sort().join(", ")}`);
  }
}

function parseInventory(value: unknown): LegacyGraphInventoryReport {
  if (!isObject(value)) throw new MemoryLegacyMigrationInputError("inventoryReport must be an object");
  if (value.toolVersion !== "legacy-graph-inventory/v1" || !isObject(value.database)
      || !Array.isArray(value.graphRoots) || !Array.isArray(value.snapshots)) {
    throw new MemoryLegacyMigrationInputError("inventoryReport is not a legacy-graph-inventory/v1 report");
  }
  return value as unknown as LegacyGraphInventoryReport;
}

function parseManifest(value: unknown): MemoryLegacyResolutionManifest {
  if (!isObject(value)) throw new MemoryLegacyMigrationInputError("resolutionManifest must be an object");
  assertExactKeys(value, ["schema_version", "source_database_sha256", "resolutions"], "resolutionManifest");
  if (value.schema_version !== "pim.memory-legacy-resolution-manifest.v1" || !Array.isArray(value.resolutions)) {
    throw new MemoryLegacyMigrationInputError("resolutionManifest has an unsupported schema version or resolutions shape");
  }
  assertDigest(value.source_database_sha256, "resolutionManifest.source_database_sha256", false);
  const seen = new Set<string>();
  for (const [index, raw] of value.resolutions.entries()) {
    if (!isObject(raw)) throw new MemoryLegacyMigrationInputError(`resolutions[${index}] must be an object`);
    assertExactKeys(raw, ["source_kind", "source_key", "source_payload_digest", "disposition", "reason_code", "mapping"], `resolutions[${index}]`);
    if (!["graph_node", "project_candidate", "agent_candidate", "project_evidence"].includes(String(raw.source_kind))
        || !stringValue(raw.source_key) || !stringValue(raw.reason_code)
        || !["active", "pending_validation", "quarantined"].includes(String(raw.disposition))) {
      throw new MemoryLegacyMigrationInputError(`resolutions[${index}] has invalid identity or disposition fields`);
    }
    assertDigest(raw.source_payload_digest, `resolutions[${index}].source_payload_digest`);
    const identity = `${raw.source_kind}\0${raw.source_key}`;
    if (seen.has(identity)) throw new MemoryLegacyMigrationInputError(`Duplicate resolution for ${raw.source_kind}:${raw.source_key}`);
    seen.add(identity);
    if (raw.mapping !== undefined && !isObject(raw.mapping)) {
      throw new MemoryLegacyMigrationInputError(`resolutions[${index}].mapping must be an object`);
    }
  }
  canonicalizeJson(value);
  return value as unknown as MemoryLegacyResolutionManifest;
}

function scanGraphPaths(roots: string[]): string[] {
  const paths: string[] = [];
  for (const root of roots) {
    const stat = fs.statSync(root);
    if (!stat.isDirectory()) throw new MemoryLegacyMigrationInputError(`Graph root is not a directory: ${root}`);
    for (const org of fs.readdirSync(root, { withFileTypes: true })) {
      if (!org.isDirectory() || org.isSymbolicLink()) continue;
      const directory = path.join(root, org.name);
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isFile() && /^graph-(latest|v\d+)\.json$/.test(entry.name)) paths.push(path.join(directory, entry.name));
      }
    }
  }
  return paths.sort();
}

function validateInventoryFiles(roots: string[], inventory: LegacyGraphInventoryReport, verifyDatabaseHash: boolean): void {
  const expectedRoots = [...new Set(roots.map((root) => path.resolve(root)))].sort();
  if (canonicalizeJson(expectedRoots) !== canonicalizeJson(inventory.graphRoots.map((root) => path.resolve(root)).sort())) {
    throw new MemoryLegacyMigrationConflictError("Explicit graph roots do not match the inventory report");
  }
  if (path.resolve(inventory.database.path) !== path.resolve(dbPath)) {
    throw new MemoryLegacyMigrationConflictError("The inventory database path does not match DB_PATH");
  }
  if (verifyDatabaseHash) {
    const wal = `${dbPath}-wal`;
    if (fs.existsSync(wal) && fs.statSync(wal).size > 0) {
      throw new MemoryLegacyMigrationConflictError("The database has an active WAL; checkpoint the offline source first");
    }
    if (sha256File(dbPath) !== inventory.database.sha256) {
      throw new MemoryLegacyMigrationConflictError("The current database hash does not match the inventory report");
    }
  }
  const scanned = scanGraphPaths(expectedRoots);
  const reported = inventory.snapshots.map((snapshot) => path.resolve(snapshot.path)).sort();
  if (canonicalizeJson(scanned) !== canonicalizeJson(reported)) {
    throw new MemoryLegacyMigrationConflictError("The current graph snapshot set does not match the inventory report");
  }
  for (const snapshot of inventory.snapshots) {
    if (sha256File(snapshot.path) !== snapshot.sha256) {
      throw new MemoryLegacyMigrationConflictError(`Graph snapshot hash changed after inventory: ${snapshot.path}`);
    }
  }
}

function tableExists(table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table));
}

function graphSources(inventory: LegacyGraphInventoryReport): LoadedSource[] {
  const sources: LoadedSource[] = [];
  for (const snapshot of inventory.snapshots) {
    if (snapshot.kind !== "latest") continue;
    const snapshotPath = path.resolve(snapshot.path);
    const snapshotDigest = `sha256:${snapshot.sha256}`;
    const rawBytes = fs.readFileSync(snapshot.path);
    let graph: unknown;
    try {
      graph = JSON.parse(rawBytes.toString("utf8")) as unknown;
    } catch {
      graph = null;
    }
    if (!isObject(graph) || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
      const legacyId = `invalid-snapshot-${snapshot.sha256.slice(0, 24)}`;
      const payload = {
        snapshot_path: snapshotPath,
        snapshot_sha256: snapshotDigest,
        raw_snapshot_base64: rawBytes.toString("base64"),
        inventory_issues: snapshot.issues,
      };
      sources.push({
        sourceKind: "graph_node",
        sourceKey: `${snapshotPath}#__invalid_snapshot__`,
        legacyId,
        legacyNodeId: legacyId,
        orgId: snapshot.orgId ?? snapshot.directoryOrgId ?? `__unresolved_org__:${snapshot.sha256.slice(0, 16)}`,
        projectId: null,
        graphVersion: snapshot.graphVersion ?? snapshot.filenameVersion ?? 0,
        snapshotSha256: snapshotDigest,
        contentDigest: canonicalJsonSha256(payload),
        semanticDigest: canonicalJsonSha256(payload),
        sourceTimestamp: null,
        payload,
        provenance: { graph_path: snapshotPath, inventory_issues: snapshot.issues },
        supersedesLegacyId: null,
        forcedReason: "invalid_graph_snapshot",
      });
      continue;
    }
    const graphOrgId = stringValue(graph.org_id) ?? snapshot.orgId ?? snapshot.directoryOrgId
      ?? `__unresolved_org__:${snapshot.sha256.slice(0, 16)}`;
    const graphOrgMissing = !stringValue(graph.org_id) && !snapshot.orgId && !snapshot.directoryOrgId;
    const graphVersion = typeof graph.version === "number" && Number.isFinite(graph.version)
      ? graph.version
      : snapshot.graphVersion ?? 0;
    const objectNodeIds = graph.nodes
      .filter(isObject)
      .map((node) => stringValue(node.id))
      .filter((nodeId): nodeId is string => nodeId !== null);
    const duplicateNodeIds = new Set(objectNodeIds.filter((nodeId, index) => objectNodeIds.indexOf(nodeId) !== index));
    const snapshotSources: LoadedSource[] = [];
    for (const [nodeIndex, rawNode] of graph.nodes.entries()) {
      if (!isObject(rawNode) || !stringValue(rawNode.id)) {
        const payload = { node_index: nodeIndex, raw_node: jsonSafeValue(rawNode) };
        const legacyId = `invalid-node-${nodeIndex}-${canonicalJsonSha256(payload).slice(7, 23)}`;
        snapshotSources.push({
          sourceKind: "graph_node",
          sourceKey: `${snapshotPath}#__invalid_node_${nodeIndex}`,
          legacyId,
          legacyNodeId: legacyId,
          orgId: graphOrgId,
          projectId: null,
          graphVersion,
          snapshotSha256: snapshotDigest,
          contentDigest: canonicalJsonSha256(payload),
          semanticDigest: canonicalJsonSha256(payload),
          sourceTimestamp: null,
          payload,
          provenance: { graph_path: snapshotPath, node_index: nodeIndex, snapshot_issues: snapshot.issues },
          supersedesLegacyId: null,
          forcedReason: "invalid_graph_node",
        });
        continue;
      }
      const node = safeRecord(rawNode);
      const nodeId = stringValue(node.id);
      if (!nodeId) throw new MemoryLegacyMigrationConflictError("Normalized graph node lost its identity");
      const { id: _id, ...semanticPayload } = node;
      const supersedes = graph.edges
        .filter((edge): edge is Record<string, unknown> => isObject(edge)
          && edge.type === "supersedes" && edge.source === nodeId && typeof edge.target === "string")
        .map((edge) => String(edge.target)).sort();
      const relatedEdges = graph.edges.filter((edge) => isObject(edge)
        && (edge.source === nodeId || edge.target === nodeId));
      snapshotSources.push({
        sourceKind: "graph_node",
        sourceKey: `${snapshotPath}#${encodeURIComponent(nodeId)}${duplicateNodeIds.has(nodeId) ? `@${nodeIndex}` : ""}`,
        legacyId: nodeId,
        legacyNodeId: nodeId,
        orgId: graphOrgId,
        projectId: stringValue(node.source_project_id),
        graphVersion,
        snapshotSha256: snapshotDigest,
        contentDigest: canonicalJsonSha256(node),
        semanticDigest: canonicalJsonSha256(semanticPayload),
        sourceTimestamp: stringValue(node.created_at),
        payload: node,
        provenance: {
          graph_path: snapshotPath,
          graph_version: graphVersion,
          snapshot_sha256: snapshotDigest,
          snapshot_issues: snapshot.issues,
          provenance: node.provenance ?? null,
          ingestion_provenance: node.ingestion_provenance ?? null,
          related_edges: relatedEdges,
        },
        supersedesLegacyId: supersedes.length === 1 ? supersedes[0] : null,
        forcedReason: graphOrgMissing
          ? "missing_org_id"
          : duplicateNodeIds.has(nodeId)
            ? "duplicate_graph_node_id"
            : snapshot.issues.length > 0
          ? "snapshot_integrity_issue"
          : supersedes.length > 1
            ? "ambiguous_supersession"
            : null,
      });
    }
    sources.push(...snapshotSources);
    for (const predecessor of snapshotSources) {
      const successorId = stringValue(predecessor.payload.superseded_by);
      if (!successorId) continue;
      const successors = snapshotSources.filter((source) => source.legacyId === successorId);
      if (successors.length !== 1) {
        predecessor.forcedReason ??= "missing_supersession_target";
        for (const successor of successors) successor.forcedReason ??= "ambiguous_supersession";
      } else if (successors[0]!.supersedesLegacyId && successors[0]!.supersedesLegacyId !== predecessor.legacyId) {
        successors[0]!.forcedReason ??= "ambiguous_supersession";
      } else {
        successors[0]!.supersedesLegacyId = predecessor.legacyId;
      }
    }
    for (const successor of snapshotSources.filter((source) => source.supersedesLegacyId !== null)) {
      const predecessors = snapshotSources.filter((source) => source.legacyId === successor.supersedesLegacyId);
      if (predecessors.length !== 1) {
        successor.forcedReason ??= "ambiguous_supersession";
        for (const predecessor of predecessors) predecessor.forcedReason ??= "ambiguous_supersession";
        continue;
      }
      predecessors[0]!.provenance.superseded_by_legacy_id = successor.legacyId;
    }
  }
  const byLegacyId = new Map<string, LoadedSource[]>();
  for (const source of sources) {
    const key = `${source.orgId}\0${source.legacyId}`;
    byLegacyId.set(key, [...(byLegacyId.get(key) ?? []), source]);
  }
  for (const group of byLegacyId.values()) {
    if (new Set(group.map((source) => source.semanticDigest)).size > 1) {
      for (const source of group) source.forcedReason = "conflicting_layout_content";
    }
  }
  return sources;
}

function sqlSources(graph: LoadedSource[], inventory: LegacyGraphInventoryReport): LoadedSource[] {
  const graphByPointer = new Map<string, LoadedSource[]>();
  for (const source of graph) {
    const key = `${source.orgId}\0${source.legacyNodeId}`;
    graphByPointer.set(key, [...(graphByPointer.get(key) ?? []), source]);
  }
  const configs: Array<{ table: string; sourceKind: MemoryLegacySourceKind }> = [
    { table: "project_memory_candidates", sourceKind: "project_candidate" },
    { table: "memory_candidates", sourceKind: "agent_candidate" },
    { table: "project_evidence_items", sourceKind: "project_evidence" },
  ];
  const result: LoadedSource[] = [];
  for (const config of configs) {
    if (!tableExists(config.table)) continue;
    const columns = db.prepare(`PRAGMA table_info("${config.table}")`).all() as Array<{ name: string }>;
    let rows: Array<Record<string, unknown>>;
    try {
      rows = db.prepare(`SELECT rowid AS __legacy_rowid, * FROM "${config.table}" ORDER BY rowid`).all() as Array<Record<string, unknown>>;
    } catch {
      const orderColumn = columns.some((column) => column.name === "id") ? "id" : columns[0]?.name;
      rows = db.prepare(`SELECT * FROM "${config.table}"${orderColumn ? ` ORDER BY "${orderColumn}"` : ""}`).all() as Array<Record<string, unknown>>;
    }
    const normalizedRows = rows.map((raw) => {
      const { __legacy_rowid: rowId = null, ...row } = raw;
      return { rowId, row: safeRecord(row) };
    });
    const idCounts = new Map<string, number>();
    for (const { row } of normalizedRows) {
      const id = stringValue(row.id);
      if (id) idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
    }
    for (const [index, { rowId, row }] of normalizedRows.entries()) {
      const digest = canonicalJsonSha256(row);
      const legacyId = stringValue(row.id) ?? `missing-id-${index}-${digest.slice(7, 23)}`;
      const orgId = stringValue(row.org_id) ?? `__unresolved_org__:${digest.slice(7, 23)}`;
      const duplicateId = (idCounts.get(legacyId) ?? 0) > 1;
      const sourceKey = stringValue(row.id) && !duplicateId
        ? legacyId
        : `${legacyId}#row:${String(rowId ?? index)}`;
      const pointer = stringValue(row.promoted_node_id);
      const matches = pointer ? graphByPointer.get(`${orgId}\0${pointer}`) ?? [] : [];
      const semanticDigests = new Set(matches.map((match) => match.semanticDigest));
      const resolved = semanticDigests.size === 1 ? matches[0] : null;
      const promoted = row.status === "promoted" || row.status === "auto_promoted" || pointer !== null;
      const inventoryIssues = inventory.database.issues.filter((issue) => issue.table === config.table
        && (issue.recordId === undefined || issue.recordId === legacyId));
      const forcedReason = !stringValue(row.id)
        ? "missing_legacy_id"
        : duplicateId
          ? "duplicate_legacy_id"
          : !stringValue(row.org_id)
            ? "missing_org_id"
            : ["project_candidate", "project_evidence"].includes(config.sourceKind) && !stringValue(row.project_id)
              ? "missing_project_id"
              : resolved?.projectId && resolved.projectId !== stringValue(row.project_id)
                ? "project_mapping_mismatch"
                : (config.sourceKind === "project_candidate" || config.sourceKind === "agent_candidate")
                    && row.status === "rejected"
                  ? "legacy_candidate_rejected"
              : inventoryIssues.length > 0
        ? "legacy_database_integrity_issue"
        : pointer && matches.length === 0
        ? "orphan_legacy_pointer"
        : semanticDigests.size > 1
          ? "conflicting_layout_content"
          : promoted && !pointer
            ? "promoted_without_pointer"
            : resolved?.forcedReason ?? null;
      result.push({
        sourceKind: config.sourceKind,
        sourceKey,
        legacyId,
        legacyNodeId: resolved?.legacyNodeId ?? null,
        orgId,
        projectId: stringValue(row.project_id),
        graphVersion: resolved?.graphVersion ?? null,
        snapshotSha256: resolved?.snapshotSha256 ?? null,
        contentDigest: digest,
        semanticDigest: resolved?.semanticDigest ?? canonicalJsonSha256({
          type: row.type ?? null,
          summary: row.summary ?? null,
          details: row.details ?? row.body ?? null,
          domains_json: row.domains_json ?? null,
        }),
        sourceTimestamp: stringValue(row.created_at) ?? stringValue(row.occurred_at) ?? stringValue(row.ingested_at),
        payload: row,
        provenance: {
          table: config.table,
          promoted_node_id: pointer,
          graph_resolutions: matches.map((match) => ({
            source_key: match.sourceKey,
            content_digest: match.contentDigest,
            graph_version: match.graphVersion,
            snapshot_sha256: match.snapshotSha256,
          })),
          resolved_node_payload: resolved?.payload ?? null,
          database_issues: inventoryIssues,
        },
        supersedesLegacyId: resolved?.supersedesLegacyId ?? null,
        forcedReason,
      });
    }
  }
  return result;
}

function hasCompleteSourceProvenance(source: LoadedSource): boolean {
  const hasValidTimestamp = source.sourceTimestamp !== null
    && Number.isFinite(Date.parse(source.sourceTimestamp));
  if (source.sourceKind === "graph_node") {
    return hasValidTimestamp
      && ((Array.isArray(source.payload.provenance) && source.payload.provenance.length > 0)
        || isObject(source.payload.ingestion_provenance));
  }
  const linkedNode = isObject(source.provenance.resolved_node_payload)
    ? source.provenance.resolved_node_payload
    : null;
  return source.legacyNodeId !== null && hasValidTimestamp && linkedNode !== null
    && ((Array.isArray(linkedNode.provenance) && linkedNode.provenance.length > 0)
      || isObject(linkedNode.ingestion_provenance));
}

function parsedLegacyEvidence(source: LoadedSource): Record<string, unknown> | null {
  const raw = source.payload.evidence_json;
  if (isObject(raw)) return raw;
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function sourcePlaneIssue(source: LoadedSource, plane: MemoryPlane): string | null {
  if (source.sourceKind === "graph_node") {
    const audience = stringValue(source.payload.audience);
    const expected = audience === "project" || audience === "product"
      ? "codebase"
      : audience === "harness"
        ? "harness"
        : audience === "org"
          ? "org"
          : null;
    if (expected === null) return "legacy_plane_missing";
    if (plane !== "org" && source.projectId === null) return "project_mapping_missing";
    return plane === expected ? null : "legacy_plane_mismatch";
  }
  if (source.sourceKind === "project_candidate" || source.sourceKind === "project_evidence") {
    return plane === "codebase" ? null : "legacy_plane_mismatch";
  }
  if (source.sourceKind !== "agent_candidate") return null;
  const target = stringValue(parsedLegacyEvidence(source)?.target_memory_scope);
  const expected = target === "product" ? "codebase" : target === "harness" ? "harness" : target === "org" ? "org" : null;
  if (!expected) return "target_memory_scope_missing";
  if (expected !== "org" && source.projectId === null) return "project_mapping_missing";
  return plane === expected ? null : "legacy_plane_mismatch";
}

function sourceCanActivate(source: LoadedSource): boolean {
  const linkedNode = source.sourceKind === "graph_node"
    ? source.payload
    : isObject(source.provenance.resolved_node_payload)
      ? source.provenance.resolved_node_payload
      : null;
  if ((linkedNode && stringValue(linkedNode.superseded_by))
      || stringValue(source.provenance.superseded_by_legacy_id)) return false;
  if (source.sourceKind === "graph_node") return source.payload.curated === true;
  if (source.sourceKind === "project_candidate") return source.payload.status === "promoted";
  if (source.sourceKind === "agent_candidate") {
    return source.payload.status === "promoted" || source.payload.status === "auto_promoted";
  }
  return false;
}

function validateMapping(source: LoadedSource, mapping: MemoryLegacyCanonicalMapping): string | null {
  if (!isObject(mapping) || mapping.org_id !== source.orgId || !stringValue(mapping.project_id)) return "resource_mapping_missing";
  if (Object.keys(mapping).some((key) => ![
    "org_id", "project_id", "plane", "kind", "content", "applicability", "validation",
    "exceptions", "compatibility", "evidence", "evidence_summary", "freshness", "provenance",
  ].includes(key))) return "mapped_payload_invalid";
  if (source.projectId !== null && mapping.project_id !== source.projectId) return "project_mapping_mismatch";
  if (!isObject(mapping.content) || !isObject(mapping.applicability) || !isObject(mapping.validation)
      || !Array.isArray(mapping.exceptions) || !Array.isArray(mapping.evidence)
      || !isObject(mapping.evidence_summary) || !isObject(mapping.freshness)
      || !isObject(mapping.compatibility) || !isObject(mapping.provenance)
      || Object.keys(mapping.provenance).length === 0) return "mapped_payload_invalid";
  const componentIssues = [
    ...memoryContractIssues("MemoryCandidateV1", {
      schema_version: "pim.memory-candidate.v1",
      client_candidate_id: "legacy-mapping-validation",
      plane: mapping.plane,
      kind: mapping.kind,
      content: mapping.content,
      applicability: mapping.applicability,
      validation: mapping.validation,
      exceptions: mapping.exceptions,
      source_run_ids: ["legacy-mapping-validation"],
      evidence_refs: [...new Set(mapping.evidence
        .filter(isObject)
        .map((evidence) => stringValue(evidence.evidence_ref_id) ?? ""))],
      extraction: {
        method: "deterministic",
        extractor_version: stringValue(mapping.provenance.extractor_version) ?? "legacy-migration/v1",
        confidence: 0,
      },
      activation_requirement_requested: "verified_merge",
    }),
    ...memoryContractIssues("CompatibilityV1", mapping.compatibility),
    ...mapping.evidence.flatMap((evidence) => memoryContractIssues("EvidenceHandleV1", evidence)),
    ...memoryContractIssues("EvidenceSummaryV1", mapping.evidence_summary),
    ...memoryContractIssues("FreshnessV1", mapping.freshness),
  ];
  if (componentIssues.length > 0 || mapping.evidence.length > 64) return "mapped_contract_invalid";
  const planeIssue = sourcePlaneIssue(source, mapping.plane);
  if (planeIssue) return planeIssue;
  const issues = memoryStructuralIssues({
    plane: mapping.plane,
    kind: mapping.kind,
    content: mapping.content,
    applicability: mapping.applicability,
    validation: mapping.validation,
    exceptions: mapping.exceptions,
  });
  if (issues.length > 0) return "mapped_structure_invalid";
  const linkedNode = source.sourceKind === "graph_node"
    ? source.payload
    : isObject(source.provenance.resolved_node_payload)
      ? source.provenance.resolved_node_payload
      : null;
  if (linkedNode) {
    const legacyType = stringValue(linkedNode.type);
    const expectedKind = legacyType === "decision"
      ? "decision"
      : legacyType === "anti_pattern"
        ? "anti_pattern"
        : legacyType === "pattern" || legacyType === "scope_insight" || legacyType === "resolved_conflict"
          ? "constraint"
          : legacyType === "test_strategy"
            ? "test_strategy"
          : null;
    if (!expectedKind || mapping.kind !== expectedKind
        || mapping.content.summary.trim() !== String(linkedNode.summary ?? "").trim()
        || mapping.content.details.trim() !== String(linkedNode.details ?? "").trim()) {
      return "mapped_content_not_source_derived";
    }
  }
  if (!stringValue(mapping.compatibility.harness_version_range)
      || !stringValue(mapping.compatibility.workflow_version_range)) return "compatibility_mapping_missing";
  if (!Number.isFinite(Date.parse(mapping.freshness.last_confirmed_at))
      || (mapping.freshness.expires_at !== undefined && mapping.freshness.expires_at !== null
        && !Number.isFinite(Date.parse(mapping.freshness.expires_at)))) return "freshness_mapping_invalid";
  if (!Number.isSafeInteger(mapping.evidence_summary.ref_count) || mapping.evidence_summary.ref_count !== mapping.evidence.length
      || !["observed", "reviewed", "verified_merge", "verified_merge_and_test", "verified_runtime"]
        .includes(mapping.evidence_summary.strength)) return "evidence_summary_invalid";
  if (mapping.evidence.some((evidence) => !isObject(evidence)
      || !stringValue(evidence.evidence_ref_id)
      || !stringValue(evidence.type) || !/^sha256:[0-9a-f]{64}$/.test(evidence.digest)
      || !stringValue(evidence.origin_id)
      || !["observed", "verified", "authorized_review"].includes(evidence.source_authority))) {
    return "evidence_mapping_invalid";
  }
  const linkedEvidenceDigests = new Set<string>([source.contentDigest]);
  if (Array.isArray(source.provenance.graph_resolutions)) {
    for (const resolution of source.provenance.graph_resolutions) {
      if (isObject(resolution) && stringValue(resolution.content_digest)) {
        linkedEvidenceDigests.add(String(resolution.content_digest));
      }
    }
  }
  if (mapping.evidence.length > 0
      && !mapping.evidence.some((evidence) => linkedEvidenceDigests.has(evidence.digest))) {
    return "evidence_not_linked_to_legacy_source";
  }
  if (!db.prepare("SELECT 1 FROM projects WHERE project_id = ? AND org_id = ?").get(mapping.project_id, mapping.org_id)) {
    return "project_mapping_missing";
  }
  if (mapping.plane === "codebase") {
    const repositoryId = stringValue((mapping.applicability as CodebaseApplicabilityV1).repository_id);
    if (!repositoryId || !db.prepare(
      `SELECT 1 FROM memory_repository_registry
       WHERE org_id = ? AND project_id = ? AND repository_id = ? AND valid_until IS NULL`,
    ).get(mapping.org_id, mapping.project_id, repositoryId)) return "repository_mapping_missing";
  }
  if (mapping.plane === "harness") {
    const applicability = mapping.applicability as HarnessApplicabilityV1;
    if (!stringValue(applicability.harness_id)
        || !(applicability.harness_version_range || applicability.workflow_version_range
          || applicability.adapter_version_range || applicability.configuration_ids?.length
          || applicability.model_ids?.length || applicability.tool_ids?.length)) return "harness_version_mapping_missing";
  }
  if (mapping.plane === "org" && !stringValue((mapping.applicability as OrgApplicabilityV1).policy_owner)) {
    return "org_policy_owner_missing";
  }
  return null;
}

function deterministicId(prefix: string, value: unknown): string {
  return `${prefix}_${canonicalJsonSha256(value).slice(7, 47)}`;
}

function canonicalRecordForMapping(mapping: MemoryLegacyCanonicalMapping): {
  recordId: string;
  recordVersion: number;
} | null {
  const claimKey = mapping.plane === "codebase"
    ? canonicalMemoryClaimKey({
      kind: mapping.kind,
      content: mapping.content,
      applicability: mapping.applicability as CodebaseApplicabilityV1,
      provenance: mapping.provenance,
    })
    : mapping.plane === "harness"
      ? canonicalHarnessMemoryClaimKey({
        kind: mapping.kind,
        content: mapping.content,
        applicability: mapping.applicability as HarnessApplicabilityV1,
        provenance: mapping.provenance,
      })
      : null;
  if (!claimKey) return null;
  const row = db.prepare(
    `SELECT record.record_id, record.current_version, record.current_status,
            record.kind, record.repository_row_id, record.harness_id,
            version.content_json, version.applicability_json, version.exceptions_json,
            version.compatibility_json, version.validation_json, version.evidence_json,
            version.evidence_summary_json, version.freshness_json, version.provenance_json,
            version.content_digest
     FROM memory_records AS record
     INNER JOIN memory_record_versions AS version
       ON version.record_id = record.record_id AND version.record_version = record.current_version
     WHERE record.org_id = ? AND record.project_id = ? AND record.plane = ? AND record.claim_key = ?`,
  ).get(mapping.org_id, mapping.project_id, mapping.plane, claimKey) as {
    record_id: string;
    current_version: number;
    current_status: string;
    kind: string;
    repository_row_id: string | null;
    harness_id: string | null;
    content_json: string;
    applicability_json: string;
    exceptions_json: string;
    compatibility_json: string;
    validation_json: string;
    evidence_json: string;
    evidence_summary_json: string;
    freshness_json: string;
    provenance_json: string;
    content_digest: string;
  } | undefined;
  if (!row) return null;
  if (row.current_status !== "active") {
    throw new MemoryLegacyMigrationConflictError("A mapped canonical claim exists only in inactive history");
  }
  const expectedFields: Array<[string, unknown]> = [
    [row.content_json, mapping.content],
    [row.applicability_json, mapping.applicability],
    [row.exceptions_json, mapping.exceptions],
    [row.compatibility_json, mapping.compatibility],
    [row.validation_json, mapping.validation],
    [row.evidence_json, mapping.evidence],
    [row.evidence_summary_json, mapping.evidence_summary],
    [row.freshness_json, mapping.freshness],
    [row.provenance_json, mapping.provenance],
  ];
  const contentDigest = expectedCanonicalContentDigest(mapping, mapping.provenance);
  if (row.kind !== mapping.kind || row.content_digest !== contentDigest
      || expectedFields.some(([actual, expected]) => canonicalizeJson(JSON.parse(actual)) !== canonicalizeJson(expected))) {
    throw new MemoryLegacyMigrationConflictError("A canonical claim exists with different immutable content");
  }
  if (mapping.plane === "codebase") {
    const repository = db.prepare(
      `SELECT repository_row_id FROM memory_repository_registry
       WHERE org_id = ? AND project_id = ? AND repository_id = ? AND valid_until IS NULL`,
    ).get(
      mapping.org_id,
      mapping.project_id,
      (mapping.applicability as CodebaseApplicabilityV1).repository_id,
    ) as { repository_row_id: string } | undefined;
    if (!repository || repository.repository_row_id !== row.repository_row_id || row.harness_id !== null) {
      throw new MemoryLegacyMigrationConflictError("A canonical claim has a different repository binding");
    }
  } else if (mapping.plane === "harness"
      && (row.repository_row_id !== null
        || row.harness_id !== (mapping.applicability as HarnessApplicabilityV1).harness_id)) {
    throw new MemoryLegacyMigrationConflictError("A canonical claim has a different harness binding");
  }
  return { recordId: row.record_id, recordVersion: row.current_version };
}

function loadSources(input: MemoryLegacyMigrationInput, verifyDatabaseHash: boolean): {
  inventory: LegacyGraphInventoryReport;
  manifest: MemoryLegacyResolutionManifest;
  sources: LoadedSource[];
} {
  const { inventory, sources } = loadInventorySources(input, verifyDatabaseHash);
  const manifest = parseManifest(input.resolutionManifest);
  if (manifest.source_database_sha256 !== inventory.database.sha256) {
    throw new MemoryLegacyMigrationConflictError("Resolution manifest database digest does not match inventory");
  }
  const resolutions = new Map(manifest.resolutions.map((resolution) => [
    `${resolution.source_kind}\0${resolution.source_key}`,
    resolution,
  ]));
  if (resolutions.size !== sources.length) {
    throw new MemoryLegacyMigrationInputError("Resolution manifest must contain exactly one entry for every current source item");
  }
  for (const source of sources) {
    const key = `${source.sourceKind}\0${source.sourceKey}`;
    const resolution = resolutions.get(key);
    if (!resolution) throw new MemoryLegacyMigrationInputError(`Missing resolution for ${source.sourceKind}:${source.sourceKey}`);
    if (resolution.source_payload_digest !== source.contentDigest) {
      throw new MemoryLegacyMigrationConflictError(`Source payload digest changed for ${source.sourceKind}:${source.sourceKey}`);
    }
  }
  for (const resolution of manifest.resolutions) {
    if (!sources.some((source) => source.sourceKind === resolution.source_kind && source.sourceKey === resolution.source_key)) {
      throw new MemoryLegacyMigrationInputError(`Resolution names an unknown source: ${resolution.source_kind}:${resolution.source_key}`);
    }
  }
  return { inventory, manifest, sources };
}

function loadInventorySources(input: MemoryLegacyResolutionTemplateInput, verifyDatabaseHash: boolean): {
  inventory: LegacyGraphInventoryReport;
  sources: LoadedSource[];
} {
  const inventory = parseInventory(input.inventoryReport);
  validateInventoryFiles(input.graphRoots, inventory, verifyDatabaseHash);
  const graph = graphSources(inventory);
  const sources = [...graph, ...sqlSources(graph, inventory)].sort((left, right) =>
    left.sourceKind.localeCompare(right.sourceKind) || left.sourceKey.localeCompare(right.sourceKey));
  return { inventory, sources };
}

export function createMemoryLegacyResolutionTemplate(
  input: MemoryLegacyResolutionTemplateInput,
): MemoryLegacyResolutionManifest {
  const { inventory, sources } = loadInventorySources(input, true);
  return {
    schema_version: "pim.memory-legacy-resolution-manifest.v1",
    source_database_sha256: inventory.database.sha256,
    resolutions: sources.map((source) => ({
      source_kind: source.sourceKind,
      source_key: source.sourceKey,
      source_payload_digest: source.contentDigest,
      disposition: "quarantined",
      reason_code: source.forcedReason ?? "operator_resolution_required",
    })),
  };
}

function loadMigrationIdentity(input: MemoryLegacyMigrationInput, verifyDatabaseHash: boolean): {
  inventory: LegacyGraphInventoryReport;
  manifest: MemoryLegacyResolutionManifest;
  sources: LoadedSource[];
  inventoryDigest: string;
  resolutionDigest: string;
  sourceBundleDigest: string;
  importRunId: string;
} {
  const { inventory, manifest, sources } = loadSources(input, verifyDatabaseHash);
  const inventoryDigest = canonicalJsonSha256(inventory);
  const resolutionDigest = canonicalJsonSha256(manifest);
  const sourceBundleDigest = canonicalJsonSha256({
    database_sha256: inventory.database.sha256,
    snapshots: inventory.snapshots.map((snapshot) => ({ path: path.resolve(snapshot.path), sha256: snapshot.sha256 })),
    items: sources.map((source) => ({ kind: source.sourceKind, key: source.sourceKey, digest: source.contentDigest })),
  });
  const importRunId = deterministicId("legacy_run", { inventoryDigest, resolutionDigest, sourceBundleDigest });
  return { inventory, manifest, sources, inventoryDigest, resolutionDigest, sourceBundleDigest, importRunId };
}

function artifactImportRunId(input: MemoryLegacyMigrationInput): string {
  const inventory = parseInventory(input.inventoryReport);
  const manifest = parseManifest(input.resolutionManifest);
  const expectedRoots = [...new Set(input.graphRoots.map((root) => path.resolve(root)))].sort();
  const reportedRoots = inventory.graphRoots.map((root) => path.resolve(root)).sort();
  if (canonicalizeJson(expectedRoots) !== canonicalizeJson(reportedRoots)
      || path.resolve(inventory.database.path) !== path.resolve(dbPath)
      || manifest.source_database_sha256 !== inventory.database.sha256) {
    throw new MemoryLegacyMigrationConflictError("Replay artifacts do not identify this database and graph inventory");
  }
  const inventoryDigest = canonicalJsonSha256(inventory);
  const resolutionDigest = canonicalJsonSha256(manifest);
  const sourceBundleDigest = canonicalJsonSha256({
    database_sha256: inventory.database.sha256,
    snapshots: inventory.snapshots.map((snapshot) => ({
      path: path.resolve(snapshot.path),
      sha256: snapshot.sha256,
    })),
    items: [...manifest.resolutions]
      .sort((left, right) => left.source_kind.localeCompare(right.source_kind)
        || left.source_key.localeCompare(right.source_key))
      .map((resolution) => ({
        kind: resolution.source_kind,
        key: resolution.source_key,
        digest: resolution.source_payload_digest,
      })),
  });
  return deterministicId("legacy_run", { inventoryDigest, resolutionDigest, sourceBundleDigest });
}

function buildPlan(input: MemoryLegacyMigrationInput, verifyDatabaseHash: boolean): MemoryLegacyMigrationPlan {
  const {
    manifest,
    sources,
    inventoryDigest,
    resolutionDigest,
    sourceBundleDigest,
    importRunId,
  } = loadMigrationIdentity(input, verifyDatabaseHash);
  const resolutions = new Map(manifest.resolutions.map((resolution) => [
    `${resolution.source_kind}\0${resolution.source_key}`,
    resolution,
  ]));
  const items: PlannedItem[] = sources.map((source) => {
    const resolution = resolutions.get(`${source.sourceKind}\0${source.sourceKey}`)!;
    const mapping = resolution.mapping ?? null;
    const mappingError = mapping ? validateMapping(source, mapping) : "resource_mapping_missing";
    let disposition: MemoryLegacyDisposition = resolution.disposition;
    let reasonCode = resolution.reason_code;
    if (resolution.disposition === "quarantined") {
      disposition = "quarantined";
    } else if (source.forcedReason) {
      disposition = "quarantined";
      reasonCode = source.forcedReason;
    } else if (!mapping || mappingError) {
      disposition = "quarantined";
      reasonCode = mappingError ?? "resource_mapping_missing";
    } else if (mapping.plane === "org") {
      disposition = "pending_validation";
      reasonCode = "org_manual_activation_required";
    } else if (resolution.disposition === "pending_validation") {
      disposition = "pending_validation";
    } else if ((mapping.plane === "harness" || mapping.kind === "anti_pattern")
        && !mapping.evidence.some((evidence) => evidence.source_authority === "authorized_review")) {
      disposition = "pending_validation";
      reasonCode = "authorized_review_required";
    } else if (!sourceCanActivate(source)) {
      disposition = "pending_validation";
      const linkedNode = source.sourceKind === "graph_node"
        ? source.payload
        : isObject(source.provenance.resolved_node_payload)
          ? source.provenance.resolved_node_payload
          : null;
      reasonCode = (linkedNode && stringValue(linkedNode.superseded_by))
        || stringValue(source.provenance.superseded_by_legacy_id)
        ? "legacy_source_superseded"
        : source.sourceKind === "project_evidence"
        ? "legacy_evidence_requires_candidate_review"
        : "legacy_source_not_curated_or_promoted";
    } else if (!source.legacyNodeId || !hasCompleteSourceProvenance(source)
        || mapping.evidence.length === 0 || mapping.evidence_summary.ref_count !== mapping.evidence.length) {
      disposition = "pending_validation";
      reasonCode = "incomplete_legacy_provenance";
    } else {
      disposition = "active";
      reasonCode = "legacy_import_validated";
    }
    const importItemId = deterministicId("legacy_item", {
      importRunId,
      sourceKind: source.sourceKind,
      sourceKey: source.sourceKey,
    });
    const existingCanonical = disposition === "active" ? canonicalRecordForMapping(mapping!) : null;
    const canonicalRecordId = disposition === "active"
      ? existingCanonical?.recordId ?? deterministicId("mem_legacy", {
        orgId: mapping!.org_id,
        projectId: mapping!.project_id,
        plane: mapping!.plane,
        kind: mapping!.kind,
        content: mapping!.content,
        applicability: mapping!.applicability,
        extractorVersion: mapping!.provenance.extractor_version ?? "legacy-migration/v1",
      })
      : null;
    return {
      ...source,
      importItemId,
      plane: mapping?.plane ?? null,
      mapping,
      disposition,
      reasonCode,
      canonicalRecordId,
      canonicalRecordVersion: canonicalRecordId ? existingCanonical?.recordVersion ?? 1 : null,
      reuseExistingCanonical: existingCanonical !== null,
      duplicateOfItemId: null,
    };
  });

  const canonicalPayloadDigest = (item: PlannedItem) => canonicalJsonSha256({
    org_id: item.mapping!.org_id,
    project_id: item.mapping!.project_id,
    plane: item.mapping!.plane,
    kind: item.mapping!.kind,
    content: item.mapping!.content,
    applicability: item.mapping!.applicability,
    validation: item.mapping!.validation,
    exceptions: item.mapping!.exceptions,
    compatibility: item.mapping!.compatibility,
    evidence: item.mapping!.evidence,
    evidence_summary: item.mapping!.evidence_summary,
    freshness: item.mapping!.freshness,
    provenance: item.mapping!.provenance,
  });
  const claimGroups = new Map<string, PlannedItem[]>();
  for (const item of items) {
    if (!item.mapping || !["active", "pending_validation"].includes(item.disposition)
        || item.mapping.plane === "org") continue;
    const claimKey = item.mapping.plane === "codebase"
      ? canonicalMemoryClaimKey({
        kind: item.mapping.kind,
        content: item.mapping.content,
        applicability: item.mapping.applicability as CodebaseApplicabilityV1,
        provenance: item.mapping.provenance,
      })
      : canonicalHarnessMemoryClaimKey({
        kind: item.mapping.kind,
        content: item.mapping.content,
        applicability: item.mapping.applicability as HarnessApplicabilityV1,
        provenance: item.mapping.provenance,
      });
    const groupKey = `${item.mapping.org_id}\0${item.mapping.project_id}\0${item.mapping.plane}\0${claimKey}`;
    claimGroups.set(groupKey, [...(claimGroups.get(groupKey) ?? []), item]);
  }
  for (const group of claimGroups.values()) {
    if (new Set(group.map(canonicalPayloadDigest)).size <= 1) continue;
    for (const item of group) {
      item.disposition = "quarantined";
      item.reasonCode = "canonical_claim_collision";
      item.canonicalRecordId = null;
      item.canonicalRecordVersion = null;
      item.reuseExistingCanonical = false;
      item.duplicateOfItemId = null;
    }
  }

  const aliases = new Map<string, PlannedItem>();
  for (const item of [...items].sort((left, right) => {
    const priority = (value: PlannedItem) => value.disposition === "active" ? 0 : 1;
    return priority(left) - priority(right) || left.sourceKind.localeCompare(right.sourceKind) || left.sourceKey.localeCompare(right.sourceKey);
  })) {
    if (!item.mapping || !["active", "pending_validation"].includes(item.disposition)) continue;
    const aliasKey = canonicalPayloadDigest(item);
    const primary = aliases.get(aliasKey);
    if (!primary) {
      aliases.set(aliasKey, item);
      continue;
    }
    item.disposition = "deduplicated";
    item.reasonCode = "same_content_alias";
    item.canonicalRecordId = null;
    item.canonicalRecordVersion = null;
    item.reuseExistingCanonical = false;
    item.duplicateOfItemId = primary.importItemId;
  }

  const createdAt = input.now ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new MemoryLegacyMigrationInputError("now must be a valid timestamp");
  }
  const reportItems: MemoryLegacyMigrationReportItem[] = items.map((item) => ({
    import_item_id: item.importItemId,
    source_kind: item.sourceKind,
    source_key: item.sourceKey,
    legacy_id: item.legacyId,
    disposition: item.disposition,
    reason_code: item.reasonCode,
    ...(item.canonicalRecordId ? {
      canonical_record_id: item.canonicalRecordId,
      canonical_record_version: item.canonicalRecordVersion!,
    } : {}),
    ...(item.duplicateOfItemId ? { duplicate_of_item_id: item.duplicateOfItemId } : {}),
  }));
  return {
    schema_version: "pim.memory-legacy-migration-report.v1",
    import_run_id: importRunId,
    inventory_digest: inventoryDigest,
    resolution_digest: resolutionDigest,
    source_bundle_digest: sourceBundleDigest,
    source_item_count: items.length,
    imported_count: items.filter((item) => item.disposition === "active").length,
    pending_count: items.filter((item) => item.disposition === "pending_validation").length,
    quarantined_count: items.filter((item) => item.disposition === "quarantined").length,
    deduplicated_count: items.filter((item) => item.disposition === "deduplicated").length,
    authority: "migration_locked",
    items: reportItems,
    created_at: createdAt,
    planned_items: items,
  };
}

export function planMemoryLegacyMigration(input: MemoryLegacyMigrationInput): MemoryLegacyMigrationPlan {
  return buildPlan(input, true);
}

function reportFromPlan(
  plan: MemoryLegacyMigrationPlan,
  authority: MemoryLegacyMigrationReport["authority"],
): MemoryLegacyMigrationReport {
  return {
    schema_version: plan.schema_version,
    import_run_id: plan.import_run_id,
    inventory_digest: plan.inventory_digest,
    resolution_digest: plan.resolution_digest,
    source_bundle_digest: plan.source_bundle_digest,
    source_item_count: plan.source_item_count,
    imported_count: plan.imported_count,
    pending_count: plan.pending_count,
    quarantined_count: plan.quarantined_count,
    deduplicated_count: plan.deduplicated_count,
    authority,
    items: plan.items,
    created_at: plan.created_at,
  };
}

interface LegacyProvenanceFields {
  importRunId: string;
  importItemId: string;
  sourceKind: MemoryLegacySourceKind;
  sourceKey: string;
  legacyId: string;
  legacyNodeId: string | null;
  contentDigest: string;
  graphVersion: number | null;
  snapshotSha256: string | null;
  sourceTimestamp: string | null;
  supersedesLegacyId: string | null;
}

function canonicalImportProvenance(
  provenance: Record<string, unknown>,
  fields: LegacyProvenanceFields,
): Record<string, unknown> {
  return {
    ...provenance,
    legacy_migration: {
      schema_version: "pim.memory-legacy-provenance.v1",
      import_run_id: fields.importRunId,
      import_item_id: fields.importItemId,
      source_kind: fields.sourceKind,
      source_key: fields.sourceKey,
      legacy_id: fields.legacyId,
      legacy_node_id: fields.legacyNodeId,
      content_digest: fields.contentDigest,
      graph_version: fields.graphVersion,
      snapshot_sha256: fields.snapshotSha256,
      source_timestamp: fields.sourceTimestamp,
      supersedes_legacy_id: fields.supersedesLegacyId,
    },
  };
}

function provenanceForPlannedItem(item: PlannedItem, importRunId: string): Record<string, unknown> {
  return canonicalImportProvenance(item.mapping!.provenance, {
    importRunId,
    importItemId: item.importItemId,
    sourceKind: item.sourceKind,
    sourceKey: item.sourceKey,
    legacyId: item.legacyId,
    legacyNodeId: item.legacyNodeId,
    contentDigest: item.contentDigest,
    graphVersion: item.graphVersion,
    snapshotSha256: item.snapshotSha256,
    sourceTimestamp: item.sourceTimestamp,
    supersedesLegacyId: item.supersedesLegacyId,
  });
}

function expectedCanonicalContentDigest(
  mapping: MemoryLegacyCanonicalMapping,
  provenance: Record<string, unknown>,
): string {
  return canonicalJsonSha256({
    content: mapping.content,
    applicability: mapping.applicability,
    exceptions: mapping.exceptions,
    compatibility: mapping.compatibility,
    validation: mapping.validation,
    evidence: mapping.evidence,
    evidence_summary: mapping.evidence_summary,
    freshness: mapping.freshness,
    provenance,
  });
}

function assertSameJson(actual: unknown, expected: unknown, label: string): void {
  if (canonicalizeJson(actual) !== canonicalizeJson(expected)) {
    throw new MemoryLegacyMigrationConflictError(`Reconciliation mismatch for ${label}`);
  }
}

function assertCanonicalVersion(input: {
  recordId: string;
  recordVersion: number;
  mapping: MemoryLegacyCanonicalMapping;
  provenance: Record<string, unknown>;
  requireCurrentActive?: boolean;
  requireSafeNewImport?: boolean;
}): void {
  const row = db.prepare(
    `SELECT record.org_id, record.project_id, record.plane, record.kind,
            record.repository_row_id, record.harness_id, record.current_version,
            record.current_status, record.prompt_eligible, record.shadow_recall_eligible,
            version.content_json, version.applicability_json, version.exceptions_json,
            version.compatibility_json, version.validation_json, version.evidence_json,
            version.evidence_summary_json, version.freshness_json, version.provenance_json,
            version.content_digest
     FROM memory_records AS record
     INNER JOIN memory_record_versions AS version
       ON version.record_id = record.record_id AND version.record_version = ?
     WHERE record.record_id = ?`,
  ).get(input.recordVersion, input.recordId) as Record<string, unknown> | undefined;
  if (!row) throw new MemoryLegacyMigrationConflictError(`Canonical record is missing: ${input.recordId}`);
  if (row.org_id !== input.mapping.org_id || row.project_id !== input.mapping.project_id
      || row.plane !== input.mapping.plane || row.kind !== input.mapping.kind
      || Number(row.current_version) < input.recordVersion) {
    throw new MemoryLegacyMigrationConflictError(`Canonical record metadata mismatch: ${input.recordId}`);
  }
  if (input.mapping.plane === "codebase") {
    const repository = input.requireCurrentActive
      ? db.prepare(
        `SELECT repository_row_id, repository_id, org_id, project_id
         FROM memory_repository_registry
         WHERE org_id = ? AND project_id = ? AND repository_id = ? AND valid_until IS NULL`,
      ).get(
        input.mapping.org_id,
        input.mapping.project_id,
        (input.mapping.applicability as CodebaseApplicabilityV1).repository_id,
      ) as Record<string, unknown> | undefined
      : db.prepare(
        `SELECT repository_row_id, repository_id, org_id, project_id
         FROM memory_repository_registry WHERE repository_row_id = ?`,
      ).get(String(row.repository_row_id)) as Record<string, unknown> | undefined;
    if (!repository || row.repository_row_id !== repository.repository_row_id
        || repository.repository_id !== (input.mapping.applicability as CodebaseApplicabilityV1).repository_id
        || repository.org_id !== input.mapping.org_id || repository.project_id !== input.mapping.project_id
        || row.harness_id !== null) {
      throw new MemoryLegacyMigrationConflictError(`Canonical repository binding mismatch: ${input.recordId}`);
    }
  } else if (input.mapping.plane === "harness") {
    if (row.repository_row_id !== null
        || row.harness_id !== (input.mapping.applicability as HarnessApplicabilityV1).harness_id) {
      throw new MemoryLegacyMigrationConflictError(`Canonical harness binding mismatch: ${input.recordId}`);
    }
  }
  if (input.requireCurrentActive && (Number(row.current_version) !== input.recordVersion
      || row.current_status !== "active")) {
    throw new MemoryLegacyMigrationConflictError(`Canonical record did not activate safely: ${input.recordId}`);
  }
  if (input.requireSafeNewImport && (Number(row.prompt_eligible) !== 0
      || Number(row.shadow_recall_eligible) !== 1)) {
    throw new MemoryLegacyMigrationConflictError(`Imported record exposure state is unsafe: ${input.recordId}`);
  }
  if (!db.prepare(
    `SELECT 1 FROM memory_transitions
     WHERE aggregate_type = 'record' AND aggregate_id = ?
       AND from_status IS NULL AND to_status = 'active'`,
  ).get(input.recordId)) {
    throw new MemoryLegacyMigrationConflictError(`Canonical activation lineage is missing: ${input.recordId}`);
  }
  const fields: Array<[string, unknown]> = [
    ["content_json", input.mapping.content],
    ["applicability_json", input.mapping.applicability],
    ["exceptions_json", input.mapping.exceptions],
    ["compatibility_json", input.mapping.compatibility],
    ["validation_json", input.mapping.validation],
    ["evidence_json", input.mapping.evidence],
    ["evidence_summary_json", input.mapping.evidence_summary],
    ["freshness_json", input.mapping.freshness],
    ["provenance_json", input.provenance],
  ];
  for (const [field, expected] of fields) {
    assertSameJson(JSON.parse(String(row[field])), expected, `${input.recordId}.${field}`);
  }
  if (row.content_digest !== expectedCanonicalContentDigest(input.mapping, input.provenance)) {
    throw new MemoryLegacyMigrationConflictError(`Canonical content digest mismatch: ${input.recordId}`);
  }
}

function importActivePlannedItem(item: PlannedItem, plan: MemoryLegacyMigrationPlan, actorId: string): void {
  const mapping = item.mapping!;
  const provenance = item.reuseExistingCanonical
    ? mapping.provenance
    : provenanceForPlannedItem(item, plan.import_run_id);
  if (!item.canonicalRecordId || !item.canonicalRecordVersion) {
    throw new MemoryLegacyMigrationConflictError(`Active item has no canonical target: ${item.importItemId}`);
  }
  if (item.reuseExistingCanonical) {
    assertCanonicalVersion({
      recordId: item.canonicalRecordId,
      recordVersion: item.canonicalRecordVersion,
      mapping,
      provenance,
      requireCurrentActive: true,
    });
    return;
  }
  let actualId: string;
  let actualVersion: number;
  if (mapping.plane === "codebase") {
    const applicability = mapping.applicability as CodebaseApplicabilityV1;
    const repository = db.prepare(
      `SELECT repository_row_id FROM memory_repository_registry
       WHERE org_id = ? AND project_id = ? AND repository_id = ? AND valid_until IS NULL`,
    ).get(mapping.org_id, mapping.project_id, applicability.repository_id) as {
      repository_row_id: string;
    } | undefined;
    if (!repository) throw new MemoryLegacyMigrationConflictError(`Repository binding disappeared: ${item.importItemId}`);
    const imported = importActiveMemoryRecord({
      orgId: mapping.org_id,
      projectId: mapping.project_id,
      repositoryRowId: repository.repository_row_id,
      recordId: item.canonicalRecordId,
      kind: mapping.kind,
      content: mapping.content,
      applicability,
      exceptions: mapping.exceptions,
      compatibility: mapping.compatibility,
      validation: mapping.validation,
      evidence: mapping.evidence,
      evidenceSummary: mapping.evidence_summary,
      freshness: mapping.freshness,
      provenance,
      validFrom: item.sourceTimestamp ?? mapping.freshness.last_confirmed_at,
      expiresAt: mapping.freshness.expires_at ?? null,
      promptEligible: false,
      actorId,
      actorType: "system",
      reasonCode: "legacy_memory_imported",
      transitionExplanation: "Offline legacy memory cutover imported a checksummed, provenance-complete record.",
      now: plan.created_at,
    });
    actualId = imported.record_id;
    actualVersion = imported.record_version;
  } else if (mapping.plane === "harness") {
    const imported = importActiveHarnessMemoryRecord({
      orgId: mapping.org_id,
      projectId: mapping.project_id,
      recordId: item.canonicalRecordId,
      kind: mapping.kind,
      content: mapping.content,
      applicability: mapping.applicability as HarnessApplicabilityV1,
      exceptions: mapping.exceptions,
      compatibility: mapping.compatibility,
      validation: mapping.validation,
      evidence: mapping.evidence,
      evidenceSummary: mapping.evidence_summary,
      freshness: mapping.freshness,
      provenance,
      actorId,
      decisionRefs: [],
      reasonCode: "legacy_memory_imported",
      explanation: "Offline legacy memory cutover imported a checksummed, provenance-complete harness record.",
      now: plan.created_at,
    });
    actualId = imported.recordId;
    actualVersion = imported.recordVersion;
  } else {
    throw new MemoryLegacyMigrationConflictError("Organization-plane legacy memory cannot be activated automatically");
  }
  if (actualId !== item.canonicalRecordId || actualVersion !== item.canonicalRecordVersion) {
    throw new MemoryLegacyMigrationConflictError(`Canonical import target changed: ${item.importItemId}`);
  }
  assertCanonicalVersion({
    recordId: actualId,
    recordVersion: actualVersion,
    mapping,
    provenance,
    requireCurrentActive: true,
    requireSafeNewImport: true,
  });
}

interface PendingCandidateSeed {
  importItemId: string;
  sourceKind: MemoryLegacySourceKind;
  sourceKey: string;
  contentDigest: string;
  reasonCode: string;
  payload: Record<string, unknown>;
  mapping: MemoryLegacyCanonicalMapping;
}

function pendingProducerRunId(importItemId: string): string {
  return `legacy:${importItemId}`;
}

function pendingCandidate(seed: PendingCandidateSeed, producerRunId: string): MemoryCandidateV1 {
  const confidence = typeof seed.payload.confidence_score === "number"
      && seed.payload.confidence_score >= 0 && seed.payload.confidence_score <= 1
    ? seed.payload.confidence_score
    : 0;
  const extractorVersion = stringValue(seed.mapping.provenance.extractor_version) ?? "legacy-migration/v1";
  const candidate = parseMemoryContract("MemoryCandidateV1", {
    schema_version: "pim.memory-candidate.v1",
    client_candidate_id: seed.importItemId,
    plane: seed.mapping.plane,
    kind: seed.mapping.kind,
    content: seed.mapping.content,
    applicability: seed.mapping.applicability,
    validation: seed.mapping.validation,
    exceptions: seed.mapping.exceptions,
    source_run_ids: [producerRunId],
    evidence_refs: [...new Set(seed.mapping.evidence.map((evidence) => evidence.evidence_ref_id))],
    extraction: { method: "deterministic", extractor_version: extractorVersion, confidence },
    activation_requirement_requested: "verified_merge",
    extensions: {
      legacy_import_item_id: seed.importItemId,
      legacy_source_kind: seed.sourceKind,
      legacy_source_key: seed.sourceKey,
      legacy_source_digest: seed.contentDigest,
      legacy_reason_code: seed.reasonCode,
    },
  });
  const required = deriveActivationRequirement(candidate);
  return required === candidate.activation_requirement_requested
    ? candidate
    : parseMemoryContract("MemoryCandidateV1", {
      ...candidate,
      activation_requirement_requested: required,
    });
}

function pendingIds(importItemId: string): { candidateId: string; receiptId: string; transitionId: string } {
  return {
    candidateId: deterministicId("candidate_legacy", importItemId),
    receiptId: deterministicId("receipt_legacy", importItemId),
    transitionId: deterministicId("transition_legacy", importItemId),
  };
}

function insertPendingPlannedItem(item: PlannedItem, plan: MemoryLegacyMigrationPlan, actorId: string): void {
  const mapping = item.mapping!;
  const candidate = pendingCandidate({
    importItemId: item.importItemId,
    sourceKind: item.sourceKind,
    sourceKey: item.sourceKey,
    contentDigest: item.contentDigest,
    reasonCode: item.reasonCode,
    payload: item.payload,
    mapping,
  }, pendingProducerRunId(item.importItemId));
  const ids = pendingIds(item.importItemId);
  const repository = mapping.plane === "codebase"
    ? db.prepare(
      `SELECT repository_row_id FROM memory_repository_registry
       WHERE org_id = ? AND project_id = ? AND repository_id = ? AND valid_until IS NULL`,
    ).get(
      mapping.org_id,
      mapping.project_id,
      (mapping.applicability as CodebaseApplicabilityV1).repository_id,
    ) as { repository_row_id: string } | undefined
    : undefined;
  if (mapping.plane === "codebase" && !repository) {
    throw new MemoryLegacyMigrationConflictError(`Pending repository binding disappeared: ${item.importItemId}`);
  }
  const repositoryId = mapping.plane === "codebase"
    ? (mapping.applicability as CodebaseApplicabilityV1).repository_id
    : null;
  const baseSha = mapping.plane === "codebase"
    ? (mapping.applicability as CodebaseApplicabilityV1).base_sha ?? null
    : null;
  const candidateDigest = canonicalJsonSha256(candidate);
  const receiptJson = {
    schema_version: "pim.memory-legacy-receipt.v1",
    import_run_id: plan.import_run_id,
    import_item_id: item.importItemId,
    source_digest: item.contentDigest,
  };
  const responseJson = {
    schema_version: "pim.memory-legacy-receipt-result.v1",
    candidate_id: ids.candidateId,
    status: "parked_for_validation",
  };
  db.prepare(
    `INSERT INTO memory_run_receipts
       (receipt_id, org_id, project_id, producer_run_id, schema_major, idempotency_key,
        request_digest, receipt_json, response_json, producer_harness_id,
        repository_row_id, repository_id, base_sha, outcome_status, created_at)
     VALUES (?, ?, ?, ?, 'legacy-migration-v1', NULL, ?, ?, ?, 'pim-legacy-migration',
             ?, ?, ?, 'completed', ?)`,
  ).run(
    ids.receiptId,
    mapping.org_id,
    mapping.project_id,
    pendingProducerRunId(item.importItemId),
    candidateDigest,
    canonicalizeJson(receiptJson),
    canonicalizeJson(responseJson),
    repository?.repository_row_id ?? null,
    repositoryId,
    baseSha,
    plan.created_at,
  );
  const status = mapping.plane === "org" ? "pending_review" : "received";
  const requirement = candidate.activation_requirement_requested;
  const blockers = [...new Set([item.reasonCode, "legacy_reingestion_required",
    requirement === "verified_merge"
      ? "verified_merge_required"
      : requirement === "authorized_review"
        ? "authorized_review_required"
        : "manual_policy_owner_required"])];
  db.prepare(
    `INSERT INTO memory_candidates_v1
       (candidate_id, org_id, project_id, receipt_id, repository_row_id,
        producer_harness_id, client_candidate_id, candidate_digest, candidate_json,
        plane, kind, current_status, aggregate_version, activation_requirement,
        blockers_json, evidence_manifest_row_id, active_record_id, active_record_version,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pim-legacy-migration', ?, ?, ?, ?, ?, ?, 1, ?, ?,
             NULL, NULL, NULL, ?, ?)`,
  ).run(
    ids.candidateId,
    mapping.org_id,
    mapping.project_id,
    ids.receiptId,
    repository?.repository_row_id ?? null,
    item.importItemId,
    candidateDigest,
    canonicalizeJson(candidate),
    mapping.plane,
    mapping.kind,
    status,
    requirement,
    canonicalizeJson(blockers),
    plan.created_at,
    plan.created_at,
  );
  db.prepare(
    `INSERT INTO memory_receipt_candidates
       (receipt_id, candidate_id, client_candidate_id, candidate_digest)
     VALUES (?, ?, ?, ?)`,
  ).run(ids.receiptId, ids.candidateId, item.importItemId, candidateDigest);
  db.prepare(
    `INSERT INTO memory_transitions
       (transition_id, org_id, project_id, aggregate_type, aggregate_id, from_status,
        to_status, actor_type, actor_id, reason_code, explanation, evidence_refs_json,
        decision_refs_json, policy_version, occurred_at, committed_at)
     VALUES (?, ?, ?, 'candidate', ?, NULL, ?, 'system', ?, ?, ?, ?, '[]',
             'memory-legacy-migration-v1', ?, ?)`,
  ).run(
    ids.transitionId,
    mapping.org_id,
    mapping.project_id,
    ids.candidateId,
    status,
    actorId,
    item.reasonCode,
    "Legacy memory was preserved as a parked candidate and requires the canonical activation gate.",
    canonicalizeJson(candidate.evidence_refs),
    plan.created_at,
    plan.created_at,
  );
}

function insertLegacyImportItem(item: PlannedItem, importRunId: string, createdAt: string): void {
  db.prepare(
    `INSERT INTO memory_legacy_import_items
       (import_item_id, import_run_id, source_kind, source_key, legacy_id,
        legacy_node_id, org_id, project_id, plane, graph_version, snapshot_sha256,
        content_digest, source_timestamp, source_payload_json, source_provenance_json,
        mapped_payload_json, disposition, reason_code, canonical_record_id,
        canonical_record_version, duplicate_of_item_id, supersedes_legacy_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    item.importItemId,
    importRunId,
    item.sourceKind,
    item.sourceKey,
    item.legacyId,
    item.legacyNodeId,
    item.orgId,
    item.projectId,
    item.plane,
    item.graphVersion,
    item.snapshotSha256,
    item.contentDigest,
    item.sourceTimestamp,
    canonicalizeJson(item.payload),
    canonicalizeJson(item.provenance),
    item.mapping ? canonicalizeJson(item.mapping) : null,
    item.disposition,
    item.reasonCode,
    item.canonicalRecordId,
    item.canonicalRecordVersion,
    item.duplicateOfItemId,
    item.supersedesLegacyId,
    createdAt,
  );
}

interface LegacyImportItemRow extends Record<string, unknown> {
  import_item_id: string;
  import_run_id: string;
  source_kind: MemoryLegacySourceKind;
  source_key: string;
  legacy_id: string;
  legacy_node_id: string | null;
  org_id: string;
  project_id: string | null;
  plane: MemoryPlane | null;
  graph_version: number | null;
  snapshot_sha256: string | null;
  content_digest: string;
  source_timestamp: string | null;
  source_payload_json: string;
  source_provenance_json: string;
  mapped_payload_json: string | null;
  disposition: MemoryLegacyDisposition;
  reason_code: string;
  canonical_record_id: string | null;
  canonical_record_version: number | null;
  duplicate_of_item_id: string | null;
  supersedes_legacy_id: string | null;
  created_at: string;
}

export function reconcileMemoryLegacyMigration(importRunId: string): MemoryLegacyMigrationReport {
  const row = db.prepare("SELECT * FROM memory_legacy_import_runs WHERE import_run_id = ?").get(importRunId) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw new MemoryLegacyMigrationInputError(`Unknown memory legacy import run: ${importRunId}`);
  const report = JSON.parse(String(row.report_json)) as MemoryLegacyMigrationReport;
  if (report.schema_version !== "pim.memory-legacy-migration-report.v1"
      || report.import_run_id !== importRunId || report.authority !== "canonical") {
    throw new MemoryLegacyMigrationConflictError("Stored legacy migration report identity is invalid");
  }
  const runFields: Array<[keyof MemoryLegacyMigrationReport, string]> = [
    ["inventory_digest", "inventory_digest"],
    ["resolution_digest", "resolution_digest"],
    ["source_bundle_digest", "source_bundle_digest"],
    ["source_item_count", "source_item_count"],
    ["imported_count", "imported_count"],
    ["pending_count", "pending_count"],
    ["quarantined_count", "quarantined_count"],
    ["deduplicated_count", "deduplicated_count"],
    ["created_at", "created_at"],
  ];
  for (const [reportField, rowField] of runFields) {
    if (String(report[reportField]) !== String(row[rowField])) {
      throw new MemoryLegacyMigrationConflictError(`Stored run metadata mismatch for ${rowField}`);
    }
  }
  const ledger = db.prepare(
    `SELECT * FROM memory_legacy_import_items
     WHERE import_run_id = ? ORDER BY source_kind, source_key`,
  ).all(importRunId) as unknown as LegacyImportItemRow[];
  const reportItems = new Map(report.items.map((item) => [item.import_item_id, item]));
  if (reportItems.size !== ledger.length) {
    throw new MemoryLegacyMigrationConflictError("Stored report item coverage does not match the immutable ledger");
  }
  const erasedLegacyItemIds = new Set<string>();
  if (tableExists("memory_erasure_tombstones")) {
    const erasedRows = db.prepare(
      `SELECT DISTINCT tombstone.resource_id
       FROM memory_erasure_tombstones AS tombstone
       JOIN memory_erasure_events AS event ON event.request_id = tombstone.request_id
       WHERE tombstone.resource_class = 'legacy_import'
         AND tombstone.erasure_method = 'field_redaction'
         AND event.state = 'primary_erased'`,
    ).all() as Array<{ resource_id: string }>;
    for (const erased of erasedRows) erasedLegacyItemIds.add(erased.resource_id);
  }
  const counts = new Map<MemoryLegacyDisposition, number>();
  for (const item of ledger) {
    const disposition = erasedLegacyItemIds.has(item.import_item_id)
      ? reportItems.get(item.import_item_id)?.disposition
      : item.disposition;
    if (!disposition) {
      throw new MemoryLegacyMigrationConflictError(`Ledger item is absent from report: ${item.import_item_id}`);
    }
    counts.set(disposition, (counts.get(disposition) ?? 0) + 1);
  }
  const expected = {
    active: Number(row.imported_count),
    pending_validation: Number(row.pending_count),
    quarantined: Number(row.quarantined_count),
    deduplicated: Number(row.deduplicated_count),
  };
  for (const [disposition, count] of Object.entries(expected)) {
    if ((counts.get(disposition as MemoryLegacyDisposition) ?? 0) !== count) {
      throw new MemoryLegacyMigrationConflictError(`Reconciliation count mismatch for ${disposition}`);
    }
  }
  const sourceCount = [...counts.values()].reduce((sum, value) => sum + value, 0);
  if (sourceCount !== Number(row.source_item_count)) {
    throw new MemoryLegacyMigrationConflictError("Reconciliation source coverage equation failed");
  }
  const ledgerById = new Map(ledger.map((item) => [item.import_item_id, item]));
  for (const item of ledger) {
    const reported = reportItems.get(item.import_item_id);
    if (!reported) throw new MemoryLegacyMigrationConflictError(`Ledger item is absent from report: ${item.import_item_id}`);
    if (erasedLegacyItemIds.has(item.import_item_id)) {
      if (reported.source_kind !== item.source_kind
          || reported.source_key !== item.source_key
          || reported.legacy_id !== item.legacy_id) {
        throw new MemoryLegacyMigrationConflictError(`Redacted ledger identity mismatch: ${item.import_item_id}`);
      }
      if (item.source_payload_json !== "{}" || item.source_provenance_json !== "{}"
          || item.mapped_payload_json !== null || item.disposition !== "quarantined"
          || item.reason_code !== "erased_by_policy" || item.canonical_record_id !== null
          || item.canonical_record_version !== null || item.duplicate_of_item_id !== null) {
        throw new MemoryLegacyMigrationConflictError(`Legacy erasure overlay mismatch: ${item.import_item_id}`);
      }
      continue;
    }
    const expectedReported: MemoryLegacyMigrationReportItem = {
      import_item_id: item.import_item_id,
      source_kind: item.source_kind,
      source_key: item.source_key,
      legacy_id: item.legacy_id,
      disposition: item.disposition,
      reason_code: item.reason_code,
      ...(item.canonical_record_id ? {
        canonical_record_id: item.canonical_record_id,
        canonical_record_version: Number(item.canonical_record_version),
      } : {}),
      ...(item.duplicate_of_item_id ? { duplicate_of_item_id: item.duplicate_of_item_id } : {}),
    };
    assertSameJson(reported, expectedReported, `${item.import_item_id}.report_item`);
    const payload = JSON.parse(item.source_payload_json) as Record<string, unknown>;
    if (canonicalJsonSha256(payload) !== item.content_digest) {
      throw new MemoryLegacyMigrationConflictError(`Source payload digest mismatch: ${item.import_item_id}`);
    }
    if (item.disposition === "active") {
      const mapping = JSON.parse(String(item.mapped_payload_json)) as MemoryLegacyCanonicalMapping;
      const importedProvenance = canonicalImportProvenance(mapping.provenance, {
        importRunId,
        importItemId: item.import_item_id,
        sourceKind: item.source_kind,
        sourceKey: item.source_key,
        legacyId: item.legacy_id,
        legacyNodeId: item.legacy_node_id,
        contentDigest: item.content_digest,
        graphVersion: item.graph_version === null ? null : Number(item.graph_version),
        snapshotSha256: item.snapshot_sha256,
        sourceTimestamp: item.source_timestamp,
        supersedesLegacyId: item.supersedes_legacy_id,
      });
      const storedVersion = db.prepare(
        `SELECT 1 AS present FROM memory_record_versions
         WHERE record_id = ? AND record_version = ?`,
      ).get(item.canonical_record_id, item.canonical_record_version) as {
        present: number;
      } | undefined;
      if (!storedVersion) {
        throw new MemoryLegacyMigrationConflictError(`Canonical version is missing: ${item.import_item_id}`);
      }
      const importTransition = db.prepare(
        `SELECT 1 FROM memory_transitions
         WHERE aggregate_type = 'record' AND aggregate_id = ?
           AND from_status IS NULL AND to_status = 'active'
           AND reason_code = 'legacy_memory_imported' AND committed_at = ?`,
      ).get(item.canonical_record_id, report.created_at);
      const provenance = importTransition ? importedProvenance : mapping.provenance;
      assertCanonicalVersion({
        recordId: String(item.canonical_record_id),
        recordVersion: Number(item.canonical_record_version),
        mapping,
        provenance,
      });
    } else if (item.disposition === "pending_validation") {
      const mapping = JSON.parse(String(item.mapped_payload_json)) as MemoryLegacyCanonicalMapping;
      const candidate = pendingCandidate({
        importItemId: item.import_item_id,
        sourceKind: item.source_kind,
        sourceKey: item.source_key,
        contentDigest: item.content_digest,
        reasonCode: item.reason_code,
        payload,
        mapping,
      }, pendingProducerRunId(item.import_item_id));
      const ids = pendingIds(item.import_item_id);
      const candidateRow = db.prepare(
        `SELECT org_id, project_id, receipt_id, repository_row_id, producer_harness_id,
                client_candidate_id, candidate_json, candidate_digest, plane, kind,
                current_status, aggregate_version, activation_requirement, blockers_json,
                active_record_id, active_record_version
         FROM memory_candidates_v1 WHERE candidate_id = ?`,
      ).get(ids.candidateId) as Record<string, unknown> | undefined;
      if (!candidateRow) throw new MemoryLegacyMigrationConflictError(`Pending candidate is missing: ${ids.candidateId}`);
      const expectedStatus = mapping.plane === "org" ? "pending_review" : "received";
      if (candidateRow.org_id !== mapping.org_id || candidateRow.project_id !== mapping.project_id
          || candidateRow.producer_harness_id !== "pim-legacy-migration"
          || candidateRow.client_candidate_id !== item.import_item_id
          || candidateRow.candidate_digest !== canonicalJsonSha256(candidate)
          || candidateRow.plane !== mapping.plane || candidateRow.kind !== mapping.kind
          || Number(candidateRow.aggregate_version) < 1
          || candidateRow.activation_requirement !== candidate.activation_requirement_requested
          || candidateRow.receipt_id !== ids.receiptId) {
        throw new MemoryLegacyMigrationConflictError(`Pending candidate metadata mismatch: ${ids.candidateId}`);
      }
      const blockers = JSON.parse(String(candidateRow.blockers_json)) as unknown;
      if (candidateRow.current_status === expectedStatus) {
        if (Number(candidateRow.aggregate_version) !== 1 || !Array.isArray(blockers)
            || !blockers.includes("legacy_reingestion_required")
            || candidateRow.active_record_id !== null || candidateRow.active_record_version !== null) {
          throw new MemoryLegacyMigrationConflictError(`Parked candidate state mismatch: ${ids.candidateId}`);
        }
      } else if (Number(candidateRow.aggregate_version) <= 1 || !db.prepare(
        `SELECT 1 FROM memory_transitions
         WHERE aggregate_type = 'candidate' AND aggregate_id = ? AND from_status = ?`,
      ).get(ids.candidateId, expectedStatus)) {
        throw new MemoryLegacyMigrationConflictError(`Candidate lifecycle lineage mismatch: ${ids.candidateId}`);
      }
      assertSameJson(JSON.parse(String(candidateRow.candidate_json)), candidate, `${ids.candidateId}.candidate_json`);
      const repositoryId = mapping.plane === "codebase"
        ? (mapping.applicability as CodebaseApplicabilityV1).repository_id
        : null;
      const baseSha = mapping.plane === "codebase"
        ? (mapping.applicability as CodebaseApplicabilityV1).base_sha ?? null
        : null;
      if (mapping.plane === "codebase") {
        const repository = db.prepare(
          `SELECT org_id, project_id, repository_id FROM memory_repository_registry
           WHERE repository_row_id = ?`,
        ).get(String(candidateRow.repository_row_id)) as Record<string, unknown> | undefined;
        if (!repository || repository.org_id !== mapping.org_id || repository.project_id !== mapping.project_id
            || repository.repository_id !== repositoryId) {
          throw new MemoryLegacyMigrationConflictError(`Pending repository binding mismatch: ${ids.candidateId}`);
        }
      } else if (candidateRow.repository_row_id !== null) {
        throw new MemoryLegacyMigrationConflictError(`Non-codebase candidate has a repository binding: ${ids.candidateId}`);
      }
      const receipt = db.prepare(
        `SELECT org_id, project_id, producer_run_id, schema_major, request_digest,
                receipt_json, producer_harness_id, repository_row_id, repository_id,
                base_sha, outcome_status
         FROM memory_run_receipts WHERE receipt_id = ?`,
      ).get(ids.receiptId) as Record<string, unknown> | undefined;
      const expectedReceipt = {
        schema_version: "pim.memory-legacy-receipt.v1",
        import_run_id: importRunId,
        import_item_id: item.import_item_id,
        source_digest: item.content_digest,
      };
      if (!receipt || receipt.org_id !== mapping.org_id || receipt.project_id !== mapping.project_id
          || receipt.producer_run_id !== pendingProducerRunId(item.import_item_id)
          || receipt.schema_major !== "legacy-migration-v1"
          || receipt.request_digest !== canonicalJsonSha256(candidate)
          || receipt.producer_harness_id !== "pim-legacy-migration"
          || receipt.repository_row_id !== candidateRow.repository_row_id
          || receipt.repository_id !== repositoryId || receipt.base_sha !== baseSha
          || receipt.outcome_status !== "completed") {
        throw new MemoryLegacyMigrationConflictError(`Pending receipt metadata mismatch: ${ids.receiptId}`);
      }
      assertSameJson(JSON.parse(String(receipt.receipt_json)), expectedReceipt, `${ids.receiptId}.receipt_json`);
      const receiptLink = db.prepare(
        `SELECT candidate_digest FROM memory_receipt_candidates
         WHERE receipt_id = ? AND candidate_id = ? AND client_candidate_id = ?`,
      ).get(ids.receiptId, ids.candidateId, item.import_item_id) as {
        candidate_digest: string;
      } | undefined;
      const transition = db.prepare(
        `SELECT 1 FROM memory_transitions
         WHERE transition_id = ? AND aggregate_type = 'candidate' AND aggregate_id = ?
           AND from_status IS NULL AND to_status = ?`,
      ).get(ids.transitionId, ids.candidateId, expectedStatus);
      if (!receiptLink || receiptLink.candidate_digest !== canonicalJsonSha256(candidate) || !transition) {
        throw new MemoryLegacyMigrationConflictError(`Pending candidate lineage mismatch: ${ids.candidateId}`);
      }
    } else if (item.disposition === "deduplicated") {
      const target = item.duplicate_of_item_id ? ledgerById.get(item.duplicate_of_item_id) : undefined;
      if (!target || target.import_run_id !== importRunId
          || !["active", "pending_validation"].includes(target.disposition)) {
        throw new MemoryLegacyMigrationConflictError(`Invalid duplicate target: ${item.import_item_id}`);
      }
      assertSameJson(
        JSON.parse(String(item.mapped_payload_json)),
        JSON.parse(String(target.mapped_payload_json)),
        `${item.import_item_id}.duplicate_mapping`,
      );
    }
  }
  const transitions = db.prepare(
    `SELECT revision, from_authority, to_authority, legacy_writes_frozen, import_run_id
     FROM memory_authority_transitions ORDER BY revision`,
  ).all() as Array<Record<string, unknown>>;
  const expectedTransitions = [
    { revision: 1, from_authority: "legacy", to_authority: "migration_locked", legacy_writes_frozen: 1, import_run_id: importRunId },
    { revision: 2, from_authority: "migration_locked", to_authority: "canonical", legacy_writes_frozen: 1, import_run_id: importRunId },
  ];
  assertSameJson(transitions, expectedTransitions, "memory_authority_transitions");
  const authority = getMemoryAuthorityState();
  if (authority.authority !== "canonical" || !authority.legacyWritesFrozen || authority.revision !== 2) {
    throw new MemoryLegacyMigrationConflictError("Canonical authority reconciliation failed");
  }
  const barrierNames: Array<[string, string]> = [
    ["memory_candidates", "memory_candidates_legacy_authority_no_insert"],
    ["memory_candidates", "memory_candidates_legacy_authority_no_update"],
    ["memory_candidates", "memory_candidates_legacy_authority_no_delete"],
    ["project_memory_candidates", "project_memory_candidates_legacy_authority_no_insert"],
    ["project_memory_candidates", "project_memory_candidates_legacy_authority_no_update"],
    ["project_memory_candidates", "project_memory_candidates_legacy_authority_no_delete"],
    ["project_evidence_items", "project_evidence_items_legacy_authority_no_promoted_insert"],
    ["project_evidence_items", "project_evidence_items_legacy_authority_no_promoted_update"],
  ];
  for (const [table, trigger] of barrierNames) {
    if (tableExists(table) && !db.prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'trigger' AND name = ?",
    ).get(trigger)) {
      throw new MemoryLegacyMigrationConflictError(`Legacy write barrier is missing for ${table}`);
    }
  }
  const foreignKeyIssues = db.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyIssues.length > 0) throw new MemoryLegacyMigrationConflictError("Legacy cutover foreign-key reconciliation failed");
  return report;
}

interface DualReadCanonicalRow {
  record_id: string;
  org_id: string;
  project_id: string;
  plane: MemoryPlane;
  current_version: number;
  current_status: string;
  claim_key: string;
}

function mappedCanonicalClaimKey(mapping: MemoryLegacyCanonicalMapping): string {
  if (mapping.plane === "codebase") {
    return canonicalMemoryClaimKey({
      kind: mapping.kind,
      content: mapping.content,
      applicability: mapping.applicability as CodebaseApplicabilityV1,
      provenance: mapping.provenance,
    });
  }
  if (mapping.plane === "harness") {
    return canonicalHarnessMemoryClaimKey({
      kind: mapping.kind,
      content: mapping.content,
      applicability: mapping.applicability as HarnessApplicabilityV1,
      provenance: mapping.provenance,
    });
  }
  throw new MemoryLegacyMigrationConflictError(
    "Organization-plane legacy memory cannot participate in active dual-read comparison",
  );
}

function scopedLogicalMemoryKey(input: {
  orgId: string;
  projectId: string;
  plane: MemoryPlane;
  claimKey: string;
}): string {
  return canonicalJsonSha256({
    org_id: input.orgId,
    project_id: input.projectId,
    plane: input.plane,
    claim_key: input.claimKey,
  });
}

/**
 * Read-only cutover proof. It combines active legacy projections from the
 * immutable import ledger with canonical records, then emits one item per
 * scoped canonical claim. Canonical lifecycle state wins, so a later stale or
 * revoked record cannot be resurrected by the legacy projection.
 */
export function compareMemoryLegacyDualRead(importRunId: string): MemoryLegacyDualReadReport {
  reconcileMemoryLegacyMigration(importRunId);
  const ledger = db.prepare(
    `SELECT * FROM memory_legacy_import_items
     WHERE import_run_id = ? ORDER BY source_kind, source_key`,
  ).all(importRunId) as unknown as LegacyImportItemRow[];
  const ledgerById = new Map(ledger.map((item) => [item.import_item_id, item]));
  const activeTargets = ledger.filter((item) => item.disposition === "active");
  const scopeKeys = new Set(activeTargets.map((item) => {
    const mapping = JSON.parse(String(item.mapped_payload_json)) as MemoryLegacyCanonicalMapping;
    return `${mapping.org_id}\0${mapping.project_id}`;
  }));
  const canonicalRows = (db.prepare(
    `SELECT record_id, org_id, project_id, plane, current_version, current_status, claim_key
     FROM memory_records ORDER BY org_id, project_id, plane, claim_key, record_id`,
  ).all() as unknown as DualReadCanonicalRow[])
    .filter((row) => scopeKeys.has(`${row.org_id}\0${row.project_id}`));
  const canonicalById = new Map(canonicalRows.map((row) => [row.record_id, row]));

  interface CombinedItem {
    logicalMemoryKey: string;
    orgId: string;
    projectId: string;
    plane: MemoryPlane;
    canonical: DualReadCanonicalRow | null;
    legacyImportItemIds: string[];
  }
  const combined = new Map<string, CombinedItem>();
  const getCombined = (input: {
    orgId: string;
    projectId: string;
    plane: MemoryPlane;
    claimKey: string;
  }): CombinedItem => {
    const logicalMemoryKey = scopedLogicalMemoryKey(input);
    const existing = combined.get(logicalMemoryKey);
    if (existing) return existing;
    const created: CombinedItem = {
      logicalMemoryKey,
      orgId: input.orgId,
      projectId: input.projectId,
      plane: input.plane,
      canonical: null,
      legacyImportItemIds: [],
    };
    combined.set(logicalMemoryKey, created);
    return created;
  };

  let canonicalProjectionCount = 0;
  for (const row of canonicalRows.filter((candidate) => candidate.current_status === "active")) {
    const item = getCombined({
      orgId: row.org_id,
      projectId: row.project_id,
      plane: row.plane,
      claimKey: row.claim_key,
    });
    if (item.canonical && item.canonical.record_id !== row.record_id) {
      throw new MemoryLegacyMigrationConflictError(
        `Canonical dual-read claim is not unique: ${item.logicalMemoryKey}`,
      );
    }
    item.canonical = row;
    canonicalProjectionCount++;
  }

  let legacyProjectionCount = 0;
  for (const item of ledger) {
    const target = item.disposition === "active"
      ? item
      : item.disposition === "deduplicated" && item.duplicate_of_item_id
        ? ledgerById.get(item.duplicate_of_item_id)
        : undefined;
    if (!target || target.disposition !== "active") continue;
    const mapping = JSON.parse(String(item.mapped_payload_json)) as MemoryLegacyCanonicalMapping;
    const claimKey = mappedCanonicalClaimKey(mapping);
    const canonical = target.canonical_record_id
      ? canonicalById.get(target.canonical_record_id)
      : undefined;
    if (!canonical || canonical.org_id !== mapping.org_id
        || canonical.project_id !== mapping.project_id || canonical.plane !== mapping.plane
        || canonical.claim_key !== claimKey
        || Number(target.canonical_record_version) > Number(canonical.current_version)) {
      throw new MemoryLegacyMigrationConflictError(
        `Legacy projection does not resolve to its canonical claim: ${item.import_item_id}`,
      );
    }
    const merged = getCombined({
      orgId: mapping.org_id,
      projectId: mapping.project_id,
      plane: mapping.plane,
      claimKey,
    });
    merged.legacyImportItemIds.push(item.import_item_id);
    legacyProjectionCount++;
  }

  const items: MemoryLegacyDualReadItem[] = [];
  let deduplicatedCount = 0;
  let suppressedInactiveLegacyCount = 0;
  for (const item of combined.values()) {
    item.legacyImportItemIds.sort();
    if (!item.canonical) {
      suppressedInactiveLegacyCount += item.legacyImportItemIds.length;
      continue;
    }
    deduplicatedCount += item.legacyImportItemIds.length;
    items.push({
      logical_memory_key: item.logicalMemoryKey,
      org_id: item.orgId,
      project_id: item.projectId,
      plane: item.plane,
      canonical_record_id: item.canonical.record_id,
      canonical_record_version: Number(item.canonical.current_version),
      legacy_import_item_ids: item.legacyImportItemIds,
      selected_authority: "canonical",
    });
  }
  items.sort((left, right) => left.logical_memory_key.localeCompare(right.logical_memory_key));
  if (new Set(items.map((item) => item.logical_memory_key)).size !== items.length) {
    throw new MemoryLegacyMigrationConflictError("Dual-read comparison returned a logical memory more than once");
  }
  const combinedProjectionCount = legacyProjectionCount + canonicalProjectionCount;
  if (items.length + deduplicatedCount + suppressedInactiveLegacyCount !== combinedProjectionCount) {
    throw new MemoryLegacyMigrationConflictError("Dual-read comparison coverage equation failed");
  }
  return {
    schema_version: "pim.memory-legacy-dual-read-report.v1",
    import_run_id: importRunId,
    legacy_projection_count: legacyProjectionCount,
    canonical_projection_count: canonicalProjectionCount,
    combined_projection_count: combinedProjectionCount,
    returned_count: items.length,
    deduplicated_count: deduplicatedCount,
    suppressed_inactive_legacy_count: suppressedInactiveLegacyCount,
    items,
  };
}

export function applyMemoryLegacyMigration(input: MemoryLegacyMigrationInput): MemoryLegacyMigrationReport {
  const replayRunId = artifactImportRunId(input);
  if (db.prepare("SELECT 1 FROM memory_legacy_import_runs WHERE import_run_id = ?").get(replayRunId)) {
    return reconcileMemoryLegacyMigration(replayRunId);
  }
  const state = getMemoryAuthorityState();
  if (state.authority !== "legacy" || state.legacyWritesFrozen || state.revision !== 0) {
    throw new MemoryLegacyMigrationConflictError(
      `Memory authority is ${state.authority} at revision ${state.revision}; only an exact completed run can replay`,
    );
  }
  const plan = buildPlan(input, true);
  const actorId = input.actorId ?? "pim-memory-offline-migration";
  if (!stringValue(actorId)) throw new MemoryLegacyMigrationInputError("actorId must be non-empty");
  return withImmediateTransaction(() => {
    const lockedState = getMemoryAuthorityState();
    if (lockedState.authority !== "legacy" || lockedState.legacyWritesFrozen || lockedState.revision !== 0) {
      throw new MemoryLegacyMigrationConflictError("Memory authority changed before the cutover lock was acquired");
    }
    const lockedPlan = buildPlan(input, true);
    assertSameJson({
      import_run_id: lockedPlan.import_run_id,
      inventory_digest: lockedPlan.inventory_digest,
      resolution_digest: lockedPlan.resolution_digest,
      source_bundle_digest: lockedPlan.source_bundle_digest,
      items: lockedPlan.items,
    }, {
      import_run_id: plan.import_run_id,
      inventory_digest: plan.inventory_digest,
      resolution_digest: plan.resolution_digest,
      source_bundle_digest: plan.source_bundle_digest,
      items: plan.items,
    }, "locked migration plan");
    const finalReport = reportFromPlan(plan, "canonical");
    db.prepare(
      `INSERT INTO memory_legacy_import_runs
         (import_run_id, inventory_digest, resolution_digest, source_bundle_digest,
          source_item_count, imported_count, pending_count, quarantined_count,
          deduplicated_count, report_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      plan.import_run_id,
      plan.inventory_digest,
      plan.resolution_digest,
      plan.source_bundle_digest,
      plan.source_item_count,
      plan.imported_count,
      plan.pending_count,
      plan.quarantined_count,
      plan.deduplicated_count,
      canonicalizeJson(finalReport),
      plan.created_at,
    );
    db.prepare(
      `INSERT INTO memory_authority_transitions
         (transition_id, revision, from_authority, to_authority, legacy_writes_frozen,
          import_run_id, actor_id, reason_code, occurred_at)
       VALUES (?, 1, 'legacy', 'migration_locked', 1, ?, ?, 'offline_cutover_started', ?)`,
    ).run(
      deterministicId("authority_transition", { importRunId: plan.import_run_id, revision: 1 }),
      plan.import_run_id,
      actorId,
      plan.created_at,
    );
    installLegacySqlWriteBarriers();
    for (const item of plan.planned_items.filter((candidate) => candidate.disposition === "active")) {
      importActivePlannedItem(item, plan, actorId);
    }
    for (const item of plan.planned_items.filter((candidate) => candidate.disposition === "pending_validation")) {
      insertPendingPlannedItem(item, plan, actorId);
    }
    for (const item of plan.planned_items.filter((candidate) => candidate.disposition !== "deduplicated")) {
      insertLegacyImportItem(item, plan.import_run_id, plan.created_at);
    }
    for (const item of plan.planned_items.filter((candidate) => candidate.disposition === "deduplicated")) {
      insertLegacyImportItem(item, plan.import_run_id, plan.created_at);
    }
    db.prepare(
      `INSERT INTO memory_authority_transitions
         (transition_id, revision, from_authority, to_authority, legacy_writes_frozen,
          import_run_id, actor_id, reason_code, occurred_at)
       VALUES (?, 2, 'migration_locked', 'canonical', 1, ?, ?, 'offline_cutover_reconciled', ?)`,
    ).run(
      deterministicId("authority_transition", { importRunId: plan.import_run_id, revision: 2 }),
      plan.import_run_id,
      actorId,
      plan.created_at,
    );
    const foreignKeyIssues = db.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeyIssues.length > 0) {
      throw new MemoryLegacyMigrationConflictError("Foreign-key reconciliation failed before canonical cutover");
    }
    return reconcileMemoryLegacyMigration(plan.import_run_id);
  });
}
