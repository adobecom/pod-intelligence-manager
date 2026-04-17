import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import chalk from "chalk";
import { findGitRoot, readConfigFile } from "../config.js";
import {
  PROTOCOL_MARKER_BEGIN,
  PROTOCOL_MARKER_END,
} from "../templates/pod-agent-protocol.md.js";
import { DISCONNECTED_SYNC_COMMAND } from "../templates/sync-command.md.js";

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function registerLeaveCommand(program: Command): void {
  program
    .command("leave")
    .description("Disconnect this repo from the current pod (remove pod binding; keep hooks and optional project config)")
    .option("--skip-claude-md", "Do not strip the Pod Agent Protocol block from CLAUDE.md")
    .option("--skip-sync", "Do not update .claude/commands/sync.md")
    .option("--skip-config", "Do not modify .council.json")
    .action((opts: { skipClaudeMd?: boolean; skipSync?: boolean; skipConfig?: boolean }) => {
      const root = findGitRoot();

      if (!root) {
        console.error(chalk.red("\n  Not a git repository. Run this from a git repo root.\n"));
        process.exit(1);
      }

      console.log(chalk.bold("\n  Council Leave\n"));

      // 1. CLAUDE.md — strip protocol block
      const claudeMdPath = path.join(root, "CLAUDE.md");
      if (!opts.skipClaudeMd && fs.existsSync(claudeMdPath)) {
        const existing = fs.readFileSync(claudeMdPath, "utf-8");
        if (existing.includes(PROTOCOL_MARKER_BEGIN)) {
          const regex = new RegExp(
            `\\n?${escapeRegex(PROTOCOL_MARKER_BEGIN)}[\\s\\S]*?${escapeRegex(PROTOCOL_MARKER_END)}\\n?`,
          );
          const updated = existing.replace(regex, "\n").replace(/\n{3,}/g, "\n\n").trimEnd();
          fs.writeFileSync(claudeMdPath, updated + (updated.endsWith("\n") ? "" : "\n"), "utf-8");
          console.log(chalk.green("  Removed Pod Agent Protocol block from CLAUDE.md"));
        } else {
          console.log(chalk.dim("  CLAUDE.md has no Council protocol block — skipped"));
        }
      } else if (opts.skipClaudeMd) {
        console.log(chalk.dim("  Skipped CLAUDE.md (--skip-claude-md)"));
      } else {
        console.log(chalk.dim("  No CLAUDE.md — skipped"));
      }

      // 2. .council.json — remove podId only
      const configPath = path.join(root, ".council.json");
      if (!opts.skipConfig && fs.existsSync(configPath)) {
        try {
          const raw = fs.readFileSync(configPath, "utf-8");
          const data = JSON.parse(raw) as Record<string, unknown>;
          if ("podId" in data) {
            delete data.podId;
            fs.writeFileSync(configPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
            console.log(chalk.green("  Removed podId from .council.json"));
          } else {
            console.log(chalk.dim("  .council.json had no podId — skipped"));
          }
        } catch {
          console.log(chalk.yellow("  Could not parse .council.json — left unchanged"));
        }
      } else if (opts.skipConfig) {
        console.log(chalk.dim("  Skipped .council.json (--skip-config)"));
      } else {
        console.log(chalk.dim("  No .council.json — skipped"));
      }

      // 3. sync.md — neutralize pod-specific commands
      const syncPath = path.join(root, ".claude", "commands", "sync.md");
      if (!opts.skipSync && fs.existsSync(syncPath)) {
        const prev = fs.readFileSync(syncPath, "utf-8");
        if (prev.includes("council context --pod") || prev.includes("Pull the latest AI Council pod context")) {
          fs.writeFileSync(syncPath, DISCONNECTED_SYNC_COMMAND, "utf-8");
          console.log(chalk.green("  Updated .claude/commands/sync.md (disconnected from pod)"));
        } else {
          console.log(chalk.dim("  .claude/commands/sync.md does not look Council-managed — skipped"));
        }
      } else if (opts.skipSync) {
        console.log(chalk.dim("  Skipped sync.md (--skip-sync)"));
      } else {
        console.log(chalk.dim("  No .claude/commands/sync.md — skipped"));
      }

      const cfg = readConfigFile();
      const hasProject = Boolean(cfg && "projectId" in cfg && cfg.projectId);
      console.log(chalk.bold.green("\n  Left pod context.\n"));
      if (hasProject) {
        console.log(chalk.dim("  projectId is still set — use council report --project … for project updates."));
      } else {
        console.log(chalk.dim("  Run council init when you join a sprint again, or set projectId for project-only reporting."));
      }
      console.log();
    });
}
