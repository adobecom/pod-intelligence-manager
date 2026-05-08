import "../load-env.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { ALL_TASKS, pickTasks } from "../tasks/index.js";
import type { Task } from "../tasks/types.js";
import { ARMS, getArm } from "../arms/index.js";
import type { Arm, SessionContextFixture } from "../arms/types.js";
import { getRunner, pickDefaultRunner } from "../runners/index.js";
import type { LLMRunner } from "../runners/types.js";
import { judgeCode, judgeContent } from "../judges/index.js";
import { costFor } from "../pricing.js";
import { renderMarkdownReport, type EvalRow } from "../report.js";

const __filename = fileURLToPath(import.meta.url);
const PKG_ROOT = join(dirname(__filename), "..", "..");
const FIXTURES_DIR = join(PKG_ROOT, "fixtures", "session-contexts");
const REPORTS_DIR = join(PKG_ROOT, "reports");

interface CliArgs {
  taskIds?: string[];
  tags?: string[];
  armIds?: string[];
  runnerName?: "bedrock" | "anthropic";
  model?: string;
  judgeRunnerName?: "bedrock" | "anthropic";
  judgeModel?: string;
  reportPath?: string;
  bypassJudgeCache?: boolean;
  maxOutputTokens?: number;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {};
  for (const arg of argv) {
    const [key, val = "true"] = arg.replace(/^-+/, "").split("=");
    switch (key) {
      case "tasks": out.taskIds = val.split(","); break;
      case "tags": out.tags = val.split(","); break;
      case "arms": out.armIds = val.split(","); break;
      case "runner": out.runnerName = val as "bedrock" | "anthropic"; break;
      case "model": out.model = val; break;
      case "judge-runner": out.judgeRunnerName = val as "bedrock" | "anthropic"; break;
      case "judge-model": out.judgeModel = val; break;
      case "report": out.reportPath = val; break;
      case "no-judge-cache": out.bypassJudgeCache = true; break;
      case "max-output-tokens": out.maxOutputTokens = Number(val); break;
      default:
        // ignore unknown
        break;
    }
  }
  return out;
}

async function loadFixture(podId: string): Promise<SessionContextFixture> {
  const path = join(FIXTURES_DIR, `${podId}.json`);
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as SessionContextFixture;
  } catch (err) {
    throw new Error(
      `Missing fixture for pod ${podId} at ${path}. Run \`pnpm --filter @pim/eval freeze\` first. (${(err as Error).message})`,
    );
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

async function runOne(
  task: Task,
  arm: Arm,
  fixture: SessionContextFixture | null,
  runner: LLMRunner,
  model: string,
  judgeRunner: LLMRunner,
  judgeModel: string,
  bypassJudgeCache: boolean,
  maxOutputTokens: number,
): Promise<EvalRow> {
  const segments = arm.build(task, fixture);

  // Step 1: runner — if this throws, we have no output to judge.
  let runnerResult;
  try {
    runnerResult = await runner.run(segments, { model, maxOutputTokens });
  } catch (err) {
    return {
      taskId: task.id,
      taskType: task.type,
      podId: task.podId,
      arm: arm.id,
      armLabel: arm.label,
      runner: runner.name,
      model,
      output: "",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      latencyMs: 0,
      judge: { passed: false, score: 0, detail: `runner error: ${(err as Error).message}` },
      costUsd: 0,
      signalsHit: [],
      error: `runner: ${(err as Error).message}`,
    };
  }

  // Step 2: judge — runner usage is preserved even if the judge fails.
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

  return {
    taskId: task.id,
    taskType: task.type,
    podId: task.podId,
    arm: arm.id,
    armLabel: arm.label,
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
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const tasks = pickTasks({ ids: args.taskIds, tags: args.tags });
  if (tasks.length === 0) {
    console.error("[run] No tasks matched the filter.");
    process.exit(1);
  }

  const arms: Arm[] = args.armIds ? args.armIds.map(getArm) : ARMS;
  const runner = args.runnerName ? getRunner(args.runnerName) : pickDefaultRunner();
  const judgeRunner = args.judgeRunnerName ? getRunner(args.judgeRunnerName) : runner;

  const model = args.model ?? defaultModelFor(runner.name);
  const judgeModel = args.judgeModel ?? defaultJudgeModelFor(judgeRunner.name);
  const maxOutputTokens = args.maxOutputTokens ?? 4096;

  console.log(`[run] runner=${runner.name} model=${model} judgeRunner=${judgeRunner.name} judgeModel=${judgeModel}`);
  console.log(`[run] tasks=${tasks.length} arms=[${arms.map((a) => a.id).join(",")}]`);

  const podIds = Array.from(new Set(tasks.map((t) => t.podId)));
  const fixtures = new Map<string, SessionContextFixture>();
  for (const id of podIds) {
    fixtures.set(id, await loadFixture(id));
  }

  // Order: arm by arm, pod by pod within arm. Maximizes prompt-cache reuse for the
  // PIM-full arm (the same context block runs across consecutive tasks for the same pod).
  const ordered = [...tasks].sort((a, b) => (a.podId === b.podId ? 0 : a.podId.localeCompare(b.podId)));

  const rows: EvalRow[] = [];
  for (const arm of arms) {
    for (const task of ordered) {
      const fixture = fixtures.get(task.podId) ?? null;
      const t0 = Date.now();
      const row = await runOne(task, arm, fixture, runner, model, judgeRunner, judgeModel, args.bypassJudgeCache ?? false, maxOutputTokens);
      const elapsed = Date.now() - t0;
      const status = row.judge.passed ? "PASS" : "FAIL";
      console.log(
        `[run] ${arm.id.padEnd(10)} ${task.id.padEnd(34)} ${status} ` +
        `score=${row.judge.score.toFixed(2)} ` +
        `in=${row.usage.inputTokens} out=${row.usage.outputTokens} cacheR=${row.usage.cacheReadTokens} cacheW=${row.usage.cacheCreationTokens} ` +
        `cost=$${row.costUsd.toFixed(4)} t=${elapsed}ms`,
      );
      rows.push(row);
    }
  }

  await mkdir(REPORTS_DIR, { recursive: true });
  const reportPath = args.reportPath ?? join(REPORTS_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
  const md = renderMarkdownReport(rows, {
    generatedAt: new Date().toISOString(),
    gitSha: gitSha(),
    runner: runner.name,
    model,
    judgeModel,
    filter: { taskIds: args.taskIds, tags: args.tags, arms: args.armIds },
  });
  await writeFile(reportPath, md);
  console.log(`[run] report written to ${reportPath}`);

  printSummary(rows);
}

function defaultModelFor(runner: "bedrock" | "anthropic"): string {
  if (runner === "anthropic") return process.env.PIM_EVAL_MODEL ?? "claude-sonnet-4-6";
  return process.env.PIM_EVAL_MODEL ?? process.env.BEDROCK_MODEL_SMART ?? "us.anthropic.claude-3-5-sonnet-20241022-v2:0";
}

function defaultJudgeModelFor(runner: "bedrock" | "anthropic"): string {
  if (runner === "anthropic") return process.env.PIM_EVAL_JUDGE_MODEL ?? "claude-opus-4-7";
  // Bedrock: prefer Opus 4.7 if available, fall back to whatever BEDROCK_MODEL_SMART is set to,
  // else Sonnet 4.6 cross-region inference profile.
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
      `  ${armId.padEnd(10)} ${passes}/${total} pass  cost=$${cost.toFixed(4)}  in=${inputTokens} cacheR=${cacheReads} cacheW=${cacheWrites}`,
    );
  }
}

main().catch((err) => {
  console.error("[run] failed:", err);
  process.exit(1);
});
