import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_TASKS, parseTaskSetName, taskSetTasks } from "../tasks/index.js";
import { applyAssignmentsToAll, headlineTasks } from "../tasks/stratification.js";
import type { Task } from "../tasks/types.js";
import {
  evaluateLicRetrievalFixtures,
  loadLicRetrievalFixtures,
  renderLicRetrievalMarkdown,
  type LicRetrievalEvalReport,
} from "../rigor/lic-retrieval-eval.js";

const __filename = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = resolve(dirname(__filename), "..", "..");
const DEFAULT_FIXTURES_DIR = join(PACKAGE_ROOT, "fixtures", "lic");
const DEFAULT_REPORT_PATH = join(PACKAGE_ROOT, "reports", "lic-retrieval.md");
const DEFAULT_JSON_PATH = join(PACKAGE_ROOT, "reports", "lic-retrieval.json");

interface Args {
  taskSet: string;
  tasks?: string[];
  fixturesDir: string;
  reportPath: string;
  jsonPath: string;
  live: boolean;
  modes: string[];
  allowWeak: boolean;
  help: boolean;
}

function usage(): string {
  return [
    "Usage: pnpm --filter @pim/eval lic-retrieval-eval -- [options]",
    "",
    "Options:",
    "  --task-set=<primary-15|kg-future-20|kg-lic-favorable|headline|all>",
    "  --tasks=<id,id>          Score explicit task ids after assignments are applied",
    "  --fixtures=<path>        LIC fixture directory (default: fixtures/lic)",
    "  --report=<path>          Markdown report path",
    "  --json=<path>            JSON report path",
    "  --allow-weak             Do not fail the command on weak/no-result claim rows",
    "  --live                   Reserved for the non-gating live diagnostic track",
    "  --mode=<mode,mode>       Reserved for --live",
    "  --help                   Print this help",
  ].join("\n");
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    taskSet: "primary-15",
    fixturesDir: DEFAULT_FIXTURES_DIR,
    reportPath: DEFAULT_REPORT_PATH,
    jsonPath: DEFAULT_JSON_PATH,
    live: false,
    modes: ["fixture"],
    allowWeak: false,
    help: false,
  };

  for (const arg of argv) {
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--live") {
      args.live = true;
    } else if (arg === "--allow-weak") {
      args.allowWeak = true;
    } else if (arg.startsWith("--task-set=")) {
      args.taskSet = arg.slice("--task-set=".length);
    } else if (arg.startsWith("--tasks=")) {
      args.tasks = splitCsv(arg.slice("--tasks=".length));
    } else if (arg.startsWith("--task=")) {
      args.tasks = splitCsv(arg.slice("--task=".length));
    } else if (arg.startsWith("--fixtures=")) {
      args.fixturesDir = resolvePath(arg.slice("--fixtures=".length));
    } else if (arg.startsWith("--report=")) {
      args.reportPath = resolvePath(arg.slice("--report=".length));
    } else if (arg.startsWith("--json=")) {
      args.jsonPath = resolvePath(arg.slice("--json=".length));
    } else if (arg.startsWith("--mode=")) {
      args.modes = splitCsv(arg.slice("--mode=".length));
    } else {
      throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
    }
  }

  return args;
}

function resolvePath(path: string): string {
  return path.startsWith("/") ? path : resolve(process.cwd(), path);
}

function splitCsv(value: string): string[] {
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}

function selectTasks(args: Args): Task[] {
  const assigned = applyAssignmentsToAll(ALL_TASKS);
  const assignedById = new Map(assigned.map((task) => [task.id, task]));

  if (args.tasks && args.tasks.length > 0) {
    const unknown = args.tasks.filter((id) => !assignedById.has(id));
    if (unknown.length > 0) {
      throw new Error(`Unknown task id(s): ${unknown.join(", ")}`);
    }
    return args.tasks.map((id) => assignedById.get(id) as Task);
  }

  if (args.taskSet === "all") return assigned;
  if (args.taskSet === "headline") return headlineTasks(ALL_TASKS);

  const named = parseTaskSetName(args.taskSet);
  const ids = new Set(taskSetTasks(named).map((task) => task.id));
  return assigned.filter((task) => ids.has(task.id));
}

async function writeOutput(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

function weakClaimRows(report: LicRetrievalEvalReport): string[] {
  return report.cases
    .filter((testCase) => testCase.claimEligible)
    .filter((testCase) => testCase.quality?.signal === "weak" || testCase.quality?.signal === "none")
    .map((testCase) => `${testCase.taskId}:${testCase.quality?.signal ?? "missing"}`);
}

function fmt(value: number | null | undefined): string {
  if (value === null || value === undefined) return "n/a";
  return value.toFixed(3);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  if (args.live) {
    throw new Error(
      "--live is the separate non-gating diagnostic track and is not implemented in this deterministic fixture scorer yet",
    );
  }

  const tasks = selectTasks(args);
  const fixtures = await loadLicRetrievalFixtures(args.fixturesDir, tasks.map((task) => task.id));
  const report = evaluateLicRetrievalFixtures(tasks, fixtures, { taskSet: args.tasks ? "custom" : args.taskSet });

  await writeOutput(args.reportPath, renderLicRetrievalMarkdown(report));
  await writeOutput(args.jsonPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`[lic-retrieval-eval] wrote ${args.reportPath}`);
  console.log(`[lic-retrieval-eval] wrote ${args.jsonPath}`);
  console.log(
    [
      `[lic-retrieval-eval] taskSet=${report.taskSet}`,
      `cases=${report.caseCount}`,
      `fixtures=${report.fixtureCount}`,
      `raw_file_recall=${fmt(report.rawOutput.fileRecall)}`,
      `raw_symbol_recall=${fmt(report.rawOutput.symbolRecall)}`,
      `rendered_file_recall=${fmt(report.renderedBlock.fileRecall)}`,
      `rendered_symbol_recall=${fmt(report.renderedBlock.symbolRecall)}`,
      `claim_blocking=${report.claimBlockingFindings.length}`,
    ].join(" "),
  );

  const weakRows = weakClaimRows(report);
  if (!args.allowWeak && weakRows.length > 0) {
    console.error(`[lic-retrieval-eval] weak/no-result claim rows: ${weakRows.join(", ")}`);
  }

  if (report.claimBlockingFindings.length > 0 || (!args.allowWeak && weakRows.length > 0)) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[lic-retrieval-eval] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
