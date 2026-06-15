import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import oracleJson from "../src/services/__fixtures__/kg-retrieval-oracle.json";
import {
  evaluateContractRetrievalOracle,
  evaluateRetrievalOracle,
  formatRetrievalEvalFailures,
  renderContractComparisonMarkdown,
  renderRetrievalEvalMarkdown,
  validateRetrievalOracle,
  type RetrievalOracleFixture,
} from "../src/services/kg-retrieval-eval.js";

interface Args {
  reportPath?: string;
  jsonPath?: string;
  compareContracts: boolean;
  help: boolean;
}

const WORKSPACE_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..", "..", "..");

function resolveOutputPath(path: string): string {
  return path.startsWith("/") ? path : resolve(WORKSPACE_ROOT, path);
}

function usage(): string {
  return [
    "Usage: pnpm --filter @pim/server retrieval-eval -- [options]",
    "",
    "Options:",
    "  --report=<path>  Markdown report path to write",
    "  --json=<path>    JSON report path to write",
    "  --compare-contracts  Compare legacy and task_relevant agent-context retrieval",
    "  --help           Print this help",
  ].join("\n");
}

function parseArgs(argv: string[]): Args {
  const args: Args = { compareContracts: false, help: false };
  for (const arg of argv) {
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--compare-contracts") {
      args.compareContracts = true;
    } else if (arg.startsWith("--report=")) {
      args.reportPath = resolveOutputPath(arg.slice("--report=".length));
    } else if (arg.startsWith("--json=")) {
      args.jsonPath = resolveOutputPath(arg.slice("--json=".length));
    } else {
      throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
    }
  }
  return args;
}

async function writeOutput(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
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

  const oracle = oracleJson as RetrievalOracleFixture;
  const validationErrors = validateRetrievalOracle(oracle);
  if (validationErrors.length > 0) {
    throw new Error(`Oracle validation failed:\n${validationErrors.map((error) => `- ${error}`).join("\n")}`);
  }

  if (args.compareContracts) {
    const report = await evaluateContractRetrievalOracle(oracle);
    if (args.reportPath) {
      await writeOutput(args.reportPath, renderContractComparisonMarkdown(report));
      console.log(`[retrieval-eval] wrote ${args.reportPath}`);
    }
    if (args.jsonPath) {
      await writeOutput(args.jsonPath, `${JSON.stringify(report, null, 2)}\n`);
      console.log(`[retrieval-eval] wrote ${args.jsonPath}`);
    }

    const gateBudget = "4000";
    const comparison = report.comparisonByBudget[gateBudget];
    const legacy = report.modes.legacy.aggregateByBudget[gateBudget];
    const taskRelevant = report.modes.task_relevant.aggregateByBudget[gateBudget];
    console.log(
      [
        `[retrieval-eval] contract-compare cases=${report.caseCount}`,
        `winner@4000=${comparison?.winner ?? "n/a"}`,
        `legacy_recall=${fmt(legacy?.recallAtBudget)}`,
        `task_relevant_recall=${fmt(taskRelevant?.recallAtBudget)}`,
        `legacy_mrr=${fmt(legacy?.mrr)}`,
        `task_relevant_mrr=${fmt(taskRelevant?.mrr)}`,
        `legacy_mean_tokens=${legacy?.meanTokenEstimate.toFixed(1) ?? "n/a"}`,
        `task_relevant_mean_tokens=${taskRelevant?.meanTokenEstimate.toFixed(1) ?? "n/a"}`,
        `failures=${comparison ? `${comparison.legacyFailureCount}/${comparison.taskRelevantFailureCount}` : "n/a"}`,
      ].join(" "),
    );
    return;
  }

  const report = evaluateRetrievalOracle(oracle);
  if (args.reportPath) {
    await writeOutput(args.reportPath, renderRetrievalEvalMarkdown(report));
    console.log(`[retrieval-eval] wrote ${args.reportPath}`);
  }
  if (args.jsonPath) {
    await writeOutput(args.jsonPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`[retrieval-eval] wrote ${args.jsonPath}`);
  }

  const gateBudget = report.aggregateByBudget["4000"];
  console.log(
    [
      `[retrieval-eval] cases=${report.caseCount}`,
      `failures=${report.failures.length}`,
      `recall@budget=${gateBudget?.recallAtBudget?.toFixed(3) ?? "n/a"}`,
      `mrr=${gateBudget?.mrr?.toFixed(3) ?? "n/a"}`,
      `meanReturned=${gateBudget?.meanReturnedCount.toFixed(1) ?? "n/a"}`,
    ].join(" "),
  );

  if (report.failures.length > 0) {
    console.error(formatRetrievalEvalFailures(report));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[retrieval-eval] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
