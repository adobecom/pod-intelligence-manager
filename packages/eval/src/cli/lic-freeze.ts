import "../load-env.js";
import { mkdir, writeFile, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import type { Task, Stratum } from "../tasks/types.js";
import { ALL_TASKS } from "../tasks/index.js";
import { applyAssignmentsToAll, headlineTasks } from "../tasks/stratification.js";
import { deriveLicFixtureQuality, type LicFixtureQuality } from "../rigor/lic-quality.js";

const __filename = fileURLToPath(import.meta.url);
const FIXTURES_DIR = join(dirname(__filename), "..", "..", "fixtures", "lic");

const DEFAULT_EMC_REPO = "/Users/rkhan/emcV2/EMC";
const DEFAULT_WORKTREE_BASE = "/Users/rkhan/emcV2-lic-worktrees";
const RENDERED_BLOCK_BUDGET = 4000;

const LIC_BIN = process.env.LIC_BIN ?? "lic";

interface FreezeArgs {
  taskFilter: "all" | "headline" | string[];
  worktreeBase: string;
  emcRepo: string;
  headOnly: boolean;
  dryRun: boolean;
  refresh: boolean;
}

interface LicCall {
  tool: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  durationMs: number;
  output: string;
}

interface LicFixture {
  taskId: string;
  stratum?: Stratum;
  recipe: string[];
  licDaemonVersion?: string;
  indexSource: { kind: "head"; repo: string } | { kind: "parentSha"; sha: string; worktree: string };
  generatedAt: string;
  calls: LicCall[];
  renderedBlock: string;
  renderedBlockHash: string;
  quality?: LicFixtureQuality;
}

function parseArgs(): FreezeArgs {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const eq = argv.find((a) => a.startsWith(`--${flag}=`));
    if (eq) return eq.slice(flag.length + 3);
    const idx = argv.indexOf(`--${flag}`);
    if (idx >= 0 && idx + 1 < argv.length && !argv[idx + 1].startsWith("--")) {
      return argv[idx + 1];
    }
    return undefined;
  };
  const has = (flag: string): boolean => argv.includes(`--${flag}`);

  const taskArg = get("task") ?? "headline";
  const taskFilter: "all" | "headline" | string[] =
    taskArg === "all" ? "all" : taskArg === "headline" ? "headline" : taskArg.split(",");

  return {
    taskFilter,
    worktreeBase: get("worktree-base") ?? DEFAULT_WORKTREE_BASE,
    emcRepo: get("emc-repo") ?? DEFAULT_EMC_REPO,
    headOnly: has("head-only"),
    dryRun: has("dry-run"),
    refresh: has("refresh"),
  };
}

function selectTasks(args: FreezeArgs): Task[] {
  // Apply stratum/licSeed/parentSha/excluded assignments for EVERY filter, so an
  // explicit --task=<id> freeze sees the same parentSha the headline run does.
  // (Previously --task and --all returned raw tasks with no parentSha, silently
  // freezing real tasks from HEAD.)
  if (args.taskFilter === "headline") return headlineTasks(ALL_TASKS);
  const assigned = applyAssignmentsToAll(ALL_TASKS);
  if (args.taskFilter === "all") return assigned;
  return assigned.filter((t) => (args.taskFilter as string[]).includes(t.id));
}

const HEADLINE_STRATA = new Set(["S1", "S2", "S3", "S4", "S5"]);

/** Real-PR task in a headline stratum (S1–S5), not excluded. These must be frozen
 * from a parent-SHA worktree, never repo HEAD, or the comparator can see the
 * answer the PR introduced. */
function isRealHeadlineTask(task: Task): boolean {
  return Boolean(task.tags?.includes("real-emc") && task.stratum && HEADLINE_STRATA.has(task.stratum) && !task.excluded);
}

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

function worktreePath(args: FreezeArgs, parentSha: string): string {
  return join(args.worktreeBase, `emc-${shortSha(parentSha)}`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function ensureWorktree(args: FreezeArgs, parentSha: string): string {
  const path = worktreePath(args, parentSha);
  const existsSync = spawnSync("test", ["-d", path]);
  if (existsSync.status === 0) return path;
  execFileSync("git", ["-C", args.emcRepo, "worktree", "add", "--detach", path, parentSha], {
    stdio: "inherit",
  });
  return path;
}

function licAttachIfNeeded(repoPath: string): void {
  const list = spawnSync(LIC_BIN, ["list"], { encoding: "utf8" });
  const stdout = list.stdout ?? "";
  if (stdout.includes(repoPath)) return;
  execFileSync(LIC_BIN, ["attach", repoPath], { stdio: "inherit" });
}

function licWaitIndexed(repoPath: string, timeoutMs = 5 * 60_000): void {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = spawnSync(LIC_BIN, ["status"], { encoding: "utf8" });
    const text = res.stdout ?? "";
    const re = new RegExp(`${repoPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} - (\\w+) \\((\\d+)/(\\d+)`);
    const m = re.exec(text);
    if (m) {
      const [, state, doneStr, totalStr] = m;
      const done = Number.parseInt(doneStr, 10);
      const total = Number.parseInt(totalStr, 10);
      if (state === "Watching" && done === total) return;
    }
    const wait = spawnSync("sleep", ["5"]);
    if (wait.status !== 0) break;
  }
  throw new Error(`lic indexing timeout for ${repoPath}`);
}

function runLic(tool: string, licArgs: string[], cwd: string): LicCall {
  const startedAt = Date.now();
  const result = spawnSync(LIC_BIN, [tool, ...licArgs], {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 90_000,
  });
  return {
    tool,
    args: licArgs,
    cwd,
    exitCode: result.status,
    durationMs: Date.now() - startedAt,
    output: (result.stdout ?? "") + (result.stderr ? `\n[stderr]\n${result.stderr}` : ""),
  };
}

interface RecipeContext {
  task: Task;
  repoPath: string;
}

interface RecipeResult {
  recipe: string[];
  calls: LicCall[];
}

function recipe(ctx: RecipeContext): RecipeResult {
  const t = ctx.task;
  const stratum = t.stratum;
  const seed = t.licSeed ?? {};
  const repoArgs = ["-r", ctx.repoPath];
  const calls: LicCall[] = [];
  const recipeNames: string[] = [];

  const symbol = seed.symbol ?? "";
  const query = seed.investigateQuery ?? t.prompt.split("\n")[0].replace(/^#\s*/, "").slice(0, 120);

  switch (stratum) {
    case "S1": {
      recipeNames.push("search", "explain-symbol");
      calls.push(runLic("search", [...repoArgs, "-l", "5", query], ctx.repoPath));
      if (symbol) calls.push(runLic("explain-symbol", [...repoArgs, symbol], ctx.repoPath));
      break;
    }
    case "S2": {
      recipeNames.push("find-references", "call-graph", "explain-symbol");
      if (symbol) calls.push(runLic("find-references", [...repoArgs, symbol], ctx.repoPath));
      if (symbol) calls.push(runLic("call-graph", [...repoArgs, "--direction", "callers", symbol], ctx.repoPath));
      if (symbol) calls.push(runLic("explain-symbol", [...repoArgs, symbol], ctx.repoPath));
      break;
    }
    case "S3": {
      recipeNames.push("keyword-search", "regex-search", "explain-symbol");
      calls.push(runLic("keyword-search", [...repoArgs, "-l", "5", query], ctx.repoPath));
      if (symbol) calls.push(runLic("explain-symbol", [...repoArgs, symbol], ctx.repoPath));
      break;
    }
    case "S4": {
      recipeNames.push("investigate.start", "memory.search");
      calls.push(runLic("investigate", ["start", ...repoArgs, query], ctx.repoPath));
      calls.push(runLic("memory", ["search", ...repoArgs, query], ctx.repoPath));
      break;
    }
    case "S5": {
      recipeNames.push("keyword-search", "find-references", "explain-symbol");
      calls.push(runLic("keyword-search", [...repoArgs, "-l", "5", query], ctx.repoPath));
      if (symbol) calls.push(runLic("find-references", [...repoArgs, symbol], ctx.repoPath));
      if (symbol) calls.push(runLic("explain-symbol", [...repoArgs, symbol], ctx.repoPath));
      break;
    }
    case "S6": {
      if (symbol) {
        recipeNames.push("impact", "find-references", "call-graph");
        calls.push(runLic("impact", [...repoArgs, symbol], ctx.repoPath));
        calls.push(runLic("find-references", [...repoArgs, symbol], ctx.repoPath));
        calls.push(runLic("call-graph", [...repoArgs, "--direction", "callees", symbol], ctx.repoPath));
      } else {
        // No symbol seed: fall back to investigate + search to give the agent
        // something rather than an empty block.
        recipeNames.push("investigate.start", "search");
        calls.push(runLic("investigate", ["start", ...repoArgs, query], ctx.repoPath));
        calls.push(runLic("search", [...repoArgs, "-l", "8", query], ctx.repoPath));
      }
      break;
    }
    default: {
      recipeNames.push("search");
      calls.push(runLic("search", [...repoArgs, "-l", "5", query], ctx.repoPath));
    }
  }

  return { recipe: recipeNames, calls };
}

/**
 * Replace the upstream tool's product name so eval artifacts say only "locally
 * indexed code" / "lic". Applied to rendered headers, recorded version strings,
 * and captured tool self-references (e.g. cache paths, "run `… memory init`").
 */
export function sanitizeProductName(text: string): string {
  return text.replace(/scout/g, "lic").replace(/Scout/g, "Lic");
}

export function renderBlock(task: Pick<Task, "id" | "stratum">, calls: LicCall[]): string {
  const lines: string[] = [];
  lines.push(`# Lic Context — task: ${task.id}`);
  lines.push(`_Stratum: ${task.stratum ?? "unknown"}._`);
  lines.push("");
  for (const c of calls) {
    lines.push(`## lic ${c.tool} ${c.args.filter((a) => !a.startsWith("/")).join(" ")}`);
    const trimmed = sanitizeProductName(c.output.trim()).slice(0, 2000);
    lines.push("```");
    lines.push(trimmed || "(no output)");
    lines.push("```");
    lines.push("");
  }
  const full = lines.join("\n");
  if (full.length <= RENDERED_BLOCK_BUDGET) return full;
  return full.slice(0, RENDERED_BLOCK_BUDGET - 50) + "\n\n_[truncated to budget]_\n";
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function getLicVersion(): string | undefined {
  const res = spawnSync(LIC_BIN, ["--version"], { encoding: "utf8" });
  const raw = (res.stdout ?? "").trim();
  return raw ? sanitizeProductName(raw) : undefined;
}

async function freezeOne(task: Task, args: FreezeArgs): Promise<LicFixture | null> {
  let repoPath: string;
  let indexSource: LicFixture["indexSource"];
  const parentSha = task.provenance?.parentSha;

  // Parent-SHA worktree for ANY task that has one (not just S2) — that is the
  // point-in-time index that cannot see the merged PR's code.
  if (parentSha && !args.headOnly) {
    repoPath = args.dryRun ? worktreePath(args, parentSha) : ensureWorktree(args, parentSha);
    if (!args.dryRun) {
      licAttachIfNeeded(repoPath);
      licWaitIndexed(repoPath);
    }
    indexSource = { kind: "parentSha", sha: parentSha, worktree: repoPath };
  } else {
    // Refuse to freeze a real headline task from HEAD: it would let the comparator
    // see the code the task's own PR introduced. --head-only is the explicit
    // debug override.
    if (isRealHeadlineTask(task) && !args.headOnly) {
      throw new Error(
        `real headline task ${task.id} (stratum ${task.stratum}) has no provenance.parentSha; ` +
          `refusing to freeze from HEAD (temporal leakage). Add parentSha in src/tasks/stratification.ts, ` +
          `or pass --head-only to override for debugging only.`,
      );
    }
    repoPath = args.emcRepo;
    indexSource = { kind: "head", repo: args.emcRepo };
  }

  if (args.dryRun) {
    console.log(
      `[dry-run] ${task.id} stratum=${task.stratum ?? "-"} indexSource=${indexSource.kind}${
        indexSource.kind === "parentSha" ? `:${shortSha(indexSource.sha)}` : ""
      } repo=${repoPath}`,
    );
    return null;
  }

  const { recipe: recipeNames, calls } = recipe({ task, repoPath });
  const sanitizedCalls = calls.map((call) => ({
    ...call,
    cwd: sanitizeProductName(call.cwd),
    args: call.args.map((arg) => sanitizeProductName(arg)),
    output: sanitizeProductName(call.output),
  }));
  const rendered = renderBlock(task, sanitizedCalls);

  const fixture: LicFixture = {
    taskId: task.id,
    stratum: task.stratum,
    recipe: recipeNames,
    licDaemonVersion: getLicVersion(),
    indexSource,
    generatedAt: new Date().toISOString(),
    calls: sanitizedCalls,
    renderedBlock: rendered,
    renderedBlockHash: sha256Hex(rendered),
  };
  fixture.quality = deriveLicFixtureQuality(task, fixture);

  await mkdir(FIXTURES_DIR, { recursive: true });
  const outPath = join(FIXTURES_DIR, `${task.id}.json`);
  await writeFile(outPath, JSON.stringify(fixture, null, 2));
  console.log(`[lic-freeze] wrote ${outPath} (${rendered.length} chars, hash ${fixture.renderedBlockHash})`);
  return fixture;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const tasks = selectTasks(args);
  console.log(`[lic-freeze] ${tasks.length} task(s) selected (filter=${JSON.stringify(args.taskFilter)})`);

  if (!args.dryRun) await mkdir(FIXTURES_DIR, { recursive: true });

  let ok = 0;
  let failed = 0;
  for (const t of tasks) {
    if (!t.stratum) {
      console.warn(`[lic-freeze] skip ${t.id}: no stratum assigned`);
      continue;
    }
    const outPath = join(FIXTURES_DIR, `${t.id}.json`);
    if (!args.refresh && !args.dryRun && (await exists(outPath))) {
      console.log(`[lic-freeze] skip ${t.id}: fixture exists (pass --refresh to overwrite)`);
      ok++;
      continue;
    }
    try {
      await freezeOne(t, args);
      ok++;
    } catch (err) {
      failed++;
      console.error(`[lic-freeze] FAILED ${t.id}: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`[lic-freeze] done: ${ok} ok, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

// Only run when invoked directly — this module also exports helpers
// (renderBlock, sanitizeProductName, sha256Hex) imported by lic-migrate.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("[lic-freeze] fatal:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
