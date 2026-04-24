import db from "../db/connection.js";
import { broadcast } from "../ws/index.js";
import { recalculatePressure, setPodPressure } from "./pressure.js";
import { notifyConflictEscalated, notifyPressureThreshold, notifyQueueBacklog } from "./slack.js";
import { QUEUE_BACKLOG_THRESHOLD, notifiedBacklogPods } from "./ingestion-queue.js";

interface OpenConflictRow {
  id: string;
  pod_id: string;
  created_at: string;
  severity: string;
  escalation_level: number;
  slack_message_ts: string | null;
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
    "SELECT id, pod_id, created_at, severity, escalation_level, slack_message_ts FROM conflicts WHERE status != 'resolved'",
  ).all() as unknown as OpenConflictRow[];

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

        // At level 4 (24h), force pressure to 1.0 (pods + org_pod_summaries)
        if (threshold.level === 4) {
          setPodPressure(conflict.pod_id, 1.0);
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

        // Slack escalation notification — thread under the original conflict
        // post when available so the channel sees one coherent conversation.
        notifyConflictEscalated(
          conflict.pod_id,
          conflict.id,
          threshold.level,
          threshold.message,
          Math.round(ageHours),
          conflict.slack_message_ts ?? undefined,
        );

        break; // Only escalate one level at a time
      }
    }
  }

  // Safety-net: notify if any pod's queue has grown past the backlog threshold.
  // Uses the same in-memory set as the enqueue path to avoid spamming every 5 min.
  const backlogs = db.prepare(`
    SELECT pod_id, COUNT(*) as queue_size
    FROM ingestion_queue
    WHERE status = 'pending'
    GROUP BY pod_id
    HAVING COUNT(*) >= ?
  `).all(QUEUE_BACKLOG_THRESHOLD) as { pod_id: string; queue_size: number }[];

  for (const { pod_id, queue_size } of backlogs) {
    if (!notifiedBacklogPods.has(pod_id)) {
      notifiedBacklogPods.add(pod_id);
      notifyQueueBacklog(pod_id, queue_size);
    }
  }
}
