/**
 * Indexed Project Search — write path.
 *
 * Normalizes project artifacts into `project_search_documents`, chunks them into
 * `project_search_chunks` (kept in sync with the `project_search_fts` FTS5 index),
 * extracts a deterministic entity/edge mind-map layer, and embeds chunks for
 * semantic retrieval. This index is the broad, current working memory; only
 * durable learnings are promoted to the org KG (see project-memory.ts).
 *
 * Idempotent: every artifact maps to a stable (source, source_id), so re-running
 * a backfill or re-polling a source upserts rather than duplicates. A content
 * hash short-circuits re-chunking when an artifact hasn't changed.
 */
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import db, { withTransaction } from "../db/connection.js";
import type {
  ProjectEvidenceItem,
  ProjectResources,
  ProjectSearchChunkKind,
  ProjectSearchEdgeType,
  ProjectSearchEntityType,
  ProjectSearchFreshness,
  ProjectSearchIndexStats,
  ProjectSearchSource,
} from "@pim/shared";
import { embeddingTextHash, generateEmbedding, isEmbeddingAvailable } from "./embeddings.js";
import { extractIdentifiers } from "./graph-analysis.js";

const EMBEDDING_MODEL = "amazon.titan-embed-text-v2:0";
const MAX_CHUNKS_PER_DOC = 24;
const CHUNK_TARGET_CHARS = 1000;
const CHUNK_OVERLAP_CHARS = 120;
const KEY_SEPARATOR = "\\0";
// Embeddings run as a bounded concurrent pool (Titan v2's on-demand quota is well
// above 1 req/sec). Tune via env without a code change; backs off on throttling.
const EMBED_CONCURRENCY = Math.max(1, parseInt(process.env.PROJECT_SEARCH_EMBED_CONCURRENCY ?? "6", 10) || 6);
const EMBED_PACING_MS = Math.max(0, parseInt(process.env.PROJECT_SEARCH_EMBED_PACING_MS ?? "100", 10) || 0);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface IndexDocumentInput {
  org_id: string;
  project_id: string;
  source: ProjectSearchSource;
  source_type: string;
  source_id: string;
  source_url?: string;
  title: string;
  author?: string;
  status?: string;
  occurred_at?: string;
  body?: string;
  /** Extra texts (e.g. comments) indexed as their own chunks. */
  comments?: string[];
  metadata?: Record<string, unknown>;
  permissions?: Record<string, unknown>;
  freshness_state?: ProjectSearchFreshness;
}

export interface IndexDocumentResult {
  document_id: string;
  chunks: number;
  reused: boolean;
}

// ---------------------------------------------------------------------------
// FTS availability (probed lazily; not cached so the test harness that drops
// and recreates tables between cases stays correct).
// ---------------------------------------------------------------------------

export function isProjectSearchFtsAvailable(): boolean {
  try {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'project_search_fts'")
      .get() as { name?: string } | undefined;
    if (!row?.name) return false;
    // Some local Node/SQLite builds can see an existing FTS5 virtual table in
    // sqlite_master but cannot load the fts5 module. Treat that as unavailable
    // and let the search path use the LIKE fallback.
    db.prepare("SELECT rowid FROM project_search_fts LIMIT 0").all();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tokenEstimate(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function contentHash(input: IndexDocumentInput): string {
  const parts = [
    input.title,
    input.status ?? "",
    input.body ?? "",
    ...(input.comments ?? []),
  ];
  return crypto.createHash("sha256").update(parts.join(KEY_SEPARATOR)).digest("hex");
}

interface ChunkDescriptor {
  kind: ProjectSearchChunkKind;
  text: string;
  /** Text fed to lexical + semantic retrieval (carries title context). */
  retrieval_text: string;
}

/** Splits a long body into overlapping windows on paragraph/sentence boundaries. */
function windowText(body: string): string[] {
  const clean = body.replace(/\r\n/g, "\n").trim();
  if (clean.length <= CHUNK_TARGET_CHARS) return clean ? [clean] : [];
  const windows: string[] = [];
  let start = 0;
  while (start < clean.length && windows.length < MAX_CHUNKS_PER_DOC) {
    let end = Math.min(start + CHUNK_TARGET_CHARS, clean.length);
    if (end < clean.length) {
      // Prefer to break on a paragraph, then sentence, then whitespace boundary.
      const slice = clean.slice(start, end);
      const para = slice.lastIndexOf("\n\n");
      const sentence = slice.lastIndexOf(". ");
      const space = slice.lastIndexOf(" ");
      const breakAt = para > CHUNK_TARGET_CHARS * 0.5 ? para
        : sentence > CHUNK_TARGET_CHARS * 0.5 ? sentence + 1
        : space > CHUNK_TARGET_CHARS * 0.5 ? space
        : -1;
      if (breakAt > 0) end = start + breakAt;
    }
    windows.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    start = Math.max(end - CHUNK_OVERLAP_CHARS, start + 1);
  }
  return windows.filter(Boolean);
}

function buildChunks(input: IndexDocumentInput): ChunkDescriptor[] {
  const title = input.title.replace(/\s+/g, " ").trim();
  const chunks: ChunkDescriptor[] = [];

  // Title is always its own chunk — short, high-signal, always embeddable.
  if (title) chunks.push({ kind: "title", text: title, retrieval_text: title });

  const bodyWindows = windowText(input.body ?? "");
  const isCode = input.source === "git" || input.source_type === "default_branch_commit";
  for (const w of bodyWindows) {
    chunks.push({
      kind: isCode ? "code" : "body",
      text: w,
      // Prepend the title so each chunk carries document context into lexical + vector space.
      retrieval_text: title ? `${title}\n${w}` : w,
    });
  }

  for (const comment of input.comments ?? []) {
    const c = comment.replace(/\s+/g, " ").trim();
    if (!c) continue;
    for (const w of windowText(c)) {
      chunks.push({ kind: "comment", text: w, retrieval_text: title ? `${title}\n${w}` : w });
    }
  }

  // Always guarantee at least one chunk so a titled-but-bodyless artifact is searchable.
  if (chunks.length === 0 && title) chunks.push({ kind: "title", text: title, retrieval_text: title });
  return chunks.slice(0, MAX_CHUNKS_PER_DOC);
}

// ---------------------------------------------------------------------------
// Deterministic entity / edge extraction (mind-map layer)
// ---------------------------------------------------------------------------

const FILE_EXT_RE = /\.(?:ts|tsx|js|jsx|json|ya?ml|md|css|scss|html|py|go|rs|java|sql)$/i;
const LOCAL_GIT_FILE_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs|json|ya?ml|css|scss|html|md|py|go|rs|java|sql)$/i;
const SYMBOL_FILE_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/i;
const FIX_RE = /\b(fix|fixes|fixed|close|closes|closed|resolve|resolves|resolved)\b/i;
const DEFAULT_GIT_LOOKBACK_DAYS = 90;
const MAX_GIT_COMMITS = 500;
const MAX_INDEXED_FILE_BYTES = 160 * 1024;
const MAX_PROJECT_GRAPH_ANNOTATION_NODES = 20_000;
const PROJECT_GRAPH_HUB_DEGREE = 24;

function classifyMention(id: string): ProjectSearchEntityType | null {
  // extractIdentifiers() lowercases its output, so match case-insensitively.
  if (/^[a-z][a-z0-9]+-\d+$/i.test(id)) return "ticket"; // JIRA-style key (MWPW-123)
  if (/#\d+$/.test(id)) return "pr"; // owner/repo#123 or #123
  if (FILE_EXT_RE.test(id) || (id.includes("/") && /\.[a-z]+$/i.test(id))) return "file";
  return null;
}

/** Canonical key for a mentioned entity (Jira keys are upper-cased for display/joins). */
function mentionKey(id: string, type: ProjectSearchEntityType): string {
  return type === "ticket" ? id.toUpperCase() : id;
}

interface EntityDescriptor {
  entity_type: ProjectSearchEntityType;
  entity_key: string;
  label: string;
  is_self?: boolean;
  metadata?: Record<string, unknown>;
}

interface EdgeDescriptor {
  source_key: string; // entity_key of source
  source_type: ProjectSearchEntityType;
  target_key: string;
  target_type: ProjectSearchEntityType;
  edge_type: ProjectSearchEdgeType;
  confidence_score: number;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim());
}

function featureKey(kind: "component" | "epic", value: string): string {
  const normalized = kind === "epic" ? value.trim().toUpperCase() : value.trim().toLowerCase();
  return `${kind}:${normalized}`;
}

function jiraFeatureDescriptors(input: IndexDocumentInput): EntityDescriptor[] {
  if (input.source !== "jira" || input.source_type === "release") return [];
  const features: EntityDescriptor[] = [];
  const components = stringArray(input.metadata?.components);
  for (const component of components) {
    features.push({
      entity_type: "feature",
      entity_key: featureKey("component", component),
      label: component,
      metadata: { kind: "component", name: component },
    });
  }
  const parent = typeof input.metadata?.parent === "string" ? input.metadata.parent.trim() : "";
  if (parent) {
    const parentSummary = typeof input.metadata?.parent_summary === "string" ? input.metadata.parent_summary.trim() : "";
    features.push({
      entity_type: "feature",
      entity_key: featureKey("epic", parent),
      label: parentSummary ? `${parent.toUpperCase()}: ${parentSummary}` : parent.toUpperCase(),
      metadata: { kind: "epic", key: parent.toUpperCase(), ...(parentSummary ? { summary: parentSummary } : {}) },
    });
  }
  return features;
}

/** Returns the self-entity for a document, or null when the artifact isn't a stable node. */
function selfEntity(input: IndexDocumentInput): EntityDescriptor | null {
  switch (input.source) {
    case "jira":
      if (input.source_type === "release") return null; // releases aren't ticket nodes
      return { entity_type: "ticket", entity_key: input.source_id, label: input.title, is_self: true };
    case "github": {
      if (input.source_type === "default_branch_commit") {
        return { entity_type: "commit", entity_key: input.source_id, label: input.title, is_self: true };
      }
      if (input.source_type === "issue") {
        return { entity_type: "ticket", entity_key: input.source_id, label: input.title, is_self: true };
      }
      return { entity_type: "pr", entity_key: input.source_id, label: input.title, is_self: true };
    }
    case "git":
      if (input.source_type === "file_summary") {
        const label = typeof input.metadata?.path === "string" ? input.metadata.path : input.title;
        return {
          entity_type: "file",
          entity_key: input.source_id,
          label,
          is_self: true,
          metadata: input.metadata,
        };
      }
      return { entity_type: "commit", entity_key: input.source_id, label: input.title, is_self: true };
    case "confluence":
      return { entity_type: "doc", entity_key: input.source_id, label: input.title, is_self: true };
    case "project_update":
    case "pod_update": {
      const t = (input.source_type || "").toLowerCase();
      if (t === "decision") return { entity_type: "decision", entity_key: input.source_id, label: input.title, is_self: true };
      if (t === "blocker") return { entity_type: "blocker", entity_key: input.source_id, label: input.title, is_self: true };
      return null; // ordinary updates aren't stable mind-map nodes
    }
    default:
      return null;
  }
}

function extractGraph(input: IndexDocumentInput): { entities: EntityDescriptor[]; edges: EdgeDescriptor[] } {
  const entities: EntityDescriptor[] = [];
  const edges: EdgeDescriptor[] = [];
  const self = selfEntity(input);
  if (self) entities.push(self);

  const fullText = `${input.title}\n${input.body ?? ""}`;
  const fixContext = FIX_RE.test(input.body ?? "");

  if (self?.entity_type === "ticket") {
    for (const feature of jiraFeatureDescriptors(input)) {
      entities.push(feature);
      edges.push({
        source_key: self.entity_key,
        source_type: self.entity_type,
        target_key: feature.entity_key,
        target_type: feature.entity_type,
        edge_type: "implements",
        confidence_score: 0.9,
      });
    }
  }

  // Author → person, with an "owns" edge to the self node.
  if (input.author && self) {
    const personKey = input.author.trim();
    if (personKey) {
      entities.push({ entity_type: "person", entity_key: personKey, label: personKey });
      edges.push({
        source_key: personKey,
        source_type: "person",
        target_key: self.entity_key,
        target_type: self.entity_type,
        edge_type: "owns",
        confidence_score: 0.8,
      });
    }
  }

  // Mentioned tickets / PRs / files.
  if (self) {
    const seen = new Set<string>([self.entity_key]);
    for (const id of extractIdentifiers(fullText)) {
      const type = classifyMention(id);
      if (!type) continue;
      const key = mentionKey(id, type);
      if (seen.has(key)) continue;
      seen.add(key);
      entities.push({ entity_type: type, entity_key: key, label: key });
      const edgeType: ProjectSearchEdgeType = type === "file"
        ? "touches"
        : fixContext
          ? "fixes"
          : "mentions";
      edges.push({
        source_key: self.entity_key,
        source_type: self.entity_type,
        target_key: key,
        target_type: type,
        edge_type: edgeType,
        confidence_score: edgeType === "fixes" ? 0.7 : 0.6,
      });
    }
  }

  return { entities, edges };
}

function upsertEntity(orgId: string, projectId: string, documentId: string, e: EntityDescriptor, now: string): string {
  const metadata = {
    ...(e.metadata ?? {}),
    version: 1,
    domains: [e.entity_type],
  };
  const metadataJson = JSON.stringify(metadata);
  const sourceDocumentId = e.is_self ? documentId : null;
  const existing = db
    .prepare(
      "SELECT id FROM project_search_entities WHERE org_id = ? AND project_id = ? AND entity_type = ? AND entity_key = ?",
    )
    .get(orgId, projectId, e.entity_type, e.entity_key) as { id: string } | undefined;
  if (existing) {
    db.prepare(
      `UPDATE project_search_entities
       SET label = ?,
           last_seen_at = ?,
           source_document_id = COALESCE(source_document_id, ?),
           metadata_json = CASE WHEN ? IS NOT NULL THEN ? ELSE metadata_json END
       WHERE id = ?`,
    ).run(e.label, now, sourceDocumentId, metadataJson, metadataJson, existing.id);
    return existing.id;
  }
  const id = `pse-${crypto.randomUUID().slice(0, 8)}`;
  db.prepare(
    `INSERT INTO project_search_entities
       (id, org_id, project_id, entity_type, entity_key, label, aliases_json, source_document_id, metadata_json, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?)`,
  ).run(id, orgId, projectId, e.entity_type, e.entity_key, e.label, sourceDocumentId, metadataJson ?? "{}", now, now);
  return id;
}

function persistGraph(
  orgId: string,
  projectId: string,
  documentId: string,
  graph: { entities: EntityDescriptor[]; edges: EdgeDescriptor[] },
  now: string,
): { entities: number; edges: number } {
  const idByKey = new Map<string, string>();
  for (const e of graph.entities) {
    const id = upsertEntity(orgId, projectId, documentId, e, now);
    idByKey.set(`${e.entity_type}:${e.entity_key}`, id);
  }
  let edgeCount = 0;
  for (const edge of graph.edges) {
    const sourceId = idByKey.get(`${edge.source_type}:${edge.source_key}`);
    const targetId = idByKey.get(`${edge.target_type}:${edge.target_key}`);
    if (!sourceId || !targetId || sourceId === targetId) continue;
    const id = `psg-${crypto.randomUUID().slice(0, 8)}`;
    db.prepare(
      `INSERT INTO project_search_edges
         (id, org_id, project_id, source_entity_id, target_entity_id, edge_type, evidence_document_id, confidence_score, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(org_id, project_id, source_entity_id, target_entity_id, edge_type) DO UPDATE SET
         evidence_document_id = excluded.evidence_document_id,
         confidence_score = MAX(project_search_edges.confidence_score, excluded.confidence_score)`,
    ).run(id, orgId, projectId, sourceId, targetId, edge.edge_type, documentId, edge.confidence_score, now);
    edgeCount++;
  }
  return { entities: graph.entities.length, edges: edgeCount };
}

function upsertDirectEdge(
  orgId: string,
  projectId: string,
  sourceEntityId: string,
  targetEntityId: string,
  edgeType: ProjectSearchEdgeType,
  evidenceDocumentId: string,
  confidenceScore: number,
  now: string,
): void {
  if (sourceEntityId === targetEntityId) return;
  const id = `psg-${crypto.randomUUID().slice(0, 8)}`;
  db.prepare(
    `INSERT INTO project_search_edges
       (id, org_id, project_id, source_entity_id, target_entity_id, edge_type, evidence_document_id, confidence_score, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(org_id, project_id, source_entity_id, target_entity_id, edge_type) DO UPDATE SET
       evidence_document_id = excluded.evidence_document_id,
       confidence_score = MAX(project_search_edges.confidence_score, excluded.confidence_score)`,
  ).run(id, orgId, projectId, sourceEntityId, targetEntityId, edgeType, evidenceDocumentId, confidenceScore, now);
}

// ---------------------------------------------------------------------------
// Document indexing
// ---------------------------------------------------------------------------

interface DocRow {
  id: string;
  content_hash: string;
}

/**
 * Upserts a single document and (re)builds its chunks, FTS rows, and mind-map
 * entities/edges. Returns `reused: true` when the content hash was unchanged
 * and nothing needed rewriting.
 */
export function indexProjectDocument(input: IndexDocumentInput): IndexDocumentResult {
  const hash = contentHash(input);
  const now = new Date().toISOString();
  const ftsAvailable = isProjectSearchFtsAvailable();

  const existing = db
    .prepare(
      "SELECT id, content_hash FROM project_search_documents WHERE org_id = ? AND project_id = ? AND source = ? AND source_id = ?",
    )
    .get(input.org_id, input.project_id, input.source, input.source_id) as DocRow | undefined;

  const documentId = existing?.id ?? `psd-${crypto.randomUUID().slice(0, 8)}`;

  return withTransaction(() => {
    // Always refresh document metadata (title/status/freshness can change cheaply).
    if (existing) {
      db.prepare(
        `UPDATE project_search_documents SET
           source_type = ?, source_url = ?, title = ?, author = ?, status = ?, occurred_at = ?,
           updated_at = ?, content_hash = ?, metadata_json = ?, permissions_json = ?, freshness_state = ?
         WHERE id = ?`,
      ).run(
        input.source_type,
        input.source_url ?? null,
        input.title,
        input.author ?? null,
        input.status ?? null,
        input.occurred_at ?? null,
        now,
        hash,
        JSON.stringify(input.metadata ?? {}),
        JSON.stringify(input.permissions ?? {}),
        input.freshness_state ?? "fresh",
        documentId,
      );
    } else {
      db.prepare(
        `INSERT INTO project_search_documents
           (id, org_id, project_id, source, source_type, source_id, source_url, title, author, status,
            occurred_at, ingested_at, updated_at, content_hash, metadata_json, permissions_json, freshness_state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        documentId,
        input.org_id,
        input.project_id,
        input.source,
        input.source_type,
        input.source_id,
        input.source_url ?? null,
        input.title,
        input.author ?? null,
        input.status ?? null,
        input.occurred_at ?? null,
        now,
        now,
        hash,
        JSON.stringify(input.metadata ?? {}),
        JSON.stringify(input.permissions ?? {}),
        input.freshness_state ?? "fresh",
      );
    }

    // Content unchanged → keep existing chunks/embeddings/graph.
    if (existing && existing.content_hash === hash) {
      return { document_id: documentId, chunks: 0, reused: true };
    }

    // Rebuild chunks + FTS for changed (or new) content.
    db.prepare("DELETE FROM project_search_chunks WHERE document_id = ?").run(documentId);
    if (ftsAvailable) db.prepare("DELETE FROM project_search_fts WHERE document_id = ?").run(documentId);

    const chunks = buildChunks(input);
    const insertChunk = db.prepare(
      `INSERT INTO project_search_chunks
         (id, document_id, org_id, project_id, chunk_index, chunk_kind, text, retrieval_text, token_estimate, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertFts = ftsAvailable
      ? db.prepare(
          "INSERT INTO project_search_fts (chunk_id, document_id, org_id, project_id, title, body) VALUES (?, ?, ?, ?, ?, ?)",
        )
      : null;

    chunks.forEach((chunk, index) => {
      const chunkId = `psc-${crypto.randomUUID().slice(0, 8)}`;
      insertChunk.run(
        chunkId,
        documentId,
        input.org_id,
        input.project_id,
        index,
        chunk.kind,
        chunk.text,
        chunk.retrieval_text,
        tokenEstimate(chunk.retrieval_text),
        now,
      );
      insertFts?.run(chunkId, documentId, input.org_id, input.project_id, input.title, chunk.retrieval_text);
    });

    persistGraph(input.org_id, input.project_id, documentId, extractGraph(input), now);

    return { document_id: documentId, chunks: chunks.length, reused: false };
  });
}

// ---------------------------------------------------------------------------
// Local git ingestion + lightweight exported-symbol extraction
// ---------------------------------------------------------------------------

interface ProjectResourcesRow {
  resources_json: string | null;
}

interface LocalGitCommit {
  sha: string;
  author_name: string;
  author_email: string;
  date: string;
  message: string;
  touched_files: string[];
}

interface LocalGitFileAccumulator {
  path: string;
  latest_date: string;
  recent_commits: string[];
}

interface ExportedSymbol {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "const";
  line: number;
}

interface ImportSpecifier {
  specifier: string;
  line: number;
}

function parseResources(raw: string | null | undefined): ProjectResources {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as ProjectResources;
  } catch {
    return {};
  }
}

function loadProjectResources(orgId: string, projectId: string): ProjectResources {
  const row = db
    .prepare("SELECT resources_json FROM projects WHERE org_id = ? AND project_id = ?")
    .get(orgId, projectId) as ProjectResourcesRow | undefined;
  return parseResources(row?.resources_json);
}

function gitOutput(repoPath: string, args: string[], maxBuffer = 16 * 1024 * 1024): string {
  return execFileSync("git", args, {
    cwd: repoPath,
    encoding: "utf8",
    maxBuffer,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function canonicalGitRepoPath(repoPath: string): string | null {
  try {
    if (!repoPath || !fs.existsSync(repoPath)) return null;
    const root = gitOutput(repoPath, ["rev-parse", "--show-toplevel"]).trim();
    return root ? path.resolve(root) : null;
  } catch {
    return null;
  }
}

function safeGitRelativePath(raw: string): string | null {
  const rel = raw.replace(/\\/g, "/").trim();
  if (!rel || rel.includes("\0") || rel.startsWith("/") || rel.split("/").includes("..")) return null;
  return rel;
}

function commitSourceId(repoPath: string, sha: string): string {
  return `${repoPath}@${sha}`;
}

function fileSourceId(repoPath: string, relPath: string): string {
  return `${repoPath}:${relPath}`;
}

function gitTouchedFiles(repoPath: string, sha: string): string[] {
  try {
    const out = gitOutput(repoPath, [
      "diff-tree",
      "--root",
      "--no-commit-id",
      "--name-only",
      "-r",
      "--diff-filter=ACMRT",
      sha,
    ]);
    const seen = new Set<string>();
    for (const line of out.split(/\r?\n/)) {
      const rel = safeGitRelativePath(line);
      if (rel) seen.add(rel);
    }
    return [...seen];
  } catch {
    return [];
  }
}

function recentGitCommits(repoPath: string, lookbackDays: number): LocalGitCommit[] {
  const since = new Date(Date.now() - lookbackDays * 864e5).toISOString();
  const out = gitOutput(
    repoPath,
    [
      "log",
      `--since=${since}`,
      `--max-count=${MAX_GIT_COMMITS}`,
      "--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%B%x1e",
    ],
    32 * 1024 * 1024,
  );
  return out
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const parts = entry.split("\x1f");
      const sha = parts[0] ?? "";
      return {
        sha,
        author_name: parts[1] ?? "",
        author_email: parts[2] ?? "",
        date: parts[3] ?? new Date().toISOString(),
        message: parts.slice(4).join("\x1f").trim(),
        touched_files: sha ? gitTouchedFiles(repoPath, sha) : [],
      };
    })
    .filter((commit) => commit.sha.length > 0);
}

function readIndexableFile(repoPath: string, relPath: string): string | null {
  if (!LOCAL_GIT_FILE_RE.test(relPath)) return null;
  const abs = path.resolve(repoPath, relPath);
  if (!abs.startsWith(`${repoPath}${path.sep}`)) return null;
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile() || stat.size > MAX_INDEXED_FILE_BYTES) return null;
    const content = fs.readFileSync(abs, "utf8");
    if (content.includes("\0")) return null;
    return content;
  } catch {
    return null;
  }
}

function lineForIndex(text: string, index: number): number {
  return text.slice(0, index).split(/\r?\n/).length;
}

function extractExportedSymbols(text: string): ExportedSymbol[] {
  const patterns: Array<[RegExp, ExportedSymbol["kind"], (match: RegExpExecArray) => string]> = [
    [/^\s*export\s+(?:declare\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/gm, "function", (m) => m[1]],
    [/^\s*export\s+default\s+(?:async\s+)?function(?:\s+([A-Za-z_$][A-Za-z0-9_$]*))?\b/gm, "function", (m) => m[1] ?? "default"],
    [/^\s*export\s+(?:declare\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/gm, "class", (m) => m[1]],
    [/^\s*export\s+default\s+class(?:\s+([A-Za-z_$][A-Za-z0-9_$]*))?\b/gm, "class", (m) => m[1] ?? "default"],
    [/^\s*export\s+(?:declare\s+)?interface\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/gm, "interface", (m) => m[1]],
    [/^\s*export\s+(?:declare\s+)?type\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/gm, "type", (m) => m[1]],
    [/^\s*export\s+(?:declare\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/gm, "const", (m) => m[1]],
  ];

  const seen = new Set<string>();
  const symbols: ExportedSymbol[] = [];
  for (const [pattern, kind, nameFor] of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const name = nameFor(match);
      const key = `${kind}:${name}:${match.index}`;
      if (!name || seen.has(key)) continue;
      seen.add(key);
      symbols.push({ name, kind, line: lineForIndex(text, match.index) });
    }
  }
  return symbols.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
}

function extractImportSpecifiers(text: string): ImportSpecifier[] {
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^'"]+\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+(?:type\s+)?[^'"]+\s+from\s+["']([^"']+)["']/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  ];
  const seen = new Set<string>();
  const imports: ImportSpecifier[] = [];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const specifier = match[1]?.trim();
      if (!specifier) continue;
      const key = `${specifier}:${match.index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      imports.push({ specifier, line: lineForIndex(text, match.index) });
    }
  }
  return imports.sort((a, b) => a.line - b.line || a.specifier.localeCompare(b.specifier));
}

function resolveRelativeImport(repoPath: string, fromRelPath: string, specifier: string): string | null {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;
  const fromDir = path.posix.dirname(fromRelPath.replace(/\\/g, "/"));
  const rawTarget = path.posix.normalize(path.posix.join(fromDir, specifier));
  if (!rawTarget || rawTarget.startsWith("../") || path.posix.isAbsolute(rawTarget)) return null;

  const candidates = [
    rawTarget,
    ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"].map((ext) => `${rawTarget}${ext}`),
    ...["ts", "tsx", "js", "jsx", "mjs", "cjs"].map((ext) => path.posix.join(rawTarget, `index.${ext}`)),
  ];
  for (const candidate of candidates) {
    const safe = safeGitRelativePath(candidate);
    if (!safe || !LOCAL_GIT_FILE_RE.test(safe)) continue;
    const abs = path.resolve(repoPath, safe);
    if (!abs.startsWith(`${repoPath}${path.sep}`)) continue;
    try {
      if (fs.statSync(abs).isFile()) return safe;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function indexSymbolsForFile(
  orgId: string,
  projectId: string,
  repoPath: string,
  relPath: string,
  documentId: string,
  content: string,
): number {
  if (!SYMBOL_FILE_RE.test(relPath)) return 0;
  const symbols = extractExportedSymbols(content);
  if (symbols.length === 0) return 0;

  const now = new Date().toISOString();
  const fileKey = fileSourceId(repoPath, relPath);
  const fileEntityId = upsertEntity(
    orgId,
    projectId,
    documentId,
    {
      entity_type: "file",
      entity_key: fileKey,
      label: relPath,
      is_self: true,
      metadata: { repo_path: repoPath, path: relPath },
    },
    now,
  );

  for (const symbol of symbols) {
    const symbolEntityId = upsertEntity(
      orgId,
      projectId,
      documentId,
      {
        entity_type: "symbol",
        entity_key: `${fileKey}#${symbol.name}`,
        label: symbol.name,
        is_self: true,
        metadata: {
          name: symbol.name,
          kind: symbol.kind,
          repo_path: repoPath,
          path: relPath,
          line: symbol.line,
        },
      },
      now,
    );
    upsertDirectEdge(orgId, projectId, fileEntityId, symbolEntityId, "defines", documentId, 0.95, now);
  }
  return symbols.length;
}

function indexImportsForFile(
  orgId: string,
  projectId: string,
  repoPath: string,
  relPath: string,
  documentId: string,
  content: string,
): number {
  if (!SYMBOL_FILE_RE.test(relPath)) return 0;
  const imports = extractImportSpecifiers(content);
  if (imports.length === 0) return 0;

  const now = new Date().toISOString();
  const fileKey = fileSourceId(repoPath, relPath);
  const fileEntityId = upsertEntity(
    orgId,
    projectId,
    documentId,
    {
      entity_type: "file",
      entity_key: fileKey,
      label: relPath,
      is_self: true,
      metadata: { repo_path: repoPath, path: relPath },
    },
    now,
  );

  let edgeCount = 0;
  const seenTargets = new Set<string>();
  for (const importSpec of imports) {
    const targetRelPath = resolveRelativeImport(repoPath, relPath, importSpec.specifier);
    if (!targetRelPath || seenTargets.has(targetRelPath)) continue;
    seenTargets.add(targetRelPath);
    const targetEntityId = upsertEntity(
      orgId,
      projectId,
      documentId,
      {
        entity_type: "file",
        entity_key: fileSourceId(repoPath, targetRelPath),
        label: targetRelPath,
        metadata: {
          repo_path: repoPath,
          path: targetRelPath,
          import_specifier: importSpec.specifier,
          line: importSpec.line,
        },
      },
      now,
    );
    upsertDirectEdge(orgId, projectId, fileEntityId, targetEntityId, "imports", documentId, 1.0, now);
    edgeCount++;
  }
  return edgeCount;
}

function indexLocalGitResources(
  orgId: string,
  projectId: string,
  seen: Set<string>,
): { documents: number; chunks: number } {
  const resources = loadProjectResources(orgId, projectId);
  const configuredRepos = resources.git?.repo_paths ?? [];
  if (configuredRepos.length === 0) return { documents: 0, chunks: 0 };

  let documents = 0;
  let chunks = 0;
  const lookbackDays = resources.git?.lookback_days ?? DEFAULT_GIT_LOOKBACK_DAYS;

  for (const configuredRepo of configuredRepos) {
    const repoPath = canonicalGitRepoPath(configuredRepo);
    if (!repoPath) continue;

    let commits: LocalGitCommit[];
    try {
      commits = recentGitCommits(repoPath, lookbackDays);
    } catch (err) {
      console.warn("[project-search] failed to read git repo", repoPath, (err as Error).message);
      continue;
    }

    const commitDocIds = new Map<string, string>();
    const filesByPath = new Map<string, LocalGitFileAccumulator>();

    for (const commit of commits) {
      const sourceId = commitSourceId(repoPath, commit.sha);
      const seenKey = `git${KEY_SEPARATOR}${sourceId}`;
      const subject = commit.message.split(/\r?\n/)[0]?.trim() || commit.sha;
      const touchedSourceFiles = commit.touched_files.filter((rel) => LOCAL_GIT_FILE_RE.test(rel));
      const body = [
        commit.message,
        touchedSourceFiles.length > 0 ? `Touched files:\n${touchedSourceFiles.map((f) => `- ${f}`).join("\n")}` : "",
      ].filter(Boolean).join("\n\n");

      if (!seen.has(seenKey)) {
        seen.add(seenKey);
        const res = indexProjectDocument({
          org_id: orgId,
          project_id: projectId,
          source: "git",
          source_type: "commit",
          source_id: sourceId,
          title: `Commit ${commit.sha.slice(0, 7)}: ${subject}`,
          author: commit.author_email ? `${commit.author_name} <${commit.author_email}>` : commit.author_name,
          occurred_at: commit.date,
          body,
          metadata: {
            repo_path: repoPath,
            sha: commit.sha,
            touched_files: touchedSourceFiles,
          },
        });
        documents++;
        chunks += res.chunks;
        commitDocIds.set(commit.sha, res.document_id);
      }

      for (const rel of touchedSourceFiles) {
        const existing = filesByPath.get(rel);
        if (existing) {
          existing.recent_commits.push(commit.sha);
        } else {
          filesByPath.set(rel, { path: rel, latest_date: commit.date, recent_commits: [commit.sha] });
        }
      }
    }

    const fileDocIds = new Map<string, string>();
    for (const file of filesByPath.values()) {
      const content = readIndexableFile(repoPath, file.path);
      if (content === null) continue;
      const sourceId = fileSourceId(repoPath, file.path);
      const seenKey = `git${KEY_SEPARATOR}${sourceId}`;
      if (seen.has(seenKey)) continue;
      seen.add(seenKey);

      const res = indexProjectDocument({
        org_id: orgId,
        project_id: projectId,
        source: "git",
        source_type: "file_summary",
        source_id: sourceId,
        title: file.path,
        occurred_at: file.latest_date,
        body: content,
        metadata: {
          repo_path: repoPath,
          path: file.path,
          recent_commits: [...new Set(file.recent_commits)].slice(0, 20),
        },
      });
      documents++;
      chunks += res.chunks;
      fileDocIds.set(file.path, res.document_id);
      indexSymbolsForFile(orgId, projectId, repoPath, file.path, res.document_id, content);
      indexImportsForFile(orgId, projectId, repoPath, file.path, res.document_id, content);
    }

    const now = new Date().toISOString();
    for (const commit of commits) {
      const commitDocId = commitDocIds.get(commit.sha);
      if (!commitDocId) continue;
      const commitEntityId = upsertEntity(
        orgId,
        projectId,
        commitDocId,
        {
          entity_type: "commit",
          entity_key: commitSourceId(repoPath, commit.sha),
          label: `Commit ${commit.sha.slice(0, 7)}`,
          is_self: true,
          metadata: { repo_path: repoPath, sha: commit.sha },
        },
        now,
      );
      for (const rel of commit.touched_files) {
        const fileDocId = fileDocIds.get(rel);
        if (!fileDocId) continue;
        const fileEntityId = upsertEntity(
          orgId,
          projectId,
          fileDocId,
          {
            entity_type: "file",
            entity_key: fileSourceId(repoPath, rel),
            label: rel,
            is_self: true,
            metadata: { repo_path: repoPath, path: rel },
          },
          now,
        );
        upsertDirectEdge(orgId, projectId, commitEntityId, fileEntityId, "touches", commitDocId, 0.95, now);
      }
    }
  }

  return { documents, chunks };
}

// ---------------------------------------------------------------------------
// Evidence + update → document mapping (shared by the live hook and backfill)
// ---------------------------------------------------------------------------

function mapEvidenceSource(source: ProjectEvidenceItem["source"]): ProjectSearchSource {
  switch (source) {
    case "commit":
      return "git";
    case "github":
    case "jira":
    case "slack":
    case "confluence":
    case "project_update":
      return source;
    default:
      return "project_update";
  }
}

export function documentInputFromEvidence(evidence: ProjectEvidenceItem): IndexDocumentInput {
  const meta = evidence.metadata ?? {};
  const status = typeof meta.status === "string" ? meta.status : typeof meta.state === "string" ? meta.state : undefined;
  return {
    org_id: evidence.org_id,
    project_id: evidence.project_id,
    source: mapEvidenceSource(evidence.source),
    source_type: evidence.source_type,
    source_id: evidence.source_id,
    ...(evidence.source_url ? { source_url: evidence.source_url } : {}),
    title: evidence.source_title || evidence.summary,
    ...(evidence.author ? { author: evidence.author } : {}),
    ...(status ? { status } : {}),
    occurred_at: evidence.occurred_at,
    body: evidence.body || evidence.summary,
    metadata: meta,
  };
}

/** Live hook: index an evidence item into the search layer. Never throws. */
export function indexEvidenceItem(evidence: ProjectEvidenceItem): void {
  try {
    indexProjectDocument(documentInputFromEvidence(evidence));
  } catch (err) {
    console.warn("[project-search] failed to index evidence", evidence.id, (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Backfill from existing project working memory
// ---------------------------------------------------------------------------

interface EvidenceBackfillRow {
  id: string;
  org_id: string;
  project_id: string;
  source: ProjectEvidenceItem["source"];
  source_type: string;
  source_id: string;
  source_url: string | null;
  source_title: string;
  summary: string;
  body: string;
  author: string | null;
  occurred_at: string;
  metadata_json: string;
  confidence_score: number;
  promotable: number;
}

interface UpdateBackfillRow {
  id: string;
  type: string;
  scope: string;
  summary: string;
  details: string;
  timestamp: string;
  status: string;
  agent_id: string;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * Rebuilds the lexical/graph index for a project from its existing working
 * memory: evidence items, project context updates, and linked pod updates.
 * Idempotent. Does not embed — call embedProjectSearchChunks() separately.
 */
export function backfillProjectSearch(orgId: string, projectId: string): { documents: number; chunks: number } {
  let documents = 0;
  let chunks = 0;
  const seen = new Set<string>();
  const index = (input: IndexDocumentInput) => {
    const key = `${input.source}${KEY_SEPARATOR}${input.source_id}`;
    if (seen.has(key)) return;
    seen.add(key);
    const res = indexProjectDocument(input);
    documents++;
    chunks += res.chunks;
  };

  // 1. Evidence items (github / jira / slack / confluence / commit / project_update).
  const evidence = db
    .prepare(
      `SELECT id, org_id, project_id, source, source_type, source_id, source_url, source_title,
              summary, body, author, occurred_at, metadata_json, confidence_score, promotable
       FROM project_evidence_items WHERE org_id = ? AND project_id = ?`,
    )
    .all(orgId, projectId) as unknown as EvidenceBackfillRow[];
  for (const row of evidence) {
    index(
      documentInputFromEvidence({
        id: row.id,
        org_id: row.org_id,
        project_id: row.project_id,
        source: row.source,
        source_type: row.source_type,
        source_id: row.source_id,
        ...(row.source_url ? { source_url: row.source_url } : {}),
        source_title: row.source_title,
        summary: row.summary,
        body: row.body,
        ...(row.author ? { author: row.author } : {}),
        occurred_at: row.occurred_at,
        ingested_at: row.occurred_at,
        metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
        confidence_score: row.confidence_score,
        promotable: row.promotable === 1,
      }),
    );
  }

  // 2. Project context updates.
  const projectUpdates = db
    .prepare(
      `SELECT id, type, scope, summary, details, timestamp, status, agent_id
       FROM project_context_updates WHERE org_id = ? AND project_id = ? AND retracted_at IS NULL`,
    )
    .all(orgId, projectId) as unknown as UpdateBackfillRow[];
  for (const u of projectUpdates) {
    index({
      org_id: orgId,
      project_id: projectId,
      source: "project_update",
      source_type: u.type,
      source_id: u.id,
      title: u.summary,
      author: u.agent_id,
      status: u.status,
      occurred_at: u.timestamp,
      body: u.details,
      metadata: { scope: u.scope, status: u.status, domains: [u.scope] },
    });
  }

  // 3. Pod context updates for pods linked to this project.
  const podUpdates = db
    .prepare(
      `SELECT cu.id, cu.type, cu.scope, cu.summary, cu.details, cu.timestamp, cu.status, cu.agent_id
       FROM context_updates cu
       JOIN pods p ON p.pod_id = cu.pod_id
       WHERE cu.org_id = ? AND p.project_id = ? AND cu.retracted_at IS NULL`,
    )
    .all(orgId, projectId) as unknown as UpdateBackfillRow[];
  for (const u of podUpdates) {
    index({
      org_id: orgId,
      project_id: projectId,
      source: "pod_update",
      source_type: u.type,
      source_id: u.id,
      title: u.summary,
      author: u.agent_id,
      status: u.status,
      occurred_at: u.timestamp,
      body: u.details,
      metadata: { scope: u.scope, status: u.status, domains: [u.scope] },
    });
  }

  const gitStats = indexLocalGitResources(orgId, projectId, seen);
  documents += gitStats.documents;
  chunks += gitStats.chunks;

  return { documents, chunks };
}

// ---------------------------------------------------------------------------
// Embedding
// ---------------------------------------------------------------------------

interface EmbedChunkRow {
  id: string;
  text: string;
  retrieval_text: string | null;
  embedding_text_hash: string | null;
}

/**
 * Embeds project chunks that lack an embedding or whose source text changed,
 * rate-limited to ~1 req/sec. Returns the number of chunks embedded.
 * No-op (returns 0) when the embedding service is unavailable.
 */
export async function embedProjectSearchChunks(orgId: string, projectId: string, limit = 5000): Promise<number> {
  if (!isEmbeddingAvailable()) return 0;
  const rows = db
    .prepare(
      `SELECT id, text, retrieval_text, embedding_text_hash
       FROM project_search_chunks
       WHERE org_id = ? AND project_id = ?
       ORDER BY created_at ASC`,
    )
    .all(orgId, projectId) as unknown as EmbedChunkRow[];

  const update = db.prepare(
    "UPDATE project_search_chunks SET embedding_json = ?, embedding_model = ?, embedding_text_hash = ? WHERE id = ?",
  );

  let embedded = 0;
  const pending = rows
    .filter((r) => r.embedding_text_hash !== embeddingTextHash(r.retrieval_text || r.text))
    .slice(0, limit);

  // Embed one chunk, with a single retry to ride out a transient throttle.
  // (DB writes are synchronous, so they never actually overlap on the event loop.)
  const embedOne = async (row: EmbedChunkRow): Promise<void> => {
    const text = row.retrieval_text || row.text;
    let embedding = await generateEmbedding(text);
    if (!embedding) {
      await sleep(500);
      embedding = await generateEmbedding(text);
    }
    if (!embedding) return; // unembedded chunks are picked up on the next reindex (hash still stale)
    update.run(JSON.stringify(embedding), EMBEDDING_MODEL, embeddingTextHash(text), row.id);
    embedded++;
  };

  // Bounded concurrency: process the backlog in waves of EMBED_CONCURRENCY.
  for (let i = 0; i < pending.length; i += EMBED_CONCURRENCY) {
    await Promise.all(pending.slice(i, i + EMBED_CONCURRENCY).map(embedOne));
    if (EMBED_PACING_MS > 0 && i + EMBED_CONCURRENCY < pending.length) await sleep(EMBED_PACING_MS);
  }
  return embedded;
}

// ---------------------------------------------------------------------------
// Reindex + cleanup
// ---------------------------------------------------------------------------

interface ProjectGraphEntityRow {
  id: string;
  entity_type: ProjectSearchEntityType;
  metadata_json: string;
}

interface ProjectGraphEdgeRow {
  source_entity_id: string;
  target_entity_id: string;
}

class UnionFind {
  private parent = new Map<string, string>();

  add(id: string): void {
    if (!this.parent.has(id)) this.parent.set(id, id);
  }

  find(id: string): string {
    const p = this.parent.get(id);
    if (!p) {
      this.parent.set(id, id);
      return id;
    }
    if (p === id) return id;
    const root = this.find(p);
    this.parent.set(id, root);
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }
}

/**
 * Annotates the project retrieval graph after a rebuild. The annotations live in
 * entity metadata so the query path can identify hubs/communities without a
 * separate graph artifact.
 */
export function annotateProjectGraph(orgId: string, projectId: string): { annotated: number; skipped: boolean } {
  const rows = db
    .prepare(
      `SELECT id, entity_type, metadata_json
       FROM project_search_entities
       WHERE org_id = ? AND project_id = ?`,
    )
    .all(orgId, projectId) as unknown as ProjectGraphEntityRow[];
  if (rows.length === 0) return { annotated: 0, skipped: false };

  const nonSymbolRows = rows.filter((row) => row.entity_type !== "symbol");
  const skipped = nonSymbolRows.length > MAX_PROJECT_GRAPH_ANNOTATION_NODES;
  const edges = db
    .prepare(
      `SELECT source_entity_id, target_entity_id
       FROM project_search_edges
       WHERE org_id = ? AND project_id = ?`,
    )
    .all(orgId, projectId) as unknown as ProjectGraphEdgeRow[];

  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.source_entity_id, (degree.get(edge.source_entity_id) ?? 0) + 1);
    degree.set(edge.target_entity_id, (degree.get(edge.target_entity_id) ?? 0) + 1);
  }

  const communityById = new Map<string, string>();
  if (!skipped) {
    const nonSymbol = new Set(nonSymbolRows.map((row) => row.id));
    const uf = new UnionFind();
    for (const id of nonSymbol) uf.add(id);
    for (const edge of edges) {
      if (nonSymbol.has(edge.source_entity_id) && nonSymbol.has(edge.target_entity_id)) {
        uf.union(edge.source_entity_id, edge.target_entity_id);
      }
    }
    const rootToCommunity = new Map<string, string>();
    let counter = 0;
    for (const row of nonSymbolRows) {
      const root = uf.find(row.id);
      let cid = rootToCommunity.get(root);
      if (!cid) {
        cid = `project-community-${counter++}`;
        rootToCommunity.set(root, cid);
      }
      communityById.set(row.id, cid);
    }
  }

  const update = db.prepare("UPDATE project_search_entities SET metadata_json = ? WHERE id = ?");
  withTransaction(() => {
    for (const row of rows) {
      const metadata = parseJson<Record<string, unknown>>(row.metadata_json, {});
      const entityDegree = degree.get(row.id) ?? 0;
      update.run(
        JSON.stringify({
          ...metadata,
          version: 1,
          domains: [row.entity_type],
          graph: {
            ...(typeof metadata.graph === "object" && metadata.graph !== null ? metadata.graph : {}),
            degree: entityDegree,
            is_hub: entityDegree >= PROJECT_GRAPH_HUB_DEGREE,
            ...(communityById.has(row.id) ? { community_id: communityById.get(row.id) } : {}),
            ...(skipped ? { community_skipped: true } : {}),
          },
        }),
        row.id,
      );
    }
  });

  return { annotated: rows.length, skipped };
}

export interface ReindexOptions {
  embed?: boolean;
}

export async function reindexProjectSearch(
  orgId: string,
  projectId: string,
  opts: ReindexOptions = {},
): Promise<ProjectSearchIndexStats> {
  purgeProjectSearch(orgId, projectId);
  backfillProjectSearch(orgId, projectId);
  const chunksEmbedded = opts.embed ? await embedProjectSearchChunks(orgId, projectId) : 0;
  annotateProjectGraph(orgId, projectId);

  const counts = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM project_search_documents WHERE org_id = ? AND project_id = ?) AS docs,
         (SELECT COUNT(*) FROM project_search_chunks   WHERE org_id = ? AND project_id = ?) AS chunks,
         (SELECT COUNT(*) FROM project_search_entities WHERE org_id = ? AND project_id = ?) AS entities,
         (SELECT COUNT(*) FROM project_search_edges    WHERE org_id = ? AND project_id = ?) AS edges`,
    )
    .get(orgId, projectId, orgId, projectId, orgId, projectId, orgId, projectId) as {
    docs: number;
    chunks: number;
    entities: number;
    edges: number;
  };

  return {
    project_id: projectId,
    documents_indexed: counts.docs,
    chunks_indexed: counts.chunks,
    entities_indexed: counts.entities,
    edges_indexed: counts.edges,
    chunks_embedded: chunksEmbedded,
    embedding_available: isEmbeddingAvailable(),
  };
}

/** Removes all project-search rows for a project (used on archive). */
export function purgeProjectSearch(orgId: string, projectId: string): void {
  withTransaction(() => {
    if (isProjectSearchFtsAvailable()) {
      db.prepare("DELETE FROM project_search_fts WHERE org_id = ? AND project_id = ?").run(orgId, projectId);
    }
    db.prepare("DELETE FROM project_search_edges WHERE org_id = ? AND project_id = ?").run(orgId, projectId);
    db.prepare("DELETE FROM project_search_entities WHERE org_id = ? AND project_id = ?").run(orgId, projectId);
    db.prepare("DELETE FROM project_search_chunks WHERE org_id = ? AND project_id = ?").run(orgId, projectId);
    db.prepare("DELETE FROM project_search_documents WHERE org_id = ? AND project_id = ?").run(orgId, projectId);
  });
}
