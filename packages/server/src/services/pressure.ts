import db from "../db/connection.js";

interface ConflictRow {
  id: string;
  severity: string;
  created_at: string;
}

// Recalculate conflict pressure for a pod based on open conflicts
// Formula: base score per conflict + age bonus + severity weight
export function recalculatePressure(podId: string): number {
  const openConflicts = db.prepare(
    "SELECT id, severity, created_at FROM conflicts WHERE pod_id = ? AND status != 'resolved'"
  ).all(podId) as ConflictRow[];

  if (openConflicts.length === 0) return 0;

  const now = Date.now();
  let pressure = 0;

  for (const conflict of openConflicts) {
    // Base: 0.15 per blocking conflict, 0.08 per non-blocking
    const base = conflict.severity === "blocking" ? 0.15 : 0.08;

    // Age factor: conflicts older than 24h add extra pressure
    const ageHours = (now - new Date(conflict.created_at).getTime()) / (1000 * 60 * 60);
    const ageFactor = Math.min(ageHours / 48, 0.1); // caps at 0.1 extra

    pressure += base + ageFactor;
  }

  // Clamp to [0, 1]
  pressure = Math.min(Math.max(pressure, 0), 1);

  // Update pod and org summary
  db.prepare("UPDATE pods SET conflict_pressure = ? WHERE pod_id = ?").run(pressure, podId);
  db.prepare("UPDATE org_pod_summaries SET conflict_pressure = ?, open_conflicts = ? WHERE pod_id = ?")
    .run(pressure, openConflicts.length, podId);

  return pressure;
}
