import db from "../../db/connection.js";
import type { OrgTuning } from "@pim/shared";
import { getOrgTuning, setOrgTuning } from "../../services/org-settings.js";

/** Minimum archived pods required before the tuning agent makes any adjustments. */
const MIN_PODS_REQUIRED = 3;

/** Most recent pods analyzed per tuning cycle. */
const PODS_LOOKBACK = 10;

/** Maximum nudge magnitude for any single threshold per cycle (prevents large sudden shifts). */
const MAX_NUDGE_FLOAT = 0.08;
const MAX_NUDGE_INT = 3;

interface TuningSignals {
  /** (dismissed conflicts) / total conflicts — proxy for false positive rate. Null if < 10 data points. */
  conflictFPRate: number | null;
  /** Average final_pressure across recent archived pods. */
  avgFinalPressure: number;
  /** (critical staleness findings) / all staleness findings. Null if < 5 data points. */
  stalenessAggression: number | null;
  podsAnalyzed: number;
}

interface Nudge {
  parameter: string;
  delta: number;
  signal: string;
  value: number;
}

type GuardRailEntry = [min: number, max: number];
const GUARD_RAILS: Record<string, GuardRailEntry> = {
  "conflictLic.additiveMinConf":     [0.40, 0.92],
  "conflictLic.overlapForceMinConf": [0.40, 0.92],
  "pressure.normalMax":                [0.10, 0.45],
  "pressure.cautiousMax":              [0.30, 0.75],
  "lint.stalenessHours":               [4,    72  ],
};

function getNestedValue(tuning: OrgTuning, parameter: string): number {
  const [group, field] = parameter.split(".");
  const g = tuning[group as keyof OrgTuning] as Record<string, number>;
  return g[field] ?? 0;
}

function setNestedValue(tuning: OrgTuning, parameter: string, value: number): OrgTuning {
  const [group, field] = parameter.split(".");
  const updated = { ...tuning, [group]: { ...(tuning[group as keyof OrgTuning] as object), [field]: value } };
  return updated as OrgTuning;
}

function clampNudge(current: number, delta: number, parameter: string): number {
  const isInt = parameter.endsWith("Hours") || parameter.endsWith("Window") || parameter.endsWith("window");
  const maxNudge = isInt ? MAX_NUDGE_INT : MAX_NUDGE_FLOAT;
  const clampedDelta = Math.max(-maxNudge, Math.min(maxNudge, delta));
  const newValue = current + clampedDelta;
  const [min, max] = GUARD_RAILS[parameter] ?? [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY];
  return Math.max(min, Math.min(max, newValue));
}

function computeSignals(orgId: string): TuningSignals | null {
  const archivedPods = db
    .prepare(
      "SELECT pod_id FROM archived_pods WHERE org_id = ? ORDER BY completed_date DESC LIMIT ?",
    )
    .all(orgId, PODS_LOOKBACK) as { pod_id: string }[];

  if (archivedPods.length < MIN_PODS_REQUIRED) return null;

  const podIds = archivedPods.map((p) => p.pod_id);
  const placeholders = podIds.map(() => "?").join(",");

  const conflictStats = db
    .prepare(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN status = 'dismissed' THEN 1 ELSE 0 END) as dismissed
       FROM conflicts WHERE pod_id IN (${placeholders})`,
    )
    .get(...podIds) as { total: number; dismissed: number };

  const conflictFPRate =
    conflictStats.total >= 10
      ? conflictStats.dismissed / conflictStats.total
      : null;

  const pressureStats = db
    .prepare("SELECT AVG(final_pressure) as avg FROM archived_pods WHERE org_id = ? AND pod_id IN (" + placeholders + ")")
    .get(orgId, ...podIds) as { avg: number };

  const stalenessStats = db
    .prepare(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) as critical
       FROM lint_findings WHERE pod_id IN (${placeholders}) AND type = 'staleness'`,
    )
    .get(...podIds) as { total: number; critical: number };

  const stalenessAggression =
    stalenessStats.total >= 5
      ? stalenessStats.critical / stalenessStats.total
      : null;

  return {
    conflictFPRate,
    avgFinalPressure: pressureStats.avg ?? 0,
    stalenessAggression,
    podsAnalyzed: archivedPods.length,
  };
}

function computeNudges(signals: TuningSignals, current: OrgTuning): Nudge[] {
  const nudges: Nudge[] = [];

  if (signals.conflictFPRate !== null) {
    if (signals.conflictFPRate > 0.30) {
      nudges.push({ parameter: "conflictLic.additiveMinConf", delta: +0.05, signal: "conflict_false_positive_rate", value: signals.conflictFPRate });
      nudges.push({ parameter: "conflictLic.overlapForceMinConf", delta: +0.05, signal: "conflict_false_positive_rate", value: signals.conflictFPRate });
    } else if (signals.conflictFPRate < 0.05) {
      nudges.push({ parameter: "conflictLic.additiveMinConf", delta: -0.03, signal: "conflict_false_positive_rate", value: signals.conflictFPRate });
      nudges.push({ parameter: "conflictLic.overlapForceMinConf", delta: -0.03, signal: "conflict_false_positive_rate", value: signals.conflictFPRate });
    }
  }

  if (signals.avgFinalPressure > 0.75) {
    nudges.push({ parameter: "pressure.cautiousMax", delta: -0.05, signal: "avg_final_pressure", value: signals.avgFinalPressure });
  } else if (signals.avgFinalPressure < 0.2 && signals.avgFinalPressure > 0) {
    nudges.push({ parameter: "pressure.normalMax", delta: +0.03, signal: "avg_final_pressure", value: signals.avgFinalPressure });
  }

  if (signals.stalenessAggression !== null) {
    if (signals.stalenessAggression > 0.5) {
      nudges.push({ parameter: "lint.stalenessHours", delta: +2, signal: "staleness_aggression_rate", value: signals.stalenessAggression });
    } else if (signals.stalenessAggression < 0.1) {
      nudges.push({ parameter: "lint.stalenessHours", delta: -1, signal: "staleness_aggression_rate", value: signals.stalenessAggression });
    }
  }

  return nudges;
}

function applyNudges(current: OrgTuning, nudges: Nudge[]): OrgTuning {
  let updated = current;
  for (const nudge of nudges) {
    const oldValue = getNestedValue(updated, nudge.parameter);
    const newValue = clampNudge(oldValue, nudge.delta, nudge.parameter);
    updated = setNestedValue(updated, nudge.parameter, newValue);
  }

  // Enforce pressure ordering invariant: normalMax < cautiousMax < degradedMax.
  // Re-read updated.pressure after each set so subsequent checks see the corrected values.
  if (updated.pressure.normalMax >= updated.pressure.cautiousMax) {
    updated = setNestedValue(updated, "pressure.normalMax", updated.pressure.cautiousMax - 0.05);
  }
  if (updated.pressure.cautiousMax >= updated.pressure.degradedMax) {
    updated = setNestedValue(updated, "pressure.cautiousMax", updated.pressure.degradedMax - 0.05);
  }

  return updated;
}

export async function runTuningAgent(orgId: string): Promise<void> {
  const signals = computeSignals(orgId);
  if (!signals) return;

  const current = getOrgTuning(orgId);
  const nudges = computeNudges(signals, current);
  if (nudges.length === 0) return;

  const updated = applyNudges(current, nudges);
  setOrgTuning(orgId, updated);

  const now = new Date().toISOString();
  const insertHistory = db.prepare(`
    INSERT INTO org_tuning_history
      (org_id, adjusted_at, signal_name, signal_value, parameter, old_value, new_value, pods_analyzed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const nudge of nudges) {
    const oldValue = getNestedValue(current, nudge.parameter);
    const newValue = getNestedValue(updated, nudge.parameter);
    if (oldValue !== newValue) {
      insertHistory.run(orgId, now, nudge.signal, nudge.value, nudge.parameter, oldValue, newValue, signals.podsAnalyzed);
    }
  }
}

export function getOrgTuningHistory(orgId: string, limit = 50): {
  id: number;
  adjusted_at: string;
  signal_name: string;
  signal_value: number;
  parameter: string;
  old_value: number;
  new_value: number;
  pods_analyzed: number;
}[] {
  return db
    .prepare(
      "SELECT id, adjusted_at, signal_name, signal_value, parameter, old_value, new_value, pods_analyzed FROM org_tuning_history WHERE org_id = ? ORDER BY adjusted_at DESC LIMIT ?",
    )
    .all(orgId, limit) as ReturnType<typeof getOrgTuningHistory>;
}

