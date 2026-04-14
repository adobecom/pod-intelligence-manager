import type { Command } from "commander";
import chalk from "chalk";
import { CouncilClient } from "@council/sdk";
import type { ContextUpdateType, WorkStatus, Scope } from "@council/shared";
import { getBaseUrl } from "../util.js";

export function registerReportCommand(program: Command) {
  program
    .command("report")
    .description("Submit a context update to the Council")
    .requiredOption("-p, --pod <podId>", "Pod ID")
    .requiredOption("-t, --type <type>", "Update type (progress|blocker|spec_change|question|decision)")
    .requiredOption("--scope <scope>", "Scope (frontend|backend|design|qa|infra|pm)")
    .requiredOption("--summary <text>", "Summary of the update")
    .option("--details <text>", "Detailed description", "")
    .option("--agent <id>", "Agent ID", "cli-user")
    .option("--status <status>", "Work status (completed|in_progress|blocked)", "in_progress")
    .action(async (opts) => {
      const base = getBaseUrl(program);

      const client = new CouncilClient({
        baseUrl: base,
        podId: opts.pod,
        agentId: opts.agent,
        scope: opts.scope as Scope,
      });

      const result = await client.report({
        type: opts.type as ContextUpdateType,
        summary: opts.summary,
        details: opts.details,
        status: opts.status as WorkStatus,
      });

      const classColor =
        result.council.classification === "additive" ? chalk.green :
        result.council.classification === "overlapping" ? chalk.yellow :
        chalk.red;

      console.log(chalk.bold("\n  Context update submitted\n"));
      console.log(`  ID:             ${result.id}`);
      console.log(`  Classification: ${classColor(result.council.classification)}`);
      console.log(`  Merged:         ${result.council.merged ? chalk.green("yes") : chalk.dim("no")}`);
      if (result.council.conflictCreated) {
        console.log(`  Conflict:       ${chalk.red("created")} (${result.council.conflictId})`);
      }
      if (result.council.note) {
        console.log(`  Note:           ${chalk.dim(result.council.note)}`);
      }
      console.log();
    });
}
