#!/usr/bin/env node

import { Command } from "commander";
import { ensureCliPackageRootEnv } from "./cli-root.js";

ensureCliPackageRootEnv();

import { resolveOrgSlug } from "./config.js";
import { setOrgSlug, setAuthToken } from "./util.js";
import { loadCredentials, ensureFreshToken } from "@pim/shared/auth";
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
import { registerProjectCommands } from "./commands/project.js";
import { registerUpdateSkillsCommand } from "./commands/update-skills.js";

setOrgSlug(resolveOrgSlug());

const program = new Command();

program
  .name("pim")
  .description("PIM (Pod Intelligence Manager) CLI — manage pods, submit context, and tunnel dev servers")
  .version("0.1.0")
  .option("-s, --server <url>", "Server base URL", process.env.PIM_SERVER_URL ?? "https://d1ygncl0yqo6sv.cloudfront.net");

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
registerUpdateSkillsCommand(program);
registerLeaveCommand(program);
registerLoginCommand(program);

// Refresh token before any command runs. login/logout/whoami manage their own
// auth directly so they're excluded to avoid a chicken-and-egg loop.
const NO_AUTH_COMMANDS = new Set(["login", "logout", "whoami"]);
program.hook("preAction", async (thisCommand) => {
  const name = thisCommand.name();
  if (NO_AUTH_COMMANDS.has(name)) return;
  const creds = loadCredentials();
  if (!creds) return;
  try {
    const fresh = await ensureFreshToken(creds);
    setAuthToken(fresh.access_token);
  } catch {
    // Token expired with no refresh token — let the command hit a 401 so the
    // error message names the actual failing operation, then tell the user to re-login.
    setAuthToken(creds.access_token);
  }
});

program.parse();
