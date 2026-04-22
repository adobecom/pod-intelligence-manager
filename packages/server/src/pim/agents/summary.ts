import db from "../../db/connection.js";
import { getPressureLabel, getPressureLevel } from "@pim/shared";
import { broadcast } from "../../ws/index.js";
import { getRelevantLearnings } from "../../services/knowledge-graph.js";
import { computeCurrentDay } from "../../services/pod-day.js";

interface PodRow {
  pod_id: string;
  name: string;
  sprint_start: string;
  sprint_end: string;
  day_number: number;
  total_days: number;
  conflict_pressure: number;
  milestone_json: string;
  project_id?: string | null;
}

interface AreaRow {
  scope: string;
  owner: string;
  status: string;
  last_activity: string | null;
}

interface ConflictRow {
  id: string;
  summary: string;
  severity: string;
  status: string;
}

interface ContextUpdateRow {
  agent_id: string;
  timestamp: string;
  type: string;
  summary: string;
}

interface TunnelRow {
  dev_name: string;
  branch: string;
  url: string;
  status: string;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}`;
}

function capitalizeStatus(status: string): string {
  return status.split("_").map(w => w[0].toUpperCase() + w.slice(1)).join(" ");
}

// Template-based living doc generation from database state
export async function regenerateLivingDoc(podId: string): Promise<string> {
  const pod = db.prepare("SELECT * FROM pods WHERE pod_id = ?").get(podId) as PodRow | undefined;
  if (!pod) return `# Pod not found: ${podId}`;

  const milestone = JSON.parse(pod.milestone_json) as { name: string; target_date: string; percent_complete: number };
  const areas = db.prepare("SELECT scope, owner, status, last_activity FROM pod_areas WHERE pod_id = ?").all(podId) as AreaRow[];
  const conflicts = db.prepare("SELECT id, summary, severity, status FROM conflicts WHERE pod_id = ? ORDER BY created_at DESC").all(podId) as ConflictRow[];
  const openConflicts = conflicts.filter(c => c.status !== "resolved");
  const updates = db.prepare("SELECT agent_id, timestamp, type, summary FROM context_updates WHERE pod_id = ? AND retracted_at IS NULL ORDER BY timestamp DESC LIMIT 10").all(podId) as ContextUpdateRow[];
  const decisions = db.prepare("SELECT agent_id, timestamp, summary FROM context_updates WHERE pod_id = ? AND type = 'decision' AND retracted_at IS NULL ORDER BY timestamp DESC").all(podId) as ContextUpdateRow[];
  const tunnels = db.prepare("SELECT dev_name, branch, url, status FROM tunnels WHERE pod_id = ?").all(podId) as TunnelRow[];

  const pressureLevel = getPressureLevel(pod.conflict_pressure);
  const pressureLabel = getPressureLabel(pressureLevel);
  const sprintStart = formatDate(pod.sprint_start);
  const sprintEnd = formatDate(pod.sprint_end);

  let md = `# Pod: ${pod.name} — Living Doc\n\n`;
  md += `## Pod Health\n`;
  const currentDay = computeCurrentDay(pod.sprint_start, pod.total_days);
  md += `**Conflict Pressure:** ${pod.conflict_pressure.toFixed(2)} (${pressureLabel}) | **Day ${currentDay} of ${pod.total_days}** | Sprint: ${sprintStart}–${sprintEnd}\n\n`;

  md += `## Active Milestone\n`;
  md += `**${milestone.name}** (Target: ${formatDate(milestone.target_date)}) — ${milestone.percent_complete}% complete\n\n`;

  md += `## Current Status\n\n`;
  md += `| Area | Owner | Status | Last Update |\n`;
  md += `|------|-------|--------|-------------|\n`;
  for (const area of areas) {
    const lastUpdate = area.last_activity ? formatDate(area.last_activity) : "—";
    md += `| ${capitalizeStatus(area.scope)} | ${area.owner} | ${capitalizeStatus(area.status)} | ${lastUpdate} |\n`;
  }
  md += `\n`;

  md += `## Open Conflicts\n\n`;
  if (openConflicts.length === 0) {
    md += `None\n\n`;
  } else {
    for (const c of openConflicts) {
      const sevLabel = c.severity === "blocking" ? "**BLOCKING**" : "non-blocking";
      md += `- **${c.id}:** ${c.summary} — ${sevLabel}\n`;
    }
    md += `\n`;
  }

  if (decisions.length > 0) {
    md += `## Decisions Log\n\n`;
    for (const d of decisions) {
      md += `- **[${formatDate(d.timestamp)}]** ${d.summary} (${d.agent_id})\n`;
    }
    md += `\n`;
  }

  md += `## Context Stream (Recent)\n\n`;
  for (const u of updates.slice(0, 8)) {
    md += `- **[${formatDateTime(u.timestamp)}]** ${u.agent_id}: ${u.summary}\n`;
  }
  md += `\n`;

  if (tunnels.length > 0) {
    md += `## Active Tunnels\n\n`;
    for (const t of tunnels) {
      const statusIcon = t.status === "active" ? "" : t.status === "idle" ? " (idle)" : " (disconnected)";
      md += `- ${t.dev_name}: ${t.branch} → ${t.url}${statusIcon}\n`;
    }
    md += `\n`;
  }

  // Add knowledge context from org memory (token-budgeted)
  try {
    const activeScopes = areas.map(a => a.scope);
    const conflictSummaries = openConflicts.map(c => c.summary);
    const knowledgeResult = await getRelevantLearnings(
      activeScopes,
      conflictSummaries,
      1500,
      pod.project_id ?? null,
    );
    if (knowledgeResult.nodes.length > 0) {
      md += `## Knowledge Context\n\n`;
      md += `*From organizational memory (${knowledgeResult.nodes.length} relevant learnings):*\n\n`;
      for (const node of knowledgeResult.nodes.slice(0, 8)) {
        const icon = node.type === "anti_pattern" ? "⚠" : node.type === "pattern" ? "✓" : "•";
        md += `- ${icon} ${node.summary} *(${node.source_pod_name})*\n`;
      }
      if (knowledgeResult.truncated) {
        md += `\n*${knowledgeResult.total_matching - knowledgeResult.nodes.length} more learnings available — query the knowledge graph for details.*\n`;
      }
      md += `\n`;
    }
  } catch {
    // Knowledge graph may not be initialized yet — skip silently
  }

  // Write to database (atomically increment regen_count)
  const now = new Date().toISOString();
  const podRow = db.prepare("SELECT org_id FROM pods WHERE pod_id = ?").get(podId) as { org_id: string | null } | undefined;
  db.prepare(
    `INSERT INTO living_docs (pod_id, markdown, last_regenerated_at, regen_count, org_id)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(pod_id) DO UPDATE SET
       markdown = excluded.markdown,
       last_regenerated_at = excluded.last_regenerated_at,
       regen_count = living_docs.regen_count + 1`
  ).run(podId, md, now, podRow?.org_id ?? null);

  // Broadcast update
  broadcast({ type: "living_doc_updated", podId, payload: { markdown: md } });

  return md;
}
