import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import oracleJson from "../src/services/__fixtures__/kg-retrieval-oracle.json";
import {
  evaluateRetrievalOracle,
  formatRetrievalEvalFailures,
  renderRetrievalEvalMarkdown,
  validateRetrievalOracle,
  type RetrievalOracleFixture,
} from "../src/services/kg-retrieval-eval.js";

interface Args {
  reportPath?: string;
  jsonPath?: string;
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
    "  --help           Print this help",
  ].join("\n");
}

function parseArgs(argv: string[]): Args {
  const args: Args = { help: false };
  for (const arg of argv) {
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      args.help = true;
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
