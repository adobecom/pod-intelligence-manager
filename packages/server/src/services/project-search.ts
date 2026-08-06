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
import { scrubHits, redactSecrets } from "./search-core/scrub.js";
import { synthesizeSearch } from "./search-core/synthesizer.js";
import {
  INDEXED_RECENCY_DAYS,
  INDEXED_RECENCY_MAX,
  INDEXED_SCOPE_BONUS,
  INDEXED_SOURCE_AGE_HALF_LIFE_DAYS,
  INDEXED_SOURCE_AUTHORITY,
  INDEXED_STALE_PENALTY,
  RRF_K,
} from "./search-core/weights.js";
import { searchJira } from "../integrations/jira.js";
import { searchGithub } from "../integrations/github.js";
import { searchConfluence } from "../integrations/confluence.js";
import { searchGit } from "../integrations/git.js";
import {
  getProjectSourceHealth,
  isProjectEvidenceReadable,
} from "./project-memory.js";
import {
  configuredConfluenceSourceInstance,
  confluenceProjectVisibilityPolicy,
} from "../integrations/confluence-visibility.js";
import {
  projectResourceEligibilitySql,
  sanitizeProjectResources,
} from "./project-resource-bindings.js";
import { redactProjectText } from "./project-evidence-normalization.js";

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

const CANDIDATE_K = 200;
// The indexer emits at most 40 chunks per document. Over-fetch chunk lanes by
// that factor, then assign dense document ranks before applying the candidate
// cap. Otherwise one long document can consume the entire lexical top-k.
const MAX_CHUNKS_PER_DOCUMENT = 40;
const CHUNK_CANDIDATE_K = CANDIDATE_K * MAX_CHUNKS_PER_DOCUMENT;
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

interface AdjacentChunkRow {
  id: string;
  document_id: string;
  chunk_index: number;
  text: string;
}

interface ConfluenceContextDocumentRow {
  id: string;
  org_id: string;
  project_id: string;
  source_instance: string;
  title: string;
  metadata_json: string;
}

interface ConfluenceContextChunkRow extends AdjacentChunkRow {
  chunk_kind: string;
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
  seedEntityIds: string[];
  focusFeature?: ProjectSearchFocusFeature;
  focusFeatureEntityId?: string;
}

function parseResources(raw: string | null): ProjectResources {
  if (!raw) return {};
  try {
    return sanitizeProjectResources(JSON.parse(raw) as ProjectResources);
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

interface ExpandedProjectQuery {
  /** Original query plus matched project/glossary synonyms. */
  lexical: string;
  /** Lexical expansion plus glossary definitions for the embedding lane. */
  semantic: string;
}

function normalizedPhrase(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function containsWholePhrase(query: string, candidate: string): boolean {
  const normalizedCandidate = normalizedPhrase(candidate);
  if (!normalizedCandidate) return false;
  return ` ${normalizedPhrase(query)} `.includes(` ${normalizedCandidate} `);
}

function appendUniqueTerms(base: string, additions: string[], maxChars = 1_600): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const value of [base, ...additions]) {
    const trimmed = value.trim();
    const key = normalizedPhrase(trimmed);
    if (!key || seen.has(key)) continue;
    if (parts.length > 0 && parts.join(" ").length + trimmed.length + 1 > maxChars) break;
    seen.add(key);
    parts.push(trimmed);
  }
  return parts.join(" ");
}

/** Deterministic, bounded expansion. A project synonym group is activated only
 * when the query contains the project name or one of its aliases. Glossary
 * groups use whole normalized phrases, never substring matching ("ai" must not
 * activate inside "chair"). */
function expandProjectQuery(query: string, projectName: string, resources: ProjectResources): ExpandedProjectQuery {
  const lexicalAdditions: string[] = [];
  const semanticAdditions: string[] = [];
  const projectTerms = [projectName, ...(resources.aliases ?? [])].filter(Boolean);
  if (projectTerms.some((term) => containsWholePhrase(query, term))) {
    lexicalAdditions.push(...projectTerms);
  }

  for (const entry of resources.glossary ?? []) {
    const terms = [entry.term, ...(entry.aliases ?? [])].filter(Boolean);
    if (!terms.some((term) => containsWholePhrase(query, term))) continue;
    lexicalAdditions.push(...terms);
    semanticAdditions.push(...terms);
    if (entry.definition) semanticAdditions.push(entry.definition);
  }

  const lexical = appendUniqueTerms(query, lexicalAdditions);
  return {
    lexical,
    semantic: appendUniqueTerms(lexical, semanticAdditions),
  };
}

interface CandidateFilters {
  orgId: string;
  projectId: string;
  sources: ProjectSearchSource[] | null;
  entityTypes: ProjectSearchEntityType[] | null;
  cutoff: string | null;
  slackReadEnabled: boolean;
  confluenceReadEnabled: boolean;
  confluenceSourceInstance: string | null;
  confluenceSpaceKeys: string[];
  confluencePageIds: string[];
  resources: ProjectResources;
}

interface SqlFragment {
  sql: string;
  params: Array<string | number | null>;
}

/** Eligibility shared by every candidate lane. Keeping this predicate on the
 * document join prevents a global top-k from being consumed by candidates that
 * a later source/entity/time/freshness pass would discard. Null timestamps keep
 * the prior API behavior: an unknown date is not treated as provably old. */
function documentEligibilitySql(alias: string, filters: CandidateFilters): SqlFragment {
  const clauses = [
    `${alias}.org_id = ?`,
    `${alias}.project_id = ?`,
    `${alias}.freshness_state != 'deleted'`,
    `${alias}.visibility = 'project_visible'`,
  ];
  const params: Array<string | number | null> = [filters.orgId, filters.projectId];
  const resourceEligibility = projectResourceEligibilitySql(alias, filters.resources);
  clauses.push(resourceEligibility.sql);
  params.push(...resourceEligibility.params);

  if (!filters.slackReadEnabled) clauses.push(`${alias}.source != 'slack'`);
  if (!filters.confluenceReadEnabled) {
    clauses.push(`${alias}.source != 'confluence'`);
  } else {
    const policyTerms: string[] = [];
    const policyParams: string[] = [];
    const safeMetadata = `CASE WHEN json_valid(${alias}.metadata_json) THEN ${alias}.metadata_json ELSE '{}' END`;
    if (filters.confluenceSpaceKeys.length > 0) {
      policyTerms.push(
        `upper(CAST(json_extract(${safeMetadata}, '$.space_key') AS TEXT)) IN (${filters.confluenceSpaceKeys.map(() => "?").join(", ")})`,
      );
      policyParams.push(...filters.confluenceSpaceKeys);
    }
    if (filters.confluencePageIds.length > 0) {
      policyTerms.push(
        `CAST(json_extract(${safeMetadata}, '$.page_id') AS TEXT) IN (${filters.confluencePageIds.map(() => "?").join(", ")})`,
      );
      policyParams.push(...filters.confluencePageIds);
    }
    clauses.push(
      `(${alias}.source != 'confluence' OR (${alias}.source_instance = ? AND (${policyTerms.join(" OR ")})))`,
    );
    params.push(filters.confluenceSourceInstance, ...policyParams);
  }

  if (filters.sources && filters.sources.length > 0) {
    clauses.push(`${alias}.source IN (${filters.sources.map(() => "?").join(", ")})`);
    params.push(...filters.sources);
  }
  if (filters.cutoff) {
    clauses.push(`(${alias}.occurred_at IS NULL OR ${alias}.occurred_at >= ?)`);
    params.push(filters.cutoff);
  }
  if (filters.entityTypes && filters.entityTypes.length > 0) {
    const placeholders = filters.entityTypes.map(() => "?").join(", ");
    clauses.push(
      `(EXISTS (
         SELECT 1 FROM project_search_entities de
         WHERE de.org_id = ${alias}.org_id
           AND de.project_id = ${alias}.project_id
           AND de.source_document_id = ${alias}.id
           AND de.entity_type IN (${placeholders})
       ) OR EXISTS (
         SELECT 1
         FROM project_search_edges ee
         JOIN project_search_entities se ON se.id = ee.source_entity_id
         JOIN project_search_entities te ON te.id = ee.target_entity_id
         WHERE ee.org_id = ${alias}.org_id
           AND ee.project_id = ${alias}.project_id
           AND ee.evidence_document_id = ${alias}.id
           AND (se.entity_type IN (${placeholders}) OR te.entity_type IN (${placeholders}))
       ))`,
    );
    params.push(...filters.entityTypes, ...filters.entityTypes, ...filters.entityTypes);
  }
  return { sql: clauses.join(" AND "), params };
}

function eligibleDocumentIds(filters: CandidateFilters): Set<string> {
  const eligibility = documentEligibilitySql("d", filters);
  const rows = db
    .prepare(`SELECT d.id FROM project_search_documents d WHERE ${eligibility.sql}`)
    .all(...eligibility.params) as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
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

function slackMessagePermalink(text: string, query: string): string | undefined {
  const terms = queryTerms(query);
  const blocks = text.split(/\n\n(?=\[[^\]]+\]\s+<@)/);
  let best: { url: string; score: number; index: number } | undefined;
  for (const [index, block] of blocks.entries()) {
    const match = block.match(/(?:^|\n)Permalink:\s+(https:\/\/[^\s]+)/i);
    if (!match?.[1]) continue;
    const lower = block.toLowerCase();
    const score = terms.reduce((sum, term) => sum + (lower.includes(term.toLowerCase()) ? 1 : 0), 0);
    if (!best || score > best.score || (score === best.score && index < best.index)) {
      best = { url: match[1], score, index };
    }
  }
  return best?.url;
}

interface ChunkHit {
  chunk_id: string;
  document_id: string;
  rank: number;
  raw: number;
}

function denseDocumentRanks(
  rows: Array<{ chunk_id: string; document_id: string; raw: number }>,
): ChunkHit[] {
  const seen = new Set<string>();
  const ranked: ChunkHit[] = [];
  for (const row of rows) {
    if (seen.has(row.document_id)) continue;
    seen.add(row.document_id);
    ranked.push({ ...row, rank: ranked.length + 1 });
    if (ranked.length >= CANDIDATE_K) break;
  }
  return ranked;
}

function lexicalSearch(filters: CandidateFilters, matchExpr: string): ChunkHit[] {
  if (!matchExpr) return [];
  const eligibility = documentEligibilitySql("d", filters);
  if (isProjectSearchFtsAvailable()) {
    try {
      const rows = db
        .prepare(
          `SELECT project_search_fts.chunk_id, project_search_fts.document_id,
                  bm25(project_search_fts) AS score
           FROM project_search_fts
           JOIN project_search_documents d ON d.id = project_search_fts.document_id
           JOIN project_search_chunks c ON c.id = project_search_fts.chunk_id
           WHERE project_search_fts MATCH ? AND ${eligibility.sql}
           ORDER BY score, d.source, d.source_id, c.chunk_index, c.id
           LIMIT ?`,
        )
        .all(matchExpr, ...eligibility.params, CHUNK_CANDIDATE_K) as Array<{
          chunk_id: string;
          document_id: string;
          score: number;
        }>;
      // bm25 returns more-negative = better. Collapse chunks first so RRF ranks
      // source evidence (documents), not arbitrary window count.
      return denseDocumentRanks(rows.map((r) => ({
        chunk_id: r.chunk_id,
        document_id: r.document_id,
        raw: -r.score,
      })));
    } catch {
      // Malformed MATCH or FTS issue — fall through to LIKE.
    }
  }
  return lexicalLikeSearch(filters, matchExpr);
}

/** Keyword-LIKE fallback when FTS5 is unavailable. Scores by distinct term hits. */
function lexicalLikeSearch(filters: CandidateFilters, matchExpr: string): ChunkHit[] {
  const terms = [...matchExpr.matchAll(/"((?:[^"]|"")+)"/g)].map((m) => m[1].replace(/""/g, '"'));
  if (terms.length === 0) return [];
  const eligibility = documentEligibilitySql("d", filters);
  const clauses = terms.map(() => "(lower(c.text) LIKE ? OR lower(c.retrieval_text) LIKE ?)");
  const score = terms
    .map(() => "(CASE WHEN lower(c.text) LIKE ? OR lower(c.retrieval_text) LIKE ? THEN 1 ELSE 0 END)")
    .join(" + ");
  const likeParams = terms.flatMap((t) => [`%${t.toLowerCase()}%`, `%${t.toLowerCase()}%`]);
  const rows = db
    .prepare(
      `SELECT c.id AS chunk_id, c.document_id, (${score}) AS hits
       FROM project_search_chunks c
       JOIN project_search_documents d ON d.id = c.document_id
       WHERE ${eligibility.sql} AND (${clauses.join(" OR ")})
       ORDER BY hits DESC, d.source, d.source_id, c.chunk_index, c.id
       LIMIT ?`,
    )
    .all(...likeParams, ...eligibility.params, ...likeParams, CHUNK_CANDIDATE_K) as Array<{
    chunk_id: string;
    document_id: string;
    hits: number;
  }>;
  return denseDocumentRanks(rows.map((r) => ({
    chunk_id: r.chunk_id,
    document_id: r.document_id,
    raw: r.hits,
  })));
}

function semanticSearch(filters: CandidateFilters, queryVec: number[]): ChunkHit[] {
  const eligibility = documentEligibilitySql("d", filters);
  const rows = db
    .prepare(
      `SELECT c.id, c.document_id, c.embedding_json, d.source, d.source_id
       FROM project_search_chunks c
       JOIN project_search_documents d ON d.id = c.document_id
       WHERE ${eligibility.sql} AND c.embedding_json IS NOT NULL`,
    )
    .all(...eligibility.params) as Array<{
      id: string;
      document_id: string;
      embedding_json: string;
      source: string;
      source_id: string;
    }>;
  const bestByDocument = new Map<string, {
    chunk_id: string;
    document_id: string;
    sim: number;
    stable_key: string;
  }>();
  for (const row of rows) {
    let vec: number[];
    try {
      vec = JSON.parse(row.embedding_json) as number[];
    } catch {
      continue;
    }
    const sim = cosineSimilarity(queryVec, vec);
    if (sim <= 0) continue;
    const prior = bestByDocument.get(row.document_id);
    if (!prior || sim > prior.sim) {
      bestByDocument.set(row.document_id, {
        chunk_id: row.id,
        document_id: row.document_id,
        sim,
        stable_key: `${row.source}\0${row.source_id}`,
      });
    }
  }
  const scored = [...bestByDocument.values()]
    .sort((a, b) => b.sim - a.sim || a.stable_key.localeCompare(b.stable_key))
    .slice(0, CANDIDATE_K);
  return scored.map((s, i) => ({ chunk_id: s.chunk_id, document_id: s.document_id, rank: i + 1, raw: s.sim }));
}

/** A reference-like identifier (ticket key, PR/issue number, file path) — specific
 *  enough to drive an exact lookup. Bare project prefixes like "EMC" are excluded
 *  so they don't substring-match every ticket in the project. */
function isReferenceIdentifier(id: string): boolean {
  return /\d/.test(id) || id.includes("/") || id.includes("#") || id.includes(".");
}

function normalizeIdentifierToken(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/^[`"'([{]+/, "")
    .replace(/[`"',.;)\]}]+$/, "");
}

/** Exact identity tokens from a native id/title. Tail PR tokens are included so
 * `#12` can match `owner/repo#12`, while equality ensures `#12` never matches
 * `#120`. */
function identifierTokens(value: string): Set<string> {
  const tokens = new Set<string>();
  for (const extracted of extractIdentifiers(value)) {
    const normalized = normalizeIdentifierToken(extracted);
    if (normalized) tokens.add(normalized);
  }
  for (const match of value.match(/#[0-9]+\b/g) ?? []) tokens.add(normalizeIdentifierToken(match));
  for (const match of value.match(/\b[A-Z][A-Z0-9]+-[0-9]+\b/gi) ?? []) {
    tokens.add(normalizeIdentifierToken(match));
  }
  const whole = normalizeIdentifierToken(value);
  if (isReferenceIdentifier(whole) && !/\s/.test(whole)) tokens.add(whole);
  return tokens;
}

/** Documents whose identity contains the same normalized identifier token.
 * Candidate eligibility is applied in SQL and token equality in memory before
 * the exact-lane cap; no substring predicate is involved. */
function identifierMatches(filters: CandidateFilters, identifiers: string[]): Map<string, "native" | "title"> {
  const matches = new Map<string, "native" | "title">();
  const refs = new Set(
    identifiers
      .filter(isReferenceIdentifier)
      .map(normalizeIdentifierToken)
      .filter(Boolean),
  );
  if (refs.size === 0) return matches;
  const eligibility = documentEligibilitySql("d", filters);
  const rows = db
    .prepare(
      `SELECT d.id, d.source_id, d.title
       FROM project_search_documents d
       WHERE ${eligibility.sql}
       ORDER BY d.source_id, d.id`,
    )
    .all(...eligibility.params) as Array<{ id: string; source_id: string; title: string }>;
  const nativeMatches: string[] = [];
  const titleMatches: string[] = [];
  for (const row of rows) {
    const sourceTokens = identifierTokens(row.source_id);
    if ([...refs].some((ref) => sourceTokens.has(ref))) {
      nativeMatches.push(row.id);
      continue;
    }
    const titleTokens = identifierTokens(row.title);
    if ([...refs].some((ref) => titleTokens.has(ref))) titleMatches.push(row.id);
  }
  for (const id of nativeMatches) {
    if (matches.size >= 50) break;
    matches.set(id, "native");
  }
  for (const id of titleMatches) {
    if (matches.size >= 50) break;
    if (!matches.has(id)) matches.set(id, "title");
  }
  return matches;
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
      const metadata = parseJson<Record<string, unknown>>(doc.metadata_json, {});
      const spaceKey = typeof metadata.space_key === "string" ? metadata.space_key : "";
      if (spaces.some((space) => space.toUpperCase() === spaceKey.toUpperCase())) return true;
      const pageId = typeof metadata.page_id === "string" || typeof metadata.page_id === "number"
        ? String(metadata.page_id)
        : "";
      const configuredPageIds = new Set((resources.confluence?.page_ids ?? []).map(String));
      for (const rawUrl of resources.confluence?.page_urls ?? []) {
        try {
          const url = new URL(rawUrl);
          const match = url.pathname.match(/\/pages\/(\d+)/i) ?? url.search.match(/[?&]pageId=(\d+)/i);
          if (match?.[1]) configuredPageIds.add(match[1]);
        } catch {
          // Invalid bindings do not widen scope.
        }
      }
      return !!pageId && configuredPageIds.has(pageId);
    }
    case "slack": {
      const metadata = parseJson<Record<string, unknown>>(doc.metadata_json, {});
      const channelId = typeof metadata.channel_id === "string" ? metadata.channel_id : "";
      if ((resources.slack?.channels ?? []).some((binding) => binding.split(":").at(-1) === channelId)) return true;
      return !!doc.source_url && (resources.slack?.thread_urls ?? []).includes(doc.source_url);
    }
    case "kg":
      // KG docs are project-scoped by construction (indexed via indexProjectKgNodes
      // which filters by include_project_id) — always count as in-scope.
      return true;
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
    if (wantsRelease) b += 0.012;
    if (wantsNext && /upcoming/i.test(doc.title)) b += 0.006;
  }
  if (wantsBacklog && doc.source_type === "backlog_issue") b += 0.008;
  if (wantsActive && doc.source_type === "active_issue") b += 0.008;
  if (wantsDone && doc.source_type === "resolved_issue") b += 0.006;
  if (wantsImplementation && (doc.source === "github" || doc.source === "git")) {
    if (["merged_pr", "updated_pr", "default_branch_commit", "commit", "file_summary"].includes(doc.source_type)) b += 0.009;
    else b += 0.004;
  }
  return b;
}

function indexedAgeBoost(doc: DocRow, now = Date.now()): number {
  if (!doc.occurred_at) return 0;
  const occurredAt = new Date(doc.occurred_at).getTime();
  if (Number.isNaN(occurredAt)) return 0;
  const ageDays = Math.max(0, (now - occurredAt) / 864e5);
  const halfLife = INDEXED_SOURCE_AGE_HALF_LIFE_DAYS[doc.source] ?? INDEXED_RECENCY_DAYS;
  return INDEXED_RECENCY_MAX * Math.pow(0.5, ageDays / Math.max(1, halfLife));
}

function emptyGraphExpansion(): GraphExpansion {
  return {
    docScores: new Map(),
    seedEntityIds: [],
  };
}

function graphContribution(edge: GraphEdgeRow, hop: 1 | 2): number {
  const priority = EDGE_PRIORITY[edge.edge_type] ?? 10;
  const priorityFactor = priority / EDGE_PRIORITY.implements;
  const hopFactor = hop === 1 ? 1 : 0.62;
  return Math.min(GRAPH_MAX_CONTRIBUTION, GRAPH_MAX_CONTRIBUTION * priorityFactor * edge.confidence_score * hopFactor);
}

function addGraphDocScore(expansion: GraphExpansion, documentId: string, score: number): void {
  const prior = expansion.docScores.get(documentId) ?? 0;
  if (score > prior) expansion.docScores.set(documentId, score);
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

function graphSeedEntitiesForIdentifiers(
  orgId: string,
  projectId: string,
  identifiers: string[],
  eligibleDocuments: Set<string>,
): GraphEntityRow[] {
  const refs = new Set(
    identifiers
      .filter(isReferenceIdentifier)
      .map(normalizeIdentifierToken)
      .filter(Boolean),
  );
  if (refs.size === 0) return [];
  const rows = db
    .prepare(
      `SELECT id, entity_type, entity_key, label, source_document_id, metadata_json
       FROM project_search_entities
       WHERE org_id = ? AND project_id = ?`,
    )
    .all(orgId, projectId) as unknown as GraphEntityRow[];
  return rows.filter((row) => {
    if (row.source_document_id && !eligibleDocuments.has(row.source_document_id)) return false;
    const tokens = new Set([...identifierTokens(row.entity_key), ...identifierTokens(row.label)]);
    return [...refs].some((ref) => tokens.has(ref));
  }).slice(0, 40);
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

function graphFeatureSeeds(
  orgId: string,
  projectId: string,
  query: string,
  eligibleDocuments: Set<string>,
): GraphEntityRow[] {
  const rows = db
    .prepare(
      `SELECT id, entity_type, entity_key, label, source_document_id, metadata_json
       FROM project_search_entities
       WHERE org_id = ? AND project_id = ? AND entity_type = 'feature'
       LIMIT 5000`,
    )
    .all(orgId, projectId) as unknown as GraphEntityRow[];
  return rows.filter((row) => {
    if (row.source_document_id && !eligibleDocuments.has(row.source_document_id)) return false;
    if (!featureMatchesQuery(query, row)) return false;
    return adjacentGraphEdges(orgId, projectId, [row.id]).some(
      (edge) => !!edge.evidence_document_id && eligibleDocuments.has(edge.evidence_document_id),
    );
  }).slice(0, 8);
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

function buildFocusFeature(
  orgId: string,
  projectId: string,
  feature: GraphEntityRow,
  eligibleDocuments: Set<string>,
): ProjectSearchFocusFeature {
  const edges = adjacentGraphEdges(orgId, projectId, [feature.id])
    .filter((edge) => !!edge.evidence_document_id && eligibleDocuments.has(edge.evidence_document_id))
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
      if (!entity || (entity.source_document_id && !eligibleDocuments.has(entity.source_document_id))) return null;
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
  eligibleDocuments: Set<string>,
): GraphExpansion {
  const expansion = emptyGraphExpansion();
  const seeds = new Map<string, GraphEntityRow>();
  for (const entity of graphSeedEntitiesForIdentifiers(orgId, projectId, identifiers, eligibleDocuments)) {
    seeds.set(entity.id, entity);
  }
  for (const entity of graphSelfEntitiesForDocuments(orgId, projectId, graphSeedDocumentIds(acc))) seeds.set(entity.id, entity);
  const featureSeeds = graphFeatureSeeds(orgId, projectId, query, eligibleDocuments);
  for (const entity of featureSeeds) seeds.set(entity.id, entity);
  if (seeds.size === 0) return expansion;

  expansion.seedEntityIds = [...seeds.keys()];
  if (featureSeeds.length > 0) {
    expansion.focusFeatureEntityId = featureSeeds[0].id;
    expansion.focusFeature = buildFocusFeature(orgId, projectId, featureSeeds[0], eligibleDocuments);
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
    const edges = adjacentGraphEdges(orgId, projectId, expandableFrontier).filter(
      (edge) => !edge.evidence_document_id || eligibleDocuments.has(edge.evidence_document_id),
    );
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
        if (other.source_document_id && eligibleDocuments.has(other.source_document_id)) {
          addGraphDocScore(expansion, other.source_document_id, graphContribution(edge, hop));
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
    return result.nodes
      .filter((node) => node.ingestion_provenance?.kind !== "project_evidence"
        || (node.ingestion_provenance.evidence_item_ids ?? [])
          .some((evidenceId) => isProjectEvidenceReadable(orgId, projectId, evidenceId)))
      .map((node) => {
      const id = redactProjectText(node.id).text;
      const summary = redactProjectText(node.summary).text;
      const details = redactProjectText(node.details || node.summary).text;
      return {
        id,
        type: node.type,
        summary,
        snippet: snippet(details || summary),
        confidence_score: node.confidence_score,
        curated: node.curated,
        url: `/knowledge#${encodeURIComponent(id)}`,
      };
    });
  } catch {
    return [];
  }
}

function documentsBySource(filters: CandidateFilters): Partial<Record<ProjectSearchSource, number>> {
  const eligibility = documentEligibilitySql("d", filters);
  const rows = db
    .prepare(
      `SELECT d.source, COUNT(*) AS count
       FROM project_search_documents d
       WHERE ${eligibility.sql}
       GROUP BY d.source`,
    )
    .all(...eligibility.params) as Array<{ source: ProjectSearchSource; count: number }>;
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
  eligibleDocuments: Set<string>,
  explicitEntityIds: string[] = [],
): ProjectSearchMindMap | undefined {
  if (documentIds.length === 0 && explicitEntityIds.length === 0) return undefined;

  const selfEntities = graphSelfEntitiesForDocuments(orgId, projectId, documentIds);
  const explicitEntities = new Map(
    [...loadGraphEntitiesByIds(explicitEntityIds)].filter(([, entity]) =>
      !entity.source_document_id || eligibleDocuments.has(entity.source_document_id)),
  );
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
  const eligibleEdge = (edge: GraphEdgeRow): boolean =>
    !!edge.evidence_document_id && eligibleDocuments.has(edge.evidence_document_id);
  const oneHop = adjacentGraphEdges(orgId, projectId, seedIds).filter(eligibleEdge);
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
    ...adjacentGraphEdges(orgId, projectId, secondHopSeeds).filter(eligibleEdge),
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
    .filter((row): row is GraphEntityRow => row !== undefined
      && (!row.source_document_id || eligibleDocuments.has(row.source_document_id)))
    .slice(0, MIND_MAP_NODE_LIMIT)
    .map((row) => ({
      id: row.id,
      entity_type: row.entity_type,
      entity_key: row.entity_key,
      label: row.label,
      ...(row.source_document_id ? { source_document_id: row.source_document_id } : {}),
      metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
    }));

  // An endpoint can disappear above when its source document becomes
  // ineligible. Never expose a dangling edge that can indirectly disclose the
  // existence of a restricted or stale entity.
  const visibleEntityIds = new Set(entities.map((entity) => entity.id));
  const visibleEdges = edges.filter((edge) =>
    visibleEntityIds.has(edge.source_entity_id) && visibleEntityIds.has(edge.target_entity_id));

  return { entities, edges: visibleEdges };
}

interface DocAccumulator {
  lexRank?: number;
  semRank?: number;
  graphRank?: number;
  bestLexChunk?: string;
  bestSemChunk?: string;
  identifier: boolean;
  nativeIdentifier?: boolean;
}

// ── Live fallback (indexed → live) ───────────────────────────────────────────
// Gated by PROJECT_SEARCH_LIVE_FALLBACK=1 env flag AND req.use_live=true.
// Triggered only when the index returns zero candidates. Connectors run in
// parallel over the project's configured sources; results are scrubbed and
// adapted to ProjectSearchHit shape but NOT written back to the index.
// The repair path (write-through) is Phase 3b and is intentionally deferred
// until the ephemeral path is validated in integration tests.

const LIVE_SOURCES: ProjectSearchSource[] = ["jira", "github", "confluence", "git"];

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
    query: redactProjectText(req.query).text,
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

/** Expand only selected source-native conversational/document context. Candidate
 * generation and ranking always operate on the matched chunk alone. Slack gets
 * one neighboring window on either side; Confluence gets up to two, matching
 * the section-adjacency contract once heading-aware chunks are ingested. */
function confluenceSectionCoordinate(metadataJson: string): { pageId: string; sectionIndex: number } | null {
  const metadata = parseJson<Record<string, unknown>>(metadataJson, {});
  const pageId = metadata.page_id;
  const sectionIndex = metadata.section_index;
  if ((typeof pageId !== "string" && typeof pageId !== "number")
    || typeof sectionIndex !== "number"
    || !Number.isInteger(sectionIndex)) return null;
  return { pageId: String(pageId), sectionIndex };
}

/** Confluence stores one document per heading section. Expand across sibling
 * section documents on the same site/page, while retaining a bounded excerpt
 * from every selected neighbor so the matched section cannot be truncated out. */
function expandConfluenceSectionContext(hit: ProjectSearchHit): boolean {
  const matchedDocument = db.prepare(
    `SELECT id, org_id, project_id, source_instance, title, metadata_json
     FROM project_search_documents
     WHERE id = ? AND source = 'confluence'`,
  ).get(hit.document_id) as ConfluenceContextDocumentRow | undefined;
  if (!matchedDocument) return false;
  const matchedCoordinate = confluenceSectionCoordinate(matchedDocument.metadata_json);
  if (!matchedCoordinate) return false;

  const documents = (db.prepare(
    `SELECT id, org_id, project_id, source_instance, title, metadata_json
     FROM project_search_documents
     WHERE org_id = ? AND project_id = ? AND source = 'confluence'
       AND source_instance = ? AND freshness_state <> 'deleted'
       AND visibility = 'project_visible'
     ORDER BY id`,
  ).all(
    matchedDocument.org_id,
    matchedDocument.project_id,
    matchedDocument.source_instance,
  ) as unknown as ConfluenceContextDocumentRow[])
    .map((document) => ({ document, coordinate: confluenceSectionCoordinate(document.metadata_json) }))
    .filter((entry): entry is { document: ConfluenceContextDocumentRow; coordinate: { pageId: string; sectionIndex: number } } =>
      entry.coordinate !== null
      && entry.coordinate.pageId === matchedCoordinate.pageId
      && Math.abs(entry.coordinate.sectionIndex - matchedCoordinate.sectionIndex) <= 2)
    .sort((a, b) => a.coordinate.sectionIndex - b.coordinate.sectionIndex || a.document.id.localeCompare(b.document.id));
  if (documents.length <= 1) return false;

  const documentIds = documents.map(({ document }) => document.id);
  const chunks = db.prepare(
    `SELECT id, document_id, chunk_index, chunk_kind, text
     FROM project_search_chunks
     WHERE document_id IN (${documentIds.map(() => "?").join(", ")})
     ORDER BY document_id, chunk_index`,
  ).all(...documentIds) as unknown as ConfluenceContextChunkRow[];
  const chunksByDocument = new Map<string, ConfluenceContextChunkRow[]>();
  for (const chunk of chunks) {
    const existing = chunksByDocument.get(chunk.document_id) ?? [];
    existing.push(chunk);
    chunksByDocument.set(chunk.document_id, existing);
  }

  const separatorChars = Math.max(0, documents.length - 1) * 2;
  const perSectionLimit = Math.max(180, Math.floor((1_600 - separatorChars) / documents.length));
  const sections = documents.map(({ document }) => {
    const documentChunks = chunksByDocument.get(document.id) ?? [];
    const bodyChunks = documentChunks.filter((chunk) => chunk.chunk_kind !== "title");
    const text = (bodyChunks.length > 0 ? bodyChunks : documentChunks)
      .map((chunk) => chunk.text)
      .filter(Boolean)
      .join("\n\n");
    return snippet(`${document.title}\n${text}`.trim(), perSectionLimit);
  }).filter(Boolean);
  if (sections.length <= 1) return false;
  hit.snippet = sections.join("\n\n");
  return true;
}

function expandSelectedContext(hits: ProjectSearchHit[]): void {
  const loadMatch = db.prepare(
    `SELECT id, document_id, chunk_index, text
     FROM project_search_chunks WHERE id = ? AND document_id = ?`,
  );
  for (const hit of hits) {
    if (!hit.chunk_id || (hit.source !== "slack" && hit.source !== "confluence")) continue;
    if (hit.source === "confluence" && expandConfluenceSectionContext(hit)) continue;
    const matched = loadMatch.get(hit.chunk_id, hit.document_id) as AdjacentChunkRow | undefined;
    if (!matched) continue;
    const radius = hit.source === "confluence" ? 2 : 1;
    const rows = db
      .prepare(
        `SELECT id, document_id, chunk_index, text
         FROM project_search_chunks
         WHERE document_id = ? AND chunk_index BETWEEN ? AND ?
         ORDER BY chunk_index`,
      )
      .all(matched.document_id, Math.max(0, matched.chunk_index - radius), matched.chunk_index + radius) as unknown as AdjacentChunkRow[];
    if (rows.length <= 1) continue;
    hit.snippet = snippet(rows.map((row) => row.text).filter(Boolean).join("\n\n"), 1_600);
  }
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
  const safeQuery = redactProjectText(req.query).text;

  const maxHits = Math.min(Math.max(req.max_hits ?? DEFAULT_MAX_HITS, 1), 50);
  const includeKg = req.include_kg ?? (req.sources ? req.sources.includes("kg") : true);
  const includeMindMap = req.include_mind_map ?? false;
  const graphExpansionEnabled = req.graph_expansion ?? true;
  const sourceFilter: Set<ProjectSearchSource> | null = req.sources && req.sources.length > 0
    ? new Set(req.sources)
    : null;
  const enabledFlag = (name: string): boolean =>
    ["1", "true", "yes", "on"].includes((process.env[name] ?? "").trim().toLowerCase());
  const confluencePolicy = confluenceProjectVisibilityPolicy();
  const confluenceSourceInstance = configuredConfluenceSourceInstance();
  const confluenceSpaceKeys = [...confluencePolicy.space_keys].sort();
  const confluencePageIds = [...confluencePolicy.page_ids].sort();
  const entityTypes = req.entity_types && req.entity_types.length > 0 ? [...new Set(req.entity_types)] : null;
  const cutoff = req.time_window_days
    ? new Date(Date.now() - req.time_window_days * 864e5).toISOString()
    : null;
  const filters: CandidateFilters = {
    orgId,
    projectId,
    sources: sourceFilter ? [...sourceFilter] : null,
    entityTypes,
    cutoff,
    slackReadEnabled: enabledFlag("PROJECT_SLACK_SEARCH_ENABLED"),
    confluenceReadEnabled: enabledFlag("PROJECT_CONFLUENCE_SEARCH_ENABLED")
      && !!confluenceSourceInstance
      && (confluenceSpaceKeys.length > 0 || confluencePageIds.length > 0),
    confluenceSourceInstance,
    confluenceSpaceKeys,
    confluencePageIds,
    resources,
  };
  const documentCounts = documentsBySource(filters);
  const eligibleDocuments = eligibleDocumentIds(filters);

  const expandedQuery = expandProjectQuery(req.query, project.name, resources);
  const detectedIdentifierSet = extractIdentifiers(req.query);
  const wholeQueryIdentifier = normalizeIdentifierToken(req.query);
  if (isReferenceIdentifier(wholeQueryIdentifier) && !/\s/.test(wholeQueryIdentifier)) {
    detectedIdentifierSet.add(wholeQueryIdentifier);
  }
  const detectedIdentifiers = [...detectedIdentifierSet];
  const identifierSet = extractIdentifiers(expandedQuery.lexical);
  for (const identifier of detectedIdentifierSet) identifierSet.add(identifier);
  const identifiers = [...identifierSet];
  const terms = queryTerms(expandedQuery.lexical);
  const matchExpr = buildMatchExpression(terms, identifiers);

  // ---- candidate generation ----
  const lexical = lexicalSearch(filters, matchExpr);
  let queryVec: number[] | null = null;
  if (isEmbeddingAvailable()) {
    try {
      queryVec = await generateEmbedding(redactProjectText(expandedQuery.semantic).text);
    } catch {
      queryVec = null;
    }
  }
  const semantic = queryVec ? semanticSearch(filters, queryVec) : [];
  const identifierDocs = identifierMatches(filters, identifiers);

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
  for (const [docId, kind] of identifierDocs) {
    const candidate = ensure(docId);
    candidate.identifier = true;
    if (kind === "native") candidate.nativeIdentifier = true;
  }

  let graphExpansion = emptyGraphExpansion();
  if (graphExpansionEnabled) {
    try {
      graphExpansion = expandProjectGraph(
        orgId,
        projectId,
        expandedQuery.lexical,
        identifiers,
        acc,
        eligibleDocuments,
      );
    } catch {
      // Graph is an optional retrieval lane. Lexical/exact/semantic evidence
      // remains available if graph tables are absent or temporarily invalid.
      graphExpansion = emptyGraphExpansion();
    }
  }
  const graphRanks = [...graphExpansion.docScores.entries()]
    .filter(([docId]) => eligibleDocuments.has(docId))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, CANDIDATE_K);
  graphRanks.forEach(([docId], index) => {
    const a = ensure(docId);
    a.graphRank = index + 1;
  });

  if (acc.size === 0) {
    // Live fallback: when the index has no candidates and the caller opted in,
    // fan out to live connectors scoped to this project's resources.
    if (liveFallbackEnabled(req)) {
      const liveHits = await liveFallbackHits(orgId, projectId, req, resources, maxHits);
      if (liveHits.length > 0) {
        const coverage = embeddingCoverage(orgId, projectId);
        const overlay = includeKg ? kgOverlay(orgId, projectId, safeQuery, queryVec) : [];
        const response: ProjectSearchResponse = {
          query: safeQuery,
          project_id: projectId,
          project_name: project.name,
          hits: liveHits,
          sources_used: [...new Set(liveHits.map((h) => h.source))],
          documents_by_source: documentCounts,
          detected_identifiers: detectedIdentifiers,
          embedding_coverage: coverage,
          retrieval_mode: "lexical",
          total_documents: totalDocumentCount(documentCounts),
          source_health: getProjectSourceHealth(orgId, projectId) ?? [],
          generated_at: new Date().toISOString(),
        };
        if (overlay.length > 0) response.kg_overlay = overlay;
        if (req.synthesize) {
          const summary = await synthesizeAnswer(safeQuery, project.name, resources.aliases ?? [], liveHits, overlay);
          if (summary) response.summary_md = redactSecrets(summary).text;
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
      detectedIdentifiers,
      queryVec,
      orgId,
      projectId,
      includeKg,
      includeMindMap,
      documentCounts,
      eligibleDocuments,
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
    // Defensive checks mirror the candidate-generation predicate. They are not
    // relied upon for top-k correctness, but protect against inconsistent rows.
    if (doc.freshness_state === "deleted") continue;
    if (sourceFilter && !sourceFilter.has(doc.source)) continue;
    if (!eligibleDocuments.has(doc.id)) continue;
    if (cutoff && doc.occurred_at && doc.occurred_at < cutoff) continue;

    const lexScore = a.lexRank ? 1 / (RRF_K + a.lexRank) : 0;
    const semScore = a.semRank ? 1 / (RRF_K + a.semRank) : 0;
    const graphScore = a.graphRank ? 1 / (RRF_K + a.graphRank) : 0;
    const scopeHit = inScope(doc, resources);
    let score = lexScore + semScore + graphScore;
    if (a.identifier) score += 1; // exact identifier lookups dominate
    if (a.nativeIdentifier) score += 0.1; // native identity beats title mentions of the same id
    if (scopeHit) score += INDEXED_SCOPE_BONUS;
    score += indexedAgeBoost(doc);
    score += INDEXED_SOURCE_AUTHORITY[doc.source] ?? 0;
    score += intentBoost(req.query, doc);
    if (doc.freshness_state === "stale") score -= INDEXED_STALE_PENALTY;

    const bestChunkId = a.bestLexChunk && a.bestSemChunk
      ? (a.lexRank ?? Number.POSITIVE_INFINITY) <= (a.semRank ?? Number.POSITIVE_INFINITY)
        ? a.bestLexChunk
        : a.bestSemChunk
      : a.bestLexChunk ?? a.bestSemChunk;
    const bestChunk = chunkText.get(bestChunkId ?? "");
    const sourceUrl = doc.source === "slack"
      ? slackMessagePermalink(bestChunk?.text ?? "", req.query) ?? doc.source_url ?? undefined
      : doc.source_url ?? undefined;
    hits.push({
      document_id: doc.id,
      ...(bestChunkId ? { chunk_id: bestChunkId } : {}),
      source: doc.source,
      source_type: doc.source_type,
      source_id: doc.source_id,
      title: doc.title,
      snippet: snippet(bestChunk?.text ?? doc.title),
      ...(sourceUrl ? { url: sourceUrl } : {}),
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

  hits.sort((x, y) => y.score - x.score || x.source_id.localeCompare(y.source_id) || x.document_id.localeCompare(y.document_id));
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

  // Source-native context is deliberately expanded after ranking/diversity so
  // neighboring text cannot influence candidate scores.
  expandSelectedContext(top);

  const sourcesUsed = [...new Set(top.map((h) => h.source))];
  const coverage = embeddingCoverage(orgId, projectId);
  const implementationGuard = implementationEvidenceGuard(documentCounts);
  const overlay = includeKg ? kgOverlay(orgId, projectId, safeQuery, queryVec) : [];

  const response: ProjectSearchResponse = {
    query: safeQuery,
    project_id: projectId,
    project_name: project.name,
    hits: scrubHits(top),
    sources_used: sourcesUsed,
    documents_by_source: documentCounts,
    detected_identifiers: detectedIdentifiers,
    embedding_coverage: coverage,
    // "hybrid" only when the query embedded AND there is an embedded corpus to match against.
    retrieval_mode: queryVec && coverage > 0 ? "hybrid" : "lexical",
    total_documents: totalDocumentCount(documentCounts),
    source_health: getProjectSourceHealth(orgId, projectId) ?? [],
    generated_at: new Date().toISOString(),
  };
  if (overlay.length > 0) response.kg_overlay = overlay;
  if (graphExpansion.focusFeature) response.focus_feature = graphExpansion.focusFeature;
  if (req.synthesize) {
    const summary = await synthesizeAnswer(safeQuery, project.name, resources.aliases ?? [], top, overlay);
    if (summary || implementationGuard) {
      const scrubbed = summary ? redactSecrets(summary).text : undefined;
      response.summary_md = [implementationGuard, scrubbed].filter(Boolean).join("\n\n");
    }
    const citations = answerCitations(overlay, top);
    if (citations.length > 0) response.answer_citations = citations;
  }
  if (includeMindMap) {
    const map = mindMapNeighborhood(
      orgId,
      projectId,
      top.map((h) => h.document_id),
      eligibleDocuments,
      graphExpansion.seedEntityIds,
    );
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
  eligibleDocuments: Set<string>,
  graphExpansion: GraphExpansion = emptyGraphExpansion(),
): Promise<ProjectSearchResponse> {
  const coverage = embeddingCoverage(orgId, projectId);
  const safeQuery = redactProjectText(req.query).text;
  const overlay = includeKg ? kgOverlay(orgId, projectId, safeQuery, queryEmbedding) : [];
  const response: ProjectSearchResponse = {
    query: safeQuery,
    project_id: project.project_id,
    project_name: project.name,
    hits: [],
    sources_used: [],
    documents_by_source: documentCounts,
    detected_identifiers: identifiers,
    embedding_coverage: coverage,
    retrieval_mode: queryEmbedding && coverage > 0 ? "hybrid" : "lexical",
    total_documents: totalDocumentCount(documentCounts),
    source_health: getProjectSourceHealth(orgId, projectId) ?? [],
    generated_at: new Date().toISOString(),
  };
  if (overlay.length > 0) response.kg_overlay = overlay;
  if (graphExpansion.focusFeature) response.focus_feature = graphExpansion.focusFeature;
  if (req.synthesize) {
    const implementationGuard = implementationEvidenceGuard(documentCounts);
    const summary = await synthesizeAnswer(safeQuery, project.name, resources.aliases ?? [], [], overlay);
    if (summary || implementationGuard) {
      const scrubbed = summary ? redactSecrets(summary).text : undefined;
      response.summary_md = [implementationGuard, scrubbed].filter(Boolean).join("\n\n");
    }
    const citations = answerCitations(overlay, []);
    if (citations.length > 0) response.answer_citations = citations;
  }
  if (includeMindMap) {
    const map = mindMapNeighborhood(orgId, projectId, [], eligibleDocuments, graphExpansion.seedEntityIds);
    if (map) response.mind_map = map;
  }
  return response;
}
