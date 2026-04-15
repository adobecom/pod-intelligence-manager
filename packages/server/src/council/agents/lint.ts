import { randomUUID } from "crypto";
import db from "../../db/connection.js";
import { broadcast } from "../../ws/index.js";

export interface LintFinding {
  id: string;
  pod_id: string;
  timestamp: string;
  type: "staleness" | "coverage_gap" | "dependency_risk" | "unresolved_conflict" | "doc_not_read";
  severity: "info" | "warning" | "critical";
  summary: string;
  area: string | null;
  suggestion: string | null;
}

interface AreaRow {
  scope: string;
  owner: string;
  status: string;
  last_activity: string | null;
}

interface PodRow {
  pod_id: string;
  day_number: number;
}

interface UpdateRow {
  agent_id: string;
  scope: string;
  timestamp: string;
  summary: string;
}

interface ConflictRow {
  id: string;
  created_at: string;
  severity: string;
  summary: string;
  sides_json: string;
}

const STALENESS_HOURS = 8;

export function runLintPass(podId: string): LintFinding[] {
  const now = Date.now();
  const timestamp = new Date().toISOString();
  const findings: LintFinding[] = [];

  const pod = db.prepare("SELECT pod_id, day_number FROM pods WHERE pod_id = ?").get(podId) as PodRow | undefined;
  if (!pod) return [];

  const areas = db.prepare(
    "SELECT scope, owner, status, last_activity FROM pod_areas WHERE pod_id = ?",
  ).all(podId) as AreaRow[];

  const recentUpdates = db.prepare(
    "SELECT agent_id, scope, timestamp, summary FROM context_updates WHERE pod_id = ? ORDER BY timestamp DESC",
  ).all(podId) as UpdateRow[];

  const openConflicts = db.prepare(
    "SELECT id, created_at, severity, summary, sides_json FROM conflicts WHERE pod_id = ? AND status != 'resolved'",
  ).all(podId) as ConflictRow[];

  // 1. Staleness: areas with no update in STALENESS_HOURS (only check active areas)
  for (const area of areas) {
    if (area.status === "done" || area.status === "waiting") continue;
    const areaUpdates = recentUpdates.filter((u) => u.scope === area.scope);
    const latestUpdate = areaUpdates[0];
    if (latestUpdate) {
      const ageMs = now - new Date(latestUpdate.timestamp).getTime();
      const ageHours = ageMs / (1000 * 60 * 60);
      if (ageHours > STALENESS_HOURS) {
        findings.push({
          id: `lint-${randomUUID().slice(0, 8)}`,
          pod_id: podId,
          timestamp,
          type: "staleness",
          severity: ageHours > 24 ? "critical" : "warning",
          summary: `${area.scope} (${area.owner}) has not reported in ${Math.round(ageHours)}h`,
          area: area.scope,
          suggestion: `Check in with ${area.owner} on ${area.scope} progress`,
        });
      }
    } else if (pod.day_number > 1) {
      // Active area but no updates at all past day 1
      findings.push({
        id: `lint-${randomUUID().slice(0, 8)}`,
        pod_id: podId,
        timestamp,
        type: "staleness",
        severity: "warning",
        summary: `${area.scope} (${area.owner}) has no updates but is marked ${area.status}`,
        area: area.scope,
        suggestion: `Verify ${area.scope} work has started`,
      });
    }
  }

  // 2. Coverage gap: areas still "waiting" past day 2
  if (pod.day_number > 2) {
    for (const area of areas) {
      if (area.status === "waiting") {
        findings.push({
          id: `lint-${randomUUID().slice(0, 8)}`,
          pod_id: podId,
          timestamp,
          type: "coverage_gap",
          severity: "warning",
          summary: `${area.scope} is still in "waiting" status on day ${pod.day_number}`,
          area: area.scope,
          suggestion: `Assign an owner or mark as not needed for this sprint`,
        });
      }
    }
  }

  // 3. Dependency risk: multiple agents in same scope without coordination
  const scopeAgents = new Map<string, Set<string>>();
  for (const update of recentUpdates) {
    if (!scopeAgents.has(update.scope)) scopeAgents.set(update.scope, new Set());
    scopeAgents.get(update.scope)!.add(update.agent_id);
  }
  for (const [scope, agents] of scopeAgents) {
    if (agents.size > 1) {
      // Check if there's a coordination decision for this scope
      const coordDecisions = recentUpdates.filter(
        (u) => u.scope === scope && u.summary.toLowerCase().includes("coordinat"),
      );
      if (coordDecisions.length === 0) {
        findings.push({
          id: `lint-${randomUUID().slice(0, 8)}`,
          pod_id: podId,
          timestamp,
          type: "dependency_risk",
          severity: "info",
          summary: `${agents.size} agents (${[...agents].join(", ")}) working in ${scope} without explicit coordination`,
          area: scope,
          suggestion: `Consider adding a coordination decision to clarify ownership`,
        });
      }
    }
  }

  // 4. Unresolved conflicts aging
  for (const conflict of openConflicts) {
    const ageMs = now - new Date(conflict.created_at).getTime();
    const ageHours = ageMs / (1000 * 60 * 60);
    if (ageHours > 8) {
      findings.push({
        id: `lint-${randomUUID().slice(0, 8)}`,
        pod_id: podId,
        timestamp,
        type: "unresolved_conflict",
        severity: conflict.severity === "blocking" ? "critical" : "warning",
        summary: `${conflict.id} (${conflict.summary}) open for ${Math.round(ageHours)}h`,
        area: null,
        suggestion: `Resolve or escalate this conflict`,
      });
    }
  }

  // 5. Doc-not-read: agents in open conflicts who haven't viewed the living doc since last regen
  const livingDoc = db.prepare(
    "SELECT last_regenerated_at, regen_count FROM living_docs WHERE pod_id = ?"
  ).get(podId) as { last_regenerated_at: string | null; regen_count: number } | undefined;

  if (livingDoc?.last_regenerated_at) {
    for (const conflict of openConflicts) {
      const sides = JSON.parse(conflict.sides_json) as Array<{ contributor: string }>;
      for (const side of sides) {
        const viewRow = db.prepare(
          "SELECT last_viewed_regen_count FROM living_doc_views WHERE pod_id = ? AND viewer_id = ?"
        ).get(podId, side.contributor) as { last_viewed_regen_count: number } | undefined;

        const neverViewed = !viewRow;
        const staleView = viewRow && viewRow.last_viewed_regen_count < livingDoc.regen_count;

        if (neverViewed || staleView) {
          findings.push({
            id: `lint-${randomUUID().slice(0, 8)}`,
            pod_id: podId,
            timestamp,
            type: "doc_not_read",
            severity: "warning",
            summary: `${side.contributor} is in conflict ${conflict.id} but hasn't viewed the living doc since last regeneration`,
            area: null,
            suggestion: `${side.contributor} should review the living doc for current context`,
          });
        }
      }
    }
  }

  // Persist findings (replace old ones for this pod)
  db.prepare("DELETE FROM lint_findings WHERE pod_id = ?").run(podId);
  const insert = db.prepare(
    `INSERT INTO lint_findings (id, pod_id, timestamp, type, severity, summary, area, suggestion)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const f of findings) {
    insert.run(f.id, f.pod_id, f.timestamp, f.type, f.severity, f.summary, f.area, f.suggestion);
  }

  // Broadcast
  broadcast({ type: "lint_completed", podId, payload: { findings } });

  return findings;
}
