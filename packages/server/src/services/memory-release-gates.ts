import { randomUUID } from "node:crypto";
import {
  canonicalJsonSha256,
  parseMemoryContract,
  type MemoryReleaseGateDecisionV1,
  type MemoryReleaseGateSnapshotV1,
} from "@pim/shared";
import db, { withImmediateTransaction } from "../db/connection.js";

export type MemoryReleaseGateStage = "pre_canary" | "expansion";
export type MemoryReleaseGateStatus = "pass" | "fail" | "insufficient_data";

export type MemoryReleaseGateSnapshot = MemoryReleaseGateSnapshotV1;
export type MemoryReleaseGateDecision = MemoryReleaseGateDecisionV1;

function finiteRate(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function missingSafetyData(snapshot: MemoryReleaseGateSnapshot): string[] {
  const missing: string[] = [];
  if (snapshot.representative_sample_count <= 0) missing.push("representative_sample_required");
  if (snapshot.reviewed_candidate_count <= 0) missing.push("reviewed_candidate_sample_required");
  if (!finiteRate(snapshot.provenance_completeness_rate)) missing.push("provenance_completeness_unmeasured");
  if (!finiteRate(snapshot.typed_round_trip_conformance_rate)) missing.push("typed_round_trip_unmeasured");
  if (!finiteRate(snapshot.extraction_precision_rate)) missing.push("extraction_precision_unmeasured");
  if (!finiteRate(snapshot.resolvable_evidence_rate)) missing.push("resolvable_evidence_unmeasured");
  if (!finiteRate(snapshot.harmful_or_stale_prompt_exposure_rate)) missing.push("harmful_stale_exposure_unmeasured");
  if (!finite(snapshot.pim_outage_blocked_execution_count)
      || !finite(snapshot.pim_outage_lost_queued_receipt_count)) {
    missing.push("pim_outage_evidence_unmeasured");
  }
  return missing;
}

function safetyFailures(snapshot: MemoryReleaseGateSnapshot): string[] {
  const failures: string[] = [];
  if (snapshot.known_boundary_leakage_count !== 0) failures.push("boundary_leakage_nonzero");
  if (snapshot.provenance_completeness_rate !== 1) failures.push("provenance_completeness_below_100_percent");
  if (snapshot.typed_round_trip_conformance_rate !== 1) failures.push("typed_round_trip_below_100_percent");
  if (snapshot.unresolved_active_pointer_count !== 0) failures.push("unresolved_active_pointers_nonzero");
  if ((snapshot.extraction_precision_rate ?? -1) < 0.95) failures.push("extraction_precision_below_95_percent");
  if ((snapshot.resolvable_evidence_rate ?? -1) < 0.95) failures.push("resolvable_evidence_below_95_percent");
  if ((snapshot.harmful_or_stale_prompt_exposure_rate ?? 1) >= 0.01) failures.push("harmful_stale_exposure_at_or_above_1_percent");
  if (snapshot.critical_policy_violation_count !== 0) failures.push("critical_policy_violation");
  if (snapshot.evidence_bypass_incident_count !== 0) failures.push("evidence_bypass_incident");
  if (snapshot.critical_harm_incident_count !== 0) failures.push("critical_harm_incident");
  if ((snapshot.pim_outage_blocked_execution_count ?? 1) !== 0) failures.push("pim_outage_blocked_execution");
  if ((snapshot.pim_outage_lost_queued_receipt_count ?? 1) !== 0) failures.push("pim_outage_lost_queued_receipt");
  return failures;
}

function missingExpansionData(snapshot: MemoryReleaseGateSnapshot): string[] {
  const missing: string[] = [];
  if (!finite(snapshot.memory_on_off_pair_count) || snapshot.memory_on_off_pair_count <= 0) {
    missing.push("memory_on_off_pairs_required");
  }
  const pathAData = finite(snapshot.task_pass_lift_percentage_points)
    && finite(snapshot.paired_95ci_lower_percentage_points);
  const pathBData = finite(snapshot.pass_rate_delta_percentage_points)
    && finite(snapshot.noninferiority_margin_percentage_points)
    && finite(snapshot.efficiency_reduction_rate);
  if (!pathAData && !pathBData) missing.push("investment_path_measurement_required");
  for (const [key, value] of [
    ["independent_reuse_unmeasured", snapshot.same_record_helpful_independent_runs],
    ["latency_cost_change_unmeasured", snapshot.latency_or_cost_increase_rate],
    ["disciplined_cycle_count_unmeasured", snapshot.disciplined_no_lift_cycles],
  ] as const) {
    if (!finite(value)) missing.push(key);
  }
  return missing;
}

function expansionFailures(snapshot: MemoryReleaseGateSnapshot): string[] {
  const failures: string[] = [];
  const pathA = snapshot.task_pass_lift_percentage_points! >= 5
    && snapshot.paired_95ci_lower_percentage_points! >= 0;
  const pathB = snapshot.pass_rate_delta_percentage_points!
      >= -snapshot.noninferiority_margin_percentage_points!
    && snapshot.efficiency_reduction_rate! >= 0.2;
  if (!pathA && !pathB) failures.push("investment_criterion_not_met");
  if (snapshot.same_record_helpful_independent_runs! < 2) {
    failures.push("same_record_not_helpful_in_two_independent_runs");
  }
  if (snapshot.latency_or_cost_increase_rate! > 0.1) {
    failures.push("uncompensated_latency_or_cost_increase_above_10_percent");
  }
  if (snapshot.disciplined_no_lift_cycles! >= 2) {
    failures.push("two_disciplined_cycles_without_lift");
  }
  return failures;
}

function shouldTripKillSwitch(snapshot: MemoryReleaseGateSnapshot): boolean {
  return snapshot.known_boundary_leakage_count > 0
    || snapshot.critical_policy_violation_count > 0
    || snapshot.evidence_bypass_incident_count > 0
    || snapshot.critical_harm_incident_count > 0;
}

export function evaluateMemoryReleaseGates(input: {
  orgId: string;
  projectId: string;
  stage: MemoryReleaseGateStage;
  datasetDigest: string;
  snapshot: MemoryReleaseGateSnapshot;
  now?: string;
}): MemoryReleaseGateDecision {
  if (!/^sha256:[0-9a-f]{64}$/.test(input.datasetDigest)) {
    throw new TypeError("datasetDigest must be a canonical sha256 digest");
  }
  const now = input.now ?? new Date().toISOString();
  const normalizedSnapshot = JSON.parse(JSON.stringify(input.snapshot)) as MemoryReleaseGateSnapshot;
  const missing = missingSafetyData(input.snapshot);
  if (input.stage === "expansion") missing.push(...missingExpansionData(input.snapshot));
  const failures = missing.length === 0 ? safetyFailures(input.snapshot) : [];
  if (input.stage === "expansion" && missing.length === 0 && failures.length === 0) {
    failures.push(...expansionFailures(input.snapshot));
  }
  const status: MemoryReleaseGateStatus = missing.length > 0
    ? "insufficient_data"
    : failures.length > 0
      ? "fail"
      : "pass";
  const reasons = status === "insufficient_data" ? [...new Set(missing)] : [...new Set(failures)];
  const decision = parseMemoryContract("MemoryReleaseGateDecisionV1", {
    schema_version: "pim.memory-release-gate-decision.v1",
    project_id: input.projectId,
    decision_id: `gate_${randomUUID()}`,
    stage: input.stage,
    decision: status === "pass" ? "continue" : "pause",
    status,
    dataset_digest: input.datasetDigest,
    metric_snapshot_digest: canonicalJsonSha256(normalizedSnapshot),
    reasons,
    created_at: now,
  });
  return withImmediateTransaction(() => {
    db.prepare(
      `INSERT INTO memory_release_gate_decisions
         (decision_id, org_id, project_id, stage, decision, status,
          metric_snapshot_json, dataset_digest, reasons_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      decision.decision_id,
      input.orgId,
      input.projectId,
      input.stage,
      decision.decision,
      decision.status,
      JSON.stringify(normalizedSnapshot),
      input.datasetDigest,
      JSON.stringify(decision.reasons),
      now,
    );
    if (shouldTripKillSwitch(input.snapshot)) {
      db.prepare(
        `UPDATE memory_prompt_policies
         SET kill_switch = 1, automatic_activation_enabled = 0,
             policy_revision = policy_revision + 1,
             updated_by_principal_id = 'release-gate-evaluator', updated_at = ?
         WHERE org_id = ? AND project_id = ?`,
      ).run(now, input.orgId, input.projectId);
    }
    return decision;
  });
}

export function listMemoryReleaseGateDecisions(
  orgId: string,
  projectId: string,
): MemoryReleaseGateDecision[] {
  return (db.prepare(
    `SELECT decision_id, stage, decision, status, dataset_digest,
            metric_snapshot_json, reasons_json, created_at
     FROM memory_release_gate_decisions
     WHERE org_id = ? AND project_id = ?
     ORDER BY created_at, decision_id`,
  ).all(orgId, projectId) as unknown as Array<{
    decision_id: string;
    stage: MemoryReleaseGateStage;
    decision: "continue" | "pause";
    status: MemoryReleaseGateStatus;
    dataset_digest: string;
    metric_snapshot_json: string;
    reasons_json: string;
    created_at: string;
  }>).map((row) => ({
    schema_version: "pim.memory-release-gate-decision.v1",
    project_id: projectId,
    decision_id: row.decision_id,
    stage: row.stage,
    decision: row.decision,
    status: row.status,
    dataset_digest: row.dataset_digest,
    metric_snapshot_digest: canonicalJsonSha256(JSON.parse(row.metric_snapshot_json) as unknown),
    reasons: JSON.parse(row.reasons_json) as string[],
    created_at: row.created_at,
  }));
}
