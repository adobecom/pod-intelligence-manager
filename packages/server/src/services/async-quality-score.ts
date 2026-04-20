import db from "../db/connection.js";
import { callLLMJSON, isLLMAvailable, MODELS } from "../pim/llm.js";
import { broadcast } from "../ws/index.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface UpdateRow {
  id: string;
  agent_id: string;
  type: string;
  scope: string;
  summary: string;
  details: string;
  artifacts_json: string;
  status: string;
}

interface LLMQualityResponse {
  quality?: number;
  rationale?: string;
}

let _systemPrompt: string | null = null;
function getSystemPrompt(): string {
  if (!_systemPrompt) {
    _systemPrompt = fs.readFileSync(
      path.resolve(__dirname, "../../../../prompts/quality-scout-agent.md"),
      "utf-8",
    );
  }
  return _systemPrompt;
}

async function runQualityScore(podId: string, updateId: string): Promise<void> {
  const row = db
    .prepare("SELECT * FROM context_updates WHERE id = ? AND pod_id = ?")
    .get(updateId, podId) as UpdateRow | undefined;
  if (!row) return;

  const artifacts = row.artifacts_json?.slice(0, 1200) ?? "[]";

  const prompt = `## Update to score
- id: ${row.id}
- agent: ${row.agent_id}
- type: ${row.type}
- scope: ${row.scope}
- status: ${row.status}
- summary: ${row.summary}
- details: ${row.details.slice(0, 6000)}${row.details.length > 6000 ? "…" : ""}
- artifacts_json (truncated): ${artifacts}`;

  const raw = await callLLMJSON<LLMQualityResponse>({
    model: MODELS.fast,
    system: getSystemPrompt(),
    prompt,
    maxTokens: 400,
  });

  if (raw == null || typeof raw.quality !== "number" || !Number.isFinite(raw.quality)) {
    return;
  }

  const quality = Math.min(1, Math.max(0, raw.quality));
  const rationale = typeof raw.rationale === "string" ? raw.rationale.slice(0, 500) : "";

  db.prepare(
    "UPDATE context_updates SET quality_score = ?, quality_rationale = ? WHERE id = ? AND pod_id = ?",
  ).run(quality, rationale, updateId, podId);

  broadcast({
    type: "context_update_quality_revised",
    podId,
    payload: {
      id: updateId,
      quality_score: quality,
      quality_rationale: rationale || null,
    },
  });
}

/** Fire-and-forget Haiku quality pass after ingest (does not block the request). */
export function scheduleAsyncQualityScore(podId: string, updateId: string): void {
  if (!isLLMAvailable()) return;
  queueMicrotask(() => {
    runQualityScore(podId, updateId).catch((err) => {
      console.error("[async-quality-score]", err);
    });
  });
}
