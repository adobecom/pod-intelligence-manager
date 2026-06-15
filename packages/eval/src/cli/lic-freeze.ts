import "../load-env.js";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import type { Task, Stratum } from "../tasks/types.js";
import { ALL_TASKS } from "../tasks/index.js";
import { applyAssignmentsToAll, headlineTasks } from "../tasks/stratification.js";
import {
  deriveLicFixtureQuality,
  describeLicFixtureQualityGate,
  isLicFixtureQualityReady,
  type LicFixtureQuality,
} from "../rigor/lic-quality.js";

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
  allowWeak: boolean;
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
    allowWeak: has("allow-weak") || has("allow-weak-lic"),
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

function runLic(tool: string, licArgs: string[], cwd: string, timeoutMs = 90_000): LicCall {
  const startedAt = Date.now();
  const result = spawnSync(LIC_BIN, [tool, ...licArgs], {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: timeoutMs,
  });
  const diagnostics = [
    result.error ? `[spawn error]\n${result.error.message}` : undefined,
    result.signal ? `[signal]\n${result.signal}` : undefined,
  ].filter(Boolean);
  return {
    tool,
    args: licArgs,
    cwd,
    exitCode: result.status,
    durationMs: Date.now() - startedAt,
    output: [
      result.stdout ?? "",
      result.stderr ? `[stderr]\n${result.stderr}` : "",
      ...diagnostics,
    ].filter(Boolean).join("\n"),
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

const memoryPrepared = new Set<string>();

function prepareMemoryForSearch(repoPath: string): RecipeResult {
  if (memoryPrepared.has(repoPath)) return { recipe: [], calls: [] };
  const calls: LicCall[] = [];
  const recipeNames: string[] = [];

  recipeNames.push("memory.stats");
  const status = runLic("memory", ["stats", repoPath], repoPath);
  calls.push(status);

  const needsInit =
    status.exitCode !== 0 ||
    /not initiali[sz]ed|memory bank not initiali[sz]ed|run .*memory init/i.test(status.output);
  if (needsInit) {
    recipeNames.push("memory.init");
    calls.push(runLic("memory", ["init", repoPath], repoPath, 10 * 60_000));
  }

  memoryPrepared.add(repoPath);
  return { recipe: recipeNames, calls };
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
      const memory = prepareMemoryForSearch(ctx.repoPath);
      recipeNames.unshift(...memory.recipe);
      calls.push(...memory.calls);
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

function broadenRecipe(ctx: RecipeContext, existingCalls: LicCall[]): RecipeResult {
  const t = ctx.task;
  const seed = t.licSeed ?? {};
  const repoArgs = ["-r", ctx.repoPath];
  const symbol = seed.symbol ?? "";
  const query = seed.investigateQuery ?? t.prompt.split("\n")[0].replace(/^#\s*/, "").slice(0, 120);
  const calls: LicCall[] = [];
  const recipeNames: string[] = [];
  const seen = new Set(existingCalls.map((call) => `${call.tool}\0${call.args.join("\0")}`));

  const add = (name: string, tool: string, args: string[]): void => {
    const key = `${tool}\0${args.join("\0")}`;
    if (seen.has(key)) return;
    seen.add(key);
    recipeNames.push(name);
    calls.push(runLic(tool, args, ctx.repoPath));
  };

  if (symbol) {
    add("find-references.expanded", "find-references", [...repoArgs, symbol]);
    add("call-graph.callers.expanded", "call-graph", [...repoArgs, "--direction", "callers", symbol]);
    add("explain-symbol.expanded", "explain-symbol", [...repoArgs, symbol]);
  }
  if (query) {
    add("search.expanded", "search", [...repoArgs, "-l", "10", query]);
    add("keyword-search.expanded", "keyword-search", [...repoArgs, "-l", "10", query]);
    add("investigate.start.expanded", "investigate", ["start", ...repoArgs, query]);
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

function ensureLicBinaryAvailable(): void {
  const res = spawnSync(LIC_BIN, ["--version"], { encoding: "utf8" });
  if (res.error) {
    throw new Error(
      `LIC_BIN=${LIC_BIN} is not executable: ${res.error.message}. ` +
        `Install the local LIC CLI or set LIC_BIN=<path-or-command> before running lic-freeze.`,
    );
  }
  if (res.status !== 0) {
    const stderr = (res.stderr ?? "").trim();
    throw new Error(
      `LIC_BIN=${LIC_BIN} --version failed with exit ${res.status}${stderr ? `: ${stderr}` : ""}`,
    );
  }
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

  let { recipe: recipeNames, calls } = recipe({ task, repoPath });
  const sanitizedCalls = calls.map((call) => ({
    ...call,
    cwd: sanitizeProductName(call.cwd),
    args: call.args.map((arg) => sanitizeProductName(arg)),
    output: sanitizeProductName(call.output),
  }));
  let rendered = renderBlock(task, sanitizedCalls);

  let fixture: LicFixture = {
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
  if (!isLicFixtureQualityReady(fixture.quality)) {
    console.warn(`[lic-freeze] ${task.id}: ${describeLicFixtureQualityGate(task.id, fixture.quality)}; broadening retrieval once`);
    const broadened = broadenRecipe({ task, repoPath }, calls);
    if (broadened.calls.length > 0) {
      recipeNames = [...recipeNames, ...broadened.recipe];
      calls = [...calls, ...broadened.calls];
      const allSanitizedCalls = calls.map((call) => ({
        ...call,
        cwd: sanitizeProductName(call.cwd),
        args: call.args.map((arg) => sanitizeProductName(arg)),
        output: sanitizeProductName(call.output),
      }));
      rendered = renderBlock(task, allSanitizedCalls);
      fixture = {
        ...fixture,
        recipe: recipeNames,
        calls: allSanitizedCalls,
        renderedBlock: rendered,
        renderedBlockHash: sha256Hex(rendered),
      };
      fixture.quality = deriveLicFixtureQuality(task, fixture);
    }
  }
  if (!isLicFixtureQualityReady(fixture.quality) && !args.allowWeak) {
    throw new Error(
      `${describeLicFixtureQualityGate(task.id, fixture.quality)}. ` +
        `Fix the LIC seed/index/memory setup and re-run, or pass --allow-weak for diagnostics-only fixtures.`,
    );
  }
  if (!isLicFixtureQualityReady(fixture.quality)) {
    console.warn(`[lic-freeze] WARNING ${task.id}: writing diagnostics-only fixture with signal=${fixture.quality?.signal}`);
  }

  await mkdir(FIXTURES_DIR, { recursive: true });
  const outPath = join(FIXTURES_DIR, `${task.id}.json`);
  await writeFile(outPath, JSON.stringify(fixture, null, 2));
  console.log(`[lic-freeze] wrote ${outPath} (${rendered.length} chars, hash ${fixture.renderedBlockHash}, quality ${fixture.quality?.signal ?? "unknown"})`);
  return fixture;
}

async function readExistingQuality(task: Task, path: string): Promise<LicFixtureQuality | undefined> {
  const raw = await readFile(path, "utf8");
  const fixture = JSON.parse(raw) as LicFixture;
  return deriveLicFixtureQuality(task, fixture);
}

async function main(): Promise<void> {
  const args = parseArgs();
  const tasks = selectTasks(args);
  console.log(`[lic-freeze] ${tasks.length} task(s) selected (filter=${JSON.stringify(args.taskFilter)})`);

  if (!args.dryRun) ensureLicBinaryAvailable();
  if (!args.dryRun) await mkdir(FIXTURES_DIR, { recursive: true });

  let ok = 0;
  let failed = 0;
  for (const t of tasks) {
    if (!t.stratum) {
      console.warn(`[lic-freeze] skip ${t.id}: no stratum assigned`);
      continue;
    }
    const outPath = join(FIXTURES_DIR, `${t.id}.json`);
    try {
      if (!args.refresh && !args.dryRun && (await exists(outPath))) {
        const quality = await readExistingQuality(t, outPath);
        if (!isLicFixtureQualityReady(quality) && !args.allowWeak) {
          throw new Error(
            `existing fixture failed quality gate: ${describeLicFixtureQualityGate(t.id, quality)}. ` +
              `Pass --refresh to regenerate, or --allow-weak for diagnostics-only fixtures.`,
          );
        }
        console.log(`[lic-freeze] skip ${t.id}: fixture exists (quality ${quality?.signal ?? "unknown"}; pass --refresh to overwrite)`);
        ok++;
        continue;
      }
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
