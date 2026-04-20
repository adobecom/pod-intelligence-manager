#!/usr/bin/env node

import { Command } from "commander";
import { ensureCliPackageRootEnv } from "./cli-root.js";

ensureCliPackageRootEnv();

import { registerPodCommands } from "./commands/pod.js";
import { registerReportCommand } from "./commands/report.js";
import { registerDocCommand } from "./commands/doc.js";
import { registerTunnelCommands } from "./commands/tunnel.js";
import { registerLintCommand } from "./commands/lint.js";
import { registerContextCommand } from "./commands/context.js";
import { registerHooksCommand } from "./commands/hooks.js";
import { registerInitCommand } from "./commands/init.js";
import { registerLeaveCommand } from "./commands/leave.js";
import { registerSearchCommand } from "./commands/search.js";
import { registerProjectCommands } from "./commands/project.js";

const program = new Command();

program
  .name("pim")
  .description("PIM (Pod Intelligence Manager) CLI — manage pods, submit context, and tunnel dev servers")
  .version("0.0.1")
  .option("-s, --server <url>", "Server base URL", process.env.PIM_SERVER_URL ?? "http://localhost:4000");

registerPodCommands(program);
registerProjectCommands(program);
registerReportCommand(program);
registerDocCommand(program);
registerTunnelCommands(program);
registerLintCommand(program);
registerHooksCommand(program);
registerContextCommand(program);
registerSearchCommand(program);
registerInitCommand(program);
registerLeaveCommand(program);

program.parse();
