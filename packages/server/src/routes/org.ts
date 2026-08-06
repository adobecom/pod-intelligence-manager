import type { FastifyInstance, FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import db from "../db/connection.js";
import type { OrgPodSummary, CrossPodOverlap, ArchivedPod, ArchivedProject, PodArchiveJob } from "@pim/shared";
import { parseProjectAnatomy } from "../services/project-anatomy-parse.js";
import { validateBody } from "../middleware/validation.js";
import {
  rejectServiceToken,
  requireAdmin,
  requireServiceScope,
} from "../middleware/service-authz.js";
import { getOrgConfig, setOrgConfig, getOrgTuning, deleteOrgTuning } from "../services/org-settings.js";
import {
  createServiceToken,
  listServiceTokens,
  revokeServiceToken,
  ServiceTokenError,
  SERVICE_TOKEN_SCOPES,
} from "../services/service-tokens.js";
import { extractKnowledgeEnhanced } from "../pim/agents/knowledge-extraction.js";
import { ingestLearnings } from "../services/ingestion-gateway.js";
import { broadcastToAll } from "../ws/index.js";
import { computeCurrentDay } from "../services/pod-day.js";
import { runTuningAgent, getOrgTuningHistory } from "../pim/agents/tuning-agent.js";

interface PodRow {
  pod_id: string;
  name: string;
  sprint_start: string;
  day_number: number;
  conflict_pressure: number;
  project_id?: string | null;
}

interface ArchiveJobState extends PodArchiveJob {
  org_id: string;
}

type ArchivedPodRow = ArchivedPod & { extraction_completed?: number | boolean | null };

const archiveJobs = new Map<string, ArchiveJobState>();
const TERMINAL_ARCHIVE_JOB_TTL_MS = 10 * 60 * 1000;
const DEFAULT_ARCHIVE_EXTRACTION_TIMEOUT_MS = 170 * 1000;

class ArchiveExtractionTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Archive extraction timed out after ${timeoutMs}ms`);
    this.name = "ArchiveExtractionTimeoutError";
  }
}

function archiveExtractionTimeoutMs(): number {
  const parsed = parseInt(process.env.ARCHIVE_EXTRACTION_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ARCHIVE_EXTRACTION_TIMEOUT_MS;
}

async function withArchiveExtractionTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ArchiveExtractionTimeoutError(timeoutMs));
    }, timeoutMs);
    timer.unref?.();
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function archiveJobKey(orgId: string, podId: string): string {
  return `${orgId}:${podId}`;
}

function archiveStatusUrl(podId: string): string {
  return `/api/pods/${encodeURIComponent(podId)}/archive/status`;
}

function publicArchiveJob(job: ArchiveJobState): PodArchiveJob {
  const { org_id: _orgId, ...out } = job;
  return out;
}

function archivedCompletedAt(archived: ArchivedPod): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(archived.completed_date)) {
    return `${archived.completed_date}T00:00:00.000Z`;
  }
  const parsed = Date.parse(archived.completed_date);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : archived.completed_date;
}

function scheduleArchiveJobEviction(key: string, job: ArchiveJobState): void {
  const timeout = setTimeout(() => {
    const current = archiveJobs.get(key);
    if (current === job && current.status !== "running") {
      archiveJobs.delete(key);
    }
  }, TERMINAL_ARCHIVE_JOB_TTL_MS);
  timeout.unref?.();
}

function normalizeArchivedPod(row: ArchivedPodRow): ArchivedPod {
  return {
    ...row,
    extraction_completed: row.extraction_completed == null ? true : Boolean(row.extraction_completed),
  };
}

function readArchivedPod(orgId: string, podId: string): ArchivedPod | undefined {
  const row = db
    .prepare("SELECT * FROM archived_pods WHERE pod_id = ? AND org_id = ?")
    .get(podId, orgId) as unknown as ArchivedPodRow | undefined;
  return row ? normalizeArchivedPod(row) : undefined;
}

function archiveExtractionComplete(archived: ArchivedPod): boolean {
  return archived.extraction_completed !== false;
}

function completedArchiveStatus(orgId: string, podId: string, archived: ArchivedPod): ArchiveJobState {
  const completedAt = archivedCompletedAt(archived);
  return {
    org_id: orgId,
    job_id: `archive-${podId}`,
    pod_id: podId,
    status: "completed",
    started_at: completedAt,
    completed_at: completedAt,
    status_url: archiveStatusUrl(podId),
    archived,
  };
}

function incompleteArchiveStatus(orgId: string, podId: string, archived: ArchivedPod): ArchiveJobState {
  const completedAt = archivedCompletedAt(archived);
  return {
    org_id: orgId,
    job_id: `archive-${podId}`,
    pod_id: podId,
    status: "failed",
    started_at: completedAt,
    completed_at: completedAt,
    status_url: archiveStatusUrl(podId),
    archived,
    error: "Archive extraction did not complete. Retry by POSTing to the archive endpoint.",
  };
}

function persistArchivedPod(orgId: string, pod: PodRow): ArchivedPod {
  const now = new Date();
  const start = new Date(pod.sprint_start);
  const durationDays = Math.max(1, Math.ceil((now.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)));

  db.prepare(
    `INSERT OR REPLACE INTO archived_pods (pod_id, name, completed_date, duration_days, final_pressure, org_id, extraction_completed)
     VALUES (?, ?, ?, ?, ?, ?, 0)`,
  ).run(pod.pod_id, pod.name, now.toISOString().split("T")[0], durationDays, pod.conflict_pressure, orgId);

  db.prepare("DELETE FROM org_pod_summaries WHERE pod_id = ? AND org_id = ?").run(pod.pod_id, orgId);

  const archived = readArchivedPod(orgId, pod.pod_id);
  if (!archived) throw new Error(`Archived pod missing after archive write: ${pod.pod_id}`);
  return archived;
}

function markArchiveExtractionPending(orgId: string, podId: string): ArchivedPod | undefined {
  db.prepare("UPDATE archived_pods SET extraction_completed = 0 WHERE pod_id = ? AND org_id = ?").run(podId, orgId);
  return readArchivedPod(orgId, podId);
}

function markArchiveExtractionCompleted(orgId: string, podId: string): ArchivedPod | undefined {
  db.prepare("UPDATE archived_pods SET extraction_completed = 1 WHERE pod_id = ? AND org_id = ?").run(podId, orgId);
  return readArchivedPod(orgId, podId);
}

const OrgConfigBodySchema = z.object({
  scopes: z.array(
    z.object({
      id: z.string().min(1),
      label: z.string().min(1),
    }),
  ),
  kg_context_contract: z.enum(["legacy", "shadow", "task_relevant"]).optional(),
});

const CreateServiceTokenSchema = z
  .object({
    name: z.string().min(1).max(120).transform((s) => s.trim()),
    scopes: z.array(z.enum(SERVICE_TOKEN_SCOPES)).min(1),
    project_id: z.string().min(1).optional(),
    pod_id: z.string().min(1).optional(),
    repository_ids: z.array(
      z.string().regex(/^github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/).max(256),
    ).max(32).default([]),
    harness_ids: z.array(z.string().min(1).max(64)).max(32).default([]),
    expires_in_days: z.number().int().positive().max(365).default(90),
  })
  .refine((body) => !(body.project_id && body.pod_id), {
    message: "A service token cannot be both project-bound and pod-bound",
    path: ["pod_id"],
  })
  .refine((body) => new Set(body.repository_ids).size === body.repository_ids.length, {
    message: "Repository bindings must be unique",
    path: ["repository_ids"],
  })
  .refine((body) => new Set(body.harness_ids).size === body.harness_ids.length, {
    message: "Harness bindings must be unique",
    path: ["harness_ids"],
  });

export default async function orgRoutes(app: FastifyInstance) {
  app.get("/api/org/config", async (req, reply) => {
    if (!requireServiceScope(req, reply, "org-config:read")) return;
    return getOrgConfig(req.org!.org_id);
  });

  app.patch<{ Body: z.infer<typeof OrgConfigBodySchema> }>(
    "/api/org/config",
    {
      preHandler: validateBody(OrgConfigBodySchema),
    },
    async (req, reply) => {
      if (!rejectServiceToken(req, reply)) return;
      try {
        return setOrgConfig(req.org!.org_id, req.body);
      } catch (e) {
        reply.code(400);
        return { error: e instanceof Error ? e.message : "Invalid org config" };
      }
    },
  );

  app.post<{ Body: z.infer<typeof CreateServiceTokenSchema> }>(
    "/api/org/service-tokens",
    { preHandler: validateBody(CreateServiceTokenSchema) },
    async (req, reply) => {
      if (!requireAdmin(req, reply)) return;
      const expiresAt = new Date(Date.now() + req.body.expires_in_days * 24 * 60 * 60 * 1000).toISOString();
      try {
        reply.code(201);
        return createServiceToken({
          orgId: req.org!.org_id,
          name: req.body.name,
          scopes: req.body.scopes,
          projectId: req.body.project_id,
          podId: req.body.pod_id,
          repositoryIds: req.body.repository_ids,
          harnessIds: req.body.harness_ids,
          expiresAt,
          createdByUserId: req.userRecord.user_id,
        });
      } catch (err) {
        if (err instanceof ServiceTokenError) {
          reply.code(err.statusCode);
          return { error: err.message };
        }
        throw err;
      }
    },
  );

  app.get("/api/org/service-tokens", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return { tokens: listServiceTokens(req.org!.org_id) };
  });

  app.post<{ Params: { tokenId: string } }>("/api/org/service-tokens/:tokenId/revoke", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const revoked = revokeServiceToken(req.org!.org_id, req.params.tokenId);
    if (!revoked) {
      reply.code(404);
      return { error: "Service token not found" };
    }
    return { ok: true };
  });

  // Autonomous tuning — read-only for humans; written by runTuningAgent after pod archival
  app.get("/api/org/tuning", async (req, reply) => {
    if (!rejectServiceToken(req, reply)) return;
    return getOrgTuning(req.org!.org_id);
  });

  app.get("/api/org/tuning/history", async (req, reply) => {
    if (!rejectServiceToken(req, reply)) return;
    return getOrgTuningHistory(req.org!.org_id);
  });

  app.delete("/api/org/tuning", async (req, reply) => {
    if (!rejectServiceToken(req, reply)) return;
    deleteOrgTuning(req.org!.org_id);
    return getOrgTuning(req.org!.org_id);
  });

  app.get("/api/org/pods", async (req, reply) => {
    if (!rejectServiceToken(req, reply)) return;
    // Join against `pods` to pull sprint_start/total_days so day_number reflects real sprint
    // progress (the denormalized org_pod_summaries.day_number is not advanced over time).
    const rows = db.prepare(
      `SELECT s.*, p.sprint_start AS _sprint_start, p.total_days AS _total_days
       FROM org_pod_summaries s
       LEFT JOIN pods p ON p.pod_id = s.pod_id
       WHERE s.org_id = ?`,
    ).all(req.org!.org_id) as unknown as Array<OrgPodSummary & { _sprint_start: string | null; _total_days: number | null }>;
    return rows.map((r) => {
      const { _sprint_start, _total_days, ...summary } = r;
      const totalDays = _total_days ?? summary.total_days;
      return {
        ...summary,
        total_days: totalDays,
        day_number: _sprint_start ? computeCurrentDay(_sprint_start, totalDays) : summary.day_number,
      };
    });
  });

  app.get("/api/org/overlaps", async (req, reply) => {
    if (!rejectServiceToken(req, reply)) return;
    return db.prepare("SELECT * FROM cross_pod_overlaps WHERE org_id = ?").all(req.org!.org_id) as unknown as CrossPodOverlap[];
  });

  app.get("/api/org/archived", async (req, reply) => {
    if (!rejectServiceToken(req, reply)) return;
    const rows = db.prepare("SELECT * FROM archived_pods WHERE org_id = ?").all(req.org!.org_id) as unknown as ArchivedPodRow[];
    return rows.map(normalizeArchivedPod);
  });

  app.get("/api/org/archived-projects", async (req, reply) => {
    if (!rejectServiceToken(req, reply)) return;
    const rows = db
      .prepare(
        "SELECT project_id, name, description, created_at, anatomy_json, archived_date FROM archived_projects WHERE org_id = ? ORDER BY archived_date DESC",
      )
      .all(req.org!.org_id) as Array<{
      project_id: string;
      name: string;
      description: string | null;
      created_at: string;
      anatomy_json: string;
      archived_date: string;
    }>;
    return rows.map(
      (r): ArchivedProject => ({
        project_id: r.project_id,
        name: r.name,
        description: r.description,
        created_at: r.created_at,
        archived_date: r.archived_date,
        anatomy: parseProjectAnatomy(r.anatomy_json),
      }),
    );
  });

  const getArchiveStatus = async (podId: string, orgId: string, reply: FastifyReply) => {
    const job = archiveJobs.get(archiveJobKey(orgId, podId));
    if (job) {
      reply.code(job.status === "running" ? 202 : 200);
      return publicArchiveJob(job);
    }
    const archived = readArchivedPod(orgId, podId);
    if (!archived) {
      reply.code(404);
      return { error: "Archive job not found" };
    }
    if (!archiveExtractionComplete(archived)) {
      return publicArchiveJob(incompleteArchiveStatus(orgId, podId, archived));
    }
    return publicArchiveJob(completedArchiveStatus(orgId, podId, archived));
  };

  app.get<{ Params: { podId: string } }>("/api/pods/:podId/archive/status", async (req, reply) => {
    if (!rejectServiceToken(req, reply)) return;
    return getArchiveStatus(req.params.podId, req.org!.org_id, reply);
  });

  app.post<{ Params: { podId: string } }>("/api/pods/:podId/archive/status", async (req, reply) => {
    if (!rejectServiceToken(req, reply)) return;
    return getArchiveStatus(req.params.podId, req.org!.org_id, reply);
  });

  app.post<{ Params: { podId: string } }>("/api/pods/:podId/archive", async (req, reply) => {
    if (!rejectServiceToken(req, reply)) return;
    const { podId } = req.params;
    const orgId = req.org!.org_id;
    const key = archiveJobKey(orgId, podId);
    const existingJob = archiveJobs.get(key);
    if (existingJob && existingJob.status !== "failed") {
      reply.code(existingJob.status === "running" ? 202 : 200);
      return publicArchiveJob(existingJob);
    }
    const retryFailedJob = existingJob?.status === "failed";

    const archivedExisting = readArchivedPod(orgId, podId);
    const activeSummary = db
      .prepare("SELECT pod_id FROM org_pod_summaries WHERE pod_id = ? AND org_id = ?")
      .get(podId, orgId) as { pod_id: string } | undefined;
    if (archivedExisting && !activeSummary && archiveExtractionComplete(archivedExisting) && !retryFailedJob) {
      return publicArchiveJob(completedArchiveStatus(orgId, podId, archivedExisting));
    }

    const pod = db.prepare("SELECT pod_id, name, sprint_start, day_number, conflict_pressure, project_id FROM pods WHERE pod_id = ? AND org_id = ?").get(podId, orgId) as PodRow | undefined;
    if (!pod) {
      if (retryFailedJob) {
        reply.code(200);
        return publicArchiveJob(existingJob);
      }
      if (archivedExisting && !archiveExtractionComplete(archivedExisting)) {
        reply.code(409);
        return { error: "Archived pod extraction is incomplete, but the source pod is missing and cannot be retried" };
      }
      reply.code(404);
      return { error: "Pod not found" };
    }

    const shouldReuseArchived = archivedExisting
      && (retryFailedJob || !activeSummary || !archiveExtractionComplete(archivedExisting));
    const archived = shouldReuseArchived
      ? (markArchiveExtractionPending(orgId, podId) ?? archivedExisting)
      : persistArchivedPod(orgId, pod);
    const job: ArchiveJobState = {
      org_id: orgId,
      job_id: `archive-${randomUUID().slice(0, 8)}`,
      pod_id: podId,
      status: "running",
      started_at: new Date().toISOString(),
      status_url: archiveStatusUrl(podId),
      archived: { ...archived, learnings_extracted: 0 },
    };
    archiveJobs.set(key, job);
    setImmediate(() => {
      void runArchiveExtractionJob(app, job, pod);
    });

    reply.code(202);
    return publicArchiveJob(job);
  });
}

async function runArchiveExtractionJob(app: FastifyInstance, job: ArchiveJobState, pod: PodRow): Promise<void> {
  let learningsExtracted = 0;
  try {
    learningsExtracted = await withArchiveExtractionTimeout(
      extractArchiveLearnings(job, pod),
      archiveExtractionTimeoutMs(),
    );
    if (learningsExtracted > 0) {
      broadcastToAll({ type: "knowledge_updated", podId: pod.pod_id, payload: { learnings_extracted: learningsExtracted } });
    }

    const archived = markArchiveExtractionCompleted(job.org_id, pod.pod_id);
    job.status = "completed";
    job.completed_at = new Date().toISOString();
    if (archived) job.archived = { ...archived, learnings_extracted: learningsExtracted };
    delete job.error;
    scheduleArchiveJobEviction(archiveJobKey(job.org_id, pod.pod_id), job);

    void runTuningAgent(job.org_id).catch((err) => {
      app.log.warn(err, "Tuning agent failed during archival (non-blocking)");
    });
  } catch (err) {
    app.log.error(err, "Archive extraction job failed");
    const archived = markArchiveExtractionPending(job.org_id, pod.pod_id);
    job.status = "failed";
    job.completed_at = new Date().toISOString();
    if (archived) job.archived = { ...archived, learnings_extracted: learningsExtracted };
    job.error = err instanceof Error ? err.message : "Archive extraction failed";
    scheduleArchiveJobEviction(archiveJobKey(job.org_id, pod.pod_id), job);
  }
}

async function extractArchiveLearnings(job: ArchiveJobState, pod: PodRow): Promise<number> {
  const learnings = await extractKnowledgeEnhanced(pod.pod_id, job.org_id);
  if (learnings.length === 0) return 0;

  let projectMeta: { project_id: string; project_name: string } | undefined;
  if (pod.project_id) {
    const pr = db.prepare("SELECT name FROM projects WHERE project_id = ? AND org_id = ?").get(pod.project_id, job.org_id) as
      | { name: string }
      | undefined;
    if (pr) projectMeta = { project_id: pod.project_id, project_name: pr.name };
  }
  // Route through the ingestion gateway (sanitize -> normalize domains ->
  // clamp confidence) before embedding + dedup + relational edge-building.
  const result = await ingestLearnings(job.org_id, learnings, pod.pod_id, pod.name, "pod_archival", projectMeta, { skipAnalysis: true });
  return result.nodesAdded;
}
