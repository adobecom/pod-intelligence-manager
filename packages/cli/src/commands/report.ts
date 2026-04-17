import type { Command } from "commander";
import chalk from "chalk";
import { PimClient } from "@pim/sdk";
import type { ContextUpdateType, WorkStatus, Scope } from "@pim/shared";
import { getBaseUrl } from "../util.js";

export function registerReportCommand(program: Command) {
  program
    .command("report")
    .description("Submit a context update to PIM (pod or project)")
    .option("-p, --pod <podId>", "Pod ID")
    .option("--project <projectId>", "Project ID (between sprints / no active pod)")
    .requiredOption("-t, --type <type>", "Update type (progress|blocker|spec_change|question|decision)")
    .requiredOption("--scope <scope>", "Org-defined scope id (see GET /api/org/config)")
    .requiredOption("--summary <text>", "Summary of the update")
    .option("--details <text>", "Detailed description", "")
    .option("--agent <id>", "Agent ID", "cli-user")
    .option("--status <status>", "Work status (completed|in_progress|blocked)", "in_progress")
    .action(async (opts) => {
      const base = getBaseUrl(program);

      const pod = opts.pod as string | undefined;
      const project = opts.project as string | undefined;
      if ((!pod && !project) || (pod && project)) {
        console.error(chalk.red("\n  Specify exactly one of --pod or --project.\n"));
        process.exit(1);
      }

      const client = new PimClient({
        baseUrl: base,
        ...(pod ? { podId: pod } : { projectId: project! }),
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
        result.pim.classification === "additive" ? chalk.green :
        result.pim.classification === "overlapping" ? chalk.yellow :
        chalk.red;

      console.log(chalk.bold("\n  Context update submitted\n"));
      console.log(`  ID:             ${result.id}`);
      console.log(`  Classification: ${classColor(result.pim.classification)}`);
      console.log(`  Merged:         ${result.pim.merged ? chalk.green("yes") : chalk.dim("no")}`);
      if (result.pim.conflictCreated) {
        console.log(`  Conflict:       ${chalk.red("created")} (${result.pim.conflictId})`);
      }
      if (result.pim.note) {
        console.log(`  Note:           ${chalk.dim(result.pim.note)}`);
      }
      console.log();
    });
}
