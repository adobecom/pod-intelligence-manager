import db from "../db/connection.js";
import { broadcast } from "../ws/index.js";
import { recalculatePressure } from "./pressure.js";
import { notifyConflictEscalated, notifyPressureThreshold } from "./slack.js";

interface OpenConflictRow {
  id: string;
  pod_id: string;
  created_at: string;
  severity: string;
  escalation_level: number;
}

const THRESHOLDS = [
  { hours: 4, level: 1, message: "Conflict unresolved >4h — pinging contributors" },
  { hours: 8, level: 2, message: "Conflict unresolved >8h — re-pinging, consider pod lead review" },
  { hours: 16, level: 3, message: "Conflict unresolved >16h — escalating to pod lead" },
  { hours: 24, level: 4, message: "Conflict unresolved >24h — forcing critical status" },
];

export function checkEscalations(): void {
  const now = Date.now();
  const conflicts = db.prepare(
    "SELECT id, pod_id, created_at, severity, escalation_level FROM conflicts WHERE status != 'resolved'",
  ).all() as OpenConflictRow[];

  for (const conflict of conflicts) {
    const ageMs = now - new Date(conflict.created_at).getTime();
    const ageHours = ageMs / (1000 * 60 * 60);

    for (const threshold of THRESHOLDS) {
      if (ageHours >= threshold.hours && conflict.escalation_level < threshold.level) {
        // Update escalation level
        db.prepare("UPDATE conflicts SET escalation_level = ? WHERE id = ?").run(
          threshold.level,
          conflict.id,
        );

        // Snapshot previous pressure before recalculation
        const previousPressure = (db.prepare("SELECT conflict_pressure FROM pods WHERE pod_id = ?").get(conflict.pod_id) as { conflict_pressure: number } | undefined)?.conflict_pressure ?? 0;

        // At level 4 (24h), force pressure to 1.0
        if (threshold.level === 4) {
          db.prepare("UPDATE pods SET conflict_pressure = 1.0 WHERE pod_id = ?").run(
            conflict.pod_id,
          );
          broadcast({
            type: "pressure_changed",
            podId: conflict.pod_id,
            payload: { pressure: 1.0 },
          });
          notifyPressureThreshold(conflict.pod_id, 1.0, previousPressure);
        } else {
          // Recalculate pressure normally
          const newPressure = recalculatePressure(conflict.pod_id);
          broadcast({
            type: "pressure_changed",
            podId: conflict.pod_id,
            payload: { pressure: newPressure },
          });
          notifyPressureThreshold(conflict.pod_id, newPressure, previousPressure);
        }

        // Broadcast escalation event
        broadcast({
          type: "conflict_escalated",
          podId: conflict.pod_id,
          payload: {
            conflictId: conflict.id,
            level: threshold.level,
            message: threshold.message,
            ageHours: Math.round(ageHours),
          },
        });

        // Slack escalation notification
        notifyConflictEscalated(
          conflict.pod_id,
          conflict.id,
          threshold.level,
          threshold.message,
          Math.round(ageHours),
        );

        break; // Only escalate one level at a time
      }
    }
  }
}
