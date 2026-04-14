import db from "../../db/connection.js";

interface DecisionRow {
  agent_id: string;
  timestamp: string;
  summary: string;
  details: string;
}

interface ResolvedConflictRow {
  id: string;
  summary: string;
  resolution: string;
  severity: string;
}

export interface PodLearning {
  type: "pattern" | "resolved_conflict" | "anti_pattern" | "scope_insight";
  summary: string;
  details: string;
}

export function extractKnowledge(podId: string): PodLearning[] {
  const learnings: PodLearning[] = [];

  // Extract decisions as patterns
  const decisions = db.prepare(
    "SELECT agent_id, timestamp, summary, details FROM context_updates WHERE pod_id = ? AND type = 'decision' ORDER BY timestamp ASC",
  ).all(podId) as DecisionRow[];

  for (const d of decisions) {
    learnings.push({
      type: "pattern",
      summary: d.summary,
      details: `Decision by ${d.agent_id}: ${d.details || d.summary}`,
    });
  }

  // Extract resolved conflicts with their resolutions
  const resolved = db.prepare(
    "SELECT id, summary, resolution, severity FROM conflicts WHERE pod_id = ? AND status = 'resolved'",
  ).all(podId) as ResolvedConflictRow[];

  for (const r of resolved) {
    learnings.push({
      type: "resolved_conflict",
      summary: `${r.summary} — resolved: ${r.resolution}`,
      details: `Conflict ${r.id} (${r.severity}): ${r.summary}. Resolution: ${r.resolution}`,
    });
  }

  // Extract blockers as potential anti-patterns
  const blockers = db.prepare(
    "SELECT agent_id, summary, details FROM context_updates WHERE pod_id = ? AND type = 'blocker' ORDER BY timestamp ASC",
  ).all(podId) as DecisionRow[];

  for (const b of blockers) {
    learnings.push({
      type: "anti_pattern",
      summary: `Blocker encountered: ${b.summary}`,
      details: `Reported by ${b.agent_id}: ${b.details || b.summary}`,
    });
  }

  return learnings;
}
