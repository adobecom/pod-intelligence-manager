import { randomUUID } from "crypto";
import db from "../../db/connection.js";
import { broadcast } from "../../ws/index.js";
import { callLLMJSON, isLLMAvailable, MODELS } from "../llm.js";
import { computeCurrentDay } from "../../services/pod-day.js";
import { DEFAULT_ORG_TUNING } from "@pim/shared";
import { getOrgTuning } from "../../services/org-settings.js";
import type { OrgTuning } from "@pim/shared";

/** Returned with POST /api/pods/:podId/lint so clients can see if the fast (Haiku) supplement ran. */
export interface LintPassMeta {
  bedrock_configured: boolean;
  /** True when Bedrock was called and the supplement finished without throwing. */
  llm_ok: boolean;
  /** Model id when `llm_ok` (e.g. Haiku via `BEDROCK_MODEL_FAST`). */
  llm_model: string | null;
  /** Count of findings added by the LLM (types such as implicit_assumption, spec_drift). */
  llm_extra_findings: number;
  llm_error: string | null;
}

export interface LintFinding {
  id: string;
  pod_id: string;
  timestamp: string;
  type:
    | "staleness"
    | "coverage_gap"
    | "dependency_risk"
    | "unresolved_conflict"
    | "doc_not_read"
    | "implicit_assumption"
    | "spec_drift"
    | "kg_org_contradiction";
  severity: "info" | "warning" | "critical";
  summary: string;
  area: string | null;
  suggestion: string | null;
}

interface AreaRow {
  scope: string;
  owner: string;
  status: string;
  last_activity: string | null;
}

interface PodRow {
  pod_id: string;
  day_number: number;
  sprint_start?: string;
  total_days?: number;
}

interface UpdateRow {
  agent_id: string;
  scope: string;
  timestamp: string;
  summary: string;
}

interface UpdateRowWithDetails extends UpdateRow {
  details: string | null;
  type: string;
}

interface ConflictRow {
  id: string;
  created_at: string;
  severity: string;
  summary: string;
  sides_json: string;
}

// Defaults preserved for backward compatibility; actual values come from OrgTuning at runtime.
const STALENESS_HOURS = DEFAULT_ORG_TUNING.lint.stalenessHours;
const LIVING_DOC_MAX_CHARS = DEFAULT_ORG_TUNING.lint.livingDocMaxChars;
const UPDATE_DETAILS_MAX_CHARS = DEFAULT_ORG_TUNING.lint.updateDetailsMaxChars;
const MAX_LLM_FINDINGS = DEFAULT_ORG_TUNING.lint.maxLlmFindings;

const LLM_ALLOWED_TYPES = new Set<LintFinding["type"]>(["implicit_assumption", "spec_drift"]);

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

function collectDeterministicLintFindings(podId: string, timestamp: string, lintTuning?: OrgTuning["lint"]): LintFinding[] {
  const now = Date.now();
  const findings: LintFinding[] = [];
  const stalenessHours = lintTuning?.stalenessHours ?? STALENESS_HOURS;

  const pod = db.prepare("SELECT pod_id, day_number, sprint_start, total_days FROM pods WHERE pod_id = ?").get(podId) as PodRow | undefined;
  if (!pod) return [];

  // Auto-advance day_number from sprint_start if available; fall back to stored value.
  const currentDay = pod.sprint_start && pod.total_days
    ? computeCurrentDay(pod.sprint_start, pod.total_days)
    : pod.day_number;

  const areas = db.prepare(
    "SELECT scope, owner, status, last_activity FROM pod_areas WHERE pod_id = ?",
  ).all(podId) as unknown as unknown as AreaRow[];

  const recentUpdates = db.prepare(
    "SELECT agent_id, scope, timestamp, summary FROM context_updates WHERE pod_id = ? ORDER BY timestamp DESC",
  ).all(podId) as unknown as UpdateRow[];

  const openConflicts = db.prepare(
    "SELECT id, created_at, severity, summary, sides_json FROM conflicts WHERE pod_id = ? AND status != 'resolved'",
  ).all(podId) as unknown as unknown as ConflictRow[];

  for (const area of areas) {
    if (area.status === "done" || area.status === "waiting") continue;
    const areaUpdates = recentUpdates.filter((u) => u.scope === area.scope);
    const latestUpdate = areaUpdates[0];
    if (latestUpdate) {
      const ageMs = now - new Date(latestUpdate.timestamp).getTime();
      const ageHours = ageMs / (1000 * 60 * 60);
      if (ageHours > stalenessHours) {
        findings.push({
          id: `lint-${randomUUID().slice(0, 8)}`,
          pod_id: podId,
          timestamp,
          type: "staleness",
          severity: ageHours > 24 ? "critical" : "warning",
          summary: `${area.scope} (${area.owner}) has not reported in ${Math.round(ageHours)}h`,
          area: area.scope,
          suggestion: `Check in with ${area.owner} on ${area.scope} progress`,
        });
      }
    } else if (currentDay > 1) {
      findings.push({
        id: `lint-${randomUUID().slice(0, 8)}`,
        pod_id: podId,
        timestamp,
        type: "staleness",
        severity: "warning",
        summary: `${area.scope} (${area.owner}) has no updates but is marked ${area.status}`,
        area: area.scope,
        suggestion: `Verify ${area.scope} work has started`,
      });
    }
  }

  if (currentDay > 2) {
    for (const area of areas) {
      if (area.status === "waiting") {
        findings.push({
          id: `lint-${randomUUID().slice(0, 8)}`,
          pod_id: podId,
          timestamp,
          type: "coverage_gap",
          severity: "warning",
          summary: `${area.scope} is still in "waiting" status on day ${currentDay}`,
          area: area.scope,
          suggestion: `Assign an owner or mark as not needed for this sprint`,
        });
      }
    }
  }

  const scopeAgents = new Map<string, Set<string>>();
  for (const update of recentUpdates) {
    if (!scopeAgents.has(update.scope)) scopeAgents.set(update.scope, new Set());
    scopeAgents.get(update.scope)!.add(update.agent_id);
  }
  for (const [scope, agents] of scopeAgents) {
    if (agents.size > 1) {
      const coordDecisions = recentUpdates.filter(
        (u) => u.scope === scope && u.summary.toLowerCase().includes("coordinat"),
      );
      if (coordDecisions.length === 0) {
        findings.push({
          id: `lint-${randomUUID().slice(0, 8)}`,
          pod_id: podId,
          timestamp,
          type: "dependency_risk",
          severity: "info",
          summary: `${agents.size} agents (${[...agents].join(", ")}) working in ${scope} without explicit coordination`,
          area: scope,
          suggestion: `Consider adding a coordination decision to clarify ownership`,
        });
      }
    }
  }

  for (const conflict of openConflicts) {
    const ageMs = now - new Date(conflict.created_at).getTime();
    const ageHours = ageMs / (1000 * 60 * 60);
    if (ageHours > 8) {
      findings.push({
        id: `lint-${randomUUID().slice(0, 8)}`,
        pod_id: podId,
        timestamp,
        type: "unresolved_conflict",
        severity: conflict.severity === "blocking" ? "critical" : "warning",
        summary: `${conflict.id} (${conflict.summary}) open for ${Math.round(ageHours)}h`,
        area: null,
        suggestion: `Resolve or escalate this conflict`,
      });
    }
  }

  const livingDoc = db.prepare(
    "SELECT last_regenerated_at, regen_count FROM living_docs WHERE pod_id = ?",
  ).get(podId) as { last_regenerated_at: string | null; regen_count: number } | undefined;

  if (livingDoc?.last_regenerated_at) {
    for (const conflict of openConflicts) {
      const sides = JSON.parse(conflict.sides_json) as Array<{ contributor: string }>;
      for (const side of sides) {
        const viewRow = db.prepare(
          "SELECT last_viewed_regen_count FROM living_doc_views WHERE pod_id = ? AND viewer_id = ?",
        ).get(podId, side.contributor) as { last_viewed_regen_count: number } | undefined;

        const neverViewed = !viewRow;
        const staleView = viewRow && viewRow.last_viewed_regen_count < livingDoc.regen_count;

        if (neverViewed || staleView) {
          findings.push({
            id: `lint-${randomUUID().slice(0, 8)}`,
            pod_id: podId,
            timestamp,
            type: "doc_not_read",
            severity: "warning",
            summary: `${side.contributor} is in conflict ${conflict.id} but hasn't viewed the living doc since last regeneration`,
            area: null,
            suggestion: `${side.contributor} should review the living doc for current context`,
          });
        }
      }
    }
  }

  return findings;
}

interface LLMFindingRow {
  type: string;
  severity: string;
  summary: string;
  area?: string | null;
  suggestion?: string | null;
}

function normalizeLLMFindings(
  podId: string,
  timestamp: string,
  rows: LLMFindingRow[] | undefined,
  maxFindings: number,
): LintFinding[] {
  if (!rows?.length) return [];
  const out: LintFinding[] = [];
  const severities = new Set(["info", "warning", "critical"]);

  for (const row of rows) {
    if (out.length >= maxFindings) break;
    if (!row.summary?.trim() || !row.type) continue;
    if (!LLM_ALLOWED_TYPES.has(row.type as LintFinding["type"])) continue;
    const sev = row.severity as LintFinding["severity"];
    if (!severities.has(sev)) continue;

    out.push({
      id: `lint-llm-${randomUUID().slice(0, 8)}`,
      pod_id: podId,
      timestamp,
      type: row.type as LintFinding["type"],
      severity: sev,
      summary: row.summary.trim().slice(0, 500),
      area: row.area?.trim() ? row.area.trim().slice(0, 120) : null,
      suggestion: row.suggestion?.trim() ? row.suggestion.trim().slice(0, 500) : null,
    });
  }

  return out;
}

function buildLintLLMContext(podId: string, deterministicSummary: string, lintTuning?: OrgTuning["lint"]): string {
  const livingDocMaxChars = lintTuning?.livingDocMaxChars ?? LIVING_DOC_MAX_CHARS;
  const updateDetailsMaxChars = lintTuning?.updateDetailsMaxChars ?? UPDATE_DETAILS_MAX_CHARS;
  const pod = db.prepare("SELECT pod_id, day_number, sprint_start, total_days FROM pods WHERE pod_id = ?").get(podId) as PodRow | undefined;
  if (!pod) return "";
  const currentDay = pod.sprint_start && pod.total_days
    ? computeCurrentDay(pod.sprint_start, pod.total_days)
    : pod.day_number;

  const areas = db.prepare(
    "SELECT scope, owner, status, last_activity FROM pod_areas WHERE pod_id = ?",
  ).all(podId) as unknown as unknown as AreaRow[];

  const updates = db.prepare(
    `SELECT agent_id, scope, timestamp, type, summary, details FROM context_updates
     WHERE pod_id = ? ORDER BY timestamp DESC LIMIT 30`,
  ).all(podId) as unknown as UpdateRowWithDetails[];

  const livingDocRow = db.prepare("SELECT markdown FROM living_docs WHERE pod_id = ?").get(podId) as
    | { markdown: string }
    | undefined;

  const lines: string[] = [];
  lines.push(`Pod: ${pod.pod_id}, sprint day: ${currentDay}`);
  lines.push("");
  lines.push("## Areas");
  lines.push(areas.length ? areas.map((a) => `- ${a.scope}: owner=${a.owner}, status=${a.status}`).join("\n") : "(none)");
  lines.push("");
  lines.push("## Recent context updates (newest first, details may be Markdown)");
  for (const u of updates) {
    const det = u.details ? truncate(u.details, updateDetailsMaxChars) : "";
    lines.push(
      `- [${u.timestamp}] ${u.agent_id} | ${u.type} | ${u.scope} | ${u.summary}${det ? `\n  Details:\n  ${det.replace(/\n/g, "\n  ")}` : ""}`,
    );
  }
  lines.push("");
  lines.push("## Living doc excerpt (Markdown)");
  lines.push(
    livingDocRow?.markdown
      ? truncate(livingDocRow.markdown, livingDocMaxChars)
      : "(no living doc in store)",
  );
  lines.push("");
  lines.push("## Deterministic lint pass (already recorded separately)");
  lines.push(deterministicSummary || "(none)");

  return lines.join("\n");
}

async function runLLMIntelligenceLint(
  podId: string,
  deterministicFindings: LintFinding[],
  timestamp: string,
  lintTuning?: OrgTuning["lint"],
): Promise<LintFinding[]> {
  const podExists = db.prepare("SELECT 1 FROM pods WHERE pod_id = ?").get(podId);
  if (!podExists) return [];

  const maxFindings = lintTuning?.maxLlmFindings ?? MAX_LLM_FINDINGS;
  const detSummary = deterministicFindings
    .map((f) => `- [${f.type}] ${f.severity}: ${f.summary}`)
    .join("\n");

  const context = buildLintLLMContext(podId, detSummary, lintTuning);
  if (!context) return [];

  const system = `You are the PIM lint assistant. Given pod state (areas, recent Markdown context updates, living doc excerpt) and a list of findings already produced by deterministic rules, add ONLY new advisory findings of types:
- implicit_assumption — work depends on something not formally decided or documented.
- spec_drift — agent updates reference behaviors or terms not reflected in the living doc / spec.

Rules:
- Output valid JSON only, no markdown fences, no commentary.
- At most ${maxFindings} findings. Skip issues already covered by the deterministic list.
- Each finding: type (implicit_assumption | spec_drift only), severity (info | warning | critical), summary (one sentence), area (scope string or empty), suggestion (actionable, or empty).
- Never include secrets, credentials, or PII. If nothing useful, return {"findings":[]}.`;

  const prompt = `Context:\n${context}\n\nReturn JSON: {"findings":[{"type":"implicit_assumption","severity":"warning","summary":"...","area":"frontend","suggestion":"..."}]}`;

  const parsed = await callLLMJSON<{ findings?: LLMFindingRow[] }>({
    model: MODELS.fast,
    system,
    prompt,
    maxTokens: 2048,
  });

  return normalizeLLMFindings(podId, timestamp, parsed?.findings, maxFindings);
}

/** Append a single lint finding without clearing existing pod findings. */
export function appendLintFinding(podId: string, finding: LintFinding): void {
  const podRow = db.prepare("SELECT org_id FROM pods WHERE pod_id = ?").get(podId) as { org_id: string | null } | undefined;
  const orgId = podRow?.org_id ?? null;
  db.prepare(
    `INSERT INTO lint_findings (id, pod_id, timestamp, type, severity, summary, area, suggestion, org_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    finding.id,
    finding.pod_id,
    finding.timestamp,
    finding.type,
    finding.severity,
    finding.summary,
    finding.area,
    finding.suggestion,
    orgId,
  );
}

function persistLintFindings(podId: string, findings: LintFinding[]): void {
  const podRow = db.prepare("SELECT org_id FROM pods WHERE pod_id = ?").get(podId) as { org_id: string | null } | undefined;
  const orgId = podRow?.org_id ?? null;
  db.prepare("DELETE FROM lint_findings WHERE pod_id = ?").run(podId);
  const insert = db.prepare(
    `INSERT INTO lint_findings (id, pod_id, timestamp, type, severity, summary, area, suggestion, org_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const f of findings) {
    insert.run(f.id, f.pod_id, f.timestamp, f.type, f.severity, f.summary, f.area, f.suggestion, orgId);
  }
}

export async function runLintPass(
  podId: string,
  orgId?: string,
): Promise<{ findings: LintFinding[]; meta: LintPassMeta }> {
  const lintTuning = orgId ? getOrgTuning(orgId).lint : undefined;
  const timestamp = new Date().toISOString();
  const findings = collectDeterministicLintFindings(podId, timestamp, lintTuning);

  const meta: LintPassMeta = {
    bedrock_configured: isLLMAvailable(),
    llm_ok: false,
    llm_model: null,
    llm_extra_findings: 0,
    llm_error: null,
  };

  if (meta.bedrock_configured) {
    try {
      const llmExtra = await runLLMIntelligenceLint(podId, findings, timestamp, lintTuning);
      meta.llm_ok = true;
      meta.llm_model = MODELS.fast;
      meta.llm_extra_findings = llmExtra.length;
      findings.push(...llmExtra);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      meta.llm_error = message;
      console.warn("[lint] LLM supplement failed:", err);
    }
  }

  persistLintFindings(podId, findings);
  broadcast({ type: "lint_completed", podId, payload: { findings, meta } });

  return { findings, meta };
}
