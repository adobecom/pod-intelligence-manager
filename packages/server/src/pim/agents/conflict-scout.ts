import db from "../../db/connection.js";
import type { ContextUpdate, OrgTuning } from "@pim/shared";
import { DEFAULT_ORG_TUNING } from "@pim/shared";
import type { Classification } from "../classifier.js";
import { callLLMJSON, isLLMAvailable, MODELS } from "../llm.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Last K context rows in this scope (any agent), for peer-presence and prompt context. */
export const SCOUT_PEER_WINDOW = DEFAULT_ORG_TUNING.conflictScout.peerWindow;

/** Min scout confidence to auto-open a conflict when heuristics said `additive`. */
export const ADDITIVE_SCOUT_CONFLICT_MIN_CONF = DEFAULT_ORG_TUNING.conflictScout.additiveMinConf;

/** Min scout confidence to force conflict on `overlapping` without waiting for merge LLM. */
export const OVERLAP_SCOUT_FORCE_CONFLICT_MIN_CONF = DEFAULT_ORG_TUNING.conflictScout.overlapForceMinConf;

/** If merge LLM escalates but scout says `none` with at least this confidence, skip creating a conflict. */
export const SUPPRESS_MERGE_ESCALATE_MIN_CONF = DEFAULT_ORG_TUNING.conflictScout.suppressMergeMinConf;

const DETAILS_CAP = DEFAULT_ORG_TUNING.conflictScout.detailsCap;

export type ScoutRecommendation = "none" | "coordination" | "open_conflict";

export interface ConflictScoutResult {
  recommendation: ScoutRecommendation;
  confidence: number;
  rationale: string;
}

interface PeerRow {
  id: string;
  agent_id: string;
  type: string;
  summary: string;
  details: string;
  timestamp: string;
}

interface LLMScoutResponse {
  recommendation?: string;
  confidence?: number;
  rationale?: string;
}

let _systemPrompt: string | null = null;
function getSystemPrompt(): string {
  if (!_systemPrompt) {
    _systemPrompt = fs.readFileSync(
      path.resolve(__dirname, "../../../../../prompts/conflict-scout-agent.md"),
      "utf-8",
    );
  }
  return _systemPrompt;
}

function truncateDetails(s: string, cap: number): string {
  if (s.length <= cap) return s;
  return `${s.slice(0, cap)}…`;
}

/** True if any row in the last K scope updates is from another agent (cross-agent activity). */
export function hasCrossAgentPeerInScoutWindow(update: ContextUpdate, peerWindow = SCOUT_PEER_WINDOW): boolean {
  const rows = db
    .prepare(
      `SELECT agent_id FROM context_updates
       WHERE pod_id = ? AND scope = ?
       ORDER BY timestamp DESC
       LIMIT ?`,
    )
    .all(update.pod_id, update.scope, peerWindow) as { agent_id: string }[];

  return rows.some((r) => r.agent_id !== update.agent_id);
}

export function shouldRunConflictScout(
  classification: Classification,
  update: ContextUpdate,
  tuning?: OrgTuning["conflictScout"],
): boolean {
  if (!isLLMAvailable()) return false;
  if (classification === "contradictory") return false;
  if (classification === "overlapping") return true;
  // additive
  return hasCrossAgentPeerInScoutWindow(update, tuning?.peerWindow ?? SCOUT_PEER_WINDOW);
}

function loadPeerBundle(update: ContextUpdate, peerWindow: number): PeerRow[] {
  return db
    .prepare(
      `SELECT id, agent_id, type, summary, details, timestamp
       FROM context_updates
       WHERE pod_id = ? AND scope = ? AND agent_id != ? AND id != ?
       ORDER BY timestamp DESC
       LIMIT ?`,
    )
    .all(
      update.pod_id,
      update.scope,
      update.agent_id,
      update.id,
      peerWindow,
    ) as unknown as PeerRow[];
}

function normalizeScoutResponse(raw: LLMScoutResponse | null): ConflictScoutResult | null {
  if (!raw?.recommendation) return null;
  const rec = raw.recommendation as string;
  if (rec !== "none" && rec !== "coordination" && rec !== "open_conflict") return null;
  const confidence =
    typeof raw.confidence === "number" && Number.isFinite(raw.confidence)
      ? Math.min(1, Math.max(0, raw.confidence))
      : 0;
  const rationale = typeof raw.rationale === "string" ? raw.rationale : "";
  return {
    recommendation: rec,
    confidence,
    rationale,
  };
}

export async function runConflictScout(
  update: ContextUpdate,
  heuristicClassification: Classification,
  tuning?: OrgTuning["conflictScout"],
): Promise<ConflictScoutResult | null> {
  if (!isLLMAvailable()) return null;

  const peerWindow = tuning?.peerWindow ?? SCOUT_PEER_WINDOW;
  const detailsCap = tuning?.detailsCap ?? DETAILS_CAP;
  const peers = loadPeerBundle(update, peerWindow);
  if (peers.length === 0 && heuristicClassification === "additive") {
    return null;
  }

  const pod = db
    .prepare("SELECT name, conflict_pressure FROM pods WHERE pod_id = ?")
    .get(update.pod_id) as { name: string; conflict_pressure: number } | undefined;

  const peerBlock =
    peers.length === 0
      ? "(No peer rows in window — overlapping path.)"
      : peers
          .map(
            (p) =>
              `- [${p.timestamp}] ${p.agent_id} (${p.type}): ${p.summary}\n  Details: ${truncateDetails(p.details, detailsCap)}`,
          )
          .join("\n");

  const prompt = `## Heuristic classification
${heuristicClassification}

## Pod
- Name: ${pod?.name ?? update.pod_id}
- Conflict pressure: ${pod?.conflict_pressure ?? 0}

## New update
- Agent: ${update.agent_id}
- Type: ${update.type}
- Scope: ${update.scope}
- Status: ${update.status}
- Summary: ${update.summary}
- Details: ${truncateDetails(update.details, detailsCap)}

## Peer updates (other agents, same scope)
${peerBlock}

Return JSON only: {"recommendation":"none"|"coordination"|"open_conflict","confidence":0.0-1.0,"rationale":"..."}`;

  try {
    const raw = await callLLMJSON<LLMScoutResponse>({
      model: MODELS.fast,
      system: getSystemPrompt(),
      prompt,
      maxTokens: 600,
    });
    return normalizeScoutResponse(raw);
  } catch (err) {
    console.error("[conflict-scout] LLM call failed:", err);
    return null;
  }
}

export function scoutSaysOpenConflict(
  scout: ConflictScoutResult | null,
  minConfidence: number,
): boolean {
  if (!scout) return false;
  return scout.recommendation === "open_conflict" && scout.confidence >= minConfidence;
}

export function scoutSuppressesMergeEscalate(scout: ConflictScoutResult | null, minConf = SUPPRESS_MERGE_ESCALATE_MIN_CONF): boolean {
  if (!scout) return false;
  return scout.recommendation === "none" && scout.confidence >= minConf;
}
