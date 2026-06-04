import db from "../../db/connection.js";
import { isLLMAvailable, callLLMJSON, MODELS } from "../llm.js";
import type { ContextUpdate } from "@pim/shared";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface MergeResult {
  merged: boolean;
  note?: string;
  escalate?: boolean;
  conflictIndicators?: string[];
  degraded?: boolean;
  held?: boolean;
  error?: string;
}

interface LLMMergeResponse {
  decision: "auto_merge" | "merge_with_note" | "escalate_conflict";
  reasoning: string;
  note: string | null;
  conflict_indicators: string[];
}

interface RecentUpdateRow {
  agent_id: string;
  summary: string;
  details: string;
  timestamp: string;
}

// Deterministic merge: additive updates always merge, overlapping updates merge with a note
export function deterministicMerge(
  update: ContextUpdate,
  classification: "additive" | "overlapping",
): MergeResult {
  if (classification === "additive") {
    return { merged: true };
  }

  return {
    merged: true,
    note: `Update merged with caution — overlaps with recent work in ${update.scope} scope. Review recommended.`,
  };
}

function degradedOverlapMerge(update: ContextUpdate, error: string): MergeResult {
  const result = deterministicMerge(update, "overlapping");
  return {
    ...result,
    escalate: true,
    degraded: true,
    error,
    conflictIndicators: ["llm_merge_unavailable"],
  };
}

export interface LlmMergeContext {
  normalMax: number;
  podPressure: number;
  openConflictCount: number;
}

// LLM-backed merge analysis
export async function llmMerge(
  update: ContextUpdate,
  pressureCtx?: LlmMergeContext,
): Promise<MergeResult> {
  if (!isLLMAvailable()) {
    return degradedOverlapMerge(update, "LLM merge unavailable; overlapping conflict detection was bypassed");
  }

  const recentUpdates = db.prepare(
    "SELECT agent_id, summary, details, timestamp FROM context_updates WHERE pod_id = ? AND scope = ? AND agent_id != ? AND id != ? ORDER BY timestamp DESC LIMIT 5"
  ).all(update.pod_id, update.scope, update.agent_id, update.id) as unknown as unknown as RecentUpdateRow[];

  const pod = db.prepare("SELECT conflict_pressure FROM pods WHERE pod_id = ?").get(update.pod_id) as { conflict_pressure: number } | undefined;

  const systemPrompt = fs.readFileSync(path.resolve(__dirname, "../../../../prompts/merge-agent.md"), "utf-8");

  const prompt = `## New Context Update
- Agent: ${update.agent_id}
- Scope: ${update.scope}
- Type: ${update.type}
- Summary: ${update.summary}
- Details: ${update.details}

## Recent Updates in Same Scope
${recentUpdates.map(u => `- [${u.timestamp}] ${u.agent_id}: ${u.summary}\n  Details: ${u.details}`).join("\n") || "None"}

## Pod State
- Conflict Pressure: ${pod?.conflict_pressure ?? 0}${pressureCtx && pressureCtx.podPressure > pressureCtx.normalMax ? ` (cautious — prefer merge_with_note when near open conflicts; ${pressureCtx.openConflictCount} open)` : ""}`;

  try {
    const response = await callLLMJSON<LLMMergeResponse>({
      model: MODELS.fast,
      system: systemPrompt,
      prompt,
    });

    if (!response) {
      return degradedOverlapMerge(update, "LLM merge returned no usable decision");
    }

    switch (response.decision) {
      case "auto_merge":
        return { merged: true };
      case "merge_with_note":
        return { merged: true, note: response.note ?? response.reasoning };
      case "escalate_conflict":
        return {
          merged: true,
          escalate: true,
          conflictIndicators: response.conflict_indicators,
          note: response.reasoning,
        };
      default:
        return degradedOverlapMerge(update, "LLM merge returned an unsupported decision");
    }
  } catch (err) {
    console.error("LLM merge failed, falling back to deterministic:", err);
    return degradedOverlapMerge(update, err instanceof Error ? err.message : "LLM merge failed");
  }
}
