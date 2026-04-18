#!/usr/bin/env node

import { Command } from "commander";
import { ensureCliPackageRootEnv } from "./cli-root.js";

ensureCliPackageRootEnv();

import { resolveOrgSlug } from "./config.js";
import { setOrgSlug, setAuthToken } from "./util.js";
import { loadCredentials } from "@pim/shared/auth";
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
import { registerLoginCommand } from "./commands/login.js";

setOrgSlug(resolveOrgSlug());
// Best-effort auth priming for every command: if creds exist on disk we attach
// the access token to outbound requests. If the server is in trust mode the
// token is ignored; if it's in IMS mode and the token is expired the server
// returns 401 and the user is prompted to re-login. The login command itself
// does not depend on this (it reads/writes creds directly).
{
  const creds = loadCredentials();
  if (creds) setAuthToken(creds.access_token);
}

const program = new Command();

program
  .name("pim")
  .description("PIM (Pod Intelligence Manager) CLI — manage pods, submit context, and tunnel dev servers")
  .version("0.0.1")
  .option("-s, --server <url>", "Server base URL", process.env.PIM_SERVER_URL ?? "http://localhost:4000");

registerPodCommands(program);
registerReportCommand(program);
registerDocCommand(program);
registerTunnelCommands(program);
registerLintCommand(program);
registerHooksCommand(program);
registerContextCommand(program);
registerSearchCommand(program);
registerInitCommand(program);
registerLeaveCommand(program);
registerLoginCommand(program);

program.parse();
