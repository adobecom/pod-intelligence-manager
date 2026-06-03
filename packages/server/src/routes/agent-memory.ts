import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { validateBody } from "../middleware/validation.js";
import {
  AgentRunNotAppendableError,
  AgentMemorySequenceError,
  appendAgentRunEvent,
  assembleAgentResumeContext,
  closeAgentSession,
  createAgentCheckpoint,
  createAgentRun,
  createAgentSession,
  endAgentRun,
  getAgentSession,
  getAgentSessionTimeline,
  listMemoryCandidates,
  promoteMemoryCandidate,
  rejectMemoryCandidate,
  rollupAgentSession,
  updateAgentSessionWorkingState,
} from "../services/agent-memory.js";

const JsonRecordSchema = z.record(z.unknown());
const AgentRunEventTypeSchema = z.enum([
  "tool_call",
  "tool_result",
  "model_output",
  "file_change",
  "checkpoint_created",
  "context_update_submitted",
  "run_compacted",
  "run_started",
  "run_completed",
  "run_failed",
  "run_cancelled",
  "error",
]);

const ArtifactSchema = z.object({
  type: z.string(),
  path: z.string().optional(),
  url: z.string().optional(),
});

const CreateSessionSchema = z.object({
  project_id: z.string().nullable().optional(),
  pod_id: z.string().nullable().optional(),
  scope: z.string().nullable().optional(),
  agent_id: z.string().min(1),
  goal: z.string().nullable().optional(),
  current_task: z.string().nullable().optional(),
  working_state: JsonRecordSchema.optional(),
  metadata: JsonRecordSchema.optional(),
});

const WorkingStateSchema = z.object({
  working_state: JsonRecordSchema,
  merge: z.boolean().optional(),
  current_task: z.string().nullable().optional(),
  status: z.enum(["active", "paused", "ended"]).optional(),
});

const CreateRunSchema = z.object({
  input_prompt: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  provider: z.string().nullable().optional(),
  metadata: JsonRecordSchema.optional(),
});

const AppendEventSchema = z.object({
  event_type: AgentRunEventTypeSchema,
  payload: JsonRecordSchema.optional(),
  summary: z.string().nullable().optional(),
  artifact_refs: z.array(ArtifactSchema).optional(),
  token_count: z.number().int().nonnegative().optional(),
  expected_seq: z.number().int().positive().optional(),
});

const CheckpointSchema = z.object({
  run_id: z.string().nullable().optional(),
  snapshot: JsonRecordSchema,
  summary: z.string().nullable().optional(),
  artifact_refs: z.array(ArtifactSchema).optional(),
});

const EndRunSchema = z.object({
  status: z.enum(["completed", "failed", "cancelled"]),
  final_output: z.string().nullable().optional(),
  error_message: z.string().nullable().optional(),
  token_input_count: z.number().int().nonnegative().optional(),
  token_output_count: z.number().int().nonnegative().optional(),
  total_cost_usd: z.number().nonnegative().optional(),
  context_update_id: z.string().nullable().optional(),
  compacted_summary: z.string().nullable().optional(),
});

function memoryCandidateStatus(s: unknown) {
  return s === "pending" || s === "promoted" || s === "rejected" || s === "auto_promoted" ? s : undefined;
}

function parseEventLimit(raw: string | undefined): number | null {
  if (raw === undefined) return 25;
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) return null;
  return parsed;
}

export default async function agentMemoryRoutes(app: FastifyInstance) {
  app.post<{ Body: z.infer<typeof CreateSessionSchema> }>(
    "/api/agent-sessions",
    { preHandler: validateBody(CreateSessionSchema) },
    async (req, reply) => {
      const session = createAgentSession({ orgId: req.org!.org_id, ...req.body });
      if (!session) {
        reply.code(404);
        return { error: "Project or pod not found" };
      }
      reply.code(201);
      return session;
    },
  );

  app.get<{ Params: { sessionId: string } }>("/api/agent-sessions/:sessionId", async (req, reply) => {
    const session = getAgentSession(req.org!.org_id, req.params.sessionId);
    if (!session) {
      reply.code(404);
      return { error: "Agent session not found" };
    }
    return session;
  });

  app.patch<{ Params: { sessionId: string }; Body: z.infer<typeof WorkingStateSchema> }>(
    "/api/agent-sessions/:sessionId/working-state",
    { preHandler: validateBody(WorkingStateSchema) },
    async (req, reply) => {
      const session = updateAgentSessionWorkingState(req.org!.org_id, req.params.sessionId, req.body);
      if (!session) {
        reply.code(404);
        return { error: "Agent session not found" };
      }
      return session;
    },
  );

  app.post<{ Params: { sessionId: string }; Body: z.infer<typeof CreateRunSchema> }>(
    "/api/agent-sessions/:sessionId/runs",
    { preHandler: validateBody(CreateRunSchema) },
    async (req, reply) => {
      const run = createAgentRun(req.org!.org_id, req.params.sessionId, req.body);
      if (!run) {
        reply.code(404);
        return { error: "Agent session not found" };
      }
      reply.code(201);
      return run;
    },
  );

  app.post<{ Params: { runId: string }; Body: z.infer<typeof AppendEventSchema> }>(
    "/api/agent-runs/:runId/events",
    { preHandler: validateBody(AppendEventSchema) },
    async (req, reply) => {
      try {
        const event = appendAgentRunEvent(req.org!.org_id, req.params.runId, req.body);
        if (!event) {
          reply.code(404);
          return { error: "Agent run not found" };
        }
        reply.code(201);
        return event;
      } catch (err) {
        if (err instanceof AgentMemorySequenceError) {
          reply.code(409);
          return { error: err.message, expected_seq: err.expectedSeq };
        }
        if (err instanceof AgentRunNotAppendableError) {
          reply.code(409);
          return { error: err.message, status: err.runStatus };
        }
        throw err;
      }
    },
  );

  app.post<{ Params: { sessionId: string }; Body: z.infer<typeof CheckpointSchema> }>(
    "/api/agent-sessions/:sessionId/checkpoints",
    { preHandler: validateBody(CheckpointSchema) },
    async (req, reply) => {
      const checkpoint = createAgentCheckpoint(req.org!.org_id, req.params.sessionId, req.body);
      if (!checkpoint) {
        reply.code(404);
        return { error: "Agent session or run not found" };
      }
      reply.code(201);
      return checkpoint;
    },
  );

  app.patch<{ Params: { runId: string }; Body: z.infer<typeof EndRunSchema> }>(
    "/api/agent-runs/:runId/end",
    { preHandler: validateBody(EndRunSchema) },
    async (req, reply) => {
      const run = await endAgentRun(req.org!.org_id, req.params.runId, req.body);
      if (!run) {
        reply.code(404);
        return { error: "Agent run not found" };
      }
      return run;
    },
  );

  app.get<{ Params: { sessionId: string } }>("/api/agent-sessions/:sessionId/timeline", async (req, reply) => {
    const timeline = getAgentSessionTimeline(req.org!.org_id, req.params.sessionId);
    if (!timeline) {
      reply.code(404);
      return { error: "Agent session not found" };
    }
    return timeline;
  });

  app.get<{ Params: { sessionId: string }; Querystring: { event_limit?: string } }>(
    "/api/agent-sessions/:sessionId/resume-context",
    async (req, reply) => {
      const limit = parseEventLimit(req.query.event_limit);
      if (limit === null) {
        reply.code(400);
        return { error: "event_limit must be an integer between 1 and 100" };
      }
      const context = await assembleAgentResumeContext(req.org!.org_id, req.params.sessionId, limit);
      if (!context) {
        reply.code(404);
        return { error: "Agent session not found" };
      }
      return context;
    },
  );

  app.post<{ Params: { sessionId: string } }>("/api/agent-sessions/:sessionId/rollup", async (req, reply) => {
    if (!getAgentSession(req.org!.org_id, req.params.sessionId)) {
      reply.code(404);
      return { error: "Agent session not found" };
    }
    return rollupAgentSession(req.org!.org_id, req.params.sessionId);
  });

  app.get<{ Params: { sessionId: string }; Querystring: { status?: string } }>(
    "/api/agent-sessions/:sessionId/memory-candidates",
    async (req, reply) => {
      if (!getAgentSession(req.org!.org_id, req.params.sessionId)) {
        reply.code(404);
        return { error: "Agent session not found" };
      }
      const status = memoryCandidateStatus(req.query.status);
      if (req.query.status && !status) {
        reply.code(400);
        return { error: "Invalid status" };
      }
      return listMemoryCandidates(req.org!.org_id, {
        session_id: req.params.sessionId,
        status,
      });
    },
  );

  app.post<{ Params: { sessionId: string } }>("/api/agent-sessions/:sessionId/end", async (req, reply) => {
    const session = closeAgentSession(req.org!.org_id, req.params.sessionId);
    if (!session) {
      reply.code(404);
      return { error: "Agent session not found" };
    }
    return session;
  });

  app.post<{ Params: { candidateId: string } }>("/api/memory-candidates/:candidateId/promote", async (req, reply) => {
    const candidate = await promoteMemoryCandidate(req.org!.org_id, req.params.candidateId);
    if (!candidate) {
      reply.code(404);
      return { error: "Memory candidate not found" };
    }
    return candidate;
  });

  app.post<{ Params: { candidateId: string } }>("/api/memory-candidates/:candidateId/reject", async (req, reply) => {
    const candidate = rejectMemoryCandidate(req.org!.org_id, req.params.candidateId);
    if (!candidate) {
      reply.code(404);
      return { error: "Memory candidate not found" };
    }
    return candidate;
  });
}
