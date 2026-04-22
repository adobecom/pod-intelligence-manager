import db from "../db/connection.js";
import { callLLMJSON, isLLMAvailable, MODELS } from "../pim/llm.js";
import { broadcast } from "../ws/index.js";
import { broadcastToAll } from "../ws/index.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VALID_TYPES = ["progress", "spec_change", "decision", "blocker", "question"] as const;
const VALID_STATUSES = ["completed", "in_progress", "blocked"] as const;

interface UpdateRow {
  id: string;
  summary: string;
  details: string;
  scope: string;
}

interface LLMEnrichmentResponse {
  type?: string;
  summary?: string;
  status?: string;
  blocks?: unknown;
  blocked_by?: unknown;
  needs_input_from?: unknown;
}

interface EnrichedFields {
  type: string;
  summary: string;
  status: string;
  blocks: string[];
  blocked_by: string[];
  needs_input_from: Array<{ role: string; question: string }>;
}

let _systemPrompt: string | null = null;
function getSystemPrompt(): string {
  if (!_systemPrompt) {
    _systemPrompt = fs.readFileSync(
      path.resolve(__dirname, "../../../../prompts/git-hook-enrichment-agent.md"),
      "utf-8",
    );
  }
  return _systemPrompt;
}

function buildPrompt(row: UpdateRow): string {
  return [
    "## Commit-sourced context update to enrich",
    `- scope: ${row.scope}`,
    `- raw summary (commit subject): ${row.summary}`,
    `- details (commit body + git stat):\n${row.details}`,
  ].join("\n");
}

function parseResponse(raw: LLMEnrichmentResponse, fallbackSummary: string): EnrichedFields {
  return {
    type: (VALID_TYPES as readonly string[]).includes(raw.type ?? "") ? raw.type! : "progress",
    summary:
      typeof raw.summary === "string" && raw.summary.trim()
        ? raw.summary.slice(0, 200)
        : fallbackSummary.slice(0, 200),
    status: (VALID_STATUSES as readonly string[]).includes(raw.status ?? "") ? raw.status! : "completed",
    blocks: Array.isArray(raw.blocks) ? (raw.blocks as string[]) : [],
    blocked_by: Array.isArray(raw.blocked_by) ? (raw.blocked_by as string[]) : [],
    needs_input_from: Array.isArray(raw.needs_input_from)
      ? (raw.needs_input_from as Array<{ role: string; question: string }>)
      : [],
  };
}

async function enrichPodUpdate(podId: string, updateId: string): Promise<void> {
  const row = db
    .prepare(
      "SELECT id, summary, details, scope FROM context_updates WHERE id = ? AND pod_id = ?",
    )
    .get(updateId, podId) as UpdateRow | undefined;
  if (!row) return;

  const raw = await callLLMJSON<LLMEnrichmentResponse>({
    model: MODELS.fast,
    system: getSystemPrompt(),
    prompt: buildPrompt(row),
    maxTokens: 400,
  });
  if (raw == null) return;

  const enriched = parseResponse(raw, row.summary);

  db.prepare(
    `UPDATE context_updates
     SET type = ?, summary = ?, status = ?, blocks_json = ?, blocked_by_json = ?, needs_input_from_json = ?
     WHERE id = ? AND pod_id = ?`,
  ).run(
    enriched.type,
    enriched.summary,
    enriched.status,
    JSON.stringify(enriched.blocks),
    JSON.stringify(enriched.blocked_by),
    JSON.stringify(enriched.needs_input_from),
    updateId,
    podId,
  );

  broadcast({
    type: "context_update_enriched",
    podId,
    payload: {
      id: updateId,
      type: enriched.type,
      summary: enriched.summary,
      status: enriched.status,
      blocks: enriched.blocks,
      blocked_by: enriched.blocked_by,
      needs_input_from: enriched.needs_input_from,
    },
  });
}

async function enrichProjectUpdate(projectId: string, updateId: string): Promise<void> {
  const row = db
    .prepare(
      "SELECT id, summary, details, scope FROM project_context_updates WHERE id = ? AND project_id = ?",
    )
    .get(updateId, projectId) as UpdateRow | undefined;
  if (!row) return;

  const raw = await callLLMJSON<LLMEnrichmentResponse>({
    model: MODELS.fast,
    system: getSystemPrompt(),
    prompt: buildPrompt(row),
    maxTokens: 400,
  });
  if (raw == null) return;

  const enriched = parseResponse(raw, row.summary);

  db.prepare(
    `UPDATE project_context_updates
     SET type = ?, summary = ?, status = ?, blocks_json = ?, blocked_by_json = ?, needs_input_from_json = ?
     WHERE id = ? AND project_id = ?`,
  ).run(
    enriched.type,
    enriched.summary,
    enriched.status,
    JSON.stringify(enriched.blocks),
    JSON.stringify(enriched.blocked_by),
    JSON.stringify(enriched.needs_input_from),
    updateId,
    projectId,
  );

  broadcastToAll({
    type: "project_context_update_enriched",
    payload: {
      projectId,
      id: updateId,
      type: enriched.type,
      summary: enriched.summary,
      status: enriched.status,
      blocks: enriched.blocks,
      blocked_by: enriched.blocked_by,
      needs_input_from: enriched.needs_input_from,
    },
  });
}

/** Fire-and-forget Haiku enrichment for git-hook sourced pod updates (does not block the request). */
export function scheduleGitHookEnrichment(podId: string, updateId: string): void {
  if (!isLLMAvailable()) return;
  queueMicrotask(() => {
    enrichPodUpdate(podId, updateId).catch((err) => {
      console.error("[git-hook-enrichment]", err);
    });
  });
}

/** Fire-and-forget Haiku enrichment for git-hook sourced project updates (does not block the request). */
export function scheduleProjectGitHookEnrichment(projectId: string, updateId: string): void {
  if (!isLLMAvailable()) return;
  queueMicrotask(() => {
    enrichProjectUpdate(projectId, updateId).catch((err) => {
      console.error("[git-hook-enrichment]", err);
    });
  });
}
