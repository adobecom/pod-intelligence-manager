import db from "../db/connection.js";
import type { Milestone } from "@pim/shared";

/** Six scopes; must match `pod_areas` rows created for each pod. */
export const POD_SCOPES = ["frontend", "backend", "design", "qa", "infra", "pm"] as const;

interface LatestRow {
  agent_id: string;
  timestamp: string;
  type: string;
  scope: string;
  status: string;
}

/** Map ingestion work status to living-doc area status. */
export function workStatusToAreaStatus(workStatus: string): "done" | "in_progress" | "blocked" | "waiting" {
  switch (workStatus) {
    case "completed":
      return "done";
    case "in_progress":
      return "in_progress";
    case "blocked":
      return "blocked";
    default:
      return "waiting";
  }
}

/** Blocker updates always surface as blocked for the scope (even if `status` was mis-filed). */
export function resolveAreaStatus(updateType: string, workStatus: string): "done" | "in_progress" | "blocked" | "waiting" {
  if (updateType === "blocker") {
    return "blocked";
  }
  return workStatusToAreaStatus(workStatus);
}

/**
 * Recompute denormalized pod snapshot from `context_updates`:
 * - `pod_areas`: latest update per scope (or waiting if none)
 * - `pods.milestone_json.percent_complete`: sprint health proxy = round(done_scopes / 6 * 100)
 * - `org_pod_summaries.agent_count`: distinct agents who posted updates
 *
 * The milestone % is a lightweight proxy, not PM-level planning truth.
 */
export function refreshPodSnapshotFromContext(podId: string): void {
  const latestRows = db.prepare(
    `SELECT agent_id, timestamp, type, scope, status FROM (
       SELECT agent_id, timestamp, type, scope, status,
         ROW_NUMBER() OVER (PARTITION BY scope ORDER BY timestamp DESC, id DESC) AS rn
       FROM context_updates
       WHERE pod_id = ?
     ) WHERE rn = 1`,
  ).all(podId) as LatestRow[];

  const byScope = new Map<string, LatestRow>();
  for (const row of latestRows) {
    byScope.set(row.scope, row);
  }

  const updateArea = db.prepare(
    `UPDATE pod_areas SET owner = ?, status = ?, last_activity = ? WHERE pod_id = ? AND scope = ?`,
  );

  for (const scope of POD_SCOPES) {
    const row = byScope.get(scope);
    if (!row) {
      updateArea.run("unassigned", "waiting", null, podId, scope);
    } else {
      const status = resolveAreaStatus(row.type, row.status);
      updateArea.run(row.agent_id, status, row.timestamp, podId, scope);
    }
  }

  const doneCount = (
    db.prepare("SELECT COUNT(*) AS c FROM pod_areas WHERE pod_id = ? AND status = 'done'").get(podId) as { c: number }
  ).c;

  const percentComplete = Math.round((doneCount / POD_SCOPES.length) * 100);

  const podRow = db.prepare("SELECT milestone_json FROM pods WHERE pod_id = ?").get(podId) as
    | { milestone_json: string }
    | undefined;
  if (podRow) {
    const milestone = JSON.parse(podRow.milestone_json) as Milestone;
    milestone.percent_complete = percentComplete;
    db.prepare("UPDATE pods SET milestone_json = ? WHERE pod_id = ?").run(JSON.stringify(milestone), podId);
  }

  const agentCountRow = db.prepare(
    "SELECT COUNT(DISTINCT agent_id) AS c FROM context_updates WHERE pod_id = ?",
  ).get(podId) as { c: number };
  db.prepare("UPDATE org_pod_summaries SET agent_count = ? WHERE pod_id = ?").run(agentCountRow.c, podId);
}
