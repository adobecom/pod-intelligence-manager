import { randomUUID } from "crypto";
import db from "../db/connection.js";
import { ingestContextUpdate } from "./ingestion.js";
import { broadcast } from "../ws/index.js";

export const QUEUE_BACKLOG_THRESHOLD = parseInt(process.env.QUEUE_BACKLOG_THRESHOLD ?? "10", 10);

// In-memory set of pods for which a backlog notification has been sent this session.
// Cleared when the queue is drained, so fresh notifications fire after re-accumulation.
export const notifiedBacklogPods = new Set<string>();

interface QueueRow {
  id: string;
  pod_id: string;
  payload_json: string;
}

export function enqueueUpdate(podId: string, orgId: string | undefined, payload: unknown): string {
  const id = `iq-${randomUUID().slice(0, 8)}`;
  db.prepare(
    "INSERT INTO ingestion_queue (id, pod_id, org_id, payload_json, queued_at, status) VALUES (?, ?, ?, ?, ?, 'pending')"
  ).run(id, podId, orgId ?? null, JSON.stringify(payload), new Date().toISOString());
  return id;
}

export function getQueueSize(podId: string): number {
  const row = db.prepare(
    "SELECT COUNT(*) as count FROM ingestion_queue WHERE pod_id = ? AND status = 'pending'"
  ).get(podId) as { count: number };
  return row.count;
}

export async function drainQueue(podId: string): Promise<{ processed: number; errors: number }> {
  const rows = db.prepare(
    "SELECT id, pod_id, payload_json FROM ingestion_queue WHERE pod_id = ? AND status = 'pending' ORDER BY queued_at ASC"
  ).all(podId) as unknown as QueueRow[];

  let processed = 0;
  let errors = 0;

  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload_json);
      const result = await ingestContextUpdate(podId, payload);
      if (result.success || result.deduplicated) {
        db.prepare("UPDATE ingestion_queue SET status = 'processed' WHERE id = ?").run(row.id);
        processed++;
      } else {
        // Validation/scan failures are permanent — mark processed to unblock the queue
        db.prepare("UPDATE ingestion_queue SET status = 'processed' WHERE id = ?").run(row.id);
        console.warn(`[ingestion-queue] Dropping invalid queued item ${row.id}: ${result.error}`);
        processed++;
      }
    } catch (err) {
      console.error(`[ingestion-queue] Failed to process queued item ${row.id}:`, err);
      errors++;
    }
  }

  notifiedBacklogPods.delete(podId);

  broadcast({
    type: "queue_drained",
    podId,
    payload: { processed, errors },
  });

  return { processed, errors };
}
