import db, { withTransaction } from "./connection.js";
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
import { upsertUserByIms } from "../services/users.js";
import { createOrg, findOrgBySlug } from "../services/orgs.js";
import { ensureOrgConfig } from "../services/org-settings.js";

const DEFAULT_PROJECT_ID = "project-emc";
const DEMO_ORG_SLUG = "demo";
const DEMO_ORG_ID = "org_demo";
const DEMO_USER_EMAIL = process.env.DEV_USER_EMAIL ?? "dev@local";
const DEMO_USER_NAME = process.env.DEV_USER_NAME ?? "Local Dev";

export function ensureDemoOrg(): { userId: string; orgId: string } {
  const user = upsertUserByIms({ email: DEMO_USER_EMAIL, display_name: DEMO_USER_NAME });

  let org = findOrgBySlug(DEMO_ORG_SLUG);
  if (!org) {
    org = createOrg({
      orgId: DEMO_ORG_ID,
      slug: DEMO_ORG_SLUG,
      name: "Demo Org",
      creatorUserId: user.user_id,
    });
  }
  ensureOrgConfig(org.org_id);

  // Backfill any pre-existing rows that were created before the org model existed.
  const tables = [
    "projects",
    "pods",
    "context_updates",
    "project_context_updates",
    "conflicts",
    "tunnels",
    "living_docs",
    "knowledge_nodes",
    "archived_pods",
    "archived_projects",
    "org_pod_summaries",
    "cross_pod_overlaps",
    "lint_findings",
    "pending_work",
  ];
  for (const t of tables) {
    try {
      db.prepare(`UPDATE ${t} SET org_id = ? WHERE org_id IS NULL`).run(org.org_id);
    } catch {
      /* table may not exist in some test DBs */
    }
  }

  // Backfill created_by_user_id for projects/pods.
  for (const t of ["projects", "pods"]) {
    try {
      db.prepare(`UPDATE ${t} SET created_by_user_id = ? WHERE created_by_user_id IS NULL`).run(user.user_id);
    } catch {
      /* column may not exist on legacy DBs before migration */
    }
  }

  return { userId: user.user_id, orgId: org.org_id };
}

export function seedDatabase() {
  const { userId: demoUserId, orgId: demoOrgId } = ensureDemoOrg();

  const podCount = db.prepare("SELECT COUNT(*) as count FROM pods").get() as { count: number };
  if (podCount.count > 0) return; // Already seeded

  const insertProject = db.prepare(
    "INSERT INTO projects (project_id, name, description, created_at, anatomy_json, org_id, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const insertPod = db.prepare(
    "INSERT INTO pods (pod_id, name, sprint_start, sprint_end, day_number, total_days, conflict_pressure, milestone_json, project_id, org_id, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertArea = db.prepare(
    "INSERT INTO pod_areas (pod_id, scope, owner, status, last_activity) VALUES (?, ?, ?, ?, ?)",
  );
  const insertConflict = db.prepare(
    "INSERT INTO conflicts (id, pod_id, created_at, status, severity, summary, sides_json, master_analysis, impact_json, resolved_by, resolution, resolution_date, org_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertPendingWork = db.prepare(
    "INSERT INTO pending_work (context_update_id, conflict_id, agent_id, summary, presumes, rework_cost, org_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const insertContextUpdate = db.prepare(
    "INSERT INTO context_updates (id, agent_id, timestamp, pod_id, type, scope, summary, details, artifacts_json, status, blocks_json, blocked_by_json, needs_input_from_json, org_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertTunnel = db.prepare(
    "INSERT INTO tunnels (tunnel_id, pod_id, dev_name, branch, url, status, last_activity, org_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertOrgPod = db.prepare(
    "INSERT INTO org_pod_summaries (pod_id, name, day_number, total_days, conflict_pressure, open_conflicts, active_tunnels, agent_count, org_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertOverlap = db.prepare(
    "INSERT INTO cross_pod_overlaps (id, pod_a, pod_b, description, advisory, org_id) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const insertArchived = db.prepare(
    "INSERT INTO archived_pods (pod_id, name, completed_date, duration_days, final_pressure, org_id) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const insertLivingDoc = db.prepare(
    "INSERT INTO living_docs (pod_id, markdown, last_regenerated_at, regen_count, org_id) VALUES (?, ?, ?, ?, ?)",
  );

  withTransaction(() => {
    insertProject.run(
      DEFAULT_PROJECT_ID,
      "EMC Platform",
      "Event Management Console for Adobe events — RBAC, sessions, and scope-level configs",
      new Date().toISOString(),
      JSON.stringify(EMPTY_PROJECT_ANATOMY),
      demoOrgId,
      demoUserId,
    );

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
        demoOrgId,
        demoUserId,
      );
      for (const area of pod.areas) {
        insertArea.run(pod.pod_id, area.scope, area.owner, area.status, area.last_activity);
      }
    }

    for (const podConflicts of Object.values(conflicts)) {
      for (const c of podConflicts) {
        insertConflict.run(
          c.id, c.pod_id, c.created_at, c.status, c.severity, c.summary,
          JSON.stringify(c.sides), c.master_analysis, JSON.stringify(c.impact),
          c.resolved_by, c.resolution, c.resolution_date, demoOrgId,
        );
      }
    }

    for (const [conflictId, items] of Object.entries(pendingWorkByConflictId)) {
      for (const pw of items) {
        insertPendingWork.run(pw.context_update_id, conflictId, pw.agent_id, pw.summary, pw.presumes, pw.rework_cost, demoOrgId);
      }
    }

    for (const updates of Object.values(contextUpdates)) {
      for (const u of updates) {
        insertContextUpdate.run(
          u.id, u.agent_id, u.timestamp, u.pod_id, u.type, u.scope, u.summary, u.details,
          JSON.stringify(u.artifacts), u.status,
          JSON.stringify(u.blocks), JSON.stringify(u.blocked_by), JSON.stringify(u.needs_input_from),
          demoOrgId,
        );
      }
    }

    for (const podTunnels of Object.values(tunnels)) {
      for (const t of podTunnels) {
        insertTunnel.run(t.tunnel_id, t.pod_id, t.dev_name, t.branch, t.url, t.status, t.last_activity, demoOrgId);
      }
    }

    for (const op of orgPods) {
      insertOrgPod.run(op.pod_id, op.name, op.day_number, op.total_days, op.conflict_pressure, op.open_conflicts, op.active_tunnels, op.agent_count, demoOrgId);
    }
    for (const o of crossPodOverlaps) {
      insertOverlap.run(o.id, o.pod_a, o.pod_b, o.description, o.advisory, demoOrgId);
    }
    for (const a of archivedPods) {
      insertArchived.run(a.pod_id, a.name, a.completed_date, a.duration_days, a.final_pressure, demoOrgId);
    }

    for (const [podId, markdown] of Object.entries(livingDocs)) {
      insertLivingDoc.run(podId, markdown, "2026-04-09T10:00:00Z", 1, demoOrgId);
    }
  });
  console.log("Database seeded with fixture data (demo org).");
}
