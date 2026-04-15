import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import db from "../../db/connection.js";
import { callLLM, isLLMAvailable, MODELS } from "../llm.js";
import type { EnhancedPodLearning, KnowledgeNodeType } from "@council/shared";

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
}

interface ResolvedConflictRow {
  id: string;
  summary: string;
  resolution: string;
  severity: string;
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
  conflict_pressure: number;
  milestone_json: string;
}

export interface PodLearning {
  type: "pattern" | "resolved_conflict" | "anti_pattern" | "scope_insight";
  summary: string;
  details: string;
}

// --- Deterministic extraction (always works, no LLM) ---

export function extractKnowledge(podId: string): PodLearning[] {
  const learnings: PodLearning[] = [];

  // Extract decisions as patterns
  const decisions = db.prepare(
    "SELECT agent_id, timestamp, summary, details FROM context_updates WHERE pod_id = ? AND type = 'decision' ORDER BY timestamp ASC",
  ).all(podId) as DecisionRow[];

  for (const d of decisions) {
    learnings.push({
      type: "pattern",
      summary: d.summary,
      details: `Decision by ${d.agent_id}: ${d.details || d.summary}`,
    });
  }

  // Extract resolved conflicts with their resolutions
  const resolved = db.prepare(
    "SELECT id, summary, resolution, severity FROM conflicts WHERE pod_id = ? AND status = 'resolved'",
  ).all(podId) as ResolvedConflictRow[];

  for (const r of resolved) {
    learnings.push({
      type: "resolved_conflict",
      summary: `${r.summary} — resolved: ${r.resolution}`,
      details: `Conflict ${r.id} (${r.severity}): ${r.summary}. Resolution: ${r.resolution}`,
    });
  }

  // Extract blockers as potential anti-patterns
  const blockers = db.prepare(
    "SELECT agent_id, summary, details FROM context_updates WHERE pod_id = ? AND type = 'blocker' ORDER BY timestamp ASC",
  ).all(podId) as DecisionRow[];

  for (const b of blockers) {
    learnings.push({
      type: "anti_pattern",
      summary: `Blocker encountered: ${b.summary}`,
      details: `Reported by ${b.agent_id}: ${b.details || b.summary}`,
    });
  }

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

function inferDomains(learning: PodLearning, podId: string): string[] {
  // Infer domains from the learning text by checking for scope keywords
  const text = `${learning.summary} ${learning.details}`.toLowerCase();
  const domains: string[] = [];
  const scopeKeywords: Record<string, string[]> = {
    frontend: ["frontend", "ui", "react", "component", "css", "layout", "design"],
    backend: ["backend", "api", "server", "database", "endpoint", "lambda"],
    design: ["design", "figma", "mockup", "wireframe", "ux", "user experience"],
    qa: ["test", "qa", "quality", "bug", "regression", "coverage"],
    infra: ["infra", "deploy", "ci", "cd", "pipeline", "aws", "docker", "kubernetes"],
    pm: ["pm", "product", "roadmap", "milestone", "stakeholder", "requirement"],
  };
  for (const [scope, keywords] of Object.entries(scopeKeywords)) {
    if (keywords.some((kw) => text.includes(kw))) {
      domains.push(scope);
    }
  }
  // If no domains inferred, use "general"
  if (domains.length === 0) domains.push("general");
  return domains;
}

export async function extractKnowledgeEnhanced(
  podId: string,
): Promise<EnhancedPodLearning[]> {
  // Step 1: Deterministic base extraction
  const baseLearnings = extractKnowledge(podId);
  const enhanced: EnhancedPodLearning[] = baseLearnings.map((l) => ({
    type: l.type as KnowledgeNodeType,
    summary: l.summary,
    details: l.details,
    domains: inferDomains(l, podId),
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
    ).all(podId) as ContextRow[];
    const conflicts = db.prepare(
      "SELECT id, summary, resolution, severity, status FROM conflicts WHERE pod_id = ?",
    ).all(podId) as (ResolvedConflictRow & { status: string })[];

    // Build context for the LLM
    const decisionsText = updates
      .filter((u) => u.type === "decision")
      .map((u) => `- [${u.scope}] ${u.summary}: ${u.details}`)
      .join("\n") || "No decisions recorded.";

    const conflictsText = conflicts
      .map((c) => `- [${c.severity}/${c.status}] ${c.summary}${c.resolution ? ` → Resolved: ${c.resolution}` : ""}`)
      .join("\n") || "No conflicts recorded.";

    const podStateText = pod
      ? `Pod "${pod.name}" — Day ${pod.day_number}/${pod.total_days}, Final Pressure: ${pod.conflict_pressure}`
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

      for (const l of llmLearnings) {
        const nodeType = isValidNodeType(l.type) ? l.type : "scope_insight";

        // Check for overlap with deterministic learnings
        const isDuplicate = enhanced.some((e) => {
          const overlapWords = l.summary.toLowerCase().split(/\s+/)
            .filter((w) => e.summary.toLowerCase().includes(w));
          return overlapWords.length / l.summary.split(/\s+/).length > 0.5;
        });

        if (!isDuplicate) {
          enhanced.push({
            type: nodeType,
            summary: l.summary,
            details: l.details,
            domains: Array.isArray(l.domain) ? l.domain : [l.domain ?? "general"],
            confidence: "inferred",
            confidence_score: mapConfidenceToScore(l.confidence),
          });
        }
      }
    }

    console.log(`[knowledge-extraction] Enhanced extraction: ${enhanced.length} learnings (deterministic + LLM)`);
  } catch (err) {
    console.error("[knowledge-extraction] LLM extraction failed, using deterministic only:", err);
  }

  return enhanced;
}
