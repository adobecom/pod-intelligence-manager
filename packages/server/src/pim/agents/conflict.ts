import db, { withTransaction } from "../../db/connection.js";
import { randomUUID } from "crypto";
import { isLLMAvailable, callLLMJSON, MODELS } from "../llm.js";
import type { ContextUpdate, Conflict, KnowledgeNode } from "@pim/shared";
import { DEFAULT_ORG_TUNING } from "@pim/shared";
import { getOrgTuning } from "../../services/org-settings.js";
import { broadcast } from "../../ws/index.js";
import { recalculatePressure } from "../../services/pressure.js";
import { getPrecedents } from "../../services/knowledge-graph.js";
import { getOrgIdForPod } from "../../services/orgs.js";
import { notifyConflictCreated, notifyPressureThreshold } from "../../services/slack.js";
import { computeCurrentDay } from "../../services/pod-day.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface LLMConflictResponse {
  summary: string;
  severity: "blocking" | "non_blocking";
  master_analysis: string;
  impact: string[];
  recommendation: string;
}

interface PodRow {
  name: string;
  day_number: number;
  total_days: number;
  sprint_start: string;
  conflict_pressure: number;
  milestone_json: string;
}

// Create a conflict record with optional LLM-powered analysis
export async function createConflict(
  update: ContextUpdate,
): Promise<Conflict | null> {
  const podId = update.pod_id;

  // Find the most recent update in the same scope from a different agent
  const conflicting = db.prepare(
    "SELECT id, agent_id, summary, details, timestamp FROM context_updates WHERE pod_id = ? AND scope = ? AND agent_id != ? AND id != ? ORDER BY timestamp DESC LIMIT 1"
  ).get(podId, update.scope, update.agent_id, update.id) as {
    id: string; agent_id: string; summary: string; details: string; timestamp: string;
  } | undefined;

  if (!conflicting) return null;

  const conflictId = `C-${randomUUID().slice(0, 4).toUpperCase()}`;
  const now = new Date().toISOString();

  // Try LLM analysis, fall back to deterministic
  let summary = `Potential conflict in ${update.scope}: ${update.agent_id} vs ${conflicting.agent_id}`;
  let severity: "blocking" | "non_blocking" = "non_blocking";
  let masterAnalysis = `Detected potential conflict between ${update.agent_id} and ${conflicting.agent_id} in ${update.scope} scope. Both agents have recent work that may overlap. Manual review recommended.`;
  let impact = [`May affect ${update.scope} deliverables`, "Review recommended before proceeding"];

  // Look up historical precedents for this conflict
  let precedentsContext = "";
  const podOrgId = getOrgIdForPod(podId);
  try {
    if (podOrgId) {
      const conflictDesc = `${update.summary} vs ${conflicting.summary} in ${update.scope}`;
      const precedents = await getPrecedents(podOrgId, conflictDesc, 500);
      if (precedents.nodes.length > 0) {
        precedentsContext = "\n\n## Historical Precedents\n";
        for (const p of precedents.nodes.slice(0, 3)) {
          precedentsContext += `- ${p.summary} (from ${p.source_pod_name}, confidence: ${p.confidence_score.toFixed(1)})\n`;
          if (p.details) precedentsContext += `  Details: ${p.details}\n`;
        }
      }
    }
  } catch {
    // Knowledge graph may not be initialized — skip silently
  }

  if (isLLMAvailable()) {
    try {
      const pod = db.prepare("SELECT name, day_number, total_days, sprint_start, conflict_pressure, milestone_json FROM pods WHERE pod_id = ?").get(podId) as PodRow | undefined;
      const currentDay = pod ? computeCurrentDay(pod.sprint_start, pod.total_days) : undefined;
      const openConflictCount = (db.prepare("SELECT COUNT(*) as count FROM conflicts WHERE pod_id = ? AND status != 'resolved'").get(podId) as { count: number }).count;
      const systemPrompt = fs.readFileSync(path.resolve(__dirname, "../../../../prompts/conflict-agent.md"), "utf-8");
      const milestoneName = pod ? safeMilestoneName(pod.milestone_json) : "Unknown";
      const prompt = `## Side A
- Agent: ${update.agent_id}
- Position: ${update.summary}
- Details: ${update.details}
- Timestamp: ${update.timestamp}

## Side B
- Agent: ${conflicting.agent_id}
- Position: ${conflicting.summary}
- Details: ${conflicting.details}
- Timestamp: ${conflicting.timestamp}

## Pod Context
- Pod: ${pod?.name ?? podId}
- Day ${currentDay ?? "?"} of ${pod?.total_days ?? "?"}
- Current conflict pressure: ${pod?.conflict_pressure ?? 0}
- Open conflicts: ${openConflictCount}
- Milestone: ${milestoneName}${precedentsContext}`;

      const response = await callLLMJSON<LLMConflictResponse>({
        model: MODELS.smart,
        system: systemPrompt,
        prompt,
      });

      if (response) {
        summary = response.summary;
        severity = response.severity;
        masterAnalysis = response.master_analysis;
        impact = response.impact;
      }
    } catch (err) {
      console.error("LLM conflict analysis failed, using deterministic:", err);
    }
  }

  const conflict: Conflict = {
    id: conflictId,
    pod_id: podId,
    created_at: now,
    status: "open",
    severity,
    summary,
    sides: [
      {
        contributor: update.agent_id,
        position: update.summary,
        context_update_id: update.id,
        timestamp: update.timestamp,
      },
      {
        contributor: conflicting.agent_id,
        position: conflicting.summary,
        context_update_id: conflicting.id,
        timestamp: conflicting.timestamp,
      },
    ],
    master_analysis: masterAnalysis,
    impact,
    resolved_by: null,
    resolution: null,
    resolution_date: null,
  };

  // Write to database atomically: conflict insert + pressure recalculation
  const podRow = db.prepare("SELECT conflict_pressure, org_id FROM pods WHERE pod_id = ?").get(podId) as { conflict_pressure: number; org_id: string | null } | undefined;
  const previousPressure = podRow?.conflict_pressure ?? 0;
  const orgId = podRow?.org_id ?? null;

  let newPressure = previousPressure;
  try {
    newPressure = withTransaction(() => {
      db.prepare(
        `INSERT INTO conflicts (id, pod_id, created_at, status, severity, summary, sides_json, master_analysis, impact_json, resolved_by, resolution, resolution_date, org_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        conflict.id, conflict.pod_id, conflict.created_at, conflict.status,
        conflict.severity, conflict.summary, JSON.stringify(conflict.sides),
        conflict.master_analysis, JSON.stringify(conflict.impact),
        conflict.resolved_by, conflict.resolution, conflict.resolution_date,
        orgId,
      );

      return recalculatePressure(podId, orgId ?? undefined);
    });
  } catch (err) {
    console.error(`[conflict] failed to persist conflict ${conflict.id}:`, err);
    throw err;
  }

  notifyConflictSideEffects(podId, conflict, newPressure, previousPressure, orgId);

  return conflict;
}

function hasOpenOrgPatternConflict(podId: string, nodeId: string): boolean {
  const rows = db.prepare(
    "SELECT sides_json FROM conflicts WHERE pod_id = ? AND status != 'resolved'",
  ).all(podId) as { sides_json: string }[];
  for (const row of rows) {
    const sides = JSON.parse(row.sides_json) as Array<{ contributor: string; context_update_id: string }>;
    if (sides.some((s) => s.context_update_id === nodeId || s.contributor === `org:kg:${nodeId}`)) {
      return true;
    }
  }
  return false;
}

export interface OrgPatternConflictAnalysis {
  contradictionSummary: string;
  rationale: string;
  confidence: number;
}

/** Conflict between a pod update and an org KG precedent (Side B = org memory). */
export async function createOrgPatternConflict(
  update: ContextUpdate,
  kgNode: KnowledgeNode,
  analysis: OrgPatternConflictAnalysis,
): Promise<Conflict | null> {
  const podId = update.pod_id;
  if (hasOpenOrgPatternConflict(podId, kgNode.id)) return null;

  const conflictId = `C-${randomUUID().slice(0, 4).toUpperCase()}`;
  const now = new Date().toISOString();
  const orgContributor = `org:kg:${kgNode.id}`;
  const severity: Conflict["severity"] =
    kgNode.type === "anti_pattern" || (kgNode.type === "decision" && kgNode.curated)
      ? "blocking"
      : "non_blocking";

  const masterAnalysis =
    `Org precedent conflict: KG node ${kgNode.id} (${kgNode.type}, ` +
    `source: ${kgNode.source_pod_name ?? kgNode.source_pod_id}, confidence ${kgNode.confidence_score.toFixed(2)}). ` +
    `${analysis.rationale}`;

  const impact = [
    `Contradicts org ${kgNode.type} in ${update.scope} scope`,
    `KG node: ${kgNode.summary}`,
  ];

  const conflict: Conflict = {
    id: conflictId,
    pod_id: podId,
    created_at: now,
    status: "open",
    severity,
    summary: analysis.contradictionSummary,
    sides: [
      {
        contributor: update.agent_id,
        position: update.summary,
        context_update_id: update.id,
        timestamp: update.timestamp,
      },
      {
        contributor: orgContributor,
        position: `${kgNode.summary}${kgNode.details ? ` — ${kgNode.details.slice(0, 300)}` : ""}`,
        context_update_id: kgNode.id,
        timestamp: kgNode.created_at ?? now,
      },
    ],
    master_analysis: masterAnalysis,
    impact,
    resolved_by: null,
    resolution: null,
    resolution_date: null,
  };

  const podRow = db.prepare("SELECT conflict_pressure, org_id FROM pods WHERE pod_id = ?").get(podId) as {
    conflict_pressure: number;
    org_id: string | null;
  } | undefined;
  const previousPressure = podRow?.conflict_pressure ?? 0;
  const orgId = podRow?.org_id ?? null;

  let newPressure = previousPressure;
  try {
    newPressure = withTransaction(() => {
      db.prepare(
        `INSERT INTO conflicts (id, pod_id, created_at, status, severity, summary, sides_json, master_analysis, impact_json, resolved_by, resolution, resolution_date, org_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        conflict.id, conflict.pod_id, conflict.created_at, conflict.status,
        conflict.severity, conflict.summary, JSON.stringify(conflict.sides),
        conflict.master_analysis, JSON.stringify(conflict.impact),
        conflict.resolved_by, conflict.resolution, conflict.resolution_date,
        orgId,
      );
      return recalculatePressure(podId, orgId ?? undefined);
    });
  } catch (err) {
    console.error(`[conflict] failed to persist org-pattern conflict ${conflict.id}:`, err);
    throw err;
  }

  notifyConflictSideEffects(podId, conflict, newPressure, previousPressure, orgId);
  return conflict;
}

function notifyConflictSideEffects(
  podId: string,
  conflict: Conflict,
  newPressure: number,
  previousPressure: number,
  orgId: string | null,
): void {
  const thresholds = orgId
    ? getOrgTuning(orgId).pressure
    : DEFAULT_ORG_TUNING.pressure;

  try {
    broadcast({ type: "conflict_created", podId, payload: conflict });
    broadcast({ type: "pressure_changed", podId, payload: { pressure: newPressure } });
  } catch (err) {
    console.error(`[conflict] broadcast failed for ${conflict.id}:`, err);
  }

  try {
    notifyConflictCreated(conflict)
      .then((ts) => {
        if (!ts) return;
        try {
          db.prepare("UPDATE conflicts SET slack_message_ts = ? WHERE id = ?").run(ts, conflict.id);
        } catch (err) {
          console.error(`[conflict] failed to persist slack_message_ts for ${conflict.id}:`, (err as Error).message);
        }
      })
      .catch((err) => {
        console.error(`[conflict] Slack conflict notification failed for ${conflict.id}:`, err);
      });
    notifyPressureThreshold(podId, newPressure, previousPressure, thresholds);
  } catch (err) {
    console.error(`[conflict] notification failed for ${conflict.id}:`, err);
  }
}

function safeMilestoneName(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { name?: unknown };
    return typeof parsed.name === "string" && parsed.name.trim() ? parsed.name : "Unknown";
  } catch {
    return "Unknown";
  }
}
