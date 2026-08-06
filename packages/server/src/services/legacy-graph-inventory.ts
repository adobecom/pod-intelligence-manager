import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const TOOL_VERSION = "legacy-graph-inventory/v1";
const GRAPH_FILE_PATTERN = /^graph-(latest|v(\d+))\.json$/;

type JsonObject = Record<string, unknown>;

export type SnapshotIssueCode =
  | "invalid_json"
  | "invalid_graph"
  | "invalid_node"
  | "invalid_edge"
  | "org_directory_mismatch"
  | "version_filename_mismatch"
  | "duplicate_node_id"
  | "dangling_edge"
  | "missing_supersession_target"
  | "missing_provenance_node";

export interface SnapshotIssue {
  code: SnapshotIssueCode;
  subjectId?: string;
  message: string;
}

export interface GraphSnapshotInventory {
  root: string;
  path: string;
  directoryOrgId: string;
  kind: "latest" | "version";
  filenameVersion: number | null;
  orgId: string | null;
  graphVersion: number | null;
  sha256: string;
  contentSha256: string | null;
  counts: {
    nodes: number;
    edges: number;
    communities: number;
  };
  issues: SnapshotIssue[];
}

export interface LayoutComparison {
  orgId: string;
  left: LayoutIdentity;
  right: LayoutIdentity;
  identical: boolean;
  sameIdSameContent: string[];
  sameIdDifferentContent: string[];
  leftOnlyNodeIds: string[];
  rightOnlyNodeIds: string[];
  sameContentDifferentIds: Array<{
    contentSha256: string;
    leftNodeIds: string[];
    rightNodeIds: string[];
  }>;
}

export interface LayoutIdentity {
  root: string;
  path: string;
  version: number | null;
  sha256: string;
  contentSha256: string;
}

export type ReferenceClassification =
  | "promoted_without_pointer"
  | "pointer_missing_all_layouts"
  | "pointer_resolves_one_layout"
  | "pointer_resolves_multiple_same"
  | "pointer_resolves_multiple_conflicting";

export interface LegacyReferenceInventory {
  source: "project_memory_candidate" | "project_evidence_item" | "memory_candidate";
  recordId: string;
  orgId: string | null;
  status: string | null;
  promotedNodeId: string | null;
  classification: ReferenceClassification;
  resolutions: Array<{
    root: string;
    path: string;
    nodeContentSha256: string;
  }>;
}

export interface DatabaseIssue {
  code: "missing_column" | "invalid_row" | "evidence_row_missing" | "candidate_evidence_pointer_mismatch";
  table: string;
  recordId?: string;
  message: string;
}

export interface LegacyGraphInventoryReport {
  toolVersion: typeof TOOL_VERSION;
  database: {
    path: string;
    sha256: string;
    inspectedTables: string[];
    missingTables: string[];
    issues: DatabaseIssue[];
  };
  graphRoots: string[];
  snapshots: GraphSnapshotInventory[];
  layoutComparisons: LayoutComparison[];
  references: LegacyReferenceInventory[];
}

export interface LegacyGraphInventoryOptions {
  dbPath: string;
  graphRoots: string[];
}

interface ParsedSnapshot {
  report: GraphSnapshotInventory;
  graph: JsonObject | null;
  nodes: NodeInventory[];
}

interface NodeInventory {
  id: string;
  contentSha256: string;
}

interface CandidateRow {
  id: string;
  orgId: string | null;
  status: string | null;
  promotedNodeId: string | null;
  evidenceItemId?: string | null;
}

interface EvidenceRow {
  id: string;
  orgId: string | null;
  promotedNodeId: string | null;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function compareIssues(left: SnapshotIssue, right: SnapshotIssue): number {
  return (
    left.code.localeCompare(right.code) ||
    (left.subjectId ?? "").localeCompare(right.subjectId ?? "") ||
    left.message.localeCompare(right.message)
  );
}

function parseSnapshot(root: string, directoryOrgId: string, filePath: string): ParsedSnapshot {
  const basename = path.basename(filePath);
  const match = GRAPH_FILE_PATTERN.exec(basename);
  if (!match) throw new Error(`Unsupported graph filename: ${filePath}`);

  const bytes = fs.readFileSync(filePath);
  const issues: SnapshotIssue[] = [];
  const kind = match[1] === "latest" ? "latest" : "version";
  const filenameVersion = match[2] === undefined ? null : Number(match[2]);
  let parsed: unknown;

  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    issues.push({
      code: "invalid_json",
      message: error instanceof Error ? error.message : "Graph file is not valid JSON",
    });
    return {
      graph: null,
      nodes: [],
      report: {
        root,
        path: filePath,
        directoryOrgId,
        kind,
        filenameVersion,
        orgId: null,
        graphVersion: null,
        sha256: sha256(bytes),
        contentSha256: null,
        counts: { nodes: 0, edges: 0, communities: 0 },
        issues,
      },
    };
  }

  if (!isObject(parsed)) {
    issues.push({ code: "invalid_graph", message: "Graph document must be a JSON object" });
  }

  const graph = isObject(parsed) ? parsed : null;
  const orgId = normalizeNullableString(graph?.org_id);
  const graphVersion = typeof graph?.version === "number" && Number.isFinite(graph.version)
    ? graph.version
    : null;
  const rawNodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const rawEdges = Array.isArray(graph?.edges) ? graph.edges : [];
  const rawCommunities = Array.isArray(graph?.communities) ? graph.communities : [];

  if (graph) {
    if (!orgId) issues.push({ code: "invalid_graph", message: "Graph org_id must be a non-empty string" });
    if (graphVersion === null) issues.push({ code: "invalid_graph", message: "Graph version must be a finite number" });
    if (!Array.isArray(graph.nodes)) issues.push({ code: "invalid_graph", message: "Graph nodes must be an array" });
    if (!Array.isArray(graph.edges)) issues.push({ code: "invalid_graph", message: "Graph edges must be an array" });
    if (!Array.isArray(graph.communities)) issues.push({ code: "invalid_graph", message: "Graph communities must be an array" });
  }
  if (orgId && orgId !== directoryOrgId) {
    issues.push({
      code: "org_directory_mismatch",
      subjectId: orgId,
      message: `Graph org_id ${orgId} does not match directory ${directoryOrgId}`,
    });
  }
  if (filenameVersion !== null && graphVersion !== null && filenameVersion !== graphVersion) {
    issues.push({
      code: "version_filename_mismatch",
      subjectId: String(graphVersion),
      message: `Graph version ${graphVersion} does not match filename version ${filenameVersion}`,
    });
  }

  const nodes: NodeInventory[] = [];
  const nodeIds = new Set<string>();
  for (const [index, value] of rawNodes.entries()) {
    if (!isObject(value) || typeof value.id !== "string" || value.id.length === 0) {
      issues.push({
        code: "invalid_node",
        subjectId: String(index),
        message: `Node at index ${index} must be an object with a non-empty id`,
      });
      continue;
    }
    if (nodeIds.has(value.id)) {
      issues.push({
        code: "duplicate_node_id",
        subjectId: value.id,
        message: `Node id ${value.id} appears more than once`,
      });
    }
    nodeIds.add(value.id);
    const { id: _id, ...content } = value;
    nodes.push({ id: value.id, contentSha256: sha256(canonicalJson(content)) });
  }

  for (const [index, value] of rawEdges.entries()) {
    if (!isObject(value) || typeof value.source !== "string" || typeof value.target !== "string") {
      issues.push({
        code: "invalid_edge",
        subjectId: String(index),
        message: `Edge at index ${index} must have string source and target ids`,
      });
      continue;
    }
    for (const endpoint of [value.source, value.target]) {
      if (!nodeIds.has(endpoint)) {
        issues.push({
          code: "dangling_edge",
          subjectId: endpoint,
          message: `Edge at index ${index} references missing node ${endpoint}`,
        });
      }
    }
  }

  for (const value of rawNodes) {
    if (!isObject(value) || typeof value.id !== "string") continue;
    if (typeof value.superseded_by === "string" && !nodeIds.has(value.superseded_by)) {
      issues.push({
        code: "missing_supersession_target",
        subjectId: value.id,
        message: `Node ${value.id} is superseded by missing node ${value.superseded_by}`,
      });
    }
    if (!isObject(value.ingestion_provenance) || !Array.isArray(value.ingestion_provenance.evidence_node_ids)) {
      continue;
    }
    for (const evidenceNodeId of value.ingestion_provenance.evidence_node_ids) {
      if (typeof evidenceNodeId === "string" && !nodeIds.has(evidenceNodeId)) {
        issues.push({
          code: "missing_provenance_node",
          subjectId: value.id,
          message: `Node ${value.id} provenance references missing node ${evidenceNodeId}`,
        });
      }
    }
  }

  nodes.sort((left, right) => left.id.localeCompare(right.id) || left.contentSha256.localeCompare(right.contentSha256));
  issues.sort(compareIssues);
  return {
    graph,
    nodes,
    report: {
      root,
      path: filePath,
      directoryOrgId,
      kind,
      filenameVersion,
      orgId,
      graphVersion,
      sha256: sha256(bytes),
      contentSha256: graph ? sha256(canonicalJson(graph)) : null,
      counts: { nodes: rawNodes.length, edges: rawEdges.length, communities: rawCommunities.length },
      issues,
    },
  };
}

function inventorySnapshots(graphRoots: string[]): ParsedSnapshot[] {
  const snapshots: ParsedSnapshot[] = [];
  for (const root of graphRoots) {
    const stat = fs.statSync(root);
    if (!stat.isDirectory()) throw new Error(`Graph root is not a directory: ${root}`);
    const orgDirectories = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const orgDirectory of orgDirectories) {
      const directory = path.join(root, orgDirectory.name);
      const files = fs.readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && GRAPH_FILE_PATTERN.test(entry.name))
        .map((entry) => path.join(directory, entry.name))
        .sort();
      for (const filePath of files) snapshots.push(parseSnapshot(root, orgDirectory.name, filePath));
    }
  }
  return snapshots.sort((left, right) => left.report.path.localeCompare(right.report.path));
}

function layoutIdentity(snapshot: ParsedSnapshot): LayoutIdentity {
  return {
    root: snapshot.report.root,
    path: snapshot.report.path,
    version: snapshot.report.graphVersion,
    sha256: snapshot.report.sha256,
    contentSha256: snapshot.report.contentSha256 ?? "",
  };
}

function groupNodeIdsByContent(nodes: NodeInventory[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const node of nodes) {
    const ids = grouped.get(node.contentSha256) ?? [];
    ids.push(node.id);
    grouped.set(node.contentSha256, ids);
  }
  for (const ids of grouped.values()) ids.sort();
  return grouped;
}

function compareLayouts(left: ParsedSnapshot, right: ParsedSnapshot): LayoutComparison {
  const leftById = new Map(left.nodes.map((node) => [node.id, node.contentSha256]));
  const rightById = new Map(right.nodes.map((node) => [node.id, node.contentSha256]));
  const leftIds = [...leftById.keys()].sort();
  const rightIds = [...rightById.keys()].sort();
  const sharedIds = leftIds.filter((id) => rightById.has(id));
  const leftByContent = groupNodeIdsByContent(left.nodes);
  const rightByContent = groupNodeIdsByContent(right.nodes);
  const sameContentDifferentIds: LayoutComparison["sameContentDifferentIds"] = [];

  for (const contentSha256 of [...leftByContent.keys()].filter((digest) => rightByContent.has(digest)).sort()) {
    const leftContentIds = leftByContent.get(contentSha256) ?? [];
    const rightContentIds = rightByContent.get(contentSha256) ?? [];
    const leftDifferent = leftContentIds.filter((id) => !rightContentIds.includes(id));
    const rightDifferent = rightContentIds.filter((id) => !leftContentIds.includes(id));
    if (leftDifferent.length > 0 && rightDifferent.length > 0) {
      sameContentDifferentIds.push({
        contentSha256,
        leftNodeIds: leftDifferent,
        rightNodeIds: rightDifferent,
      });
    }
  }

  return {
    orgId: left.report.orgId ?? "",
    left: layoutIdentity(left),
    right: layoutIdentity(right),
    identical: left.report.contentSha256 === right.report.contentSha256,
    sameIdSameContent: sharedIds.filter((id) => leftById.get(id) === rightById.get(id)),
    sameIdDifferentContent: sharedIds.filter((id) => leftById.get(id) !== rightById.get(id)),
    leftOnlyNodeIds: leftIds.filter((id) => !rightById.has(id)),
    rightOnlyNodeIds: rightIds.filter((id) => !leftById.has(id)),
    sameContentDifferentIds,
  };
}

function compareLatestLayouts(snapshots: ParsedSnapshot[]): LayoutComparison[] {
  const byOrg = new Map<string, ParsedSnapshot[]>();
  for (const snapshot of snapshots) {
    if (snapshot.report.kind !== "latest" || !snapshot.report.orgId || !snapshot.report.contentSha256) continue;
    const layouts = byOrg.get(snapshot.report.orgId) ?? [];
    layouts.push(snapshot);
    byOrg.set(snapshot.report.orgId, layouts);
  }

  const comparisons: LayoutComparison[] = [];
  for (const orgId of [...byOrg.keys()].sort()) {
    const layouts = (byOrg.get(orgId) ?? []).sort((left, right) => left.report.path.localeCompare(right.report.path));
    for (let leftIndex = 0; leftIndex < layouts.length; leftIndex++) {
      for (let rightIndex = leftIndex + 1; rightIndex < layouts.length; rightIndex++) {
        comparisons.push(compareLayouts(layouts[leftIndex], layouts[rightIndex]));
      }
    }
  }
  return comparisons;
}

function tableNames(db: DatabaseSync): Set<string> {
  const rows = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(\"${table}\")`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function selectedColumn(columns: Set<string>, column: string): string {
  return columns.has(column) ? `\"${column}\"` : `NULL AS \"${column}\"`;
}

function readRows(db: DatabaseSync, table: string, columns: string[]): Array<Record<string, unknown>> {
  const available = tableColumns(db, table);
  return db.prepare(
    `SELECT ${columns.map((column) => selectedColumn(available, column)).join(", ")} FROM \"${table}\"`,
  ).all() as Array<Record<string, unknown>>;
}

function missingColumnIssues(db: DatabaseSync, table: string, expected: string[]): DatabaseIssue[] {
  const columns = tableColumns(db, table);
  return expected
    .filter((column) => !columns.has(column))
    .map((column) => ({
      code: "missing_column" as const,
      table,
      message: `Table ${table} is missing column ${column}`,
    }));
}

function normalizeCandidate(row: Record<string, unknown>, table: string, issues: DatabaseIssue[]): CandidateRow | null {
  const id = normalizeNullableString(row.id);
  if (!id) {
    issues.push({ code: "invalid_row", table, message: `Table ${table} contains a row without a usable id` });
    return null;
  }
  return {
    id,
    orgId: normalizeNullableString(row.org_id),
    status: normalizeNullableString(row.status),
    promotedNodeId: normalizeNullableString(row.promoted_node_id),
    evidenceItemId: normalizeNullableString(row.evidence_item_id),
  };
}

function isPromoted(source: LegacyReferenceInventory["source"], status: string | null): boolean {
  if (source === "project_evidence_item") return false;
  return status === "promoted" || status === "auto_promoted";
}

function classifyReference(
  source: LegacyReferenceInventory["source"],
  row: CandidateRow | EvidenceRow,
  layouts: ParsedSnapshot[],
): LegacyReferenceInventory {
  if (!row.promotedNodeId) {
    return {
      source,
      recordId: row.id,
      orgId: row.orgId,
      status: "status" in row ? row.status : null,
      promotedNodeId: null,
      classification: "promoted_without_pointer",
      resolutions: [],
    };
  }

  const resolutions = layouts.flatMap((layout) => {
    if (layout.report.orgId !== row.orgId) return [];
    const matches = layout.nodes.filter((node) => node.id === row.promotedNodeId);
    return matches.map((node) => ({
      root: layout.report.root,
      path: layout.report.path,
      nodeContentSha256: node.contentSha256,
    }));
  }).sort((left, right) => left.path.localeCompare(right.path) || left.nodeContentSha256.localeCompare(right.nodeContentSha256));

  let classification: ReferenceClassification;
  if (resolutions.length === 0) classification = "pointer_missing_all_layouts";
  else if (resolutions.length === 1) classification = "pointer_resolves_one_layout";
  else if (new Set(resolutions.map((resolution) => resolution.nodeContentSha256)).size === 1) {
    classification = "pointer_resolves_multiple_same";
  } else {
    classification = "pointer_resolves_multiple_conflicting";
  }

  return {
    source,
    recordId: row.id,
    orgId: row.orgId,
    status: "status" in row ? row.status : null,
    promotedNodeId: row.promotedNodeId,
    classification,
    resolutions,
  };
}

function inventoryDatabase(
  dbPath: string,
  latestLayouts: ParsedSnapshot[],
): Pick<LegacyGraphInventoryReport, "database" | "references"> {
  const databaseSha256 = sha256(fs.readFileSync(dbPath));
  const walPath = `${dbPath}-wal`;
  if (fs.existsSync(walPath) && fs.statSync(walPath).size > 0) {
    throw new Error(`Database has an active WAL; inventory a checkpointed copy instead: ${walPath}`);
  }
  const databaseUrl = pathToFileURL(dbPath);
  databaseUrl.searchParams.set("immutable", "1");
  const db = new DatabaseSync(databaseUrl, { readOnly: true });
  const expectedTables = ["memory_candidates", "project_evidence_items", "project_memory_candidates"];
  const issues: DatabaseIssue[] = [];
  const references: LegacyReferenceInventory[] = [];
  let inspectedTables: string[] = [];
  let missingTables: string[] = [];

  try {
    db.exec("PRAGMA query_only = ON");
    const tables = tableNames(db);
    inspectedTables = expectedTables.filter((table) => tables.has(table));
    missingTables = expectedTables.filter((table) => !tables.has(table));

    let evidenceRows: EvidenceRow[] = [];
    if (tables.has("project_evidence_items")) {
      issues.push(...missingColumnIssues(db, "project_evidence_items", ["id", "org_id", "promoted_node_id"]));
      evidenceRows = readRows(db, "project_evidence_items", ["id", "org_id", "promoted_node_id"])
        .flatMap((row) => {
          const id = normalizeNullableString(row.id);
          if (!id) {
            issues.push({
              code: "invalid_row",
              table: "project_evidence_items",
              message: "Table project_evidence_items contains a row without a usable id",
            });
            return [];
          }
          return [{ id, orgId: normalizeNullableString(row.org_id), promotedNodeId: normalizeNullableString(row.promoted_node_id) }];
        });
      for (const row of evidenceRows.filter((item) => item.promotedNodeId)) {
        references.push(classifyReference("project_evidence_item", row, latestLayouts));
      }
    }

    if (tables.has("project_memory_candidates")) {
      const table = "project_memory_candidates";
      const columns = ["id", "org_id", "status", "promoted_node_id", "evidence_item_id"];
      issues.push(...missingColumnIssues(db, table, columns));
      const candidates = readRows(db, table, columns)
        .map((row) => normalizeCandidate(row, table, issues))
        .filter((row): row is CandidateRow => row !== null);
      const evidenceById = new Map(evidenceRows.map((row) => [row.id, row]));
      for (const candidate of candidates) {
        if (isPromoted("project_memory_candidate", candidate.status) || candidate.promotedNodeId) {
          references.push(classifyReference("project_memory_candidate", candidate, latestLayouts));
        }
        if (!candidate.evidenceItemId) continue;
        const evidence = evidenceById.get(candidate.evidenceItemId);
        if (!evidence) {
          issues.push({
            code: "evidence_row_missing",
            table,
            recordId: candidate.id,
            message: `Candidate ${candidate.id} references missing evidence item ${candidate.evidenceItemId}`,
          });
        } else if (candidate.promotedNodeId !== evidence.promotedNodeId) {
          issues.push({
            code: "candidate_evidence_pointer_mismatch",
            table,
            recordId: candidate.id,
            message: `Candidate ${candidate.id} pointer ${candidate.promotedNodeId ?? "<null>"} differs from evidence ${evidence.id} pointer ${evidence.promotedNodeId ?? "<null>"}`,
          });
        }
      }
    }

    if (tables.has("memory_candidates")) {
      const table = "memory_candidates";
      const columns = ["id", "org_id", "status", "promoted_node_id"];
      issues.push(...missingColumnIssues(db, table, columns));
      const candidates = readRows(db, table, columns)
        .map((row) => normalizeCandidate(row, table, issues))
        .filter((row): row is CandidateRow => row !== null);
      for (const candidate of candidates) {
        if (isPromoted("memory_candidate", candidate.status) || candidate.promotedNodeId) {
          references.push(classifyReference("memory_candidate", candidate, latestLayouts));
        }
      }
    }
  } finally {
    db.close();
  }

  issues.sort((left, right) =>
    left.table.localeCompare(right.table) ||
    (left.recordId ?? "").localeCompare(right.recordId ?? "") ||
    left.code.localeCompare(right.code) ||
    left.message.localeCompare(right.message));
  references.sort((left, right) =>
    left.source.localeCompare(right.source) ||
    (left.orgId ?? "").localeCompare(right.orgId ?? "") ||
    left.recordId.localeCompare(right.recordId));

  return {
    database: {
      path: dbPath,
      sha256: databaseSha256,
      inspectedTables,
      missingTables,
      issues,
    },
    references,
  };
}

/**
 * Inventories legacy graph layouts and SQL pointers without initializing either
 * storage system. All paths are explicit; only graph-latest snapshots take part
 * in pointer resolution and layout comparisons.
 */
export function inventoryLegacyGraphs(options: LegacyGraphInventoryOptions): LegacyGraphInventoryReport {
  if (!options.dbPath) throw new Error("dbPath is required");
  if (options.graphRoots.length === 0) throw new Error("At least one graph root is required");

  const dbPath = path.resolve(options.dbPath);
  const graphRoots = [...new Set(options.graphRoots.map((root) => path.resolve(root)))].sort();
  const snapshots = inventorySnapshots(graphRoots);
  const latestLayouts = snapshots.filter((snapshot) =>
    snapshot.report.kind === "latest" && snapshot.report.orgId !== null && snapshot.report.contentSha256 !== null);
  const { database, references } = inventoryDatabase(dbPath, latestLayouts);

  return {
    toolVersion: TOOL_VERSION,
    database,
    graphRoots,
    snapshots: snapshots.map((snapshot) => snapshot.report),
    layoutComparisons: compareLatestLayouts(snapshots),
    references,
  };
}
