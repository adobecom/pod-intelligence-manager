import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import db from "../../db/connection.js";
import { callLLM, callLLMJSON, isLLMAvailable, MODELS } from "../llm.js";
import type { EnhancedPodLearning, KnowledgeNodeType } from "@pim/shared";
import { computeCurrentDay } from "../../services/pod-day.js";
import { getGraph } from "../../services/knowledge-graph.js";
import {
  generateEmbedding,
  isEmbeddingAvailable,
  cosineSimilarity,
} from "../../services/embeddings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _systemPrompt: string | null = null;
function getSystemPrompt(): string {
  if (!_systemPrompt) {
    _systemPrompt = fs.readFileSync(
      path.resolve(__dirname, "../../../../../prompts/knowledge-extraction-agent.md"),
      "utf-8",
    );
  }
  return _systemPrompt;
}

let _durabilityPrompt: string | null = null;
function getDurabilityPrompt(): string {
  if (!_durabilityPrompt) {
    _durabilityPrompt = fs.readFileSync(
      path.resolve(__dirname, "../../../../../prompts/decision-durability-classifier.md"),
      "utf-8",
    );
  }
  return _durabilityPrompt;
}

interface DecisionRow {
  agent_id: string;
  timestamp: string;
  summary: string;
  details: string;
  scope: string;
}

interface ResolvedConflictRow {
  id: string;
  summary: string;
  resolution: string;
  severity: string;
  scope: string | null;
}

interface ContextRow {
  type: string;
  scope: string;
  summary: string;
  details: string;
  agent_id: string;
  status: string;
}

interface PodRow {
  name: string;
  day_number: number;
  total_days: number;
  sprint_start?: string;
  conflict_pressure: number;
  milestone_json: string;
}

export interface PodLearning {
  type: "pattern" | "resolved_conflict" | "anti_pattern" | "scope_insight";
  summary: string;
  details: string;
  /** Authoritative scope from the source row, when available. */
  scope?: string;
}

// Decisions with details shorter than this are noise (one-word edits, blank entries).
const MIN_DECISION_DETAIL_LENGTH = 30;

// Hard ceiling on per-pod learnings persisted into the graph. Sorted by confidence_score DESC.
// Prevents pathological pods from producing 50+ pattern nodes despite the prompt's 3-8 guidance.
export const MAX_LEARNINGS_PER_POD = 20;

// Resolved conflicts are inherently substantive — keep the prior confidence floor.
const RESOLVED_CONFLICT_SCORE = 0.9;

// Score for deterministic patterns when the Haiku classifier is unavailable. Lower than the
// previous hardcoded 0.9 — even offline we stop overclaiming durability.
const DEFAULT_PATTERN_SCORE = 0.7;

// --- Deterministic extraction (always works, no LLM) ---

export function extractKnowledge(podId: string): PodLearning[] {
  const learnings: PodLearning[] = [];

  // Decisions become patterns. Filter out trivial entries with no reusable signal.
  const decisions = db.prepare(
    `SELECT agent_id, timestamp, summary, details, scope
     FROM context_updates
     WHERE pod_id = ? AND type = 'decision'
       AND length(coalesce(details, summary)) >= ?
     ORDER BY timestamp ASC`,
  ).all(podId, MIN_DECISION_DETAIL_LENGTH) as unknown as DecisionRow[];

  for (const d of decisions) {
    learnings.push({
      type: "pattern",
      summary: d.summary,
      details: d.details || d.summary,
      scope: d.scope,
    });
  }

  // Resolved conflicts. Pull the scope from the first referenced context update via a LEFT JOIN
  // when possible — falls back to NULL if the conflict's sides don't reference a known update.
  const resolved = db.prepare(
    `SELECT c.id, c.summary, c.resolution, c.severity,
            (SELECT cu.scope
             FROM context_updates cu, json_each(c.sides_json) s
             WHERE cu.id = json_extract(s.value, '$.context_update_id')
             LIMIT 1) AS scope
     FROM conflicts c
     WHERE c.pod_id = ? AND c.status = 'resolved'`,
  ).all(podId) as unknown as ResolvedConflictRow[];

  for (const r of resolved) {
    learnings.push({
      type: "resolved_conflict",
      summary: `${r.summary} — resolved: ${r.resolution}`,
      details: `Conflict ${r.id} (${r.severity}): ${r.summary}. Resolution: ${r.resolution}`,
      scope: r.scope ?? undefined,
    });
  }

  // Blockers are not extracted. Most are transient ("waiting on approval", "CI flaky")
  // and don't generalize as anti-patterns. Anti-patterns must come from the LLM
  // extraction or the explicit ad-hoc submission API.

  return learnings;
}

// --- Durability classifier (Haiku) ---

type Durability = "high" | "medium" | "low" | "junk";

const DURABILITY_TO_SCORE: Record<Durability, number> = {
  high: 0.85,
  medium: 0.7,
  low: 0.5,
  junk: 0.3,
};

interface DurabilityRating {
  index: number;
  durability: Durability;
}

interface DurabilityResponse {
  ratings: DurabilityRating[];
}

/**
 * Classify deterministic pattern items by durability using Haiku. Returns a Map<index, score>
 * keyed by position in the input array. Items missing from the response (or any failure mode)
 * fall back to DEFAULT_PATTERN_SCORE.
 */
export async function classifyDecisionDurability(
  items: PodLearning[],
): Promise<Map<number, number>> {
  const scores = new Map<number, number>();
  if (items.length === 0) return scores;

  if (!isLLMAvailable()) {
    // Offline: keep things safe but not over-claimed.
    items.forEach((_, i) => scores.set(i, DEFAULT_PATTERN_SCORE));
    return scores;
  }

  const prompt = JSON.stringify(
    items.map((item, index) => ({
      index,
      scope: item.scope ?? "unknown",
      summary: item.summary,
      details: item.details,
    })),
  );

  try {
    const response = await callLLMJSON<DurabilityResponse>({
      model: MODELS.fast,
      system: getDurabilityPrompt(),
      prompt,
      maxTokens: 1024,
    });
    if (response?.ratings) {
      for (const rating of response.ratings) {
        const score = DURABILITY_TO_SCORE[rating.durability];
        if (typeof rating.index === "number" && score !== undefined) {
          scores.set(rating.index, score);
        }
      }
    }
  } catch (err) {
    console.error("[knowledge-extraction] Durability classifier failed:", err);
  }

  // Fill in any items the classifier didn't return.
  for (let i = 0; i < items.length; i++) {
    if (!scores.has(i)) scores.set(i, DEFAULT_PATTERN_SCORE);
  }
  return scores;
}

// --- Enhanced extraction: deterministic base + optional LLM analysis ---

interface LLMLearning {
  type: string;
  domain: string[] | string;
  summary: string;
  details: string;
  confidence: string;
}

function mapConfidenceToScore(confidence: string): number {
  switch (confidence) {
    case "high": return 0.85;
    case "medium": return 0.6;
    case "low": return 0.4;
    default: return 0.5;
  }
}

function isValidNodeType(type: string): type is KnowledgeNodeType {
  return ["decision", "pattern", "anti_pattern", "resolved_conflict", "scope_insight"].includes(type);
}

/**
 * Normalize an LLM `domain` field into a string[]. Returns null when the field is missing,
 * empty, or otherwise unusable — callers should drop the entry rather than guess.
 */
function normalizeLLMDomains(raw: LLMLearning["domain"]): string[] | null {
  if (Array.isArray(raw)) {
    const cleaned = raw.map((d) => String(d).trim()).filter(Boolean);
    return cleaned.length > 0 ? cleaned : null;
  }
  if (typeof raw === "string" && raw.trim()) {
    return [raw.trim()];
  }
  return null;
}

export async function extractKnowledgeEnhanced(
  podId: string,
  orgId: string,
): Promise<EnhancedPodLearning[]> {
  // Step 1: Deterministic base extraction. Use the authoritative `scope` from the source row
  // when present; default to "unknown" rather than keyword-bag inference (which mis-tags).
  const baseLearnings = extractKnowledge(podId);

  // Step 2: Score deterministic patterns by durability. Resolved conflicts skip the classifier
  // and keep the higher floor — a resolved disagreement is inherently substantive.
  const patternIndices: number[] = [];
  const patternsForClassifier: PodLearning[] = [];
  baseLearnings.forEach((l, i) => {
    if (l.type === "pattern") {
      patternIndices.push(i);
      patternsForClassifier.push(l);
    }
  });
  const durabilityScores = await classifyDecisionDurability(patternsForClassifier);

  const enhanced: EnhancedPodLearning[] = baseLearnings.map((l, i) => {
    let confidence_score = RESOLVED_CONFLICT_SCORE;
    if (l.type === "pattern") {
      const classifierIdx = patternIndices.indexOf(i);
      confidence_score = durabilityScores.get(classifierIdx) ?? DEFAULT_PATTERN_SCORE;
    }
    return {
      type: l.type as KnowledgeNodeType,
      summary: l.summary,
      details: l.details,
      domains: l.scope ? [l.scope] : ["unknown"],
      confidence: "extracted" as const,
      confidence_score,
    };
  });

  // Step 3: If LLM available, run enhanced extraction
  if (!isLLMAvailable()) {
    console.log(`[knowledge-extraction] LLM not available, returning ${enhanced.length} deterministic learnings`);
    return capLearnings(enhanced);
  }

  try {
    // Gather full pod context for LLM
    const pod = db.prepare("SELECT * FROM pods WHERE pod_id = ?").get(podId) as PodRow | undefined;
    const updates = db.prepare(
      "SELECT type, scope, summary, details, agent_id, status FROM context_updates WHERE pod_id = ? ORDER BY timestamp ASC",
    ).all(podId) as unknown as ContextRow[];
    const conflicts = db.prepare(
      "SELECT id, summary, resolution, severity, status FROM conflicts WHERE pod_id = ?",
    ).all(podId) as unknown as (ResolvedConflictRow & { status: string })[];

    // Build context for the LLM
    const decisionsText = updates
      .filter((u) => u.type === "decision")
      .map((u) => `- [${u.scope}] ${u.summary}: ${u.details}`)
      .join("\n") || "No decisions recorded.";

    const conflictsText = conflicts
      .map((c) => `- [${c.severity}/${c.status}] ${c.summary}${c.resolution ? ` → Resolved: ${c.resolution}` : ""}`)
      .join("\n") || "No conflicts recorded.";

    const displayDay = pod?.sprint_start && pod.total_days
      ? computeCurrentDay(pod.sprint_start, pod.total_days)
      : pod?.day_number ?? 0;
    const podStateText = pod
      ? `Pod "${pod.name}" — Day ${displayDay}/${pod.total_days}, Final Pressure: ${pod.conflict_pressure}`
      : `Pod ${podId}`;

    const prompt = `## Pod Summary\n${podStateText}\n\n## Decisions Log\n${decisionsText}\n\n## Conflicts\n${conflictsText}\n\n## All Context Updates (${updates.length} total)\n${updates.slice(-20).map((u) => `- [${u.type}/${u.scope}/${u.status}] ${u.summary}`).join("\n")}`;

    const raw = await callLLM({
      model: MODELS.smart,
      system: getSystemPrompt(),
      prompt,
      maxTokens: 2048,
    });

    // Parse JSON array from response (handle markdown code blocks)
    const jsonMatch =
      raw.match(/```(?:json)?\s*([\s\S]*?)```/) ?? raw.match(/(\[[\s\S]*\])/);
    if (jsonMatch) {
      const llmLearnings = JSON.parse(jsonMatch[1]) as LLMLearning[];

      // Pre-fetch existing graph nodes once so we can dedup against history, not just this batch.
      let existingNodes: { summary: string; embedding?: number[] }[] = [];
      try {
        existingNodes = getGraph(orgId).nodes.map((n) => ({ summary: n.summary, embedding: n.embedding }));
      } catch {
        // Graph not initialized yet (e.g. test setups) — skip historical dedup.
      }

      const embeddingsAvailable = isEmbeddingAvailable();

      for (const l of llmLearnings) {
        const nodeType = isValidNodeType(l.type) ? l.type : "scope_insight";

        // Skip entries the LLM produced without a domain. We don't keyword-infer anymore —
        // a mis-tagged node is worse than a dropped one (mis-tags poison cross-domain queries).
        const domains = normalizeLLMDomains(l.domain);
        if (!domains) {
          console.warn(`[knowledge-extraction] LLM learning skipped (missing domain): ${l.summary}`);
          continue;
        }

        // Word-overlap dedup against the current batch's deterministic learnings.
        const overlapsBatch = enhanced.some((e) => {
          const overlapWords = l.summary.toLowerCase().split(/\s+/)
            .filter((w) => e.summary.toLowerCase().includes(w));
          return overlapWords.length / l.summary.split(/\s+/).length > 0.5;
        });
        if (overlapsBatch) continue;

        // Embedding-based dedup against the existing graph (if embeddings available).
        if (embeddingsAvailable && existingNodes.length > 0) {
          const llmEmbedding = await generateEmbedding(`${l.summary}\n${l.details}`);
          if (llmEmbedding) {
            const overlapsHistory = existingNodes.some((e) => {
              if (!e.embedding) return false;
              return cosineSimilarity(llmEmbedding, e.embedding) >= 0.92;
            });
            if (overlapsHistory) continue;
          }
        }

        enhanced.push({
          type: nodeType,
          summary: l.summary,
          details: l.details,
          domains,
          confidence: "inferred",
          confidence_score: mapConfidenceToScore(l.confidence),
        });
      }
    }

    console.log(`[knowledge-extraction] Enhanced extraction: ${enhanced.length} learnings (deterministic + LLM)`);
  } catch (err) {
    console.error("[knowledge-extraction] LLM extraction failed, using deterministic only:", err);
  }

  return capLearnings(enhanced);
}

/**
 * Apply the per-pod ceiling. We sort by confidence_score DESC so the highest-signal learnings
 * survive truncation. Resolved conflicts (0.9) sort to the top; junk-classified patterns (0.3)
 * are first to drop.
 */
function capLearnings(learnings: EnhancedPodLearning[]): EnhancedPodLearning[] {
  if (learnings.length <= MAX_LEARNINGS_PER_POD) return learnings;
  const sorted = [...learnings].sort((a, b) => b.confidence_score - a.confidence_score);
  const dropped = sorted.length - MAX_LEARNINGS_PER_POD;
  console.log(`[knowledge-extraction] Truncated ${dropped} learnings over cap (kept top ${MAX_LEARNINGS_PER_POD})`);
  return sorted.slice(0, MAX_LEARNINGS_PER_POD);
}
