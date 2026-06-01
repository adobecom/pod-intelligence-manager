import { randomUUID } from "crypto";
import db from "../db/connection.js";
import { ContextUpdateInputSchema } from "./ingestion.js";
import { scanForSecrets } from "./secret-scan.js";
import { scoreProjectUpdate } from "./quality-scoring.js";
import { broadcastToAll } from "../ws/index.js";
import type { ProjectContextUpdate } from "@pim/shared";
import { scheduleProjectGitHookEnrichment } from "./git-hook-enrichment.js";
import type { PimResult } from "../pim/master.js";
import { recordProjectEvidence } from "./project-memory.js";

export interface ProjectIngestionResult {
  success: boolean;
  update?: ProjectContextUpdate;
  pim?: PimResult;
  error?: string;
  secretFindings?: string[];
  deduplicated?: boolean;
}

export async function ingestProjectContextUpdate(
  projectId: string,
  input: unknown,
): Promise<ProjectIngestionResult> {
  const parsed = ContextUpdateInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: `Validation failed: ${parsed.error.message}` };
  }

  const data = parsed.data;

  const project = db.prepare("SELECT project_id, name, org_id FROM projects WHERE project_id = ?").get(projectId) as
    | { project_id: string; name: string; org_id: string | null }
    | undefined;
  if (!project) {
    return { success: false, error: `Project not found: ${projectId}` };
  }

  const textToScan = [data.summary, data.details, ...data.artifacts.map(a => a.path ?? a.url ?? "")].join(" ");
  const scanResult = scanForSecrets(textToScan);
  if (!scanResult.clean) {
    return {
      success: false,
      error: "Context update rejected: potential secrets detected",
      secretFindings: scanResult.findings,
    };
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

  db.prepare(
    `INSERT INTO project_context_updates (id, agent_id, timestamp, project_id, type, scope, summary, details, artifacts_json, status, quality_score, blocks_json, blocked_by_json, needs_input_from_json, source, commit_sha, org_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    update.id,
    update.agent_id,
    update.timestamp,
    update.project_id,
    update.type,
    update.scope,
    update.summary,
    update.details,
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
