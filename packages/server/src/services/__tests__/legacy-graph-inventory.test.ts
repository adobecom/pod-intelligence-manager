import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { inventoryLegacyGraphs } from "../legacy-graph-inventory.js";

let tempDir = "";

function node(id: string, summary: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    type: "pattern",
    summary,
    details: `${summary} details`,
    source_pod_id: "pod-1",
    source_pod_name: "Pod 1",
    domains: ["test"],
    confidence: "extracted",
    confidence_score: 0.9,
    created_at: "2026-01-01T00:00:00.000Z",
    curated: false,
    ...extra,
  };
}

function graph(orgId: string, version: number, nodes: unknown[], edges: unknown[] = []) {
  return {
    version,
    org_id: orgId,
    updated_at: "2026-01-01T00:00:00.000Z",
    nodes,
    edges,
    communities: [],
  };
}

function writeGraph(root: string, directoryOrgId: string, value: unknown, filename = "graph-latest.json") {
  const directory = path.join(root, directoryOrgId);
  fs.mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, filename);
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
  return filePath;
}

function createLegacyDb(dbPath: string) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE project_evidence_items (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      promoted_node_id TEXT
    );
    CREATE TABLE project_memory_candidates (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      evidence_item_id TEXT,
      status TEXT NOT NULL,
      promoted_node_id TEXT
    );
    CREATE TABLE memory_candidates (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      status TEXT NOT NULL,
      promoted_node_id TEXT
    );
  `);
  return db;
}

function fingerprint(filePath: string) {
  const bytes = fs.readFileSync(filePath);
  const stat = fs.statSync(filePath);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

describe("legacy graph inventory", () => {
  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = "";
  });

  it("reports layout divergence and classifies legacy pointers deterministically without writes", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-graph-inventory-"));
    const rootA = path.join(tempDir, "root-a");
    const rootB = path.join(tempDir, "root-b");
    const dbPath = path.join(tempDir, "legacy.db");
    const graphA = writeGraph(rootA, "org-1", graph("org-1", 4, [
      node("same-id", "same"),
      node("shared-conflict", "left"),
      node("only-a", "left only"),
      node("renamed-a", "renamed content"),
    ]));
    const graphB = writeGraph(rootB, "org-1", graph("org-1", 416, [
      node("same-id", "same"),
      node("shared-conflict", "right"),
      node("only-b", "right only"),
      node("renamed-b", "renamed content"),
    ]));

    const db = createLegacyDb(dbPath);
    const insertEvidence = db.prepare("INSERT INTO project_evidence_items VALUES (?, 'org-1', ?)");
    const insertCandidate = db.prepare("INSERT INTO project_memory_candidates VALUES (?, 'org-1', ?, 'promoted', ?)");
    for (const [id, nodeId] of [
      ["null", null],
      ["one", "only-b"],
      ["orphan", "missing"],
      ["conflict", "shared-conflict"],
      ["same", "same-id"],
      ["mismatch", "only-b"],
    ] as const) {
      insertEvidence.run(`e-${id}`, nodeId);
      insertCandidate.run(`c-${id}`, `e-${id}`, id === "mismatch" ? "only-a" : nodeId);
    }
    db.prepare("INSERT INTO memory_candidates VALUES ('agent-null', 'org-1', 'auto_promoted', NULL)").run();
    db.close();

    const files = [dbPath, graphA, graphB];
    const before = files.map(fingerprint);
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(false);
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
    const report = inventoryLegacyGraphs({ dbPath, graphRoots: [rootB, rootA] });
    const repeated = inventoryLegacyGraphs({ dbPath, graphRoots: [rootA, rootB, rootA] });

    expect(repeated).toEqual(report);
    expect(files.map(fingerprint)).toEqual(before);
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(false);
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
    expect(report.graphRoots).toEqual([rootA, rootB]);
    expect(report.layoutComparisons).toHaveLength(1);
    expect(report.layoutComparisons[0]).toMatchObject({
      orgId: "org-1",
      identical: false,
      sameIdSameContent: ["same-id"],
      sameIdDifferentContent: ["shared-conflict"],
      leftOnlyNodeIds: ["only-a", "renamed-a"],
      rightOnlyNodeIds: ["only-b", "renamed-b"],
    });
    expect(report.layoutComparisons[0].sameContentDifferentIds).toEqual([
      expect.objectContaining({ leftNodeIds: ["renamed-a"], rightNodeIds: ["renamed-b"] }),
    ]);

    const projectReference = (id: string) => report.references.find(
      (reference) => reference.source === "project_memory_candidate" && reference.recordId === id,
    );
    expect(projectReference("c-null")?.classification).toBe("promoted_without_pointer");
    expect(projectReference("c-one")?.classification).toBe("pointer_resolves_one_layout");
    expect(projectReference("c-orphan")?.classification).toBe("pointer_missing_all_layouts");
    expect(projectReference("c-conflict")?.classification).toBe("pointer_resolves_multiple_conflicting");
    expect(projectReference("c-same")?.classification).toBe("pointer_resolves_multiple_same");
    expect(report.references.find((reference) => reference.recordId === "agent-null")?.classification)
      .toBe("promoted_without_pointer");
    expect(report.database.issues).toContainEqual(expect.objectContaining({
      code: "candidate_evidence_pointer_mismatch",
      recordId: "c-mismatch",
    }));
  });

  it("accepts a pre-v1 database with none of the legacy candidate tables", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-graph-inventory-empty-"));
    const dbPath = path.join(tempDir, "empty.db");
    new DatabaseSync(dbPath).close();
    const root = path.join(tempDir, "graph-root");
    writeGraph(root, "org-1", graph("org-1", 1, []));

    const report = inventoryLegacyGraphs({ dbPath, graphRoots: [root] });

    expect(report.database.inspectedTables).toEqual([]);
    expect(report.database.missingTables).toEqual([
      "memory_candidates",
      "project_evidence_items",
      "project_memory_candidates",
    ]);
    expect(report.references).toEqual([]);
  });

  it("refuses a database with an active WAL instead of reading a stale main file", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-graph-inventory-wal-"));
    const dbPath = path.join(tempDir, "active.db");
    new DatabaseSync(dbPath).close();
    fs.writeFileSync(`${dbPath}-wal`, "uncheckpointed changes");
    const root = path.join(tempDir, "graph-root");
    writeGraph(root, "org-1", graph("org-1", 1, []));

    expect(() => inventoryLegacyGraphs({ dbPath, graphRoots: [root] }))
      .toThrow("Database has an active WAL; inventory a checkpointed copy instead");
  });

  it("hashes every snapshot and reports malformed graph references", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-graph-inventory-invalid-"));
    const dbPath = path.join(tempDir, "empty.db");
    new DatabaseSync(dbPath).close();
    const root = path.join(tempDir, "graph-root");
    writeGraph(root, "directory-org", graph("document-org", 1, [
      node("duplicate", "first", {
        superseded_by: "missing-successor",
        ingestion_provenance: { evidence_node_ids: ["missing-evidence"] },
      }),
      node("duplicate", "second"),
    ], [{ source: "duplicate", target: "missing-target", type: "relates_to", weight: 1 }]));
    writeGraph(root, "directory-org", graph("document-org", 8, []), "graph-v7.json");
    const malformedPath = path.join(root, "directory-org", "graph-v2.json");
    fs.writeFileSync(malformedPath, "{");

    const report = inventoryLegacyGraphs({ dbPath, graphRoots: [root] });
    const latest = report.snapshots.find((snapshot) => snapshot.kind === "latest");
    const codes = latest?.issues.map((issue) => issue.code) ?? [];

    expect(report.snapshots).toHaveLength(3);
    expect(report.snapshots.every((snapshot) => snapshot.sha256.length === 64)).toBe(true);
    expect(codes).toEqual(expect.arrayContaining([
      "org_directory_mismatch",
      "duplicate_node_id",
      "dangling_edge",
      "missing_supersession_target",
      "missing_provenance_node",
    ]));
    expect(report.snapshots.find((snapshot) => snapshot.filenameVersion === 7)?.issues)
      .toContainEqual(expect.objectContaining({ code: "version_filename_mismatch" }));
    expect(report.snapshots.find((snapshot) => snapshot.filenameVersion === 2)?.issues)
      .toContainEqual(expect.objectContaining({ code: "invalid_json" }));
  });
});
