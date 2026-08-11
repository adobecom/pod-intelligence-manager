import crypto from "node:crypto";
import db from "../db/connection.js";
import { assertLegacyActivationStructure } from "./memory-structural-validator.js";
import { assertLegacyMemoryWritable, legacyMemoryWritesFrozen } from "./memory-authority.js";
import type {
  EnhancedPodLearning,
  KnowledgeNodeType,
  ProjectEvidenceItem,
  ProjectEvidenceSource,
  ProjectMemoryCandidate,
  ProjectResources,
  ProjectSourceHealth,
} from "@pim/shared";
import { ingestLearnings } from "./ingestion-gateway.js";
import { queryKnowledge } from "./knowledge-graph.js";
import { extractIdentifiers, extractKeywords } from "./graph-analysis.js";
import { indexEvidenceItem } from "./project-search-index.js";
import { validatePendingAgentSessionCandidatesForProjectEvidence } from "./agent-memory.js";
import {
  normalizeProjectEvidence,
  ProjectEvidenceNormalizationError,
} from "./project-evidence-normalization.js";
import { syncSlackProjectSource } from "./project-slack-sync.js";
import { syncConfluenceProjectSource } from "./project-confluence-source.js";
import {
  configuredConfluenceSourceInstance,
  confluenceProjectVisibilityPolicy,
  hasConfluenceProjectVisibilityPolicy,
} from "../integrations/confluence-visibility.js";
import {
  changedConnectorSources,
  connectorBindingVersion,
  projectResourceEligibilitySql,
  sanitizeProjectResources,
  configuredGithubRepos,
  hasGithubProjectBinding,
  hasJiraProjectBinding,
} from "./project-resource-bindings.js";

const AUTO_PROMOTE_CONFIDENCE_MIN = 0.85;
const SOURCE_HEALTH_PROBE_TIMEOUT_MS = 5_000;

type JsonRecord = Record<string, unknown>;

function enabledFlag(name: string): boolean {
  return ["1", "true", "yes", "on"].includes((process.env[name] ?? "").trim().toLowerCase());
}

function evidenceReadEligibilitySql(alias: string, resources: ProjectResources): { sql: string; params: string[] } {
  const resourceEligibility = projectResourceEligibilitySql(alias, resources);
  const clauses = [`${alias}.visibility = 'project_visible'`, resourceEligibility.sql];
  const params: string[] = [...resourceEligibility.params];
  if (!enabledFlag("PROJECT_SLACK_SEARCH_ENABLED")) clauses.push(`${alias}.source != 'slack'`);

  const policy = confluenceProjectVisibilityPolicy();
  const sourceInstance = configuredConfluenceSourceInstance();
  const spaces = [...policy.space_keys].sort();
  const pages = [...policy.page_ids].sort();
  if (!enabledFlag("PROJECT_CONFLUENCE_SEARCH_ENABLED") || !sourceInstance || (spaces.length === 0 && pages.length === 0)) {
    clauses.push(`${alias}.source != 'confluence'`);
  } else {
    const safeMetadata = `CASE WHEN json_valid(${alias}.metadata_json) THEN ${alias}.metadata_json ELSE '{}' END`;
    const allowed: string[] = [];
    const policyParams: string[] = [];
    if (spaces.length > 0) {
      allowed.push(
        `upper(CAST(json_extract(${safeMetadata}, '$.space_key') AS TEXT)) IN (${spaces.map(() => "?").join(", ")})`,
      );
      policyParams.push(...spaces);
    }
    if (pages.length > 0) {
      allowed.push(
        `CAST(json_extract(${safeMetadata}, '$.page_id') AS TEXT) IN (${pages.map(() => "?").join(", ")})`,
      );
      policyParams.push(...pages);
    }
    clauses.push(`(${alias}.source != 'confluence' OR (${alias}.source_instance = ? AND (${allowed.join(" OR ")})))`);
    params.push(sourceInstance, ...policyParams);
  }
  return { sql: clauses.join(" AND "), params };
}

interface ProjectRow {
  project_id: string;
  name: string;
  org_id: string;
  resources_json: string | null;
}

interface EvidenceRow {
  id: string;
  org_id: string;
  project_id: string;
  source: ProjectEvidenceSource;
  source_type: string;
  source_id: string;
  source_url: string | null;
  source_title: string;
  summary: string;
  body: string;
  author: string | null;
  occurred_at: string;
  ingested_at: string;
  metadata_json: string;
  confidence_score: number;
  promotable: number;
  promoted_node_id: string | null;
  source_instance: string;
  native_id: string | null;
  source_version: string | null;
  visibility: ProjectEvidenceItem["visibility"] | null;
  visibility_version: string | null;
  redaction_version: string | null;
  normalized_content_hash: string | null;
  source_updated_at: string | null;
}

interface CandidateRow {
  id: string;
  org_id: string;
  project_id: string;
  evidence_item_id: string;
  type: KnowledgeNodeType;
  summary: string;
  details: string;
  domains_json: string;
  confidence_score: number;
  source: ProjectEvidenceSource;
  status: ProjectMemoryCandidate["status"];
  created_at: string;
  reviewed_at: string | null;
  promoted_node_id: string | null;
}

export interface ProjectEvidenceInput {
  org_id: string;
  project_id: string;
  source: ProjectEvidenceSource;
  source_type: string;
  source_id: string;
  source_url?: string;
  source_title: string;
  summary: string;
  body: string;
  author?: string;
  occurred_at?: string;
  metadata?: JsonRecord;
  confidence_score: number;
  promotable?: boolean;
  source_instance?: string;
  native_id?: string;
  source_version?: string;
  visibility?: NonNullable<ProjectEvidenceItem["visibility"]>;
  visibility_version?: string;
  source_updated_at?: string;
}

export interface PollSourceResult {
  source: ProjectEvidenceSource;
  ingested: number;
  deleted?: number;
  quarantined?: number;
  missing?: string;
}

export interface ProjectPollResult {
  results: PollSourceResult[];
  health: ProjectSourceHealth[];
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function loadProject(projectId: string, orgId: string): ProjectRow | null {
  const row = db
    .prepare("SELECT project_id, name, org_id, resources_json FROM projects WHERE project_id = ? AND org_id = ?")
    .get(projectId, orgId) as ProjectRow | undefined;
  return row ?? null;
}

function rowToEvidence(row: EvidenceRow): ProjectEvidenceItem {
  return {
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
    ingested_at: row.ingested_at,
    metadata: parseJson<JsonRecord>(row.metadata_json, {}),
    confidence_score: row.confidence_score,
    promotable: row.promotable === 1,
    ...(row.promoted_node_id ? { promoted_node_id: row.promoted_node_id } : {}),
    source_instance: row.source_instance,
    native_id: row.native_id ?? row.source_id,
    ...(row.source_version ? { source_version: row.source_version } : {}),
    visibility: row.visibility ?? "unknown",
    visibility_version: row.visibility_version ?? "1",
    redaction_version: row.redaction_version ?? "legacy",
    ...(row.normalized_content_hash ? { normalized_content_hash: row.normalized_content_hash } : {}),
    ...(row.source_updated_at ? { source_updated_at: row.source_updated_at } : {}),
  };
}

function rowToCandidate(row: CandidateRow): ProjectMemoryCandidate {
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    evidence_item_id: row.evidence_item_id,
    type: row.type,
    summary: row.summary,
    details: row.details,
    domains: parseJson<string[]>(row.domains_json, []),
    confidence_score: row.confidence_score,
    source: row.source,
    status: row.status,
    created_at: row.created_at,
    ...(row.reviewed_at ? { reviewed_at: row.reviewed_at } : {}),
    ...(row.promoted_node_id ? { promoted_node_id: row.promoted_node_id } : {}),
  };
}

function shouldAutoPromote(evidence: ProjectEvidenceItem): boolean {
  if (evidence.source === "slack") return false;
  if (evidence.confidence_score < AUTO_PROMOTE_CONFIDENCE_MIN) return false;
  if (evidence.source === "github" && evidence.source_type === "merged_pr") return true;
  if (evidence.source === "jira" && evidence.source_type === "resolved_issue") return true;
  return false;
}

function hasMeaningfulOverlap(a: string, b: string): boolean {
  const aIdentifiers = extractIdentifiers(a);
  const bIdentifiers = extractIdentifiers(b);
  for (const identifier of aIdentifiers) {
    if (bIdentifiers.has(identifier)) return true;
  }

  const aKeywords = extractKeywords(a);
  const bKeywords = extractKeywords(b);
  let keywordHits = 0;
  for (const keyword of aKeywords) {
    if (bKeywords.has(keyword)) keywordHits++;
    if (keywordHits >= 2) return true;
  }
  return false;
}

function antiPatternContradictsEvidence(evidenceText: string, nodeText: string): boolean {
  const text = nodeText.toLowerCase();
  if (/\b(contradict|contradicts|conflict|conflicts|incompatible|superseded|rejected)\b/.test(text)) return true;
  if (/\b(do not|don't|must not|should not|never)\b/.test(text)) return true;
  if (!/\bavoid\b/.test(text)) return false;
  return hasMeaningfulOverlap(evidenceText, nodeText);
}

function hasCurrentContradiction(evidence: ProjectEvidenceItem): boolean {
  try {
    const evidenceText = `${evidence.summary} ${evidence.body}`;
    const result = queryKnowledge(evidence.org_id, {
      filters: {
        types: ["anti_pattern"],
        include_project_id: evidence.project_id,
        confidence_min: 0.75,
      },
      query_text: evidenceText,
      max_tokens: 800,
      limit: 3,
    });
    return result.nodes.some((node) => {
      const text = `${node.summary} ${node.details}`;
      return antiPatternContradictsEvidence(evidenceText, text);
    });
  } catch {
    return false;
  }
}

function candidateTypeFor(evidence: ProjectEvidenceItem): KnowledgeNodeType {
  const text = `${evidence.source_type} ${evidence.summary}`.toLowerCase();
  if (text.includes("risk") || text.includes("avoid") || text.includes("regression")) return "anti_pattern";
  if (text.includes("conflict") || text.includes("resolved")) return "resolved_conflict";
  if (text.includes("decision") || text.includes("decided") || text.includes("chose")) return "decision";
  if (evidence.source === "jira" && evidence.source_type === "resolved_issue") return "decision";
  if (evidence.source === "github" && evidence.source_type === "merged_pr") return "pattern";
  return "scope_insight";
}

function domainsFor(projectId: string, evidence: ProjectEvidenceItem): string[] {
  const metaDomains = evidence.metadata.domains;
  if (Array.isArray(metaDomains)) {
    const cleaned = metaDomains.filter((d): d is string => typeof d === "string" && d.trim().length > 0);
    if (cleaned.length > 0) return [...new Set(cleaned)];
  }
  return [...new Set(["project", projectId, evidence.source])];
}

function candidateDetails(evidence: ProjectEvidenceItem): string {
  const lines = [
    evidence.summary,
    evidence.body,
    evidence.source_url ? `Source: ${evidence.source_url}` : "",
  ].filter(Boolean);
  return lines.join("\n\n");
}

function getEvidenceById(orgId: string, projectId: string, evidenceId: string): ProjectEvidenceItem | null {
  const project = loadProject(projectId, orgId);
  if (!project) return null;
  const eligibility = evidenceReadEligibilitySql(
    "e",
    sanitizeProjectResources(parseJson<ProjectResources>(project.resources_json, {})),
  );
  const row = db
    .prepare(`SELECT e.* FROM project_evidence_items e
      WHERE e.id = ? AND e.org_id = ? AND e.project_id = ? AND ${eligibility.sql}`)
    .get(evidenceId, orgId, projectId, ...eligibility.params) as unknown as EvidenceRow | undefined;
  return row ? rowToEvidence(row) : null;
}

export function isProjectEvidenceReadable(orgId: string, projectId: string, evidenceId: string): boolean {
  return getEvidenceById(orgId, projectId, evidenceId) !== null;
}

function getCandidateRow(orgId: string, projectId: string, candidateId: string): CandidateRow | null {
  const row = db
    .prepare("SELECT * FROM project_memory_candidates WHERE id = ? AND org_id = ? AND project_id = ?")
    .get(candidateId, orgId, projectId) as unknown as CandidateRow | undefined;
  return row ?? null;
}

function createOrLoadCandidate(evidence: ProjectEvidenceItem): ProjectMemoryCandidate {
  const existing = db
    .prepare(
      "SELECT * FROM project_memory_candidates WHERE org_id = ? AND project_id = ? AND evidence_item_id = ? AND summary = ?",
    )
    .get(evidence.org_id, evidence.project_id, evidence.id, evidence.summary) as unknown as CandidateRow | undefined;
  if (existing) return rowToCandidate(existing);

  const id = `pmc-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const candidate = {
    id,
    org_id: evidence.org_id,
    project_id: evidence.project_id,
    evidence_item_id: evidence.id,
    type: candidateTypeFor(evidence),
    summary: evidence.summary,
    details: candidateDetails(evidence),
    domains: domainsFor(evidence.project_id, evidence),
    confidence_score: evidence.confidence_score,
    source: evidence.source,
    status: "pending" as const,
    created_at: now,
  };

  db.prepare(
    `INSERT INTO project_memory_candidates
       (id, org_id, project_id, evidence_item_id, type, summary, details, domains_json, confidence_score, source, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    candidate.id,
    candidate.org_id,
    candidate.project_id,
    candidate.evidence_item_id,
    candidate.type,
    candidate.summary,
    candidate.details,
    JSON.stringify(candidate.domains),
    candidate.confidence_score,
    candidate.source,
    candidate.status,
    candidate.created_at,
  );
  return candidate;
}

export async function promoteProjectMemoryCandidate(
  orgId: string,
  projectId: string,
  candidateId: string,
): Promise<ProjectMemoryCandidate | null> {
  assertLegacyMemoryWritable("project_memory_candidate_promotion");
  const project = loadProject(projectId, orgId);
  if (!project) return null;

  const row = getCandidateRow(orgId, projectId, candidateId);
  if (!row) return null;
  const candidate = rowToCandidate(row);
  if (candidate.status === "promoted") return candidate;

  const evidence = getEvidenceById(orgId, projectId, candidate.evidence_item_id);
  if (!evidence) return null;
  // `promotable` is the authoritative lifecycle boundary, not merely an
  // auto-promotion hint. Discussion/wiki evidence must remain evidence-only
  // even when a caller knows the candidate id and requests manual promotion.
  if (!evidence.promotable) return null;

  assertLegacyActivationStructure({
    type: candidate.type,
    summary: candidate.summary,
    details: candidate.details,
    domains: candidate.domains,
  });

  const learning: EnhancedPodLearning = {
    type: candidate.type,
    summary: candidate.summary,
    details: candidate.details,
    domains: candidate.domains,
    confidence: candidate.confidence_score >= AUTO_PROMOTE_CONFIDENCE_MIN ? "extracted" : "inferred",
    confidence_score: candidate.confidence_score,
    audience: "project",
    provenance: [
      {
        source: evidence.source,
        source_id: evidence.source_id,
        title: evidence.source_title,
        url: evidence.source_url,
        occurred_at: evidence.occurred_at,
        evidence_item_id: evidence.id,
      },
    ],
    ingestion_provenance: {
      kind: "project_evidence",
      run_id: `project-memory:${candidate.id}`,
      model: "deterministic-v1",
      evidence_node_ids: [],
      evidence_item_ids: [evidence.id],
    },
  };

  const result = await ingestLearnings(
    orgId,
    [learning],
    `project-${projectId}`,
    project.name,
    "project_memory",
    { project_id: projectId, project_name: project.name },
    { skipAnalysis: true },
  );
  const nodeId = result.nodeIds[0] ?? candidate.promoted_node_id;
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE project_memory_candidates SET status = 'promoted', reviewed_at = ?, promoted_node_id = ? WHERE id = ? AND org_id = ? AND project_id = ?",
  ).run(now, nodeId ?? null, candidate.id, orgId, projectId);
  db.prepare(
    "UPDATE project_evidence_items SET promoted_node_id = COALESCE(?, promoted_node_id) WHERE id = ? AND org_id = ? AND project_id = ?",
  ).run(nodeId ?? null, evidence.id, orgId, projectId);

  const promoted = getCandidateRow(orgId, projectId, candidate.id);
  return promoted ? rowToCandidate(promoted) : null;
}

export function rejectProjectMemoryCandidate(
  orgId: string,
  projectId: string,
  candidateId: string,
): ProjectMemoryCandidate | null {
  assertLegacyMemoryWritable("project_memory_candidate_rejection");
  const row = getCandidateRow(orgId, projectId, candidateId);
  if (!row) return null;
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE project_memory_candidates SET status = 'rejected', reviewed_at = ? WHERE id = ? AND org_id = ? AND project_id = ?",
  ).run(now, candidateId, orgId, projectId);
  const updated = getCandidateRow(orgId, projectId, candidateId);
  return updated ? rowToCandidate(updated) : null;
}

export async function recordProjectEvidence(input: ProjectEvidenceInput): Promise<ProjectEvidenceItem> {
  const project = loadProject(input.project_id, input.org_id);
  if (!project) throw new Error(`Project not found: ${input.project_id}`);

  const bindingSource = input.source === "commit" ? "git" : input.source;
  const resources = sanitizeProjectResources(parseJson<ProjectResources>(project.resources_json, {}));
  const bindingVersion = bindingSource === "github"
    || bindingSource === "jira"
    || bindingSource === "slack"
    || bindingSource === "confluence"
    || bindingSource === "git"
    ? connectorBindingVersion(resources, bindingSource)
    : null;
  if ((bindingSource === "github"
      || bindingSource === "jira"
      || bindingSource === "slack"
      || bindingSource === "confluence"
      || bindingSource === "git")
    && !bindingVersion) {
    throw new ProjectEvidenceNormalizationError(
      "resource_binding",
      `Project evidence source has no eligible current project binding: ${bindingSource}`,
    );
  }
  // A persisted binding version is derived state, not caller authority. Always
  // stamp the current admin-controlled project binding after validating that a
  // connector binding exists, so re-ingestion repairs stale metadata.
  const metadata = bindingVersion
    ? { ...(input.metadata ?? {}), resource_binding_version: bindingVersion }
    : input.metadata;

  const normalized = normalizeProjectEvidence({
    source: input.source,
    source_type: input.source_type,
    source_id: input.source_id,
    source_instance: input.source_instance,
    native_id: input.native_id,
    source_version: input.source_version,
    source_url: input.source_url,
    source_title: input.source_title,
    summary: input.summary,
    body: input.body,
    author: input.author,
    metadata,
    visibility: input.visibility,
    visibility_version: input.visibility_version,
    source_updated_at: input.source_updated_at,
  });
  if (normalized.visibility !== "project_visible") {
    throw new Error(`Project evidence visibility is not eligible for persistence: ${normalized.visibility}`);
  }

  const existing = db
    .prepare(
      `SELECT id, occurred_at FROM project_evidence_items
       WHERE org_id = ? AND project_id = ? AND source = ? AND source_id = ?`,
    )
    .get(input.org_id, input.project_id, input.source, normalized.source_id) as { id: string; occurred_at: string } | undefined;

  const id = existing?.id ?? `pei-${crypto.randomUUID().slice(0, 8)}`;
  const ingestedAt = new Date().toISOString();
  const occurredAt = input.occurred_at ?? existing?.occurred_at ?? ingestedAt;
  const strongSource =
    (input.source === "github" && input.source_type === "merged_pr") ||
    (input.source === "jira" && input.source_type === "resolved_issue");
  const promotable = input.promotable ?? (strongSource && input.confidence_score >= AUTO_PROMOTE_CONFIDENCE_MIN);

  db.prepare(
    `INSERT INTO project_evidence_items
       (id, org_id, project_id, source, source_type, source_id, source_url, source_title, summary, body,
        author, occurred_at, ingested_at, metadata_json, confidence_score, promotable, source_instance, native_id,
        source_version, visibility, visibility_version, redaction_version, normalized_content_hash, source_updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(org_id, project_id, source, source_id) DO UPDATE SET
       source_type = excluded.source_type,
       source_url = excluded.source_url,
       source_title = excluded.source_title,
       summary = excluded.summary,
       body = excluded.body,
       author = excluded.author,
       occurred_at = excluded.occurred_at,
       ingested_at = excluded.ingested_at,
       metadata_json = excluded.metadata_json,
       confidence_score = excluded.confidence_score,
       promotable = excluded.promotable,
       source_instance = excluded.source_instance,
       native_id = excluded.native_id,
       source_version = excluded.source_version,
       visibility = excluded.visibility,
       visibility_version = excluded.visibility_version,
       redaction_version = excluded.redaction_version,
       normalized_content_hash = excluded.normalized_content_hash,
       source_updated_at = excluded.source_updated_at`,
  ).run(
    id,
    input.org_id,
    input.project_id,
    input.source,
    normalized.source_type,
    normalized.source_id,
    normalized.source_url ?? null,
    normalized.source_title,
    normalized.summary,
    normalized.body,
    normalized.author ?? null,
    occurredAt,
    ingestedAt,
    JSON.stringify(normalized.metadata),
    input.confidence_score,
    promotable ? 1 : 0,
    normalized.source_instance,
    normalized.native_id,
    normalized.source_version ?? null,
    normalized.visibility,
    normalized.visibility_version,
    normalized.redaction_version,
    normalized.normalized_content_hash,
    normalized.source_updated_at ?? null,
  );

  const row = db.prepare("SELECT * FROM project_evidence_items WHERE id = ?").get(id) as unknown as EvidenceRow;
  const evidence = rowToEvidence(row);
  indexEvidenceItem(evidence);
  if (legacyMemoryWritesFrozen()) return evidence;
  const candidate = createOrLoadCandidate(evidence);
  if (shouldAutoPromote(evidence) && !hasCurrentContradiction(evidence) && candidate.status !== "promoted") {
    await promoteProjectMemoryCandidate(input.org_id, input.project_id, candidate.id);
  }
  if (evidence.source === "github" && evidence.source_type === "merged_pr") {
    try {
      await validatePendingAgentSessionCandidatesForProjectEvidence(evidence);
    } catch (err) {
      console.error(`[project-memory] agent-session validation failed for evidence ${evidence.id}:`, err);
    }
  }
  return rowToEvidence(db.prepare("SELECT * FROM project_evidence_items WHERE id = ?").get(id) as unknown as EvidenceRow);
}

export function listProjectEvidence(
  orgId: string,
  projectId: string,
  limit = 100,
): ProjectEvidenceItem[] | null {
  const project = loadProject(projectId, orgId);
  if (!project) return null;
  const eligibility = evidenceReadEligibilitySql(
    "e",
    sanitizeProjectResources(parseJson<ProjectResources>(project.resources_json, {})),
  );
  const rows = db
    .prepare(
      `SELECT e.* FROM project_evidence_items e
       WHERE e.org_id = ? AND e.project_id = ? AND ${eligibility.sql}
       ORDER BY e.occurred_at DESC
       LIMIT ?`,
    )
    .all(orgId, projectId, ...eligibility.params, limit) as unknown as EvidenceRow[];
  return rows.map(rowToEvidence);
}

export function listProjectMemoryCandidates(
  orgId: string,
  projectId: string,
  status?: ProjectMemoryCandidate["status"],
): ProjectMemoryCandidate[] | null {
  const project = loadProject(projectId, orgId);
  if (!project) return null;
  const eligibility = evidenceReadEligibilitySql(
    "e",
    sanitizeProjectResources(parseJson<ProjectResources>(project.resources_json, {})),
  );
  const rows = status
    ? db
        .prepare(
          `SELECT c.* FROM project_memory_candidates c
           JOIN project_evidence_items e ON e.id = c.evidence_item_id
           WHERE c.org_id = ? AND c.project_id = ? AND c.status = ? AND ${eligibility.sql}
           ORDER BY c.created_at DESC`,
        )
        .all(orgId, projectId, status, ...eligibility.params)
    : db
        .prepare(
          `SELECT c.* FROM project_memory_candidates c
           JOIN project_evidence_items e ON e.id = c.evidence_item_id
           WHERE c.org_id = ? AND c.project_id = ? AND ${eligibility.sql}
           ORDER BY c.created_at DESC`,
        )
        .all(orgId, projectId, ...eligibility.params);
  return (rows as unknown as CandidateRow[]).map(rowToCandidate);
}

export function getProjectCursor(
  orgId: string,
  projectId: string,
  source: ProjectEvidenceSource,
  cursorKey: string,
): string | null {
  const row = db
    .prepare(
      "SELECT cursor_value FROM project_ingestion_cursors WHERE org_id = ? AND project_id = ? AND source = ? AND cursor_key = ?",
    )
    .get(orgId, projectId, source, cursorKey) as { cursor_value: string } | undefined;
  return row?.cursor_value ?? null;
}

export function setProjectCursor(
  orgId: string,
  projectId: string,
  source: ProjectEvidenceSource,
  cursorKey: string,
  cursorValue: string,
): void {
  db.prepare(
    `INSERT INTO project_ingestion_cursors (org_id, project_id, source, cursor_key, cursor_value, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(org_id, project_id, source, cursor_key) DO UPDATE SET
       cursor_value = excluded.cursor_value,
       updated_at = excluded.updated_at`,
  ).run(orgId, projectId, source, cursorKey, cursorValue, new Date().toISOString());
}

function clearProjectCursor(
  orgId: string,
  projectId: string,
  source: ProjectEvidenceSource,
  cursorKey: string,
): void {
  db.prepare(
    "DELETE FROM project_ingestion_cursors WHERE org_id = ? AND project_id = ? AND source = ? AND cursor_key = ?",
  ).run(orgId, projectId, source, cursorKey);
}

async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    // Upstream bodies can contain echoed query text, credentials, or source
    // content. Operational paths retain only a bounded status code.
    throw new Error(`upstream_http_${res.status}`);
  }
  return res.json() as Promise<T>;
}

interface PersistedEvidenceIdentity {
  source_id: string;
  source_instance: string;
  native_id: string | null;
}

async function purgeMissingEvidenceIdentities(
  orgId: string,
  projectId: string,
  source: "github" | "jira",
  persisted: readonly PersistedEvidenceIdentity[],
  seenSourceIds: ReadonlySet<string>,
): Promise<number> {
  const missing = persisted.filter((row) => !seenSourceIds.has(row.source_id));
  if (missing.length === 0) return 0;
  const { purgeProjectEvidenceIdentity } = await import("./project-source-change.js");
  let deleted = 0;
  for (const row of missing) {
    deleted += purgeProjectEvidenceIdentity(
      orgId,
      projectId,
      source,
      row.source_instance,
      row.native_id ?? row.source_id,
    );
  }
  return deleted;
}

type CredentialState = ProjectSourceHealth["credential_state"];
type HealthProbeResult = { credentialState: CredentialState; message?: string };

async function fetchWithShortTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOURCE_HEALTH_PROBE_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function fetchFailureCode(err: unknown): string | undefined {
  if (err instanceof Error && err.name === "AbortError") return "ABORT_ERR";
  const cause = err instanceof Error
    ? (err as { cause?: { code?: string; message?: string } }).cause
    : undefined;
  return cause?.code;
}

function isNetworkOrTlsFailure(err: unknown): boolean {
  const code = fetchFailureCode(err);
  return !!code && [
    "ABORT_ERR",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ETIMEDOUT",
    "UND_ERR_CONNECT_TIMEOUT",
    "ECONNREFUSED",
    "ECONNRESET",
    "UND_ERR_SOCKET",
    "CERT_HAS_EXPIRED",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
  ].includes(code);
}

function failureMessage(prefix: string, err: unknown): string {
  const code = fetchFailureCode(err);
  const msg = err instanceof Error ? err.message : String(err);
  return code ? `${prefix}: ${msg} (${code})` : `${prefix}: ${msg}`;
}

function sinceDefault(days = 7): string {
  return new Date(Date.now() - days * 864e5).toISOString();
}

const GITHUB_RECONCILIATION_PAGE_SIZE = 100;
const MAX_GITHUB_RECONCILIATION_PAGES_PER_RUN = 5;

interface GithubReconciliationCursor {
  version: 1;
  resource_binding_version: string;
  next_page: number;
  seen_source_ids: string[];
}

function parseGithubReconciliationCursor(
  raw: string | null,
  resourceBindingVersion: string,
): GithubReconciliationCursor | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<GithubReconciliationCursor>;
    if (value.version !== 1
      || value.resource_binding_version !== resourceBindingVersion
      || typeof value.next_page !== "number"
      || !Number.isInteger(value.next_page)
      || value.next_page < 1
      || !Array.isArray(value.seen_source_ids)
      || value.seen_source_ids.length > 100_000
      || value.seen_source_ids.some((id) => typeof id !== "string")) return null;
    return value as GithubReconciliationCursor;
  } catch {
    return null;
  }
}

async function reconcileGithubRepo(
  project: ProjectRow,
  repo: string,
  headers: Record<string, string>,
  resourceBindingVersion: string,
): Promise<number> {
  const cursorKey = `repo:${repo}:reconciliation:v1`;
  const rawCursor = getProjectCursor(project.org_id, project.project_id, "github", cursorKey);
  const cursor = parseGithubReconciliationCursor(rawCursor, resourceBindingVersion);
  if (rawCursor && !cursor) clearProjectCursor(project.org_id, project.project_id, "github", cursorKey);

  let page = cursor?.next_page ?? 1;
  const seen = new Set(cursor?.seen_source_ids ?? []);
  let complete = false;
  for (let pages = 0; pages < MAX_GITHUB_RECONCILIATION_PAGES_PER_RUN; pages++) {
    const items = await fetchJson<Array<{ number?: number }>>(
      `https://api.github.com/repos/${repo}/issues?state=all&sort=created&direction=asc&per_page=${GITHUB_RECONCILIATION_PAGE_SIZE}&page=${page}`,
      { headers },
    );
    for (const item of items) {
      if (Number.isInteger(item.number) && Number(item.number) > 0) seen.add(`${repo}#${item.number}`);
    }
    page++;
    if (items.length < GITHUB_RECONCILIATION_PAGE_SIZE) {
      complete = true;
      break;
    }
  }

  if (!complete) {
    setProjectCursor(project.org_id, project.project_id, "github", cursorKey, JSON.stringify({
      version: 1,
      resource_binding_version: resourceBindingVersion,
      next_page: page,
      seen_source_ids: [...seen].sort(),
    } satisfies GithubReconciliationCursor));
    return 0;
  }

  const prefix = `${repo}#`;
  const persisted = db.prepare(
    `SELECT source_id, source_instance, native_id FROM project_evidence_items
     WHERE org_id = ? AND project_id = ? AND source = 'github'
       AND substr(source_id, 1, length(?)) = ?`,
  ).all(project.org_id, project.project_id, prefix, prefix) as unknown as PersistedEvidenceIdentity[];
  const deleted = await purgeMissingEvidenceIdentities(
    project.org_id,
    project.project_id,
    "github",
    persisted,
    seen,
  );
  clearProjectCursor(project.org_id, project.project_id, "github", cursorKey);
  return deleted;
}

async function pollGithub(project: ProjectRow, resources: ProjectResources): Promise<PollSourceResult> {
  const configuredRepos = resources.github?.repos ?? [];
  if (configuredRepos.length === 0) return { source: "github", ingested: 0 };
  if (!hasGithubProjectBinding(resources)) {
    return { source: "github", ingested: 0, missing: "github_project_binding_invalid" };
  }
  const repos = configuredGithubRepos(resources);
  const resourceBindingVersion = connectorBindingVersion(resources, "github");
  if (!resourceBindingVersion) {
    return { source: "github", ingested: 0, missing: "github_project_binding_invalid" };
  }
  const token = process.env.GH_TOKEN;
  if (!token) return { source: "github", ingested: 0, missing: "GH_TOKEN not set" };

  let ingested = 0;
  let deleted = 0;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  for (const repo of repos) {
    const cursorKey = `repo:${repo}`;
    const since = getProjectCursor(project.org_id, project.project_id, "github", cursorKey) ?? sinceDefault();
    let newest = since;

    type Pull = {
      number: number;
      title?: string;
      body?: string;
      html_url?: string;
      user?: { login?: string };
      updated_at?: string;
      merged_at?: string | null;
    };
    type Issue = {
      number: number;
      title?: string;
      body?: string;
      html_url?: string;
      user?: { login?: string };
      updated_at?: string;
      pull_request?: unknown;
      state?: string;
    };
    type Commit = {
      sha: string;
      html_url?: string;
      commit?: { message?: string; author?: { name?: string; date?: string } };
      author?: { login?: string };
    };

    const prs = await fetchJson<Pull[]>(
      `https://api.github.com/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=25`,
      { headers },
    );
    for (const pr of prs) {
      const updated = pr.updated_at ?? pr.merged_at ?? new Date().toISOString();
      if (updated <= since) continue;
      if (updated > newest) newest = updated;
      await recordProjectEvidence({
        org_id: project.org_id,
        project_id: project.project_id,
        source: "github",
        source_type: pr.merged_at ? "merged_pr" : "updated_pr",
        source_id: `${repo}#${pr.number}`,
        source_url: pr.html_url,
        source_title: `PR #${pr.number}: ${pr.title ?? ""}`.trim(),
        summary: pr.title ?? `Pull request #${pr.number}`,
        body: pr.body ?? "",
        author: pr.user?.login,
        occurred_at: pr.merged_at ?? updated,
        metadata: { repo, number: pr.number, resource_binding_version: resourceBindingVersion },
        confidence_score: pr.merged_at ? 0.9 : 0.65,
      });
      ingested++;
    }

    const issues = await fetchJson<Issue[]>(
      `https://api.github.com/repos/${repo}/issues?state=all&since=${encodeURIComponent(since)}&per_page=25`,
      { headers },
    );
    for (const issue of issues) {
      if (issue.pull_request) continue;
      const updated = issue.updated_at ?? new Date().toISOString();
      if (updated > newest) newest = updated;
      await recordProjectEvidence({
        org_id: project.org_id,
        project_id: project.project_id,
        source: "github",
        source_type: "issue",
        source_id: `${repo}#${issue.number}`,
        source_url: issue.html_url,
        source_title: `Issue #${issue.number}: ${issue.title ?? ""}`.trim(),
        summary: issue.title ?? `Issue #${issue.number}`,
        body: issue.body ?? "",
        author: issue.user?.login,
        occurred_at: updated,
        metadata: { repo, number: issue.number, state: issue.state, resource_binding_version: resourceBindingVersion },
        confidence_score: 0.6,
      });
      ingested++;
    }

    const branch = resources.github?.default_branches?.[repo];
    const branchParam = branch ? `&sha=${encodeURIComponent(branch)}` : "";
    const commits = await fetchJson<Commit[]>(
      `https://api.github.com/repos/${repo}/commits?since=${encodeURIComponent(since)}${branchParam}&per_page=25`,
      { headers },
    );
    for (const commit of commits) {
      const occurred = commit.commit?.author?.date ?? new Date().toISOString();
      if (occurred > newest) newest = occurred;
      const firstLine = (commit.commit?.message ?? commit.sha).split("\n")[0] ?? commit.sha;
      await recordProjectEvidence({
        org_id: project.org_id,
        project_id: project.project_id,
        source: "github",
        source_type: "default_branch_commit",
        source_id: `${repo}@${commit.sha}`,
        source_url: commit.html_url,
        source_title: `Commit ${commit.sha.slice(0, 7)}: ${firstLine}`,
        summary: firstLine,
        body: commit.commit?.message ?? "",
        author: commit.author?.login ?? commit.commit?.author?.name,
        occurred_at: occurred,
        metadata: { repo, sha: commit.sha, branch: branch ?? "default", resource_binding_version: resourceBindingVersion },
        confidence_score: 0.7,
      });
      ingested++;
    }

    if (newest > since) setProjectCursor(project.org_id, project.project_id, "github", cursorKey, newest);
    deleted += await reconcileGithubRepo(project, repo, headers, resourceBindingVersion);
  }

  return { source: "github", ingested, ...(deleted > 0 ? { deleted } : {}) };
}

function escapeJql(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function jiraScopeClauses(resources: ProjectResources): string[] {
  const clauses: string[] = [];
  const keys = resources.jira?.project_keys ?? [];
  if (keys.length > 0) clauses.push(`project in (${keys.map((k) => `"${escapeJql(k)}"`).join(", ")})`);
  if (resources.jira?.team) clauses.push(`"Team" = "${escapeJql(resources.jira.team)}"`);
  const components = resources.jira?.components ?? [];
  if (components.length > 0) {
    clauses.push(`component in (${components.map((c) => `"${escapeJql(c)}"`).join(", ")})`);
  }
  const epics = resources.jira?.epics ?? [];
  if (epics.length > 0) {
    const list = epics.map((k) => `"${escapeJql(k)}"`).join(", ");
    clauses.push(`("Epic Link" in (${list}) OR parent in (${list}))`);
  }
  const versions = resources.jira?.fix_versions ?? [];
  if (versions.length > 0) clauses.push(`fixVersion in (${versions.map((v) => `"${escapeJql(v)}"`).join(", ")})`);
  const issueKeys = resources.jira?.issue_keys ?? [];
  if (issueKeys.length > 0) clauses.push(`issuekey in (${issueKeys.map((k) => `"${escapeJql(k)}"`).join(", ")})`);
  return clauses;
}

function buildPollJql(resources: ProjectResources, since: string): string | null {
  const clauses = jiraScopeClauses(resources);
  if (clauses.length === 0) return null;
  clauses.push(`updated >= "${since.slice(0, 16).replace("T", " ")}"`);
  // Newest-first keeps polling focused on the latest tickets. When this window
  // is truncated by MAX_JIRA_ISSUES, pollJira deliberately does not advance the
  // cursor past older matching tickets it did not fetch.
  return `${clauses.join(" AND ")} ORDER BY updated DESC, key DESC`;
}

function buildJiraReconciliationJql(resources: ProjectResources): string | null {
  const clauses = jiraScopeClauses(resources);
  return clauses.length > 0 ? `${clauses.join(" AND ")} ORDER BY key ASC` : null;
}

function buildProbeJql(resources: ProjectResources): string | null {
  const issueKeys = resources.jira?.issue_keys ?? [];
  if (issueKeys.length > 0) {
    return `issuekey in (${issueKeys.map((k) => `"${escapeJql(k)}"`).join(", ")})`;
  }
  const keys = resources.jira?.project_keys ?? [];
  if (keys.length > 0) {
    return `project in (${keys.map((k) => `"${escapeJql(k)}"`).join(", ")})`;
  }
  if (resources.jira?.team) {
    return `"Team" = "${escapeJql(resources.jira.team)}"`;
  }
  const epics = resources.jira?.epics ?? [];
  if (epics.length > 0) {
    const list = epics.map((k) => `"${escapeJql(k)}"`).join(", ");
    return `("Epic Link" in (${list}) OR parent in (${list}))`;
  }
  const versions = resources.jira?.fix_versions ?? [];
  if (versions.length > 0) {
    return `fixVersion in (${versions.map((v) => `"${escapeJql(v)}"`).join(", ")})`;
  }
  return null;
}

async function probeGithubHealth(resources: ProjectResources): Promise<HealthProbeResult> {
  const repos = resources.github?.repos ?? [];
  if (repos.length === 0) return { credentialState: "not_configured" };
  if (!hasGithubProjectBinding(resources)) {
    return { credentialState: "misconfigured", message: "GitHub project binding is invalid" };
  }
  const token = process.env.GH_TOKEN;
  if (!token) return { credentialState: "missing_credentials", message: "GH_TOKEN not set" };

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  for (const repo of repos) {
    try {
      const res = await fetchWithShortTimeout(`https://api.github.com/repos/${repo}`, { headers });
      if (res.ok) continue;
      if (res.status === 401 || res.status === 403) {
        return { credentialState: "invalid_credentials", message: `GitHub ${res.status}` };
      }
      if (res.status === 404 || res.status === 422) {
        return { credentialState: "misconfigured", message: `GitHub repo "${repo}" probe failed: ${res.status}` };
      }
      if (res.status >= 500 || res.status === 429) {
        return { credentialState: "unreachable", message: `GitHub probe failed: ${res.status}` };
      }
      return { credentialState: "misconfigured", message: `GitHub repo "${repo}" probe failed: ${res.status}` };
    } catch (err) {
      return {
        credentialState: isNetworkOrTlsFailure(err) ? "unreachable" : "misconfigured",
        message: failureMessage(`GitHub repo "${repo}" probe failed`, err),
      };
    }
  }

  return { credentialState: "ok" };
}

async function probeJiraHealth(resources: ProjectResources): Promise<HealthProbeResult> {
  if (buildProbeJql(resources) && !hasJiraProjectBinding(resources)) {
    return { credentialState: "misconfigured", message: "Jira project binding is invalid" };
  }
  const base = process.env.JIRA_BASE_URL;
  const token = process.env.JIRA_TOKEN;
  const email = process.env.JIRA_EMAIL;
  const jql = buildProbeJql(resources);
  if (!jql) return { credentialState: "not_configured" };
  if (!base || !token) {
    return { credentialState: "missing_credentials", message: "JIRA_BASE_URL or JIRA_TOKEN not set" };
  }

  const isCloud = /atlassian\.net$/i.test(base) && !!email;
  const restPath = isCloud ? "rest/api/3/search" : "rest/api/2/search";
  const authHeader = isCloud
    ? "Basic " + Buffer.from(`${email}:${token}`).toString("base64")
    : `Bearer ${token}`;

  try {
    const res = await fetchWithShortTimeout(`${base.replace(/\/$/, "")}/${restPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
        Accept: "application/json",
      },
      body: JSON.stringify({
        jql,
        maxResults: 1,
        fields: ["summary"],
      }),
    });
    if (res.ok) return { credentialState: "ok" };

    if (res.status === 401 || res.status === 403) {
      return { credentialState: "invalid_credentials", message: `Jira ${res.status}` };
    }
    if (res.status === 400 || res.status === 404) {
      return { credentialState: "misconfigured", message: `Jira probe failed: ${res.status}` };
    }
    if (res.status >= 500 || res.status === 429) {
      return { credentialState: "unreachable", message: `Jira probe failed: ${res.status}` };
    }
    return { credentialState: "misconfigured", message: `Jira probe failed: ${res.status}` };
  } catch (err) {
    return {
      credentialState: isNetworkOrTlsFailure(err) ? "unreachable" : "misconfigured",
      message: failureMessage("Jira probe failed", err),
    };
  }
}

const MAX_JIRA_ISSUES = 500;
const MAX_JIRA_DESCRIPTION_WALK_NODES = 10_000;
const JIRA_ISSUE_PAGE_CURSOR = "issues:page:v1";
const JIRA_RECONCILIATION_CURSOR = "issues:reconciliation:v1";

interface JiraIssuePageCursor {
  version: 1;
  resource_binding_version: string;
  since: string;
  start_at: number;
  newest: string;
}

interface JiraReconciliationCursor {
  version: 1;
  resource_binding_version: string;
  start_at: number;
  seen_issue_keys: string[];
}

function parseJiraIssuePageCursor(
  raw: string | null,
  resourceBindingVersion: string,
): JiraIssuePageCursor | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<JiraIssuePageCursor>;
    if (value.version !== 1
      || value.resource_binding_version !== resourceBindingVersion
      || typeof value.since !== "string"
      || !Number.isFinite(Date.parse(value.since))
      || typeof value.newest !== "string"
      || typeof value.start_at !== "number"
      || !Number.isInteger(value.start_at)
      || value.start_at < 0) return null;
    return value as JiraIssuePageCursor;
  } catch {
    return null;
  }
}

function parseJiraReconciliationCursor(
  raw: string | null,
  resourceBindingVersion: string,
): JiraReconciliationCursor | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<JiraReconciliationCursor>;
    if (value.version !== 1
      || value.resource_binding_version !== resourceBindingVersion
      || typeof value.start_at !== "number"
      || !Number.isInteger(value.start_at)
      || value.start_at < 0
      || !Array.isArray(value.seen_issue_keys)
      || value.seen_issue_keys.length > 100_000
      || value.seen_issue_keys.some((key) => typeof key !== "string")) return null;
    return value as JiraReconciliationCursor;
  } catch {
    return null;
  }
}

interface JiraFields {
  summary?: string;
  description?: unknown;
  updated?: string;
  created?: string;
  duedate?: string | null;
  resolutiondate?: string | null;
  resolution?: { name?: string } | null;
  status?: { name?: string; statusCategory?: { key?: string; name?: string } };
  priority?: { name?: string };
  issuetype?: { name?: string };
  creator?: { displayName?: string; emailAddress?: string };
  assignee?: { displayName?: string; emailAddress?: string };
  reporter?: { displayName?: string; emailAddress?: string };
  fixVersions?: Array<{ name?: string; released?: boolean }>;
  components?: Array<{ name?: string }>;
  labels?: string[];
  parent?: { key?: string; fields?: { summary?: string } };
}

const JIRA_FIELDS = [
  "summary", "description", "status", "priority", "issuetype", "labels", "components",
  "updated", "created", "duedate", "creator", "assignee", "reporter", "resolution",
  "resolutiondate", "fixVersions", "parent",
];

/** Flattens a Jira description (plain string or Atlassian Document Format) to readable text. */
function jiraDescriptionToText(d: unknown): string {
  if (typeof d === "string") return d;
  if (!d || typeof d !== "object") return "";
  const parts: string[] = [];
  const seen = new WeakSet<object>();
  const stack: unknown[] = [d];
  let visited = 0;
  while (stack.length > 0 && visited < MAX_JIRA_DESCRIPTION_WALK_NODES) {
    const n = stack.pop();
    visited++;
    if (!n) continue;
    if (typeof n === "string") { parts.push(n); continue; }
    if (typeof n !== "object") continue;
    if (seen.has(n)) continue;
    seen.add(n);
    if (Array.isArray(n)) {
      for (let i = n.length - 1; i >= 0; i--) stack.push(n[i]);
      continue;
    }
    const node = n as { text?: string; content?: unknown };
    if (typeof node.text === "string") parts.push(node.text);
    if (node.content) stack.push(node.content);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** Maps Jira status category to a working-memory source_type + confidence. */
function jiraIssueType(f: JiraFields): { type: string; resolved: boolean; confidence: number } {
  const cat = f.status?.statusCategory?.key;
  const resolved = !!f.resolutiondate || cat === "done";
  if (resolved) return { type: "resolved_issue", resolved: true, confidence: 0.9 };
  if (cat === "indeterminate") return { type: "active_issue", resolved: false, confidence: 0.75 };
  return { type: "backlog_issue", resolved: false, confidence: 0.6 };
}

/** Renders a human-readable ticket body — readable by both PMs and engineers. */
function renderJiraBody(key: string, f: JiraFields): string {
  const comps = (f.components ?? []).map((c) => c.name).filter(Boolean);
  const fixv = (f.fixVersions ?? []).map((v) => v.name).filter(Boolean);
  const lines: string[] = [
    `${f.issuetype?.name ?? "Issue"} ${key}: ${f.summary ?? ""}`.trim(),
    `Status: ${f.status?.name ?? "?"}${f.status?.statusCategory?.name ? ` (${f.status.statusCategory.name})` : ""}`
      + `${f.priority?.name ? ` · Priority: ${f.priority.name}` : ""}`
      + ` · ${f.assignee?.displayName ? `Assignee: ${f.assignee.displayName}` : "Unassigned"}`,
  ];
  if (comps.length) lines.push(`Components: ${comps.join(", ")}`);
  if (fixv.length) lines.push(`Fix version(s): ${fixv.join(", ")}`);
  if (f.labels?.length) lines.push(`Labels: ${f.labels.join(", ")}`);
  if (f.parent?.key) lines.push(`Parent: ${f.parent.key}${f.parent.fields?.summary ? ` — ${f.parent.fields.summary}` : ""}`);
  if (f.resolution?.name) lines.push(`Resolution: ${f.resolution.name}`);
  if (f.duedate) lines.push(`Due: ${f.duedate}`);
  const desc = jiraDescriptionToText(f.description);
  if (desc) lines.push("", desc);
  return lines.join("\n");
}

function jiraAuth(base: string, token: string, email?: string): { restPath: string; apiBasePath: string; authHeader: string } {
  const isCloud = /atlassian\.net$/i.test(base) && !!email;
  const apiBasePath = isCloud ? "rest/api/3" : "rest/api/2";
  return {
    restPath: `${apiBasePath}/search`,
    apiBasePath,
    authHeader: isCloud ? "Basic " + Buffer.from(`${email}:${token}`).toString("base64") : `Bearer ${token}`,
  };
}

function jiraDateToStartOfDay(date: string | undefined): string | undefined {
  return date ? `${date}T00:00:00.000Z` : undefined;
}

async function pollJira(project: ProjectRow, resources: ProjectResources): Promise<PollSourceResult> {
  const base = process.env.JIRA_BASE_URL;
  const token = process.env.JIRA_TOKEN;
  const email = process.env.JIRA_EMAIL;
  if (!base || !token) return { source: "jira", ingested: 0, missing: "JIRA_BASE_URL or JIRA_TOKEN not set" };

  const cursorKey = "issues";
  const lookbackDays = resources.jira?.lookback_days ?? 90;
  const windowSince = new Date(Date.now() - lookbackDays * 864e5).toISOString();
  const resourceBindingVersion = connectorBindingVersion(resources, "jira");
  if (!resourceBindingVersion) {
    return { source: "jira", ingested: 0, missing: "jira_project_binding_invalid" };
  }
  const pageCursorRaw = getProjectCursor(project.org_id, project.project_id, "jira", JIRA_ISSUE_PAGE_CURSOR);
  const pageCursor = parseJiraIssuePageCursor(pageCursorRaw, resourceBindingVersion);
  if (pageCursorRaw && !pageCursor) {
    clearProjectCursor(project.org_id, project.project_id, "jira", JIRA_ISSUE_PAGE_CURSOR);
  }
  const cursor = getProjectCursor(project.org_id, project.project_id, "jira", cursorKey);
  // Floor the lookback at the configured window so we never re-pull ancient history.
  const since = pageCursor?.since ?? (cursor && cursor > windowSince ? cursor : windowSince);
  const jql = buildPollJql(resources, since);
  if (!jql) return { source: "jira", ingested: 0 };

  const { restPath, authHeader } = jiraAuth(base, token, email);
  const url = `${base.replace(/\/$/, "")}/${restPath}`;
  const headers = { "Content-Type": "application/json", Authorization: authHeader, Accept: "application/json" };

  let ingested = 0;
  let newest = pageCursor?.newest ?? since;
  let startAt = pageCursor?.start_at ?? 0;
  let processedThisRun = 0;
  let total = Infinity;
  // Paginate so the full backlog (not just the first page) is ingested. The
  // durable page cursor makes the per-run safety cap progressive: a 501st
  // issue is fetched on the next run instead of the newest 500 repeating
  // forever while the timestamp high-water mark remains intentionally fixed.
  while (startAt < total && processedThisRun < MAX_JIRA_ISSUES) {
    const maxResults = Math.min(50, MAX_JIRA_ISSUES - processedThisRun);
    const data = await fetchJson<{ issues?: Array<{ key: string; fields?: JiraFields }>; total?: number }>(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jql, startAt, maxResults, fields: JIRA_FIELDS }),
    });
    total = data.total ?? (data.issues?.length ?? 0);
    const issues = data.issues ?? [];
    if (issues.length === 0) break;
    for (const issue of issues) {
      const f = issue.fields ?? {};
      const updated = f.updated ?? new Date().toISOString();
      if (updated > newest) newest = updated;
      const { type, resolved, confidence } = jiraIssueType(f);
      await recordProjectEvidence({
        org_id: project.org_id,
        project_id: project.project_id,
        source: "jira",
        source_type: type,
        source_id: issue.key,
        source_url: `${base.replace(/\/$/, "")}/browse/${issue.key}`,
        source_title: `${issue.key}: ${f.summary ?? ""}`,
        summary: f.summary ?? issue.key,
        body: renderJiraBody(issue.key, f),
        author: f.assignee?.displayName ?? f.creator?.displayName ?? f.creator?.emailAddress,
        occurred_at: resolved ? (f.resolutiondate ?? updated) : updated,
        metadata: {
          resource_binding_version: resourceBindingVersion,
          key: issue.key,
          status: f.status?.name,
          status_category: f.status?.statusCategory?.name,
          issue_type: f.issuetype?.name,
          priority: f.priority?.name,
          assignee: f.assignee?.displayName ?? f.assignee?.emailAddress,
          reporter: f.reporter?.displayName ?? f.reporter?.emailAddress,
          components: (f.components ?? []).map((c) => c.name).filter(Boolean),
          labels: f.labels ?? [],
          fix_versions: (f.fixVersions ?? []).map((v) => v.name).filter(Boolean),
          parent: f.parent?.key,
          parent_summary: f.parent?.fields?.summary,
          due_date: f.duedate ?? undefined,
          resolved,
        },
        confidence_score: confidence,
      });
      ingested++;
    }
    startAt += issues.length;
    processedThisRun += issues.length;
    if (startAt < total) {
      setProjectCursor(
        project.org_id,
        project.project_id,
        "jira",
        JIRA_ISSUE_PAGE_CURSOR,
        JSON.stringify({
          version: 1,
          resource_binding_version: resourceBindingVersion,
          since,
          start_at: startAt,
          newest,
        } satisfies JiraIssuePageCursor),
      );
    }
  }
  const truncatedByCap = startAt < total;
  if (!truncatedByCap) {
    clearProjectCursor(project.org_id, project.project_id, "jira", JIRA_ISSUE_PAGE_CURSOR);
    if (newest > since) setProjectCursor(project.org_id, project.project_id, "jira", cursorKey, newest);
  }
  return { source: "jira", ingested };
}

async function reconcileJiraIssues(project: ProjectRow, resources: ProjectResources): Promise<PollSourceResult> {
  const base = process.env.JIRA_BASE_URL;
  const token = process.env.JIRA_TOKEN;
  const email = process.env.JIRA_EMAIL;
  const jql = buildJiraReconciliationJql(resources);
  if (!jql) return { source: "jira", ingested: 0 };
  if (!base || !token) {
    return { source: "jira", ingested: 0, missing: "JIRA_BASE_URL or JIRA_TOKEN not set" };
  }
  const resourceBindingVersion = connectorBindingVersion(resources, "jira");
  if (!resourceBindingVersion) {
    return { source: "jira", ingested: 0, missing: "jira_project_binding_invalid" };
  }

  const rawCursor = getProjectCursor(project.org_id, project.project_id, "jira", JIRA_RECONCILIATION_CURSOR);
  const cursor = parseJiraReconciliationCursor(rawCursor, resourceBindingVersion);
  if (rawCursor && !cursor) {
    clearProjectCursor(project.org_id, project.project_id, "jira", JIRA_RECONCILIATION_CURSOR);
  }
  let startAt = cursor?.start_at ?? 0;
  const seen = new Set(cursor?.seen_issue_keys ?? []);
  let processedThisRun = 0;
  let total = Infinity;

  const { restPath, authHeader } = jiraAuth(base, token, email);
  const url = `${base.replace(/\/$/, "")}/${restPath}`;
  const headers = { "Content-Type": "application/json", Authorization: authHeader, Accept: "application/json" };
  while (startAt < total && processedThisRun < MAX_JIRA_ISSUES) {
    const maxResults = Math.min(50, MAX_JIRA_ISSUES - processedThisRun);
    const data = await fetchJson<{ issues?: Array<{ key: string }>; total?: number }>(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jql, startAt, maxResults, fields: ["key"] }),
    });
    total = data.total ?? (data.issues?.length ?? 0);
    const issues = data.issues ?? [];
    if (issues.length === 0) break;
    for (const issue of issues) {
      if (issue.key) seen.add(issue.key.toUpperCase());
    }
    startAt += issues.length;
    processedThisRun += issues.length;
  }

  if (startAt < total) {
    setProjectCursor(project.org_id, project.project_id, "jira", JIRA_RECONCILIATION_CURSOR, JSON.stringify({
      version: 1,
      resource_binding_version: resourceBindingVersion,
      start_at: Math.max(0, startAt - 50),
      seen_issue_keys: [...seen].sort(),
    } satisfies JiraReconciliationCursor));
    return { source: "jira", ingested: 0 };
  }

  const persisted = db.prepare(
    `SELECT source_id, source_instance, native_id FROM project_evidence_items
     WHERE org_id = ? AND project_id = ? AND source = 'jira' AND source_type != 'release'`,
  ).all(project.org_id, project.project_id) as unknown as PersistedEvidenceIdentity[];
  const deleted = await purgeMissingEvidenceIdentities(
    project.org_id,
    project.project_id,
    "jira",
    persisted,
    seen,
  );
  clearProjectCursor(project.org_id, project.project_id, "jira", JIRA_RECONCILIATION_CURSOR);
  return { source: "jira", ingested: 0, ...(deleted > 0 ? { deleted } : {}) };
}

interface JiraVersion {
  name?: string;
  description?: string;
  released?: boolean;
  archived?: boolean;
  overdue?: boolean;
  releaseDate?: string;
  startDate?: string;
}

/** Ingests Jira releases (versions) so "what's shipping next / what shipped" is answerable. */
async function pollJiraReleases(project: ProjectRow, resources: ProjectResources): Promise<PollSourceResult> {
  const base = process.env.JIRA_BASE_URL;
  const token = process.env.JIRA_TOKEN;
  const email = process.env.JIRA_EMAIL;
  const prefixes = resources.jira?.version_prefixes ?? [];
  const keys = resources.jira?.project_keys ?? [];
  if (prefixes.length === 0 || keys.length === 0) return { source: "jira", ingested: 0 };
  if (!base || !token) return { source: "jira", ingested: 0, missing: "JIRA_BASE_URL or JIRA_TOKEN not set" };
  const resourceBindingVersion = connectorBindingVersion(resources, "jira");

  const { apiBasePath, authHeader } = jiraAuth(base, token, email);
  const headers = { Authorization: authHeader, Accept: "application/json" };
  const matchesPrefix = (name: string) => prefixes.some((p) => name.toLowerCase().startsWith(p.toLowerCase()));

  let ingested = 0;
  for (const key of keys) {
    let versions: JiraVersion[];
    try {
      versions = await fetchJson<JiraVersion[]>(
        `${base.replace(/\/$/, "")}/${apiBasePath}/project/${encodeURIComponent(key)}/versions`,
        { headers },
      );
    } catch {
      continue; // project may not expose versions; skip quietly
    }
    for (const v of versions) {
      const name = v.name ?? "";
      if (!name || v.archived || !matchesPrefix(name)) continue;
      const status = v.released ? "Released" : "Upcoming";
      const bodyLines = [`Release ${name} (${key}) — ${status}`];
      if (v.releaseDate) bodyLines.push(`Release date: ${v.releaseDate}`);
      if (v.startDate) bodyLines.push(`Start date: ${v.startDate}`);
      if (!v.released && v.overdue) bodyLines.push("This upcoming release is overdue.");
      if (v.description) bodyLines.push("", v.description);
      const occurredAt = jiraDateToStartOfDay(v.releaseDate ?? v.startDate);
      await recordProjectEvidence({
        org_id: project.org_id,
        project_id: project.project_id,
        source: "jira",
        source_type: "release",
        source_id: `release:${key}:${name}`,
        source_url: `${base.replace(/\/$/, "")}/projects/${encodeURIComponent(key)}/versions`,
        source_title: `Release ${name} — ${status}`,
        summary: `${name} (${status}${v.releaseDate ? `, ${v.releaseDate}` : ""})`,
        body: bodyLines.join("\n"),
        ...(occurredAt ? { occurred_at: occurredAt } : {}),
        metadata: {
          resource_binding_version: resourceBindingVersion,
          name,
          project_key: key,
          status,
          released: !!v.released,
          release_date: v.releaseDate,
          overdue: !!v.overdue,
        },
        confidence_score: 0.7,
        promotable: false,
      });
      ingested++;
    }
  }
  return { source: "jira", ingested };
}

async function pollJiraResources(project: ProjectRow, resources: ProjectResources): Promise<PollSourceResult> {
  if (buildPollJql(resources, new Date(0).toISOString()) && !hasJiraProjectBinding(resources)) {
    return { source: "jira", ingested: 0, missing: "jira_project_binding_invalid" };
  }
  const parts: Array<[string, () => Promise<PollSourceResult>]> = [
    ["issues", () => pollJira(project, resources)],
    ["releases", () => pollJiraReleases(project, resources)],
    ["reconciliation", () => reconcileJiraIssues(project, resources)],
  ];
  let ingested = 0;
  let deleted = 0;
  let failed = false;
  for (const [, poller] of parts) {
    try {
      const result = await poller();
      ingested += result.ingested;
      deleted += result.deleted ?? 0;
      if (result.missing) failed = true;
    } catch {
      // Keep connector diagnostics out of poll responses. Upstream error
      // strings can contain echoed query text or other source content.
      failed = true;
    }
  }
  return {
    source: "jira",
    ingested,
    ...(deleted > 0 ? { deleted } : {}),
    ...(failed ? { missing: "jira_source_poll_failed" } : {}),
  };
}

export async function pollProjectSources(orgId: string, projectId: string): Promise<ProjectPollResult | null> {
  const project = loadProject(projectId, orgId);
  if (!project) return null;
  const resources = sanitizeProjectResources(parseJson<ProjectResources>(project.resources_json, {}));
  const results: PollSourceResult[] = [];

  const pollers: Array<[ProjectEvidenceSource, () => Promise<PollSourceResult>]> = [
    ["github", () => pollGithub(project, resources)],
    ["jira", () => pollJiraResources(project, resources)],
    ["slack", async () => {
      if ((resources.slack?.channels?.length ?? 0) === 0 && (resources.slack?.thread_urls?.length ?? 0) > 0) {
        return {
          source: "slack",
          ingested: 0,
          missing: "slack_thread_urls_require_an_explicit_public_channel_binding",
        };
      }
      if ((resources.slack?.channels?.length ?? 0) > 0 && !enabledFlag("PROJECT_SLACK_INGESTION_ENABLED")) {
        return { source: "slack", ingested: 0, missing: "slack_ingestion_disabled" };
      }
      return syncSlackProjectSource(project.org_id, project.project_id, resources);
    }],
    ["confluence", () => {
      const configured = (resources.confluence?.space_keys?.length ?? 0)
        + (resources.confluence?.page_ids?.length ?? 0)
        + (resources.confluence?.page_urls?.length ?? 0);
      if (configured > 0 && !enabledFlag("PROJECT_CONFLUENCE_INGESTION_ENABLED")) {
        return Promise.resolve({ source: "confluence" as const, ingested: 0, missing: "confluence_ingestion_disabled" });
      }
      return syncConfluenceProjectSource(project.org_id, project.project_id, resources);
    }],
  ];
  for (const [source, poller] of pollers) {
    try {
      results.push(await poller());
    } catch {
      results.push({ source, ingested: 0, missing: `${source}_source_poll_failed` });
    }
  }

  // Connector I/O runs outside the resource-update transaction. If a binding
  // changed while a slow poll was in flight, discard everything produced under
  // that obsolete boundary before any caller can rely on the refresh result.
  const current = loadProject(projectId, orgId);
  if (current) {
    const currentResources = sanitizeProjectResources(parseJson<ProjectResources>(current.resources_json, {}));
    const changed = changedConnectorSources(resources, currentResources)
      .filter((source): source is Exclude<ProjectSourceHealth["source"], "git"> => source !== "git");
    if (changed.length > 0) {
      const { purgeProjectEvidenceSource } = await import("./project-source-change.js");
      for (const source of changed) {
        purgeProjectEvidenceSource(orgId, projectId, source);
        const index = results.findIndex((result) => result.source === source);
        const stale: PollSourceResult = {
          source,
          ingested: 0,
          missing: "source_binding_changed_during_poll",
        };
        if (index >= 0) results[index] = stale;
        else results.push(stale);
      }
    }
  }

  return { results, health: getProjectSourceHealth(orgId, projectId) ?? [] };
}

export function getProjectSourceHealth(orgId: string, projectId: string): ProjectSourceHealth[] | null {
  const project = loadProject(projectId, orgId);
  if (!project) return null;
  const resources = sanitizeProjectResources(parseJson<ProjectResources>(project.resources_json, {}));
  const rows = db
    .prepare(
      `SELECT source, COUNT(*) AS count, MAX(ingested_at) AS last_ingested_at
       FROM project_evidence_items
       WHERE org_id = ? AND project_id = ?
       GROUP BY source`,
    )
    .all(orgId, projectId) as Array<{ source: string; count: number; last_ingested_at: string | null }>;
  const evidenceBySource = new Map(rows.map((r) => [r.source, r]));
  const cursorRows = db
    .prepare(
      `SELECT source, COUNT(*) AS count
       FROM project_ingestion_cursors
       WHERE org_id = ? AND project_id = ?
       GROUP BY source`,
    )
    .all(orgId, projectId) as Array<{ source: string; count: number }>;
  const cursorBySource = new Map(cursorRows.map((r) => [r.source, r.count]));
  const slackCursorWatermarks: Record<string, string> = {};
  const slackCursorRow = db.prepare(
    `SELECT cursor_value FROM project_ingestion_cursors
     WHERE org_id = ? AND project_id = ? AND source = 'slack' AND cursor_key = 'poll_state:v1'`,
  ).get(orgId, projectId) as { cursor_value: string } | undefined;
  if (slackCursorRow) {
    const state = parseJson<{ channels?: Record<string, { watermark?: unknown }> }>(slackCursorRow.cursor_value, {});
    for (const [binding, channel] of Object.entries(state.channels ?? {})) {
      if (typeof channel.watermark === "string" && channel.watermark) {
        slackCursorWatermarks[binding] = channel.watermark;
      }
    }
  }
  const syncRows = db
    .prepare(
      `SELECT source, source_instance, last_attempt_at, last_success_at, last_reconciliation_at,
              lag_seconds, indexed_count, retry_count, last_error_code
       FROM project_source_sync_state
       WHERE org_id = ? AND project_id = ?`,
    )
    .all(orgId, projectId) as unknown as Array<{
      source: string;
      source_instance: string;
      last_attempt_at: string | null;
      last_success_at: string | null;
      last_reconciliation_at: string | null;
      lag_seconds: number | null;
      indexed_count: number;
      retry_count: number;
      last_error_code: string | null;
    }>;
  const syncBySource = new Map<string, typeof syncRows>();
  for (const row of syncRows) {
    const values = syncBySource.get(row.source) ?? [];
    values.push(row);
    syncBySource.set(row.source, values);
  }

  const newest = (values: Array<string | null>): string | undefined =>
    values.filter((value): value is string => !!value).sort().at(-1);

  function health(
    source: ProjectSourceHealth["source"],
    configuredItems: number,
    credentialState: ProjectSourceHealth["credential_state"],
    message?: string,
  ): ProjectSourceHealth {
    const evidence = evidenceBySource.get(source);
    const sync = syncBySource.get(source) ?? [];
    const configured = configuredItems > 0;
    const lastAttempt = newest(sync.map((row) => row.last_attempt_at));
    const latestError = [...sync]
      .filter((row) => row.last_error_code)
      .sort((a, b) => (b.last_attempt_at ?? "").localeCompare(a.last_attempt_at ?? ""))[0];
    const errorCode = latestError?.last_error_code;
    let operationalCredentialState = credentialState;
    if (source === "slack" && errorCode) {
      operationalCredentialState = errorCode === "slack_invalid_credentials"
        ? "invalid_credentials"
        : errorCode === "slack_error"
          ? "unreachable"
          : errorCode === "slack_not_public" || errorCode === "slack_not_member"
            ? "misconfigured"
            : operationalCredentialState;
    } else if (source === "confluence" && errorCode) {
      operationalCredentialState = /(?:http_401|credentials_missing_or_invalid)/.test(errorCode)
        ? "invalid_credentials"
        : /(?:fetch_failed|http_5\d\d|poll_failed|sync_failed)/.test(errorCode)
          ? "unreachable"
          : /(?:http_403|visibility_policy_missing)/.test(errorCode)
            ? "misconfigured"
            : operationalCredentialState;
    }
    const lagValues = sync.map((row) => row.lag_seconds).filter((value): value is number => value !== null);
    return {
      source,
      configured,
      credential_state: configured ? operationalCredentialState : "not_configured",
      configured_items: configuredItems,
      ...(evidence?.last_ingested_at ? { last_ingested_at: evidence.last_ingested_at } : {}),
      cursor_count: cursorBySource.get(source) ?? 0,
      ...(source === "slack" && Object.keys(slackCursorWatermarks).length > 0
        ? { cursor_watermarks: slackCursorWatermarks }
        : {}),
      ...(sync.length === 1 ? { source_instance: sync[0].source_instance } : {}),
      ...(lastAttempt ? { last_attempt_at: lastAttempt } : {}),
      ...(newest(sync.map((row) => row.last_success_at))
        ? { last_success_at: newest(sync.map((row) => row.last_success_at)) }
        : {}),
      ...(newest(sync.map((row) => row.last_reconciliation_at))
        ? { last_reconciliation_at: newest(sync.map((row) => row.last_reconciliation_at)) }
        : {}),
      ...(lagValues.length > 0 ? { lag_seconds: Math.max(...lagValues) } : {}),
      indexed_count: sync.length > 0
        ? sync.reduce((sum, row) => sum + row.indexed_count, 0)
        : (evidence?.count ?? 0),
      retry_count: sync.reduce((sum, row) => sum + row.retry_count, 0),
      ...(latestError?.last_error_code ? { last_error_code: latestError.last_error_code } : {}),
      ...(configured && (message ?? latestError?.last_error_code)
        ? { message: message ?? latestError!.last_error_code! }
        : {}),
    };
  }

  const slackCredentialConfigured = [
    "SLACK_INGEST_BOT_TOKEN",
    "SLACK_BOT_TOKEN",
    "SLACK_INGEST_BOT_TOKEN_MWP",
    "SLACK_BOT_TOKEN_MWP",
    "SLACK_INGEST_BOT_TOKEN_AEM_ENG",
    "SLACK_BOT_TOKEN_AEM_ENG",
    "SLACK_INGEST_BOT_TOKEN_ADOBEDOTCOM",
    "SLACK_BOT_TOKEN_ADOBEDOTCOM",
  ].some((key) => !!process.env[key]);
  const githubCredentialConfigured = !!process.env.GH_TOKEN;
  const githubVisibilityConfigured = hasGithubProjectBinding(resources);
  const githubCredentialState: ProjectSourceHealth["credential_state"] = !githubCredentialConfigured
    ? "missing_credentials"
    : !githubVisibilityConfigured
      ? "misconfigured"
      : "ok";
  const jiraCredentialConfigured = !!process.env.JIRA_BASE_URL && !!process.env.JIRA_TOKEN;
  const jiraVisibilityConfigured = hasJiraProjectBinding(resources);
  const jiraCredentialState: ProjectSourceHealth["credential_state"] = !jiraCredentialConfigured
    ? "missing_credentials"
    : !jiraVisibilityConfigured
      ? "misconfigured"
      : "ok";
  const slackIngestionEnabled = enabledFlag("PROJECT_SLACK_INGESTION_ENABLED");
  const confluenceCredentialConfigured = !!process.env.CONFLUENCE_BASE_URL && !!process.env.CONFLUENCE_TOKEN;
  const confluenceVisibilityConfigured = hasConfluenceProjectVisibilityPolicy();
  const confluenceIngestionEnabled = enabledFlag("PROJECT_CONFLUENCE_INGESTION_ENABLED");
  const confluenceCredentialState: ProjectSourceHealth["credential_state"] = !confluenceIngestionEnabled
    ? "misconfigured"
    : !confluenceCredentialConfigured
    ? "missing_credentials"
    : !confluenceVisibilityConfigured
      ? "misconfigured"
      : "ok";

  return [
    health(
      "github",
      resources.github?.repos?.length ?? 0,
      githubCredentialState,
      !githubCredentialConfigured
        ? "GH_TOKEN not set"
        : !githubVisibilityConfigured
          ? "GitHub project binding is invalid"
          : undefined,
    ),
    health(
      "jira",
      (resources.jira?.project_keys?.length ?? 0) +
        (resources.jira?.epics?.length ?? 0) +
        (resources.jira?.issue_keys?.length ?? 0) +
        (resources.jira?.fix_versions?.length ?? 0) +
        (resources.jira?.team ? 1 : 0),
      jiraCredentialState,
      !jiraCredentialConfigured
        ? "JIRA_BASE_URL or JIRA_TOKEN not set"
        : !jiraVisibilityConfigured
          ? "Jira project binding is invalid"
          : undefined,
    ),
    health(
      "slack",
      (resources.slack?.channels?.length ?? 0) + (resources.slack?.thread_urls?.length ?? 0),
      !slackIngestionEnabled ? "misconfigured" : slackCredentialConfigured ? "ok" : "missing_credentials",
      !slackIngestionEnabled
        ? "Slack ingestion is disabled"
        : slackCredentialConfigured ? undefined : "Slack ingestion bot token not set",
    ),
    health(
      "confluence",
      (resources.confluence?.space_keys?.length ?? 0) + (resources.confluence?.page_urls?.length ?? 0) + (resources.confluence?.page_ids?.length ?? 0),
      confluenceCredentialState,
      !confluenceIngestionEnabled
        ? "Confluence ingestion is disabled"
        : !confluenceCredentialConfigured
        ? "CONFLUENCE_BASE_URL or CONFLUENCE_TOKEN not set"
        : !confluenceVisibilityConfigured
          ? "Confluence project visibility policy not configured"
          : undefined,
    ),
    health("git", resources.git?.repo_paths?.length ?? 0, "not_required"),
  ];
}

export async function getProjectSourceHealthLive(orgId: string, projectId: string): Promise<ProjectSourceHealth[] | null> {
  const project = loadProject(projectId, orgId);
  if (!project) return null;
  const resources = sanitizeProjectResources(parseJson<ProjectResources>(project.resources_json, {}));
  const snapshot = getProjectSourceHealth(orgId, projectId);
  if (!snapshot) return null;

  const [githubProbe, jiraProbe] = await Promise.all([
    probeGithubHealth(resources),
    probeJiraHealth(resources),
  ]);

  return snapshot.map((entry) => {
    const probe = entry.source === "github"
      ? githubProbe
      : entry.source === "jira"
        ? jiraProbe
        : null;
    if (!probe || !entry.configured) return entry;
    const next: ProjectSourceHealth = {
      ...entry,
      credential_state: probe.credentialState,
    };
    if (probe.message) next.message = probe.message;
    else delete next.message;
    return next;
  });
}
