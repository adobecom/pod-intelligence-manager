import { afterAll, beforeAll, describe, expect, it } from "vitest";
import db from "../../db/connection.js";
import { createMemoryTestContext, type MemoryTestContext } from "../../routes/__tests__/memory-test-app.js";
import {
  evaluateMemoryReleaseGates,
  listMemoryReleaseGateDecisions,
  type MemoryReleaseGateSnapshot,
} from "../memory-release-gates.js";

const DATASET_DIGEST = `sha256:${"d".repeat(64)}`;
let context: MemoryTestContext;

function safetySnapshot(
  overrides: Partial<MemoryReleaseGateSnapshot> = {},
): MemoryReleaseGateSnapshot {
  return {
    representative_sample_count: 100,
    reviewed_candidate_count: 100,
    known_boundary_leakage_count: 0,
    provenance_completeness_rate: 1,
    typed_round_trip_conformance_rate: 1,
    unresolved_active_pointer_count: 0,
    extraction_precision_rate: 0.95,
    resolvable_evidence_rate: 0.95,
    harmful_or_stale_prompt_exposure_rate: 0.0099,
    critical_policy_violation_count: 0,
    evidence_bypass_incident_count: 0,
    critical_harm_incident_count: 0,
    pim_outage_blocked_execution_count: 0,
    pim_outage_lost_queued_receipt_count: 0,
    memory_on_off_pair_count: null,
    task_pass_lift_percentage_points: null,
    paired_95ci_lower_percentage_points: null,
    pass_rate_delta_percentage_points: null,
    noninferiority_margin_percentage_points: null,
    efficiency_reduction_rate: null,
    same_record_helpful_independent_runs: null,
    latency_or_cost_increase_rate: null,
    disciplined_no_lift_cycles: null,
    ...overrides,
  };
}

function expansionSnapshot(
  overrides: Partial<MemoryReleaseGateSnapshot> = {},
): MemoryReleaseGateSnapshot {
  return safetySnapshot({
    memory_on_off_pair_count: 50,
    task_pass_lift_percentage_points: 5,
    paired_95ci_lower_percentage_points: 0,
    same_record_helpful_independent_runs: 2,
    latency_or_cost_increase_rate: 0.1,
    disciplined_no_lift_cycles: 1,
    ...overrides,
  });
}

beforeAll(async () => {
  context = await createMemoryTestContext();
});

afterAll(async () => {
  if (context) await context.app.close();
});

describe("Slice 5 quantitative release gates", () => {
  it("passes the exact pre-canary safety boundaries and persists an append-only decision", () => {
    const result = evaluateMemoryReleaseGates({
      orgId: context.orgA.id,
      projectId: context.projectA,
      stage: "pre_canary",
      datasetDigest: DATASET_DIGEST,
      snapshot: safetySnapshot(),
      now: "2026-08-03T22:00:00.000Z",
    });
    expect(result).toMatchObject({ status: "pass", decision: "continue", reasons: [] });
    expect(listMemoryReleaseGateDecisions(context.orgA.id, context.projectA)).toContainEqual(result);
    expect(() => db.prepare(
      "UPDATE memory_release_gate_decisions SET status = 'fail' WHERE decision_id = ?",
    ).run(result.decision_id)).toThrow(/append-only/);
  });

  it("fails closed for missing representative evidence and at the strict safety boundaries", () => {
    const insufficient = evaluateMemoryReleaseGates({
      orgId: context.orgA.id,
      projectId: context.projectA,
      stage: "pre_canary",
      datasetDigest: DATASET_DIGEST,
      snapshot: safetySnapshot({ representative_sample_count: 0 }),
    });
    expect(insufficient).toMatchObject({ status: "insufficient_data", decision: "pause" });
    expect(insufficient.reasons).toContain("representative_sample_required");

    const failed = evaluateMemoryReleaseGates({
      orgId: context.orgA.id,
      projectId: context.projectA,
      stage: "pre_canary",
      datasetDigest: DATASET_DIGEST,
      snapshot: safetySnapshot({
        extraction_precision_rate: 0.9499,
        harmful_or_stale_prompt_exposure_rate: 0.01,
      }),
    });
    expect(failed).toMatchObject({ status: "fail", decision: "pause" });
    expect(failed.reasons).toEqual(expect.arrayContaining([
      "extraction_precision_below_95_percent",
      "harmful_stale_exposure_at_or_above_1_percent",
    ]));
  });

  it("accepts either documented investment path at its exact boundary", () => {
    const lift = evaluateMemoryReleaseGates({
      orgId: context.orgA.id,
      projectId: context.projectA,
      stage: "expansion",
      datasetDigest: DATASET_DIGEST,
      snapshot: expansionSnapshot(),
    });
    expect(lift).toMatchObject({ status: "pass", decision: "continue" });

    const nonInferior = evaluateMemoryReleaseGates({
      orgId: context.orgA.id,
      projectId: context.projectA,
      stage: "expansion",
      datasetDigest: DATASET_DIGEST,
      snapshot: expansionSnapshot({
        task_pass_lift_percentage_points: null,
        paired_95ci_lower_percentage_points: null,
        pass_rate_delta_percentage_points: -2,
        noninferiority_margin_percentage_points: 2,
        efficiency_reduction_rate: 0.2,
      }),
    });
    expect(nonInferior).toMatchObject({ status: "pass", decision: "continue" });
  });

  it("pauses expansion for weak reuse, excess overhead, or two no-lift cycles", () => {
    const result = evaluateMemoryReleaseGates({
      orgId: context.orgA.id,
      projectId: context.projectA,
      stage: "expansion",
      datasetDigest: DATASET_DIGEST,
      snapshot: expansionSnapshot({
        same_record_helpful_independent_runs: 1,
        latency_or_cost_increase_rate: 0.1001,
        disciplined_no_lift_cycles: 2,
      }),
    });
    expect(result).toMatchObject({ status: "fail", decision: "pause" });
    expect(result.reasons).toEqual(expect.arrayContaining([
      "same_record_not_helpful_in_two_independent_runs",
      "uncompensated_latency_or_cost_increase_above_10_percent",
      "two_disciplined_cycles_without_lift",
    ]));
  });

  it("trips the project kill switch immediately after a critical boundary incident", () => {
    const now = "2026-08-03T23:00:00.000Z";
    db.prepare(
      `INSERT INTO memory_prompt_policies
         (org_id, project_id, policy_revision, enabled, kill_switch,
          automatic_activation_enabled, canary_percentage,
          allowed_repository_ids_json, allowed_kinds_json, max_prompt_items,
          max_prompt_tokens, updated_by_principal_id, created_at, updated_at)
       VALUES (?, ?, 1, 1, 0, 1, 100, ?, ?, 2, 600, 'gate-test', ?, ?)`,
    ).run(
      context.orgA.id,
      context.projectA,
      JSON.stringify(["github.com/acme/checkout"]),
      JSON.stringify(["anti_pattern"]),
      now,
      now,
    );
    const result = evaluateMemoryReleaseGates({
      orgId: context.orgA.id,
      projectId: context.projectA,
      stage: "pre_canary",
      datasetDigest: DATASET_DIGEST,
      snapshot: safetySnapshot({ known_boundary_leakage_count: 1 }),
      now,
    });
    expect(result).toMatchObject({ status: "fail", decision: "pause" });
    expect(db.prepare(
      `SELECT kill_switch, automatic_activation_enabled, policy_revision,
              updated_by_principal_id
       FROM memory_prompt_policies WHERE org_id = ? AND project_id = ?`,
    ).get(context.orgA.id, context.projectA)).toEqual({
      kill_switch: 1,
      automatic_activation_enabled: 0,
      policy_revision: 2,
      updated_by_principal_id: "release-gate-evaluator",
    });
  });
});
