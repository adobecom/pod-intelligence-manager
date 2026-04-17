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

// LLM-backed merge analysis
export async function llmMerge(
  update: ContextUpdate,
): Promise<MergeResult> {
  if (!isLLMAvailable()) {
    return deterministicMerge(update, "overlapping");
  }

  const recentUpdates = db.prepare(
    "SELECT agent_id, summary, details, timestamp FROM context_updates WHERE pod_id = ? AND scope = ? AND agent_id != ? AND id != ? ORDER BY timestamp DESC LIMIT 5"
  ).all(update.pod_id, update.scope, update.agent_id, update.id) as RecentUpdateRow[];

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
- Conflict Pressure: ${pod?.conflict_pressure ?? 0}`;

  try {
    const response = await callLLMJSON<LLMMergeResponse>({
      model: MODELS.fast,
      system: systemPrompt,
      prompt,
    });

    if (!response) {
      return deterministicMerge(update, "overlapping");
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
        return deterministicMerge(update, "overlapping");
    }
  } catch (err) {
    console.error("LLM merge failed, falling back to deterministic:", err);
    return deterministicMerge(update, "overlapping");
  }
}
