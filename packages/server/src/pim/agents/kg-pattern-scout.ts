import { randomUUID } from "crypto";
import type { ContextUpdate, KnowledgeNode, OrgTuning } from "@pim/shared";
import { DEFAULT_ORG_TUNING } from "@pim/shared";
import { getOrgPatternCandidates } from "../../services/knowledge-graph.js";
import { isLLMAvailable, callLLMJSON, MODELS } from "../llm.js";
import { appendLintFinding, type LintFinding } from "./lint.js";
import { createOrgPatternConflict } from "./conflict.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type KgPatternRecommendation = "none" | "advisory" | "open_conflict";

export interface KgPatternScoutResult {
  kg_scout_used: boolean;
  kg_hits: number;
  kg_recommendation: KgPatternRecommendation;
  kg_primary_node_id?: string;
  kg_conflict_created?: boolean;
  kg_conflict_id?: string;
  kg_lint_finding_id?: string;
  kg_rationale?: string;
}

interface LLMKgScoutResponse {
  recommendation?: string;
  confidence?: number;
  rationale?: string;
  primary_node_id?: string | null;
  contradiction_summary?: string | null;
}

let _systemPrompt: string | null = null;
function getSystemPrompt(): string {
  if (!_systemPrompt) {
    _systemPrompt = fs.readFileSync(
      path.resolve(__dirname, "../../../../../prompts/kg-pattern-scout-agent.md"),
      "utf-8",
    );
  }
  return _systemPrompt;
}

function formatCandidates(nodes: KnowledgeNode[]): string {
  if (nodes.length === 0) return "None";
  return nodes
    .slice(0, 8)
    .map(
      (n) =>
        `- [${n.id}] type=${n.type} confidence=${n.confidence_score.toFixed(2)} pod=${n.source_pod_name ?? n.source_pod_id}\n  ${n.summary}${n.details ? `\n  ${n.details.slice(0, 200)}` : ""}`,
    )
    .join("\n");
}

export async function runKgPatternScout(
  update: ContextUpdate,
  orgId: string | undefined,
  tuning: OrgTuning["kgPatternScout"] = DEFAULT_ORG_TUNING.kgPatternScout,
  podPressure = 0,
  openConflictCount = 0,
): Promise<KgPatternScoutResult> {
  const empty: KgPatternScoutResult = {
    kg_scout_used: false,
    kg_hits: 0,
    kg_recommendation: "none",
  };

  if (!orgId || !tuning.enabled) return empty;

  const queryText = `${update.summary}\n${update.details}`;
  let candidates: KnowledgeNode[] = [];
  try {
    const result = await getOrgPatternCandidates(orgId, queryText, update.scope, {
      maxTokens: tuning.maxTokens,
      types: tuning.types,
      confidenceMin: 0.65,
    });
    candidates = result.nodes;
  } catch (err) {
    console.warn("[kg-pattern-scout] KG query failed:", err);
    return empty;
  }

  if (candidates.length === 0) return empty;

  if (!isLLMAvailable()) {
    return { ...empty, kg_scout_used: true, kg_hits: candidates.length };
  }

  const prompt = `## New Context Update
- Agent: ${update.agent_id}
- Scope: ${update.scope}
- Type: ${update.type}
- Summary: ${update.summary}
- Details: ${update.details}

## KG Candidates
${formatCandidates(candidates)}

## Pod State
- Conflict pressure: ${podPressure}
- Open conflicts: ${openConflictCount}`;

  let recommendation: KgPatternRecommendation = "none";
  let confidence = 0;
  let rationale = "";
  let primaryNodeId: string | undefined;
  let contradictionSummary: string | undefined;

  try {
    const response = await callLLMJSON<LLMKgScoutResponse>({
      model: MODELS.fast,
      system: getSystemPrompt(),
      prompt,
    });
    if (response) {
      const rec = response.recommendation;
      if (rec === "advisory" || rec === "open_conflict" || rec === "none") {
        recommendation = rec;
      }
      confidence = typeof response.confidence === "number" ? response.confidence : 0;
      rationale = response.rationale ?? "";
      primaryNodeId = response.primary_node_id ?? undefined;
      contradictionSummary = response.contradiction_summary ?? undefined;
    }
  } catch (err) {
    console.error("[kg-pattern-scout] LLM failed:", err);
    return { ...empty, kg_scout_used: true, kg_hits: candidates.length };
  }

  const primaryNode =
    (primaryNodeId ? candidates.find((n) => n.id === primaryNodeId) : undefined) ??
    candidates[0];

  const result: KgPatternScoutResult = {
    kg_scout_used: true,
    kg_hits: candidates.length,
    kg_recommendation: recommendation,
    kg_primary_node_id: primaryNode?.id,
    kg_rationale: rationale,
  };

  if (recommendation === "none") return result;

  if (recommendation === "advisory" && confidence >= tuning.advisoryMinConf) {
    const findingId = `lint-kg-${randomUUID().slice(0, 8)}`;
    const finding: LintFinding = {
      id: findingId,
      pod_id: update.pod_id,
      timestamp: new Date().toISOString(),
      type: "kg_org_contradiction",
      severity: "warning",
      summary: contradictionSummary ?? `Possible contradiction with org ${primaryNode?.type}: ${primaryNode?.summary ?? "precedent"}`,
      area: update.scope,
      suggestion: primaryNode
        ? `Review KG node ${primaryNode.id} (${primaryNode.source_pod_name ?? "org"}). Align with org precedent or document an explicit override.`
        : "Review matching org knowledge before proceeding.",
    };
    appendLintFinding(update.pod_id, finding);
    result.kg_lint_finding_id = findingId;
    return result;
  }

  if (recommendation === "open_conflict" && confidence >= tuning.openConflictMinConf && primaryNode) {
    const conflict = await createOrgPatternConflict(update, primaryNode, {
      contradictionSummary: contradictionSummary ?? rationale,
      rationale,
      confidence,
    });
    if (conflict) {
      result.kg_conflict_created = true;
      result.kg_conflict_id = conflict.id;
    }
    return result;
  }

  return result;
}
