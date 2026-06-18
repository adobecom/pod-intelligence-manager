import type { Command } from "commander";
import chalk from "chalk";
import { PimClient } from "@pim/sdk";
import type { ContextUpdateType, WorkStatus, Scope } from "@pim/shared";
import { getBaseUrl, getOrgSlug, getAuthToken } from "../util.js";

type ReportSuccessResult = {
  id: string;
  pim: {
    classification: string;
    merged: boolean;
    conflictCreated: boolean;
    conflictId?: string;
    note?: string;
  };
};

type ReportQueuedResult = {
  queued: true;
  queue_id: string;
  queue_size: number;
  conflict_pressure: number;
  message: string;
};

type ReportDeduplicatedResult = {
  deduplicated: true;
  message: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isQueuedReportResult(value: unknown): value is ReportQueuedResult {
  return (
    isRecord(value) &&
    value.queued === true &&
    typeof value.queue_id === "string" &&
    typeof value.queue_size === "number" &&
    typeof value.conflict_pressure === "number" &&
    typeof value.message === "string"
  );
}

function isDeduplicatedReportResult(value: unknown): value is ReportDeduplicatedResult {
  return isRecord(value) && value.deduplicated === true && typeof value.message === "string";
}

function isReportSuccessResult(value: unknown): value is ReportSuccessResult {
  if (!isRecord(value) || typeof value.id !== "string" || !isRecord(value.pim)) return false;
  const pim = value.pim;
  return (
    typeof pim.classification === "string" &&
    typeof pim.merged === "boolean" &&
    typeof pim.conflictCreated === "boolean"
  );
}

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
        orgSlug: getOrgSlug() ?? undefined,
        authToken: getAuthToken() ?? undefined,
      });

      const result = await client.report({
        type: opts.type as ContextUpdateType,
        summary: opts.summary,
        details: opts.details,
        status: opts.status as WorkStatus,
      }) as unknown;

      if (isQueuedReportResult(result)) {
        console.log(chalk.bold("\n  Context update queued\n"));
        console.log(`  Queue ID:          ${result.queue_id}`);
        console.log(`  Queue size:        ${result.queue_size}`);
        console.log(`  Conflict pressure: ${chalk.yellow(result.conflict_pressure.toFixed(2))}`);
        console.log(`  Message:           ${chalk.dim(result.message)}`);
        console.log();
        return;
      }

      if (isDeduplicatedReportResult(result)) {
        console.log(chalk.bold("\n  Context update deduplicated\n"));
        console.log(`  Message: ${chalk.dim(result.message)}`);
        console.log();
        return;
      }

      if (!isReportSuccessResult(result)) {
        console.error(chalk.red("\n  Error: unexpected report response from PIM server.\n"));
        process.exit(1);
      }

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
