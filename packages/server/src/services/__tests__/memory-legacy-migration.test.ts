import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  CodebaseApplicabilityV1,
  HarnessApplicabilityV1,
  OrgApplicabilityV1,
} from "@pim/shared";

const { testDb, testDbPath, tempRoot } = vi.hoisted(() => {
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const root = mkdtempSync(join(tmpdir(), "pim-memory-legacy-migration-"));
  const databasePath = join(root, "legacy.db");
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON");
  return { testDb: database, testDbPath: databasePath, tempRoot: root };
});

vi.mock("../../db/connection.js", () => {
  let savepointSequence = 0;
  const transact = <T>(begin: string, fn: () => T): T => {
    const nested = testDb.isTransaction;
    const savepoint = nested ? `legacy_test_${++savepointSequence}` : "";
    testDb.exec(nested ? `SAVEPOINT ${savepoint}` : begin);
    try {
      const result = fn();
      testDb.exec(nested ? `RELEASE ${savepoint}` : "COMMIT");
      return result;
    } catch (error) {
      if (nested) {
        testDb.exec(`ROLLBACK TO ${savepoint}`);
        testDb.exec(`RELEASE ${savepoint}`);
      } else {
        testDb.exec("ROLLBACK");
      }
      throw error;
    }
  };
  return {
    default: testDb,
    dbPath: testDbPath,
    withTransaction: <T>(fn: () => T) => transact("BEGIN", fn),
    withImmediateTransaction: <T>(fn: () => T) => transact("BEGIN IMMEDIATE", fn),
  };
});

import { createTables } from "../../db/schema.js";
import { inventoryLegacyGraphs, type LegacyGraphInventoryReport } from "../legacy-graph-inventory.js";
import {
  applyMemoryLegacyMigration,
  compareMemoryLegacyDualRead,
  createMemoryLegacyResolutionTemplate,
  planMemoryLegacyMigration,
  reconcileMemoryLegacyMigration,
  type MemoryLegacyCanonicalMapping,
  type MemoryLegacyMigrationInput,
  type MemoryLegacyMigrationPlan,
  type MemoryLegacyResolutionManifest,
  type MemoryLegacySourceResolution,
} from "../memory-legacy-migration.js";
import {
  applyMemoryErasurePlan,
  createMemoryRetentionPolicyVersion,
  planMemoryErasure,
  planMemoryRetention,
} from "../memory-data-governance.js";
import { markMemoryCandidateValidationFailed } from "../memory-candidates.js";

const NOW = "2026-08-03T12:00:00.000Z";
const ORG_ID = "org-memory-legacy-migration";
const PROJECT_ID = "project-memory-legacy-migration";
const REPOSITORY_ID = "github.com/acme/legacy-memory";
const REPOSITORY_ROW_ID = "repository-memory-legacy-migration";
const GRAPH_VERSION = 7;

const GRAPH_NODE_IDS = {
  codebase: "legacy-codebase-active",
  harness: "legacy-harness-active",
  org: "legacy-org-pending",
  uncurated: "legacy-uncurated-pending",
  operatorReviewed: "legacy-operator-reviewed-gap",
  layoutConflict: "legacy-layout-conflict",
} as const;

interface LegacyNode {
  id: string;
  type: "pattern";
  summary: string;
  details: string;
  audience?: "project" | "harness" | "org";
  source_project_id?: string;
  source_pod_id: string;
  source_pod_name: string;
  domains: string[];
  confidence: "extracted";
  confidence_score: number;
  created_at: string;
  curated: boolean;
  provenance?: Array<{ source: string; source_id: string; occurred_at: string }>;
  retrieval_text?: string;
  embedding?: number[];
  embedding_text_hash?: string;
}

let graphRoots: string[] = [];
let graphPaths: string[] = [];
let graphNodes: LegacyNode[] = [];
let inventoryReport: LegacyGraphInventoryReport;
let resolutionManifest: MemoryLegacyResolutionManifest;
let migrationInput: MemoryLegacyMigrationInput;
let planned: MemoryLegacyMigrationPlan;
let graphBefore: Array<ReturnType<typeof fileFingerprint>>;
let legacyRowsBefore = "";

function fileFingerprint(filePath: string) {
  const bytes = fs.readFileSync(filePath);
  return {
    bytes: bytes.toString("base64"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  };
}

function databaseSha256(): string {
  return createHash("sha256").update(fs.readFileSync(testDbPath)).digest("hex");
}

function node(id: string, audience: LegacyNode["audience"], curated: boolean): LegacyNode {
  const label = id.replaceAll("-", " ");
  return {
    id,
    type: "pattern",
    summary: `Preserve the ${label} invariant`,
    details: `The ${label} behavior must remain stable across the offline legacy memory cutover.`,
    audience,
    source_project_id: PROJECT_ID,
    source_pod_id: "pod-memory-migration",
    source_pod_name: "Memory Migration",
    domains: ["migration"],
    confidence: "extracted",
    confidence_score: 0.96,
    created_at: NOW,
    curated,
    provenance: [{ source: "migration-test", source_id: `source-${id}`, occurred_at: NOW }],
  };
}

function writeGraph(root: string, version: number, nodes: LegacyNode[]): string {
  const orgDirectory = path.join(root, ORG_ID);
  fs.mkdirSync(orgDirectory, { recursive: true });
  const graphPath = path.join(orgDirectory, "graph-latest.json");
  fs.writeFileSync(graphPath, JSON.stringify({
    version,
    org_id: ORG_ID,
    updated_at: NOW,
    nodes,
    edges: [],
    communities: [],
  }, null, 2));
  return graphPath;
}

function writeGraphs(): void {
  const codebase = node(GRAPH_NODE_IDS.codebase, "project", true);
  codebase.retrieval_text = `Expanded retrieval text for ${GRAPH_NODE_IDS.codebase}`;
  codebase.embedding = Array.from({ length: 512 }, (_, index) => (index + 1) / 512);
  codebase.embedding_text_hash = createHash("sha256")
    .update(codebase.retrieval_text)
    .digest("hex");
  const operatorReviewed = node(GRAPH_NODE_IDS.operatorReviewed, "project", false);
  delete operatorReviewed.audience;
  delete operatorReviewed.source_project_id;
  delete operatorReviewed.provenance;
  graphNodes = [
    codebase,
    node(GRAPH_NODE_IDS.harness, "harness", true),
    node(GRAPH_NODE_IDS.org, "org", true),
    node(GRAPH_NODE_IDS.uncurated, "project", false),
    operatorReviewed,
  ];
  const leftConflict = {
    ...node(GRAPH_NODE_IDS.layoutConflict, "project", true),
    summary: "Preserve the primary layout claim",
    details: "The primary graph layout contains one side of an explicit migration conflict.",
  };
  const rightConflict = {
    ...node(GRAPH_NODE_IDS.layoutConflict, "project", true),
    summary: "Preserve the secondary layout claim",
    details: "The secondary graph layout contains the divergent side of the same legacy id.",
  };
  graphRoots = [
    path.join(tempRoot, "knowledge-graphs-primary"),
    path.join(tempRoot, "knowledge-graphs-secondary"),
  ];
  graphPaths = [
    writeGraph(graphRoots[0]!, GRAPH_VERSION, [...graphNodes, leftConflict]),
    writeGraph(graphRoots[1]!, GRAPH_VERSION + 1, [...graphNodes, rightConflict]),
  ];
}

function insertFixtureResources(): void {
  testDb.prepare(
    `INSERT INTO users (user_id, email, display_name, is_service, created_at)
     VALUES ('user-memory-legacy-migration', 'memory-legacy-migration@pim.test',
             'Memory Legacy Migration', 0, ?)`,
  ).run(NOW);
  testDb.prepare(
    `INSERT INTO orgs (org_id, slug, name, created_by_user_id, created_at)
     VALUES (?, 'memory-legacy-migration', 'Memory Legacy Migration',
             'user-memory-legacy-migration', ?)`,
  ).run(ORG_ID, NOW);
  testDb.prepare(
    `INSERT INTO projects
       (project_id, name, description, created_at, anatomy_json, resources_json,
        org_id, created_by_user_id)
     VALUES (?, 'Memory Legacy Migration', NULL, ?, '{}', ?, ?,
             'user-memory-legacy-migration')`,
  ).run(PROJECT_ID, NOW, JSON.stringify({ github: { repos: ["acme/legacy-memory"] } }), ORG_ID);
  testDb.prepare(
    `INSERT INTO memory_repository_registry
       (repository_row_id, org_id, project_id, provider, provider_repository_id,
        repository_id, display_slug, valid_from, valid_until, created_at, updated_at)
     VALUES (?, ?, ?, 'github', 'provider-memory-legacy-migration', ?,
             'Acme/Legacy-Memory', ?, NULL, ?, ?)`,
  ).run(REPOSITORY_ROW_ID, ORG_ID, PROJECT_ID, REPOSITORY_ID, NOW, NOW, NOW);
}

function insertLegacyRows(): void {
  testDb.prepare(
    `INSERT INTO memory_candidates
       (id, org_id, project_id, source_type, source_id, type, summary, details,
        retrieval_text, entity_refs_json, domains_json, confidence_score,
        evidence_json, status, promoted_node_id, created_at, reviewed_at)
     VALUES ('agent-same-node', ?, ?, 'agent_run', 'run-same-node', 'pattern',
             ?, ?, NULL, '[]', '["migration"]', 0.96,
             '{"target_memory_scope":"product"}', 'auto_promoted', ?, ?, ?)`,
  ).run(
    ORG_ID,
    PROJECT_ID,
    graphNodes[0]!.summary,
    graphNodes[0]!.details,
    GRAPH_NODE_IDS.codebase,
    NOW,
    NOW,
  );
  testDb.prepare(
    `INSERT INTO memory_candidates
       (id, org_id, project_id, source_type, source_id, type, summary, details,
        retrieval_text, entity_refs_json, domains_json, confidence_score,
        evidence_json, status, promoted_node_id, created_at, reviewed_at)
     VALUES ('agent-orphan', ?, ?, 'agent_run', 'run-orphan', 'pattern',
             'Preserve the orphan quarantine boundary',
             'A promoted pointer that cannot resolve must be retained and quarantined without loss.',
             NULL, '[]', '["migration"]', 0.91,
             '{"target_memory_scope":"product"}', 'auto_promoted',
             'missing-legacy-node', ?, ?)`,
  ).run(ORG_ID, PROJECT_ID, NOW, NOW);
  testDb.prepare(
    `INSERT INTO project_evidence_items
       (id, org_id, project_id, source, source_type, source_id, source_url,
        source_title, summary, body, author, occurred_at, ingested_at,
        metadata_json, confidence_score, promotable, promoted_node_id)
     VALUES ('project-evidence-rejected', ?, ?, 'project_update', 'decision',
             'project-source-rejected', NULL, 'Rejected legacy evidence',
             'Rejected legacy evidence is retained',
             'Rejected project evidence must remain accounted for without becoming active memory.',
             NULL, ?, ?, '{}', 0.72, 1, ?)`,
  ).run(ORG_ID, PROJECT_ID, NOW, NOW, GRAPH_NODE_IDS.codebase);
  testDb.prepare(
    `INSERT INTO project_memory_candidates
       (id, org_id, project_id, evidence_item_id, type, summary, details,
        domains_json, confidence_score, source, status, created_at, reviewed_at,
        promoted_node_id)
     VALUES ('project-candidate-rejected', ?, ?, 'project-evidence-rejected',
             'pattern', ?, ?, '["migration"]', 0.72, 'project_update',
             'rejected', ?, ?, ?)`,
  ).run(
    ORG_ID,
    PROJECT_ID,
    graphNodes[0]!.summary,
    graphNodes[0]!.details,
    NOW,
    NOW,
    GRAPH_NODE_IDS.codebase,
  );
}

function legacyRows(): string {
  const tables = ["memory_candidates", "project_evidence_items", "project_memory_candidates"];
  return JSON.stringify(Object.fromEntries(tables.map((table) => [
    table,
    testDb.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
  ])));
}

function graphResolutions(nodeId: string): MemoryLegacySourceResolution[] {
  const results = resolutionManifest.resolutions.filter((resolution) =>
    resolution.source_kind === "graph_node"
      && resolution.source_key.includes(`#${encodeURIComponent(nodeId)}`));
  if (results.length === 0) throw new Error(`No graph resolution for ${nodeId}`);
  return results;
}

function sourceResolution(kind: MemoryLegacySourceResolution["source_kind"], key: string) {
  const result = resolutionManifest.resolutions.find((resolution) =>
    resolution.source_kind === kind && resolution.source_key === key);
  if (!result) throw new Error(`No ${kind} resolution for ${key}`);
  return result;
}

function commonMapping(
  source: MemoryLegacySourceResolution,
  sourceNode: LegacyNode,
  plane: MemoryLegacyCanonicalMapping["plane"],
  applicability: CodebaseApplicabilityV1 | HarnessApplicabilityV1 | OrgApplicabilityV1,
): MemoryLegacyCanonicalMapping {
  return {
    org_id: ORG_ID,
    project_id: PROJECT_ID,
    plane,
    kind: "constraint",
    content: {
      summary: sourceNode.summary,
      details: sourceNode.details,
      rationale: "The legacy claim is provenance-complete and must survive this cutover.",
    },
    applicability,
    validation: plane === "codebase"
      ? { strategy: "repository_anchors" }
      : plane === "harness"
        ? { strategy: "stable_failure_fingerprint", failure_fingerprint: `failure:${sourceNode.id}` }
        : { strategy: "policy_owner_review" },
    exceptions: [],
    compatibility: {
      harness_version_range: ">=1.0.0",
      workflow_version_range: ">=1.0.0",
    },
    evidence: [{
      evidence_ref_id: `evidence-${sourceNode.id}`,
      type: "review",
      digest: source.source_payload_digest,
      origin_id: `source-${sourceNode.id}`,
      source_authority: "authorized_review",
    }],
    evidence_summary: { strength: "reviewed", ref_count: 1 },
    freshness: { last_confirmed_at: NOW },
    provenance: {
      extractor_version: "legacy-migration-test/v1",
      legacy_source_digest: source.source_payload_digest,
    },
  };
}

function resolveAs(
  resolution: MemoryLegacySourceResolution,
  mapping: MemoryLegacyCanonicalMapping,
): void {
  resolution.disposition = "active";
  resolution.reason_code = "operator_mapped_for_cutover";
  resolution.mapping = mapping;
}

function configureManifest(): void {
  const codebase = graphResolutions(GRAPH_NODE_IDS.codebase);
  const harness = graphResolutions(GRAPH_NODE_IDS.harness);
  const org = graphResolutions(GRAPH_NODE_IDS.org);
  const uncurated = graphResolutions(GRAPH_NODE_IDS.uncurated);
  const operatorReviewed = graphResolutions(GRAPH_NODE_IDS.operatorReviewed);
  const codebaseMapping = commonMapping(codebase[0]!, graphNodes[0]!, "codebase", {
    repository_id: REPOSITORY_ID,
    paths: ["src/legacy-memory.ts"],
  });
  for (const resolution of codebase) resolveAs(resolution, codebaseMapping);
  resolveAs(
    sourceResolution("agent_candidate", "agent-same-node"),
    codebaseMapping,
  );
  for (const resolution of harness) {
    resolveAs(resolution, commonMapping(resolution, graphNodes[1]!, "harness", {
      harness_id: "fiesta",
      harness_version_range: ">=2.0.0",
      workflow_version_range: ">=3.0.0",
    }));
  }
  for (const resolution of org) {
    resolveAs(resolution, commonMapping(resolution, graphNodes[2]!, "org", {
      audience: ["memory-policy-reviewers"],
      policy_owner: "memory-governance",
      effective_from: NOW,
      project_ids: [PROJECT_ID],
    }));
  }
  for (const resolution of uncurated) {
    resolveAs(resolution, commonMapping(resolution, graphNodes[3]!, "codebase", {
      repository_id: REPOSITORY_ID,
      paths: ["src/uncurated.ts"],
    }));
  }
  for (const resolution of operatorReviewed) {
    resolveAs(resolution, commonMapping(resolution, graphNodes[4]!, "codebase", {
      repository_id: REPOSITORY_ID,
      paths: ["src/operator-reviewed.ts"],
    }));
  }
  resolveAs(
    sourceResolution("agent_candidate", "agent-orphan"),
    {
      ...commonMapping(
        sourceResolution("agent_candidate", "agent-orphan"),
        {
          ...graphNodes[0]!,
          id: "agent-orphan",
          summary: "Preserve the orphan quarantine boundary",
          details: "A promoted pointer that cannot resolve must be retained and quarantined without loss.",
        },
        "codebase",
        { repository_id: REPOSITORY_ID, paths: ["src/orphan.ts"] },
      ),
      provenance: { extractor_version: "legacy-migration-test/v1" },
    },
  );
}

beforeAll(() => {
  createTables();
  insertFixtureResources();
  writeGraphs();
  insertLegacyRows();
  legacyRowsBefore = legacyRows();
  graphBefore = graphPaths.map(fileFingerprint);
  inventoryReport = inventoryLegacyGraphs({ dbPath: testDbPath, graphRoots });
  resolutionManifest = createMemoryLegacyResolutionTemplate({
    graphRoots,
    inventoryReport,
  });
  configureManifest();
  migrationInput = {
    graphRoots,
    inventoryReport,
    resolutionManifest,
    actorId: "memory-migration-test",
    now: NOW,
  };
  planned = planMemoryLegacyMigration(migrationInput);
});

afterAll(() => {
  testDb.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("offline legacy memory migration", () => {
  it("templates every legacy authority exactly once and plans eligibility and aliases without writes", () => {
    const expectedSourceCount = ((graphNodes.length + 1) * graphRoots.length) + 2 + 1 + 1;
    expect(resolutionManifest.resolutions).toHaveLength(expectedSourceCount);
    expect(new Set(resolutionManifest.resolutions.map((resolution) =>
      `${resolution.source_kind}\0${resolution.source_key}`)).size).toBe(expectedSourceCount);
    expect(resolutionManifest.resolutions.every((resolution) =>
      /^sha256:[0-9a-f]{64}$/.test(resolution.source_payload_digest))).toBe(true);

    expect(planMemoryLegacyMigration(migrationInput)).toEqual(planned);

    expect(planned.source_item_count).toBe(expectedSourceCount);
    expect(
      planned.imported_count
      + planned.pending_count
      + planned.quarantined_count
      + planned.deduplicated_count,
    ).toBe(expectedSourceCount);
    expect(planned).toMatchObject({
      imported_count: 2,
      pending_count: 2,
      quarantined_count: 7,
      deduplicated_count: 5,
      authority: "migration_locked",
    });

    expect(inventoryReport.layoutComparisons).toHaveLength(1);
    expect(inventoryReport.layoutComparisons[0]).toMatchObject({
      identical: false,
      sameIdDifferentContent: [GRAPH_NODE_IDS.layoutConflict],
    });
    expect(inventoryReport.references.map((reference) => ({
      recordId: reference.recordId,
      classification: reference.classification,
    }))).toEqual(expect.arrayContaining([
      { recordId: "agent-orphan", classification: "pointer_missing_all_layouts" },
      { recordId: "agent-same-node", classification: "pointer_resolves_multiple_same" },
      { recordId: "project-candidate-rejected", classification: "pointer_resolves_multiple_same" },
      { recordId: "project-evidence-rejected", classification: "pointer_resolves_multiple_same" },
    ]));

    const disposition = (kind: string, sourceKey: string) => planned.items.find((item) =>
      item.source_kind === kind && item.source_key === sourceKey)?.disposition;
    const codebaseAliasDispositions = [
      ...graphResolutions(GRAPH_NODE_IDS.codebase).map((resolution) =>
        disposition("graph_node", resolution.source_key)),
      disposition("agent_candidate", "agent-same-node"),
    ];
    expect(codebaseAliasDispositions.sort()).toEqual(["active", "deduplicated", "deduplicated"]);
    expect(graphResolutions(GRAPH_NODE_IDS.harness).map((resolution) =>
      disposition("graph_node", resolution.source_key)).sort()).toEqual(["active", "deduplicated"]);
    expect(graphResolutions(GRAPH_NODE_IDS.org).map((resolution) =>
      disposition("graph_node", resolution.source_key)).sort()).toEqual(["deduplicated", "pending_validation"]);
    expect(graphResolutions(GRAPH_NODE_IDS.uncurated).map((resolution) =>
      disposition("graph_node", resolution.source_key)).sort()).toEqual(["deduplicated", "pending_validation"]);

    const reviewedManifest = structuredClone(resolutionManifest);
    for (const source of reviewedManifest.resolutions.filter((resolution) =>
      resolution.source_kind === "graph_node"
        && resolution.source_key.includes(`#${encodeURIComponent(GRAPH_NODE_IDS.operatorReviewed)}`))) {
      const snapshotPath = source.source_key.slice(0, source.source_key.lastIndexOf("#"));
      const snapshot = inventoryReport.snapshots.find((candidate) =>
        path.resolve(candidate.path) === path.resolve(snapshotPath));
      expect(snapshot).toBeDefined();
      source.mapping!.provenance.legacy_operator_review = {
        schema_version: "pim.memory-legacy-operator-review.v1",
        actor_id: "milo-memory-owner",
        reviewed_at: NOW,
        collection: "milo",
        org_id: ORG_ID,
        project_id: PROJECT_ID,
        repository_id: REPOSITORY_ID,
        source_kind: source.source_kind,
        source_key: source.source_key,
        source_payload_digest: source.source_payload_digest,
        snapshot_sha256: `sha256:${snapshot!.sha256}`,
        assertions: ["curated", "legacy_snapshot_provenance", "codebase_scope"],
      };
    }
    const reviewedPlan = planMemoryLegacyMigration({
      ...migrationInput,
      resolutionManifest: reviewedManifest,
    });
    expect(reviewedPlan.items.filter((item) => item.legacy_id === GRAPH_NODE_IDS.operatorReviewed)
      .map((item) => ({ disposition: item.disposition, reason: item.reason_code })).sort((left, right) =>
        left.disposition.localeCompare(right.disposition)))
      .toEqual([
        { disposition: "active", reason: "legacy_import_validated" },
        { disposition: "deduplicated", reason: "same_content_alias" },
      ]);
    expect(reviewedPlan).toMatchObject({
      imported_count: 3,
      pending_count: 2,
      quarantined_count: 5,
      deduplicated_count: 6,
    });
    const tamperedManifest = structuredClone(reviewedManifest);
    const tampered = tamperedManifest.resolutions.find((resolution) =>
      resolution.source_kind === "graph_node"
        && resolution.source_key.includes(`#${encodeURIComponent(GRAPH_NODE_IDS.operatorReviewed)}`))!;
    (tampered.mapping!.provenance.legacy_operator_review as Record<string, unknown>)
      .source_payload_digest = `sha256:${"0".repeat(64)}`;
    expect(planMemoryLegacyMigration({
      ...migrationInput,
      resolutionManifest: tamperedManifest,
    }).items.find((item) => item.source_key === tampered.source_key)).toMatchObject({
      disposition: "quarantined",
      reason_code: "legacy_operator_review_invalid",
    });
    expect(graphResolutions(GRAPH_NODE_IDS.layoutConflict).map((resolution) =>
      disposition("graph_node", resolution.source_key))).toEqual(["quarantined", "quarantined"]);
    expect(disposition("agent_candidate", "agent-orphan")).toBe("quarantined");
    expect(disposition("project_candidate", "project-candidate-rejected")).toBe("quarantined");

    expect(testDb.prepare("SELECT COUNT(*) AS count FROM memory_legacy_import_runs").get())
      .toEqual({ count: 0 });
    expect(testDb.prepare("SELECT COUNT(*) AS count FROM memory_records").get())
      .toEqual({ count: 0 });
    expect(graphPaths.map(fileFingerprint)).toEqual(graphBefore);
    expect(legacyRows()).toBe(legacyRowsBefore);
  });

  it("rolls back a late failure, then applies, reconciles, and replays atomically without changing sources", () => {
    testDb.exec(`
      CREATE TEMP TRIGGER fail_legacy_migration_duplicate_item
      BEFORE INSERT ON memory_legacy_import_items
      WHEN NEW.disposition = 'deduplicated'
      BEGIN SELECT RAISE(ABORT, 'injected legacy migration failure'); END;
    `);

    expect(() => applyMemoryLegacyMigration(migrationInput))
      .toThrow("injected legacy migration failure");
    expect(testDb.prepare("SELECT COUNT(*) AS count FROM memory_legacy_import_runs").get())
      .toEqual({ count: 0 });
    expect(testDb.prepare("SELECT COUNT(*) AS count FROM memory_legacy_import_items").get())
      .toEqual({ count: 0 });
    expect(testDb.prepare("SELECT COUNT(*) AS count FROM memory_authority_transitions").get())
      .toEqual({ count: 0 });
    expect(testDb.prepare("SELECT COUNT(*) AS count FROM memory_records").get())
      .toEqual({ count: 0 });
    expect(testDb.prepare("SELECT COUNT(*) AS count FROM memory_candidates_v1").get())
      .toEqual({ count: 0 });
    expect(testDb.prepare(
      `SELECT COUNT(*) AS count FROM sqlite_schema
       WHERE type = 'trigger' AND name LIKE '%legacy_authority%'`,
    ).get()).toEqual({ count: 0 });
    expect(graphPaths.map(fileFingerprint)).toEqual(graphBefore);
    expect(legacyRows()).toBe(legacyRowsBefore);

    testDb.exec("DROP TRIGGER temp.fail_legacy_migration_duplicate_item");
    const report = applyMemoryLegacyMigration(migrationInput);
    const reconciled = reconcileMemoryLegacyMigration(report.import_run_id);

    expect(report).toEqual(reconciled);
    expect(report).toMatchObject({
      import_run_id: planned.import_run_id,
      source_item_count: planned.source_item_count,
      imported_count: planned.imported_count,
      pending_count: planned.pending_count,
      quarantined_count: planned.quarantined_count,
      deduplicated_count: planned.deduplicated_count,
      authority: "canonical",
    });
    const ledger = testDb.prepare(
      `SELECT source_kind, source_key, legacy_id, legacy_node_id, graph_version,
              snapshot_sha256, content_digest, source_timestamp, source_payload_json,
              source_provenance_json, disposition, canonical_record_id,
              canonical_record_version, duplicate_of_item_id
       FROM memory_legacy_import_items
       WHERE import_run_id = ? ORDER BY source_kind, source_key`,
    ).all(report.import_run_id) as Array<Record<string, unknown>>;
    expect(ledger).toHaveLength(report.source_item_count);
    expect(new Set(ledger.map((item) => `${item.source_kind}\0${item.source_key}`)))
      .toEqual(new Set(resolutionManifest.resolutions.map((resolution) =>
        `${resolution.source_kind}\0${resolution.source_key}`)));
    for (const item of ledger) {
      const resolution = resolutionManifest.resolutions.find((candidate) =>
        candidate.source_kind === item.source_kind && candidate.source_key === item.source_key);
      expect(item.content_digest).toBe(resolution?.source_payload_digest);
    }
    expect(ledger.filter((item) => item.disposition === "active")).toHaveLength(report.imported_count);
    expect(ledger.filter((item) => item.disposition === "pending_validation")).toHaveLength(report.pending_count);
    expect(ledger.filter((item) => item.disposition === "quarantined")).toHaveLength(report.quarantined_count);
    expect(ledger.filter((item) => item.disposition === "deduplicated"))
      .toHaveLength(report.deduplicated_count);
    expect(ledger.filter((item) => item.disposition === "deduplicated"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ canonical_record_id: null }),
      ]));
    expect(ledger.filter((item) => item.disposition === "deduplicated")
      .every((item) => typeof item.duplicate_of_item_id === "string")).toBe(true);
    const latestSnapshot = inventoryReport.snapshots.find((snapshot) => snapshot.kind === "latest")!;
    const codebaseGraphItem = ledger.find((item) =>
      item.source_kind === "graph_node" && item.legacy_id === GRAPH_NODE_IDS.codebase)!;
    expect(codebaseGraphItem).toMatchObject({
      legacy_node_id: GRAPH_NODE_IDS.codebase,
      graph_version: GRAPH_VERSION,
      snapshot_sha256: `sha256:${latestSnapshot.sha256}`,
      source_timestamp: NOW,
    });
    expect(JSON.parse(String(codebaseGraphItem.source_payload_json))).toMatchObject({
      id: GRAPH_NODE_IDS.codebase,
      source_project_id: PROJECT_ID,
      curated: true,
    });
    expect(JSON.parse(String(codebaseGraphItem.source_provenance_json))).toMatchObject({
      graph_path: graphPaths[0],
      graph_version: GRAPH_VERSION,
      snapshot_sha256: `sha256:${latestSnapshot.sha256}`,
    });
    const activeCodebaseGraphItem = ledger.find((item) =>
      item.legacy_node_id === GRAPH_NODE_IDS.codebase && item.disposition === "active")!;
    const importedEmbedding = testDb.prepare(
      `SELECT embedding_json FROM memory_record_versions
       WHERE record_id = ? AND record_version = ?`,
    ).get(
      String(activeCodebaseGraphItem.canonical_record_id),
      Number(activeCodebaseGraphItem.canonical_record_version),
    ) as {
      embedding_json: string;
    };
    expect(JSON.parse(importedEmbedding.embedding_json)).toEqual(graphNodes[0]!.embedding);
    expect(new Set(ledger.filter((item) => item.source_kind === "graph_node")
      .map((item) => JSON.parse(String(item.source_provenance_json)).graph_path)))
      .toEqual(new Set(graphPaths));
    const agentAliasItem = ledger.find((item) => item.source_key === "agent-same-node")!;
    expect(agentAliasItem).toMatchObject({
      legacy_node_id: GRAPH_NODE_IDS.codebase,
      graph_version: GRAPH_VERSION,
      snapshot_sha256: `sha256:${latestSnapshot.sha256}`,
      source_timestamp: NOW,
    });
    expect(JSON.parse(String(agentAliasItem.source_payload_json))).toMatchObject({
      id: "agent-same-node",
      promoted_node_id: GRAPH_NODE_IDS.codebase,
      status: "auto_promoted",
    });
    expect(JSON.parse(String(agentAliasItem.source_provenance_json))).toMatchObject({
      table: "memory_candidates",
      promoted_node_id: GRAPH_NODE_IDS.codebase,
      resolved_node_payload: { id: GRAPH_NODE_IDS.codebase },
    });

    expect(testDb.prepare(
      `SELECT revision, from_authority, to_authority, legacy_writes_frozen,
              import_run_id
       FROM memory_authority_transitions ORDER BY revision`,
    ).all()).toEqual([
      {
        revision: 1,
        from_authority: "legacy",
        to_authority: "migration_locked",
        legacy_writes_frozen: 1,
        import_run_id: report.import_run_id,
      },
      {
        revision: 2,
        from_authority: "migration_locked",
        to_authority: "canonical",
        legacy_writes_frozen: 1,
        import_run_id: report.import_run_id,
      },
    ]);
    for (const item of ledger.filter((candidate) => candidate.disposition === "active")) {
      const version = testDb.prepare(
        `SELECT provenance_json FROM memory_record_versions
         WHERE record_id = ? AND record_version = ?`,
      ).get(String(item.canonical_record_id), Number(item.canonical_record_version)) as {
        provenance_json: string;
      };
      expect(version.provenance_json).toContain(String(item.legacy_id));
      expect(version.provenance_json).toContain(String(item.content_digest));
    }

    expect(testDb.prepare(
      `SELECT plane, prompt_eligible, shadow_recall_eligible
       FROM memory_records ORDER BY plane`,
    ).all()).toEqual([
      { plane: "codebase", prompt_eligible: 0, shadow_recall_eligible: 1 },
      { plane: "harness", prompt_eligible: 0, shadow_recall_eligible: 1 },
    ]);
    expect(testDb.prepare(
      `SELECT plane, current_status, activation_requirement
       FROM memory_candidates_v1 ORDER BY plane`,
    ).all()).toEqual([
      { plane: "codebase", current_status: "received", activation_requirement: "verified_merge" },
      { plane: "org", current_status: "pending_review", activation_requirement: "manual_policy_owner" },
    ]);
    expect(testDb.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    const storedReport = testDb.prepare(
      "SELECT report_json FROM memory_legacy_import_runs WHERE import_run_id = ?",
    ).get(report.import_run_id) as { report_json: string };
    expect(JSON.parse(storedReport.report_json)).toEqual(report);
    const dualRead = compareMemoryLegacyDualRead(report.import_run_id);
    expect(dualRead).toMatchObject({
      schema_version: "pim.memory-legacy-dual-read-report.v1",
      legacy_projection_count: 5,
      canonical_projection_count: 2,
      combined_projection_count: 7,
      returned_count: 2,
      deduplicated_count: 5,
      suppressed_inactive_legacy_count: 0,
    });
    expect(new Set(dualRead.items.map((item) => item.logical_memory_key)).size)
      .toBe(dualRead.returned_count);
    expect(dualRead.items.every((item) => item.selected_authority === "canonical")).toBe(true);
    expect(dualRead.items.flatMap((item) => item.legacy_import_item_ids)).toHaveLength(5);
    expect(graphPaths.map(fileFingerprint)).toEqual(graphBefore);
    expect(legacyRows()).toBe(legacyRowsBefore);

    expect(() => testDb.prepare(
      `INSERT INTO memory_candidates
         (id, org_id, project_id, source_type, source_id, type, summary, details,
          domains_json, confidence_score, evidence_json, status, created_at)
       VALUES ('agent-after-cutover', ?, ?, 'agent_run', 'after-cutover', 'pattern',
               'Legacy writes remain frozen after cutover',
               'The durable SQL barrier must reject every new legacy candidate after cutover.',
               '[]', 0.9, '{}', 'pending', ?)`,
    ).run(ORG_ID, PROJECT_ID, NOW)).toThrow(/legacy_authority_frozen/);
    expect(legacyRows()).toBe(legacyRowsBefore);

    expect(databaseSha256()).not.toBe(inventoryReport.database.sha256);
    const replay = applyMemoryLegacyMigration({ ...migrationInput, now: "2026-08-04T12:00:00.000Z" });
    expect(JSON.stringify(replay)).toBe(JSON.stringify(report));
    expect(reconcileMemoryLegacyMigration(report.import_run_id)).toEqual(report);
    expect(graphPaths.map(fileFingerprint)).toEqual(graphBefore);
    expect(legacyRows()).toBe(legacyRowsBefore);

    const changedManifest = structuredClone(resolutionManifest);
    changedManifest.resolutions.find((resolution) => resolution.source_kind === "project_evidence")!
      .reason_code = "operator_changed_after_cutover";
    expect(() => applyMemoryLegacyMigration({
      ...migrationInput,
      resolutionManifest: changedManifest,
    })).toThrow(/canonical|authority|conflict|idempotency/i);

    const imported = report.items.find((item) => item.disposition === "active")!;
    const erasurePlan = planMemoryErasure({
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      dataClass: "record",
      recordId: imported.canonical_record_id!,
      method: "physical_delete",
      actorId: "privacy-admin",
      reasonCode: "legacy_record_erasure",
      now: "2026-08-05T12:00:00.000Z",
    }, testDb);
    const legacyTargets = erasurePlan.targets
      .filter((target) => target.resource_class === "legacy_import")
      .map((target) => target.resource_id);
    expect(legacyTargets).toContain(imported.import_item_id);
    applyMemoryErasurePlan({
      plan: erasurePlan,
      expectedPlanDigest: erasurePlan.plan_digest,
      downtimeConfirmed: true,
      compact: false,
      now: "2026-08-05T12:00:00.000Z",
    }, testDb);
    const redactedLedger = testDb.prepare(
      `SELECT import_item_id, source_payload_json, source_provenance_json,
              mapped_payload_json, disposition, reason_code, canonical_record_id,
              duplicate_of_item_id
       FROM memory_legacy_import_items ORDER BY import_item_id`,
    ).all() as Array<Record<string, unknown>>;
    for (const item of redactedLedger.filter((row) =>
      legacyTargets.includes(String(row.import_item_id)))) {
      expect(item).toMatchObject({
        source_payload_json: "{}",
        source_provenance_json: "{}",
        mapped_payload_json: null,
        disposition: "quarantined",
        reason_code: "erased_by_policy",
        canonical_record_id: null,
        duplicate_of_item_id: null,
      });
    }
    expect(testDb.prepare(
      "SELECT 1 FROM memory_records WHERE record_id = ?",
    ).get(imported.canonical_record_id!)).toBeUndefined();
    expect(reconcileMemoryLegacyMigration(report.import_run_id)).toEqual(report);

    const pendingLineages = testDb.prepare(
      `SELECT legacy.import_item_id, legacy.plane, candidate.candidate_id,
              candidate.receipt_id, candidate.current_status, candidate.aggregate_version
       FROM memory_legacy_import_items AS legacy
       JOIN memory_candidates_v1 AS candidate
         ON candidate.client_candidate_id = legacy.import_item_id
        AND candidate.producer_harness_id = 'pim-legacy-migration'
        AND json_extract(
          candidate.candidate_json,
          '$.extensions.legacy_import_item_id'
        ) = legacy.import_item_id
       WHERE legacy.import_run_id = ? AND legacy.disposition = 'pending_validation'
       ORDER BY legacy.plane`,
    ).all(report.import_run_id) as Array<{
      import_item_id: string;
      plane: "codebase" | "org";
      candidate_id: string;
      receipt_id: string;
      current_status: string;
      aggregate_version: number;
    }>;
    const codebaseLineage = pendingLineages.find((item) => item.plane === "codebase")!;
    const orgLineage = pendingLineages.find((item) => item.plane === "org")!;
    expect(codebaseLineage.current_status).toBe("received");
    expect(orgLineage.current_status).toBe("pending_review");

    const lineageIds = (rootImportItemId: string): string[] => (
      testDb.prepare(
        `WITH RECURSIVE lineage(import_item_id) AS (
           SELECT import_item_id FROM memory_legacy_import_items WHERE import_item_id = ?
           UNION
           SELECT child.import_item_id
           FROM memory_legacy_import_items AS child
           JOIN lineage AS parent ON child.duplicate_of_item_id = parent.import_item_id
         )
         SELECT import_item_id FROM lineage ORDER BY import_item_id`,
      ).all(rootImportItemId) as Array<{ import_item_id: string }>
    ).map((item) => item.import_item_id);

    markMemoryCandidateValidationFailed(
      codebaseLineage.candidate_id,
      "legacy_candidate_retention_test",
    );
    expect(testDb.prepare(
      `SELECT current_status, aggregate_version
       FROM memory_candidates_v1 WHERE candidate_id = ?`,
    ).get(codebaseLineage.candidate_id)).toEqual({
      current_status: "validation_failed",
      aggregate_version: 3,
    });
    createMemoryRetentionPolicyVersion({
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      dataClass: "candidate",
      retentionDays: 0,
      actorId: "privacy-admin",
      reasonCode: "legacy_candidate_retention",
      effectiveAt: "2026-08-06T12:00:00.000Z",
      now: "2026-08-06T12:00:00.000Z",
    }, testDb);
    const candidateRetention = planMemoryRetention({
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      dataClass: "candidate",
      actorId: "privacy-admin",
      reasonCode: "apply_legacy_candidate_retention",
      now: "2026-08-07T12:00:00.000Z",
    }, testDb);
    const codebaseLegacyLineageIds = lineageIds(codebaseLineage.import_item_id);
    expect(codebaseLegacyLineageIds.length).toBeGreaterThan(1);
    expect(candidateRetention.targets.filter((target) => target.resource_class === "candidate"))
      .toEqual([expect.objectContaining({ resource_id: codebaseLineage.candidate_id })]);
    expect(candidateRetention.targets
      .filter((target) => target.resource_class === "legacy_import")
      .map((target) => target.resource_id)).toEqual(codebaseLegacyLineageIds);
    applyMemoryErasurePlan({
      plan: candidateRetention,
      expectedPlanDigest: candidateRetention.plan_digest,
      downtimeConfirmed: true,
      compact: false,
      now: "2026-08-07T12:00:00.000Z",
    }, testDb);
    expect(testDb.prepare(
      "SELECT 1 FROM memory_candidates_v1 WHERE candidate_id = ?",
    ).get(codebaseLineage.candidate_id)).toBeUndefined();
    expect(reconcileMemoryLegacyMigration(report.import_run_id)).toEqual(report);

    testDb.prepare(
      `UPDATE memory_candidates_v1 SET current_status = 'active' WHERE candidate_id = ?`,
    ).run(orgLineage.candidate_id);
    expect(() => reconcileMemoryLegacyMigration(report.import_run_id))
      .toThrow(/candidate lifecycle lineage mismatch/i);
    testDb.prepare(
      `UPDATE memory_candidates_v1 SET current_status = 'pending_review' WHERE candidate_id = ?`,
    ).run(orgLineage.candidate_id);
    expect(reconcileMemoryLegacyMigration(report.import_run_id)).toEqual(report);

    expect(testDb.prepare(
      `UPDATE memory_candidates_v1
       SET current_status = 'rejected', aggregate_version = aggregate_version + 1,
           blockers_json = '["legacy_policy_rejected"]', updated_at = ?
       WHERE candidate_id = ? AND current_status = 'pending_review' AND aggregate_version = 1`,
    ).run("2026-08-08T12:00:00.000Z", orgLineage.candidate_id).changes).toBe(1);
    testDb.prepare(
      `INSERT INTO memory_transitions
         (transition_id, org_id, project_id, aggregate_type, aggregate_id, from_status,
          to_status, actor_type, actor_id, reason_code, explanation, evidence_refs_json,
          decision_refs_json, policy_version, occurred_at, committed_at)
       VALUES ('transition-legacy-org-retention-test', ?, ?, 'candidate', ?,
               'pending_review', 'rejected', 'system', 'privacy-admin',
               'legacy_policy_rejected', 'Legacy pending validation was rejected by policy.',
               '[]', '[]', 'memory-retention-test-v1', ?, ?)`,
    ).run(
      ORG_ID,
      PROJECT_ID,
      orgLineage.candidate_id,
      "2026-08-08T12:00:00.000Z",
      "2026-08-08T12:00:00.000Z",
    );
    expect(reconcileMemoryLegacyMigration(report.import_run_id)).toEqual(report);

    createMemoryRetentionPolicyVersion({
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      dataClass: "receipt",
      retentionDays: 0,
      actorId: "privacy-admin",
      reasonCode: "legacy_receipt_retention",
      effectiveAt: "2026-08-08T12:00:00.000Z",
      now: "2026-08-08T12:00:00.000Z",
    }, testDb);
    const receiptRetention = planMemoryRetention({
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      dataClass: "receipt",
      actorId: "privacy-admin",
      reasonCode: "apply_legacy_receipt_retention",
      now: "2026-08-09T12:00:00.000Z",
    }, testDb);
    const orgLegacyLineageIds = lineageIds(orgLineage.import_item_id);
    expect(orgLegacyLineageIds.length).toBeGreaterThan(1);
    expect(receiptRetention.targets.filter((target) => target.resource_class === "receipt"))
      .toEqual([expect.objectContaining({ resource_id: orgLineage.receipt_id })]);
    expect(receiptRetention.targets
      .filter((target) => target.resource_class === "legacy_import")
      .map((target) => target.resource_id)).toEqual(orgLegacyLineageIds);
    applyMemoryErasurePlan({
      plan: receiptRetention,
      expectedPlanDigest: receiptRetention.plan_digest,
      downtimeConfirmed: true,
      compact: false,
      now: "2026-08-09T12:00:00.000Z",
    }, testDb);
    expect(testDb.prepare(
      "SELECT receipt_json, response_json FROM memory_run_receipts WHERE receipt_id = ?",
    ).get(orgLineage.receipt_id)).toEqual({ receipt_json: "{}", response_json: "{}" });
    expect(reconcileMemoryLegacyMigration(report.import_run_id)).toEqual(report);
    const postReceiptCandidateRetention = planMemoryRetention({
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      dataClass: "candidate",
      actorId: "privacy-admin",
      reasonCode: "verify_legacy_tombstone_idempotency",
      now: "2026-08-10T12:00:00.000Z",
    }, testDb);
    expect(postReceiptCandidateRetention.targets
      .filter((target) => target.resource_class === "legacy_import")).toEqual([]);

    const remainingActive = report.items.find((item) =>
      item.disposition === "active" && testDb.prepare(
        "SELECT 1 FROM memory_records WHERE record_id = ?",
      ).get(item.canonical_record_id!))!;
    const remainingRecord = testDb.prepare(
      "SELECT kind FROM memory_records WHERE record_id = ?",
    ).get(remainingActive.canonical_record_id!) as { kind: string };
    const tamperedKind = remainingRecord.kind === "decision" ? "constraint" : "decision";
    testDb.prepare("UPDATE memory_records SET kind = ? WHERE record_id = ?")
      .run(tamperedKind, remainingActive.canonical_record_id!);
    expect(() => reconcileMemoryLegacyMigration(report.import_run_id))
      .toThrow(/canonical record metadata mismatch/i);
    testDb.prepare("UPDATE memory_records SET kind = ? WHERE record_id = ?")
      .run(remainingRecord.kind, remainingActive.canonical_record_id!);
    expect(reconcileMemoryLegacyMigration(report.import_run_id)).toEqual(report);
  });
});
