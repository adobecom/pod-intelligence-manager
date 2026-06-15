import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "../tasks/types.js";

/**
 * Executable patch judge — buildability check, scored SEPARATELY from the rubric.
 *
 * Real-PR "content" tasks ask the model for a unified diff. The rubric judge only
 * scores similarity to the hidden merged patch; it cannot tell whether the diff
 * would actually apply. This judge applies the candidate diff to the task's
 * parent-SHA worktree and (optionally) typechecks, so a plausible-but-unappliable
 * diff is caught and a clean apply is rewarded — independent of rubric similarity.
 *
 * It is intentionally NOT wired into the main run loop: it needs the product repo
 * checked out locally, which is unavailable in CI. Run it post-hoc via
 * `src/cli/judge-patches.ts`. When the repo or a parent SHA is missing it returns
 * `skipped` rather than failing, so it never silently penalizes a task.
 */
export interface PatchJudgeResult {
  /** Whether the model output contained an extractable unified diff. */
  diffExtracted: boolean;
  /** True only when the diff applied cleanly (the buildability signal). */
  applies: boolean;
  /** Whether the apply check actually ran (false when skipped). */
  checked: boolean;
  /** True when prerequisites were missing (no diff, no parentSha, no repo). */
  skipped: boolean;
  /** Buildability score in 0..1: 1 = applies (and typechecks if requested), else 0. */
  buildability: number;
  reason: string;
  typecheck?: { ran: boolean; ok: boolean; output: string };
}

export interface PatchJudgeOptions {
  /** Path to the product repo (a git checkout). Defaults to $EMC_REPO. */
  emcRepo?: string;
  /** Base dir for parent-SHA worktrees. Defaults to $EMC_WORKTREE_BASE. */
  worktreeBase?: string;
  /** Run `npm run type-check` in the worktree after applying. Slow; off by default. */
  typecheck?: boolean;
  /** Override the typecheck command (array form). */
  typecheckCmd?: string[];
}

/**
 * Pull a unified diff out of a model response: prefer a fenced ```diff/```patch
 * block, then any fenced block that looks like a diff, then a raw diff body.
 */
export function extractUnifiedDiff(text: string): string | null {
  const fences = [...text.matchAll(/```(?:diff|patch)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  for (const body of fences) {
    if (looksLikeDiff(body)) return normalizeDiff(body);
  }
  // No fence — accept a raw diff if the whole response looks like one.
  if (looksLikeDiff(text)) return normalizeDiff(text);
  return null;
}

function looksLikeDiff(body: string): boolean {
  return /^(diff --git |--- |\+\+\+ |@@ )/m.test(body) && /^@@ /m.test(body);
}

function normalizeDiff(body: string): string {
  const trimmed = body.replace(/\s+$/, "");
  return trimmed.endsWith("\n") ? trimmed : trimmed + "\n";
}

function repoFromEnv(opts: PatchJudgeOptions): string | undefined {
  return opts.emcRepo ?? process.env.EMC_REPO ?? undefined;
}

function dirExists(path: string): boolean {
  return spawnSync("test", ["-d", path]).status === 0;
}

function ensureWorktree(repo: string, sha: string, base: string): string | null {
  const path = join(base, `emc-${sha.slice(0, 12)}`);
  if (dirExists(path)) return path;
  const res = spawnSync("git", ["-C", repo, "worktree", "add", "--detach", path, sha], {
    encoding: "utf8",
  });
  if (res.status !== 0) return null;
  return path;
}

export function judgePatch(task: Task, output: string, opts: PatchJudgeOptions = {}): PatchJudgeResult {
  const diff = extractUnifiedDiff(output);
  if (!diff) {
    return { diffExtracted: false, applies: false, checked: false, skipped: true, buildability: 0, reason: "no unified diff in output" };
  }

  const repo = repoFromEnv(opts);
  const parentSha = task.provenance?.parentSha;
  if (!repo || !dirExists(repo)) {
    return { diffExtracted: true, applies: false, checked: false, skipped: true, buildability: 0, reason: "product repo unavailable (set EMC_REPO)" };
  }
  if (!parentSha) {
    return { diffExtracted: true, applies: false, checked: false, skipped: true, buildability: 0, reason: `no parentSha for ${task.id}` };
  }

  const base = opts.worktreeBase ?? process.env.EMC_WORKTREE_BASE ?? join(tmpdir(), "emc-patch-judge");
  spawnSync("mkdir", ["-p", base]);
  const worktree = ensureWorktree(repo, parentSha, base);
  if (!worktree) {
    return { diffExtracted: true, applies: false, checked: false, skipped: true, buildability: 0, reason: `could not create worktree at ${parentSha}` };
  }

  const tmp = mkdtempSync(join(tmpdir(), "patch-"));
  const patchFile = join(tmp, "candidate.diff");
  writeFileSync(patchFile, diff);
  try {
    // Reset the worktree to a clean parent-SHA state before each apply.
    spawnSync("git", ["-C", worktree, "checkout", "--", "."], { encoding: "utf8" });
    spawnSync("git", ["-C", worktree, "clean", "-fd"], { encoding: "utf8" });

    const check = spawnSync("git", ["-C", worktree, "apply", "--check", "-p1", patchFile], { encoding: "utf8" });
    if (check.status !== 0) {
      // Retry with whitespace tolerance before declaring non-appliable.
      const lenient = spawnSync(
        "git",
        ["-C", worktree, "apply", "--check", "-p1", "--ignore-whitespace", patchFile],
        { encoding: "utf8" },
      );
      if (lenient.status !== 0) {
        return {
          diffExtracted: true,
          applies: false,
          checked: true,
          skipped: false,
          buildability: 0,
          reason: `git apply --check failed: ${(check.stderr || lenient.stderr || "").trim().slice(0, 300)}`,
        };
      }
    }

    if (!opts.typecheck) {
      return { diffExtracted: true, applies: true, checked: true, skipped: false, buildability: 1, reason: "diff applies cleanly" };
    }

    // Apply for real, then typecheck.
    const apply = spawnSync("git", ["-C", worktree, "apply", "-p1", "--ignore-whitespace", patchFile], { encoding: "utf8" });
    if (apply.status !== 0) {
      return { diffExtracted: true, applies: true, checked: true, skipped: false, buildability: 0.5, reason: "applied in --check but real apply failed" };
    }
    const cmd = opts.typecheckCmd ?? ["npm", "run", "type-check"];
    const tc = spawnSync(cmd[0], cmd.slice(1), { cwd: worktree, encoding: "utf8", timeout: 300_000 });
    const tcOut = ((tc.stdout ?? "") + (tc.stderr ?? "")).slice(-2000);
    const ok = tc.status === 0;
    return {
      applies: true,
      diffExtracted: true,
      checked: true,
      skipped: false,
      buildability: ok ? 1 : 0.5,
      reason: ok ? "diff applies and typechecks" : "diff applies but typecheck failed",
      typecheck: { ran: true, ok, output: tcOut },
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    // Leave the worktree clean for reuse by the next task.
    spawnSync("git", ["-C", worktree, "checkout", "--", "."], { encoding: "utf8" });
    spawnSync("git", ["-C", worktree, "clean", "-fd"], { encoding: "utf8" });
  }
}
