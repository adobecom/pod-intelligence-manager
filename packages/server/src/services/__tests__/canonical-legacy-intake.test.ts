import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { EnhancedPodLearning, RunReceiptV1 } from "@pim/shared";

const { testDb } = vi.hoisted(() => {
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  return { testDb: database };
});

vi.mock("../../db/connection.js", () => ({
  default: testDb,
  withTransaction: (fn: () => unknown) => fn(),
  withImmediateTransaction: (fn: () => unknown) => fn(),
}));

import { createTables } from "../../db/schema.js";
import {
  CanonicalLegacyIntakeConflictError,
  canonicalLegacySystemProjectId,
  mapCanonicalLegacyLearnings,
  submitCanonicalLegacyLearnings,
} from "../canonical-legacy-intake.js";
import {
  acceptMemoryRunReceipt,
  MemoryReceiptError,
} from "../memory-receipts.js";
import {
  markMemoryCandidateActive,
  validateMemoryCandidate,
} from "../memory-candidates.js";

const ORG_ID = "org-canonical-legacy-intake";
const PROJECT_ID = "project-canonical-legacy-intake";
const OCCURRED_AT = "2026-08-09T12:00:00.000Z";

function learning(
  type: EnhancedPodLearning["type"],
  suffix: string,
  confidenceScore = 0.8,
): EnhancedPodLearning {
  return {
    type,
    summary: `Canonical legacy learning ${suffix}`,
    details: `Canonical legacy learning ${suffix} preserves all source detail while it awaits explicit validation and review.`,
    retrieval_text: `retrieval ${suffix}`,
    entity_refs: [{ type: "component", id: `entity-${suffix}`, key: `entity-${suffix}`, label: suffix }],
    scopes: ["memory"],
    topics: ["canonical-intake"],
    domains: ["memory", suffix],
    confidence: confidenceScore >= 0.8 ? "extracted" : "inferred",
    confidence_score: confidenceScore,
    audience: "org",
    provenance: [{ source: "pod", source_id: `pod-${suffix}`, title: suffix }],
    ingestion_provenance: {
      kind: "agent_run",
      run_id: `run-${suffix}`,
      model: "test-model",
      evidence_node_ids: [],
      evidence_item_ids: [`evidence-${suffix}`],
    },
  };
}

beforeAll(() => {
  createTables();
  testDb.prepare(
    `INSERT INTO users (user_id, email, display_name, is_service, created_at)
     VALUES ('canonical-intake-user', 'canonical-intake@local', 'Canonical Intake', 0, ?)`,
  ).run(OCCURRED_AT);
  testDb.prepare(
    `INSERT INTO orgs (org_id, slug, name, created_by_user_id, created_at)
     VALUES (?, 'canonical-legacy-intake', 'Canonical Legacy Intake', 'canonical-intake-user', ?)`,
  ).run(ORG_ID, OCCURRED_AT);
  testDb.prepare(
    `INSERT INTO projects
       (project_id, name, description, created_at, resources_json, org_id, created_by_user_id)
     VALUES (?, 'Canonical Intake Project', NULL, ?, '{}', ?, 'canonical-intake-user')`,
  ).run(PROJECT_ID, OCCURRED_AT, ORG_ID);
  testDb.prepare(
    `INSERT INTO memory_authority_transitions
       (transition_id, revision, from_authority, to_authority, legacy_writes_frozen,
        import_run_id, actor_id, reason_code, occurred_at)
     VALUES ('canonical-intake-transition-1', 1, 'legacy', 'migration_locked', 1,
             NULL, 'canonical-intake-test', 'offline_cutover_locked', ?)`,
  ).run(OCCURRED_AT);
  testDb.prepare(
    `INSERT INTO memory_authority_transitions
       (transition_id, revision, from_authority, to_authority, legacy_writes_frozen,
        import_run_id, actor_id, reason_code, occurred_at)
     VALUES ('canonical-intake-transition-2', 2, 'migration_locked', 'canonical', 1,
             NULL, 'canonical-intake-test', 'offline_cutover_complete', ?)`,
  ).run(OCCURRED_AT);
});

afterAll(() => {
  testDb.close();
});

describe("canonical intake for frozen legacy producers", () => {
  it("maps every legacy learning kind losslessly with additive selection counters", () => {
    const mapped = mapCanonicalLegacyLearnings({
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      usedSystemProject: false,
      source: {
        kind: "pod_archival",
        sourceId: "pod-mapping",
        sourceLabel: "Mapping Pod",
        projectId: PROJECT_ID,
        occurredAt: OCCURRED_AT,
      },
      learnings: [
        learning("decision", "decision"),
        learning("pattern", "pattern"),
        learning("anti_pattern", "anti-pattern"),
        learning("resolved_conflict", "conflict"),
        learning("scope_insight", "scope"),
        learning("decision", "low-confidence", 0.2),
        { ...learning("decision", "unmappable"), type: "unknown" as EnhancedPodLearning["type"] },
      ],
    });

    expect(mapped.counters).toEqual({
      total: 7,
      selected: 5,
      dropped_low_confidence: 1,
      dropped_unmappable: 1,
      dropped_over_cap: 0,
    });
    const bySourceType = new Map(mapped.candidates.map((item) => [
      item.candidate.extensions?.source_learning_type,
      item,
    ]));
    expect(bySourceType.get("decision")?.candidate.kind).toBe("decision");
    expect(bySourceType.get("pattern")?.candidate.kind).toBe("constraint");
    expect(bySourceType.get("anti_pattern")?.candidate.kind).toBe("anti_pattern");
    expect(bySourceType.get("resolved_conflict")?.candidate.kind).toBe("decision");
    expect(bySourceType.get("scope_insight")?.candidate.kind).toBe("constraint");
    for (const item of mapped.candidates) {
      expect(item.candidate).toMatchObject({
        plane: "org",
        validation: { strategy: "policy_owner_review" },
        activation_requirement_requested: "manual_policy_owner",
      });
      expect(item.candidate.extensions).toMatchObject({
        source_retrieval_text: expect.any(String),
        source_entity_refs_json: expect.any(String),
        source_domains_json: expect.any(String),
        source_payload_digest: `sha256:${item.contentDigest}`,
      });
      expect(item.evidenceManifest.refs[0]?.uri).toMatch(
        /^pim:\/\/memory-source\/pod_archival\/[0-9a-f]{32}\/[0-9a-f]{64}$/,
      );
    }
  });

  it("submits one canonical receipt per selected learning and replays after input reorder", () => {
    const source = {
      kind: "pod_archival" as const,
      sourceId: "pod-reorder-replay",
      sourceLabel: "Reorder Replay Pod",
      projectId: PROJECT_ID,
      occurredAt: OCCURRED_AT,
    };
    const firstLearning = learning("decision", "reorder-first", 0.9);
    const secondLearning = learning("pattern", "reorder-second", 0.8);
    const first = submitCanonicalLegacyLearnings({
      orgId: ORG_ID,
      source,
      learnings: [firstLearning, secondLearning],
      now: OCCURRED_AT,
    });
    const replay = submitCanonicalLegacyLearnings({
      orgId: ORG_ID,
      source,
      learnings: [secondLearning, firstLearning],
      now: "2026-08-10T12:00:00.000Z",
    });

    expect(first.candidatesSubmitted).toBe(2);
    expect(first.candidatesCreated).toBe(2);
    expect(replay.candidatesSubmitted).toBe(2);
    expect(replay.candidatesCreated).toBe(0);
    expect(replay.submissions.map((item) => item.candidateId))
      .toEqual(first.submissions.map((item) => item.candidateId));
    expect(testDb.prepare(
      "SELECT COUNT(*) AS count FROM memory_run_receipts WHERE producer_run_id LIKE 'legacy-intake:pod_archival:%'",
    ).get()).toMatchObject({ count: 2 });
    expect(testDb.prepare(
      "SELECT COUNT(*) AS count FROM memory_candidates_v1 WHERE producer_harness_id = 'pim-internal'",
    ).get()).toMatchObject({ count: 2 });
    expect(testDb.prepare(
      "SELECT COUNT(*) AS count FROM memory_v2_facet_quarantine WHERE source_plane = 'org'",
    ).get()).toMatchObject({ count: 4 });
    expect(testDb.prepare("SELECT COUNT(*) AS count FROM memory_candidates").get())
      .toMatchObject({ count: 0 });
    expect(testDb.prepare("SELECT COUNT(*) AS count FROM knowledge_nodes").get())
      .toMatchObject({ count: 0 });

    const candidateId = first.submissions[0]!.candidateId;
    const validated = validateMemoryCandidate(candidateId, 1);
    expect(validated).toMatchObject({
      current_status: "pending_review",
      activation_requirement: "manual_policy_owner",
      aggregate_version: 3,
    });
    expect(JSON.parse(validated.blockers_json)).toEqual(["manual_policy_owner_required"]);
    expect(() => markMemoryCandidateActive({
      candidateId,
      expectedVersion: 3,
      recordId: "record-forbidden-autoactivation",
      recordVersion: 1,
      actorId: "automatic-validator",
      fromStatus: "pending_review",
    })).toThrow(/activation policy/i);
  });

  it("returns a typed conflict when a stable archive slot changes content", () => {
    const source = {
      kind: "pod_archival" as const,
      sourceId: "pod-content-conflict",
      sourceLabel: "Conflict Pod",
      projectId: PROJECT_ID,
      occurredAt: OCCURRED_AT,
    };
    submitCanonicalLegacyLearnings({
      orgId: ORG_ID,
      source,
      learnings: [learning("decision", "original")],
      now: OCCURRED_AT,
    });
    expect(() => submitCanonicalLegacyLearnings({
      orgId: ORG_ID,
      source,
      learnings: [learning("decision", "changed")],
      now: OCCURRED_AT,
    })).toThrowError(CanonicalLegacyIntakeConflictError);
  });

  it("creates the stable system project lazily and keeps org receipts internal-only", () => {
    const systemProjectId = canonicalLegacySystemProjectId(ORG_ID);
    const empty = submitCanonicalLegacyLearnings({
      orgId: ORG_ID,
      source: {
        kind: "ad_hoc",
        sourceId: "low-confidence-system-project",
        sourceLabel: "Low Confidence",
        occurredAt: OCCURRED_AT,
      },
      learnings: [learning("decision", "too-low", 0.2)],
      now: OCCURRED_AT,
    });
    expect(empty.candidatesSubmitted).toBe(0);
    expect(testDb.prepare("SELECT 1 FROM projects WHERE project_id = ?").get(systemProjectId))
      .toBeUndefined();

    const accepted = submitCanonicalLegacyLearnings({
      orgId: ORG_ID,
      source: {
        kind: "ad_hoc",
        sourceId: "system-project-submission",
        sourceLabel: "System Project Submission",
        occurredAt: OCCURRED_AT,
      },
      learnings: [learning("decision", "system-project")],
      now: OCCURRED_AT,
    });
    expect(accepted).toMatchObject({
      projectId: systemProjectId,
      usedSystemProject: true,
      candidatesSubmitted: 1,
      candidatesCreated: 1,
    });
    expect(testDb.prepare(
      "SELECT COUNT(*) AS count FROM projects WHERE project_id = ? AND org_id = ?",
    ).get(systemProjectId, ORG_ID)).toMatchObject({ count: 1 });

    const receiptRow = testDb.prepare(
      "SELECT producer_run_id, receipt_json FROM memory_run_receipts WHERE receipt_id = ?",
    ).get(accepted.submissions[0]!.receiptId) as {
      producer_run_id: string;
      receipt_json: string;
    };
    expect(() => acceptMemoryRunReceipt({
      orgId: ORG_ID,
      projectId: systemProjectId,
      principalId: "svcprn-external-producer",
      producerRunId: receiptRow.producer_run_id,
      repository: null,
      receipt: JSON.parse(receiptRow.receipt_json) as RunReceiptV1,
      now: OCCURRED_AT,
    })).toThrowError(expect.objectContaining({
      name: MemoryReceiptError.name,
      code: "schema_invalid",
    }));
  });
});
