import db from "../db/connection.js";
import type {
  KnowledgeNode,
  ProjectAnswerIntent,
  ProjectAnswerRawHit,
  ProjectAnswerResponse,
  ProjectResources,
} from "@pim/shared";
import { queryKnowledge } from "./knowledge-graph.js";

interface ProjectRow {
  project_id: string;
  name: string;
  resources_json: string | null;
}

interface EvidenceHitRow {
  id: string;
  source: string;
  source_type: string;
  source_url: string | null;
  source_title: string;
  summary: string;
  body: string;
  occurred_at: string;
  confidence_score: number;
}

interface UpdateHitRow {
  id: string;
  source_kind: "project_update" | "pod_update";
  title: string;
  details: string;
  timestamp: string;
  status: string;
  quality_score: number;
}

const STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "all",
  "any",
  "are",
  "for",
  "from",
  "has",
  "have",
  "how",
  "into",
  "latest",
  "our",
  "the",
  "their",
  "this",
  "what",
  "when",
  "where",
  "which",
  "with",
]);

function parseResources(raw: string | null): ProjectResources {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as ProjectResources;
  } catch {
    return {};
  }
}

function classifyIntent(query: string): ProjectAnswerIntent {
  const q = query.toLowerCase();
  if (/\b(block|blocked|blocker|stuck|waiting)\b/.test(q)) return "blocker";
  if (/\b(decision|decided|chose|why did|rationale)\b/.test(q)) return "decision";
  if (/\b(when|timeline|date|eta|release|ship|milestone)\b/.test(q)) return "timeline";
  if (/\b(qa|test|testing|verify|validation|focus)\b/.test(q)) return "qa_focus";
  if (/\b(owner|owns|responsible|assignee|who)\b/.test(q)) return "ownership";
  if (/\b(risk|concern|regression|danger)\b/.test(q)) return "risk";
  if (/\b(why|how|explain|explanation)\b/.test(q)) return "explanation";
  return "status";
}

function keywords(query: string): string[] {
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/i)
    .map((w) => w.trim())
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  return [...new Set(words)].slice(0, 12);
}

function expandWithGlossary(query: string, resources: ProjectResources): string {
  const q = query.toLowerCase();
  const additions: string[] = [];
  for (const entry of resources.glossary ?? []) {
    const terms = [entry.term, ...(entry.aliases ?? [])].filter(Boolean);
    if (terms.some((term) => q.includes(term.toLowerCase()))) {
      additions.push(entry.term, ...(entry.aliases ?? []));
      if (entry.definition) additions.push(entry.definition);
    }
  }
  return [...new Set([query, ...additions].filter(Boolean))].join(" ");
}

function snippet(text: string, max = 260): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1)}...`;
}

function evidenceWhere(words: string[]): { sql: string; params: string[] } {
  if (words.length === 0) return { sql: "", params: [] };
  const clauses = words.map(() => "(lower(source_title) LIKE ? OR lower(summary) LIKE ? OR lower(body) LIKE ?)");
  const params = words.flatMap((w) => [`%${w}%`, `%${w}%`, `%${w}%`]);
  return { sql: ` AND (${clauses.join(" OR ")})`, params };
}

function updateWhere(words: string[]): { sql: string; params: string[] } {
  if (words.length === 0) return { sql: "", params: [] };
  const clauses = words.map(() => "(lower(summary) LIKE ? OR lower(details) LIKE ?)");
  const params = words.flatMap((w) => [`%${w}%`, `%${w}%`]);
  return { sql: ` AND (${clauses.join(" OR ")})`, params };
}

function confidenceFromHits(hits: ProjectAnswerRawHit[]): number {
  if (hits.length === 0) return 0.1;
  const top = hits.slice(0, 5);
  const avg = top.reduce((sum, h) => sum + (h.confidence_score ?? 0.55), 0) / top.length;
  return Math.max(0.2, Math.min(0.95, avg));
}

function sourcePriority(hit: ProjectAnswerRawHit): number {
  if (hit.source === "kg") return 2;
  if (hit.source === "project_update" || hit.source === "pod_update") return 1;
  return 3;
}

function loadProject(orgId: string, projectId: string): ProjectRow | null {
  const row = db
    .prepare("SELECT project_id, name, resources_json FROM projects WHERE org_id = ? AND project_id = ?")
    .get(orgId, projectId) as ProjectRow | undefined;
  return row ?? null;
}

function retrieveEvidence(orgId: string, projectId: string, words: string[]): ProjectAnswerRawHit[] {
  const where = evidenceWhere(words);
  const rows = db
    .prepare(
      `SELECT id, source, source_type, source_url, source_title, summary, body, occurred_at, confidence_score
       FROM project_evidence_items
       WHERE org_id = ? AND project_id = ?${where.sql}
       ORDER BY occurred_at DESC
       LIMIT 8`,
    )
    .all(orgId, projectId, ...where.params) as unknown as EvidenceHitRow[];
  return rows.map((r) => ({
    id: r.id,
    source: r.source as ProjectAnswerRawHit["source"],
    title: r.source_title || r.summary,
    snippet: snippet(r.body || r.summary),
    ...(r.source_url ? { url: r.source_url } : {}),
    timestamp: r.occurred_at,
    confidence_score: r.confidence_score,
  }));
}

function retrieveKg(orgId: string, projectId: string, query: string): ProjectAnswerRawHit[] {
  const result = queryKnowledge(orgId, {
    filters: { include_project_id: projectId, confidence_min: 0 },
    include_details: true,
    limit: 6,
    max_tokens: 1800,
    query_text: query,
  });
  return result.nodes.map((node: KnowledgeNode) => ({
    id: node.id,
    source: "kg",
    title: node.summary,
    snippet: snippet(node.details || node.summary),
    url: `/knowledge#${node.id}`,
    timestamp: node.created_at,
    confidence_score: node.confidence_score,
  }));
}

function retrieveUpdates(orgId: string, projectId: string, words: string[]): ProjectAnswerRawHit[] {
  const where = updateWhere(words);
  const projectRows = db
    .prepare(
      `SELECT id, 'project_update' AS source_kind, summary AS title, details, timestamp, status, quality_score
       FROM project_context_updates
       WHERE org_id = ? AND project_id = ? AND retracted_at IS NULL${where.sql}
       ORDER BY timestamp DESC
       LIMIT 6`,
    )
    .all(orgId, projectId, ...where.params) as unknown as UpdateHitRow[];
  const podRows = db
    .prepare(
      `SELECT cu.id, 'pod_update' AS source_kind, cu.summary AS title, cu.details, cu.timestamp, cu.status, cu.quality_score
       FROM context_updates cu
       JOIN pods p ON p.pod_id = cu.pod_id
       WHERE cu.org_id = ? AND p.project_id = ? AND cu.retracted_at IS NULL${where.sql.replace(/summary/g, "cu.summary").replace(/details/g, "cu.details")}
       ORDER BY cu.timestamp DESC
       LIMIT 6`,
    )
    .all(orgId, projectId, ...where.params) as unknown as UpdateHitRow[];

  return [...projectRows, ...podRows]
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 8)
    .map((r) => ({
      id: r.id,
      source: r.source_kind,
      title: r.title,
      snippet: snippet(r.details || r.title),
      timestamp: r.timestamp,
      confidence_score: Math.max(0.45, Math.min(0.75, r.quality_score || 0.55)),
    }));
}

function renderAnswer(intent: ProjectAnswerIntent, query: string, hits: ProjectAnswerRawHit[]): string {
  if (hits.length === 0) {
    return `No project evidence matched "${query}".`;
  }
  const heading = {
    status: "Current Status",
    decision: "Decision Trail",
    blocker: "Blockers",
    timeline: "Timeline",
    qa_focus: "QA Focus",
    explanation: "Explanation",
    ownership: "Ownership",
    risk: "Risks",
  }[intent];
  const lines = hits.slice(0, 5).map((hit, index) => {
    const suffix = hit.timestamp ? ` (${new Date(hit.timestamp).toISOString().slice(0, 10)})` : "";
    return `- [${index + 1}] ${hit.title}${suffix}: ${hit.snippet}`;
  });
  return [`## ${heading}`, ...lines].join("\n");
}

export function answerProjectQuestion(
  orgId: string,
  projectId: string,
  query: string,
): ProjectAnswerResponse | null {
  const project = loadProject(orgId, projectId);
  if (!project) return null;
  const resources = parseResources(project.resources_json);
  const expanded = expandWithGlossary(query, resources);
  const words = keywords(expanded);
  const intent = classifyIntent(query);

  const evidenceHits = retrieveEvidence(orgId, projectId, words);
  const kgHits = retrieveKg(orgId, projectId, expanded);
  const updateHits = retrieveUpdates(orgId, projectId, words);

  const unavailable_sources: ProjectAnswerResponse["unavailable_sources"] = [];
  if (evidenceHits.length === 0) {
    unavailable_sources.push({ source: "project_evidence", reason: "No matching working-memory evidence" });
  }
  if (kgHits.length === 0) {
    unavailable_sources.push({ source: "project_kg", reason: "No matching project-scoped KG nodes" });
  }
  if (updateHits.length === 0) {
    unavailable_sources.push({ source: "project_updates", reason: "No matching project or pod updates" });
  }

  const sources_used: ProjectAnswerResponse["sources_used"] = [];
  if (evidenceHits.length > 0) sources_used.push("project_evidence");
  if (kgHits.length > 0) sources_used.push("project_kg");
  if (updateHits.length > 0) sources_used.push("project_updates");

  const collapsed = [...evidenceHits, ...kgHits, ...updateHits]
    .sort((a, b) => sourcePriority(b) - sourcePriority(a) || (b.confidence_score ?? 0) - (a.confidence_score ?? 0))
    .slice(0, 12);

  return {
    intent,
    answer_markdown: renderAnswer(intent, query, collapsed),
    confidence: confidenceFromHits(collapsed),
    citations: collapsed.slice(0, 8).map((hit) => ({
      id: hit.id,
      source: hit.source,
      title: hit.title,
      ...(hit.url ? { url: hit.url } : {}),
      ...(hit.timestamp ? { timestamp: hit.timestamp } : {}),
    })),
    sources_used,
    unavailable_sources,
    collapsed_raw_hits: collapsed,
  };
}
