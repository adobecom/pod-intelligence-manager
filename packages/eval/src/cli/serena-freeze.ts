import "../load-env.js";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Task } from "../tasks/types.js";
import { ALL_TASKS } from "../tasks/index.js";
import { KG_FUTURE_20_TASK_IDS } from "../tasks/task-sets.js";
import { applyAssignmentsToAll, headlineTasks } from "../tasks/stratification.js";
import { connectSerena, preflightSerenaEnv, type SerenaClientHandle } from "../serena/mcp-client.js";
import { deriveSerenaSeed, runRecipe } from "../serena/recipes.js";
import { renderSerenaBlock, sha256Hex } from "../serena/render.js";
import { TRACK_A_ALLOWLIST, TRACK_A_DENYLIST } from "../serena/tools.js";
import type { SerenaContextFixture, SerenaIndexSource, SerenaSeed } from "../serena/types.js";
import {
  deriveSerenaFixtureQuality,
  describeSerenaFixtureQualityGate,
  isSerenaFixtureQualityReady,
} from "../rigor/serena-quality.js";

const __filename = fileURLToPath(import.meta.url);
const PKG_ROOT = join(dirname(__filename), "..", "..");
const FIXTURES_DIR = join(PKG_ROOT, "fixtures", "serena");

const DEFAULT_EMC_REPO = "/Users/rkhan/emcV2/EMC";
// Reuse the LIC parent-SHA worktrees by default: they are content-identical
// detached checkouts, and Serena state is redirected to SERENA_HOME, so it never
// pollutes them. Override with --worktree-base to keep Serena worktrees separate.
const DEFAULT_WORKTREE_BASE = "/Users/rkhan/emcV2-lic-worktrees";

/** The 23-task pilot slice from docs/SERENA_LOCAL_EVAL_PLAN.md. */
const SERENA_PILOT_IDS = [
  "real-emc-event-form-route-with-event-id",
  "real-emc-series-form-footer-alignment",
  "real-emc-datatable-horizontal-edge-scroll",
  "real-emc-event-mod-time-sync-after-session",
  "real-emc-ppn-ack-hydration",
  "real-emc-speaker-image-cache-invalidate",
  "real-emc-session-api-batch-optimisation",
  "real-emc-scope-group-my-filter",
  "real-emc-event-put-omit-detail-page-path",
  "real-emc-partner-put-sponsor-id-payload",
  "real-emc-series-put-readonly-targetcms",
  "real-emc-rbac-events-dashboard-gating",
  "real-emc-ppn-explicit-select",
  "real-emc-session-api-error-toast",
  "real-emc-include-partners-toggle",
  "real-emc-rte-quill-semantic-html",
  "real-emc-s2-tabs-crash-segmented-control",
  "real-emc-sxsw-ticket-field-config-service",
  "future-emc-agenda-switcher-segmented-control",
  "future-emc-rich-text-semantic-export",
  "arch-event-form-render-flow",
  "arch-rbac-permission-check-callsites",
  "arch-impact-of-removing-detail-page-path",
];

const HEADLINE_STRATA = new Set(["S1", "S2", "S3", "S4", "S5"]);

interface FreezeArgs {
  taskFilter: "all" | "headline" | "serena-pilot" | "kg-future-20" | string[];
  worktreeBase: string;
  emcRepo: string;
  backend: "language-server" | "jetbrains";
  serenaHome: string;
  serenaBin?: string;
  context: string;
  headOnly: boolean;
  dryRun: boolean;
  refresh: boolean;
  allowWeak: boolean;
  /** Permit a denylisted tool to be exposed (spike/tuning only; off for headline). */
  allowExposedDenied: boolean;
  callTimeoutMs: number;
  connectTimeoutMs: number;
}

function parseArgs(): FreezeArgs {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const eq = argv.find((a) => a.startsWith(`--${flag}=`));
    if (eq) return eq.slice(flag.length + 3);
    const idx = argv.indexOf(`--${flag}`);
    if (idx >= 0 && idx + 1 < argv.length && !argv[idx + 1].startsWith("--")) return argv[idx + 1];
    return undefined;
  };
  const has = (flag: string): boolean => argv.includes(`--${flag}`);

  const taskArg = get("task") ?? "serena-pilot";
  const taskFilter: FreezeArgs["taskFilter"] =
    taskArg === "all" || taskArg === "headline" || taskArg === "serena-pilot" || taskArg === "kg-future-20"
      ? taskArg
      : taskArg.split(",");

  const defaultHome = join(PKG_ROOT, "runs", `serena-freeze-${new Date().toISOString().slice(0, 10)}`, "config", "serena-home");

  return {
    taskFilter,
    worktreeBase: get("worktree-base") ?? DEFAULT_WORKTREE_BASE,
    emcRepo: get("emc-repo") ?? DEFAULT_EMC_REPO,
    backend: (get("backend") as FreezeArgs["backend"]) ?? "language-server",
    serenaHome: get("serena-home") ?? defaultHome,
    serenaBin: get("serena-bin"),
    context: get("context") ?? "codex",
    headOnly: has("head-only"),
    dryRun: has("dry-run"),
    refresh: has("refresh"),
    allowWeak: has("allow-weak") || has("allow-weak-serena"),
    allowExposedDenied: has("allow-exposed-denied"),
    callTimeoutMs: Number(get("call-timeout-ms") ?? 180_000),
    connectTimeoutMs: Number(get("connect-timeout-ms") ?? 300_000),
  };
}

function selectTasks(args: FreezeArgs): Task[] {
  if (args.taskFilter === "headline") return headlineTasks(ALL_TASKS);
  const assigned = applyAssignmentsToAll(ALL_TASKS);
  if (args.taskFilter === "all") return assigned;
  const ids = new Set(
    args.taskFilter === "serena-pilot"
      ? SERENA_PILOT_IDS
      : args.taskFilter === "kg-future-20"
        ? [...KG_FUTURE_20_TASK_IDS]
        : (args.taskFilter as string[]),
  );
  return assigned.filter((t) => ids.has(t.id));
}

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
  if (spawnSync("test", ["-d", path]).status === 0) return path;
  execFileSync("git", ["-C", args.emcRepo, "worktree", "add", "--detach", path, parentSha], { stdio: "inherit" });
  return path;
}

/** Resolve each task's index source (parent-SHA worktree, or HEAD with the leakage guard). */
function resolveIndexSource(task: Task, args: FreezeArgs): { repoPath: string; indexSource: SerenaIndexSource } {
  const parentSha = task.provenance?.parentSha;
  if (parentSha && !args.headOnly) {
    const repoPath = args.dryRun ? worktreePath(args, parentSha) : ensureWorktree(args, parentSha);
    return { repoPath, indexSource: { kind: "parentSha", sha: parentSha, worktree: repoPath } };
  }
  if (isRealHeadlineTask(task) && !args.headOnly) {
    throw new Error(
      `real headline task ${task.id} (stratum ${task.stratum}) has no provenance.parentSha; ` +
        `refusing to freeze from HEAD (temporal leakage). Add parentSha, or pass --head-only for debugging only.`,
    );
  }
  return { repoPath: args.emcRepo, indexSource: { kind: "head", repo: args.emcRepo } };
}

function getSerenaVersion(bin: string): string {
  const res = spawnSync(bin, ["--version"], { encoding: "utf8" });
  return (res.stdout ?? res.stderr ?? "").trim() || "unknown";
}

function ensureSerenaAvailable(bin: string): void {
  const res = spawnSync(bin, ["--version"], { encoding: "utf8" });
  if (res.error) {
    throw new Error(
      `serena binary "${bin}" is not executable: ${res.error.message}. ` +
        `Install it with \`uv tool install -p 3.13 serena-agent\` or set --serena-bin/SERENA_BIN.`,
    );
  }
}

/**
 * Write a complete, valid run-scoped global config at $SERENA_HOME/serena_config.yml.
 * We emit every key Serena's template defines (so its loader never KeyErrors) and
 * override only what isolation/read-only requires:
 *  - base_modes: [] + default_modes: [no-onboarding, no-memories] — drops the default
 *    `editing` base mode so edit tools are not auto-included;
 *  - excluded_tools: the full Track-A denylist — those tools are never exposed;
 *  - project_serena_folder_location: redirected under the run dir (never the worktree);
 *  - web dashboard + gui log window off (headless batch);
 *  - LSP/JetBrains backend per --backend.
 * Returns the serena-projects dir so the caller can record/clean it.
 */
async function writeSerenaConfig(args: FreezeArgs): Promise<string> {
  await mkdir(args.serenaHome, { recursive: true });
  const projectsDir = join(dirname(dirname(args.serenaHome)), "serena-projects");
  const excluded = TRACK_A_DENYLIST.map((t) => `  - ${t}`).join("\n");
  const yaml = [
    "# Run-scoped Serena config written by serena-freeze (data-isolation: local only).",
    `language_backend: ${args.backend === "jetbrains" ? "JetBrains" : "LSP"}`,
    "line_ending: native",
    "gui_log_window: False",
    "web_dashboard: False",
    "web_dashboard_open_on_launch: False",
    "web_dashboard_interface:",
    "web_dashboard_listen_address: 127.0.0.1",
    "jetbrains_plugin_server_address: 127.0.0.1",
    "log_level: 40",
    "trace_lsp_communication: False",
    "ls_specific_settings: {}",
    "ignored_paths: []",
    "read_only_memory_patterns: []",
    "ignored_memory_patterns: []",
    "tool_timeout: 240",
    "excluded_tools:",
    excluded,
    "included_optional_tools: []",
    "fixed_tools: []",
    "base_modes: []",
    "default_modes:",
    "  - no-onboarding",
    "  - no-memories",
    "default_max_tool_answer_chars: 150000",
    "token_count_estimator: CHAR_COUNT",
    "symbol_info_budget: 10",
    `project_serena_folder_location: "${join(projectsDir, "$projectFolderName", ".serena")}"`,
    "projects: []",
    "",
  ].join("\n");
  await writeFile(join(args.serenaHome, "serena_config.yml"), yaml);
  return projectsDir;
}

async function freezeOnePath(
  client: SerenaClientHandle,
  task: Task,
  indexSource: SerenaIndexSource,
  repoPath: string,
  args: FreezeArgs,
): Promise<SerenaContextFixture> {
  const seed: SerenaSeed = deriveSerenaSeed(task);
  const { recipe, calls } = await runRecipe(client, task, seed);
  const generatedAt = new Date().toISOString();
  const renderedBlock = renderSerenaBlock({
    taskId: task.id,
    stratum: task.stratum,
    generatedAt,
    backend: args.backend,
    projectPath: repoPath,
    toolAllowlist: TRACK_A_ALLOWLIST,
    seed,
    calls,
  });
  const fixture: SerenaContextFixture = {
    taskId: task.id,
    stratum: task.stratum,
    generatedAt,
    serenaVersion: getSerenaVersion(args.serenaBin ?? process.env.SERENA_BIN ?? "serena"),
    backend: args.backend,
    mcpCommand: client.command,
    projectPath: repoPath,
    repoSha: indexSource.kind === "parentSha" ? indexSource.sha : undefined,
    indexSource,
    toolAllowlist: TRACK_A_ALLOWLIST,
    toolDenylist: TRACK_A_DENYLIST,
    toolInventory: client.toolInventory,
    configHash: client.configHash,
    recipe,
    seed,
    calls,
    renderedBlock,
    renderedBlockHash: sha256Hex(renderedBlock),
  };
  fixture.quality = deriveSerenaFixtureQuality(task, fixture);
  return fixture;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const bin = args.serenaBin ?? process.env.SERENA_BIN ?? "serena";
  const tasks = selectTasks(args).filter((t) => {
    if (!t.stratum) {
      console.warn(`[serena-freeze] skip ${t.id}: no stratum assigned`);
      return false;
    }
    return true;
  });
  console.log(`[serena-freeze] ${tasks.length} task(s) selected (filter=${JSON.stringify(args.taskFilter)})`);

  // Group by index source so each worktree is activated/indexed once.
  const groups = new Map<string, { repoPath: string; indexSource: SerenaIndexSource; tasks: Task[] }>();
  for (const task of tasks) {
    const { repoPath, indexSource } = resolveIndexSource(task, args);
    const group = groups.get(repoPath) ?? { repoPath, indexSource, tasks: [] };
    group.tasks.push(task);
    groups.set(repoPath, group);
  }

  if (args.dryRun) {
    for (const { repoPath, indexSource, tasks: groupTasks } of groups.values()) {
      console.log(`\n[dry-run] project=${repoPath} indexSource=${indexSource.kind}${indexSource.kind === "parentSha" ? `:${shortSha(indexSource.sha)}` : ""}`);
      for (const task of groupTasks) {
        const seed = deriveSerenaSeed(task);
        console.log(`  ${task.id} [${task.stratum}] seedSource=${seed.source} symbols=[${seed.symbols.join(", ")}]${seed.files?.length ? ` files=[${seed.files.join(", ")}]` : ""}`);
      }
    }
    return;
  }

  preflightSerenaEnv();
  ensureSerenaAvailable(bin);
  await writeSerenaConfig(args);
  await mkdir(FIXTURES_DIR, { recursive: true });

  let ok = 0;
  let failed = 0;
  for (const { repoPath, indexSource, tasks: groupTasks } of groups.values()) {
    // Skip whole group if every task already has a fixture and not refreshing.
    const pending = [];
    for (const task of groupTasks) {
      const outPath = join(FIXTURES_DIR, `${task.id}.json`);
      if (!args.refresh && (await exists(outPath))) {
        console.log(`[serena-freeze] skip ${task.id}: fixture exists (pass --refresh to overwrite)`);
        ok++;
        continue;
      }
      pending.push(task);
    }
    if (pending.length === 0) continue;

    console.log(`[serena-freeze] connecting Serena to ${repoPath} (${pending.length} task(s))`);
    let client: SerenaClientHandle;
    try {
      client = await connectSerena({
        serenaBin: bin,
        context: args.context,
        projectPath: repoPath,
        serenaHome: args.serenaHome,
        backend: args.backend,
        allowlist: TRACK_A_ALLOWLIST,
        denylist: TRACK_A_DENYLIST,
        connectTimeoutMs: args.connectTimeoutMs,
        callTimeoutMs: args.callTimeoutMs,
      });
    } catch (err) {
      failed += pending.length;
      console.error(`[serena-freeze] FAILED to connect for ${repoPath}: ${err instanceof Error ? err.message : err}`);
      continue;
    }

    console.log(`[serena-freeze] connected. tools exposed (${client.toolInventory.length}): ${client.toolInventory.join(", ")}`);
    console.log(`[serena-freeze] configHash=${client.configHash} deniedExposed=[${client.deniedExposed.join(", ")}]`);

    if (client.deniedExposed.length > 0 && !args.allowExposedDenied) {
      await client.close();
      throw new Error(
        `tool gate failed: Serena exposed denylisted tool(s): ${client.deniedExposed.join(", ")}. ` +
          `Tighten the run-scoped serena_config.yml, or pass --allow-exposed-denied for tuning only (never headline).`,
      );
    }
    if (client.deniedExposed.length > 0) {
      console.warn(`[serena-freeze] WARNING: denylisted tools exposed (allowed by flag): ${client.deniedExposed.join(", ")}`);
    }

    try {
      for (const task of pending) {
        try {
          const fixture = await freezeOnePath(client, task, indexSource, repoPath, args);
          if (!isSerenaFixtureQualityReady(fixture.quality) && !args.allowWeak) {
            failed++;
            console.error(
              `[serena-freeze] FAILED ${task.id}: ${describeSerenaFixtureQualityGate(task.id, fixture.quality)}. ` +
                `Add a reviewed serenaSeed and re-run, or pass --allow-weak for diagnostics-only fixtures.`,
            );
            continue;
          }
          if (!isSerenaFixtureQualityReady(fixture.quality)) {
            console.warn(`[serena-freeze] WARNING ${task.id}: diagnostics-only fixture signal=${fixture.quality?.signal}`);
          }
          const outPath = join(FIXTURES_DIR, `${task.id}.json`);
          await writeFile(outPath, JSON.stringify(fixture, null, 2));
          console.log(`[serena-freeze] wrote ${outPath} (${fixture.renderedBlock.length} chars, hash ${fixture.renderedBlockHash}, quality ${fixture.quality?.signal})`);
          ok++;
        } catch (err) {
          failed++;
          console.error(`[serena-freeze] FAILED ${task.id}: ${err instanceof Error ? err.message : err}`);
        }
      }
    } finally {
      await client.close();
    }
  }

  console.log(`[serena-freeze] done: ${ok} ok, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("[serena-freeze] fatal:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
