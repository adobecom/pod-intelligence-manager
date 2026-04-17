import type { Command } from "commander";
import chalk from "chalk";
import { getBaseUrl, fetchJSON } from "../util.js";

interface LintFinding {
  id: string;
  pod_id: string;
  timestamp: string;
  type: string;
  severity: string;
  summary: string;
  area: string | null;
  suggestion: string | null;
}

export function registerLintCommand(program: Command) {
  program
    .command("lint")
    .description("Run a lint pass on a pod")
    .argument("<podId>", "Pod ID")
    .action(async (podId: string) => {
      const base = getBaseUrl(program);

      console.log(chalk.dim("\n  Running lint pass...\n"));
      const result = await fetchJSON<{
        findings: LintFinding[];
        meta: {
          bedrock_configured: boolean;
          llm_ok: boolean;
          llm_model: string | null;
          llm_extra_findings: number;
          llm_error: string | null;
        };
      }>(`${base}/api/pods/${podId}/lint`, {
        method: "POST",
      });

      const { meta } = result;
      if (meta.bedrock_configured) {
        if (meta.llm_ok) {
          console.log(
            chalk.dim(
              `  LLM (fast) ${meta.llm_model ?? "model"}: +${meta.llm_extra_findings} finding(s)\n`,
            ),
          );
        } else {
          console.log(chalk.yellow(`  LLM supplement failed: ${meta.llm_error ?? "unknown"}\n`));
        }
      } else {
        console.log(chalk.dim("  LLM supplement skipped (AWS_BEARER_TOKEN_BEDROCK not set on server).\n"));
      }

      if (result.findings.length === 0) {
        console.log(chalk.green("  No issues found.\n"));
        return;
      }

      console.log(chalk.bold(`  ${result.findings.length} finding(s):\n`));
      for (const f of result.findings) {
        const sevColor =
          f.severity === "critical" ? chalk.red :
          f.severity === "warning" ? chalk.yellow :
          chalk.dim;
        console.log(`  ${sevColor(f.severity.toUpperCase().padEnd(8))} [${f.type}] ${f.summary}`);
        if (f.area) console.log(`           Area: ${f.area}`);
        if (f.suggestion) console.log(`           ${chalk.dim(f.suggestion)}`);
        console.log();
      }
    });
}
