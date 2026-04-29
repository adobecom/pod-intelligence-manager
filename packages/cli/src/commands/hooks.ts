import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import chalk from "chalk";
import { getCliPackageRoot } from "../cli-root.js";
import { findGitRoot } from "../config.js";

const MARKER_BEGIN = "# pim-git-hook-begin";
const MARKER_END = "# pim-git-hook-end";

function hookScriptBody(kind: string, runnerPath: string): string {
  const passArgs = kind === "post-rewrite" ? `"$@"` : "";
  return `#!/bin/sh
${MARKER_BEGIN}
PIM_HOOK_KIND=${kind}
export PIM_HOOK_KIND
exec node ${JSON.stringify(runnerPath)} ${passArgs}
${MARKER_END}
`;
}

function isOurHook(content: string): boolean {
  return content.includes(MARKER_BEGIN) && content.includes(MARKER_END);
}

export function resolveRunnerPath(): string {
  const pkgRoot = getCliPackageRoot();
  return path.join(pkgRoot, "dist/git-hook/run.js");
}

export function installHooks(): void {
  const root = findGitRoot();
  if (!root) {
    console.error(chalk.red("\n  Not a git repository (git rev-parse failed).\n"));
    process.exit(1);
  }

  const runnerPath = resolveRunnerPath();
  if (!fs.existsSync(runnerPath)) {
    console.error(
      chalk.red(
        `\n  Hook runner not found at ${runnerPath}. Build the CLI first: pnpm --filter ado-pim build\n`,
      ),
    );
    process.exit(1);
  }

  const hooksDir = path.join(root, ".git", "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });

  for (const kind of ["post-commit", "post-rewrite"]) {
    const target = path.join(hooksDir, kind);
    const body = hookScriptBody(kind, runnerPath);
    fs.writeFileSync(target, body, { mode: 0o755 });
    try {
      fs.chmodSync(target, 0o755);
    } catch {
      /* Windows may ignore */
    }
    console.log(chalk.green(`  Installed ${kind}`));
  }

  console.log(chalk.dim(`\n  Runner: ${runnerPath}`));
  console.log(
    chalk.dim(
      "  Set PIM_POD_ID, PIM_AGENT_ID, PIM_SCOPE (or create .pim.json). See docs/POD_AGENT_PROTOCOL.md\n",
    ),
  );
}

export function registerHooksCommand(program: Command): void {
  const hooks = program
    .command("hooks")
    .description("Install or remove PIM git hooks (post-commit, post-rewrite)");

  hooks
    .command("install")
    .description("Write post-commit and post-rewrite hooks that report to the PIM API")
    .action(() => {
      installHooks();
    });

  hooks
    .command("uninstall")
    .description("Remove PIM-managed hooks if they were installed by pim hooks install")
    .action(() => {
      const root = findGitRoot();
      if (!root) {
        console.error(chalk.red("\n  Not a git repository.\n"));
        process.exit(1);
      }

      const hooksDir = path.join(root, ".git", "hooks");

      for (const kind of ["post-commit", "post-rewrite"]) {
        const target = path.join(hooksDir, kind);
        if (!fs.existsSync(target)) continue;
        const content = fs.readFileSync(target, "utf-8");
        if (isOurHook(content)) {
          fs.unlinkSync(target);
          console.log(chalk.green(`  Removed ${kind}`));
        } else {
          console.log(chalk.yellow(`  Skipped ${kind} (not PIM-managed)`));
        }
      }

      console.log();
    });
}
