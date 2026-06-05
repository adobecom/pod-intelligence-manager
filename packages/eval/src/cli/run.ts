import "../load-env.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { ALL_TASKS, pickTasks } from "../tasks/index.js";
import type { Task } from "../tasks/types.js";
import { applyAssignment } from "../tasks/stratification.js";
import { classifyPromptTier } from "../tasks/prompt-tiers.js";
import { ARMS, getArm } from "../arms/index.js";
import { filterFixtureByAsOf } from "../arms/pim-full.js";
import type { Arm, SessionContextFixture, LicContextFixture } from "../arms/types.js";
import { getRunner, pickDefaultRunner } from "../runners/index.js";
import type { LLMRunner, PromptSegments, RunUsage } from "../runners/types.js";
import { EMPTY_USAGE } from "../runners/types.js";
import { judgeCode, judgeContent } from "../judges/index.js";
import { costFor } from "../pricing.js";
import { renderMarkdownReport, type EvalRow } from "../report.js";
import {
  hashTaskGroundTruth,
  hashTaskPrompt,
  hashTaskRubric,
  readHoldout,
  validateHoldoutManifest,
  type HoldoutManifest,
  type HoldoutTaskEntry,
} from "../rigor/holdout.js";
import { sha256File, sha256Text, stableJson } from "../rigor/hash.js";
import { deriveLicFixtureQuality, type LicFixtureQuality } from "../rigor/lic-quality.js";
import { computeProtocolAnalysis, DEFAULT_PROTOCOL_ARMS } from "../rigor/protocol-analysis.js";
import {
  writeJson,
  writeRunArtifacts,
  type ApiCallArtifact,
  type OutputArtifact,
  type PromptArtifact,
  type RunManifest,
} from "../rigor/run-artifacts.js";

const __filename = fileURLToPath(import.meta.url);
const PKG_ROOT = join(dirname(__filename), "..", "..");
const FIXTURES_DIR = join(PKG_ROOT, "fixtures", "session-contexts");
const LIC_FIXTURES_DIR = join(PKG_ROOT, "fixtures", "lic");
const REPORTS_DIR = join(PKG_ROOT, "reports");
const LLAMA_JUDGE_MODEL = "us.meta.llama3-3-70b-instruct-v1:0";
const PROTOCOL_CANDIDATE_MODEL = "us.anthropic.claude-haiku-4-5-20251001-v1:0";

interface CliArgs {
  taskIds?: string[];
  tags?: string[];
  armIds?: string[];
  runnerName?: "bedrock" | "anthropic";
  model?: string;
  /** Per-arm model override, e.g. {"control":"us.anthropic.claude-sonnet-4-6","pim-full":"us.anthropic.claude-haiku-4-5-20251001-v1:0"}. Falls back to --model for arms not listed. */
  armModels?: Record<string, string>;
  judgeRunnerName?: "bedrock" | "anthropic";
  judgeModel?: string;
  reportPath?: string;
  bypassJudgeCache?: boolean;
  maxOutputTokens?: number;
  /** Number of times to run each (task, arm) combination. Default 1 ad-hoc, 3 protocol. */
  seeds?: number;
  /** Sampling temperature override. Auto-bumps to 0.3 when seeds > 1 unless user sets it. */
  temperature?: number;
  holdoutPath?: string;
  protocolPath?: string;
  runDir?: string;
  unknownFlags: string[];
}

interface LoadedSessionFixture {
  fixture: SessionContextFixture;
  hash: string;
}

interface LoadedLicFixture {
  fixture: LicContextFixture;
  hash: string;
}

interface RunOneResult {
  row: EvalRow;
  prompt: PromptArtifact;
  apiCall: ApiCallArtifact;
  output: OutputArtifact;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { unknownFlags: [] };
  for (const arg of argv) {
    const [key, val = "true"] = arg.replace(/^-+/, "").split("=");
    switch (key) {
      case "tasks": out.taskIds = val.split(",").filter(Boolean); break;
      case "tags": out.tags = val.split(",").filter(Boolean); break;
      case "arms": out.armIds = val.split(",").filter(Boolean); break;
      case "runner": out.runnerName = val as "bedrock" | "anthropic"; break;
      case "model": out.model = val; break;
      case "arm-models": {
        out.armModels = {};
        for (const pair of val.split(",")) {
          const colon = pair.indexOf(":");
          if (colon <= 0) throw new Error(`--arm-models entry "${pair}" must be armId:model`);
          out.armModels[pair.slice(0, colon).trim()] = pair.slice(colon + 1).trim();
        }
        break;
      }
      case "judge-runner": out.judgeRunnerName = val as "bedrock" | "anthropic"; break;
      case "judge-model": out.judgeModel = val; break;
      case "report": out.reportPath = val; break;
      case "no-judge-cache": out.bypassJudgeCache = true; break;
      case "max-output-tokens": out.maxOutputTokens = Number(val); break;
      case "seeds": out.seeds = Number(val); break;
      case "temperature": out.temperature = Number(val); break;
      case "holdout": out.holdoutPath = val; break;
      case "protocol": out.protocolPath = val; break;
      case "run-dir": out.runDir = val; break;
      default:
        out.unknownFlags.push(arg);
        break;
    }
  }
  return out;
}

async function loadFixture(podId: string): Promise<LoadedSessionFixture> {
  const path = join(FIXTURES_DIR, `${podId}.json`);
  try {
    const raw = await readFile(path, "utf8");
    return { fixture: JSON.parse(raw) as SessionContextFixture, hash: sha256Text(raw) };
  } catch (err) {
    throw new Error(
      `Missing fixture for pod ${podId} at ${path}. Run \`pnpm --filter @pim/eval freeze\` first. (${(err as Error).message})`,
    );
  }
}

async function loadLicFixture(task: Task): Promise<LoadedLicFixture | null> {
  const path = join(LIC_FIXTURES_DIR, `${task.id}.json`);
  try {
    const raw = await readFile(path, "utf8");
    const fixture = JSON.parse(raw) as LicContextFixture;
    if (!fixture.quality) fixture.quality = deriveLicFixtureQuality(task, fixture);
    return { fixture, hash: sha256Text(raw) };
  } catch {
    return null;
  }
}

function gitSha(): string | undefined {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return undefined;
  }
}

function findSignals(output: string, signals: string[] | undefined): string[] {
  if (!signals) return [];
  const lower = output.toLowerCase();
  return signals.filter((s) => lower.includes(s.toLowerCase()));
}

function resolvePkgPath(path: string): string {
  return isAbsolute(path) ? path : join(PKG_ROOT, path);
}

function manifestPath(path: string): string {
  const resolved = resolvePkgPath(path);
  const rel = relative(PKG_ROOT, resolved);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
}

function protocolMode(args: CliArgs): boolean {
  return Boolean(args.holdoutPath || args.protocolPath || args.runDir);
}

function requireProtocolArgs(args: CliArgs): asserts args is CliArgs & { holdoutPath: string; protocolPath: string; runDir: string } {
  const missing = [
    !args.holdoutPath ? "--holdout" : undefined,
    !args.protocolPath ? "--protocol" : undefined,
    !args.runDir ? "--run-dir" : undefined,
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`protocol mode requires ${missing.join(", ")}`);
  }
}

function taskMap(): Map<string, Task> {
  return new Map(ALL_TASKS.map((task) => [task.id, applyAssignment(task)]));
}

async function loadProtocolTasks(args: CliArgs & { holdoutPath: string; protocolPath: string; runDir: string }): Promise<{
  holdout: HoldoutManifest;
  holdoutPath: string;
  protocolPath: string;
  holdoutHash: string;
  protocolHash: string;
  tasks: Task[];
  entries: Map<string, HoldoutTaskEntry>;
}> {
  if (args.unknownFlags.length > 0) throw new Error(`unknown flag(s) in protocol mode: ${args.unknownFlags.join(", ")}`);
  if (args.taskIds?.length || args.tags?.length) {
    throw new Error("protocol mode loads tasks only from the holdout manifest; omit --tasks and --tags");
  }
  if (args.armModels) {
    throw new Error("protocol mode requires one fixed candidate model across arms; omit --arm-models");
  }

  const holdoutPath = resolvePkgPath(args.holdoutPath);
  const protocolPath = resolvePkgPath(args.protocolPath);
  const holdout = await readHoldout(holdoutPath);
  const protocolRef = manifestPath(args.protocolPath);
  if (holdout.protocol !== protocolRef) {
    throw new Error(`holdout protocol mismatch: manifest=${holdout.protocol} cli=${protocolRef}`);
  }

  const audit = await validateHoldoutManifest(holdout, { licFixtureDir: LIC_FIXTURES_DIR });
  if (!audit.ok) {
    const detail = audit.findings.map((f) => `${f.level}: ${f.message}`).join("\n");
    throw new Error(`holdout validation failed:\n${detail}`);
  }

  const byId = taskMap();
  const entries = new Map(holdout.tasks.map((entry) => [entry.id, entry]));
  const tasks = holdout.tasks.map((entry) => {
    const task = byId.get(entry.id);
    if (!task) throw new Error(`holdout references unknown task ${entry.id}`);
    return task;
  });

  validateTaskDrift(tasks, entries);

  return {
    holdout,
    holdoutPath,
    protocolPath,
    holdoutHash: await sha256File(holdoutPath),
    protocolHash: await sha256File(protocolPath),
    tasks,
    entries,
  };
}

function validateTaskDrift(tasks: Task[], entries: Map<string, HoldoutTaskEntry>): void {
  const errors: string[] = [];
  for (const task of tasks) {
    const entry = entries.get(task.id);
    if (!entry) continue;
    if (entry.promptHash !== hashTaskPrompt(task)) errors.push(`prompt hash drift for ${task.id}`);
    if (entry.groundTruthHash !== hashTaskGroundTruth(task)) errors.push(`ground truth hash drift for ${task.id}`);
    if (entry.rubricHash !== hashTaskRubric(task)) errors.push(`rubric hash drift for ${task.id}`);
    if (entry.stratum !== task.stratum) errors.push(`stratum drift for ${task.id}`);
    if (entry.promptTier !== undefined && entry.promptTier !== classifyPromptTier(task)) errors.push(`prompt tier drift for ${task.id}`);
    if (entry.asOf !== task.asOf) errors.push(`asOf drift for ${task.id}`);
    if (entry.provenance?.parentSha && entry.provenance.parentSha !== task.provenance?.parentSha) errors.push(`parentSha drift for ${task.id}`);
    const licSeedHash = task.licSeed ? sha256Text(stableJson(task.licSeed)) : undefined;
    if (entry.licSeedHash !== licSeedHash) errors.push(`lic seed hash drift for ${task.id}`);
  }
  if (errors.length > 0) throw new Error(`holdout task drift:\n${errors.join("\n")}`);
}

function buildPrompt(arm: Arm, task: Task, fixture: SessionContextFixture | null, lic: LicContextFixture | null): PromptSegments {
  return arm.buildWithInputs
    ? arm.buildWithInputs(task, { pim: fixture, lic })
    : arm.build(task, fixture);
}

async function runOne(params: {
  runId: string;
  task: Task;
  arm: Arm;
  fixture: SessionContextFixture | null;
  lic: LicContextFixture | null;
  licFixtureHash?: string;
  licFixtureQuality?: LicFixtureQuality;
  runner: LLMRunner;
  model: string;
  judgeRunner: LLMRunner;
  judgeModel: string;
  bypassJudgeCache: boolean;
  maxOutputTokens: number;
  temperature: number | undefined;
  seed: number;
}): Promise<RunOneResult> {
  const {
    runId,
    task,
    arm,
    fixture,
    lic,
    licFixtureHash,
    licFixtureQuality,
    runner,
    model,
    judgeRunner,
    judgeModel,
    bypassJudgeCache,
    maxOutputTokens,
    temperature,
    seed,
  } = params;
  const candidateId = `${task.id}__${arm.id}__seed-${seed}`;
  const baseRow = {
    taskId: task.id,
    taskType: task.type,
    podId: task.podId,
    arm: arm.id,
    armLabel: arm.label,
    tags: task.tags,
    stratum: task.stratum,
    promptTier: classifyPromptTier(task),
    licFixtureHash,
    licFixtureQuality,
    seed,
  };

  let segments: PromptSegments;
  try {
    segments = buildPrompt(arm, task, fixture, lic);
  } catch (err) {
    const message = `prompt: ${(err as Error).message}`;
    const row = failedRow(baseRow, runner.name, model, message);
    const prompt: PromptArtifact = { runId, taskId: task.id, arm: arm.id, seed, prompt: { system: "", userTask: "" } };
    return {
      row,
      prompt,
      apiCall: apiCallFromError(runId, task, arm, seed, runner.name, model, message),
      output: outputArtifact(runId, candidateId, task, arm, seed, row),
    };
  }

  const prompt: PromptArtifact = { runId, taskId: task.id, arm: arm.id, seed, prompt: segments };

  let runnerResult;
  try {
    runnerResult = await runner.run(segments, { model, maxOutputTokens, temperature });
  } catch (err) {
    const message = `runner: ${(err as Error).message}`;
    const row = failedRow(baseRow, runner.name, model, message);
    return {
      row,
      prompt,
      apiCall: apiCallFromError(runId, task, arm, seed, runner.name, model, message),
      output: outputArtifact(runId, candidateId, task, arm, seed, row),
    };
  }

  let judge;
  let judgeError: string | undefined;
  try {
    judge =
      task.type === "code"
        ? await judgeCode(task, runnerResult.text)
        : await judgeContent(task, runnerResult.text, {
            judgeRunner,
            judgeModel,
            bypassCache: bypassJudgeCache,
          });
  } catch (err) {
    judgeError = `judge: ${(err as Error).message}`;
    judge = { passed: false, score: 0, detail: judgeError };
  }

  const row: EvalRow = {
    ...baseRow,
    runner: runnerResult.runner,
    model: runnerResult.model,
    output: runnerResult.text,
    usage: runnerResult.usage,
    latencyMs: runnerResult.latencyMs,
    judge,
    costUsd: costFor(runnerResult.model, runnerResult.usage),
    signalsHit: findSignals(runnerResult.text, task.expectedSignals),
    ...(judgeError ? { error: judgeError } : {}),
  };

  return {
    row,
    prompt,
    apiCall: {
      runId,
      taskId: task.id,
      arm: arm.id,
      seed,
      runner: runnerResult.runner,
      model: runnerResult.model,
      latencyMs: runnerResult.latencyMs,
      usage: runnerResult.usage,
      ...(judgeError ? { error: judgeError } : {}),
    },
    output: outputArtifact(runId, candidateId, task, arm, seed, row),
  };
}

function failedRow(
  baseRow: Pick<EvalRow, "taskId" | "taskType" | "podId" | "arm" | "armLabel" | "tags" | "stratum" | "promptTier" | "licFixtureHash" | "licFixtureQuality" | "seed">,
  runner: "bedrock" | "anthropic",
  model: string,
  error: string,
): EvalRow {
  return {
    ...baseRow,
    runner,
    model,
    output: "",
    usage: EMPTY_USAGE,
    latencyMs: 0,
    judge: { passed: false, score: 0, detail: error },
    costUsd: 0,
    signalsHit: [],
    error,
  };
}

function apiCallFromError(
  runId: string,
  task: Task,
  arm: Arm,
  seed: number,
  runner: string,
  model: string,
  error: string,
): ApiCallArtifact {
  return {
    runId,
    taskId: task.id,
    arm: arm.id,
    seed,
    runner,
    model,
    latencyMs: 0,
    usage: EMPTY_USAGE,
    error,
  };
}

function outputArtifact(runId: string, candidateId: string, task: Task, arm: Arm, seed: number, row: EvalRow): OutputArtifact {
  return {
    runId,
    candidateId,
    taskId: task.id,
    arm: arm.id,
    seed,
    output: row.output,
    judge: row.judge,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const isProtocolMode = protocolMode(args);
  let protocol: Awaited<ReturnType<typeof loadProtocolTasks>> | undefined;
  let tasks: Task[];

  if (isProtocolMode) {
    requireProtocolArgs(args);
    protocol = await loadProtocolTasks(args);
    tasks = protocol.tasks;
  } else {
    tasks = pickTasks({ ids: args.taskIds, tags: args.tags });
  }

  if (tasks.length === 0) {
    console.error("[run] No tasks matched the filter.");
    process.exit(1);
  }

  const arms: Arm[] = args.armIds
    ? args.armIds.map(getArm)
    : isProtocolMode
      ? DEFAULT_PROTOCOL_ARMS.map(getArm)
      : ARMS;

  const podIds = Array.from(new Set(tasks.map((t) => t.podId)));
  const loadedFixtures = new Map<string, LoadedSessionFixture>();
  for (const id of podIds) loadedFixtures.set(id, await loadFixture(id));
  const fixtures = new Map(Array.from(loadedFixtures, ([id, loaded]) => [id, loaded.fixture]));
  const fixtureHashes = Object.fromEntries(Array.from(loadedFixtures, ([id, loaded]) => [id, loaded.hash]));

  const shouldLoadLicFixtures = isProtocolMode || arms.some((a) => a.usesLic);
  const loadedLicFixtures = new Map<string, LoadedLicFixture>();
  if (shouldLoadLicFixtures) {
    const missing: string[] = [];
    for (const task of tasks) {
      const sc = await loadLicFixture(task);
      if (sc) loadedLicFixtures.set(task.id, sc);
      else missing.push(task.id);
    }
    if (missing.length > 0 && (isProtocolMode || arms.some((a) => a.usesLic))) {
      throw new Error(`missing lic fixture(s): ${missing.join(", ")}`);
    }
  }
  if (protocol) {
    for (const [taskId, entry] of protocol.entries) {
      const actual = loadedLicFixtures.get(taskId)?.hash;
      if (entry.licFixtureHash && actual !== entry.licFixtureHash) {
        throw new Error(`lic fixture hash drift for ${taskId}: holdout=${entry.licFixtureHash} actual=${actual ?? "(missing)"}`);
      }
    }
  }

  const licFixtures = new Map(Array.from(loadedLicFixtures, ([id, loaded]) => [id, loaded.fixture]));
  const licFixtureHashes = Object.fromEntries(Array.from(loadedLicFixtures, ([id, loaded]) => [id, loaded.hash]));
  const licFixtureQuality = Object.fromEntries(
    Array.from(loadedLicFixtures, ([id, loaded]) => [id, loaded.fixture.quality ?? deriveLicFixtureQuality(taskMap().get(id)!, loaded.fixture)]),
  );
  const taskStrata = Object.fromEntries(tasks.map((task) => [task.id, task.stratum ?? ""]));

  const runner = args.runnerName ? getRunner(args.runnerName) : pickDefaultRunner();
  const judgeRunner = args.judgeRunnerName ? getRunner(args.judgeRunnerName) : isProtocolMode ? getRunner("bedrock") : runner;
  const model = args.model ?? (isProtocolMode ? PROTOCOL_CANDIDATE_MODEL : defaultModelFor(runner.name));
  const judgeModel = args.judgeModel ?? (isProtocolMode ? LLAMA_JUDGE_MODEL : defaultJudgeModelFor(judgeRunner.name));
  const maxOutputTokens = args.maxOutputTokens ?? 4096;
  const seeds = args.seeds && args.seeds > 0 ? args.seeds : isProtocolMode ? 3 : 1;
  const temperature =
    args.temperature !== undefined
      ? args.temperature
      : seeds > 1
        ? 0.3
        : undefined;
  const bypassJudgeCache = (args.bypassJudgeCache ?? false) || seeds > 1;

  const armModelFor = (armId: string): string => args.armModels?.[armId] ?? model;
  console.log(`[run] runner=${runner.name} model=${model} judgeRunner=${judgeRunner.name} judgeModel=${judgeModel}`);
  if (args.armModels) {
    for (const arm of arms) {
      const m = armModelFor(arm.id);
      if (m !== model) console.log(`[run]   arm=${arm.id} -> model=${m}`);
    }
  }
  console.log(`[run] tasks=${tasks.length} arms=[${arms.map((a) => a.id).join(",")}] seeds=${seeds}${temperature !== undefined ? ` temp=${temperature}` : ""}`);

  const ordered = isProtocolMode
    ? tasks
    : [...tasks].sort((a, b) => (a.podId === b.podId ? 0 : a.podId.localeCompare(b.podId)));
  const runId = args.runDir ? basename(resolvePkgPath(args.runDir)) : new Date().toISOString().replace(/[:.]/g, "-");
  const generatedAt = new Date().toISOString();

  const rows: EvalRow[] = [];
  const prompts: PromptArtifact[] = [];
  const apiCalls: ApiCallArtifact[] = [];
  const outputs: OutputArtifact[] = [];
  for (let seed = 0; seed < seeds; seed++) {
    for (const arm of arms) {
      for (const task of ordered) {
        const fixture = fixtures.get(task.podId) ?? null;
        const lic = licFixtures.get(task.id) ?? null;
        const t0 = Date.now();
        const result = await runOne({
          runId,
          task,
          arm,
          fixture,
          lic,
          licFixtureHash: licFixtureHashes[task.id],
          licFixtureQuality: licFixtureQuality[task.id],
          runner,
          model: armModelFor(arm.id),
          judgeRunner,
          judgeModel,
          bypassJudgeCache,
          maxOutputTokens,
          temperature,
          seed,
        });
        const row = result.row;
        const elapsed = Date.now() - t0;
        const status = row.judge.passed ? "PASS" : "FAIL";
        const seedTag = seeds > 1 ? ` seed=${seed}` : "";
        console.log(
          `[run] ${arm.id.padEnd(24)} ${task.id.padEnd(42)}${seedTag} ${status} ` +
          `score=${row.judge.score.toFixed(2)} ` +
          `in=${row.usage.inputTokens} out=${row.usage.outputTokens} cacheR=${row.usage.cacheReadTokens} cacheW=${row.usage.cacheCreationTokens} ` +
          `cost=$${row.costUsd.toFixed(4)} t=${elapsed}ms`,
        );
        rows.push(row);
        prompts.push(result.prompt);
        apiCalls.push(result.apiCall);
        outputs.push(result.output);
      }
    }
  }

  const reportPath = args.runDir
    ? join(resolvePkgPath(args.runDir), "report.md")
    : args.reportPath
      ? resolvePkgPath(args.reportPath)
      : join(REPORTS_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
  await mkdir(dirname(reportPath), { recursive: true });
  // Protocol claim analysis: computed once, rendered into report.md and persisted
  // as analysis.json. The primary family excludes control (the operational
  // baseline); control still appears via the focus comparisons and arm summaries.
  const analysisArms = arms.map((arm) => arm.id).filter((armId) => armId !== "control");
  const protocolAnalysis = isProtocolMode
    ? computeProtocolAnalysis(rows, { generatedAt, primaryArms: analysisArms })
    : undefined;
  const md = renderMarkdownReport(rows, {
    generatedAt,
    gitSha: gitSha(),
    runner: runner.name,
    model,
    judgeModel,
    filter: { taskIds: args.taskIds, tags: args.tags, arms: args.armIds },
    protocol: protocolAnalysis,
  });
  await writeFile(reportPath, md);

  if (args.runDir && protocol) {
    const runDir = resolvePkgPath(args.runDir);

    // Per-task point-in-time PIM snapshots: exactly what the PIM arms scoped the
    // context to. Persisted so the temporal audit validates what the model saw,
    // not the unscoped pod fixture.
    const scopedFixtures = new Map<string, SessionContextFixture>();
    const taskAsOf: Record<string, string> = {};
    for (const task of tasks) {
      const asOf = task.asOf ?? protocol.entries.get(task.id)?.asOf;
      if (!asOf) continue;
      taskAsOf[task.id] = asOf;
      const pod = fixtures.get(task.podId);
      if (pod) scopedFixtures.set(task.id, filterFixtureByAsOf(pod, asOf));
    }

    const manifest: RunManifest = {
      runId,
      generatedAt,
      gitSha: gitSha(),
      holdoutId: protocol.holdout.id,
      protocolPath: manifestPath(args.protocolPath!),
      protocolHash: protocol.protocolHash,
      holdoutPath: manifestPath(args.holdoutPath!),
      holdoutHash: protocol.holdoutHash,
      runner: runner.name,
      model,
      judgeRunner: judgeRunner.name,
      judgeModel,
      seeds,
      ...(temperature !== undefined ? { temperature } : {}),
      arms: arms.map((a) => a.id),
      tasks: tasks.map((t) => t.id),
      taskStrata,
      taskAsOf,
      fixtureHashes,
      licFixtureHashes,
      licFixtureQuality,
      filter: { arms: args.armIds },
    };
    await writeRunArtifacts({
      runDir,
      manifest,
      prompts,
      apiCalls,
      outputs,
      rows,
      fixtures,
      licFixtures,
      scopedFixtures,
    });
    await writeJson(
      join(runDir, "analysis.json"),
      protocolAnalysis ?? computeProtocolAnalysis(rows, { generatedAt, primaryArms: analysisArms }),
    );
  }

  console.log(`[run] report written to ${reportPath}`);
  printSummary(rows);
}

function defaultModelFor(runner: "bedrock" | "anthropic"): string {
  if (runner === "anthropic") return process.env.PIM_EVAL_MODEL ?? "claude-sonnet-4-6";
  return process.env.PIM_EVAL_MODEL ?? process.env.BEDROCK_MODEL_SMART ?? "us.anthropic.claude-3-5-sonnet-20241022-v2:0";
}

function defaultJudgeModelFor(runner: "bedrock" | "anthropic"): string {
  if (runner === "anthropic") return process.env.PIM_EVAL_JUDGE_MODEL ?? "claude-opus-4-7";
  return (
    process.env.PIM_EVAL_JUDGE_MODEL ??
    process.env.BEDROCK_JUDGE_MODEL ??
    process.env.BEDROCK_MODEL_SMART ??
    "us.anthropic.claude-sonnet-4-6"
  );
}

function printSummary(rows: EvalRow[]): void {
  const armIds = Array.from(new Set(rows.map((r) => r.arm)));
  console.log("");
  console.log("=== Summary ===");
  for (const armId of armIds) {
    const armRows = rows.filter((r) => r.arm === armId);
    const passes = armRows.filter((r) => r.judge.passed).length;
    const total = armRows.length;
    const cost = armRows.reduce((s, r) => s + r.costUsd, 0);
    const cacheReads = armRows.reduce((s, r) => s + r.usage.cacheReadTokens, 0);
    const cacheWrites = armRows.reduce((s, r) => s + r.usage.cacheCreationTokens, 0);
    const inputTokens = armRows.reduce((s, r) => s + r.usage.inputTokens, 0);
    console.log(
      `  ${armId.padEnd(24)} ${passes}/${total} pass  cost=$${cost.toFixed(4)}  in=${inputTokens} cacheR=${cacheReads} cacheW=${cacheWrites}`,
    );
  }
}

main().catch((err) => {
  console.error("[run] failed:", err);
  process.exit(1);
});
