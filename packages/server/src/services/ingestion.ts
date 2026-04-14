import { z } from "zod";
import { randomUUID } from "crypto";
import db from "../db/connection.js";
import { scanForSecrets } from "./secret-scan.js";
import { broadcast } from "../ws/index.js";
import { processUpdate, type CouncilResult } from "../council/master.js";
import type { ContextUpdate } from "@council/shared";

const ScopeSchema = z.enum(["frontend", "backend", "design", "qa", "infra", "pm"]);
const UpdateTypeSchema = z.enum(["progress", "blocker", "spec_change", "question", "decision"]);
const WorkStatusSchema = z.enum(["completed", "in_progress", "blocked"]);

const ContextUpdateInputSchema = z.object({
  agent_id: z.string().min(1),
  type: UpdateTypeSchema,
  scope: ScopeSchema,
  summary: z.string().min(1),
  details: z.string(),
  artifacts: z.array(z.object({
    type: z.string(),
    path: z.string().optional(),
    url: z.string().optional(),
  })).default([]),
  status: WorkStatusSchema,
  blocks: z.array(z.string()).default([]),
  blocked_by: z.array(z.string()).default([]),
  needs_input_from: z.array(z.object({
    role: ScopeSchema,
    question: z.string(),
  })).default([]),
});

export type ContextUpdateInput = z.infer<typeof ContextUpdateInputSchema>;

export interface IngestionResult {
  success: boolean;
  update?: ContextUpdate;
  council?: CouncilResult;
  error?: string;
  secretFindings?: string[];
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

  // 4. Create the update record
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
  };

  // 5. Write to database
  db.prepare(
    `INSERT INTO context_updates (id, agent_id, timestamp, pod_id, type, scope, summary, details, artifacts_json, status, blocks_json, blocked_by_json, needs_input_from_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    update.id, update.agent_id, update.timestamp, update.pod_id,
    update.type, update.scope, update.summary, update.details,
    JSON.stringify(update.artifacts), update.status,
    JSON.stringify(update.blocks), JSON.stringify(update.blocked_by),
    JSON.stringify(update.needs_input_from),
  );

  // 6. Broadcast via WebSocket
  broadcast({
    type: "context_update_added",
    podId,
    payload: update,
  });

  // 7. Run through Council Master (classify, route, regenerate living doc)
  const councilResult = await processUpdate(update);

  return { success: true, update, council: councilResult };
}
