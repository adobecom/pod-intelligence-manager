import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import type { PromptTier, Task, TaskProvenance } from "../tasks/types.js";
import { ALL_TASKS } from "../tasks/index.js";
import { applyAssignment } from "../tasks/stratification.js";
import { classifyPromptTier } from "../tasks/prompt-tiers.js";
import type { LicIndexSource } from "../arms/types.js";
import { sha256Text, stableJson } from "./hash.js";
import type { AuditResult, AuditFinding } from "./protocol.js";

export interface HoldoutTaskEntry {
  id: string;
  promptHash: string;
  groundTruthHash?: string;
  rubricHash?: string;
  asOf?: string;
  /** Frozen prompt-realism tier. The headline claim uses only realistic-ticket. */
  promptTier?: PromptTier;
  /** Stratum (S1-S6) assigned in the haiku protocol. */
  stratum?: string;
  /** Frozen real-task provenance used to guard point-in-time indexing. */
  provenance?: Pick<TaskProvenance, "mergeSha" | "parentSha" | "sourceUrl">;
  /** SHA-256 of the frozen lic fixture for this task. */
  licFixtureHash?: string;
  /** Index source recorded in the frozen lic fixture. */
  licIndexSource?: LicIndexSource;
  /** SHA-256 of the deterministic lic-recipe inputs. */
  licSeedHash?: string;
  objectiveClass?: {
    taskType: string;
    hasGroundTruth: boolean;
    promptChars: number;
    groundTruthChars: number;
    sourceTagSnapshot: string[];
  };
}

export interface HoldoutManifest {
  id: string;
  protocol: string;
  minimumTaskCount: number;
  createdAt: string;
  /**
   * Set when the holdout was generated with --allow-head-leak: real headline tasks
   * are missing parentSha and their lic fixtures are HEAD-indexed. Downgrades the
   * parentSha guardrail from error to warning so an exploratory (not headline)
   * holdout can still be generated and run. Drop once fixtures are re-frozen from
   * parent SHAs.
   */
  headLeakWaived?: boolean;
  tasks: HoldoutTaskEntry[];
}

const HEADLINE_STRATA = new Set(["S1", "S2", "S3", "S4", "S5"]);
const BASELINE_SOURCE_EXCERPT_TAG = "baseline-starting-file-excerpt";

/** Real-PR task in a headline stratum, not excluded — must be frozen from a
 * parent-SHA worktree to avoid temporal leakage. */
export function isRealHeadlineTask(task: Task): boolean {
  return Boolean(task.tags?.includes("real-emc") && task.stratum && HEADLINE_STRATA.has(task.stratum) && !task.excluded);
}

function hasPastedSourceExcerpt(task: Task): boolean {
  return /# Current source|```(?:tsx?|jsx?|typescript|javascript)?\b/i.test(task.prompt);
}

function hasBaselineExcerptJustification(task: Task): boolean {
  return Boolean(task.tags?.includes(BASELINE_SOURCE_EXCERPT_TAG));
}

export function hashTaskPrompt(task: Task): string {
  return sha256Text(task.prompt);
}

export function hashTaskGroundTruth(task: Task): string | undefined {
  return task.groundTruth ? sha256Text(task.groundTruth.output) : undefined;
}

export function hashTaskRubric(task: Task): string | undefined {
  return task.rubric ? sha256Text(stableJson(task.rubric)) : undefined;
}

function findingLevelForWaiver(manifest: HoldoutManifest): AuditFinding["level"] {
  return manifest.headLeakWaived ? "warning" : "error";
}

function sameJson(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}

function provenanceSnapshot(task: Task): HoldoutTaskEntry["provenance"] | undefined {
  if (!task.provenance) return undefined;
  return {
    ...(task.provenance.mergeSha ? { mergeSha: task.provenance.mergeSha } : {}),
    ...(task.provenance.parentSha ? { parentSha: task.provenance.parentSha } : {}),
    ...(task.provenance.sourceUrl ? { sourceUrl: task.provenance.sourceUrl } : {}),
  };
}

export async function readHoldout(path: string): Promise<HoldoutManifest> {
  return JSON.parse(await readFile(path, "utf8")) as HoldoutManifest;
}

export async function auditHoldout(path: string): Promise<AuditResult> {
  const manifest = await readHoldout(path);
  return validateHoldoutManifest(manifest, {
    licFixtureDir: join(dirname(path), "..", "fixtures", "lic"),
  });
}

export async function validateHoldoutManifest(
  manifest: HoldoutManifest,
  opts: { tasks?: Task[]; licFixtureDir?: string } = {},
): Promise<AuditResult> {
  const findings: AuditFinding[] = [];
  if (!manifest.id) findings.push({ level: "error", message: "holdout missing id" });
  if (!manifest.protocol) findings.push({ level: "error", message: "holdout missing protocol reference" });
  // The active haiku protocol has a lower floor (30) because S7 + saturated are
  // excluded by pre-registration. Other protocols require >= 50 by default.
  const isHaiku = manifest.protocol.includes("pim-vs-lic-haiku");
  const minFloor = isHaiku ? 30 : 50;
  if (manifest.minimumTaskCount < minFloor) {
    findings.push({
      level: "error",
      message: `minimumTaskCount must be at least ${minFloor} for ${isHaiku ? "haiku" : "standard"} headline claims`,
    });
  }
  if (manifest.tasks.length < manifest.minimumTaskCount) {
    // Under the exploratory (head-leak) waiver a sub-minimum count is directional,
    // not headline — matches the claim gate "≥50 real tasks OR label as directional".
    findings.push({
      level: manifest.headLeakWaived ? "warning" : "error",
      message: `holdout has ${manifest.tasks.length} tasks, below minimum ${manifest.minimumTaskCount}${manifest.headLeakWaived ? " (exploratory — not headline-eligible)" : ""}`,
    });
  }

  const byId = new Map((opts.tasks ?? ALL_TASKS).map((task) => [task.id, applyAssignment(task)]));
  if (isHaiku) {
    const primaryClaimTaskCount = new Set(
      manifest.tasks
        .map((entry) => byId.get(entry.id))
        .filter((task): task is Task => Boolean(task))
        .filter((task) => task.stratum && HEADLINE_STRATA.has(task.stratum) && !task.excluded)
        .filter((task) => classifyPromptTier(task) === "realistic-ticket")
        .map((task) => task.id),
    ).size;
    if (primaryClaimTaskCount < manifest.minimumTaskCount) {
      findings.push({
        level: findingLevelForWaiver(manifest),
        message:
          `primary claim has ${primaryClaimTaskCount} realistic-ticket headline tasks, below minimum ${manifest.minimumTaskCount}` +
          `${manifest.headLeakWaived ? " (exploratory — not headline-eligible)" : ""}`,
      });
    }
  }

  const seen = new Set<string>();
  for (const entry of manifest.tasks) {
    if (seen.has(entry.id)) findings.push({ level: "error", message: `duplicate task in holdout: ${entry.id}` });
    seen.add(entry.id);
    const task = byId.get(entry.id);
    if (!task) {
      findings.push({ level: "error", message: `unknown task: ${entry.id}` });
      continue;
    }
    if (entry.promptHash !== hashTaskPrompt(task)) {
      findings.push({ level: "error", message: `prompt hash drift for ${entry.id}` });
    }
    const groundTruthHash = hashTaskGroundTruth(task);
    if (entry.groundTruthHash !== groundTruthHash) {
      findings.push({ level: "error", message: `ground truth hash drift for ${entry.id}` });
    }
    const rubricHash = hashTaskRubric(task);
    if (entry.rubricHash !== rubricHash) {
      findings.push({ level: "error", message: `rubric hash drift for ${entry.id}` });
    }
    if ((isHaiku || entry.stratum !== undefined) && entry.stratum !== task.stratum) {
      findings.push({
        level: "error",
        message: `stratum drift for ${entry.id}: holdout=${entry.stratum ?? "(missing)"} task=${task.stratum ?? "(missing)"}`,
      });
    }
    const promptTier = classifyPromptTier(task);
    if (isHaiku && entry.promptTier === undefined) {
      findings.push({
        level: findingLevelForWaiver(manifest),
        message: `prompt tier snapshot missing for ${entry.id} — tier drift would not invalidate this holdout`,
      });
    } else if (entry.promptTier !== undefined && entry.promptTier !== promptTier) {
      findings.push({
        level: "error",
        message: `prompt tier drift for ${entry.id}: holdout=${entry.promptTier} task=${promptTier}`,
      });
    }
    if (isHaiku && promptTier === "realistic-ticket" && hasPastedSourceExcerpt(task) && !hasBaselineExcerptJustification(task)) {
      findings.push({
        level: findingLevelForWaiver(manifest),
        message:
          `realistic-ticket task ${entry.id} includes pasted source excerpts without ` +
          `\`${BASELINE_SOURCE_EXCERPT_TAG}\` justification; rewrite, re-tier, or justify the baseline excerpt policy`,
      });
    }
    if (entry.asOf !== task.asOf) {
      findings.push({
        level: "error",
        message: `asOf drift for ${entry.id}: holdout=${entry.asOf ?? "(missing)"} task=${task.asOf ?? "(missing)"}`,
      });
    }
    const expectedProvenance = provenanceSnapshot(task);
    if (entry.provenance !== undefined && !sameJson(entry.provenance, expectedProvenance)) {
      findings.push({ level: "error", message: `provenance snapshot drift for ${entry.id}` });
    }
    if (isHaiku && isRealHeadlineTask(task) && !entry.provenance?.parentSha) {
      findings.push({
        level: findingLevelForWaiver(manifest),
        message: `parentSha snapshot missing for real headline task ${entry.id}`,
      });
    }
    const licSeedHash = task.licSeed ? sha256Text(stableJson(task.licSeed)) : undefined;
    if ((isHaiku || entry.licSeedHash !== undefined) && entry.licSeedHash !== licSeedHash) {
      findings.push({ level: "error", message: `lic seed hash drift for ${entry.id}` });
    }
    if (isHaiku && !entry.licFixtureHash) {
      findings.push({ level: "error", message: `lic fixture hash missing for ${entry.id}` });
    }
    if (entry.licFixtureHash && opts.licFixtureDir) {
      try {
        const raw = await readFile(join(opts.licFixtureDir, `${entry.id}.json`), "utf8");
        const parsed = JSON.parse(raw) as { indexSource?: LicIndexSource };
        if (sha256Text(raw) !== entry.licFixtureHash) {
          findings.push({ level: "error", message: `lic fixture hash drift for ${entry.id}` });
        }
        if (entry.licIndexSource !== undefined && parsed.indexSource !== undefined && !sameJson(entry.licIndexSource, parsed.indexSource)) {
          findings.push({ level: "error", message: `lic index source drift for ${entry.id}` });
        }
        const indexSource = parsed.indexSource ?? entry.licIndexSource;
        if (isHaiku && isRealHeadlineTask(task)) {
          if (!indexSource) {
            findings.push({
              level: findingLevelForWaiver(manifest),
              message: `lic fixture for ${entry.id} missing indexSource — cannot prove parent-SHA indexing`,
            });
          } else if (indexSource.kind !== "parentSha") {
            findings.push({
              level: findingLevelForWaiver(manifest),
              message: `lic fixture for ${entry.id} is ${indexSource.kind}-indexed; real headline tasks must be parentSha-indexed`,
            });
          } else if (task.provenance?.parentSha && indexSource.sha !== task.provenance.parentSha) {
            findings.push({
              level: findingLevelForWaiver(manifest),
              message: `lic fixture for ${entry.id} indexed sha ${indexSource.sha} does not match task parentSha ${task.provenance.parentSha}`,
            });
          }
        }
        // Fail closed on stale fixtures that still name the upstream product.
        if (/\bscout\b/i.test(raw)) {
          findings.push({
            level: "error",
            message: `lic fixture for ${entry.id} still names the upstream product ("scout") — run \`pnpm --filter @pim/eval lic-migrate\``,
          });
        }
      } catch (err) {
        findings.push({
          level: "error",
          message: `lic fixture missing for ${entry.id}: ${(err as Error).message}`,
        });
      }
    }
    if (task.tags?.includes("real-emc") && !entry.asOf && !task.asOf) {
      findings.push({ level: "error", message: `real-emc task missing asOf cutoff: ${entry.id}` });
    }
    // Real headline tasks must be frozen from a parent SHA, not repo HEAD. Without
    // parentSha the lic fixture is HEAD-indexed and can leak the PR's own answer.
    if (isHaiku && isRealHeadlineTask(task) && !task.provenance?.parentSha) {
      findings.push({
        level: findingLevelForWaiver(manifest),
        message: `real headline task ${entry.id} lacks provenance.parentSha — lic fixture is HEAD-indexed (temporal leakage). Re-freeze from the parent SHA.`,
      });
    }
    if (!entry.objectiveClass) {
      findings.push({ level: "warning", message: `task missing objective classification snapshot: ${entry.id}` });
    }
  }

  // Per-stratum floor (#7): the headline claim shouldn't rest on one or two tasks
  // in a stratum. Surface thin strata as warnings (target ≥ 8 per S1–S5).
  if (isHaiku) {
    const PER_STRATUM_TARGET = 8;
    const counts: Record<string, number> = {};
    for (const entry of manifest.tasks) {
      if (entry.stratum && ["S1", "S2", "S3", "S4", "S5"].includes(entry.stratum)) {
        counts[entry.stratum] = (counts[entry.stratum] ?? 0) + 1;
      }
    }
    for (const stratum of ["S1", "S2", "S3", "S4", "S5"]) {
      const n = counts[stratum] ?? 0;
      if (n < PER_STRATUM_TARGET) {
        findings.push({ level: "warning", message: `stratum ${stratum} has ${n} tasks (target ≥ ${PER_STRATUM_TARGET}) — thin for a per-stratum read` });
      }
    }
  }

  return { ok: findings.every((f) => f.level !== "error"), findings };
}

export function makeHoldoutEntry(task: Task, opts: { licFixtureHash?: string; licIndexSource?: LicIndexSource } = {}): HoldoutTaskEntry {
  return {
    id: task.id,
    promptHash: hashTaskPrompt(task),
    groundTruthHash: hashTaskGroundTruth(task),
    rubricHash: hashTaskRubric(task),
    asOf: task.asOf,
    promptTier: classifyPromptTier(task),
    stratum: task.stratum,
    provenance: provenanceSnapshot(task),
    licFixtureHash: opts.licFixtureHash,
    licIndexSource: opts.licIndexSource,
    licSeedHash: task.licSeed ? sha256Text(stableJson(task.licSeed)) : undefined,
    objectiveClass: {
      taskType: task.type,
      hasGroundTruth: Boolean(task.groundTruth),
      promptChars: task.prompt.length,
      groundTruthChars: task.groundTruth?.output.length ?? 0,
      sourceTagSnapshot: task.tags ?? [],
    },
  };
}
