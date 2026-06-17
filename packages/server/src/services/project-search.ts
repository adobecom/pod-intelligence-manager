/**
 * Indexed Project Search — read path.
 *
 * Hybrid retrieval over a single project's artifact index:
 *   1. exact-identifier lookup (Jira keys, PR/issue numbers, file paths),
 *   2. lexical search via the FTS5 bm25 index (keyword LIKE fallback),
 *   3. semantic search via cosine over chunk embeddings (when available),
 * fused with reciprocal-rank fusion and reranked with project-aware signals
 * (recency, source authority, configured-resource scope, freshness). Optionally
 * attaches a small project-scoped KG overlay and an entity/edge mind-map
 * neighborhood. Every query is hard-scoped to (org_id, project_id) — other
 * projects' artifacts can never leak in.
 */
import db from "../db/connection.js";
import type {
  ProjectResources,
  ProjectSearchAnswerCitation,
  ProjectSearchEdgeType,
  ProjectSearchEntityType,
  ProjectSearchFocusFeature,
  ProjectSearchFreshness,
  ProjectSearchHit,
  ProjectSearchKgHit,
  ProjectSearchMindMap,
  ProjectSearchRequest,
  ProjectSearchResponse,
  ProjectSearchSource,
  SearchDocument,
} from "@pim/shared";
import path from "node:path";
import { cosineSimilarity, generateEmbedding, isEmbeddingAvailable } from "./embeddings.js";
import { extractIdentifiers } from "./graph-analysis.js";
import { isProjectSearchFtsAvailable } from "./project-search-index.js";
import { queryKnowledge } from "./knowledge-graph.js";
import { scrubHits } from "./search-core/scrub.js";
import { synthesizeSearch } from "./search-core/synthesizer.js";
import { INDEXED_SOURCE_AUTHORITY, INDEXED_RECENCY_DAYS, INDEXED_RECENCY_MAX } from "./search-core/weights.js";
import { searchJira } from "../integrations/jira.js";
import { searchGithub } from "../integrations/github.js";
import { searchConfluence } from "../integrations/confluence.js";
import { searchGit } from "../integrations/git.js";

const SYNTHESIS_PROMPT_PATH = path.resolve(
  new URL(".", import.meta.url).pathname,
  "../../../../prompts/search-synthesis.md",
);

/** A short, human-meaningful citation token for a hit (Jira key, PR #, release name, commit). */
function refFor(h: ProjectSearchHit): string {
  if (h.source === "jira" && h.source_type === "release") {
    const tail = h.source_id.split(":").pop();
    return tail || h.title;
  }
  if (h.source === "jira") return h.source_id;
  if (h.source === "github") {
    if (h.source_id.includes("#")) return `PR #${h.source_id.split("#")[1]}`;
    if (h.source_id.includes("@")) return `commit ${h.source_id.split("@")[1]?.slice(0, 7)}`;
  }
  return h.source_id;
}

function refForKg(index: number): string {
  return `K${index + 1}`;
}

type ProjectSearchSynthesisEvidence = {
  ref: string;
  source: ProjectSearchSource | "kg";
  source_type: string;
  title: string;
  snippet: string;
  status?: string;
  occurred_at?: string;
  confidence_score?: number;
  curated?: boolean;
};

function synthesisEvidence(
  kgHits: ProjectSearchKgHit[],
  hits: ProjectSearchHit[],
): ProjectSearchSynthesisEvidence[] {
  return [
    ...kgHits.slice(0, 4).map((h, i) => ({
      ref: refForKg(i),
      source: "kg" as const,
      source_type: h.type,
      title: h.summary,
      snippet: h.snippet,
      confidence_score: h.confidence_score,
      ...(h.curated !== undefined ? { curated: h.curated } : {}),
    })),
    ...hits.slice(0, 14).map((h) => ({
      ref: refFor(h),
      source: h.source,
      source_type: h.source_type,
      title: h.title,
      status: h.status,
      occurred_at: h.occurred_at,
      snippet: h.snippet,
    })),
  ];
}

function answerCitations(
  kgHits: ProjectSearchKgHit[],
  hits: ProjectSearchHit[],
): ProjectSearchAnswerCitation[] {
  return [
    ...kgHits.slice(0, 4).map((h, i) => ({
      ref: refForKg(i),
      source: "kg" as const,
      title: h.summary,
      url: h.url,
    })),
    ...hits.slice(0, 14).map((h) => ({
      ref: refFor(h),
      source: h.source,
      title: h.title,
      ...(h.url ? { url: h.url } : {}),
    })),
  ];
}

/** LLM-synthesized, plain-language answer over the top hits. Returns undefined on any failure. */
async function synthesizeAnswer(
  query: string,
  projectName: string | undefined,
  aliases: string[],
  hits: ProjectSearchHit[],
  kgHits: ProjectSearchKgHit[],
): Promise<string | undefined> {
  const evidence = synthesisEvidence(kgHits, hits);
  if (evidence.length === 0) return undefined;
  return synthesizeSearch({
    systemPromptPath: SYNTHESIS_PROMPT_PATH,
    evidence: {
      mode: "indexed",
      query,
      project: { name: projectName, aliases },
      evidence,
    },
    maxTokens: 1200,
    label: "project-search",
  });
}

const RRF_K = 60;
const CANDIDATE_K = 200;
const DEFAULT_MAX_HITS = 10;
const GRAPH_MAX_CONTRIBUTION = 0.22;
const GRAPH_HUB_DEGREE = 24;
const GRAPH_SEED_DOCUMENTS = 12;
const MIND_MAP_NODE_LIMIT = 40;
const MIND_MAP_EDGE_LIMIT = 80;

const EDGE_PRIORITY: Record<ProjectSearchEdgeType, number> = {
  implements: 100,
  defines: 90,
  fixes: 85,
  touches: 80,
  imports: 75,
  calls: 70,
  blocks: 65,
  owns: 60,
  discusses: 45,
  supersedes: 40,
  linked_to: 35,
  cites_kg: 30,
  mentions: 20,
};

const STOP_WORDS = new Set([
  "the", "and", "for", "from", "has", "have", "with", "what", "when", "where", "which",
  "this", "that", "into", "about", "are", "our", "their", "how", "why", "did", "does",
  "is", "of", "to", "in", "on", "a", "an", "be", "or",
]);

interface ProjectRow {
  project_id: string;
  name: string;
  resources_json: string | null;
}

interface DocRow {
  id: string;
  source: ProjectSearchSource;
  source_type: string;
  source_id: string;
  source_url: string | null;
  title: string;
  author: string | null;
  status: string | null;
  occurred_at: string | null;
  freshness_state: ProjectSearchFreshness;
  metadata_json: string;
}

interface ChunkTextRow {
  id: string;
  document_id: string;
  text: string;
  retrieval_text: string | null;
  embedding_json: string | null;
}

interface GraphEntityRow {
  id: string;
  entity_type: ProjectSearchEntityType;
  entity_key: string;
  label: string;
  source_document_id: string | null;
  metadata_json: string;
}

interface GraphEdgeRow {
  source_entity_id: string;
  target_entity_id: string;
  edge_type: ProjectSearchEdgeType;
  confidence_score: number;
  evidence_document_id: string | null;
}

interface GraphExpansion {
  docScores: Map<string, number>;
  entityIdsByDocument: Map<string, Set<string>>;
  seedEntityIds: string[];
  focusFeature?: ProjectSearchFocusFeature;
  focusFeatureEntityId?: string;
}

function parseResources(raw: string | null): ProjectResources {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as ProjectResources;
  } catch {
    return {};
  }
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function loadProject(orgId: string, projectId: string): ProjectRow | null {
  const row = db
    .prepare("SELECT project_id, name, resources_json FROM projects WHERE org_id = ? AND project_id = ?")
    .get(orgId, projectId) as ProjectRow | undefined;
  return row ?? null;
}

function queryTerms(query: string): string[] {
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .map((w) => w.trim())
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
  return [...new Set(words)].slice(0, 24);
}

/** Builds a safe FTS5 MATCH expression — every term quoted so identifiers with
 *  hyphens/slashes/dots/# can't break the query grammar. */
function buildMatchExpression(terms: string[], identifiers: string[]): string {
  const quoted = new Set<string>();
  for (const t of terms) quoted.add(`"${t.replace(/"/g, '""')}"`);
  for (const id of identifiers) quoted.add(`"${id.toLowerCase().replace(/"/g, '""')}"`);
  return [...quoted].join(" OR ");
}

function snippet(text: string, max = 280): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

interface ChunkHit {
  chunk_id: string;
  document_id: string;
  rank: number;
  raw: number;
}

function lexicalSearch(orgId: string, projectId: string, matchExpr: string): ChunkHit[] {
  if (!matchExpr) return [];
  if (isProjectSearchFtsAvailable()) {
    try {
      const rows = db
        .prepare(
          `SELECT chunk_id, document_id, bm25(project_search_fts) AS score
           FROM project_search_fts
           WHERE project_search_fts MATCH ? AND org_id = ? AND project_id = ?
           ORDER BY score
           LIMIT ?`,
        )
        .all(matchExpr, orgId, projectId, CANDIDATE_K) as Array<{ chunk_id: string; document_id: string; score: number }>;
      // bm25 returns more-negative = better; rank ascending.
      return rows.map((r, i) => ({ chunk_id: r.chunk_id, document_id: r.document_id, rank: i + 1, raw: -r.score }));
    } catch {
      // Malformed MATCH or FTS issue — fall through to LIKE.
    }
  }
  return lexicalLikeSearch(orgId, projectId, matchExpr);
}

/** Keyword-LIKE fallback when FTS5 is unavailable. Scores by distinct term hits. */
function lexicalLikeSearch(orgId: string, projectId: string, matchExpr: string): ChunkHit[] {
  const terms = [...matchExpr.matchAll(/"((?:[^"]|"")+)"/g)].map((m) => m[1].replace(/""/g, '"'));
  if (terms.length === 0) return [];
  const clauses = terms.map(() => "(lower(text) LIKE ? OR lower(retrieval_text) LIKE ?)");
  const score = terms
    .map(() => "(CASE WHEN lower(text) LIKE ? OR lower(retrieval_text) LIKE ? THEN 1 ELSE 0 END)")
    .join(" + ");
  const likeParams = terms.flatMap((t) => [`%${t.toLowerCase()}%`, `%${t.toLowerCase()}%`]);
  const rows = db
    .prepare(
      `SELECT id AS chunk_id, document_id, (${score}) AS hits
       FROM project_search_chunks
       WHERE org_id = ? AND project_id = ? AND (${clauses.join(" OR ")})
       ORDER BY hits DESC
       LIMIT ?`,
    )
    .all(...likeParams, orgId, projectId, ...likeParams, CANDIDATE_K) as Array<{
    chunk_id: string;
    document_id: string;
    hits: number;
  }>;
  return rows.map((r, i) => ({ chunk_id: r.chunk_id, document_id: r.document_id, rank: i + 1, raw: r.hits }));
}

function semanticSearch(orgId: string, projectId: string, queryVec: number[]): ChunkHit[] {
  const rows = db
    .prepare(
      `SELECT id, document_id, embedding_json
       FROM project_search_chunks
       WHERE org_id = ? AND project_id = ? AND embedding_json IS NOT NULL`,
    )
    .all(orgId, projectId) as Array<{ id: string; document_id: string; embedding_json: string }>;
  const scored = rows
    .map((r) => {
      let vec: number[];
      try {
        vec = JSON.parse(r.embedding_json) as number[];
      } catch {
        return null;
      }
      return { chunk_id: r.id, document_id: r.document_id, sim: cosineSimilarity(queryVec, vec) };
    })
    .filter((x): x is { chunk_id: string; document_id: string; sim: number } => x !== null && x.sim > 0)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, CANDIDATE_K);
  return scored.map((s, i) => ({ chunk_id: s.chunk_id, document_id: s.document_id, rank: i + 1, raw: s.sim }));
}

/** A reference-like identifier (ticket key, PR/issue number, file path) — specific
 *  enough to drive an exact lookup. Bare project prefixes like "EMC" are excluded
 *  so they don't substring-match every ticket in the project. */
function isReferenceIdentifier(id: string): boolean {
  return /\d/.test(id) || id.includes("/") || id.includes("#") || id.includes(".");
}

/** Documents whose identity (source_id / title) directly contains a detected identifier. */
function identifierMatches(orgId: string, projectId: string, identifiers: string[]): Set<string> {
  const docIds = new Set<string>();
  const refs = identifiers.filter(isReferenceIdentifier);
  if (refs.length === 0) return docIds;
  const clauses = refs.map(() => "(instr(lower(source_id), ?) > 0 OR instr(lower(title), ?) > 0)");
  const params = refs.flatMap((id) => [id.toLowerCase(), id.toLowerCase()]);
  const rows = db
    .prepare(
      `SELECT id FROM project_search_documents
       WHERE org_id = ? AND project_id = ? AND (${clauses.join(" OR ")})
       LIMIT 50`,
    )
    .all(orgId, projectId, ...params) as Array<{ id: string }>;
  for (const r of rows) docIds.add(r.id);
  return docIds;
}

function normalizeRepoPath(value: string): string {
  return path.resolve(value);
}

function localGitRepoFromSourceId(sourceId: string): string {
  const at = sourceId.lastIndexOf("@");
  if (at > 0) return sourceId.slice(0, at);
  const colon = sourceId.indexOf(":");
  if (colon > 0) return sourceId.slice(0, colon);
  return sourceId;
}

function inScope(doc: DocRow, resources: ProjectResources): boolean {
  switch (doc.source) {
    case "jira": {
      const keys = resources.jira?.project_keys ?? [];
      return keys.some((k) => doc.source_id.toUpperCase().startsWith(`${k.toUpperCase()}-`) || doc.source_id.toUpperCase() === k.toUpperCase());
    }
    case "github": {
      const repos = resources.github?.repos ?? [];
      return repos.some((r) => doc.source_id.startsWith(`${r}#`) || doc.source_id.startsWith(`${r}@`) || doc.source_id.startsWith(r));
    }
    case "git": {
      const repoPaths = resources.git?.repo_paths ?? [];
      if (repoPaths.length === 0) return false;
      const metadata = parseJson<Record<string, unknown>>(doc.metadata_json, {});
      const docRepo = typeof metadata.repo_path === "string" ? metadata.repo_path : localGitRepoFromSourceId(doc.source_id);
      const normalizedDocRepo = normalizeRepoPath(docRepo);
      return repoPaths.some((configured) => normalizeRepoPath(configured) === normalizedDocRepo);
    }
    case "confluence": {
      const spaces = resources.confluence?.space_keys ?? [];
      const space = typeof doc.source_id === "string" ? doc.source_id : "";
      return spaces.some((s) => space.includes(s));
    }
    default:
      return false;
  }
}

/** Boosts doc types that match the question's intent (releases for "what's shipping",
 *  backlog for "what's planned", active for "in progress", resolved for "what shipped").
 *  Makes the layer answer project-status questions, not just keyword lookups. */
function intentBoost(query: string, doc: DocRow): number {
  const q = query.toLowerCase();
  const wantsRelease = /\b(release|releases|ship|shipping|shipped|launch|launching|version|roll ?out|upcoming|next sprint|next release)\b/.test(q);
  const wantsNext = /\b(next|upcoming|planned|future|soon)\b/.test(q);
  const wantsBacklog = /\b(backlog|planned|to ?do|not started|roadmap|upcoming work)\b/.test(q);
  const wantsActive = /\b(in progress|wip|being built|active|currently|ongoing|working on|under way|underway)\b/.test(q);
  const wantsDone = /\b(done|shipped|completed|complete|resolved|fixed|finished|closed)\b/.test(q);
  const wantsImplementation = /\b(implemented|implementation|built|coded|code|merged|pr|commit|where is|how is)\b/.test(q);
  let b = 0;
  if (doc.source_type === "release") {
    if (wantsRelease) b += 0.4;
    if (wantsNext && /upcoming/i.test(doc.title)) b += 0.3;
  }
  if (wantsBacklog && doc.source_type === "backlog_issue") b += 0.3;
  if (wantsActive && doc.source_type === "active_issue") b += 0.3;
  if (wantsDone && doc.source_type === "resolved_issue") b += 0.2;
  if (wantsImplementation && (doc.source === "github" || doc.source === "git")) {
    if (["merged_pr", "updated_pr", "default_branch_commit", "commit", "file_summary"].includes(doc.source_type)) b += 0.35;
    else b += 0.15;
  }
  return b;
}

function emptyGraphExpansion(): GraphExpansion {
  return {
    docScores: new Map(),
    entityIdsByDocument: new Map(),
    seedEntityIds: [],
  };
}

function graphContribution(edge: GraphEdgeRow, hop: 1 | 2): number {
  const priority = EDGE_PRIORITY[edge.edge_type] ?? 10;
  const priorityFactor = priority / EDGE_PRIORITY.implements;
  const hopFactor = hop === 1 ? 1 : 0.62;
  return Math.min(GRAPH_MAX_CONTRIBUTION, GRAPH_MAX_CONTRIBUTION * priorityFactor * edge.confidence_score * hopFactor);
}

function addGraphDocScore(expansion: GraphExpansion, documentId: string, entityId: string, score: number): void {
  const prior = expansion.docScores.get(documentId) ?? 0;
  if (score > prior) expansion.docScores.set(documentId, score);
  let entityIds = expansion.entityIdsByDocument.get(documentId);
  if (!entityIds) {
    entityIds = new Set();
    expansion.entityIdsByDocument.set(documentId, entityIds);
  }
  entityIds.add(entityId);
}

function loadGraphEntitiesByIds(ids: string[]): Map<string, GraphEntityRow> {
  if (ids.length === 0) return new Map();
  const rows = db
    .prepare(
      `SELECT id, entity_type, entity_key, label, source_document_id, metadata_json
       FROM project_search_entities
       WHERE id IN (${ids.map(() => "?").join(", ")})`,
    )
    .all(...ids) as unknown as GraphEntityRow[];
  return new Map(rows.map((row) => [row.id, row]));
}

function graphDegrees(orgId: string, projectId: string): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT entity_id, COUNT(*) AS degree
       FROM (
         SELECT source_entity_id AS entity_id FROM project_search_edges WHERE org_id = ? AND project_id = ?
         UNION ALL
         SELECT target_entity_id AS entity_id FROM project_search_edges WHERE org_id = ? AND project_id = ?
       )
       GROUP BY entity_id`,
    )
    .all(orgId, projectId, orgId, projectId) as Array<{ entity_id: string; degree: number }>;
  return new Map(rows.map((row) => [row.entity_id, row.degree]));
}

function adjacentGraphEdges(orgId: string, projectId: string, entityIds: string[]): GraphEdgeRow[] {
  if (entityIds.length === 0) return [];
  const placeholders = entityIds.map(() => "?").join(", ");
  return db
    .prepare(
      `SELECT source_entity_id, target_entity_id, edge_type, confidence_score, evidence_document_id
       FROM project_search_edges
       WHERE org_id = ? AND project_id = ?
         AND (source_entity_id IN (${placeholders}) OR target_entity_id IN (${placeholders}))`,
    )
    .all(orgId, projectId, ...entityIds, ...entityIds) as unknown as GraphEdgeRow[];
}

function graphSeedEntitiesForIdentifiers(orgId: string, projectId: string, identifiers: string[]): GraphEntityRow[] {
  const refs = identifiers.filter(isReferenceIdentifier);
  if (refs.length === 0) return [];
  const clauses = refs.map(() => "(lower(entity_key) = ? OR instr(lower(entity_key), ?) > 0 OR lower(label) = ?)");
  const params = refs.flatMap((id) => {
    const ref = id.toLowerCase();
    return [ref, ref, ref];
  });
  return db
    .prepare(
      `SELECT id, entity_type, entity_key, label, source_document_id, metadata_json
       FROM project_search_entities
       WHERE org_id = ? AND project_id = ? AND (${clauses.join(" OR ")})
       LIMIT 40`,
    )
    .all(orgId, projectId, ...params) as unknown as GraphEntityRow[];
}

function graphSelfEntitiesForDocuments(orgId: string, projectId: string, documentIds: string[]): GraphEntityRow[] {
  if (documentIds.length === 0) return [];
  return db
    .prepare(
      `SELECT id, entity_type, entity_key, label, source_document_id, metadata_json
       FROM project_search_entities
       WHERE org_id = ? AND project_id = ? AND source_document_id IN (${documentIds.map(() => "?").join(", ")})`,
    )
    .all(orgId, projectId, ...documentIds) as unknown as GraphEntityRow[];
}

function documentIdsForEntityTypes(
  orgId: string,
  projectId: string,
  entityTypes: ProjectSearchEntityType[],
): Set<string> {
  if (entityTypes.length === 0) return new Set();
  const placeholders = entityTypes.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT DISTINCT source_document_id AS document_id
       FROM project_search_entities
       WHERE org_id = ? AND project_id = ?
         AND source_document_id IS NOT NULL
         AND entity_type IN (${placeholders})
       UNION
       SELECT DISTINCT e.evidence_document_id AS document_id
       FROM project_search_edges e
       JOIN project_search_entities se ON se.id = e.source_entity_id
       JOIN project_search_entities te ON te.id = e.target_entity_id
       WHERE e.org_id = ? AND e.project_id = ?
         AND e.evidence_document_id IS NOT NULL
         AND (se.entity_type IN (${placeholders}) OR te.entity_type IN (${placeholders}))`,
    )
    .all(orgId, projectId, ...entityTypes, orgId, projectId, ...entityTypes, ...entityTypes) as Array<{
    document_id: string | null;
  }>;
  return new Set(rows.map((row) => row.document_id).filter((id): id is string => !!id));
}

function normalizedWords(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

function featureMatchesQuery(query: string, feature: GraphEntityRow): boolean {
  const queryWords = new Set(normalizedWords(query));
  const labelWords = normalizedWords(feature.label);
  if (labelWords.length === 0) return false;
  const normalizedQuery = ` ${query.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  const normalizedLabel = ` ${feature.label.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
  if (normalizedLabel.trim().length > 1 && normalizedQuery.includes(normalizedLabel)) return true;
  return labelWords.every((word) => queryWords.has(word));
}

function graphFeatureSeeds(orgId: string, projectId: string, query: string): GraphEntityRow[] {
  const rows = db
    .prepare(
      `SELECT id, entity_type, entity_key, label, source_document_id, metadata_json
       FROM project_search_entities
       WHERE org_id = ? AND project_id = ? AND entity_type = 'feature'
       LIMIT 5000`,
    )
    .all(orgId, projectId) as unknown as GraphEntityRow[];
  return rows.filter((row) => featureMatchesQuery(query, row)).slice(0, 8);
}

function bestCandidateRank(a: DocAccumulator): number {
  if (a.identifier) return 0;
  return Math.min(a.lexRank ?? Number.POSITIVE_INFINITY, a.semRank ?? Number.POSITIVE_INFINITY);
}

function graphSeedDocumentIds(acc: Map<string, DocAccumulator>): string[] {
  return [...acc.entries()]
    .filter(([, a]) => a.identifier || a.lexRank !== undefined || a.semRank !== undefined)
    .sort(([, a], [, b]) => bestCandidateRank(a) - bestCandidateRank(b))
    .map(([docId]) => docId)
    .slice(0, GRAPH_SEED_DOCUMENTS);
}

function buildFocusFeature(orgId: string, projectId: string, feature: GraphEntityRow): ProjectSearchFocusFeature {
  const edges = adjacentGraphEdges(orgId, projectId, [feature.id])
    .sort((a, b) => {
      const priority = (EDGE_PRIORITY[b.edge_type] ?? 0) - (EDGE_PRIORITY[a.edge_type] ?? 0);
      return priority || b.confidence_score - a.confidence_score;
    })
    .slice(0, 100);
  const memberIds = [...new Set(edges.map((edge) => (
    edge.source_entity_id === feature.id ? edge.target_entity_id : edge.source_entity_id
  )))];
  const membersById = loadGraphEntitiesByIds(memberIds);
  const members = edges
    .map((edge) => {
      const otherId = edge.source_entity_id === feature.id ? edge.target_entity_id : edge.source_entity_id;
      const entity = membersById.get(otherId);
      if (!entity) return null;
      return {
        entity_id: entity.id,
        entity_type: entity.entity_type,
        entity_key: entity.entity_key,
        label: entity.label,
        edge_type: edge.edge_type,
        confidence_score: edge.confidence_score,
        ...(entity.source_document_id ? { source_document_id: entity.source_document_id } : {}),
      };
    })
    .filter((member): member is ProjectSearchFocusFeature["members"][number] => member !== null)
    .slice(0, 12);
  return {
    entity_id: feature.id,
    entity_key: feature.entity_key,
    label: feature.label,
    members,
  };
}

function expandProjectGraph(
  orgId: string,
  projectId: string,
  query: string,
  identifiers: string[],
  acc: Map<string, DocAccumulator>,
): GraphExpansion {
  const expansion = emptyGraphExpansion();
  const seeds = new Map<string, GraphEntityRow>();
  for (const entity of graphSeedEntitiesForIdentifiers(orgId, projectId, identifiers)) seeds.set(entity.id, entity);
  for (const entity of graphSelfEntitiesForDocuments(orgId, projectId, graphSeedDocumentIds(acc))) seeds.set(entity.id, entity);
  const featureSeeds = graphFeatureSeeds(orgId, projectId, query);
  for (const entity of featureSeeds) seeds.set(entity.id, entity);
  if (seeds.size === 0) return expansion;

  expansion.seedEntityIds = [...seeds.keys()];
  if (featureSeeds.length > 0) {
    expansion.focusFeatureEntityId = featureSeeds[0].id;
    expansion.focusFeature = buildFocusFeature(orgId, projectId, featureSeeds[0]);
  }

  const degrees = graphDegrees(orgId, projectId);
  const seedIds = new Set(expansion.seedEntityIds);
  const focusId = expansion.focusFeatureEntityId;
  const visited = new Set<string>(seedIds);
  let frontier = [...seedIds];

  for (const hop of [1, 2] as const) {
    const expandableFrontier = frontier.filter((id) => {
      const isSeedOrFocus = seedIds.has(id) || id === focusId;
      return isSeedOrFocus || (degrees.get(id) ?? 0) < GRAPH_HUB_DEGREE;
    });
    const edges = adjacentGraphEdges(orgId, projectId, expandableFrontier);
    const endpointIds = new Set<string>();
    for (const edge of edges) {
      endpointIds.add(edge.source_entity_id);
      endpointIds.add(edge.target_entity_id);
    }
    const entities = loadGraphEntitiesByIds([...endpointIds]);
    const current = new Set(expandableFrontier);
    const next: string[] = [];

    for (const edge of edges) {
      const currentIds = [
        current.has(edge.source_entity_id) ? edge.source_entity_id : null,
        current.has(edge.target_entity_id) ? edge.target_entity_id : null,
      ].filter((id): id is string => id !== null);
      for (const currentId of currentIds) {
        const otherId = currentId === edge.source_entity_id ? edge.target_entity_id : edge.source_entity_id;
        const other = entities.get(otherId);
        if (!other) continue;
        if (other.source_document_id) {
          addGraphDocScore(expansion, other.source_document_id, other.id, graphContribution(edge, hop));
        }
        if (!visited.has(otherId)) {
          visited.add(otherId);
          const otherIsSeedOrFocus = seedIds.has(otherId) || otherId === focusId;
          if (otherIsSeedOrFocus || (degrees.get(otherId) ?? 0) < GRAPH_HUB_DEGREE) next.push(otherId);
        }
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }

  return expansion;
}

function kgOverlay(
  orgId: string,
  projectId: string,
  query: string,
  queryEmbedding?: number[] | null,
): ProjectSearchKgHit[] {
  try {
    const result = queryKnowledge(orgId, {
      filters: { include_project_id: projectId, confidence_min: 0 },
      include_details: true,
      limit: 4,
      max_tokens: 1200,
      query_text: query,
      ...(queryEmbedding ? { query_embedding: queryEmbedding } : {}),
    });
    return result.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      summary: node.summary,
      snippet: snippet(node.details || node.summary),
      confidence_score: node.confidence_score,
      curated: node.curated,
      url: `/knowledge#${node.id}`,
    }));
  } catch {
    return [];
  }
}

function documentsBySource(orgId: string, projectId: string): Partial<Record<ProjectSearchSource, number>> {
  const rows = db
    .prepare(
      `SELECT source, COUNT(*) AS count
       FROM project_search_documents
       WHERE org_id = ? AND project_id = ? AND freshness_state != 'deleted'
       GROUP BY source`,
    )
    .all(orgId, projectId) as Array<{ source: ProjectSearchSource; count: number }>;
  const counts: Partial<Record<ProjectSearchSource, number>> = {};
  for (const row of rows) counts[row.source] = row.count;
  return counts;
}

function totalDocumentCount(counts: Partial<Record<ProjectSearchSource, number>>): number {
  return Object.values(counts).reduce((sum, count) => sum + (count ?? 0), 0);
}

function hasImplementationEvidence(counts: Partial<Record<ProjectSearchSource, number>>): boolean {
  return (counts.git ?? 0) > 0 || (counts.github ?? 0) > 0;
}

function implementationEvidenceGuard(counts: Partial<Record<ProjectSearchSource, number>>): string | undefined {
  if (hasImplementationEvidence(counts)) return undefined;
  const indexed = totalDocumentCount(counts);
  if (indexed === 0) return undefined;
  return "> Implementation evidence is absent from this project index; results are limited to non-implementation sources.";
}

function evidenceEdgesForDocuments(orgId: string, projectId: string, documentIds: string[]): GraphEdgeRow[] {
  if (documentIds.length === 0) return [];
  return db
    .prepare(
      `SELECT source_entity_id, target_entity_id, edge_type, confidence_score, evidence_document_id
       FROM project_search_edges
       WHERE org_id = ? AND project_id = ? AND evidence_document_id IN (${documentIds.map(() => "?").join(", ")})`,
    )
    .all(orgId, projectId, ...documentIds) as unknown as GraphEdgeRow[];
}

function uniqueEdges(edges: GraphEdgeRow[]): GraphEdgeRow[] {
  const seen = new Set<string>();
  const unique: GraphEdgeRow[] = [];
  for (const edge of edges) {
    const key = `${edge.source_entity_id}\0${edge.target_entity_id}\0${edge.edge_type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(edge);
  }
  return unique;
}

function mindMapNeighborhood(
  orgId: string,
  projectId: string,
  documentIds: string[],
  explicitEntityIds: string[] = [],
): ProjectSearchMindMap | undefined {
  if (documentIds.length === 0 && explicitEntityIds.length === 0) return undefined;

  const selfEntities = graphSelfEntitiesForDocuments(orgId, projectId, documentIds);
  const explicitEntities = loadGraphEntitiesByIds(explicitEntityIds);
  const seedEntityIds = new Set<string>();
  for (const id of explicitEntities.keys()) {
    if (seedEntityIds.size >= MIND_MAP_NODE_LIMIT) break;
    seedEntityIds.add(id);
  }
  for (const entity of selfEntities) {
    if (seedEntityIds.size >= MIND_MAP_NODE_LIMIT) break;
    seedEntityIds.add(entity.id);
  }
  if (seedEntityIds.size === 0) return undefined;

  const degrees = graphDegrees(orgId, projectId);
  const seedIds = [...seedEntityIds];
  const oneHop = adjacentGraphEdges(orgId, projectId, seedIds);
  const firstNeighbors = new Set<string>();
  for (const edge of oneHop) {
    if (seedEntityIds.has(edge.source_entity_id) && !seedEntityIds.has(edge.target_entity_id)) {
      firstNeighbors.add(edge.target_entity_id);
    }
    if (seedEntityIds.has(edge.target_entity_id) && !seedEntityIds.has(edge.source_entity_id)) {
      firstNeighbors.add(edge.source_entity_id);
    }
  }
  const secondHopSeeds = [...firstNeighbors]
    .filter((id) => (degrees.get(id) ?? 0) < GRAPH_HUB_DEGREE)
    .slice(0, 80);
  const candidateEdges = uniqueEdges([
    ...evidenceEdgesForDocuments(orgId, projectId, documentIds),
    ...oneHop,
    ...adjacentGraphEdges(orgId, projectId, secondHopSeeds),
  ]).sort((a, b) => {
    const aSeed = seedEntityIds.has(a.source_entity_id) || seedEntityIds.has(a.target_entity_id) ? 1 : 0;
    const bSeed = seedEntityIds.has(b.source_entity_id) || seedEntityIds.has(b.target_entity_id) ? 1 : 0;
    if (aSeed !== bSeed) return bSeed - aSeed;
    const priority = (EDGE_PRIORITY[b.edge_type] ?? 0) - (EDGE_PRIORITY[a.edge_type] ?? 0);
    return priority || b.confidence_score - a.confidence_score;
  });

  const entityIds = new Set<string>(seedEntityIds);
  const edges: ProjectSearchMindMap["edges"] = [];
  for (const edge of candidateEdges) {
    if (edges.length >= MIND_MAP_EDGE_LIMIT) break;
    const nextIds = new Set(entityIds);
    nextIds.add(edge.source_entity_id);
    nextIds.add(edge.target_entity_id);
    if (nextIds.size > MIND_MAP_NODE_LIMIT) continue;
    entityIds.add(edge.source_entity_id);
    entityIds.add(edge.target_entity_id);
    edges.push({
      source_entity_id: edge.source_entity_id,
      target_entity_id: edge.target_entity_id,
      edge_type: edge.edge_type,
      confidence_score: edge.confidence_score,
    });
  }

  const rowsById = loadGraphEntitiesByIds([...entityIds]);
  const entities = [...entityIds]
    .map((id) => rowsById.get(id))
    .filter((row): row is GraphEntityRow => row !== undefined)
    .slice(0, MIND_MAP_NODE_LIMIT)
    .map((row) => ({
      id: row.id,
      entity_type: row.entity_type,
      entity_key: row.entity_key,
      label: row.label,
      ...(row.source_document_id ? { source_document_id: row.source_document_id } : {}),
      metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
    }));

  return { entities, edges };
}

interface DocAccumulator {
  lexRank?: number;
  semRank?: number;
  bestLexChunk?: string;
  bestSemChunk?: string;
  identifier: boolean;
  graphScore?: number;
  graphEntityIds?: Set<string>;
}

// ── Live fallback (indexed → live) ───────────────────────────────────────────
// Gated by PROJECT_SEARCH_LIVE_FALLBACK=1 env flag AND req.use_live=true.
// Triggered only when the index returns zero candidates. Connectors run in
// parallel over the project's configured sources; results are scrubbed and
// adapted to ProjectSearchHit shape but NOT written back to the index.
// The repair path (write-through) is Phase 3b and is intentionally deferred
// until the ephemeral path is validated in integration tests.

const LIVE_SOURCES: ProjectSearchSource[] = ["jira", "github", "confluence", "git", "slack"];

/** True when the feature flag and per-request opt-in are both set. */
function liveFallbackEnabled(req: ProjectSearchRequest): boolean {
  return req.use_live === true && process.env.PROJECT_SEARCH_LIVE_FALLBACK === "1";
}

/** Adapt a `SearchDocument` from a live connector to a `ProjectSearchHit`.
 *  Live hits carry no index-specific fields (document_id, chunk_id, RRF scores).
 *  They are marked `freshness: "unknown"` since they are not persisted.
 */
function liveDocToHit(doc: SearchDocument, score: number): ProjectSearchHit {
  return {
    document_id: `live:${doc.source_id}`,
    source: doc.source as ProjectSearchSource,
    source_type: doc.source_type ?? "unknown",
    source_id: doc.source_id,
    title: doc.title,
    snippet: doc.snippet,
    ...(doc.source_url ? { url: doc.source_url } : {}),
    ...(doc.author ? { author: doc.author } : {}),
    ...(doc.timestamp ? { occurred_at: doc.timestamp } : {}),
    ...(doc.status ? { status: doc.status } : {}),
    freshness: "unknown",
    score,
    matched: {},
  };
}

/** Fan-out to live connectors scoped to this project and return scrubbed hits.
 *  Called only when the index returned zero candidates and the feature flag is on.
 */
async function liveFallbackHits(
  orgId: string,
  projectId: string,
  req: ProjectSearchRequest,
  resources: ProjectResources,
  maxHits: number,
): Promise<ProjectSearchHit[]> {
  const opts = {
    query: req.query,
    org_id: orgId,
    project_id: projectId,
    project_resources: resources,
    time_window_days: req.time_window_days ?? 90,
    max_hits_per_source: Math.ceil(maxHits / 2),
  };

  const sourceFilter = req.sources
    ? new Set(req.sources.filter((s) => LIVE_SOURCES.includes(s)))
    : new Set(LIVE_SOURCES);

  const connectors = ([
    sourceFilter.has("jira") ? searchJira(opts) : null,
    sourceFilter.has("github") ? searchGithub(opts) : null,
    sourceFilter.has("confluence") ? searchConfluence(opts) : null,
    sourceFilter.has("git") ? searchGit(opts) : null,
  ] as Array<ReturnType<typeof searchJira> | null>).filter(Boolean) as Array<ReturnType<typeof searchJira>>;

  const settled = await Promise.allSettled(connectors);
  const docs: SearchDocument[] = [];
  for (const r of settled) {
    if (r.status === "fulfilled") docs.push(...r.value.documents);
  }

  const scrubbed = scrubHits(docs);
  return scrubbed.slice(0, maxHits).map((doc, i) => liveDocToHit(doc, 1 / (1 + i)));
}

/**
 * Runs a hybrid search over one project's index. Returns null when the project
 * does not exist for the org (so the route can 404).
 */
export async function searchProject(
  orgId: string,
  projectId: string,
  req: ProjectSearchRequest,
): Promise<ProjectSearchResponse | null> {
  const project = loadProject(orgId, projectId);
  if (!project) return null;
  const resources = parseResources(project.resources_json);
  const documentCounts = documentsBySource(orgId, projectId);

  const maxHits = Math.min(Math.max(req.max_hits ?? DEFAULT_MAX_HITS, 1), 50);
  const includeKg = req.include_kg ?? true;
  const includeMindMap = req.include_mind_map ?? false;
  const graphExpansionEnabled = req.graph_expansion ?? true;
  const sourceFilter = req.sources && req.sources.length > 0 ? new Set(req.sources) : null;
  const entityTypes = req.entity_types && req.entity_types.length > 0 ? [...new Set(req.entity_types)] : null;
  const entityFilteredDocumentIds = entityTypes ? documentIdsForEntityTypes(orgId, projectId, entityTypes) : null;
  const cutoff = req.time_window_days
    ? new Date(Date.now() - req.time_window_days * 864e5).toISOString()
    : null;

  const identifiers = [...extractIdentifiers(req.query)];
  const terms = queryTerms(req.query);
  const matchExpr = buildMatchExpression(terms, identifiers);

  // ---- candidate generation ----
  const lexical = lexicalSearch(orgId, projectId, matchExpr);
  const queryVec = isEmbeddingAvailable() ? await generateEmbedding(req.query) : null;
  const semantic = queryVec ? semanticSearch(orgId, projectId, queryVec) : [];
  const identifierDocs = identifierMatches(orgId, projectId, identifiers);

  const acc = new Map<string, DocAccumulator>();
  const ensure = (docId: string): DocAccumulator => {
    let a = acc.get(docId);
    if (!a) {
      a = { identifier: false };
      acc.set(docId, a);
    }
    return a;
  };
  for (const hit of lexical) {
    const a = ensure(hit.document_id);
    if (a.lexRank === undefined || hit.rank < a.lexRank) {
      a.lexRank = hit.rank;
      a.bestLexChunk = hit.chunk_id;
    }
  }
  for (const hit of semantic) {
    const a = ensure(hit.document_id);
    if (a.semRank === undefined || hit.rank < a.semRank) {
      a.semRank = hit.rank;
      a.bestSemChunk = hit.chunk_id;
    }
  }
  for (const docId of identifierDocs) ensure(docId).identifier = true;

  const graphExpansion = graphExpansionEnabled
    ? expandProjectGraph(orgId, projectId, req.query, identifiers, acc)
    : emptyGraphExpansion();
  for (const [docId, graphScore] of graphExpansion.docScores) {
    const a = ensure(docId);
    a.graphScore = Math.max(a.graphScore ?? 0, graphScore);
    const entityIds = graphExpansion.entityIdsByDocument.get(docId);
    if (entityIds) {
      a.graphEntityIds = new Set([...(a.graphEntityIds ?? []), ...entityIds]);
    }
  }

  if (acc.size === 0) {
    // Live fallback: when the index has no candidates and the caller opted in,
    // fan out to live connectors scoped to this project's resources.
    if (liveFallbackEnabled(req)) {
      const liveHits = await liveFallbackHits(orgId, projectId, req, resources, maxHits);
      if (liveHits.length > 0) {
        const coverage = embeddingCoverage(orgId, projectId);
        const overlay = includeKg ? kgOverlay(orgId, projectId, req.query, queryVec) : [];
        const response: ProjectSearchResponse = {
          query: req.query,
          project_id: projectId,
          project_name: project.name,
          hits: liveHits,
          sources_used: [...new Set(liveHits.map((h) => h.source))],
          documents_by_source: documentCounts,
          detected_identifiers: identifiers,
          embedding_coverage: coverage,
          retrieval_mode: "lexical",
          total_documents: totalDocumentCount(documentCounts),
          generated_at: new Date().toISOString(),
        };
        if (overlay.length > 0) response.kg_overlay = overlay;
        if (req.synthesize) {
          const summary = await synthesizeAnswer(req.query, project.name, resources.aliases ?? [], liveHits, overlay);
          if (summary) response.summary_md = summary;
          const citations = answerCitations(overlay, liveHits);
          if (citations.length > 0) response.answer_citations = citations;
        }
        return response;
      }
    }
    return emptyResponse(
      project,
      resources,
      req,
      identifiers,
      queryVec,
      orgId,
      projectId,
      includeKg,
      includeMindMap,
      documentCounts,
      graphExpansion,
    );
  }

  // ---- load candidate documents + best chunk text ----
  const docIds = [...acc.keys()];
  const docRows = db
    .prepare(
      `SELECT id, source, source_type, source_id, source_url, title, author, status, occurred_at, freshness_state, metadata_json
       FROM project_search_documents
       WHERE id IN (${docIds.map(() => "?").join(", ")})`,
    )
    .all(...docIds) as unknown as DocRow[];
  const docById = new Map(docRows.map((d) => [d.id, d]));

  const chunkIds = new Set<string>();
  for (const a of acc.values()) {
    if (a.bestLexChunk) chunkIds.add(a.bestLexChunk);
    if (a.bestSemChunk) chunkIds.add(a.bestSemChunk);
  }
  const chunkText = new Map<string, ChunkTextRow>();
  if (chunkIds.size > 0) {
    const ids = [...chunkIds];
    const rows = db
      .prepare(
        `SELECT id, document_id, text, retrieval_text, embedding_json FROM project_search_chunks
         WHERE id IN (${ids.map(() => "?").join(", ")})`,
      )
      .all(...ids) as unknown as ChunkTextRow[];
    for (const r of rows) chunkText.set(r.id, r);
  }

  // ---- score + filter ----
  const hits: ProjectSearchHit[] = [];
  for (const [docId, a] of acc) {
    const doc = docById.get(docId);
    if (!doc) continue;
    if (doc.freshness_state === "deleted") continue;
    if (sourceFilter && !sourceFilter.has(doc.source)) continue;
    if (entityFilteredDocumentIds && !entityFilteredDocumentIds.has(doc.id)) continue;
    if (cutoff && doc.occurred_at && doc.occurred_at < cutoff) continue;

    const lexScore = a.lexRank ? 1 / (RRF_K + a.lexRank) : 0;
    const semScore = a.semRank ? 1 / (RRF_K + a.semRank) : 0;
    const graphScore = a.graphScore ?? 0;
    const scopeHit = inScope(doc, resources);
    let score = lexScore + semScore + graphScore;
    if (a.identifier) score += 1; // exact identifier lookups dominate
    if (scopeHit) score += 0.15;
    if (doc.occurred_at) {
      const ageDays = (Date.now() - new Date(doc.occurred_at).getTime()) / 864e5;
      if (!Number.isNaN(ageDays) && ageDays <= INDEXED_RECENCY_DAYS)
        score += INDEXED_RECENCY_MAX * (1 - ageDays / INDEXED_RECENCY_DAYS);
    }
    score += INDEXED_SOURCE_AUTHORITY[doc.source] ?? 0;
    score += intentBoost(req.query, doc);
    if (doc.freshness_state === "stale") score -= 0.1;

    const bestChunk = chunkText.get(a.bestLexChunk ?? "") ?? chunkText.get(a.bestSemChunk ?? "");
    hits.push({
      document_id: doc.id,
      ...(a.bestLexChunk || a.bestSemChunk ? { chunk_id: a.bestLexChunk ?? a.bestSemChunk } : {}),
      source: doc.source,
      source_type: doc.source_type,
      source_id: doc.source_id,
      title: doc.title,
      snippet: snippet(bestChunk?.text ?? doc.title),
      ...(doc.source_url ? { url: doc.source_url } : {}),
      ...(doc.author ? { author: doc.author } : {}),
      ...(doc.occurred_at ? { occurred_at: doc.occurred_at } : {}),
      ...(doc.status ? { status: doc.status } : {}),
      freshness: doc.freshness_state,
      score,
      ...(a.lexRank ? { lexical_score: lexScore } : {}),
      ...(a.semRank ? { semantic_score: semScore } : {}),
      ...(graphScore > 0 ? { graph_score: graphScore } : {}),
      matched: {
        ...(a.identifier ? { identifier: true } : {}),
        ...(a.lexRank ? { lexical: true } : {}),
        ...(a.semRank ? { semantic: true } : {}),
        ...(graphScore > 0 ? { graph: true } : {}),
        ...(scopeHit ? { in_scope_resource: true } : {}),
      },
    });
  }

  hits.sort((x, y) => y.score - x.score);
  // Diversity: keep one doc-type/source (e.g. 54 releases or a Jira-only pile)
  // from flooding the answer, so questions still surface supporting implementation
  // artifacts when they exist.
  const top: ProjectSearchHit[] = [];
  const perTypeCap = Math.max(2, Math.ceil(maxHits * 0.6));
  const perSourceCap = Math.max(3, Math.ceil(maxHits * 0.75));
  const graphOnlyCap = Math.max(1, Math.floor(maxHits * 0.3));
  let graphOnlyCount = 0;
  const typeCount = new Map<string, number>();
  const sourceCount = new Map<ProjectSearchSource, number>();
  const chosen = new Set<string>();
  for (const h of hits) {
    if (top.length >= maxHits) break;
    const graphOnly = !!h.matched.graph && !h.matched.identifier && !h.matched.lexical && !h.matched.semantic;
    if (graphOnly && graphOnlyCount >= graphOnlyCap) continue;
    const typeSeen = typeCount.get(h.source_type) ?? 0;
    const sourceSeen = sourceCount.get(h.source) ?? 0;
    if (typeSeen >= perTypeCap || sourceSeen >= perSourceCap) continue;
    top.push(h);
    chosen.add(h.document_id);
    if (graphOnly) graphOnlyCount++;
    typeCount.set(h.source_type, typeSeen + 1);
    sourceCount.set(h.source, sourceSeen + 1);
  }
  for (const h of hits) {
    if (top.length >= maxHits) break;
    if (chosen.has(h.document_id)) continue;
    const graphOnly = !!h.matched.graph && !h.matched.identifier && !h.matched.lexical && !h.matched.semantic;
    if (graphOnly && graphOnlyCount >= graphOnlyCap) continue;
    top.push(h);
    chosen.add(h.document_id);
    if (graphOnly) graphOnlyCount++;
  }

  const sourcesUsed = [...new Set(top.map((h) => h.source))];
  const coverage = embeddingCoverage(orgId, projectId);
  const implementationGuard = implementationEvidenceGuard(documentCounts);
  const overlay = includeKg ? kgOverlay(orgId, projectId, req.query, queryVec) : [];

  const response: ProjectSearchResponse = {
    query: req.query,
    project_id: projectId,
    project_name: project.name,
    hits: scrubHits(top),
    sources_used: sourcesUsed,
    documents_by_source: documentCounts,
    detected_identifiers: identifiers,
    embedding_coverage: coverage,
    // "hybrid" only when the query embedded AND there is an embedded corpus to match against.
    retrieval_mode: queryVec && coverage > 0 ? "hybrid" : "lexical",
    total_documents: totalDocumentCount(documentCounts),
    generated_at: new Date().toISOString(),
  };
  if (overlay.length > 0) response.kg_overlay = overlay;
  if (graphExpansion.focusFeature) response.focus_feature = graphExpansion.focusFeature;
  if (req.synthesize) {
    const summary = await synthesizeAnswer(req.query, project.name, resources.aliases ?? [], top, overlay);
    if (summary || implementationGuard) {
      response.summary_md = [implementationGuard, summary].filter(Boolean).join("\n\n");
    }
    const citations = answerCitations(overlay, top);
    if (citations.length > 0) response.answer_citations = citations;
  }
  if (includeMindMap) {
    const map = mindMapNeighborhood(orgId, projectId, top.map((h) => h.document_id), graphExpansion.seedEntityIds);
    if (map) response.mind_map = map;
  }
  return response;
}

function embeddingCoverage(orgId: string, projectId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total, COUNT(embedding_json) AS embedded
       FROM project_search_chunks WHERE org_id = ? AND project_id = ?`,
    )
    .get(orgId, projectId) as { total: number; embedded: number };
  return row.total === 0 ? 0 : Number((row.embedded / row.total).toFixed(3));
}

async function emptyResponse(
  project: ProjectRow,
  resources: ProjectResources,
  req: ProjectSearchRequest,
  identifiers: string[],
  queryEmbedding: number[] | null,
  orgId: string,
  projectId: string,
  includeKg: boolean,
  includeMindMap: boolean,
  documentCounts: Partial<Record<ProjectSearchSource, number>>,
  graphExpansion: GraphExpansion = emptyGraphExpansion(),
): Promise<ProjectSearchResponse> {
  const coverage = embeddingCoverage(orgId, projectId);
  const overlay = includeKg ? kgOverlay(orgId, projectId, req.query, queryEmbedding) : [];
  const response: ProjectSearchResponse = {
    query: req.query,
    project_id: project.project_id,
    project_name: project.name,
    hits: [],
    sources_used: [],
    documents_by_source: documentCounts,
    detected_identifiers: identifiers,
    embedding_coverage: coverage,
    retrieval_mode: queryEmbedding && coverage > 0 ? "hybrid" : "lexical",
    total_documents: totalDocumentCount(documentCounts),
    generated_at: new Date().toISOString(),
  };
  if (overlay.length > 0) response.kg_overlay = overlay;
  if (graphExpansion.focusFeature) response.focus_feature = graphExpansion.focusFeature;
  if (req.synthesize) {
    const implementationGuard = implementationEvidenceGuard(documentCounts);
    const summary = await synthesizeAnswer(req.query, project.name, resources.aliases ?? [], [], overlay);
    if (summary || implementationGuard) {
      response.summary_md = [implementationGuard, summary].filter(Boolean).join("\n\n");
    }
    const citations = answerCitations(overlay, []);
    if (citations.length > 0) response.answer_citations = citations;
  }
  if (includeMindMap) {
    const map = mindMapNeighborhood(orgId, projectId, [], graphExpansion.seedEntityIds);
    if (map) response.mind_map = map;
  }
  return response;
}
