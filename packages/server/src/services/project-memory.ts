import crypto from "node:crypto";
import db from "../db/connection.js";
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

const AUTO_PROMOTE_CONFIDENCE_MIN = 0.85;
const SOURCE_HEALTH_PROBE_TIMEOUT_MS = 5_000;

type JsonRecord = Record<string, unknown>;

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
}

export interface PollSourceResult {
  source: ProjectEvidenceSource;
  ingested: number;
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
  const row = db
    .prepare("SELECT * FROM project_evidence_items WHERE id = ? AND org_id = ? AND project_id = ?")
    .get(evidenceId, orgId, projectId) as unknown as EvidenceRow | undefined;
  return row ? rowToEvidence(row) : null;
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
  const project = loadProject(projectId, orgId);
  if (!project) return null;

  const row = getCandidateRow(orgId, projectId, candidateId);
  if (!row) return null;
  const candidate = rowToCandidate(row);
  if (candidate.status === "promoted") return candidate;

  const evidence = getEvidenceById(orgId, projectId, candidate.evidence_item_id);
  if (!evidence) return null;

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

  const existing = db
    .prepare(
      `SELECT id FROM project_evidence_items
       WHERE org_id = ? AND project_id = ? AND source = ? AND source_id = ?`,
    )
    .get(input.org_id, input.project_id, input.source, input.source_id) as { id: string } | undefined;

  const id = existing?.id ?? `pei-${crypto.randomUUID().slice(0, 8)}`;
  const occurredAt = input.occurred_at ?? new Date().toISOString();
  const ingestedAt = new Date().toISOString();
  const strongSource =
    (input.source === "github" && input.source_type === "merged_pr") ||
    (input.source === "jira" && input.source_type === "resolved_issue");
  const promotable = input.promotable ?? (strongSource && input.confidence_score >= AUTO_PROMOTE_CONFIDENCE_MIN);

  db.prepare(
    `INSERT INTO project_evidence_items
       (id, org_id, project_id, source, source_type, source_id, source_url, source_title, summary, body,
        author, occurred_at, ingested_at, metadata_json, confidence_score, promotable)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
       promotable = excluded.promotable`,
  ).run(
    id,
    input.org_id,
    input.project_id,
    input.source,
    input.source_type,
    input.source_id,
    input.source_url ?? null,
    input.source_title,
    input.summary,
    input.body,
    input.author ?? null,
    occurredAt,
    ingestedAt,
    JSON.stringify(input.metadata ?? {}),
    input.confidence_score,
    promotable ? 1 : 0,
  );

  const row = db.prepare("SELECT * FROM project_evidence_items WHERE id = ?").get(id) as unknown as EvidenceRow;
  const evidence = rowToEvidence(row);
  const candidate = createOrLoadCandidate(evidence);
  if (shouldAutoPromote(evidence) && candidate.status !== "promoted") {
    await promoteProjectMemoryCandidate(input.org_id, input.project_id, candidate.id);
  }
  return rowToEvidence(db.prepare("SELECT * FROM project_evidence_items WHERE id = ?").get(id) as unknown as EvidenceRow);
}

export function listProjectEvidence(
  orgId: string,
  projectId: string,
  limit = 100,
): ProjectEvidenceItem[] | null {
  if (!loadProject(projectId, orgId)) return null;
  const rows = db
    .prepare(
      `SELECT * FROM project_evidence_items
       WHERE org_id = ? AND project_id = ?
       ORDER BY occurred_at DESC
       LIMIT ?`,
    )
    .all(orgId, projectId, limit) as unknown as EvidenceRow[];
  return rows.map(rowToEvidence);
}

export function listProjectMemoryCandidates(
  orgId: string,
  projectId: string,
  status?: ProjectMemoryCandidate["status"],
): ProjectMemoryCandidate[] | null {
  if (!loadProject(projectId, orgId)) return null;
  const rows = status
    ? db
        .prepare(
          `SELECT * FROM project_memory_candidates
           WHERE org_id = ? AND project_id = ? AND status = ?
           ORDER BY created_at DESC`,
        )
        .all(orgId, projectId, status)
    : db
        .prepare(
          `SELECT * FROM project_memory_candidates
           WHERE org_id = ? AND project_id = ?
           ORDER BY created_at DESC`,
        )
        .all(orgId, projectId);
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

async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 200).replace(/\s+/g, " ");
    throw new Error(`${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
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

async function pollGithub(project: ProjectRow, resources: ProjectResources): Promise<PollSourceResult> {
  const repos = resources.github?.repos ?? [];
  if (repos.length === 0) return { source: "github", ingested: 0 };
  const token = process.env.GH_TOKEN;
  if (!token) return { source: "github", ingested: 0, missing: "GH_TOKEN not set" };

  let ingested = 0;
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
        metadata: { repo, number: pr.number },
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
        metadata: { repo, number: issue.number, state: issue.state },
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
        metadata: { repo, sha: commit.sha, branch: branch ?? "default" },
        confidence_score: 0.7,
      });
      ingested++;
    }

    if (newest > since) setProjectCursor(project.org_id, project.project_id, "github", cursorKey, newest);
  }

  return { source: "github", ingested };
}

function escapeJql(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildPollJql(resources: ProjectResources, since: string): string | null {
  const clauses: string[] = [];
  const keys = resources.jira?.project_keys ?? [];
  if (keys.length > 0) clauses.push(`project in (${keys.map((k) => `"${escapeJql(k)}"`).join(", ")})`);
  if (resources.jira?.team) clauses.push(`"Team" = "${escapeJql(resources.jira.team)}"`);
  const epics = resources.jira?.epics ?? [];
  if (epics.length > 0) {
    const list = epics.map((k) => `"${escapeJql(k)}"`).join(", ");
    clauses.push(`("Epic Link" in (${list}) OR parent in (${list}))`);
  }
  const versions = resources.jira?.fix_versions ?? [];
  if (versions.length > 0) clauses.push(`fixVersion in (${versions.map((v) => `"${escapeJql(v)}"`).join(", ")})`);
  const issueKeys = resources.jira?.issue_keys ?? [];
  if (issueKeys.length > 0) clauses.push(`issuekey in (${issueKeys.map((k) => `"${escapeJql(k)}"`).join(", ")})`);
  if (clauses.length === 0) return null;
  clauses.push(`updated >= "${since.slice(0, 16).replace("T", " ")}"`);
  return `${clauses.join(" AND ")} ORDER BY updated ASC`;
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
      const body = (await res.text().catch(() => "")).slice(0, 200).replace(/\s+/g, " ");
      if (res.status === 401 || res.status === 403) {
        return { credentialState: "invalid_credentials", message: `GitHub ${res.status}: ${body}` };
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

    const body = (await res.text().catch(() => "")).slice(0, 200).replace(/\s+/g, " ");
    if (res.status === 401 || res.status === 403) {
      return { credentialState: "invalid_credentials", message: `Jira ${res.status}: ${body}` };
    }
    if (res.status === 400 || res.status === 404) {
      return { credentialState: "misconfigured", message: `Jira probe failed: ${res.status}: ${body}` };
    }
    if (res.status >= 500 || res.status === 429) {
      return { credentialState: "unreachable", message: `Jira probe failed: ${res.status}: ${body}` };
    }
    return { credentialState: "misconfigured", message: `Jira probe failed: ${res.status}: ${body}` };
  } catch (err) {
    return {
      credentialState: isNetworkOrTlsFailure(err) ? "unreachable" : "misconfigured",
      message: failureMessage("Jira probe failed", err),
    };
  }
}

async function pollJira(project: ProjectRow, resources: ProjectResources): Promise<PollSourceResult> {
  const base = process.env.JIRA_BASE_URL;
  const token = process.env.JIRA_TOKEN;
  const email = process.env.JIRA_EMAIL;
  if (!base || !token) return { source: "jira", ingested: 0, missing: "JIRA_BASE_URL or JIRA_TOKEN not set" };

  const cursorKey = "issues";
  const since = getProjectCursor(project.org_id, project.project_id, "jira", cursorKey) ?? sinceDefault();
  const jql = buildPollJql(resources, since);
  if (!jql) return { source: "jira", ingested: 0 };

  const isCloud = /atlassian\.net$/i.test(base) && !!email;
  const restPath = isCloud ? "rest/api/3/search" : "rest/api/2/search";
  const authHeader = isCloud
    ? "Basic " + Buffer.from(`${email}:${token}`).toString("base64")
    : `Bearer ${token}`;

  interface JiraIssue {
    key: string;
    fields?: {
      summary?: string;
      description?: unknown;
      updated?: string;
      resolutiondate?: string | null;
      status?: { name?: string; statusCategory?: { key?: string } };
      creator?: { displayName?: string; emailAddress?: string };
      assignee?: { displayName?: string; emailAddress?: string };
      fixVersions?: Array<{ name?: string }>;
    };
  }
  interface JiraResponse { issues?: JiraIssue[] }

  const data = await fetchJson<JiraResponse>(`${base.replace(/\/$/, "")}/${restPath}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader,
      Accept: "application/json",
    },
    body: JSON.stringify({
      jql,
      maxResults: 50,
      fields: ["summary", "description", "status", "updated", "creator", "assignee", "resolutiondate", "fixVersions"],
    }),
  });

  let ingested = 0;
  let newest = since;
  for (const issue of data.issues ?? []) {
    const f = issue.fields ?? {};
    const updated = f.updated ?? new Date().toISOString();
    if (updated > newest) newest = updated;
    const resolved = !!f.resolutiondate || f.status?.statusCategory?.key === "done";
    const description = typeof f.description === "string"
      ? f.description
      : JSON.stringify(f.description ?? "");
    await recordProjectEvidence({
      org_id: project.org_id,
      project_id: project.project_id,
      source: "jira",
      source_type: resolved ? "resolved_issue" : "issue",
      source_id: issue.key,
      source_url: `${base.replace(/\/$/, "")}/browse/${issue.key}`,
      source_title: `${issue.key}: ${f.summary ?? ""}`,
      summary: f.summary ?? issue.key,
      body: description,
      author: f.creator?.displayName ?? f.creator?.emailAddress,
      occurred_at: f.resolutiondate ?? updated,
      metadata: {
        key: issue.key,
        status: f.status?.name,
        assignee: f.assignee?.displayName ?? f.assignee?.emailAddress,
        fix_versions: (f.fixVersions ?? []).map((v) => v.name).filter(Boolean),
      },
      confidence_score: resolved ? 0.9 : 0.65,
    });
    ingested++;
  }
  if (newest > since) setProjectCursor(project.org_id, project.project_id, "jira", cursorKey, newest);
  return { source: "jira", ingested };
}

async function ingestSlackThreadUrls(project: ProjectRow, resources: ProjectResources): Promise<PollSourceResult> {
  const urls = resources.slack?.thread_urls ?? [];
  let ingested = 0;
  for (const url of urls) {
    await recordProjectEvidence({
      org_id: project.org_id,
      project_id: project.project_id,
      source: "slack",
      source_type: "thread_url",
      source_id: url,
      source_url: url,
      source_title: "Slack thread",
      summary: "Configured Slack thread",
      body: url,
      occurred_at: new Date().toISOString(),
      metadata: { thread_url: url },
      confidence_score: 0.55,
      promotable: false,
    });
    ingested++;
  }
  return { source: "slack", ingested };
}

export async function pollProjectSources(orgId: string, projectId: string): Promise<ProjectPollResult | null> {
  const project = loadProject(projectId, orgId);
  if (!project) return null;
  const resources = parseJson<ProjectResources>(project.resources_json, {});
  const results: PollSourceResult[] = [];

  for (const poller of [
    () => pollGithub(project, resources),
    () => pollJira(project, resources),
    () => ingestSlackThreadUrls(project, resources),
  ]) {
    try {
      results.push(await poller());
    } catch (err) {
      const source = results.length === 0 ? "github" : results.length === 1 ? "jira" : "slack";
      results.push({ source, ingested: 0, missing: (err as Error).message });
    }
  }

  return { results, health: getProjectSourceHealth(orgId, projectId) ?? [] };
}

export function getProjectSourceHealth(orgId: string, projectId: string): ProjectSourceHealth[] | null {
  const project = loadProject(projectId, orgId);
  if (!project) return null;
  const resources = parseJson<ProjectResources>(project.resources_json, {});
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

  function health(
    source: ProjectSourceHealth["source"],
    configuredItems: number,
    credentialState: ProjectSourceHealth["credential_state"],
    message?: string,
  ): ProjectSourceHealth {
    const evidence = evidenceBySource.get(source);
    const configured = configuredItems > 0;
    return {
      source,
      configured,
      credential_state: configured ? credentialState : "not_configured",
      configured_items: configuredItems,
      ...(evidence?.last_ingested_at ? { last_ingested_at: evidence.last_ingested_at } : {}),
      cursor_count: cursorBySource.get(source) ?? 0,
      ...(configured && message ? { message } : {}),
    };
  }

  return [
    health("github", resources.github?.repos?.length ?? 0, process.env.GH_TOKEN ? "ok" : "missing_credentials", process.env.GH_TOKEN ? undefined : "GH_TOKEN not set"),
    health(
      "jira",
      (resources.jira?.project_keys?.length ?? 0) +
        (resources.jira?.epics?.length ?? 0) +
        (resources.jira?.issue_keys?.length ?? 0) +
        (resources.jira?.fix_versions?.length ?? 0) +
        (resources.jira?.team ? 1 : 0),
      process.env.JIRA_BASE_URL && process.env.JIRA_TOKEN ? "ok" : "missing_credentials",
      process.env.JIRA_BASE_URL && process.env.JIRA_TOKEN ? undefined : "JIRA_BASE_URL or JIRA_TOKEN not set",
    ),
    health("slack", (resources.slack?.channels?.length ?? 0) + (resources.slack?.thread_urls?.length ?? 0), "not_required"),
    health("confluence", (resources.confluence?.space_keys?.length ?? 0) + (resources.confluence?.page_urls?.length ?? 0) + (resources.confluence?.page_ids?.length ?? 0), "not_required"),
    health("git", resources.git?.repo_paths?.length ?? 0, "not_required"),
  ];
}

export async function getProjectSourceHealthLive(orgId: string, projectId: string): Promise<ProjectSourceHealth[] | null> {
  const project = loadProject(projectId, orgId);
  if (!project) return null;
  const resources = parseJson<ProjectResources>(project.resources_json, {});
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
