import db from "../../db/connection.js";
import { randomUUID } from "crypto";
import { isLLMAvailable, callLLMJSON, MODELS } from "../llm.js";
import type { ContextUpdate, Conflict } from "@pim/shared";
import { broadcast } from "../../ws/index.js";
import { recalculatePressure } from "../../services/pressure.js";
import { getPrecedents } from "../../services/knowledge-graph.js";
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
  try {
    const conflictDesc = `${update.summary} vs ${conflicting.summary} in ${update.scope}`;
    const precedents = await getPrecedents(conflictDesc, 500);
    if (precedents.nodes.length > 0) {
      precedentsContext = "\n\n## Historical Precedents\n";
      for (const p of precedents.nodes.slice(0, 3)) {
        precedentsContext += `- ${p.summary} (from ${p.source_pod_name}, confidence: ${p.confidence_score.toFixed(1)})\n`;
        if (p.details) precedentsContext += `  Details: ${p.details}\n`;
      }
    }
  } catch {
    // Knowledge graph may not be initialized — skip silently
  }

  if (isLLMAvailable()) {
    const pod = db.prepare("SELECT name, day_number, total_days, sprint_start, conflict_pressure, milestone_json FROM pods WHERE pod_id = ?").get(podId) as PodRow | undefined;
    const currentDay = pod ? computeCurrentDay(pod.sprint_start, pod.total_days) : undefined;
    const openConflictCount = (db.prepare("SELECT COUNT(*) as count FROM conflicts WHERE pod_id = ? AND status != 'resolved'").get(podId) as { count: number }).count;

    const systemPrompt = fs.readFileSync(path.resolve(__dirname, "../../../../prompts/conflict-agent.md"), "utf-8");

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
- Milestone: ${pod ? JSON.parse(pod.milestone_json).name : "Unknown"}${precedentsContext}`;

    try {
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

  const insertAndRecalculate = db.transaction(() => {
    db.prepare(
      `INSERT INTO conflicts (id, pod_id, created_at, status, severity, summary, sides_json, master_analysis, impact_json, resolved_by, resolution, resolution_date, org_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      conflict.id, conflict.pod_id, conflict.created_at, conflict.status,
      conflict.severity, conflict.summary, JSON.stringify(conflict.sides),
      conflict.master_analysis, JSON.stringify(conflict.impact),
      conflict.resolved_by, conflict.resolution, conflict.resolution_date,
      orgId,
    );

    return recalculatePressure(podId);
  });

  const newPressure = insertAndRecalculate();

  // Broadcast and notify (outside transaction — side effects should not roll back)
  broadcast({ type: "conflict_created", podId, payload: conflict });
  broadcast({ type: "pressure_changed", podId, payload: { pressure: newPressure } });

  // Slack notifications — capture the posted message ts so later escalations/
  // resolutions can thread under it instead of posting new top-level messages.
  // Fire-and-forget: we don't block conflict creation on Slack round-trip.
  notifyConflictCreated(conflict).then((ts) => {
    if (!ts) return;
    try {
      db.prepare("UPDATE conflicts SET slack_message_ts = ? WHERE id = ?").run(ts, conflict.id);
    } catch (err) {
      console.error(`[conflict] failed to persist slack_message_ts for ${conflict.id}:`, (err as Error).message);
    }
  });
  notifyPressureThreshold(podId, newPressure, previousPressure);

  return conflict;
}
