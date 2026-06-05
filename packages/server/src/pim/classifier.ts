import db from "../db/connection.js";
import type { ContextUpdate, OrgTuning } from "@pim/shared";
import { DEFAULT_ORG_TUNING } from "@pim/shared";

export type Classification = "additive" | "overlapping" | "contradictory";

interface ConflictScopeRow {
  sides_json: string;
}

interface RecentUpdateRow {
  id: string;
  agent_id: string;
  scope: string;
  summary: string;
  details: string;
}

// Classify whether a new context update is additive, overlapping, or contradictory
export function classifyUpdate(
  update: ContextUpdate,
  tuning?: OrgTuning["classifier"],
  pressureCautiousMax?: number,
): Classification {
  const podId = update.pod_id;
  const t = tuning ?? DEFAULT_ORG_TUNING.classifier;
  const pressureOverride = pressureCautiousMax ?? t.highPressureOverride;

  // 1. Check if this update's scope overlaps with any open conflict
  const openConflicts = db.prepare(
    "SELECT sides_json FROM conflicts WHERE pod_id = ? AND status != 'resolved'"
  ).all(podId) as unknown as ConflictScopeRow[];

  for (const conflict of openConflicts) {
    const sides = JSON.parse(conflict.sides_json) as Array<{ contributor: string }>;
    const conflictAgents = sides.map(s => s.contributor);
    if (conflictAgents.includes(update.agent_id)) {
      return "contradictory";
    }
  }

  // 2. Check if the update references entities from a different agent's recent work in the same scope
  const recentUpdates = db.prepare(
    "SELECT id, agent_id, scope, summary, details FROM context_updates WHERE pod_id = ? AND scope = ? AND agent_id != ? ORDER BY timestamp DESC LIMIT ?"
  ).all(podId, update.scope, update.agent_id, t.peerWindow) as unknown as RecentUpdateRow[];

  if (recentUpdates.length > 0) {
    const updateText = update.summary + " " + update.details;
    const updateWords = extractKeywords(updateText);
    for (const recent of recentUpdates) {
      const recentText = recent.summary + " " + (recent.details ?? "");
      const recentWords = extractKeywords(recentText);
      const overlap = updateWords.filter(w => recentWords.includes(w));
      if (overlap.length >= t.overlapKeywordMin) {
        if (hasContradictionSignal(updateText)) {
          return "contradictory";
        }
        return "overlapping";
      }
    }
  }

  // 3. Check conflict pressure
  const pod = db.prepare("SELECT conflict_pressure FROM pods WHERE pod_id = ?").get(podId) as { conflict_pressure: number } | undefined;
  if (pod && pod.conflict_pressure > pressureOverride) {
    return "overlapping";
  }

  return "additive";
}

function extractKeywords(text: string): string[] {
  const stopWords = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "need", "dare", "ought",
    "used", "to", "of", "in", "for", "on", "with", "at", "by", "from",
    "as", "into", "through", "during", "before", "after", "above", "below",
    "between", "out", "off", "over", "under", "again", "further", "then",
    "once", "and", "but", "or", "nor", "not", "no", "so", "than", "too",
    "very", "just", "about", "up", "this", "that", "these", "those",
    "it", "its", "we", "they", "them", "their", "our", "my", "your",
    "now", "new", "also", "added", "updated", "implemented",
  ]);

  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));
}

function hasContradictionSignal(text: string): boolean {
  const normalized = text.toLowerCase();
  return /\b(contradict|contradicts|contradiction|incompatible|rejected|rejects|rollback|revert|supersede|supersedes|instead of|rather than|must not|should not|do not|don't|never)\b/.test(normalized)
    || /\bconflicts?\s+with\b/.test(normalized);
}
