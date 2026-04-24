import db from "../db/connection.js";
import type { ContextUpdate } from "@pim/shared";

export type Classification = "additive" | "overlapping" | "contradictory";

interface ConflictScopeRow {
  sides_json: string;
}

interface RecentUpdateRow {
  id: string;
  agent_id: string;
  scope: string;
  summary: string;
}

// Classify whether a new context update is additive, overlapping, or contradictory
export function classifyUpdate(update: ContextUpdate): Classification {
  const podId = update.pod_id;

  // 1. Check if this update's scope overlaps with any open conflict
  const openConflicts = db.prepare(
    "SELECT sides_json FROM conflicts WHERE pod_id = ? AND status != 'resolved'"
  ).all(podId) as unknown as ConflictScopeRow[];

  for (const conflict of openConflicts) {
    const sides = JSON.parse(conflict.sides_json) as Array<{ contributor: string }>;
    const conflictAgents = sides.map(s => s.contributor);
    if (conflictAgents.includes(update.agent_id)) {
      // This agent is already part of an open conflict
      return "contradictory";
    }
  }

  // 2. Check if the update references entities from a different agent's recent work in the same scope
  const recentUpdates = db.prepare(
    "SELECT id, agent_id, scope, summary FROM context_updates WHERE pod_id = ? AND scope = ? AND agent_id != ? ORDER BY timestamp DESC LIMIT 5"
  ).all(podId, update.scope, update.agent_id) as unknown as RecentUpdateRow[];

  if (recentUpdates.length > 0) {
    // Simple keyword overlap check — look for shared significant terms
    const updateWords = extractKeywords(update.summary + " " + update.details);
    for (const recent of recentUpdates) {
      const recentWords = extractKeywords(recent.summary);
      const overlap = updateWords.filter(w => recentWords.includes(w));
      if (overlap.length >= 3) {
        return "overlapping";
      }
    }
  }

  // 3. Check conflict pressure
  const pod = db.prepare("SELECT conflict_pressure FROM pods WHERE pod_id = ?").get(podId) as { conflict_pressure: number } | undefined;
  if (pod && pod.conflict_pressure > 0.6) {
    // In degraded/critical mode, treat everything as overlapping for caution
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
