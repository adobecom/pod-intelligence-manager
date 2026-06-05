import "../load-env.js";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ALL_TASKS } from "../tasks/index.js";
import { applyAssignment } from "../tasks/stratification.js";
import type { Task } from "../tasks/types.js";
import { judgePatch, type PatchJudgeResult } from "../judges/patch.js";

/**
 * Post-hoc executable patch judge over a completed run. Applies each candidate's
 * unified diff to the task's parent-SHA worktree and scores buildability, written
 * to `<run-dir>/patch-judge.jsonl` and summarized per arm. This is separate from
 * the rubric score so reviewers can see "passed the rubric but the diff does not
 * apply" cases. Requires the product repo locally (EMC_REPO); otherwise rows are
 * recorded as skipped.
 *
 * Usage:
 *   pnpm --filter @pim/eval judge-patches -- --run-dir=runs/<id> [--emc-repo=/path] [--typecheck]
 */
function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((a) => a.startsWith(prefix))?.slice(prefix.length);
}
function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

interface OutputRow {
  taskId: string;
  arm: string;
  seed: number;
  output: string;
  judge: { passed: boolean; score: number };
}

async function readJsonl<T>(path: string): Promise<T[]> {
  const raw = await readFile(path, "utf8").catch(() => "");
  return raw.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as T);
}

function taskMap(): Map<string, Task> {
  return new Map(ALL_TASKS.map((t) => [t.id, applyAssignment(t)]));
}

async function main(): Promise<void> {
  const runDir = argValue("run-dir") ?? argValue("run-id");
  if (!runDir) throw new Error("--run-dir=<run artifact dir> is required");
  const emcRepo = argValue("emc-repo");
  const typecheck = hasFlag("typecheck");

  const outputs = await readJsonl<OutputRow>(join(runDir, "outputs.jsonl"));
  const tasks = taskMap();

  const results: Array<OutputRow & { patch: PatchJudgeResult }> = [];
  for (const row of outputs) {
    const task = tasks.get(row.taskId);
    if (!task || task.type !== "content") continue; // patch judge is for diff-output tasks
    const patch = judgePatch(task, row.output, { emcRepo, typecheck });
    results.push({ ...row, patch });
    const tag = patch.skipped ? "skip" : patch.applies ? "APPLIES" : "FAILS";
    console.log(`[judge-patches] ${row.arm.padEnd(22)} ${row.taskId.padEnd(40)} seed=${row.seed} ${tag} (${patch.reason})`);
  }

  await writeFile(
    join(runDir, "patch-judge.jsonl"),
    results.map((r) => JSON.stringify({ taskId: r.taskId, arm: r.arm, seed: r.seed, patch: r.patch })).join("\n") + (results.length ? "\n" : ""),
  );

  // Per-arm buildability summary over rows that actually ran.
  const arms = Array.from(new Set(results.map((r) => r.arm)));
  console.log("\n=== Patch buildability by arm (checked rows only) ===");
  for (const arm of arms) {
    const checked = results.filter((r) => r.arm === arm && r.patch.checked);
    const applied = checked.filter((r) => r.patch.applies).length;
    const skipped = results.filter((r) => r.arm === arm && r.patch.skipped).length;
    const denom = checked.length || 1;
    console.log(`  ${arm.padEnd(22)} applies ${applied}/${checked.length} (${((applied / denom) * 100).toFixed(0)}%)  skipped=${skipped}`);
  }
  const anyChecked = results.some((r) => r.patch.checked);
  if (!anyChecked) {
    console.log("  (all rows skipped — set EMC_REPO to a local product checkout to enable the patch judge)");
  }
  console.log(`\n[judge-patches] wrote ${join(runDir, "patch-judge.jsonl")} (${results.length} rows)`);
}

main().catch((err) => {
  console.error("[judge-patches] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
