import db from "./connection.js";
import {
  pods,
  conflicts,
  pendingWorkByConflictId,
  contextUpdates,
  tunnels,
  orgPods,
  crossPodOverlaps,
  archivedPods,
  livingDocs,
  EMPTY_PROJECT_ANATOMY,
} from "@pim/shared";

const DEFAULT_PROJECT_ID = "project-demo";

export function seedDatabase() {
  const podCount = db.prepare("SELECT COUNT(*) as count FROM pods").get() as { count: number };
  if (podCount.count > 0) return; // Already seeded

  const insertProject = db.prepare(
    "INSERT INTO projects (project_id, name, description, created_at, anatomy_json) VALUES (?, ?, ?, ?, ?)",
  );
  const insertPod = db.prepare(
    "INSERT INTO pods (pod_id, name, sprint_start, sprint_end, day_number, total_days, conflict_pressure, milestone_json, project_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertArea = db.prepare(
    "INSERT INTO pod_areas (pod_id, scope, owner, status, last_activity) VALUES (?, ?, ?, ?, ?)",
  );
  const insertConflict = db.prepare(
    "INSERT INTO conflicts (id, pod_id, created_at, status, severity, summary, sides_json, master_analysis, impact_json, resolved_by, resolution, resolution_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertPendingWork = db.prepare(
    "INSERT INTO pending_work (context_update_id, conflict_id, agent_id, summary, presumes, rework_cost) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const insertContextUpdate = db.prepare(
    "INSERT INTO context_updates (id, agent_id, timestamp, pod_id, type, scope, summary, details, artifacts_json, status, blocks_json, blocked_by_json, needs_input_from_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertTunnel = db.prepare(
    "INSERT INTO tunnels (tunnel_id, pod_id, dev_name, branch, url, status, last_activity) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const insertOrgPod = db.prepare(
    "INSERT INTO org_pod_summaries (pod_id, name, day_number, total_days, conflict_pressure, open_conflicts, active_tunnels, agent_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertOverlap = db.prepare(
    "INSERT INTO cross_pod_overlaps (id, pod_a, pod_b, description, advisory) VALUES (?, ?, ?, ?, ?)",
  );
  const insertArchived = db.prepare(
    "INSERT INTO archived_pods (pod_id, name, completed_date, duration_days, final_pressure) VALUES (?, ?, ?, ?, ?)",
  );
  const insertLivingDoc = db.prepare(
    "INSERT INTO living_docs (pod_id, markdown, last_regenerated_at, regen_count) VALUES (?, ?, ?, ?)",
  );

  const transaction = db.transaction(() => {
    insertProject.run(
      DEFAULT_PROJECT_ID,
      "Demo initiative",
      "Shared project for seed pods",
      new Date().toISOString(),
      JSON.stringify(EMPTY_PROJECT_ANATOMY),
    );

    // Pods + areas
    for (const pod of Object.values(pods)) {
      const pid = pod.project_id ?? DEFAULT_PROJECT_ID;
      insertPod.run(
        pod.pod_id,
        pod.name,
        pod.sprint_start,
        pod.sprint_end,
        pod.day_number,
        pod.total_days,
        pod.conflict_pressure,
        JSON.stringify(pod.milestone),
        pid,
      );
      for (const area of pod.areas) {
        insertArea.run(pod.pod_id, area.scope, area.owner, area.status, area.last_activity);
      }
    }

    // Conflicts
    for (const [podId, podConflicts] of Object.entries(conflicts)) {
      for (const c of podConflicts) {
        insertConflict.run(c.id, c.pod_id, c.created_at, c.status, c.severity, c.summary, JSON.stringify(c.sides), c.master_analysis, JSON.stringify(c.impact), c.resolved_by, c.resolution, c.resolution_date);
      }
    }

    // Pending work
    for (const [conflictId, items] of Object.entries(pendingWorkByConflictId)) {
      for (const pw of items) {
        insertPendingWork.run(pw.context_update_id, conflictId, pw.agent_id, pw.summary, pw.presumes, pw.rework_cost);
      }
    }

    // Context updates
    for (const [podId, updates] of Object.entries(contextUpdates)) {
      for (const u of updates) {
        insertContextUpdate.run(u.id, u.agent_id, u.timestamp, u.pod_id, u.type, u.scope, u.summary, u.details, JSON.stringify(u.artifacts), u.status, JSON.stringify(u.blocks), JSON.stringify(u.blocked_by), JSON.stringify(u.needs_input_from));
      }
    }

    // Tunnels
    for (const [podId, podTunnels] of Object.entries(tunnels)) {
      for (const t of podTunnels) {
        insertTunnel.run(t.tunnel_id, t.pod_id, t.dev_name, t.branch, t.url, t.status, t.last_activity);
      }
    }

    // Org data
    for (const op of orgPods) {
      insertOrgPod.run(op.pod_id, op.name, op.day_number, op.total_days, op.conflict_pressure, op.open_conflicts, op.active_tunnels, op.agent_count);
    }
    for (const o of crossPodOverlaps) {
      insertOverlap.run(o.id, o.pod_a, o.pod_b, o.description, o.advisory);
    }
    for (const a of archivedPods) {
      insertArchived.run(a.pod_id, a.name, a.completed_date, a.duration_days, a.final_pressure);
    }

    // Living docs
    for (const [podId, markdown] of Object.entries(livingDocs)) {
      insertLivingDoc.run(podId, markdown, "2026-04-09T10:00:00Z", 1);
    }
  });

  transaction();
  console.log("Database seeded with fixture data.");
}
