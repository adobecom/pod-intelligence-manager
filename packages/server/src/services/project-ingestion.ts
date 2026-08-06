import { randomUUID } from "crypto";
import db from "../db/connection.js";
import { ContextUpdateInputSchema, type ContextUpdateInput } from "./ingestion.js";
import { scoreProjectUpdate } from "./quality-scoring.js";
import { broadcastToAll } from "../ws/index.js";
import type { ProjectContextUpdate } from "@pim/shared";
import { scheduleProjectGitHookEnrichment } from "./git-hook-enrichment.js";
import type { PimResult } from "../pim/master.js";
import { recordProjectEvidence } from "./project-memory.js";
import {
  buildProjectContextUpdateMemory,
  recordTemporalRelationshipsForUpdate,
} from "./memory-enrichment.js";
import { redactProjectText, redactProjectUrl } from "./project-evidence-normalization.js";

export interface ProjectIngestionResult {
  success: boolean;
  update?: ProjectContextUpdate;
  pim?: PimResult;
  error?: string;
  secretFindings?: string[];
  deduplicated?: boolean;
}

function normalizeText(value: string, findings: Set<string>): string {
  const normalized = redactProjectText(value);
  for (const finding of normalized.findings) findings.add(finding);
  return normalized.text;
}

/** Canonicalize every admitted string before it can reach memory enrichment,
 * SQLite/WAL, evidence indexing, broadcasts, or follow-on jobs. */
function normalizeProjectContextInput(data: ContextUpdateInput): {
  data: ContextUpdateInput;
  findings: string[];
} {
  const findings = new Set<string>();
  const normalized: ContextUpdateInput = {
    agent_id: normalizeText(data.agent_id, findings),
    type: data.type,
    scope: normalizeText(data.scope, findings),
    summary: normalizeText(data.summary, findings),
    details: normalizeText(data.details, findings),
    artifacts: data.artifacts.map((artifact) => ({
      type: normalizeText(artifact.type, findings),
      ...(artifact.path !== undefined ? { path: normalizeText(artifact.path, findings) } : {}),
      ...(artifact.url !== undefined ? { url: redactProjectUrl(artifact.url, findings) } : {}),
      ...(artifact.sha !== undefined ? { sha: normalizeText(artifact.sha, findings) } : {}),
    })),
    status: data.status,
    blocks: data.blocks.map((value) => normalizeText(value, findings)),
    blocked_by: data.blocked_by.map((value) => normalizeText(value, findings)),
    needs_input_from: data.needs_input_from.map((request) => ({
      role: normalizeText(request.role, findings),
      question: normalizeText(request.question, findings),
    })),
    source: data.source,
  };
  return { data: normalized, findings: [...findings].sort() };
}

export async function ingestProjectContextUpdate(
  projectId: string,
  input: unknown,
): Promise<ProjectIngestionResult> {
  const parsed = ContextUpdateInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: `Validation failed: ${parsed.error.message}` };
  }

  const normalized = normalizeProjectContextInput(parsed.data);
  if (normalized.findings.length > 0) {
    return {
      success: false,
      error: "Context update rejected: potential secrets detected",
      secretFindings: normalized.findings,
    };
  }
  const data = normalized.data;

  const project = db.prepare("SELECT project_id, name, org_id FROM projects WHERE project_id = ?").get(projectId) as
    | { project_id: string; name: string; org_id: string | null }
    | undefined;
  if (!project) {
    return { success: false, error: `Project not found: ${projectId}` };
  }

  const quality = scoreProjectUpdate(data, projectId);

  const commitArtifact = data.artifacts.find(a => a.type === "commit" && a.sha);
  const commitSha = commitArtifact?.sha ?? null;

  if (commitSha) {
    const recent = db.prepare(
      `SELECT id FROM project_context_updates
       WHERE project_id = ? AND commit_sha = ?
       AND timestamp > datetime('now', '-60 seconds')`,
    ).get(projectId, commitSha) as { id: string } | undefined;
    if (recent) {
      return { success: true, update: undefined, pim: undefined, deduplicated: true };
    }
  }

  const id = `pcu-${randomUUID().slice(0, 8)}`;
  const timestamp = new Date().toISOString();

  const update: ProjectContextUpdate = {
    id,
    agent_id: data.agent_id,
    timestamp,
    project_id: projectId,
    type: data.type,
    scope: data.scope,
    summary: data.summary,
    details: data.details,
    artifacts: data.artifacts as ProjectContextUpdate["artifacts"],
    status: data.status,
    blocks: data.blocks,
    blocked_by: data.blocked_by,
    needs_input_from: data.needs_input_from as ProjectContextUpdate["needs_input_from"],
    quality_score: quality.total,
    source: data.source,
  };

  const memory = buildProjectContextUpdateMemory(project.org_id ?? "", update);
  update.retrieval_text = memory.retrieval_text;
  update.entity_refs = memory.entity_refs;

  db.prepare(
    `INSERT INTO project_context_updates
       (id, agent_id, timestamp, project_id, type, scope, summary, details, retrieval_text, entity_refs_json,
        artifacts_json, status, quality_score, blocks_json, blocked_by_json, needs_input_from_json, source, commit_sha, org_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    update.id,
    update.agent_id,
    update.timestamp,
    update.project_id,
    update.type,
    update.scope,
    update.summary,
    update.details,
    update.retrieval_text ?? null,
    JSON.stringify(update.entity_refs ?? []),
    JSON.stringify(update.artifacts),
    update.status,
    update.quality_score ?? 0,
    JSON.stringify(update.blocks),
    JSON.stringify(update.blocked_by),
    JSON.stringify(update.needs_input_from),
    update.source ?? "manual",
    commitSha,
    project.org_id,
  );

  if (project.org_id) {
    recordTemporalRelationshipsForUpdate({
      orgId: project.org_id,
      updateId: update.id,
      timestamp: update.timestamp,
      type: update.type,
      entityRefs: update.entity_refs ?? [],
      artifacts: update.artifacts,
      reason: update.summary,
    });
  }

  if (project.org_id) {
    await recordProjectEvidence({
      org_id: project.org_id,
      project_id: projectId,
      source: "project_update",
      source_type: update.type,
      source_id: update.id,
      source_title: update.summary,
      summary: update.summary,
      body: update.details,
      author: update.agent_id,
      occurred_at: update.timestamp,
      metadata: {
        scope: update.scope,
        status: update.status,
        artifacts: update.artifacts,
        domains: [update.scope],
      },
      confidence_score: Math.max(0.5, Math.min(0.8, update.quality_score ?? 0.5)),
      promotable: false,
    });
  }

  broadcastToAll({
    type: "project_context_update_added",
    payload: { projectId, update },
  });

  if (data.source === "git-hook") {
    scheduleProjectGitHookEnrichment(projectId, update.id);
  }

  return {
    success: true,
    update,
    pim: {
      classification: "additive",
      merged: true,
      conflictCreated: false,
      note: "Project context recorded (no pod PIM orchestrator run)",
    },
  };
}
