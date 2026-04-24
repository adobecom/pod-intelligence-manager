import db from "../db/connection.js";
import { DEFAULT_ORG_TUNING } from "@pim/shared";
import { getOrgTuning } from "./org-settings.js";

interface ConflictRow {
  id: string;
  severity: string;
  created_at: string;
}

/** Persist conflict pressure on `pods` and `org_pod_summaries` (open conflict count from DB). */
export function setPodPressure(podId: string, pressure: number): void {
  const row = db.prepare(
    "SELECT COUNT(*) as count FROM conflicts WHERE pod_id = ? AND status != 'resolved'",
  ).get(podId) as { count: number };
  db.prepare("UPDATE pods SET conflict_pressure = ? WHERE pod_id = ?").run(pressure, podId);
  db.prepare(
    "UPDATE org_pod_summaries SET conflict_pressure = ?, open_conflicts = ? WHERE pod_id = ?",
  ).run(pressure, row.count, podId);
}

// Recalculate conflict pressure for a pod based on open conflicts
// Formula: base score per conflict + age bonus + severity weight
export function recalculatePressure(podId: string, orgId?: string): number {
  const openConflicts = db.prepare(
    "SELECT id, severity, created_at FROM conflicts WHERE pod_id = ? AND status != 'resolved'",
  ).all(podId) as ConflictRow[];

  if (openConflicts.length === 0) {
    setPodPressure(podId, 0);
    return 0;
  }

  const pw = orgId ? getOrgTuning(orgId).pressureWeights : DEFAULT_ORG_TUNING.pressureWeights;
  const now = Date.now();
  let pressure = 0;

  for (const conflict of openConflicts) {
    const base = conflict.severity === "blocking" ? pw.blockingBase : pw.nonBlockingBase;
    const ageHours = (now - new Date(conflict.created_at).getTime()) / (1000 * 60 * 60);
    const ageFactor = Math.min(ageHours / pw.ageWindowHours, pw.ageFactorCap);
    pressure += base + ageFactor;
  }

  pressure = Math.min(Math.max(pressure, 0), 1);
  setPodPressure(podId, pressure);
  return pressure;
}
