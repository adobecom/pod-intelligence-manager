import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ALL_TASKS } from "../tasks/index.js";
import { applyAssignment } from "../tasks/stratification.js";
import type { Task } from "../tasks/types.js";
import type { EvalRow } from "../report.js";
import type { AuditFinding, AuditResult } from "./protocol.js";
import { computeProtocolAnalysis } from "./protocol-analysis.js";

interface RunManifestLike {
  runId: string;
  tasks: string[];
  taskAsOf?: Record<string, string>;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function readJsonl<T>(path: string): Promise<T[]> {
  const raw = await readFile(path, "utf8").catch(() => "");
  return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as T);
}

async function readRunManifest(runDir: string): Promise<RunManifestLike> {
  return readJson<RunManifestLike>(join(runDir, "manifest.json"));
}

async function promptText(runDir: string): Promise<string> {
  const dir = join(runDir, "prompts");
  const files = await readdir(dir).catch(() => []);
  const parts: string[] = [];
  for (const file of files.filter((f) => f.endsWith(".json"))) {
    parts.push(await readFile(join(dir, file), "utf8"));
  }
  return parts.join("\n");
}

async function fixtureEntries(runDir: string): Promise<Array<{ file: string; text: string; json: any }>> {
  const out: Array<{ file: string; text: string; json: any }> = [];
  const root = join(runDir, "fixtures");
  const walk = async (dir: string, prefix = ""): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const file = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path, file);
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        const text = await readFile(path, "utf8");
        out.push({ file, text, json: JSON.parse(text) });
      }
    }
  };
  await walk(root);
  return out;
}

interface OutputRowForAudit {
  taskId: string;
  arm: string;
  seed: number;
}

interface PatchJudgeRowForAudit {
  taskId: string;
  arm: string;
  seed: number;
  patch?: {
    checked?: boolean;
    skipped?: boolean;
    applies?: boolean;
    reason?: string;
  };
}

function artifactKey(row: { taskId: string; arm: string; seed: number }): string {
  return `${row.taskId}::${row.arm}::${row.seed}`;
}

function isPatchJudgedTask(task: Task | undefined): boolean {
  return Boolean(task?.type === "content" && task.tags?.includes("real-emc"));
}

async function auditPatchJudge(runDir: string, manifest: RunManifestLike, tasks: Map<string, Task>, findings: AuditFinding[]): Promise<void> {
  const patchTaskIds = new Set(manifest.tasks.filter((id) => isPatchJudgedTask(tasks.get(id))));
  if (patchTaskIds.size === 0) return;

  const outputs = await readJsonl<OutputRowForAudit>(join(runDir, "outputs.jsonl"));
  const expected = outputs.filter((row) => patchTaskIds.has(row.taskId));
  if (expected.length === 0) {
    findings.push({ level: "error", message: "patch-judge task set is non-empty, but outputs.jsonl has no matching rows" });
    return;
  }

  const patchRows = await readJsonl<PatchJudgeRowForAudit>(join(runDir, "patch-judge.jsonl"));
  if (patchRows.length === 0) {
    findings.push({
      level: "error",
      message: `real-EMC diff tasks require patch-judge.jsonl (${patchTaskIds.size} task(s)); run \`pnpm --filter @pim/eval judge-patches -- --run-dir=${runDir}\``,
    });
    return;
  }

  const seen = new Set(patchRows.map(artifactKey));
  const missing = expected.filter((row) => !seen.has(artifactKey(row)));
  if (missing.length > 0) {
    findings.push({ level: "error", message: `patch judge missing ${missing.length}/${expected.length} output row(s)` });
  }

  const relevant = patchRows.filter((row) => patchTaskIds.has(row.taskId));
  const checked = relevant.filter((row) => row.patch?.checked);
  if (checked.length === 0) {
    findings.push({
      level: "error",
      message: "patch-judge.jsonl contains no checked rows; set EMC_REPO/--emc-repo so the executable patch judge actually runs",
    });
  }

  const failed = checked.filter((row) => row.patch?.applies === false);
  if (failed.length > 0) {
    findings.push({ level: "warning", message: `patch judge found ${failed.length}/${checked.length} checked patch(es) that do not apply` });
  }
}

async function scopedFixtureEntries(runDir: string): Promise<Array<{ taskId: string; json: any }>> {
  const dir = join(runDir, "fixtures", "scoped");
  const files = await readdir(dir).catch(() => []);
  const out: Array<{ taskId: string; json: any }> = [];
  for (const file of files.filter((f) => f.endsWith(".json"))) {
    out.push({ taskId: file.replace(/\.json$/, ""), json: JSON.parse(await readFile(join(dir, file), "utf8")) });
  }
  return out;
}

function renderLivingDocSectionsForAudit(sections: Array<{ markdown?: string }>): string {
  if (sections.length === 0) return "(no living doc sections at this point in time)";
  return sections.map((section) => section.markdown?.trim() ?? "").filter(Boolean).join("\n\n");
}

function taskMap(): Map<string, Task> {
  return new Map(ALL_TASKS.map((task) => {
    const assigned = applyAssignment(task);
    return [assigned.id, assigned] as const;
  }));
}

/**
 * Temporal leakage audit. Validates the per-task point-in-time PIM snapshots in
 * `fixtures/scoped/` (each stamped with `asOf`), which are exactly what the PIM
 * arms scoped the context to. Every timestamped element — recent updates,
 * conflicts (`created_at`), and knowledge-graph nodes (`created_at`) — must be on
 * or before the snapshot's `asOf`. The unscoped pod fixtures in `fixtures/` carry
 * no `asOf` and are intentionally not checked here.
 *
 * Also cross-checks coverage: every manifest task with a cutoff (`taskAsOf`) must
 * have a scoped snapshot, so the audit cannot pass vacuously by simply not
 * emitting scoped fixtures.
 */
export async function auditTemporal(runDir: string): Promise<AuditResult> {
  const findings: AuditFinding[] = [];
  const manifest = await readRunManifest(runDir).catch(() => ({ runId: "", tasks: [] } as RunManifestLike));
  const scoped = await scopedFixtureEntries(runDir);
  const scopedIds = new Set(scoped.map((s) => s.taskId));

  for (const { taskId, json } of scoped) {
    const cutoff = json.asOf ? Date.parse(json.asOf) : NaN;
    if (!Number.isFinite(cutoff)) {
      findings.push({ level: "error", message: `scoped fixture ${taskId}.json missing valid asOf cutoff` });
      continue;
    }
    const after = (ts: string | undefined): boolean => {
      if (!ts) return false;
      const t = Date.parse(ts);
      return Number.isFinite(t) && t > cutoff;
    };
    const payload = json.payload ?? {};
    if (!Array.isArray(payload.livingDocSections)) {
      findings.push({
        level: "error",
        message: `${taskId}: scoped fixture missing livingDocSections — livingDocMarkdown is an unauditable blob`,
      });
    } else {
      for (const section of payload.livingDocSections) {
        if (!section.updated_at) {
          findings.push({ level: "error", message: `${taskId}: living-doc section "${section.heading ?? "(unknown)"}" missing updated_at` });
        } else if (after(section.updated_at)) {
          findings.push({
            level: "error",
            message: `${taskId}: post-asOf living-doc section "${section.heading ?? "(unknown)"}" (${section.updated_at})`,
          });
        }
      }
      const expectedMarkdown = renderLivingDocSectionsForAudit(payload.livingDocSections);
      if ((payload.livingDocMarkdown ?? "") !== expectedMarkdown) {
        findings.push({
          level: "error",
          message: `${taskId}: livingDocMarkdown does not match filtered livingDocSections`,
        });
      }
    }
    for (const u of payload.recentUpdates ?? []) {
      if (after(u.timestamp)) findings.push({ level: "error", message: `${taskId}: post-asOf recent update ${u.timestamp}` });
    }
    for (const c of payload.conflicts ?? []) {
      if (after(c.created_at)) findings.push({ level: "error", message: `${taskId}: post-asOf conflict ${c.id} (${c.created_at})` });
    }
    const learningGroups = [payload.relevantLearnings, ...Object.values(payload.taskRelevantLearnings ?? {})];
    for (const group of learningGroups) {
      for (const n of (group as { nodes?: Array<{ created_at?: string; summary?: string }> } | undefined)?.nodes ?? []) {
        if (after(n.created_at)) findings.push({ level: "error", message: `${taskId}: post-asOf learning (${n.created_at})` });
      }
    }
  }

  for (const [taskId] of Object.entries(manifest.taskAsOf ?? {})) {
    if (!scopedIds.has(taskId)) {
      findings.push({ level: "error", message: `task ${taskId} has an asOf cutoff but no scoped fixture was written` });
    }
  }

  if (scoped.length === 0 && Object.keys(manifest.taskAsOf ?? {}).length === 0) {
    findings.push({ level: "warning", message: "no scoped fixtures and no task asOf cutoffs — temporal scoping not exercised" });
  }

  return { ok: findings.every((f) => f.level !== "error"), findings };
}

export async function auditLeakage(runDir: string): Promise<AuditResult> {
  const findings: AuditFinding[] = [];
  const manifest = await readRunManifest(runDir);
  const prompts = await promptText(runDir);
  const fixtures = (await fixtureEntries(runDir)).map((f) => f.text).join("\n");
  const tasks = taskMap();
  for (const taskId of manifest.tasks) {
    const task = tasks.get(taskId);
    if (!task) continue;
    if (task.groundTruth?.output) {
      const normalized = task.groundTruth.output.replace(/\s+/g, " ").trim();
      for (const chunk of chunkText(normalized, 120)) {
        if (chunk.length > 80 && prompts.includes(chunk)) {
          findings.push({ level: "error", message: `ground truth chunk leaked into prompt for ${taskId}` });
        }
        if (chunk.length > 80 && fixtures.includes(chunk)) {
          findings.push({ level: "error", message: `ground truth chunk leaked into fixture for ${taskId}` });
        }
      }
    }
    for (const value of [task.provenance?.mergeSha, task.provenance?.sourceUrl, task.groundTruth?.note].filter(Boolean)) {
      const s = String(value);
      if (s.length > 8 && prompts.includes(s)) {
        findings.push({ level: "error", message: `provenance value leaked into candidate prompt for ${taskId}: ${s.slice(0, 80)}` });
      }
    }
  }
  return { ok: findings.every((f) => f.level !== "error"), findings };
}

export async function auditRubrics(runDir: string): Promise<AuditResult> {
  const findings: AuditFinding[] = [];
  const manifest = await readRunManifest(runDir);
  const tasks = taskMap();
  const banned = [/\bPIM\b/i, /living doc/i, /pod-emc-/i, /\bC-\d+\b/, /conflict ID/i, /documented in pod/i];
  for (const taskId of manifest.tasks) {
    const rubricText = JSON.stringify(tasks.get(taskId)?.rubric ?? {});
    for (const re of banned) {
      if (re.test(rubricText)) {
        findings.push({ level: "error", message: `rubric for ${taskId} contains PIM-only or priming phrase (${re})` });
      }
    }
  }
  return { ok: findings.every((f) => f.level !== "error"), findings };
}

export async function auditJudging(runDir: string): Promise<AuditResult> {
  const findings: AuditFinding[] = [];
  const manifest = await readRunManifest(runDir);
  const tasks = taskMap();
  const rubricTasks = manifest.tasks.filter((id) => tasks.get(id)?.type === "content");
  const reviews = await readJsonl<Record<string, unknown>>(join(runDir, "human-review.jsonl"));
  if (rubricTasks.length > 0 && reviews.length === 0) {
    findings.push({ level: "error", message: "rubric tasks require blinded human or second-judge review entries" });
  }
  const kappaRaw = reviews.find((r) => typeof r.kappa === "number")?.kappa;
  if (typeof kappaRaw === "number" && kappaRaw < 0.6) {
    findings.push({ level: "error", message: `inter-rater kappa below 0.6 (${kappaRaw})` });
  }
  await auditPatchJudge(runDir, manifest, tasks, findings);
  return { ok: findings.every((f) => f.level !== "error"), findings };
}

export async function analyzeRun(runDir: string): Promise<AuditResult> {
  const rows = await readJsonl<EvalRow>(join(runDir, "rows.jsonl"));
  const analysis = computeProtocolAnalysis(rows);
  await writeFile(join(runDir, "analysis.json"), JSON.stringify(analysis, null, 2));
  const focus = analysis.realisticTicketFocus.find((v) => v.armA === "pim-full" && v.armB === "lic-full")?.comparison;
  const claimDecision = focus?.verdict ?? "no-effect";
  return {
    ok: claimDecision === "strong-support" || claimDecision === "directional",
    findings: [{
      level: claimDecision === "strong-support" || claimDecision === "directional" ? "warning" : "error",
      message: `realistic-ticket primary claim: ${claimDecision}`,
    }],
  };
}

export async function writeReviewerPacket(runDir: string): Promise<void> {
  const manifest = await readRunManifest(runDir);
  const analysis = await readFile(join(runDir, "analysis.json"), "utf8").catch(() => "{}");
  const outDir = join(runDir, "reviewer-packet");
  await mkdir(outDir, { recursive: true });
  await writeFile(
    join(outDir, "REVIEW_PACKET.md"),
    [
      "# PIM Context Benchmark Reviewer Packet",
      "",
      `Run id: \`${manifest.runId}\``,
      "",
      "## Included Artifacts",
      "",
      "- `manifest.json`",
      "- `fixtures/`",
      "- `prompts/`",
      "- `outputs.jsonl`",
      "- `judge-inputs/` and `judge-outputs/`",
      "- `human-review.jsonl`",
      "- `patch-judge.jsonl`",
      "- `analysis.json`",
      "",
      "## Analysis Snapshot",
      "",
      "```json",
      analysis,
      "```",
      "",
      "All result numbers in this packet are derived from run artifacts.",
    ].join("\n"),
  );
}

function chunkText(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}
