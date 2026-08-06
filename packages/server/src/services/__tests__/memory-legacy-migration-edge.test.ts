import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { canonicalJsonSha256, type CodebaseApplicabilityV1 } from "@pim/shared";

const { testDb, testDbPath, tempRoot } = vi.hoisted(() => {
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const root = mkdtempSync(join(tmpdir(), "pim-memory-legacy-edge-"));
  const databasePath = join(root, "legacy.db");
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON");
  return { testDb: database, testDbPath: databasePath, tempRoot: root };
});

vi.mock("../../db/connection.js", () => {
  let savepointSequence = 0;
  const transact = <T>(begin: string, fn: () => T): T => {
    const nested = testDb.isTransaction;
    const savepoint = nested ? `legacy_edge_${++savepointSequence}` : "";
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
import { inventoryLegacyGraphs } from "../legacy-graph-inventory.js";
import {
  applyMemoryLegacyMigration,
  compareMemoryLegacyDualRead,
  createMemoryLegacyResolutionTemplate,
  planMemoryLegacyMigration,
  reconcileMemoryLegacyMigration,
  type MemoryLegacyCanonicalMapping,
  type MemoryLegacyMigrationInput,
  type MemoryLegacyResolutionManifest,
  type MemoryLegacySourceResolution,
} from "../memory-legacy-migration.js";
import { markMemoryCandidateValidationFailed } from "../memory-candidates.js";
import { importActiveMemoryRecord, transitionMemoryRecordStatus } from "../memory-records.js";

const NOW = "2026-08-03T12:00:00.000Z";
const ORG_ID = "org-memory-legacy-edge";
const PROJECT_ID = "project-memory-legacy-edge";
const REPOSITORY_ID = "github.com/acme/legacy-edge";
const REPOSITORY_ROW_ID = "repository-memory-legacy-edge";
const PREEXISTING_RECORD_ID = "mem-preexisting-legacy-edge";

interface LegacyNode {
  id: string;
  type: "pattern" | "anti_pattern";
  summary: string;
  details: string;
  audience: "project";
  source_project_id: string;
  source_pod_id: string;
  source_pod_name: string;
  domains: string[];
  confidence: "extracted";
  confidence_score: number;
  created_at: string;
  curated: boolean;
  provenance: Array<{ source: string; source_id: string; occurred_at: string }>;
}

const IDS = {
  reuse: "legacy-reuse-existing",
  imported: "legacy-import-new",
  parked: "legacy-parked",
  predecessor: "legacy-edge-predecessor",
  successor: "legacy-edge-successor",
} as const;

let nodes: LegacyNode[] = [];
let mainInput: MemoryLegacyMigrationInput;

function node(
  id: string,
  curated = true,
  type: LegacyNode["type"] = "pattern",
): LegacyNode {
  return {
    id,
    type,
    summary: `Preserve ${id}`,
    details: `The ${id} behavior remains stable through the offline cutover.`,
    audience: "project",
    source_project_id: PROJECT_ID,
    source_pod_id: "pod-memory-edge",
    source_pod_name: "Memory Edge",
    domains: ["migration"],
    confidence: "extracted",
    confidence_score: 0.97,
    created_at: NOW,
    curated,
    provenance: [{ source: "edge-test", source_id: `source-${id}`, occurred_at: NOW }],
  };
}

function mapping(sourceNode: LegacyNode, digest: string): MemoryLegacyCanonicalMapping {
  const antiPattern = sourceNode.type === "anti_pattern";
  return {
    org_id: ORG_ID,
    project_id: PROJECT_ID,
    plane: "codebase",
    kind: antiPattern ? "anti_pattern" : "constraint",
    content: {
      summary: sourceNode.summary,
      details: sourceNode.details,
      rationale: "The checksummed legacy claim is complete and must be retained.",
    },
    applicability: {
      repository_id: REPOSITORY_ID,
      paths: [`src/${sourceNode.id}.ts`],
    },
    validation: antiPattern
      ? { strategy: "stable_failure_fingerprint", failure_fingerprint: `failure:${sourceNode.id}` }
      : { strategy: "repository_anchors" },
    exceptions: antiPattern ? ["Does not apply after the underlying failure is eliminated."] : [],
    compatibility: {
      harness_version_range: ">=1.0.0",
      workflow_version_range: ">=1.0.0",
    },
    evidence: [{
      evidence_ref_id: `evidence-${sourceNode.id}`,
      type: "review",
      digest,
      origin_id: `source-${sourceNode.id}`,
      source_authority: "authorized_review",
    }],
    evidence_summary: { strength: "reviewed", ref_count: 1 },
    freshness: { last_confirmed_at: NOW },
    provenance: {
      extractor_version: "legacy-edge-test/v1",
      legacy_source_digest: digest,
    },
  };
}

function graphResolution(
  manifest: MemoryLegacyResolutionManifest,
  nodeId: string,
): MemoryLegacySourceResolution {
  const resolution = manifest.resolutions.find((candidate) =>
    candidate.source_kind === "graph_node"
      && candidate.source_key.includes(`#${encodeURIComponent(nodeId)}`));
  if (!resolution) throw new Error(`Missing graph resolution for ${nodeId}`);
  return resolution;
}

function seedResources(): void {
  testDb.prepare(
    `INSERT INTO users (user_id, email, display_name, is_service, created_at)
     VALUES ('user-memory-legacy-edge', 'memory-legacy-edge@pim.test',
             'Memory Legacy Edge', 0, ?)`,
  ).run(NOW);
  testDb.prepare(
    `INSERT INTO orgs (org_id, slug, name, created_by_user_id, created_at)
     VALUES (?, 'memory-legacy-edge', 'Memory Legacy Edge',
             'user-memory-legacy-edge', ?)`,
  ).run(ORG_ID, NOW);
  testDb.prepare(
    `INSERT INTO projects
       (project_id, name, description, created_at, anatomy_json, resources_json,
        org_id, created_by_user_id)
     VALUES (?, 'Memory Legacy Edge', NULL, ?, '{}', ?, ?, 'user-memory-legacy-edge')`,
  ).run(PROJECT_ID, NOW, JSON.stringify({ github: { repos: ["acme/legacy-edge"] } }), ORG_ID);
  testDb.prepare(
    `INSERT INTO memory_repository_registry
       (repository_row_id, org_id, project_id, provider, provider_repository_id,
        repository_id, display_slug, valid_from, valid_until, created_at, updated_at)
     VALUES (?, ?, ?, 'github', 'provider-memory-legacy-edge', ?,
             'Acme/Legacy-Edge', ?, NULL, ?, ?)`,
  ).run(REPOSITORY_ROW_ID, ORG_ID, PROJECT_ID, REPOSITORY_ID, NOW, NOW, NOW);
}

function writeGraph(root: string, graphNodes: unknown[], edges: unknown[] = []): string {
  const orgDirectory = path.join(root, ORG_ID);
  fs.mkdirSync(orgDirectory, { recursive: true });
  const graphPath = path.join(orgDirectory, "graph-latest.json");
  fs.writeFileSync(graphPath, JSON.stringify({
    version: 3,
    org_id: ORG_ID,
    updated_at: NOW,
    nodes: graphNodes,
    edges,
    communities: [],
  }, null, 2));
  return graphPath;
}

beforeAll(() => {
  createTables();
  seedResources();
  nodes = [
    node(IDS.reuse),
    node(IDS.imported),
    node(IDS.parked, false, "anti_pattern"),
    node(IDS.predecessor),
    node(IDS.successor),
  ];
  const mainRoot = path.join(tempRoot, "main-graphs");
  writeGraph(mainRoot, nodes, [{
    source: IDS.successor,
    target: IDS.predecessor,
    type: "supersedes",
    weight: 1,
  }]);

  const reuseMapping = mapping(nodes[0]!, canonicalJsonSha256(nodes[0]!));
  importActiveMemoryRecord({
    orgId: ORG_ID,
    projectId: PROJECT_ID,
    repositoryRowId: REPOSITORY_ROW_ID,
    recordId: PREEXISTING_RECORD_ID,
    kind: reuseMapping.kind,
    content: reuseMapping.content,
    applicability: reuseMapping.applicability as CodebaseApplicabilityV1,
    exceptions: reuseMapping.exceptions,
    compatibility: reuseMapping.compatibility,
    validation: reuseMapping.validation,
    evidence: reuseMapping.evidence,
    evidenceSummary: reuseMapping.evidence_summary,
    freshness: reuseMapping.freshness,
    provenance: reuseMapping.provenance,
    promptEligible: false,
    now: NOW,
  });

  const inventory = inventoryLegacyGraphs({ dbPath: testDbPath, graphRoots: [mainRoot] });
  const manifest = createMemoryLegacyResolutionTemplate({ graphRoots: [mainRoot], inventoryReport: inventory });
  for (const sourceNode of nodes) {
    const resolution = graphResolution(manifest, sourceNode.id);
    resolution.disposition = "active";
    resolution.reason_code = "operator_mapped_for_edge_test";
    resolution.mapping = mapping(sourceNode, resolution.source_payload_digest);
  }
  mainInput = {
    graphRoots: [mainRoot],
    inventoryReport: inventory,
    resolutionManifest: manifest,
    actorId: "memory-legacy-edge-test",
    now: NOW,
  };
});

afterAll(() => {
  testDb.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("offline legacy migration edge cases", () => {
  it("accounts for a malformed graph node as quarantined input", () => {
    const malformedRoot = path.join(tempRoot, "malformed-graphs");
    writeGraph(malformedRoot, [node("valid-beside-malformed"), { summary: "missing identity" }]);
    const inventory = inventoryLegacyGraphs({ dbPath: testDbPath, graphRoots: [malformedRoot] });
    const manifest = createMemoryLegacyResolutionTemplate({
      graphRoots: [malformedRoot],
      inventoryReport: inventory,
    });
    const plan = planMemoryLegacyMigration({
      graphRoots: [malformedRoot],
      inventoryReport: inventory,
      resolutionManifest: manifest,
      now: NOW,
    });

    expect(plan.source_item_count).toBe(2);
    expect(plan.quarantined_count).toBe(2);
    expect(plan.items.find((item) => item.source_key.includes("#__invalid_node_1"))).toMatchObject({
      disposition: "quarantined",
      reason_code: "invalid_graph_node",
    });
  });

  it("reuses an exact canonical claim and never activates an edge-only superseded predecessor", () => {
    const before = testDb.prepare("SELECT COUNT(*) AS count FROM memory_records").get();
    const plan = planMemoryLegacyMigration(mainInput);
    const predecessor = plan.items.find((item) => item.legacy_id === IDS.predecessor);
    const reused = plan.items.find((item) => item.legacy_id === IDS.reuse);

    expect(before).toEqual({ count: 1 });
    expect(predecessor).toMatchObject({
      disposition: "pending_validation",
      reason_code: "legacy_source_superseded",
    });
    expect(reused).toMatchObject({
      disposition: "active",
      canonical_record_id: PREEXISTING_RECORD_ID,
      canonical_record_version: 1,
    });
    const conflictingManifest = structuredClone(
      mainInput.resolutionManifest,
    ) as MemoryLegacyResolutionManifest;
    graphResolution(conflictingManifest, IDS.reuse).mapping!.evidence[0]!.origin_id =
      "different-immutable-origin";
    expect(() => planMemoryLegacyMigration({
      ...mainInput,
      resolutionManifest: conflictingManifest,
    })).toThrow(/canonical claim exists with different immutable content/i);
    const invalidContractManifest = structuredClone(
      mainInput.resolutionManifest,
    ) as MemoryLegacyResolutionManifest;
    graphResolution(invalidContractManifest, IDS.imported)
      .mapping!.compatibility.harness_version_range = "x".repeat(129);
    expect(planMemoryLegacyMigration({
      ...mainInput,
      resolutionManifest: invalidContractManifest,
    }).items.find((item) => item.legacy_id === IDS.imported)).toMatchObject({
      disposition: "quarantined",
      reason_code: "mapped_contract_invalid",
    });

    const report = applyMemoryLegacyMigration(mainInput);
    expect(report).toMatchObject({ imported_count: 3, pending_count: 2, quarantined_count: 0 });
    expect(testDb.prepare("SELECT COUNT(*) AS count FROM memory_records").get()).toEqual({ count: 3 });
    expect(testDb.prepare(
      `SELECT COUNT(*) AS count FROM memory_record_versions
       WHERE record_id = ?`,
    ).get(PREEXISTING_RECORD_ID)).toEqual({ count: 1 });

    const imported = report.items.find((item) => item.legacy_id === IDS.imported)!;
    transitionMemoryRecordStatus({
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      recordId: imported.canonical_record_id!,
      toStatus: "stale",
      actorId: "memory-legacy-edge-test",
      reasonCode: "post_cutover_revalidation_due",
      explanation: "Exercise reconciliation against immutable imported history after lifecycle progress.",
      now: "2026-08-04T12:00:00.000Z",
    });

    const parked = report.items.find((item) => item.legacy_id === IDS.parked)!;
    const parkedRow = testDb.prepare(
      `SELECT candidate_id, activation_requirement
       FROM memory_candidates_v1 WHERE client_candidate_id = ?`,
    ).get(parked.import_item_id) as { candidate_id: string; activation_requirement: string };
    expect(parkedRow.activation_requirement).toBe("authorized_review");
    markMemoryCandidateValidationFailed(parkedRow.candidate_id, "edge_test_validation_retry");
    expect(testDb.prepare(
      `SELECT current_status, aggregate_version FROM memory_candidates_v1 WHERE candidate_id = ?`,
    ).get(parkedRow.candidate_id)).toEqual({ current_status: "validation_failed", aggregate_version: 3 });

    const dualRead = compareMemoryLegacyDualRead(report.import_run_id);
    expect(dualRead).toMatchObject({
      legacy_projection_count: 3,
      canonical_projection_count: 2,
      combined_projection_count: 5,
      returned_count: 2,
      deduplicated_count: 2,
      suppressed_inactive_legacy_count: 1,
    });
    expect(dualRead.items.some((item) => item.canonical_record_id === imported.canonical_record_id))
      .toBe(false);

    expect(reconcileMemoryLegacyMigration(report.import_run_id)).toEqual(report);
    expect(applyMemoryLegacyMigration({ ...mainInput, now: "2026-08-05T12:00:00.000Z" }))
      .toEqual(report);

    testDb.prepare(
      `INSERT INTO project_evidence_items
         (id, org_id, project_id, source, source_type, source_id, source_url,
          source_title, summary, body, author, occurred_at, ingested_at,
          metadata_json, confidence_score, promotable, promoted_node_id)
       VALUES ('post-cutover-unpromoted-evidence', ?, ?, 'project_update', 'observation',
               'post-cutover-source', NULL, 'Post-cutover evidence',
               'Unpromoted evidence remains writable after authority cutover.',
               'This later legacy source must not change the identity of an already completed import.',
               NULL, ?, ?, '{}', 0.8, 0, NULL)`,
    ).run(ORG_ID, PROJECT_ID, "2026-08-05T13:00:00.000Z", "2026-08-05T13:00:00.000Z");
    expect(applyMemoryLegacyMigration({ ...mainInput, now: "2026-08-06T12:00:00.000Z" }))
      .toEqual(report);
  });
});
