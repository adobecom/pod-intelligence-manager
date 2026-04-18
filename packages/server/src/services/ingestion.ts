import { z } from "zod";
import { randomUUID } from "crypto";
import db from "../db/connection.js";
import { scanForSecrets } from "./secret-scan.js";
import { scoreUpdate } from "./quality-scoring.js";
import { broadcast } from "../ws/index.js";
import { processUpdate, type PimResult } from "../pim/master.js";
import type { ContextUpdate } from "@pim/shared";
import { refreshPodSnapshotFromContext } from "./pod-snapshot.js";
import { scheduleAsyncQualityScore } from "./async-quality-score.js";
import { getOrgScopeIds } from "./org-settings.js";
import { getOrgIdForPod } from "./orgs.js";

const ScopeSchema = z.string().min(1);
const UpdateTypeSchema = z.enum(["progress", "blocker", "spec_change", "question", "decision"]);
const WorkStatusSchema = z.enum(["completed", "in_progress", "blocked"]);

const SourceSchema = z.enum(["manual", "git-hook", "claude-code-hook", "mcp", "sdk"]);

export const ContextUpdateInputSchema = z.object({
  agent_id: z.string().min(1),
  type: UpdateTypeSchema,
  scope: ScopeSchema,
  summary: z.string().min(1),
  details: z.string(),
  artifacts: z.array(z.object({
    type: z.string(),
    path: z.string().optional(),
    url: z.string().optional(),
    sha: z.string().optional(),
  })).default([]),
  status: WorkStatusSchema,
  blocks: z.array(z.string()).default([]),
  blocked_by: z.array(z.string()).default([]),
  needs_input_from: z.array(z.object({
    role: ScopeSchema,
    question: z.string(),
  })).default([]),
  source: SourceSchema.optional().default("manual"),
});

export type ContextUpdateInput = z.infer<typeof ContextUpdateInputSchema>;

export interface IngestionResult {
  success: boolean;
  update?: ContextUpdate;
  pim?: PimResult;
  error?: string;
  secretFindings?: string[];
  deduplicated?: boolean;
}

export async function ingestContextUpdate(podId: string, input: unknown): Promise<IngestionResult> {
  // 1. Validate schema
  const parsed = ContextUpdateInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: `Validation failed: ${parsed.error.message}` };
  }

  const data = parsed.data;

  // 2. Check pod exists
  const pod = db.prepare("SELECT pod_id FROM pods WHERE pod_id = ?").get(podId);
  if (!pod) {
    return { success: false, error: `Pod not found: ${podId}` };
  }

  // 2.5 Validate scope against the pod's org scopes
  const orgId = getOrgIdForPod(podId);
  if (!orgId) {
    return { success: false, error: `Pod ${podId} is not linked to an org` };
  }
  const validScopes = getOrgScopeIds(orgId);
  if (!validScopes.has(data.scope)) {
    return { success: false, error: `scope "${data.scope}" is not defined in the org` };
  }
  for (const req of data.needs_input_from) {
    if (!validScopes.has(req.role)) {
      return { success: false, error: `needs_input_from.role "${req.role}" is not a valid scope` };
    }
  }

  // 3. Secret scan (summary + details + artifact paths/urls)
  const textToScan = [data.summary, data.details, ...data.artifacts.map(a => a.path ?? a.url ?? "")].join(" ");
  const scanResult = scanForSecrets(textToScan);
  if (!scanResult.clean) {
    return {
      success: false,
      error: "Context update rejected: potential secrets detected",
      secretFindings: scanResult.findings,
    };
  }

  // 4. Quality scoring
  const quality = scoreUpdate(data, podId);

  // 4.5 Extract commit SHA for deduplication
  const commitArtifact = data.artifacts.find(a => a.type === "commit" && a.sha);
  const commitSha = commitArtifact?.sha ?? null;

  // 4.6 Deduplicate: if another source already reported this commit within 60s, skip
  if (commitSha) {
    const recent = db.prepare(
      `SELECT id FROM context_updates
       WHERE pod_id = ? AND commit_sha = ?
       AND timestamp > datetime('now', '-60 seconds')`
    ).get(podId, commitSha) as { id: string } | undefined;
    if (recent) {
      return { success: true, update: undefined, pim: undefined, deduplicated: true };
    }
  }

  // 5. Create the update record
  const id = `ctx-${randomUUID().slice(0, 8)}`;
  const timestamp = new Date().toISOString();

  const update: ContextUpdate = {
    id,
    agent_id: data.agent_id,
    timestamp,
    pod_id: podId,
    type: data.type,
    scope: data.scope,
    summary: data.summary,
    details: data.details,
    artifacts: data.artifacts as ContextUpdate["artifacts"],
    status: data.status,
    blocks: data.blocks,
    blocked_by: data.blocked_by,
    needs_input_from: data.needs_input_from as ContextUpdate["needs_input_from"],
    quality_score: quality.total,
    source: data.source,
  };

  // 6. Write to database
  db.prepare(
    `INSERT INTO context_updates (id, agent_id, timestamp, pod_id, type, scope, summary, details, artifacts_json, status, quality_score, blocks_json, blocked_by_json, needs_input_from_json, source, commit_sha, org_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    update.id, update.agent_id, update.timestamp, update.pod_id,
    update.type, update.scope, update.summary, update.details,
    JSON.stringify(update.artifacts), update.status, update.quality_score,
    JSON.stringify(update.blocks), JSON.stringify(update.blocked_by),
    JSON.stringify(update.needs_input_from),
    update.source ?? "manual", commitSha, orgId,
  );

  // 6.5 Denormalize pod_areas + milestone % + org agent_count from context stream
  refreshPodSnapshotFromContext(podId);

  // 7. Broadcast via WebSocket
  broadcast({
    type: "context_update_added",
    podId,
    payload: update,
  });

  // 8. Run through PIM orchestrator (classify, route, regenerate living doc)
  const pimResult = await processUpdate(update);

  // 9. Async AI quality score (non-blocking; updates row + WS when done)
  scheduleAsyncQualityScore(podId, update.id);

  return { success: true, update, pim: pimResult };
}
