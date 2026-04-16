import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import chalk from "chalk";
import { getBaseUrl } from "../util.js";
import { findGitRoot } from "../config.js";
import { installHooks, resolveRunnerPath } from "./hooks.js";
import {
  renderPodAgentProtocol,
  PROTOCOL_MARKER_BEGIN,
  PROTOCOL_MARKER_END,
} from "../templates/pod-agent-protocol.md.js";
import { renderSyncCommand } from "../templates/sync-command.md.js";

const VALID_SCOPES = ["frontend", "backend", "design", "qa", "infra", "pm"];

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Initialize Council integration for this repo (hooks, Claude Code config, CLAUDE.md)")
    .requiredOption("-p, --pod <podId>", "Pod ID to connect to")
    .option("--scope <scope>", "Agent scope (frontend|backend|design|qa|infra|pm)")
    .option("--agent <id>", "Agent ID (default: git user.name)")
    .option("--skip-hooks", "Skip git hook installation")
    .option("--skip-claude", "Skip Claude Code integration (.claude/ files)")
    .option("--skip-claude-md", "Skip CLAUDE.md addendum")
    .action(async (opts) => {
      const serverUrl = getBaseUrl(program);
      const root = findGitRoot();

      if (!root) {
        console.error(chalk.red("\n  Not a git repository. Run this from a git repo root.\n"));
        process.exit(1);
      }

      const podId: string = opts.pod;
      const scope: string | undefined = opts.scope;
      const agentId: string | undefined = opts.agent;

      if (scope && !VALID_SCOPES.includes(scope)) {
        console.error(chalk.red(`\n  Invalid scope "${scope}". Must be one of: ${VALID_SCOPES.join(", ")}\n`));
        process.exit(1);
      }

      console.log(chalk.bold("\n  Council Init\n"));

      // 1. Verify server connectivity
      console.log(chalk.dim("  Checking server..."));
      try {
        const healthRes = await fetch(`${serverUrl}/api/health`, { signal: AbortSignal.timeout(5000) });
        if (!healthRes.ok) throw new Error(`HTTP ${healthRes.status}`);
      } catch (e) {
        console.error(chalk.red(`  Cannot reach Council server at ${serverUrl}`));
        console.error(chalk.dim(`  Make sure the server is running. Error: ${e instanceof Error ? e.message : e}\n`));
        process.exit(1);
      }
      console.log(chalk.green("  Server OK"));

      // 2. Verify pod exists
      console.log(chalk.dim("  Verifying pod..."));
      try {
        const podRes = await fetch(`${serverUrl}/api/pods/${encodeURIComponent(podId)}`, {
          signal: AbortSignal.timeout(5000),
        });
        if (!podRes.ok) throw new Error(`HTTP ${podRes.status}`);
        const pod = (await podRes.json()) as { name: string };
        console.log(chalk.green(`  Pod: ${pod.name} (${podId})`));
      } catch {
        console.error(chalk.red(`  Pod "${podId}" not found on server.\n`));
        process.exit(1);
      }

      // 3. Write .council.json
      const configPath = path.join(root, ".council.json");
      const configData: Record<string, unknown> = {
        podId,
        serverUrl,
        autoReport: { gitHook: true, claudeCodeHook: true },
      };
      if (scope) configData.scope = scope;
      if (agentId) configData.agentId = agentId;

      fs.writeFileSync(configPath, JSON.stringify(configData, null, 2) + "\n", "utf-8");
      console.log(chalk.green("  Created .council.json"));

      // 4. Install git hooks
      if (!opts.skipHooks) {
        const runnerPath = resolveRunnerPath();
        if (fs.existsSync(runnerPath)) {
          console.log(chalk.dim("  Installing git hooks..."));
          installHooks();
        } else {
          console.log(chalk.yellow("  Git hooks skipped (build CLI first: pnpm --filter @council/cli build)"));
        }
      } else {
        console.log(chalk.dim("  Skipped git hooks (--skip-hooks)"));
      }

      // 5. Claude Code integration
      if (!opts.skipClaude) {
        const claudeDir = path.join(root, ".claude");
        fs.mkdirSync(claudeDir, { recursive: true });

        // 5a. Merge hooks into .claude/settings.json
        const settingsPath = path.join(claudeDir, "settings.json");
        let settings: Record<string, unknown> = {};
        if (fs.existsSync(settingsPath)) {
          try {
            settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
          } catch {
            settings = {};
          }
        }

        const hookRunnerDir = path.dirname(resolveRunnerPath());
        const postToolScript = path.resolve(path.join(hookRunnerDir, "../hooks/claude-code-post-tool.js"));
        const preToolScript = path.resolve(path.join(hookRunnerDir, "../hooks/claude-code-pre-tool.js"));

        const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;

        // Add PostToolCall hook if not already present
        const postHooks = (hooks.PostToolCall ?? []) as Array<Record<string, string>>;
        const hasPostHook = postHooks.some((h) => h.command?.includes("claude-code-post-tool"));
        if (!hasPostHook) {
          postHooks.push({
            matcher: "Bash",
            command: `node ${JSON.stringify(postToolScript)}`,
          });
        }
        hooks.PostToolCall = postHooks;

        // Add PreToolCall hook if not already present
        const preHooks = (hooks.PreToolCall ?? []) as Array<Record<string, string>>;
        const hasPreHook = preHooks.some((h) => h.command?.includes("claude-code-pre-tool"));
        if (!hasPreHook) {
          preHooks.push({
            matcher: "Bash",
            command: `node ${JSON.stringify(preToolScript)}`,
          });
        }
        hooks.PreToolCall = preHooks;

        settings.hooks = hooks;
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
        console.log(chalk.green("  Updated .claude/settings.json (hooks)"));

        // 5b. Create /sync slash command
        const commandsDir = path.join(claudeDir, "commands");
        fs.mkdirSync(commandsDir, { recursive: true });
        const syncPath = path.join(commandsDir, "sync.md");
        fs.writeFileSync(syncPath, renderSyncCommand({ podId, scope: scope ?? "backend" }), "utf-8");
        console.log(chalk.green("  Created .claude/commands/sync.md"));
      } else {
        console.log(chalk.dim("  Skipped Claude Code integration (--skip-claude)"));
      }

      // 6. CLAUDE.md addendum
      if (!opts.skipClaudeMd) {
        const claudeMdPath = path.join(root, "CLAUDE.md");
        const protocol = renderPodAgentProtocol({
          podId,
          scope: scope ?? "backend",
          serverUrl,
        });

        if (fs.existsSync(claudeMdPath)) {
          const existing = fs.readFileSync(claudeMdPath, "utf-8");

          if (existing.includes(PROTOCOL_MARKER_BEGIN)) {
            // Replace existing protocol section
            const regex = new RegExp(
              `${escapeRegex(PROTOCOL_MARKER_BEGIN)}[\\s\\S]*?${escapeRegex(PROTOCOL_MARKER_END)}`,
            );
            const updated = existing.replace(regex, protocol);
            fs.writeFileSync(claudeMdPath, updated, "utf-8");
            console.log(chalk.green("  Updated CLAUDE.md (Pod Agent Protocol replaced)"));
          } else {
            // Append
            fs.writeFileSync(claudeMdPath, existing + "\n\n" + protocol + "\n", "utf-8");
            console.log(chalk.green("  Updated CLAUDE.md (Pod Agent Protocol appended)"));
          }
        } else {
          fs.writeFileSync(claudeMdPath, `# CLAUDE.md\n\n${protocol}\n`, "utf-8");
          console.log(chalk.green("  Created CLAUDE.md with Pod Agent Protocol"));
        }
      } else {
        console.log(chalk.dim("  Skipped CLAUDE.md (--skip-claude-md)"));
      }

      // 7. Create .council/ directory for context caching
      const councilDir = path.join(root, ".council");
      fs.mkdirSync(councilDir, { recursive: true });

      // Add .council/ to .gitignore if not already there
      const gitignorePath = path.join(root, ".gitignore");
      if (fs.existsSync(gitignorePath)) {
        const gitignore = fs.readFileSync(gitignorePath, "utf-8");
        if (!gitignore.includes(".council/")) {
          fs.appendFileSync(gitignorePath, "\n# Council local state\n.council/\n");
          console.log(chalk.green("  Added .council/ to .gitignore"));
        }
      }

      console.log(chalk.bold.green("\n  Council initialized!\n"));
      console.log(chalk.dim("  Next steps:"));
      console.log(chalk.dim(`    1. Set COUNCIL_AGENT_ID (or pass --agent) for commit attribution`));
      if (!scope) {
        console.log(chalk.dim(`    2. Set COUNCIL_SCOPE or pass --scope to scope your reports`));
      }
      console.log(chalk.dim(`    3. Run 'council context --pod ${podId}' to pull initial pod state`));
      console.log(chalk.dim(`    4. Start coding — commits will auto-report to the Council\n`));
    });
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
