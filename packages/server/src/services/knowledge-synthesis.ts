/**
 * Scheduled graph synthesis — proposes composite learnings from the existing graph
 * plus persisted lint findings. Ingests via the ingestion gateway (skipAnalysis).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  EnhancedPodLearning,
  KnowledgeGraph,
  KnowledgeNodeType,
  KnowledgeIngestionProvenance,
} from "@pim/shared";
import db from "../db/connection.js";
import { callLLMJSON, isLLMAvailable, MODELS } from "../pim/llm.js";
import { identifyHubs } from "./graph-analysis.js";
import { getGraph } from "./knowledge-graph.js";
import { ingestLearnings } from "./ingestion-gateway.js";
import { isEmbeddingAvailable } from "./embeddings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const SYNTHESIS_SOURCE_POD_ID = "synthesis";
export const SYNTHESIS_SOURCE_POD_NAME = "Scheduled synthesis";

/** Minimum nodes with embeddings before synthesis runs (needs grounded dedup + context). */
export const MIN_EMBEDDED_NODES_FOR_SYNTHESIS = 5;
/** Max proposals accepted from the model per run. */
export const MAX_SYNTHESIS_PROPOSALS_PER_RUN = 5;
/** Max lint rows to load and show the model. */
export const MAX_LINT_ROWS = 25;
/** Max hub nodes to include in the prompt. */
export const MAX_HUB_NODES_IN_PROMPT = 12;
/** Max communities to summarize in the prompt. */
export const MAX_COMMUNITIES_IN_PROMPT = 8;
/** Max graph node lines listed in the prompt (avoids huge prompts). */
export const MAX_NODE_LINES_IN_PROMPT = 500;
/** Max characters for the GRAPH_NODES block after joining lines. */
export const MAX_NODE_BLOCK_CHARS = 100_000;
/** Inferred confidence score for synthesized nodes (kept low for ranking / pruning until curated). */
export const SYNTHESIS_CONFIDENCE_SCORE = 0.42;

export interface LintFindingRow {
  id: string;
  pod_id: string;
  timestamp: string;
  type: string;
  severity: string;
  summary: string;
  area: string | null;
  suggestion: string | null;
}

export interface RawSynthesisProposal {
  type?: string;
  summary?: string;
  details?: string;
  domains?: unknown;
  evidence_node_ids?: unknown;
  lint_finding_ids?: unknown;
}

export interface GraphSynthesisRunResult {
  ok: boolean;
  skipped?: string;
  run_id?: string;
  nodes_added?: number;
  edges_added?: number;
  error?: string;
}

const NODE_TYPES: KnowledgeNodeType[] = [
  "decision",
  "pattern",
  "anti_pattern",
  "resolved_conflict",
  "scope_insight",
];

function isValidNodeType(t: string): t is KnowledgeNodeType {
  return (NODE_TYPES as string[]).includes(t);
}

let _systemPrompt: string | null = null;
function getSystemPrompt(): string {
  if (!_systemPrompt) {
    _systemPrompt = fs.readFileSync(
      path.resolve(__dirname, "../../../../prompts/knowledge-synthesis-agent.md"),
      "utf-8",
    );
  }
  return _systemPrompt;
}

export function fetchRecentLintFindingsForOrg(orgId: string, limit: number): LintFindingRow[] {
  return db
    .prepare(
      `SELECT lf.id, lf.pod_id, lf.timestamp, lf.type, lf.severity, lf.summary, lf.area, lf.suggestion
       FROM lint_findings lf
       INNER JOIN pods p ON p.pod_id = lf.pod_id
       WHERE IFNULL(p.org_id, 'default') = ?
       ORDER BY lf.timestamp DESC
       LIMIT ?`,
    )
    .all(orgId, limit) as unknown as LintFindingRow[];
}

function nodeDegree(graph: KnowledgeGraph, nodeId: string): number {
  let d = 0;
  for (const e of graph.edges) {
    if (e.source === nodeId) d++;
    if (e.target === nodeId) d++;
  }
  return d;
}

function hubNodesForPrompt(graph: KnowledgeGraph): { id: string; text: string }[] {
  const hubIds = identifyHubs(graph);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const ranked = hubIds
    .filter((id) => byId.has(id))
    .sort((a, b) => nodeDegree(graph, b) - nodeDegree(graph, a))
    .slice(0, MAX_HUB_NODES_IN_PROMPT);

  return ranked.map((id) => {
    const n = byId.get(id)!;
    const details = n.details.length > 450 ? `${n.details.slice(0, 450)}…` : n.details;
    const text = [
      `id=${n.id}`,
      `type=${n.type}`,
      `domains=${n.domains.join(",")}`,
      `summary=${n.summary}`,
      `details=${details}`,
    ].join("\n");
    return { id: n.id, text };
  });
}

function buildUserPrompt(graph: KnowledgeGraph, lintRows: LintFindingRow[]): string {
  const communities = graph.communities.slice(0, MAX_COMMUNITIES_IN_PROMPT).map((c) => {
    return `- community ${c.id}: ${c.label} (nodes≈${c.node_count}) domains=[${c.top_domains.join(", ")}] summary=${c.summary}`;
  });

  const hubs = hubNodesForPrompt(graph);
  const hubBlock =
    hubs.length > 0
      ? hubs.map((h) => `### Hub node\n${h.text}`).join("\n\n")
      : "(No statistical hubs — use any nodes listed in GRAPH_NODES.)";

  const nodeLines = graph.nodes.map((n) => `- ${n.id} | ${n.type} | [${n.domains.join(", ")}] | ${n.summary}`);
  const linesTruncated = nodeLines.length > MAX_NODE_LINES_IN_PROMPT;
  const linesForPrompt = linesTruncated ? nodeLines.slice(0, MAX_NODE_LINES_IN_PROMPT) : nodeLines;
  let nodesBlock = linesForPrompt.join("\n");
  if (nodesBlock.length > MAX_NODE_BLOCK_CHARS) {
    nodesBlock = `${nodesBlock.slice(0, MAX_NODE_BLOCK_CHARS)}\n… (GRAPH_NODES truncated by size)`;
  } else if (linesTruncated) {
    nodesBlock += `\n… (${graph.nodes.length} total nodes; list truncated to ${MAX_NODE_LINES_IN_PROMPT} lines)`;
  }

  const lintBlock =
    lintRows.length === 0
      ? "(No recent lint findings.)"
      : lintRows
          .map(
            (r) =>
              `- id=${r.id} pod=${r.pod_id} type=${r.type} sev=${r.severity} area=${r.area ?? ""} summary=${r.summary}`,
          )
          .join("\n");

  return [
    "## Graph overview",
    `org_id=${graph.org_id} nodes=${graph.nodes.length} edges=${graph.edges.length}`,
    "",
    "## Communities",
    communities.length ? communities.join("\n") : "(No communities computed yet — still provide grounded proposals using nodes + lint.)",
    "",
    "## Hub nodes (high connectivity)",
    hubBlock,
    "",
    "## GRAPH_NODES (id | type | domains | summary)",
    nodesBlock,
    "",
    "## Recent lint findings",
    lintBlock,
    "",
    "Return JSON: {\"proposals\":[...]} as specified in your system instructions.",
  ].join("\n");
}

export interface ProposalValidationContext {
  graphNodeIds: Set<string>;
  lintIds: Set<string>;
  runId: string;
  model: string;
  maxOutputs: number;
}

/**
 * Maps raw LLM proposals to learnings; drops invalid rows. Exported for unit tests.
 */
export function rawProposalsToLearnings(
  proposals: RawSynthesisProposal[] | undefined,
  ctx: ProposalValidationContext,
): EnhancedPodLearning[] {
  if (!proposals?.length) return [];

  const out: EnhancedPodLearning[] = [];

  for (const p of proposals) {
    if (out.length >= ctx.maxOutputs) break;

    const summary = typeof p.summary === "string" ? p.summary.trim() : "";
    const details = typeof p.details === "string" ? p.details.trim() : "";
    const typeStr = typeof p.type === "string" ? p.type.trim() : "";

    if (summary.length < 10 || details.length < 30 || !isValidNodeType(typeStr)) continue;

    const domains = Array.isArray(p.domains)
      ? p.domains.map((d) => String(d).trim().toLowerCase()).filter(Boolean)
      : [];
    if (domains.length === 0) continue;

    const evRaw = Array.isArray(p.evidence_node_ids) ? p.evidence_node_ids : [];
    const evidence_node_ids = [...new Set(evRaw.map((id) => String(id).trim()).filter((id) => ctx.graphNodeIds.has(id)))];

    const lintRaw = Array.isArray(p.lint_finding_ids) ? p.lint_finding_ids : [];
    const lint_finding_ids = [
      ...new Set(lintRaw.map((id) => String(id).trim()).filter((id) => ctx.lintIds.has(id))),
    ];

    const evidenceOk = evidence_node_ids.length >= 2 || (evidence_node_ids.length >= 1 && lint_finding_ids.length >= 1);
    if (!evidenceOk) continue;

    const provenance: KnowledgeIngestionProvenance = {
      kind: "scheduled_synthesis",
      run_id: ctx.runId,
      model: ctx.model,
      evidence_node_ids,
      ...(lint_finding_ids.length > 0 ? { lint_finding_ids } : {}),
    };

    out.push({
      type: typeStr,
      summary,
      details,
      domains,
      confidence: "inferred",
      confidence_score: SYNTHESIS_CONFIDENCE_SCORE,
      ingestion_provenance: provenance,
    });
  }

  return out;
}

interface LLMSynthesisResponse {
  proposals?: RawSynthesisProposal[];
}

/**
 * Runs one synthesis pass for the given org's graph. Safe to call on a timer; no-ops when gated.
 * The periodic scheduler in index.ts invokes this once per loaded org per tick.
 */
export async function runScheduledGraphSynthesis(orgId: string): Promise<GraphSynthesisRunResult> {
  const run_id = crypto.randomUUID();

  if (!isLLMAvailable()) {
    return { ok: true, skipped: "llm_unavailable", run_id };
  }
  if (!isEmbeddingAvailable()) {
    return { ok: true, skipped: "embeddings_unavailable", run_id };
  }

  let graph: KnowledgeGraph;
  try {
    graph = getGraph(orgId);
  } catch {
    return { ok: false, error: "graph_not_initialized", run_id };
  }

  const embedded = graph.nodes.filter((n) => n.embedding?.length).length;
  if (embedded < MIN_EMBEDDED_NODES_FOR_SYNTHESIS) {
    return { ok: true, skipped: "insufficient_embedded_nodes", run_id };
  }

  const lintRows = fetchRecentLintFindingsForOrg(graph.org_id, MAX_LINT_ROWS);
  const lintIds = new Set(lintRows.map((r) => r.id));
  const graphNodeIds = new Set(graph.nodes.map((n) => n.id));

  const userPrompt = buildUserPrompt(graph, lintRows);
  const model = MODELS.fast;

  let parsed: LLMSynthesisResponse | null;
  try {
    parsed = await callLLMJSON<LLMSynthesisResponse>({
      model,
      system: getSystemPrompt(),
      prompt: userPrompt,
      maxTokens: 4096,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[knowledge-synthesis] LLM call failed:", err);
    return { ok: false, error: message, run_id };
  }

  const learnings = rawProposalsToLearnings(parsed?.proposals, {
    graphNodeIds,
    lintIds,
    runId: run_id,
    model,
    maxOutputs: MAX_SYNTHESIS_PROPOSALS_PER_RUN,
  });

  if (learnings.length === 0) {
    return { ok: true, skipped: "no_valid_proposals", run_id, nodes_added: 0, edges_added: 0 };
  }

  try {
    const result = await ingestLearnings(orgId, learnings, SYNTHESIS_SOURCE_POD_ID, SYNTHESIS_SOURCE_POD_NAME, "synthesis", undefined, {
      skipAnalysis: true,
    });
    console.log(
      `[knowledge-synthesis] run ${run_id} (org ${orgId}): added ${result.nodesAdded} node(s), ${result.edgesAdded} edge(s), dropped ${result.droppedCount} in pre-processing`,
    );
    return {
      ok: true,
      run_id,
      nodes_added: result.nodesAdded,
      edges_added: result.edgesAdded,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[knowledge-synthesis] ingestLearnings failed:", err);
    return { ok: false, error: message, run_id };
  }
}
