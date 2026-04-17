#!/usr/bin/env node

import { Command } from "commander";
import { registerPodCommands } from "./commands/pod.js";
import { registerReportCommand } from "./commands/report.js";
import { registerDocCommand } from "./commands/doc.js";
import { registerTunnelCommands } from "./commands/tunnel.js";
import { registerLintCommand } from "./commands/lint.js";
import { registerHooksCommand } from "./commands/hooks.js";
import { registerContextCommand } from "./commands/context.js";
import { registerInitCommand } from "./commands/init.js";
import { registerLeaveCommand } from "./commands/leave.js";

const program = new Command();

program
  .name("council")
  .description("AI Council CLI — manage pods, submit context, and tunnel dev servers")
  .version("0.0.1")
  .option("-s, --server <url>", "Server base URL", process.env.COUNCIL_SERVER_URL ?? "http://localhost:4000");

registerPodCommands(program);
registerReportCommand(program);
registerDocCommand(program);
registerTunnelCommands(program);
registerLintCommand(program);
registerHooksCommand(program);
registerContextCommand(program);
registerInitCommand(program);
registerLeaveCommand(program);

program.parse();
