import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalJsonSha256 } from "@pim/shared";
import db from "../../db/connection.js";
import {
  createMemoryTestContext,
  type MemoryTestContext,
} from "../../routes/__tests__/memory-test-app.js";
import { importActiveHarnessMemoryRecord } from "../memory-harness-records.js";
import {
  assertMemoryV2HarnessServingReady,
  reconcileMemoryV2HarnessReadFacets,
} from "../memory-v2-harness-facets.js";
import type { ThinV1MemoryKind } from "../memory-structural-validator.js";

const NOW = "2026-08-09T18:00:00.000Z";

let context: MemoryTestContext;
const records = new Map<ThinV1MemoryKind, string>();

function importHarnessRecord(kind: ThinV1MemoryKind): string {
  const suffix = randomUUID();
  const recordId = `slice4-harness-${kind}-${suffix}`;
  const evidenceDigest = canonicalJsonSha256({ recordId, kind });
  importActiveHarnessMemoryRecord({
    orgId: context.orgA.id,
    projectId: context.projectA,
    recordId,
    kind,
    content: {
      summary: `Harness ${kind} guidance ${suffix}.`,
      details: `This canonical harness ${kind} record provides bounded recovery guidance for an exact Example harness A failure fingerprint.`,
      rationale: "The guidance is useful only for the exact harness and workflow selectors under review.",
    },
    applicability: {
      harness_id: "example-harness-a",
      harness_version_range: "harness-shadow-v1",
      workflow_version_range: "code-change.v3",
      adapter_version_range: "example-harness-a-pim-adapter.v1",
      configuration_ids: ["routing-default-v2"],
      model_ids: ["gpt-slice4"],
      tool_ids: ["terminal-state-inspector"],
    },
    exceptions: ["Do not apply outside the exact Example harness A recovery workflow."],
    compatibility: {
      harness_version_range: "harness-shadow-v1",
      workflow_version_range: "code-change.v3",
      adapter_version_range: "example-harness-a-pim-adapter.v1",
    },
    validation: {
      strategy: "stable_failure_fingerprint",
      failure_fingerprint: `slice4:${kind}:terminal-state-unknown`,
    },
    evidence: [{
      evidence_ref_id: `slice4-evidence-${suffix}`,
      type: "failure",
      digest: evidenceDigest,
      origin_id: `example-harness-a:slice4:${suffix}`,
      source_authority: "observed",
    }],
    evidenceSummary: { strength: "observed", ref_count: 1 },
    freshness: { last_confirmed_at: NOW, expires_at: null },
    provenance: { producer: "slice4-facet-test", extractor_version: "v1" },
    actorId: "slice4-reviewer",
    decisionRefs: [`slice4-decision-${suffix}`],
    reasonCode: "slice4_harness_fixture_approved",
    explanation: "An authorized reviewer admitted this permanent-shadow harness fixture.",
    now: NOW,
  });
  records.set(kind, recordId);
  return recordId;
}

beforeAll(async () => {
  context = await createMemoryTestContext();
});

afterAll(async () => {
  if (context) await context.app.close();
});

describe("memory v2 harness facet reconciliation", () => {
  it("records a genuinely empty harness backfill as valid and ready", () => {
    expect(reconcileMemoryV2HarnessReadFacets({ now: NOW })).toEqual({
      sourceRecordVersionCount: 0,
      mappedRecordVersionCount: 0,
      quarantinedRecordVersionCount: 0,
      ambiguousRecordVersionCount: 0,
      legacyEligibleRecordVersionCount: 0,
      serveableRecordVersionCount: 0,
      quarantinedLegacyEligibleRecordVersionCount: 0,
      representabilityMismatchCount: 0,
      companionCountMismatch: 0,
      mismatchCount: 0,
      emptyBackfill: true,
      ok: true,
    });
  });

  it("maps every lossless legacy kind and quarantines the ambiguous broad kind", () => {
    for (const kind of [
      "decision",
      "anti_pattern",
      "test_strategy",
      "constraint",
    ] as const) importHarnessRecord(kind);

    expect(db.prepare(
      `SELECT record.kind, facet.subtype, facet.projection_status
       FROM memory_records AS record
       INNER JOIN memory_v2_record_facets AS facet
         ON facet.record_id = record.record_id AND facet.record_version = 1
       WHERE record.record_id IN (?, ?, ?)
       ORDER BY record.kind`,
    ).all(
      records.get("decision")!,
      records.get("anti_pattern")!,
      records.get("test_strategy")!,
    )).toEqual([
      { kind: "anti_pattern", subtype: "failure_pattern", projection_status: "mapped" },
      { kind: "decision", subtype: "workflow_strategy", projection_status: "mapped" },
      { kind: "test_strategy", subtype: "verification_sequence", projection_status: "mapped" },
    ]);
    expect(db.prepare(
      `SELECT source_plane, reason_code
       FROM memory_v2_facet_quarantine
       WHERE aggregate_type = 'record' AND aggregate_id = ? AND aggregate_version = 1`,
    ).get(records.get("constraint")!)).toEqual({
      source_plane: "harness",
      reason_code: "subtype_ambiguous",
    });
    expect(db.prepare(
      "SELECT 1 FROM memory_v2_record_facets WHERE record_id = ? AND record_version = 1",
    ).get(records.get("constraint")!)).toBeUndefined();

    expect(assertMemoryV2HarnessServingReady({ now: NOW })).toMatchObject({
      sourceRecordVersionCount: 4,
      mappedRecordVersionCount: 3,
      quarantinedRecordVersionCount: 1,
      ambiguousRecordVersionCount: 1,
      legacyEligibleRecordVersionCount: 4,
      serveableRecordVersionCount: 3,
      quarantinedLegacyEligibleRecordVersionCount: 1,
      representabilityMismatchCount: 0,
      mismatchCount: 0,
      emptyBackfill: false,
      ok: true,
    });
  });

  it("keeps harness serving closed when an exact mapped facet no longer reconciles", () => {
    const recordId = records.get("decision")!;
    const trigger = db.prepare(
      `SELECT sql FROM sqlite_schema
       WHERE type = 'trigger' AND name = 'memory_v2_record_facets_no_update'`,
    ).get() as { sql: string };
    const row = db.prepare(
      `SELECT facet_json FROM memory_v2_record_facets
       WHERE record_id = ? AND record_version = 1`,
    ).get(recordId) as { facet_json: string };
    db.exec("DROP TRIGGER memory_v2_record_facets_no_update");
    try {
      db.prepare(
        `UPDATE memory_v2_record_facets SET facet_json = '{}'
         WHERE record_id = ? AND record_version = 1`,
      ).run(recordId);
      expect(reconcileMemoryV2HarnessReadFacets({ now: NOW })).toMatchObject({
        mismatchCount: 1,
        ok: false,
      });
      expect(() => assertMemoryV2HarnessServingReady({ now: NOW }))
        .toThrow(/serving remains closed/);
    } finally {
      db.prepare(
        `UPDATE memory_v2_record_facets SET facet_json = ?
         WHERE record_id = ? AND record_version = 1`,
      ).run(row.facet_json, recordId);
      db.exec(trigger.sql);
    }
    expect(assertMemoryV2HarnessServingReady({ now: NOW }).ok).toBe(true);
  });

  it("keeps serving closed when a mapped v1 record is not representable by v2", () => {
    const recordId = records.get("decision")!;
    const trigger = db.prepare(
      `SELECT sql FROM sqlite_schema
       WHERE type = 'trigger' AND name = 'memory_record_versions_no_update'`,
    ).get() as { sql: string };
    const row = db.prepare(
      `SELECT evidence_json FROM memory_record_versions
       WHERE record_id = ? AND record_version = 1`,
    ).get(recordId) as { evidence_json: string };
    const evidence = JSON.parse(row.evidence_json) as Array<Record<string, unknown>>;
    db.exec("DROP TRIGGER memory_record_versions_no_update");
    try {
      db.prepare(
        `UPDATE memory_record_versions SET evidence_json = ?
         WHERE record_id = ? AND record_version = 1`,
      ).run(JSON.stringify([{ ...evidence[0], type: "unsupported_incident" }]), recordId);
      expect(reconcileMemoryV2HarnessReadFacets({ now: NOW })).toMatchObject({
        representabilityMismatchCount: 1,
        mismatchCount: 1,
        ok: false,
      });
      expect(() => assertMemoryV2HarnessServingReady({ now: NOW }))
        .toThrow(/serving remains closed/);
    } finally {
      db.prepare(
        `UPDATE memory_record_versions SET evidence_json = ?
         WHERE record_id = ? AND record_version = 1`,
      ).run(row.evidence_json, recordId);
      db.exec(trigger.sql);
    }
    expect(assertMemoryV2HarnessServingReady({ now: NOW }).ok).toBe(true);
  });
});
