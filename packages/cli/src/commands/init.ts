import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import chalk from "chalk";
import { confirm, input, select } from "@inquirer/prompts";
import type { OrgConfig } from "@pim/shared";
import { getBaseUrl } from "../util.js";
import { findGitRoot, getGitUserName } from "../config.js";
import { installHooks, resolveRunnerPath } from "./hooks.js";
import {
  renderPodAgentProtocol,
  PROTOCOL_MARKER_BEGIN,
  PROTOCOL_MARKER_END,
} from "../templates/pod-agent-protocol.md.js";
import { renderSyncCommand } from "../templates/sync-command.md.js";
import {
  defaultScopeIdFromConfig,
  fetchOrgConfig,
  fetchOrgPods,
  fetchProjects,
  formatScopeChoicesForError,
  scopeIdsFromConfig,
  verifyProjectExists,
} from "../org-config.js";

export interface RunInitOptions {
  serverUrl: string;
  root: string;
  podId: string;
  projectId?: string;
  scope?: string;
  agentId?: string;
  /** Used in templates when scope is omitted (first org scope). */
  defaultScopeId: string;
  skipHooks: boolean;
  skipClaude: boolean;
  skipClaudeMd: boolean;
}

function isInteractiveSession(): boolean {
  if (!process.stdin.isTTY) return false;
  if (process.env.CI === "true" || process.env.CI === "1") return false;
  return true;
}

export async function runInit(opts: RunInitOptions): Promise<void> {
  const {
    serverUrl,
    root,
    podId,
    projectId: projectIdOpt,
    scope,
    agentId,
    defaultScopeId,
    skipHooks,
    skipClaude,
    skipClaudeMd,
  } = opts;

  const templateScope = scope ?? defaultScopeId;

  // 3. Write .pim.json
  const configPath = path.join(root, ".pim.json");
  const configData: Record<string, unknown> = {
    podId,
    serverUrl,
    autoReport: { gitHook: true, claudeCodeHook: true },
  };
  if (scope) configData.scope = scope;
  if (agentId) configData.agentId = agentId;
  if (projectIdOpt) configData.projectId = projectIdOpt;

  fs.writeFileSync(configPath, JSON.stringify(configData, null, 2) + "\n", "utf-8");
  console.log(chalk.green("  Created .pim.json"));

  // 4. Install git hooks
  if (!skipHooks) {
    const runnerPath = resolveRunnerPath();
    if (fs.existsSync(runnerPath)) {
      console.log(chalk.dim("  Installing git hooks..."));
      installHooks();
    } else {
      console.log(chalk.yellow("  Git hooks skipped (build CLI first: pnpm --filter @pim/cli build)"));
    }
  } else {
    console.log(chalk.dim("  Skipped git hooks (--skip-hooks)"));
  }

  // 5. Claude Code integration
  if (!skipClaude) {
    const claudeDir = path.join(root, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });

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

    const postHooks = (hooks.PostToolCall ?? []) as Array<Record<string, string>>;
    const hasPostHook = postHooks.some((h) => h.command?.includes("claude-code-post-tool"));
    if (!hasPostHook) {
      postHooks.push({
        matcher: "Bash",
        command: `node ${JSON.stringify(postToolScript)}`,
      });
    }
    hooks.PostToolCall = postHooks;

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

    const commandsDir = path.join(claudeDir, "commands");
    fs.mkdirSync(commandsDir, { recursive: true });
    const syncPath = path.join(commandsDir, "sync.md");
    fs.writeFileSync(syncPath, renderSyncCommand({ podId, scope: templateScope }), "utf-8");
    console.log(chalk.green("  Created .claude/commands/sync.md"));
  } else {
    console.log(chalk.dim("  Skipped Claude Code integration (--skip-claude)"));
  }

  // 6. CLAUDE.md addendum
  if (!skipClaudeMd) {
    const claudeMdPath = path.join(root, "CLAUDE.md");
    const protocol = renderPodAgentProtocol({
      podId,
      scope: templateScope,
      serverUrl,
    });

    if (fs.existsSync(claudeMdPath)) {
      const existing = fs.readFileSync(claudeMdPath, "utf-8");

      if (existing.includes(PROTOCOL_MARKER_BEGIN)) {
        const regex = new RegExp(
          `${escapeRegex(PROTOCOL_MARKER_BEGIN)}[\\s\\S]*?${escapeRegex(PROTOCOL_MARKER_END)}`,
        );
        const updated = existing.replace(regex, protocol);
        fs.writeFileSync(claudeMdPath, updated, "utf-8");
        console.log(chalk.green("  Updated CLAUDE.md (Pod Agent Protocol replaced)"));
      } else {
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

  // 7. Create .pim/ directory for context caching
  const pimDir = path.join(root, ".pim");
  fs.mkdirSync(pimDir, { recursive: true });

  const gitignorePath = path.join(root, ".gitignore");
  if (fs.existsSync(gitignorePath)) {
    const gitignore = fs.readFileSync(gitignorePath, "utf-8");
    if (!gitignore.includes(".pim/")) {
      fs.appendFileSync(gitignorePath, "\n# PIM local state\n.pim/\n");
      console.log(chalk.green("  Added .pim/ to .gitignore"));
    }
  }

  console.log(chalk.bold.green("\n  PIM initialized!\n"));
  console.log(chalk.dim("  Next steps:"));
  console.log(chalk.dim(`    1. Set PIM_AGENT_ID (or pass --agent) for commit attribution`));
  if (!scope) {
    console.log(chalk.dim(`    2. Set PIM_SCOPE or pass --scope to scope your reports`));
  }
  console.log(chalk.dim(`    3. Run 'pim context --pod ${podId}' to pull initial pod state`));
  console.log(chalk.dim(`    4. Start coding — commits will auto-report to PIM\n`));
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function runWizard(
  serverUrl: string,
  orgConfig: OrgConfig,
  initial: { project?: string; scope?: string; agent?: string },
): Promise<{ podId: string; projectId?: string; scope?: string; agentId?: string }> {
  const pods = await fetchOrgPods(serverUrl);
  if (pods.length === 0) {
    console.error(chalk.red("\n  No active pods. Create one in the UI or run `pim pod create`.\n"));
    process.exit(1);
  }

  const podChoices = pods.map(p => ({
    name: `${p.name} (${p.pod_id})`,
    value: p.pod_id,
  }));

  const podId = await select({
    message: "Which pod should this repo use?",
    choices: podChoices,
  });

  let projectId = initial.project;
  if (projectId === undefined) {
    const linkProject = await confirm({
      message: "Link a long-lived project (optional)?",
      default: false,
    });
    if (linkProject) {
      const projects = await fetchProjects(serverUrl);
      if (projects.length === 0) {
        console.log(chalk.yellow("  No projects on the server; skipping project link."));
      } else {
        const picked = await select({
          message: "Select project",
          choices: [
            { name: "(none)", value: "__none__" },
            ...projects.map(pr => ({ name: `${pr.name} (${pr.project_id})`, value: pr.project_id })),
          ],
        });
        projectId = picked === "__none__" ? undefined : picked;
      }
    }
  }

  let scope = initial.scope;
  if (scope === undefined) {
    const setScope = await confirm({
      message: "Set a default scope for this repo (optional)?",
      default: false,
    });
    if (setScope) {
      scope = await select({
        message: "Scope",
        choices: orgConfig.scopes.map(s => ({ name: `${s.label} (${s.id})`, value: s.id })),
      });
    }
  }

  let agentId = initial.agent;
  if (agentId === undefined) {
    const defaultName = getGitUserName() ?? "";
    const entered = await input({
      message: "Agent id for attribution (optional)",
      default: defaultName,
    });
    agentId = entered.trim() || undefined;
  }

  const ok = await confirm({
    message: `Write .pim.json for pod ${podId}${projectId ? `, project ${projectId}` : ""}?`,
    default: true,
  });
  if (!ok) {
    console.log(chalk.dim("\n  Aborted.\n"));
    process.exit(0);
  }

  return { podId, projectId, scope, agentId };
}

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Initialize PIM integration for this repo (hooks, Claude Code config, CLAUDE.md)")
    .option("-p, --pod <podId>", "Pod ID to connect to")
    .option("--project <projectId>", "Optional project ID for long-lived memory (must exist on server)")
    .option("--scope <scope>", "Agent scope id (must exist in org config; see GET /api/org/config)")
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

      const interactive = isInteractiveSession();

      console.log(chalk.bold("\n  PIM Init\n"));

      console.log(chalk.dim("  Checking server..."));
      try {
        const healthRes = await fetch(`${serverUrl}/api/health`, { signal: AbortSignal.timeout(5000) });
        if (!healthRes.ok) throw new Error(`HTTP ${healthRes.status}`);
      } catch (e) {
        console.error(chalk.red(`  Cannot reach PIM server at ${serverUrl}`));
        console.error(chalk.dim(`  Make sure the server is running. Error: ${e instanceof Error ? e.message : e}\n`));
        process.exit(1);
      }
      console.log(chalk.green("  Server OK"));

      let orgConfig: OrgConfig;
      try {
        orgConfig = await fetchOrgConfig(serverUrl);
      } catch (e) {
        console.error(chalk.red("  Cannot load org config."));
        console.error(chalk.dim(`  ${e instanceof Error ? e.message : e}\n`));
        process.exit(1);
      }

      const allowedIds = scopeIdsFromConfig(orgConfig);
      const defaultScopeId = defaultScopeIdFromConfig(orgConfig) ?? "frontend";

      let podId: string | undefined = opts.pod;
      let projectIdOpt: string | undefined = opts.project;
      let scope: string | undefined = opts.scope;
      let agentId: string | undefined = opts.agent;

      if (interactive && !opts.pod) {
        const w = await runWizard(serverUrl, orgConfig, {
          project: projectIdOpt,
          scope,
          agent: agentId,
        });
        podId = w.podId;
        projectIdOpt = w.projectId;
        scope = w.scope;
        agentId = w.agentId;
      } else {
        if (!podId?.trim()) {
          console.error(chalk.red("\n  Missing --pod (required in non-interactive mode / CI).\n"));
          process.exit(1);
        }
      }

      if (scope && !allowedIds.has(scope)) {
        console.error(
          chalk.red(`\n  Invalid scope "${scope}". Must be one of: ${formatScopeChoicesForError(orgConfig)}\n`),
        );
        process.exit(1);
      }

      console.log(chalk.dim("  Verifying pod..."));
      try {
        const podRes = await fetch(`${serverUrl}/api/pods/${encodeURIComponent(podId!)}`, {
          signal: AbortSignal.timeout(5000),
        });
        if (!podRes.ok) throw new Error(`HTTP ${podRes.status}`);
        const pod = (await podRes.json()) as { name: string };
        console.log(chalk.green(`  Pod: ${pod.name} (${podId})`));
      } catch {
        console.error(chalk.red(`  Pod "${podId}" not found on server.\n`));
        process.exit(1);
      }

      if (projectIdOpt) {
        console.log(chalk.dim("  Verifying project..."));
        try {
          const pr = await verifyProjectExists(serverUrl, projectIdOpt);
          console.log(chalk.green(`  Project: ${pr.name} (${projectIdOpt})`));
        } catch {
          console.error(chalk.red(`  Project "${projectIdOpt}" not found on server.\n`));
          process.exit(1);
        }
      }

      await runInit({
        serverUrl,
        root,
        podId: podId!,
        projectId: projectIdOpt,
        scope,
        agentId,
        defaultScopeId,
        skipHooks: !!opts.skipHooks,
        skipClaude: !!opts.skipClaude,
        skipClaudeMd: !!opts.skipClaudeMd,
      });
    });
}
