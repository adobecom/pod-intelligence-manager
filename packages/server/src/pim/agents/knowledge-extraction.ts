import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import db from "../../db/connection.js";
import { callLLM, isLLMAvailable, MODELS } from "../llm.js";
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

// --- Enhanced extraction: deterministic base + optional LLM analysis ---

interface LLMLearning {
  type: string;
  domain: string[];
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
 * Fallback domain inference for sources without an authoritative scope (e.g. LLM-generated
 * learnings whose `domain` field is missing). Prefer using the source row's `scope` directly.
 */
function inferDomainsFromText(text: string): string[] {
  const lower = text.toLowerCase();
  const domains: string[] = [];
  const scopeKeywords: Record<string, string[]> = {
    frontend: ["frontend", "ui", "react", "component", "css", "layout"],
    backend: ["backend", "api", "server", "database", "endpoint", "lambda"],
    design: ["figma", "mockup", "wireframe", "ux", "user experience"],
    qa: ["qa", "regression", "coverage", "test plan"],
    infra: ["infra", "deploy", "ci/cd", "pipeline", "aws", "docker", "kubernetes"],
    pm: ["roadmap", "milestone", "stakeholder", "requirement"],
  };
  for (const [scope, keywords] of Object.entries(scopeKeywords)) {
    if (keywords.some((kw) => lower.includes(kw))) {
      domains.push(scope);
    }
  }
  if (domains.length === 0) domains.push("general");
  return domains;
}

export async function extractKnowledgeEnhanced(
  podId: string,
): Promise<EnhancedPodLearning[]> {
  // Step 1: Deterministic base extraction. Use the authoritative `scope` from the source row
  // when present; fall back to keyword inference only when scope is missing.
  const baseLearnings = extractKnowledge(podId);
  const enhanced: EnhancedPodLearning[] = baseLearnings.map((l) => ({
    type: l.type as KnowledgeNodeType,
    summary: l.summary,
    details: l.details,
    domains: l.scope ? [l.scope] : inferDomainsFromText(`${l.summary} ${l.details}`),
    confidence: "extracted" as const,
    confidence_score: 0.9,
  }));

  // Step 2: If LLM available, run enhanced extraction
  if (!isLLMAvailable()) {
    console.log(`[knowledge-extraction] LLM not available, returning ${enhanced.length} deterministic learnings`);
    return enhanced;
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
        existingNodes = getGraph().nodes.map((n) => ({ summary: n.summary, embedding: n.embedding }));
      } catch {
        // Graph not initialized yet (e.g. test setups) — skip historical dedup.
      }

      const embeddingsAvailable = isEmbeddingAvailable();

      for (const l of llmLearnings) {
        const nodeType = isValidNodeType(l.type) ? l.type : "scope_insight";

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
          domains: Array.isArray(l.domain) && l.domain.length > 0
            ? l.domain
            : (typeof l.domain === "string" && l.domain
              ? [l.domain]
              : inferDomainsFromText(`${l.summary} ${l.details}`)),
          confidence: "inferred",
          confidence_score: mapConfidenceToScore(l.confidence),
        });
      }
    }

    console.log(`[knowledge-extraction] Enhanced extraction: ${enhanced.length} learnings (deterministic + LLM)`);
  } catch (err) {
    console.error("[knowledge-extraction] LLM extraction failed, using deterministic only:", err);
  }

  return enhanced;
}
